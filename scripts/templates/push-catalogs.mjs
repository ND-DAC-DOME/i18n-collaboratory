#!/usr/bin/env node
/**
 * Push locale JSON files from a site repo to the i18n collaboratory ingest function.
 *
 * Env:
 *   INGEST_URL, I18N_PUSH_SECRET, VERSION_HASH, PROJECT_SLUG
 *   SOURCE_LOCALE (default en), LOCALES_DIR (default locales)
 *   INITIAL_APPROVAL (approved|unapproved, first push only)
 */
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.INGEST_URL;
const secret = process.env.I18N_PUSH_SECRET;
const versionHash = process.env.VERSION_HASH;
const projectSlug = process.env.PROJECT_SLUG;
const sourceLocale = process.env.SOURCE_LOCALE || 'en';
const localesDir = process.env.LOCALES_DIR || 'locales';
const initialApproval = process.env.INITIAL_APPROVAL || 'unapproved';

if (!url || !secret || !versionHash || !projectSlug) {
  console.error('Missing INGEST_URL, I18N_PUSH_SECRET, VERSION_HASH, or PROJECT_SLUG');
  process.exit(1);
}

const locales = {};
for (const name of fs.readdirSync(localesDir)) {
  if (!name.endsWith('.json') || name.endsWith('.notes.json') || name === 'manifest.json') {
    continue;
  }
  const code = name.replace(/\.json$/, '');
  const raw = fs.readFileSync(path.join(localesDir, name), 'utf8');
  locales[code] = JSON.parse(raw);
}

if (!(sourceLocale in locales)) {
  console.error(`Missing source locale file ${sourceLocale}.json in ${localesDir}`);
  process.exit(1);
}

const body = {
  projectSlug,
  versionHash,
  sourceLocale,
  initialApproval,
  locales,
};

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error('Ingest failed', res.status, data);
  process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
