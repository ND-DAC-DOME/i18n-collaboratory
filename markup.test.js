#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var markup = require('./markup.js');

var strong = '<strong>Correct!</strong> This is <strong>hate speech</strong>.';
var strongSplit = markup.splitHtml(strong);
assert.strictEqual(
  strongSplit.text,
  'Correct! ¦  This is  ¦ hate speech ¦ .'
);
assert.strictEqual(
  strongSplit.markup,
  '<strong>{0}</strong>{1}<strong>{2}</strong>{3}'
);
assert.strictEqual(markup.joinHtml(strongSplit.text, strongSplit.markup), strong);

var colored = '<span style="color: #fff">Title</span>';
var coloredSplit = markup.splitHtml(colored);
assert.strictEqual(coloredSplit.text, 'Title');
assert.strictEqual(coloredSplit.markup, '<span style="color: #fff">{0}</span>');
assert.strictEqual(markup.joinHtml(coloredSplit.text, coloredSplit.markup), colored);
assert.deepStrictEqual(markup.segmentHints(coloredSplit.markup), ['Colored']);

var edited = markup.joinSegments(
  ['¡Correcto!', ' Esto es ', 'discurso de odio', '.'],
  strongSplit.markup
);
assert.strictEqual(
  edited,
  '<strong>¡Correcto!</strong> Esto es <strong>discurso de odio</strong>.'
);
assert.ok(!/<[a-z]/i.test(markup.plainText(edited)));

var linked = '<p>See the <a href="https://example.com/" target="_blank"><strong>UAOA Barometer</strong></a>.</p>';
var linkedSplit = markup.splitHtml(linked);
assert.ok(linkedSplit.markup.indexOf('href="https://example.com/"') !== -1);
assert.strictEqual(
  markup.joinHtml(linkedSplit.text, linkedSplit.markup),
  linked
);
assert.deepStrictEqual(
  markup.segmentHints(linkedSplit.markup),
  ['Text', 'Bold', 'Text']
);
assert.ok(markup.segmentHints(linkedSplit.markup).indexOf('Link') < 0);

var plain = 'Next';
assert.strictEqual(markup.splitHtml(plain).markup, '');
assert.strictEqual(markup.joinHtml(plain, ''), plain);

var en = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../source/i18n/en.json'),
  'utf8'
));

function walk(obj, prefix, out) {
  if (!obj || typeof obj !== 'object') return;
  Object.keys(obj).forEach(function (k) {
    if (String(k).charAt(0) === '_') return;
    var p = prefix ? prefix + '.' + k : k;
    var v = obj[k];
    if (v && typeof v === 'object' && typeof v.text === 'string' &&
        Object.keys(v).every(function (key) { return key === 'text' || key === 'note'; })) {
      out.push([p, v.text]);
    } else if (v && typeof v === 'object') {
      walk(v, p, out);
    }
  });
}

var rows = [];
walk(en, '', rows);
var tagged = 0;
var mismatches = [];
rows.forEach(function (row) {
  var split = markup.splitHtml(row[1]);
  if (!split.markup) return;
  tagged += 1;
  var joined = markup.joinHtml(split.text, split.markup);
  if (joined !== row[1]) mismatches.push(row[0]);
});

assert.ok(tagged > 200, 'expected tagged catalog strings, got ' + tagged);
assert.deepStrictEqual(mismatches, ['welcome.about.aboutTheCourse.body']);

var spanRow = rows.filter(function (row) {
  return row[1].indexOf('<span style="color:') !== -1 && row[1].indexOf('<strong>') !== -1;
})[0];
assert.ok(spanRow, 'missing colored span fixture');
var spanJoined = markup.joinHtml(
  markup.splitHtml(spanRow[1]).text,
  markup.splitHtml(spanRow[1]).markup
);
assert.strictEqual(spanJoined, spanRow[1], spanRow[0]);

console.log('markup.test.js ok — tagged round-trips ' + tagged + ', known drift ' + mismatches.length);
