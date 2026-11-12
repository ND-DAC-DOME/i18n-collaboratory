#!/usr/bin/env node
/**
 * nestFlat / nestStrings shape rules:
 * - 0-based numeric siblings (include "0") → JSON array
 * - 1-based numbered objects ("1","2",…) → plain object (no leading null)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const hubSrc = fs.readFileSync(path.join(rootDir, 'hub.js'), 'utf8');
const sandbox = { UAOA_I18N_REVIEW: {} };
sandbox.globalThis = sandbox;
createContext(sandbox);
runInContext(hubSrc, sandbox);
const nestFlat = sandbox.I18nHub.nestFlat;

function leaf(text, note = '') {
  return { text, note };
}

function sameJson(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

{
  const nested = nestFlat(
    {
      'sections.1.title': leaf('A'),
      'sections.2.title': leaf('B'),
      'sections.3.title': leaf('C'),
      'sections.4.title': leaf('D'),
    },
    'plain',
  );
  assert.ok(!Array.isArray(nested.sections), '1-based keys must stay objects');
  sameJson(nested.sections, {
    1: { title: 'A' },
    2: { title: 'B' },
    3: { title: 'C' },
    4: { title: 'D' },
  });
  assert.equal(JSON.stringify(nested.sections).includes('null'), false);
}

{
  const nested = nestFlat(
    {
      'labels.0': leaf('x'),
      'labels.1': leaf('y'),
    },
    'plain',
  );
  assert.ok(Array.isArray(nested.labels), '0-based keys become arrays');
  sameJson(nested.labels, ['x', 'y']);
}

{
  const nested = nestFlat(
    {
      'ui.edu.labels.1': leaf('What it means'),
      'ui.edu.labels.2': leaf('Why it matters'),
      'content.homePage.why.bullets.1': leaf('One'),
      'content.homePage.why.bullets.2': leaf('Two'),
      'items.0.name': leaf('zero'),
      'items.1.name': leaf('one'),
    },
    'plain',
  );
  assert.ok(!Array.isArray(nested.ui.edu.labels));
  sameJson(nested.ui.edu.labels, {
    1: 'What it means',
    2: 'Why it matters',
  });
  assert.ok(!Array.isArray(nested.content.homePage.why.bullets));
  sameJson(nested.content.homePage.why.bullets, { 1: 'One', 2: 'Two' });
  assert.ok(Array.isArray(nested.items));
  sameJson(nested.items, [{ name: 'zero' }, { name: 'one' }]);
}

{
  const nested = nestFlat(
    {
      'a.1': leaf('Hi', 'greeting'),
    },
    'rich',
  );
  sameJson(nested, { a: { 1: { text: 'Hi', note: 'greeting' } } });
}

console.log('nest.test.mjs: ok');
