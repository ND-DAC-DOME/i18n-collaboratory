#!/usr/bin/env node
/**
 * One-time import of this repo's data/*.json + state/approvals into Supabase.
 *
 * Requires env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   PROJECT_SLUG (default uaoa)
 *   PROJECT_NAME (default UAOA Translation Review)
 *   HUB_ADMIN_USER_ID — auth.users id to seed as hub admin + project admin
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const slug = process.env.PROJECT_SLUG || 'uaoa';
const name = process.env.PROJECT_NAME || 'UAOA Translation Review';
const hubAdmin = process.env.HUB_ADMIN_USER_ID || '';

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

function isLeafEntry(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  if (typeof node.text !== 'string') return false;
  return Object.keys(node).every((k) => k === 'text' || k === 'note');
}

function flatten(obj, prefix = '', out = {}) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
    return out;
  }
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (String(k).startsWith('_')) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (isLeafEntry(v)) {
      out[p] = { text: v.text, note: v.note || '' };
    } else if (v && typeof v === 'object') {
      flatten(v, p, out);
    } else if (typeof v === 'string' && k !== 'note') {
      out[p] = { text: v, note: '' };
    }
  }
  return out;
}

function sha(text) {
  return crypto.createHash('sha256').update(text || '', 'utf8').digest('hex');
}

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const reviewLocales = ['es', 'cs', 'sl', 'sv', 'fr'];
const en = flatten(loadJson('data/en.json'));

if (hubAdmin) {
  await sb.from('hub_admins').upsert({ user_id: hubAdmin });
}

const { data: existing } = await sb.from('projects').select('*').eq('slug', slug).maybeSingle();
let project = existing;
if (!project) {
  const { data, error } = await sb.from('projects').insert({
    slug,
    name,
    source_locale: 'en',
    rich_text: true,
    placeholder_style: 'auto',
    locales_path: 'data',
    head_version_hash: 'local-import',
  }).select('*').single();
  if (error) throw error;
  project = data;
}

if (hubAdmin) {
  await sb.from('project_members').upsert({
    project_id: project.id,
    user_id: hubAdmin,
    role: 'admin',
  }, { onConflict: 'project_id,user_id' });
}

for (const code of reviewLocales) {
  await sb.from('project_locales').upsert({
    project_id: project.id,
    locale: code,
    label: code,
  });
}

const sourceRows = Object.entries(en).map(([key, leaf]) => ({
  project_id: project.id,
  key,
  text: leaf.text,
  note: leaf.note,
  text_fp: sha(leaf.text),
  previous_text: null,
}));

for (let i = 0; i < sourceRows.length; i += 200) {
  const { error } = await sb.from('source_strings').upsert(sourceRows.slice(i, i + 200));
  if (error) throw error;
}

const now = new Date().toISOString();
for (const code of reviewLocales) {
  const catalog = flatten(loadJson(`data/${code}.json`));
  let approvals = {};
  try {
    approvals = loadJson(`state/approvals/${code}.json`);
  } catch {
    approvals = {};
  }

  const rows = Object.keys(en).map((key) => {
    const leaf = catalog[key] || { text: '', note: '' };
    const a = approvals[key];
    const approved = !!(a && a.approved && !a.stale);
    return {
      project_id: project.id,
      locale: code,
      key,
      text: leaf.text,
      note: leaf.note,
      approved,
      approved_by: null,
      approved_at: approved ? (a.at || now) : null,
      en_fp: approved ? (a.enFp || sha(en[key].text)) : null,
      stale: !!(a && a.stale && !a.approved),
      stale_reason: a && a.stale ? (a.staleReason || 'en_source_changed') : null,
      updated_at: now,
    };
  });

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from('translations').upsert(rows.slice(i, i + 200));
    if (error) throw error;
  }
  const approvedCount = rows.filter((r) => r.approved).length;
  console.log(`${code}: imported ${rows.length} keys, approved=${approvedCount}`);
}

await sb.from('revisions').upsert({
  project_id: project.id,
  version_hash: 'local-import',
  source_key_count: Object.keys(en).length,
  changed_key_count: 0,
  initial_approval: 'approved',
}, { onConflict: 'project_id,version_hash' });

console.log('done', { projectId: project.id, slug, sourceKeys: Object.keys(en).length });
