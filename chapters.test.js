#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'chapters.js'), 'utf8'));
const chapters = globalThis.ReviewChapters;

function leaves(node, prefix, out) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    Object.keys(node).forEach(function (key) {
      leaves(node[key], prefix ? prefix + '.' + key : key, out);
    });
    return;
  }
  if (prefix) out.push(prefix);
}

function repeat(prefix, count) {
  var keys = [];
  for (var i = 0; i < count; i++) keys.push(prefix + '.k' + i);
  return keys;
}

var flat = []
  .concat(repeat('ui.nav', 20), repeat('ui.question', 30))
  .concat(repeat('content.homePage.howto', 40))
  .concat(repeat('content.assessment.sections.1.questions.1', 300))
  .concat(repeat('content.assessment.sections.2.questions.3', 300))
  .concat(repeat('notes.item', 300))
  .concat(repeat('flatbag', 600));

assert.deepStrictEqual(chapters.orderChapters(chapters.deriveChapters(flat)), [
  'ui',
  'content.homePage',
  'content.assessment.sections.1',
  'content.assessment.sections.2',
  'flatbag',
  'notes',
]);

assert.strictEqual(
  chapters.chapterOf('content.assessment.sections.2.questions.3.k4', [
    'content.assessment.sections.1',
    'content.assessment.sections.2',
  ]),
  'content.assessment.sections.2'
);
assert.strictEqual(
  chapters.groupOf('content.assessment.sections.1.questions.4.text', 'content.assessment.sections.1'),
  'content.assessment.sections.1.questions.4'
);
assert.strictEqual(
  chapters.groupLabel('content.assessment.sections.1.questions.4', 'content.assessment.sections.1'),
  'Question 4'
);
assert.strictEqual(
  chapters.groupLabel('player.systemLabels.navigation', 'player'),
  'player.systemLabels.navigation'
);
assert.strictEqual(
  chapters.groupOf('player.systemLabels.navigation.next', 'player'),
  'player.systemLabels.navigation'
);
assert.strictEqual(chapters.label('content.homePage'), 'Home');
assert.strictEqual(chapters.label('content.assessment.sections.3'), 'Assessment §3');
assert.strictEqual(chapters.deriveChapters(['_meta.locale', '_inventory.summary']).length, 0);

var uaoa = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/en.json'), 'utf8'));
var uaoaKeys = [];
leaves(uaoa, '', uaoaKeys);
assert.deepStrictEqual(
  chapters.orderChapters(chapters.deriveChapters(uaoaKeys)),
  ['common', 'course', 'welcome', 'survey', 'm1', 'm2', 'm3', 'm4', 'm5', 'summary', 'embeds', 'player']
);

var orpPath = '/Users/jhendri4/Documents/GitHub/orp_website/frontend/locales/en.json';
if (fs.existsSync(orpPath)) {
  var orp = JSON.parse(fs.readFileSync(orpPath, 'utf8'));
  var orpKeys = [];
  leaves(orp, '', orpKeys);
  var orpChapters = chapters.orderChapters(chapters.deriveChapters(orpKeys));
  assert.deepStrictEqual(orpChapters, [
    'ui',
    'content.homePage',
    'content.educationSteps',
    'content.rolePrompt',
    'content.prepIntro',
    'content.assessment.sections.1',
    'content.assessment.sections.2',
    'content.assessment.sections.3',
    'content.assessment.sections.4',
    'content.printRecs',
    'content.reportIntro',
    'content.disclaimers',
  ]);
  orpKeys.forEach(function (key) {
    var chapter = chapters.chapterOf(key, orpChapters);
    assert.ok(orpChapters.indexOf(chapter) !== -1, key);
    assert.ok(key === chapter || key.indexOf(chapter + '.') === 0, key + ' -> ' + chapter);
  });
  assert.strictEqual(orpKeys.length, 1288);
}

console.log('chapters.test.js ok');
