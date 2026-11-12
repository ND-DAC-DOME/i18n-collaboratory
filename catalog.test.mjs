#!/usr/bin/env node
/**
 * Flatten + page collection. Run with type stripping so this can import catalog.ts.
 * npm script: node --experimental-strip-types catalog.test.mjs
 */
import assert from 'node:assert/strict';
import { collectPages, flattenCatalog, nestStrings } from './supabase/functions/_shared/catalog.ts';

{
  const flat = flattenCatalog({
    content: {
      educationSteps: {
        1: { note: 'Context matters.', title: 'Step' },
      },
    },
  }, '', 'plain');
  assert.equal(flat['content.educationSteps.1.note'].text, 'Context matters.');
  assert.equal(flat['content.educationSteps.1.title'].text, 'Step');
  const nested = nestStrings(flat, 'plain');
  assert.equal(nested.content.educationSteps['1'].note, 'Context matters.');
  assert.equal(Array.isArray(nested.content.educationSteps), false);
}

{
  const flat = flattenCatalog({
    links: {
      act: {
        note: 'translator metadata, not copy',
        items: [{ text: 'Get Involved' }],
      },
    },
  }, '', 'rich');
  assert.equal(flat['links.act.note'], undefined);
  assert.equal(flat['links.act.items.0'].text, 'Get Involved');
}

{
  const rows = Array.from({ length: 1294 }, (_, i) => ({ key: String(i).padStart(4, '0') }));
  const calls = [];
  const got = await collectPages(async (from, to) => {
    calls.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  });
  assert.equal(got.length, 1294);
  assert.deepEqual(got.map((r) => r.key), rows.map((r) => r.key));
  assert.deepEqual(calls, [
    [0, 999],
    [1000, 1999],
  ]);
}

{
  let n = 0;
  await assert.rejects(
    () => collectPages(async () => {
      n += 1;
      return { data: [{ key: 'loop' }], error: null };
    }, 1),
    /page limit exceeded/,
  );
  assert.equal(n, 100);
}

console.log('catalog.test.mjs ok');
