# i18n Collaboratory

Multi-project translation review hub for a family of sites.

- Static UI on **GitHub Pages** (this private Team-plan repo; the published site is public)
- Shared state on **Supabase** (Auth, Postgres + RLS, Edge Functions)
- Reviewers sign in with GitHub or email magic link (magic link needs custom SMTP)
- Per-project roles: admin or language reviewer
- Versioned catalog ingest from each site repo via GitHub Actions + a project push secret
- Sticky English fingerprints: unchanged English keeps approvals; changed English shows a side-by-side diff and needs re-approval
- Admins can **download** a `locales/` zip anytime, or **push** files back to the site repo

## Live setup

1. Follow [docs/DEPLOY.md](docs/DEPLOY.md) to create the Supabase project, apply migrations, deploy functions, and enable Pages.
2. Put `supabaseUrl` and `supabaseAnonKey` in [config.js](config.js).
3. Seed a hub admin, create a project, rotate the push secret, invite reviewers.

## Local UI

Serve the repo root over HTTP (Pages-style), not as a `file://` page:

```bash
python3 -m http.server 8787
# open http://127.0.0.1:8787/
```

## Catalog format

Default interchange: one UTF-8 JSON file per locale with the same nested key tree and string leaves (i18next-style). Translator notes live in the database; plain projects also export `*.notes.json`. Projects with `rich_text` keep `{text, note}` leaves and HTML-aware editing via [markup.js](markup.js).

## Site repo push

See [scripts/templates/push-catalogs.yml](scripts/templates/push-catalogs.yml). Body fields include optional `initialApproval` (`approved` | `unapproved`, default `unapproved`) on the **first** push only.

## Legacy Python API

[api/server.py](api/server.py) and [render.yaml](render.yaml) are the inherited Render + GitHub Contents design. They are no longer the production path. Prefer Supabase for shared locks, approvals, and catalog writes.

## Wiki

Architecture notes for agents live in the GitHub wiki (local checkout `.llm-wiki/`).
