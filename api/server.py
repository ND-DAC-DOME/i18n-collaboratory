#!/usr/bin/env python3
"""UAOA i18n review API + static file server.

Local (filesystem state):
  cd tools/i18n-review && python3 api/server.py

GitHub-backed (shared locks / saves for public reviewers):
  export GITHUB_TOKEN=ghp_...
  export GITHUB_REPO=jhendri4/uaoa-i18n-review
  export GITHUB_BRANCH=main
  python3 api/server.py --port 8787

The GitHub token stays on the server — the public page never sees it.
"""
from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from approval_util import (  # noqa: E402
    flatten_catalog,
    make_approval,
    reconcile_approvals,
)

DATA = ROOT / 'data'
STATE = ROOT / 'state'
LOCKS = STATE / 'locks'
APPROVALS = STATE / 'approvals'
LOCALES = {'es', 'cs', 'sl', 'sv', 'fr'}

GITHUB_TOKEN = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN') or ''
GITHUB_REPO = os.environ.get('GITHUB_REPO', '')
GITHUB_BRANCH = os.environ.get('GITHUB_BRANCH', 'main')
USE_GITHUB = bool(GITHUB_TOKEN and GITHUB_REPO)

# Render / slim images often lack a working system CA bundle; prefer certifi.
try:
    import certifi

    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    SSL_CONTEXT = ssl.create_default_context()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def cors(handler: SimpleHTTPRequestHandler) -> None:
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
    # Echo requested headers when present so browser preflights (custom headers
    # like Bypass-Tunnel-Reminder from older clients) succeed against github.io.
    req_hdrs = handler.headers.get('Access-Control-Request-Headers')
    allow = req_hdrs or 'Content-Type, Accept, Bypass-Tunnel-Reminder'
    handler.send_header('Access-Control-Allow-Headers', allow)
    handler.send_header('Access-Control-Max-Age', '86400')


def read_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get('Content-Length') or 0)
    raw = handler.rfile.read(length) if length else b'{}'
    try:
        data = json.loads(raw.decode('utf-8') or '{}')
    except json.JSONDecodeError as e:
        raise ValueError(f'invalid JSON: {e}') from e
    if not isinstance(data, dict):
        raise ValueError('JSON body must be an object')
    return data


def send_json(handler: SimpleHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    cors(handler)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


# --- storage helpers ---------------------------------------------------------

class GitHubHTTPError(RuntimeError):
    def __init__(self, method: str, path: str, code: int, detail: str):
        super().__init__(f'GitHub {method} {path} -> {code}: {detail[:400]}')
        self.method = method
        self.path = path
        self.code = code


def gh_api(method: str, path: str, body: dict | None = None) -> dict:
    url = f'https://api.github.com{path}'
    data = None if body is None else json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            'Authorization': f'Bearer {GITHUB_TOKEN}',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'uaoa-i18n-review',
            'Content-Type': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as res:
            raw = res.read().decode('utf-8')
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err = e.read().decode('utf-8', errors='replace')
        raise GitHubHTTPError(method, path, e.code, err) from e
    except urllib.error.URLError as e:
        raise RuntimeError(f'GitHub {method} {path} -> network/SSL error: {e}') from e


def gh_get_file(path: str) -> tuple[Any, str | None]:
    """Return (parsed_json, sha). Missing file → (None, None)."""
    api_path = f'/repos/{GITHUB_REPO}/contents/{path}?ref={GITHUB_BRANCH}'
    try:
        meta = gh_api('GET', api_path)
    except GitHubHTTPError as e:
        if e.code == 404:
            return None, None
        raise
    content = base64.b64decode(meta.get('content') or '').decode('utf-8')
    sha = meta.get('sha')
    if not content.strip():
        return None, sha
    return json.loads(content), sha


def gh_put_file(path: str, obj: Any, message: str, sha: str | None) -> str | None:
    """Write a JSON file. Returns the new blob SHA from the Contents API."""
    content = base64.b64encode(
        (json.dumps(obj, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    ).decode('ascii')
    body: dict[str, Any] = {
        'message': message,
        'content': content,
        'branch': GITHUB_BRANCH,
    }
    if sha:
        body['sha'] = sha
    result = gh_api('PUT', f'/repos/{GITHUB_REPO}/contents/{path}', body)
    meta = result.get('content') if isinstance(result, dict) else None
    if isinstance(meta, dict) and meta.get('sha'):
        return str(meta['sha'])
    return None


def fs_read(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    text = path.read_text(encoding='utf-8').strip()
    if not text or text == 'null':
        return default
    return json.loads(text)


def fs_write(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def load_catalog(locale: str) -> dict:
    if locale != 'en' and locale not in LOCALES:
        raise ValueError(f'unsupported locale: {locale}')
    rel = f'data/{locale}.json'
    if USE_GITHUB:
        data, _ = gh_get_file(rel)
        if data is None:
            # fall back to bundled copy shipped with the server
            return fs_read(DATA / f'{locale}.json', {})
        return data
    return fs_read(DATA / f'{locale}.json', {})


def save_catalog(locale: str, catalog: dict, message: str) -> None:
    if locale not in LOCALES:
        raise ValueError(f'unsupported locale: {locale}')
    rel = f'data/{locale}.json'
    if USE_GITHUB:
        _, sha = gh_get_file(rel)
        gh_put_file(rel, catalog, message, sha)
    else:
        fs_write(DATA / f'{locale}.json', catalog)


# Last known approvals file per locale (blob SHA + map). Avoids a second
# Contents GET immediately before PUT. Invalidated on GitHub 409.
_APPROVAL_GUARD = threading.Lock()
_APPROVAL_STATE: dict[str, dict[str, Any]] = {}
_APPROVAL_WRITE_LOCKS: dict[str, threading.Lock] = {}


def _approval_write_lock(locale: str) -> threading.Lock:
    with _APPROVAL_GUARD:
        lock = _APPROVAL_WRITE_LOCKS.get(locale)
        if lock is None:
            lock = threading.Lock()
            _APPROVAL_WRITE_LOCKS[locale] = lock
        return lock


def _cache_get(locale: str) -> tuple[bool, str | None, dict]:
    with _APPROVAL_GUARD:
        entry = _APPROVAL_STATE.get(locale)
        if not entry:
            return False, None, {}
        return True, entry.get('sha'), copy.deepcopy(entry['data'])


def _cache_store(locale: str, data: dict, sha: str | None) -> None:
    with _APPROVAL_GUARD:
        _APPROVAL_STATE[locale] = {
            'sha': sha,
            'data': copy.deepcopy(data) if isinstance(data, dict) else {},
        }


def _cache_invalidate(locale: str) -> None:
    with _APPROVAL_GUARD:
        _APPROVAL_STATE.pop(locale, None)


def load_approvals_raw(locale: str) -> dict:
    if locale not in LOCALES:
        raise ValueError(f'unsupported locale: {locale}')
    hit, _sha, data = _cache_get(locale)
    if hit:
        return data
    rel = f'state/approvals/{locale}.json'
    if USE_GITHUB:
        fetched, sha = gh_get_file(rel)
        raw = fetched if isinstance(fetched, dict) else {}
    else:
        raw = fs_read(APPROVALS / f'{locale}.json', {})
        if not isinstance(raw, dict):
            raw = {}
        sha = None
    _cache_store(locale, raw, sha)
    return copy.deepcopy(raw)


# Short TTL cache — loadLocale hits catalog + approvals + claim in a burst;
# each approvals path previously re-fetched EN from GitHub and amplified 5xxs.
_EN_MAP_CACHE: tuple[float, dict[str, str]] | None = None
_EN_MAP_TTL_SEC = 60.0


def en_text_map(*, force: bool = False) -> dict[str, str]:
    global _EN_MAP_CACHE
    now = time.time()
    if (
        not force
        and _EN_MAP_CACHE is not None
        and (now - _EN_MAP_CACHE[0]) < _EN_MAP_TTL_SEC
    ):
        return _EN_MAP_CACHE[1]
    mapping = flatten_catalog(load_catalog('en'))
    _EN_MAP_CACHE = (now, mapping)
    return mapping


def load_approvals(locale: str) -> dict:
    """Approvals reconciled against current English source (sticky / stale)."""
    raw = load_approvals_raw(locale)
    try:
        reconciled, _stats = reconcile_approvals(raw, en_text_map(), mark_stale=True)
        return reconciled
    except Exception as e:  # noqa: BLE001 — never 500 the UI over reconcile
        sys.stderr.write(f'approval reconcile failed for {locale}: {e}\n')
        return raw if isinstance(raw, dict) else {}


def save_approvals(locale: str, approvals: dict, message: str) -> None:
    """Write the approvals file. Uses the cached blob SHA — no GET first."""
    rel = f'state/approvals/{locale}.json'
    if USE_GITHUB:
        hit, sha, _cached = _cache_get(locale)
        if not hit:
            _existing, sha = gh_get_file(rel)
        new_sha = gh_put_file(rel, approvals, message, sha)
        if new_sha:
            _cache_store(locale, approvals, new_sha)
        else:
            # Don't reuse the previous SHA; the next call must re-read.
            _cache_invalidate(locale)
    else:
        fs_write(APPROVALS / f'{locale}.json', approvals)
        _cache_store(locale, approvals, None)


def commit_approval_updates(
    locale: str,
    updates: dict[str, dict | None],
    message: str,
) -> dict:
    """Apply key updates and write the approvals file once.

    ``updates`` maps a key to a new entry, or None to delete that key.
    On GitHub 409, re-read the file and re-apply the same keys once.
    Returns the approvals map that was written. Caller must already hold
    the checkout (require_holder); this does not change the lock.
    """
    if locale not in LOCALES:
        raise ValueError(f'unsupported locale: {locale}')

    def apply(approvals: dict) -> dict:
        out = dict(approvals)
        for key, entry in updates.items():
            if entry is None:
                out.pop(key, None)
            else:
                out[key] = entry
        return out

    lock = _approval_write_lock(locale)
    with lock:
        approvals = apply(load_approvals(locale))
        try:
            save_approvals(locale, approvals, message)
        except GitHubHTTPError as e:
            if e.code != 409 or not USE_GITHUB:
                raise
            sys.stderr.write(
                f'approval save 409 for {locale}; re-reading and retrying once\n'
            )
            _cache_invalidate(locale)
            approvals = apply(load_approvals(locale))
            save_approvals(locale, approvals, message)
        return approvals


def _approval_keys_from_body(body: dict, *, many: bool) -> list[str]:
    if many:
        raw_keys = body.get('keys')
        if not isinstance(raw_keys, list):
            raise ValueError('keys required')
        keys: list[str] = []
        seen: set[str] = set()
        for item in raw_keys:
            key = item.strip() if isinstance(item, str) else ''
            if not key or key in seen:
                continue
            seen.add(key)
            keys.append(key)
        if not keys:
            raise ValueError('keys required')
        return keys
    key = (body.get('key') or '').strip()
    if not key:
        raise ValueError('key required')
    return [key]


def approve_keys(
    locale: str,
    keys: list[str],
    name: str,
    session_id: str,
    *,
    message: str,
) -> tuple[dict[str, Any], dict]:
    """Check the lock once, then write every key in one approvals commit.

    Returns (entries just written, full approvals map).
    """
    if locale not in LOCALES:
        raise ValueError(f'unsupported locale: {locale}')
    require_holder(load_lock(locale), session_id)
    en_map = en_text_map()
    if any(key not in en_map for key in keys):
        raise ValueError('unknown English key')
    updates = {key: make_approval(name, en_map[key]) for key in keys}
    approvals = commit_approval_updates(locale, updates, message)
    entries = {key: approvals[key] for key in keys if key in approvals}
    return entries, approvals


def load_lock(locale: str) -> dict | None:
    if locale not in LOCALES:
        raise ValueError(f'unsupported locale: {locale}')
    rel = f'state/locks/{locale}.json'
    if USE_GITHUB:
        data, _ = gh_get_file(rel)
        lock = data if isinstance(data, dict) else None
    else:
        lock = fs_read(LOCKS / f'{locale}.json', None)
        if lock is None:
            return None
    if not lock:
        return None
    until = parse_iso(lock.get('until'))
    if until and until <= utcnow():
        return None
    return lock


def save_lock(locale: str, lock: dict | None, message: str) -> None:
    rel = f'state/locks/{locale}.json'
    payload: Any = lock
    if USE_GITHUB:
        _, sha = gh_get_file(rel)
        gh_put_file(rel, payload, message, sha)
    else:
        fs_write(LOCKS / f'{locale}.json', payload)


def set_by_path(root: dict, key: str, text: str) -> None:
    """Numeric parts index lists; existing plain strings stay plain (no {text} wrap)."""
    parts = key.split('.')
    cur = root
    for p in parts[:-1]:
        if isinstance(cur, list):
            cur = cur[int(p)]
            continue
        nxt = cur.get(p)
        if isinstance(nxt, list):
            cur = nxt
            continue
        if not isinstance(nxt, dict) or (
            isinstance(nxt, dict) and 'text' in nxt and set(nxt.keys()) <= {'text', 'note'}
        ):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    leaf = parts[-1]
    if isinstance(cur, list):
        idx = int(leaf)
        cur[idx] = text if isinstance(cur[idx], str) else {**cur[idx], 'text': text}
        return
    existing = cur.get(leaf)
    if isinstance(existing, str):
        cur[leaf] = text
    elif isinstance(existing, dict) and 'text' in existing:
        cur[leaf] = {**existing, 'text': text}
    else:
        cur[leaf] = {'text': text}


def require_holder(lock: dict | None, session_id: str) -> None:
    if not lock or lock.get('sessionId') != session_id:
        raise PermissionError('You do not hold the checkout for this locale')


# --- HTTP handler ------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        cors(self)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith('/api/'):
                self.handle_api_get(path)
            else:
                super().do_GET()
        except Exception as e:  # noqa: BLE001
            send_json(self, 500, {'error': str(e)})

    def do_POST(self) -> None:  # noqa: N802
        self.handle_mutating('POST')

    def do_PUT(self) -> None:  # noqa: N802
        self.handle_mutating('PUT')

    def handle_mutating(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if not path.startswith('/api/'):
                send_json(self, 404, {'error': 'not found'})
                return
            body = read_json_body(self)
            self.handle_api_write(method, path, body)
        except PermissionError as e:
            send_json(self, 403, {'error': str(e)})
        except ValueError as e:
            send_json(self, 400, {'error': str(e)})
        except Exception as e:  # noqa: BLE001
            send_json(self, 500, {'error': str(e)})

    def handle_api_get(self, path: str) -> None:
        m = re.fullmatch(r'/api/catalog/([a-z]{2})', path)
        if m:
            locale = m.group(1)
            cat = load_catalog(locale)
            send_json(self, 200, {'locale': locale, 'catalog': cat})
            return
        m = re.fullmatch(r'/api/approvals/([a-z]{2})', path)
        if m:
            locale = m.group(1)
            send_json(self, 200, {'locale': locale, 'approvals': load_approvals(locale)})
            return
        m = re.fullmatch(r'/api/lock/([a-z]{2})', path)
        if m:
            locale = m.group(1)
            send_json(self, 200, {'locale': locale, 'lock': load_lock(locale)})
            return
        if path == '/api/health':
            send_json(self, 200, {
                'ok': True,
                'storage': 'github' if USE_GITHUB else 'filesystem',
                'repo': GITHUB_REPO or None,
            })
            return
        send_json(self, 404, {'error': 'not found'})

    def handle_api_write(self, method: str, path: str, body: dict) -> None:
        if path == '/api/lock/claim' and method == 'POST':
            locale = (body.get('locale') or '').strip().lower()
            name = (body.get('name') or '').strip()
            session_id = (body.get('sessionId') or '').strip()
            minutes = int(body.get('minutes') or 15)
            if locale not in LOCALES:
                raise ValueError('unsupported locale')
            if len(name) < 2 or not session_id:
                raise ValueError('name and sessionId required')
            current = load_lock(locale)
            acquired = False
            if current is None or current.get('sessionId') == session_id:
                lock = {
                    'holder': name,
                    'sessionId': session_id,
                    'until': iso(utcnow() + timedelta(minutes=max(5, min(minutes, 180)))),
                    'claimedAt': iso(utcnow()),
                }
                save_lock(locale, lock, f'i18n-review: {name} claimed {locale}')
                current = lock
                acquired = True
            try:
                approvals = load_approvals(locale)
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f'claim approvals load failed for {locale}: {e}\n')
                approvals = load_approvals_raw(locale)
            send_json(self, 200, {
                'acquired': acquired,
                'lock': current,
                'approvals': approvals,
            })
            return

        if path == '/api/lock/heartbeat' and method == 'POST':
            locale = (body.get('locale') or '').strip().lower()
            name = (body.get('name') or '').strip()
            session_id = (body.get('sessionId') or '').strip()
            minutes = int(body.get('minutes') or 15)
            current = load_lock(locale)
            if current and current.get('sessionId') == session_id:
                current = {
                    **current,
                    'holder': name or current.get('holder'),
                    'until': iso(utcnow() + timedelta(minutes=max(5, min(minutes, 180)))),
                }
                save_lock(locale, current, f'i18n-review: heartbeat {locale}')
                send_json(self, 200, {'acquired': True, 'lock': current})
            else:
                send_json(self, 200, {'acquired': False, 'lock': current})
            return

        if path == '/api/lock/release' and method == 'POST':
            locale = (body.get('locale') or '').strip().lower()
            session_id = (body.get('sessionId') or '').strip()
            current = load_lock(locale)
            if current and current.get('sessionId') == session_id:
                save_lock(locale, None, f'i18n-review: released {locale}')
            send_json(self, 200, {'ok': True})
            return

        if path == '/api/approve-batch' and method == 'POST':
            locale = (body.get('locale') or '').strip().lower()
            name = (body.get('name') or '').strip()
            session_id = (body.get('sessionId') or '').strip()
            keys = _approval_keys_from_body(body, many=True)
            if locale not in LOCALES:
                raise ValueError(f'unsupported locale: {locale}')
            require_holder(load_lock(locale), session_id)
            en_map = en_text_map()
            known = [key for key in keys if key in en_map]
            unknown = [key for key in keys if key not in en_map]
            if not known:
                raise ValueError('unknown English key')
            # Unknown keys are reported on their own. They do not roll back the rest.
            entries, _approvals = approve_keys(
                locale,
                known,
                name,
                session_id,
                message=f'i18n-review: approve {locale} {len(known)} strings',
            )
            errors = {key: 'unknown English key' for key in unknown}
            send_json(self, 200, {
                'ok': True,
                'locale': locale,
                'entries': entries,
                'errors': errors,
            })
            return

        if path == '/api/approve' and method == 'POST':
            locale = (body.get('locale') or '').strip().lower()
            name = (body.get('name') or '').strip()
            session_id = (body.get('sessionId') or '').strip()
            keys = _approval_keys_from_body(body, many=False)
            key = keys[0]
            entries, approvals = approve_keys(
                locale,
                keys,
                name,
                session_id,
                message=f'i18n-review: approve {locale} {key}',
            )
            send_json(self, 200, {
                'approvals': approvals,
                'entry': entries.get(key),
                'entries': entries,
            })
            return

        if path == '/api/unapprove' and method == 'POST':
            locale = (body.get('locale') or '').strip().lower()
            key = (body.get('key') or '').strip()
            session_id = (body.get('sessionId') or '').strip()
            if locale not in LOCALES:
                raise ValueError(f'unsupported locale: {locale}')
            require_holder(load_lock(locale), session_id)
            approvals = commit_approval_updates(
                locale,
                {key: None},
                f'i18n-review: unlock {locale} {key}',
            )
            send_json(self, 200, {'approvals': approvals})
            return

        if path == '/api/translation' and method == 'PUT':
            locale = (body.get('locale') or '').strip().lower()
            key = (body.get('key') or '').strip()
            text = body.get('text')
            name = (body.get('name') or '').strip()
            session_id = (body.get('sessionId') or '').strip()
            require_holder(load_lock(locale), session_id)
            if not key or text is None:
                raise ValueError('key and text required')
            catalog = load_catalog(locale)
            set_by_path(catalog, key, str(text))
            save_catalog(locale, catalog, f'i18n-review: {name} updated {locale} {key}')
            # Locale edits invalidate approval until the reviewer Approves again.
            approvals = load_approvals(locale)
            if key in approvals:
                approvals = commit_approval_updates(
                    locale,
                    {key: None},
                    f'i18n-review: clear approval after edit {locale} {key}',
                )
            send_json(self, 200, {
                'ok': True,
                'catalog': catalog,
                'approvals': approvals,
            })
            return

        send_json(self, 404, {'error': 'not found'})


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8787)
    args = p.parse_args()

    LOCKS.mkdir(parents=True, exist_ok=True)
    APPROVALS.mkdir(parents=True, exist_ok=True)

    mode = f'GitHub:{GITHUB_REPO}@{GITHUB_BRANCH}' if USE_GITHUB else f'filesystem:{ROOT}'
    print(f'UAOA i18n review → http://{args.host}:{args.port}/')
    print(f'storage: {mode}')
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nbye')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
