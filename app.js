(function () {
  'use strict';

  var CFG = window.UAOA_I18N_REVIEW || {};
  var API = (CFG.apiBase || '').replace(/\/$/, '');
  var LOCALES = CFG.locales || [];
  var MODULE_ORDER = ['common', 'course', 'welcome', 'survey', 'm1', 'm2', 'm3', 'm4', 'm5', 'summary', 'embeds', 'player'];
  var MODULE_LABELS = {
    common: 'Common UI',
    course: 'Course outline (sidebar)',
    welcome: 'About Course & Introduction',
    survey: 'Survey',
    m1: 'Module 1',
    m2: 'Module 2',
    m3: 'Module 3',
    m4: 'Module 4',
    m5: 'Module 5',
    summary: 'Summary & Exit',
    embeds: 'Chrome embeds',
    player: 'Player / system labels',
  };

  var state = {
    name: sessionStorage.getItem('uaoa.reviewer') || '',
    sessionId: sessionStorage.getItem('uaoa.sessionId') || '',
    locale: '',
    module: 'common',
    en: null,
    tr: null,
    approvals: {},
    lock: null,
    canEdit: false,
    editingKey: null,
    editingDraft: null,
    editingDraftKey: null,
    pendingKey: null,
    pendingAction: null, // 'save' | 'unapprove' — approvals do not take this lock
    filter: '',
    rowsCache: [],
    approveQueue: {},
    approveInflight: null,
    approveHeld: [],
    approveErrors: {},
    approveFlushTimer: null,
    approveFlushing: false,
    approveFlushPromise: null,
  };

  var el = {
    localeSelect: document.getElementById('localeSelect'),
    reviewerPill: document.getElementById('reviewerPill'),
    lockPill: document.getElementById('lockPill'),
    checkoutBtn: document.getElementById('checkoutBtn'),
    releaseBtn: document.getElementById('releaseBtn'),
    modList: document.getElementById('modList'),
    rows: document.getElementById('rows'),
    stats: document.getElementById('stats'),
    search: document.getElementById('search'),
    banner: document.getElementById('statusBanner'),
    wakeBanner: document.getElementById('wakeBanner'),
    wakeTitle: document.getElementById('wakeBannerTitle'),
    wakeBody: document.getElementById('wakeBannerBody'),
    nameModal: document.getElementById('nameModal'),
    nameInput: document.getElementById('nameInput'),
    nameStart: document.getElementById('nameStart'),
    toast: document.getElementById('toast'),
  };

  // Render free-tier cold starts often take 30–60s.
  var WAKE_SLOW_MS = 2500;
  var WAKE_PING_TIMEOUT_MS = 55000;
  var WAKE_MAX_ATTEMPTS = 6;
  var WAKE_RETRY_GAP_MS = 2000;
  var wakePromise = null;

  function uid() {
    return 's-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function toast(msg, kind) {
    el.toast.textContent = msg;
    el.toast.className = 'toast show' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.toast.classList.remove('show');
    }, 2400);
  }

  function setPending(key, action) {
    state.pendingKey = key || null;
    state.pendingAction = action || null;
  }

  function clearPending() {
    state.pendingKey = null;
    state.pendingAction = null;
  }

  function btnLabel(text, busy) {
    if (!busy) return text;
    return '<span class="btn-spinner" aria-hidden="true"></span><span>' + text + '</span>';
  }

  function isLocalTunnel(base) {
    return /\.loca\.lt$/i.test(String(base || '').replace(/^https?:\/\//i, '').split('/')[0] || '');
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function showWakeBanner(opts) {
    opts = opts || {};
    if (!el.wakeBanner) return;
    el.wakeBanner.hidden = false;
    el.wakeBanner.classList.toggle('is-failed', !!opts.failed);
    if (el.wakeTitle) {
      el.wakeTitle.textContent = opts.title || 'Server is waking up';
    }
    if (el.wakeBody) {
      el.wakeBody.textContent = opts.body ||
        'Please wait up to 1 minute for the server to resume from hibernation.';
    }
  }

  function hideWakeBanner() {
    if (!el.wakeBanner) return;
    el.wakeBanner.hidden = true;
    el.wakeBanner.classList.remove('is-failed');
  }

  function showWakeFailed(detail) {
    showWakeBanner({
      failed: true,
      title: 'API still unavailable',
      body: detail ||
        'The review server did not wake in time. Refresh this page to try again, or check that the Render API is up.',
    });
  }

  /**
   * Probe /api/health until the Render service responds (or attempts are exhausted).
   * Shows a hibernation notice when the first ping is slow, times out, or fails.
   * Dedupes concurrent callers onto one in-flight wake cycle.
   */
  function ensureApiAwake() {
    if (wakePromise) return wakePromise;

    var attempt = 0;
    var slowTimer = setTimeout(function () {
      showWakeBanner();
    }, WAKE_SLOW_MS);

    function clearSlowTimer() {
      if (slowTimer) {
        clearTimeout(slowTimer);
        slowTimer = null;
      }
    }

    function tryPing() {
      attempt += 1;
      var started = Date.now();
      return api('/api/health', {
        retries: 0,
        timeoutMs: WAKE_PING_TIMEOUT_MS,
      }).then(function (data) {
        var elapsed = Date.now() - started;
        clearSlowTimer();
        // Cold start / retries: keep the notice until catalogs finish loading.
        if (elapsed >= WAKE_SLOW_MS || attempt > 1) {
          showWakeBanner();
        }
        return data;
      }).catch(function (err) {
        showWakeBanner();
        if (attempt >= WAKE_MAX_ATTEMPTS) {
          clearSlowTimer();
          throw err;
        }
        return delay(WAKE_RETRY_GAP_MS).then(tryPing);
      });
    }

    wakePromise = tryPing().catch(function (err) {
      wakePromise = null;
      throw err;
    });

    return wakePromise;
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({
      'Accept': 'application/json',
    }, opts.headers || {});
    // Only for localtunnel — custom header forces CORS preflight; Render must allow it.
    if (isLocalTunnel(API)) headers['Bypass-Tunnel-Reminder'] = 'true';
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    var attempts = typeof opts.retries === 'number' ? opts.retries : 2;
    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 45000;

    function once() {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      return fetch(API + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
        keepalive: !!opts.keepalive,
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var err = new Error((data && data.error) || ('HTTP ' + res.status));
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
      }).finally(function () {
        if (timer) clearTimeout(timer);
      });
    }

    function run(left) {
      return once().catch(function (e) {
        var retriable = !e.status || e.status >= 500 || e.name === 'AbortError' ||
          /Failed to fetch|NetworkError|timeout/i.test(String(e.message || e));
        if (left <= 0 || !retriable) throw e;
        return new Promise(function (r) { setTimeout(r, 1500); }).then(function () {
          return run(left - 1);
        });
      });
    }

    return run(attempts);
  }

  // Debounce GitHub approval commits until a couple of seconds after the last click.
  var APPROVE_FLUSH_MS = 2500;

  function localApprovalStamp(name) {
    return {
      approved: true,
      by: name || '',
      at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      _local: true,
    };
  }

  function setApprovals(map) {
    state.approvals = map || {};
    Object.keys(state.approveQueue).forEach(function (key) {
      var item = state.approveQueue[key];
      if (item && item.locale === state.locale && item.entry) {
        state.approvals[key] = item.entry;
      }
    });
    state.approveHeld.forEach(function (payload) {
      if (!payload || payload.locale !== state.locale || !payload.entries) return;
      Object.keys(payload.entries).forEach(function (key) {
        if (state.approveQueue[key]) return;
        state.approvals[key] = payload.entries[key];
      });
    });
  }

  function forgetApprovePayload(payload) {
    state.approveHeld = state.approveHeld.filter(function (item) { return item !== payload; });
    if (state.approveInflight === payload) state.approveInflight = null;
  }

  function dropQueuedApprove(key) {
    var item = state.approveQueue[key];
    if (!item) return null;
    delete state.approveQueue[key];
    if (!Object.keys(state.approveQueue).length && state.approveFlushTimer) {
      clearTimeout(state.approveFlushTimer);
      state.approveFlushTimer = null;
    }
    return item;
  }

  function scheduleApproveFlush() {
    if (state.approveFlushTimer) clearTimeout(state.approveFlushTimer);
    state.approveFlushTimer = setTimeout(function () {
      state.approveFlushTimer = null;
      flushApprovals();
    }, APPROVE_FLUSH_MS);
  }

  function drainApproveQueue() {
    var keys = Object.keys(state.approveQueue);
    if (!keys.length) return null;
    var first = state.approveQueue[keys[0]];
    var locale = first.locale;
    var batchKeys = keys.filter(function (key) {
      return state.approveQueue[key] && state.approveQueue[key].locale === locale;
    });
    var prevByKey = {};
    var entries = {};
    batchKeys.forEach(function (key) {
      var item = state.approveQueue[key];
      prevByKey[key] = item.prev;
      entries[key] = item.entry;
      delete state.approveQueue[key];
    });
    if (Object.keys(state.approveQueue).length) scheduleApproveFlush();
    return {
      locale: locale,
      name: first.name,
      sessionId: first.sessionId,
      keys: batchKeys,
      prevByKey: prevByKey,
      entries: entries,
    };
  }

  function applyApproveSuccess(payload, data) {
    forgetApprovePayload(payload);
    if (state.locale !== payload.locale) return;
    var entries = (data && data.entries) || {};
    payload.keys.forEach(function (key) {
      if (state.approveQueue[key]) return;
      if (entries[key]) state.approvals[key] = entries[key];
      delete state.approveErrors[key];
    });
    renderModules(state.rowsCache);
    renderRows();
  }

  function applyApproveFailure(payload, err) {
    forgetApprovePayload(payload);
    var msg = (err && err.message) || 'Approve failed';
    if (state.locale === payload.locale) {
      payload.keys.forEach(function (key) {
        if (state.approveQueue[key]) return;
        var prev = payload.prevByKey[key];
        if (prev) state.approvals[key] = prev;
        else delete state.approvals[key];
        state.approveErrors[key] = msg;
      });
      renderModules(state.rowsCache);
      renderRows();
    }
    var n = payload.keys.length;
    toast(n === 1 ? (msg || 'Approve failed') : ('Could not save ' + n + ' approvals'), 'error');
  }

  function flushApprovals() {
    if (state.approveFlushTimer) {
      clearTimeout(state.approveFlushTimer);
      state.approveFlushTimer = null;
    }
    var payload = drainApproveQueue();
    if (!payload && !state.approveFlushing) {
      // A batch can already be queued behind the in-flight request (approveHeld)
      // in the moment after that request finishes and before the next one starts.
      if (state.approveHeld.length && state.approveFlushPromise) return state.approveFlushPromise;
      return Promise.resolve();
    }
    if (!payload) return state.approveFlushPromise || Promise.resolve();

    state.approveHeld.push(payload);
    var run = function () {
      state.approveFlushing = true;
      state.approveInflight = payload;
      return api('/api/approve-batch', {
        method: 'POST',
        keepalive: true,
        body: {
          locale: payload.locale,
          keys: payload.keys,
          name: payload.name,
          sessionId: payload.sessionId,
        },
      }).then(function (data) {
        applyApproveSuccess(payload, data);
      }).catch(function (e) {
        applyApproveFailure(payload, e);
      }).finally(function () {
        state.approveFlushing = false;
        forgetApprovePayload(payload);
      });
    };

    if (state.approveFlushing && state.approveFlushPromise) {
      state.approveFlushPromise = state.approveFlushPromise.then(run, run);
    } else {
      state.approveFlushPromise = run();
    }
    return state.approveFlushPromise;
  }

  function settleApproveQueue() {
    function step() {
      if (!Object.keys(state.approveQueue).length && !state.approveFlushing && !state.approveHeld.length) {
        return Promise.resolve();
      }
      return flushApprovals().then(step);
    }
    return step();
  }

  function beaconQueuedApprovals() {
    if (state.approveFlushTimer) {
      clearTimeout(state.approveFlushTimer);
      state.approveFlushTimer = null;
    }
    var payload = drainApproveQueue();
    if (!payload) return false;
    var body = JSON.stringify({
      locale: payload.locale,
      keys: payload.keys,
      name: payload.name,
      sessionId: payload.sessionId,
    });
    // text/plain is a CORS-safelisted type, so sendBeacon can reach the API
    // from GitHub Pages without a preflight during unload.
    var ok = false;
    try {
      if (navigator.sendBeacon) {
        ok = navigator.sendBeacon(
          API + '/api/approve-batch',
          new Blob([body], { type: 'text/plain;charset=UTF-8' })
        );
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      try {
        fetch(API + '/api/approve-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'application/json' },
          body: body,
          keepalive: true,
          mode: 'cors',
        });
      } catch (e2) { /* best effort */ }
    }
    return true;
  }

  function beaconReleaseLock() {
    try {
      navigator.sendBeacon(
        API + '/api/lock/release',
        new Blob([JSON.stringify({
          locale: state.locale,
          name: state.name,
          sessionId: state.sessionId,
        })], { type: 'application/json' })
      );
    } catch (e) { /* ignore */ }
  }

  function leafText(node) {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'object' && typeof node.text === 'string') return node.text;
    return '';
  }

  function leafNote(node) {
    if (node && typeof node === 'object' && node.note) return String(node.note);
    return '';
  }

  function isLeafEntry(v) {
    // Catalog leaf = { text: string, note?: string }. Nested groups that
    // contain a `text` child (scenarios with ok/bad, etc.) must be walked.
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (typeof v.text !== 'string') return false;
    return Object.keys(v).every(function (k) { return k === 'text' || k === 'note'; });
  }

  function walk(obj, prefix, out) {
    // Arrays are walked by index (links.act.items.0.text); a string `note`
    // beside other fields is a translator note, not a learner string.
    if (!obj || typeof obj !== 'object') return;
    Object.keys(obj).forEach(function (k) {
      if (k.charAt(0) === '_') return;
      var path = prefix ? prefix + '.' + k : k;
      var v = obj[k];
      if (isLeafEntry(v)) {
        out.push({ key: path, text: leafText(v), note: leafNote(v) });
      } else if (v && typeof v === 'object') {
        walk(v, path, out);
      } else if (typeof v === 'string' && k !== 'note') {
        out.push({ key: path, text: v, note: '' });
      }
    });
  }

  function getByPath(root, key) {
    var cur = root;
    var parts = key.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== 'object') return null;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function moduleOf(key) {
    return key.split('.')[0] || 'other';
  }

  function widgetOf(key) {
    var parts = key.split('.');
    if (parts.length < 2) return parts[0] || 'root';
    if (parts[0] === 'player') return parts.slice(0, 3).join('.');
    return parts.slice(0, 2).join('.');
  }

  function isUrlOnlyString(key, text) {
    var k = String(key || '');
    if (/\.(url|href|image)$/i.test(k)) return true;
    var plain = window.UAOAMarkup
      ? window.UAOAMarkup.plainText(text || '').trim()
      : String(text || '').replace(/<[^>]+>/g, '').trim();
    return /^https?:\/\/\S+$/i.test(plain);
  }

  function flattenEn() {
    var out = [];
    walk(state.en, '', out);
    // URLs / media paths are not translated — omit from the review list.
    return out.filter(function (r) { return !isUrlOnlyString(r.key, r.text); });
  }

  /** Sticky approval: valid only while EN source fingerprint still matches. */
  function approvalEntry(key) {
    return state.approvals[key] || null;
  }

  function isApproved(key) {
    var a = approvalEntry(key);
    return !!(a && a.approved && !a.stale);
  }

  function isStale(key) {
    var a = approvalEntry(key);
    return !!(a && a.stale && !a.approved);
  }

  function formatStampAt(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch (e) {
      return String(iso);
    }
  }

  /** Approved stamp: by + at. Optional Unapprove when canEdit. */
  function makeStamp(entry, opts) {
    opts = opts || {};
    var stamp = document.createElement('div');
    stamp.className = 'approval-stamp';
    stamp.setAttribute('role', 'status');

    var mark = document.createElement('div');
    mark.className = 'approval-stamp-mark';
    mark.textContent = 'Approved';
    stamp.appendChild(mark);

    var meta = document.createElement('div');
    meta.className = 'approval-stamp-meta';
    var by = (entry && entry.by) || '—';
    var at = formatStampAt(entry && entry.at);
    meta.innerHTML =
      '<span class="approval-stamp-by">by ' + escapeHtml(by) + '</span>' +
      (at ? '<span class="approval-stamp-at">' + escapeHtml(at) + '</span>' : '');
    stamp.appendChild(meta);

    if (opts.canUnapprove && opts.onUnapprove) {
      var un = document.createElement('button');
      un.type = 'button';
      un.className = 'btn-stamp-unapprove' + (opts.pending ? ' is-busy' : '');
      un.innerHTML = btnLabel(opts.pending ? '…' : 'Unapprove', !!opts.pending);
      un.disabled = !!opts.pending || !!opts.disabled;
      un.setAttribute('aria-busy', opts.pending ? 'true' : 'false');
      un.title = 'Clear approval for this string';
      un.addEventListener('click', function () {
        if (state.pendingKey) return;
        opts.onUnapprove();
      });
      stamp.appendChild(un);
    }
    return stamp;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function makeEditButton(key, disabled) {
    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-edit';
    edit.textContent = 'Edit';
    edit.disabled = !!disabled;
    edit.addEventListener('click', function () {
      if (state.pendingKey) return;
      state.editingKey = key;
      state.editingDraft = null;
      state.editingDraftKey = null;
      renderRows();
      var ta = document.getElementById('edit-' + key);
      if (ta) ta.focus();
    });
    return edit;
  }

  function makeApproveButton(key, stale) {
    var approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'btn btn-approve';
    approve.textContent = stale ? 'Re-approve' : 'Approve';
    approve.addEventListener('click', function () {
      approveKey(key);
    });
    return approve;
  }

  function ensureSession() {
    if (!state.sessionId) {
      state.sessionId = uid();
      sessionStorage.setItem('uaoa.sessionId', state.sessionId);
    }
  }

  function localeFromUrl() {
    var q = new URLSearchParams(location.search);
    return (q.get('locale') || LOCALES[0] && LOCALES[0].code || 'es').toLowerCase();
  }

  function setUrlLocale(code) {
    var u = new URL(location.href);
    u.searchParams.set('locale', code);
    history.replaceState(null, '', u.toString());
  }

  function fillLocaleSelect() {
    el.localeSelect.innerHTML = '';
    LOCALES.forEach(function (loc) {
      var opt = document.createElement('option');
      opt.value = loc.code;
      opt.textContent = loc.label + ' (' + loc.code + ')';
      el.localeSelect.appendChild(opt);
    });
  }

  function updateChrome() {
    el.reviewerPill.textContent = state.name ? ('Reviewer: ' + state.name) : 'Reviewer…';
    var lock = state.lock;
    var mine = !!(lock && lock.sessionId === state.sessionId);
    var free = !lock;

    if (free) {
      el.lockPill.textContent = 'Locale available';
      el.lockPill.className = 'pill ok';
    } else if (mine) {
      el.lockPill.textContent = 'Checked out by you';
      el.lockPill.className = 'pill ok';
    } else {
      el.lockPill.textContent = 'In use by ' + (lock.holder || 'someone');
      el.lockPill.className = 'pill busy';
    }

    // Release only while you hold the lease. Start Review stays visible once named:
    // enabled (primary) when free; disabled gray when you hold or someone else does.
    el.releaseBtn.hidden = !(state.canEdit && mine);
    el.checkoutBtn.hidden = !state.name;

    var checkoutHeldByMe = !!(state.canEdit && mine);
    var checkoutBlocked = !free; // mine or someone else
    el.checkoutBtn.disabled = checkoutBlocked || !state.name;
    el.checkoutBtn.classList.toggle('is-held', checkoutHeldByMe);
    el.checkoutBtn.classList.toggle('is-busy-other', !!(lock && !mine));
    el.checkoutBtn.classList.toggle('btn-approve', free && !!state.name);
    el.checkoutBtn.classList.toggle('btn-ghost', !free || !state.name);
    if (checkoutHeldByMe) {
      el.checkoutBtn.title = 'Checked out by you';
      el.checkoutBtn.setAttribute('aria-label', 'Checked out by you');
    } else if (lock && !mine) {
      el.checkoutBtn.title = 'Cannot begin review since locked by ' + (lock.holder || 'someone else');
      el.checkoutBtn.setAttribute('aria-label', 'Cannot begin review since locked by someone else');
    } else {
      el.checkoutBtn.title = 'Start Review to claim this locale and approve or edit';
      el.checkoutBtn.setAttribute('aria-label', 'Start Review');
    }

    if (!state.canEdit) {
      el.banner.hidden = false;
      el.banner.className = 'banner';
      if (lock && !mine) {
        el.banner.textContent = 'Cannot begin review since locked by ' +
          (lock.holder || 'someone else') +
          ' until ' +
          (lock.until ? new Date(lock.until).toLocaleString() : 'later') +
          '. You can browse in read-only mode.';
      } else if (free) {
        el.banner.textContent = 'View only — press Start Review to claim this locale and approve or edit.';
      } else {
        el.banner.textContent = 'Read-only — could not check out this locale. Try again or pick another language.';
      }
    } else {
      el.banner.hidden = false;
      el.banner.className = 'banner ok';
      el.banner.textContent = 'You have an exclusive checkout for ' + state.locale.toUpperCase() +
        '. Approve stamps a line; Edit to change the translation (Save clears approval). Release when done.';
    }
  }

  function moduleStats(allRows) {
    var by = {};
    MODULE_ORDER.forEach(function (m) { by[m] = { total: 0, approved: 0 }; });
    allRows.forEach(function (r) {
      var m = moduleOf(r.key);
      if (!by[m]) by[m] = { total: 0, approved: 0 };
      by[m].total += 1;
      if (isApproved(r.key)) by[m].approved += 1;
    });
    return by;
  }

  function renderModules(allRows) {
    var stats = moduleStats(allRows);
    el.modList.innerHTML = '';
    MODULE_ORDER.forEach(function (m) {
      if (!stats[m] || !stats[m].total) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mod-btn' + (state.module === m ? ' active' : '');
      btn.innerHTML = '<span>' + (MODULE_LABELS[m] || m) + '</span>' +
        '<span class="meta">' + stats[m].approved + ' / ' + stats[m].total + ' approved</span>';
      btn.addEventListener('click', function () {
        state.module = m;
        state.editingKey = null;
        renderModules(allRows);
        renderRows();
      });
      el.modList.appendChild(btn);
    });
  }

  function filteredRows() {
    var q = (state.filter || '').trim().toLowerCase();
    return state.rowsCache.filter(function (r) {
      if (moduleOf(r.key) !== state.module) return false;
      if (!q) return true;
      var tr = leafText(getByPath(state.tr, r.key));
      var enPlain = window.UAOAMarkup ? window.UAOAMarkup.plainText(r.text) : r.text;
      var trPlain = window.UAOAMarkup ? window.UAOAMarkup.plainText(tr) : tr;
      return (r.key + ' ' + enPlain + ' ' + trPlain + ' ' + r.note).toLowerCase().indexOf(q) !== -1;
    });
  }

  function snapshotEditDraft() {
    if (!state.editingKey) return;
    var box = document.getElementById('edit-' + state.editingKey);
    if (!box) return;
    if (window.UAOAMarkup && typeof box._markup === 'string') {
      state.editingDraft = window.UAOAMarkup.readEditor(box);
    } else if ('value' in box) {
      state.editingDraft = box.value;
    }
    state.editingDraftKey = state.editingKey;
  }

  function renderRows() {
    snapshotEditDraft();
    var rows = filteredRows();
    var approved = rows.filter(function (r) { return isApproved(r.key); }).length;
    var stale = rows.filter(function (r) { return isStale(r.key); }).length;
    el.stats.textContent = (MODULE_LABELS[state.module] || state.module) +
      ' · ' + rows.length + ' strings · ' + approved + ' approved' +
      (stale ? ' · ' + stale + ' stale' : '');

    if (!rows.length) {
      el.rows.innerHTML = '<div class="empty">No strings in this module' +
        (state.filter ? ' match your filter' : '') + '.</div>';
      return;
    }

    var groups = {};
    var order = [];
    rows.forEach(function (r) {
      var w = widgetOf(r.key);
      if (!groups[w]) { groups[w] = []; order.push(w); }
      groups[w].push(r);
    });

    el.rows.innerHTML = '';
    order.forEach(function (w) {
      var block = document.createElement('section');
      block.className = 'widget-block';
      var head = document.createElement('header');
      head.textContent = w;
      block.appendChild(head);

      groups[w].forEach(function (r) {
        block.appendChild(renderRow(r));
      });
      el.rows.appendChild(block);
    });
  }

  function renderRow(r) {
    var approved = isApproved(r.key);
    var stale = isStale(r.key);
    var editing = state.editingKey === r.key;
    var pending = state.pendingKey === r.key;
    var pendingSave = pending && state.pendingAction === 'save';
    var pendingUnlock = pending && state.pendingAction === 'unapprove';
    var saveError = state.approveErrors[r.key] || '';
    var trText = leafText(getByPath(state.tr, r.key));
    if (editing && state.editingDraft != null && state.editingDraftKey === r.key) {
      trText = state.editingDraft;
    }

    var row = document.createElement('article');
    row.className = 'row' +
      (pending ? ' is-pending' : '') +
      (stale ? ' is-stale' : '') +
      (saveError && !approved ? ' is-save-failed' : '');
    row.dataset.key = r.key;

    var keyEl = document.createElement('div');
    keyEl.className = 'key';
    keyEl.textContent = r.key;
    row.appendChild(keyEl);

    if (r.note) {
      var note = document.createElement('p');
      note.className = 'note';
      note.textContent = r.note;
      row.appendChild(note);
    }

    var left = document.createElement('div');
    left.innerHTML = '<div class="panel-label">English</div>';
    var enBox = document.createElement('div');
    enBox.className = 'en-box';
    if (window.UAOAMarkup) window.UAOAMarkup.mountPreview(enBox, r.text);
    else enBox.textContent = r.text;
    left.appendChild(enBox);
    row.appendChild(left);

    var right = document.createElement('div');
    right.innerHTML = '<div class="panel-label">Translation (' + state.locale + ')</div>';
    var trBox;
    if (editing) {
      trBox = buildSegmentEditor(r.text, trText, pendingSave);
      trBox.id = 'edit-' + r.key;
    } else {
      trBox = document.createElement('div');
      trBox.className = 'tr-box' + (approved ? ' locked' : '');
      if (window.UAOAMarkup) window.UAOAMarkup.mountPreview(trBox, trText);
      else trBox.textContent = trText || '—';
    }
    right.appendChild(trBox);
    row.appendChild(right);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var entry = approvalEntry(r.key);

    if (!state.canEdit) {
      // View-only: stamp if approved; never stamp when stale; else Read-only.
      if (approved) {
        actions.appendChild(makeStamp(entry, { canUnapprove: false }));
      } else if (stale) {
        var staleRo = document.createElement('span');
        staleRo.className = 'pill busy';
        staleRo.title = 'English source changed since this string was approved';
        staleRo.textContent = 'Source updated — re-approve';
        actions.appendChild(staleRo);
      } else {
        var ro = document.createElement('span');
        ro.className = 'pill ro';
        ro.textContent = 'Read-only';
        actions.appendChild(ro);
      }
    } else if (editing) {
      // Edit mode: hide stamp; Save / Cancel only. Cancel restores stamp if still approved.
      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-save' + (pendingSave ? ' is-busy' : '');
      save.innerHTML = btnLabel(pendingSave ? 'Saving…' : 'Save', pendingSave);
      save.disabled = pendingSave;
      save.setAttribute('aria-busy', pendingSave ? 'true' : 'false');
      save.addEventListener('click', function () {
        if (state.pendingKey) return;
        var next = window.UAOAMarkup ? window.UAOAMarkup.readEditor(trBox) : trBox.value;
        saveEdit(r.key, next);
      });
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-cancel';
      cancel.textContent = 'Cancel';
      cancel.disabled = pendingSave;
      cancel.addEventListener('click', function () {
        if (state.pendingKey) return;
        state.editingKey = null;
        state.editingDraft = null;
        state.editingDraftKey = null;
        renderRows();
      });
      actions.appendChild(save);
      actions.appendChild(cancel);
    } else if (approved) {
      // Stamp + Edit (+ Unapprove on stamp). Edit hides stamp until Cancel/Save.
      actions.appendChild(makeStamp(entry, {
        canUnapprove: true,
        pending: pendingUnlock,
        disabled: pendingUnlock,
        onUnapprove: function () { unapprove(r.key); },
      }));
      actions.appendChild(makeEditButton(r.key, pendingUnlock));
    } else {
      // Not approved: stale banner never uses a stamp; Approve (+ Edit).
      if (stale) {
        var stalePill = document.createElement('span');
        stalePill.className = 'pill busy';
        stalePill.title = 'English source changed since this string was approved — re-approve after review';
        stalePill.textContent = 'Source updated — re-approve';
        actions.appendChild(stalePill);
      }
      actions.appendChild(makeApproveButton(r.key, stale));
      actions.appendChild(makeEditButton(r.key, false));
    }

    row.appendChild(actions);
    if (saveError && state.canEdit && !editing && !approved) {
      var errEl = document.createElement('p');
      errEl.className = 'row-save-error';
      errEl.setAttribute('role', 'alert');
      errEl.textContent = 'Did not save (' + saveError + '). Press Approve to retry.';
      row.appendChild(errEl);
    }
    return row;
  }

  function buildSegmentEditor(enText, locText, disabled) {
    var aligned = window.UAOAMarkup
      ? window.UAOAMarkup.alignLocaleSegments(enText, locText)
      : { segments: [locText || ''], markup: '', hints: [], collapsed: false };
    if (!aligned.markup) {
      var plain = document.createElement('textarea');
      plain.className = 'tr-box editable' + (disabled ? ' is-busy' : '');
      plain.value = locText || '';
      if (disabled) plain.disabled = true;
      return plain;
    }
    var box = document.createElement('div');
    box.className = 'tr-box editable segment-editor' + (disabled ? ' is-busy' : '');
    box._markup = aligned.markup;
    var note = document.createElement('p');
    note.className = 'seg-note';
    note.textContent = aligned.collapsed
      ? 'This translation is not split like the English. The full text is in one field. Saving reapplies the English styling.'
      : 'Edit the words only. Saving reapplies the English styling.';
    box.appendChild(note);
    aligned.segments.forEach(function (seg, i) {
      var label = document.createElement('label');
      label.className = 'seg-field';
      var hint = document.createElement('span');
      hint.className = 'seg-hint';
      hint.textContent = aligned.hints[i] || 'Text';
      var area = document.createElement('textarea');
      area.value = seg;
      area.rows = Math.min(8, Math.max(2, Math.ceil(String(seg || '').length / 72)));
      if (disabled) area.disabled = true;
      label.appendChild(hint);
      label.appendChild(area);
      box.appendChild(label);
    });
    return box;
  }

  function setByPathLocal(root, key, text) {
    var parts = key.split('.');
    var cur = root;
    for (var i = 0; i < parts.length - 1; i++) {
      var p = parts[i];
      if (Array.isArray(cur[p])) { cur = cur[p]; continue; }
      if (!cur[p] || typeof cur[p] !== 'object' || ('text' in cur[p] && Object.keys(cur[p]).every(function (k) {
        return k === 'text' || k === 'note';
      }))) {
        cur[p] = {};
      }
      cur = cur[p];
    }
    var leaf = parts[parts.length - 1];
    var existing = cur[leaf];
    if (typeof existing === 'string') {
      cur[leaf] = text;
    } else if (existing && typeof existing === 'object' && 'text' in existing) {
      cur[leaf] = Object.assign({}, existing, { text: text });
    } else {
      cur[leaf] = { text: text };
    }
  }

  function priorApproval(key) {
    if (state.approveQueue[key]) return state.approveQueue[key].prev;
    var saw = false;
    var found = null;
    state.approveHeld.forEach(function (payload) {
      if (!payload || !payload.prevByKey) return;
      if (!Object.prototype.hasOwnProperty.call(payload.prevByKey, key)) return;
      saw = true;
      found = payload.prevByKey[key];
    });
    if (saw) return found;
    var current = state.approvals[key];
    if (current && current._local) return null;
    return current ? Object.assign({}, current) : null;
  }

  function approveKey(key) {
    if (!state.canEdit || !state.locale || !key) return;
    if (state.pendingKey === key) return;
    delete state.approveErrors[key];
    var prev = priorApproval(key);
    var entry = localApprovalStamp(state.name);
    state.approvals[key] = entry;
    state.approveQueue[key] = {
      locale: state.locale,
      name: state.name,
      sessionId: state.sessionId,
      entry: entry,
      prev: prev,
    };
    scheduleApproveFlush();
    renderModules(state.rowsCache);
    renderRows();
  }

  function unapprove(key) {
    if (state.pendingKey) return;
    var queued = dropQueuedApprove(key);
    delete state.approveErrors[key];
    var inflight = state.approveHeld.some(function (payload) {
      return payload && payload.keys && payload.keys.indexOf(key) !== -1;
    });
    if (queued && !inflight && !queued.prev) {
      delete state.approvals[key];
      renderModules(state.rowsCache);
      renderRows();
      return;
    }
    var wait = inflight ? settleApproveQueue() : Promise.resolve();
    setPending(key, 'unapprove');
    renderRows();
    wait.then(function () {
      return api('/api/unapprove', {
        method: 'POST',
        body: {
          locale: state.locale,
          key: key,
          name: state.name,
          sessionId: state.sessionId,
        },
      });
    }).then(function (data) {
      setApprovals(data.approvals || {});
      delete state.approvals[key];
      delete state.approveErrors[key];
      clearPending();
      toast('Unapproved', 'ok');
      renderModules(state.rowsCache);
      renderRows();
    }).catch(function (e) {
      clearPending();
      toast(e.message || 'Unapprove failed', 'error');
      renderRows();
    });
  }

  function saveEdit(key, text) {
    if (state.pendingKey) return;
    dropQueuedApprove(key);
    delete state.approveErrors[key];
    var inflight = state.approveHeld.some(function (payload) {
      return payload && payload.keys && payload.keys.indexOf(key) !== -1;
    });
    // Keep editingKey so the row stays in edit mode until the request finishes.
    setByPathLocal(state.tr, key, text);
    state.editingDraft = text;
    state.editingDraftKey = key;
    setPending(key, 'save');
    renderRows();
    var wait = inflight ? settleApproveQueue() : Promise.resolve();
    wait.then(function () {
      return api('/api/translation', {
        method: 'PUT',
        body: {
          locale: state.locale,
          key: key,
          text: text,
          name: state.name,
          sessionId: state.sessionId,
        },
      });
    }).then(function (data) {
      if (data.catalog) state.tr = data.catalog;
      else setByPathLocal(state.tr, key, text);
      // Save clears approval for this key until they Approve again.
      if (data.approvals) setApprovals(data.approvals);
      else if (state.approvals[key]) delete state.approvals[key];
      delete state.approvals[key];
      delete state.approveErrors[key];
      clearPending();
      state.editingKey = null;
      state.editingDraft = null;
      state.editingDraftKey = null;
      toast('Saved — re-approve when ready', 'ok');
      renderModules(state.rowsCache);
      renderRows();
    }).catch(function (e) {
      clearPending();
      toast(e.message || 'Save failed', 'error');
      renderRows();
    });
  }

  function claimLocale() {
    return api('/api/lock/claim', {
      method: 'POST',
      body: {
        locale: state.locale,
        name: state.name,
        sessionId: state.sessionId,
        minutes: CFG.leaseMinutes || 15,
      },
    }).then(function (data) {
      state.lock = data.lock || null;
      state.canEdit = !!data.acquired;
      if (data.approvals) setApprovals(data.approvals);
      updateChrome();
      return data;
    });
  }

  function releaseLocale() {
    return api('/api/lock/release', {
      method: 'POST',
      body: {
        locale: state.locale,
        name: state.name,
        sessionId: state.sessionId,
      },
    }).then(function () {
      state.lock = null;
      state.canEdit = false;
      state.editingKey = null;
      updateChrome();
      toast('Locale released — view only until you check out again.');
    }).catch(function (e) { toast(e.message || 'Release failed', 'error'); });
  }

  function heartbeat() {
    if (!state.canEdit || !state.locale) return;
    api('/api/lock/heartbeat', {
      method: 'POST',
      body: {
        locale: state.locale,
        name: state.name,
        sessionId: state.sessionId,
        minutes: CFG.leaseMinutes || 15,
      },
    }).then(function (data) {
      if (data.lock) state.lock = data.lock;
      if (data.acquired === false) {
        state.canEdit = false;
        updateChrome();
        renderRows();
        toast('Checkout lost — locale taken or expired');
      }
    }).catch(function () { /* ignore transient */ });
  }

  function loadLocale(code) {
    state.locale = code;
    state.editingKey = null;
    state.editingDraft = null;
    state.editingDraftKey = null;
    state.approveErrors = {};
    setUrlLocale(code);
    el.localeSelect.value = code;

    return ensureApiAwake().then(function () {
      return Promise.all([
        api('/api/catalog/en'),
        api('/api/catalog/' + encodeURIComponent(code)),
        api('/api/approvals/' + encodeURIComponent(code)),
        api('/api/lock/' + encodeURIComponent(code)),
      ]);
    }).then(function (parts) {
      state.en = parts[0].catalog;
      state.tr = parts[1].catalog;
      setApprovals(parts[2].approvals || {});
      state.lock = parts[3].lock || null;
      state.rowsCache = flattenEn();
      if (!MODULE_ORDER.includes(state.module) ||
          !state.rowsCache.some(function (r) { return moduleOf(r.key) === state.module; })) {
        state.module = 'common';
      }
      // Paint catalogs immediately. Checkout is best-effort — a claim/reconcile
      // failure must not leave the UI blank after sticky-approvals deploy.
      state.canEdit = !!(state.lock && state.lock.sessionId === state.sessionId);
      hideWakeBanner();
      if (el.banner) el.banner.hidden = true;
      updateChrome();
      renderModules(state.rowsCache);
      renderRows();
      return claimLocale().then(function () {
        renderRows();
      }).catch(function (e) {
        toast(e.message || 'Checkout failed — browsing read-only', 'error');
        updateChrome();
        renderRows();
      });
    }).catch(function (e) {
      // Likely still cold-starting or network failure — allow a fresh wake cycle.
      wakePromise = null;
      var msg = e.message || 'network';
      var waking = e.name === 'AbortError' ||
        /Failed to fetch|NetworkError|timeout|abort/i.test(String(msg));
      if (waking) {
        showWakeFailed(
          'Please wait up to 1 minute for the server to resume from hibernation, then refresh. (' + msg + ')'
        );
      } else {
        hideWakeBanner();
        el.banner.hidden = false;
        el.banner.className = 'banner';
        el.banner.textContent = 'API unavailable (' + msg +
          '). Run python3 api/server.py locally, or host the API (Render) and set config.js apiBase.';
      }
      throw e;
    });
  }

  function boot() {
    fillLocaleSelect();
    ensureSession();

    el.localeSelect.addEventListener('change', function () {
      var next = el.localeSelect.value;
      var prev = state.locale;
      if (!next || next === prev) return;
      var go = function () {
        loadLocale(next).catch(function (e) { toast(e.message || 'Failed to load locale'); });
      };
      // Flush while this locale is still checked out, then release.
      // A failed flush stays on the row so the reviewer can retry.
      settleApproveQueue().then(function () {
        if (state.locale === prev && Object.keys(state.approveErrors).length) {
          el.localeSelect.value = prev;
          toast('Some approvals did not save — retry the highlighted rows', 'error');
          return;
        }
        if (state.canEdit && prev) return releaseLocale().finally(go);
        go();
      }).catch(function (e) {
        el.localeSelect.value = prev;
        toast((e && e.message) || 'Could not save approvals before switching', 'error');
      });
    });

    el.releaseBtn.addEventListener('click', function () {
      // Release only — do not re-claim; stay view-only until Start Review.
      releaseLocale().then(function () {
        renderRows();
      });
    });

    el.checkoutBtn.addEventListener('click', function () {
      if (!state.name || !state.locale || el.checkoutBtn.disabled) return;
      claimLocale().then(function (data) {
        renderRows();
        if (data && data.acquired) {
          toast('Checked out — you can approve and edit', 'ok');
        } else {
          toast('Could not begin review — locale may be in use', 'error');
        }
      }).catch(function (e) {
        toast(e.message || 'Start Review failed', 'error');
      });
    });

    el.search.addEventListener('input', function () {
      state.filter = el.search.value;
      renderRows();
    });

    function startReview() {
      loadLocale(localeFromUrl()).catch(function (e) {
        toast(e.message || 'API unavailable', 'error');
      });
    }

    el.nameStart.addEventListener('click', function () {
      var name = (el.nameInput.value || '').trim();
      if (name.length < 2) {
        el.nameInput.focus();
        return;
      }
      state.name = name;
      sessionStorage.setItem('uaoa.reviewer', name);
      el.nameModal.hidden = true;
      startReview();
    });

    el.nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') el.nameStart.click();
    });

    var unloadHandled = false;
    function onLeavePage() {
      if (unloadHandled) return;
      unloadHandled = true;
      var sentApprovals = beaconQueuedApprovals();
      if (!state.canEdit) return;
      // Skip the release beacon while a batch is still being written so the
      // checkout check on that batch still passes. The lease expires on its own.
      if (sentApprovals || state.approveFlushing || state.approveHeld.length) return;
      beaconReleaseLock();
    }
    window.addEventListener('pagehide', onLeavePage);
    window.addEventListener('beforeunload', onLeavePage);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushApprovals();
    });

    setInterval(heartbeat, 120000);

    el.localeSelect.value = localeFromUrl();

    // Kick the Render cold-start early (while the name gate is open if needed).
    ensureApiAwake().catch(function (e) {
      showWakeFailed(
        'Please wait up to 1 minute for the server to resume from hibernation, then refresh. (' +
          (e.message || 'network') + ')'
      );
    });

    if (!state.name) {
      el.nameModal.hidden = false;
      el.nameInput.focus();
    } else {
      el.nameModal.hidden = true;
      startReview();
    }
  }

  boot();
})();
