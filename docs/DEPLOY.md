# Deploy the i18n Collaboratory hub

Zero-cost target: **GitHub Pages** (public site from this private Team-plan repo) + one **Supabase Free** project.

## 1. Supabase project

1. Create a free Supabase project.
2. Apply migrations from `supabase/migrations/` (`npx supabase db push` after `npx supabase link`).
3. Deploy Edge Functions:
   - `ingest` (`verify_jwt = false`)
   - `credentials`
   - `push`
4. Function secrets:
   - `CREDENTIALS_ENCRYPTION_KEY` — long random string used to encrypt per-project GitHub tokens
5. Auth → enable **GitHub** and **Email**. Set Site URL / redirect to the Pages URL.
6. Custom SMTP is required before magic-link works for addresses outside the Supabase org team. No specific SMTP vendor is required.
7. Seed yourself as hub admin after first sign-in:

```sql
insert into public.hub_admins (user_id)
values ('<your auth.users id>');
```

## 2. Pages site

1. Put the public URL and anon key in `config.js` (`supabaseUrl`, `supabaseAnonKey`).
2. Settings → Pages → publish from the root of `main` (or `docs/` if you move the static files).
3. The site is public. The repository can stay private on GitHub Team.

## 3. Keep-alive workflow

Add repository secrets:

| Secret | Purpose |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Personal access token with `projects:write` |
| `SUPABASE_PROJECT_REF` | Project ref |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Publishable key |

Enable [.github/workflows/supabase-keepalive.yml](../.github/workflows/supabase-keepalive.yml). It runs daily: restores a paused project via the Management API, otherwise pings PostgREST so the free project stays active.

The browser cannot wake a paused project. If the API is down, the UI asks the reviewer to retry shortly.

## 4. Import this checkout (optional)

```bash
npm install @supabase/supabase-js
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
export HUB_ADMIN_USER_ID=...
node scripts/import_local_catalogs.mjs
```

Imports `data/*.json` and `state/approvals/*.json` into project slug `uaoa` with `rich_text=true`, preserving existing approval stamps.

## 5. Site repos

Copy [scripts/templates/push-catalogs.yml](../scripts/templates/push-catalogs.yml) and [scripts/templates/push-catalogs.mjs](../scripts/templates/push-catalogs.mjs) into each site. Create the project in the hub Admin UI, rotate a push secret, set `I18N_INGEST_URL` / `I18N_PUSH_SECRET` / `I18N_PROJECT_SLUG`.

First push: set `INITIAL_APPROVAL=approved` when adopting an already-accepted catalog; omit or use `unapproved` for a new site.

## 6. Local API (legacy)

`python3 api/server.py` still serves the old filesystem / GitHub-Contents backend for offline experiments. Production is Pages + Supabase.
