# UAOA Translation Review

Public review UI for approving / editing course translations.

- English (read-only) left · translation right  
- **Approve** stamps a string (by + at) · **Edit** opens a textarea · **Unapprove** clears the stamp  
- Grouped by module → widget; filter box for search  
- Locale dropdown or shareable `?locale=es`  
- Name gate on load (no account)  
- **Locale checkout lease** — one active editor per language (others read-only). **Start reviewing** / load a locale claims a lease; a heartbeat renews it while the tab is open; **Release** gives up edit rights (view-only until **Start Review** again); stale leases expire after `leaseMinutes`.
- **Sticky approvals** — approvals fingerprint the English source string at approve time (`enFp`). Re-syncing catalogs does **not** clear approvals when EN text is unchanged. If EN changes, the UI shows “Source updated — re-approve” (no stamp) until Approves again. **Saving a translation clears that key’s approval** until re-approved. Cancel edit (no save) restores the stamp if still approved. Sidebar progress counts only non-stale approvals.

## Live

| | URL |
|---|---|
| **UI (GitHub Pages)** | https://jhendri4.github.io/uaoa-i18n-review/ |
| **API (Render)** | https://uaoa-i18n-review-api.onrender.com |

The Pages site is static (`config.js` → `apiBase`). Shared locks/saves go through the Render API; the GitHub token stays on the server.

## Local (UI + API together)

```bash
cd tools/i18n-review          # or the uaoa-i18n-review clone
python3 scripts/sync_catalogs.py
python3 api/server.py        # http://127.0.0.1:8787/
```

Open that URL (not the raw `index.html` file). Filesystem mode writes under `data/` + `state/`.

## Deploy / redeploy the API (Render)

Live service: **`uaoa-i18n-review-api`** → https://uaoa-i18n-review-api.onrender.com  
Dashboard: https://dashboard.render.com/web/srv-dbcfoomktt5c73faov7g

Uses the **standalone** repo `jhendri4/uaoa-i18n-review` (not the elearning monorepo root).

**Redeploy after API changes:** push to `main` on that repo (auto-deploy is on), or:

```bash
brew install render   # once
render login          # once
render workspace set tea-dbcfnp3l550s73908nvg
render deploys create srv-dbcfoomktt5c73faov7g --confirm
```

**Rotate the GitHub token (recommended):** create a fine-grained PAT with **Contents: Read & write** on `jhendri4/uaoa-i18n-review` only, then in the Render dashboard set env **`GITHUB_TOKEN`** (keep `GITHUB_REPO` / `GITHUB_BRANCH` as in `render.yaml`). Prefer a PAT over a short-lived `gh` OAuth token.

Health check: `GET /api/health` → `{"ok":true,"storage":"github",...}`.

Free-tier services sleep when idle; the first request after sleep can take ~30–60s. The UI probes `/api/health` on load, shows a sticky hibernation banner while waiting (“Please wait up to 1 minute…”), retries for a few minutes, then clears the banner once catalogs load.

## Point Pages at the API

In both this folder and the Pages repo, `config.js` should be:

```js
window.UAOA_I18N_REVIEW = {
  apiBase: 'https://uaoa-i18n-review-api.onrender.com',
  // ...
};
```

Bump the `?v=` query on the script tags in `index.html` when changing `config.js` / `app.js` so browsers pick up the new API URL.

## Sync catalogs

From the elearning monorepo:

```bash
python3 tools/i18n-review/scripts/sync_catalogs.py
# then copy tools/i18n-review/data (+ approval_util.py / API / UI) → uaoa-i18n-review and push
```

`sync_catalogs.py` also reconciles `state/approvals/{locale}.json` against current EN:
migrates legacy entries (backfills `enFp`), marks EN-changed keys stale, drops removed keys.

Reviewed `data/<locale>.json` can be copied back into `source/i18n/`.

### Approval entry shape

```json
{
  "approved": true,
  "by": "Reviewer Name",
  "at": "2026-10-21T20:00:00Z",
  "enFp": "<sha256 hex of English source text at approve time>"
}
```

When EN source for a key changes:

```json
{
  "approved": false,
  "stale": true,
  "staleReason": "en_source_changed",
  "staleAt": "2026-10-21T21:00:00Z",
  "by": "Reviewer Name",
  "at": "2026-10-21T20:00:00Z",
  "enFp": "<previous fingerprint>"
}
```
