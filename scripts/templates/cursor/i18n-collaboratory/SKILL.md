---
name: i18n-collaboratory
description: >-
  Connects an application repo to the i18n collaboratory translation backend:
  catalog shape, GitHub Action ingest, admin upload, sticky English approvals,
  and pulling reviewed locales back. Use when adding or editing locale JSON,
  user-facing copy, placeholders, i18n keys, translation review, catalog ingest,
  or the collaboratory.
---

# i18n collaboratory (site repo)

The collaboratory reviews translations. This repo loads them. Do the work below in the site repo. Create the hub project, invite reviewers, and store the GitHub push token in the hub Admin UI; those steps are not done by editing this repo.

Read `.cursor/rules/i18n-collaboratory.mdc` for the invariants. This skill is the procedure.

## Decide the interchange

The hub accepts one UTF-8 JSON file per locale, same nested tree, in a single directory (default `locales/`).

| This repo already has | Do this |
|---|---|
| `locales/{code}.json` (or the same shape in another directory) | Point `LOCALES_DIR` at that directory. |
| Several files per locale (for example `{code}/ui.json` and `{code}/content.json`) | Keep that layout as what the app builds. Add pack/unpack scripts. Ingest and export only the packed flat files. |
| HTML in string values that must keep English tags and link targets | Set hub `rich_text` on. Leaves may be `{text, note}`. |
| Markdown, or only interpolation tokens | Set hub `rich_text` off. Leaves stay bare strings. Notes, when present, travel in `{code}.notes.json` on export. |

Pack merges namespaces with a stable prefix (`ui.*`, `content.*`) so keys cannot collide. Unpack must restore the app’s files byte-for-byte aside from translation text. Ingest only the packed files. Leave sibling data files (navigation trees, `structure.json`, anything that is not copy) out of the zip and out of `LOCALES_DIR`.

`placeholder_style` on the hub project is one of `i18next`, `icu`, `single-brace`, `auto`. `auto` is the right default when the catalog mixes styles or you have not classified them. There is no separate mustache value; `{{name}}` is preserved as text under `auto`.

## First connection

1. A hub admin creates the project: slug, `source_locale`, `placeholder_style`, `rich_text`, GitHub repo, branch, and locales path (the directory push-to-repo writes).
2. Copy `scripts/templates/push-catalogs.yml` to `.github/workflows/push-catalogs.yml` and `scripts/templates/push-catalogs.mjs` to `scripts/push-catalogs.mjs`. Set `LOCALES_DIR` to the flat directory. Narrow the workflow `paths:` filter to that directory plus the pack script if packing is required.
3. Repo secrets: `I18N_INGEST_URL` (`https://<ref>.supabase.co/functions/v1/ingest`) and `I18N_PUSH_SECRET` (from hub Admin, shown once). Variable: `I18N_PROJECT_SLUG`.
4. First ingest only: set `initialApproval` to `approved` when the existing translations are already trusted, otherwise leave `unapproved`. Later pushes ignore the flag.
5. Trigger ingest (Action on push to the locale paths, or `workflow_dispatch`). Confirm the hub reports a new head version and a non-zero string count. Sending the same `versionHash` again changes nothing.
6. Admin → save a GitHub token on the project if reviewers should push files back. The token is encrypted in the hub. It does not belong in this repo.

Admin folder/zip upload is the same trees without the push secret. The browser upload’s version hash is a content hash, so a later Action push with a git SHA still applies.

## After English changes

1. Edit the source locale in this repo (and pack, if this repo packs).
2. Ingest. Keys whose English text changed become stale in every locale. Keys whose English text is unchanged stay approved. Keys removed from English are dropped. A missing `en_fp` on an old approval is backfilled from current English and kept approved.
3. Tell reviewers to re-approve stale keys in the collaboratory. The UI shows the previous English beside the new English.

Do not clear stale flags from this repo. Do not copy an old translation onto new English and call it approved.

## Pulling translations back

1. Prefer hub Admin push-to-repo when the project has a repo, branch, locales path, and stored token. Otherwise download the locales zip.
2. Push-to-repo writes one Git commit (author/committer `i18n-collaboratory`) with only review-locale files that differ from the branch tip. It does **not** rewrite the source locale (`en.json` unless the project says otherwise) — this repo owns English. Expect `{code}.json` for each review locale; plain projects may also get `{code}.notes.json`. `manifest.json` is included only when locale files change. Zip download still includes the source locale.
3. Read `manifest.unapproved`. Export includes unapproved and stale text. Ship a release only when that count is acceptable for this app.
4. Unpack into the runtime layout if step “Decide the interchange” required packing. Prefer keeping the source locale file from git unless English was intentionally changed here. Run this repo’s i18n check and a build.
5. Commit the unpacked catalogs. The next ingest of that same git SHA is a no-op; a newer SHA with the same strings reconciles without clearing approvals.

Someone else may hold focus on a single key for about 45 seconds. That lock is inside the hub. It does not block ingest or a push-to-repo.

## Catalog rules that break ingest or review

- Include the source file (`en.json` unless the project says otherwise). Ingest rejects a payload without it.
- Keep leaf types stable. A string stays a string on the way back. A `{text, note}` object stays an object when `rich_text` is on; extra keys on that object are not leaves and are not preserved.
- Do not put numbers, booleans, or objects-with-extra-fields where a string should be. Those nodes are walked or skipped, not stored as copy.
- Do not rename placeholder identifiers inside a translation. Reviewers and later agents match them to the English tokens.
- With `rich_text`, do not rewrite English tags to change wording. Tag and `href` changes are source changes; the editor puts the words back into the English markup on save.
- Skip files named `*.notes.json` and `manifest.json` when assembling an ingest body. The template script already does this.

## What this skill does not do

Do not deploy the hub, edit its Edge Functions, or add a one-site folder layout to ingest. Do not use the legacy Python server or Render. Reviewers sign in on the collaboratory Pages site with GitHub or a magic link; roles are per project (`admin`, or `reviewer` plus assigned locales).
