/**
 * Sidebar chapters for the review list.
 * UAOA stays one chapter per top-level module. Larger trees (ORP) split on
 * the key path, and stop at assessment.sections.N so a section stays one chapter.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ReviewChapters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Largest UAOA module (player) is about 430 strings. Anything bigger is split,
  // except children of a `sections` node, which stay intact (ORP assessment).
  var MAX_CHAPTER_KEYS = 500;
  // A flat bag of string keys is not a chapter boundary.
  var MAX_SPLIT_FANOUT = 24;

  var NAV_ORDER = [
    'common',
    'course',
    'welcome',
    'survey',
    'm1',
    'm2',
    'm3',
    'm4',
    'm5',
    'summary',
    'embeds',
    'player',
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
  ];

  var NAV_LABELS = {
    common: 'Common UI',
    course: 'Course outline (sidebar)',
    welcome: 'About Course & Introduction',
    survey: 'Survey',
    m1: 'Module 1',
    m2: 'Module 2',
    m3: 'Module 3',
    m4: 'Module 4',
    m5: 'Module 5',
    summary: 'Summary & Exit',
    embeds: 'Chrome embeds',
    player: 'Player / system labels',
    ui: 'UI',
    'content.homePage': 'Home',
    'content.educationSteps': 'Key Concepts',
    'content.rolePrompt': 'Role prompt',
    'content.prepIntro': 'Prep',
    'content.assessment.sections.1': 'Assessment §1',
    'content.assessment.sections.2': 'Assessment §2',
    'content.assessment.sections.3': 'Assessment §3',
    'content.assessment.sections.4': 'Assessment §4',
    'content.printRecs': 'Print recommendations',
    'content.reportIntro': 'Report intro',
    'content.disclaimers': 'Disclaimers',
  };

  var NAV_INDEX = {};
  NAV_ORDER.forEach(function (id, i) { NAV_INDEX[id] = i; });

  function reviewKey(key) {
    var text = String(key || '');
    if (!text || text.charAt(0) === '_') return '';
    if (text.split('.')[0].charAt(0) === '_') return '';
    return text;
  }

  function childGroups(prefix, keys) {
    var depth = prefix ? prefix.split('.').length : 0;
    var groups = [];
    var index = Object.create(null);
    var exact = [];
    keys.forEach(function (key) {
      if (prefix && key === prefix) {
        exact.push(key);
        return;
      }
      var parts = key.split('.');
      if (parts.length <= depth) return;
      var child = parts.slice(0, depth + 1).join('.');
      var group = index[child];
      if (!group) {
        group = { prefix: child, keys: [] };
        index[child] = group;
        groups.push(group);
      }
      group.keys.push(key);
    });
    return { groups: groups, exact: exact };
  }

  function emitOrDivide(group, out) {
    if (group.keys.length > MAX_CHAPTER_KEYS) partition(group.prefix, group.keys, out);
    else out.push(group.prefix);
  }

  function partition(prefix, keys, out) {
    var split = childGroups(prefix, keys);
    if (!split.groups.length) {
      if (prefix && (split.exact.length || keys.length)) out.push(prefix);
      return;
    }

    var last = prefix ? prefix.split('.').pop() : '';
    if (last === 'sections') {
      split.groups.forEach(function (group) { out.push(group.prefix); });
      return;
    }

    var fanout = split.groups.length;
    if (!prefix) {
      if (fanout === 1 && !split.exact.length) {
        partition(split.groups[0].prefix, split.groups[0].keys, out);
        return;
      }
      split.groups.forEach(function (group) { emitOrDivide(group, out); });
      return;
    }

    if (keys.length <= MAX_CHAPTER_KEYS) {
      out.push(prefix);
      return;
    }

    if (fanout === 1 && !split.exact.length) {
      partition(split.groups[0].prefix, split.groups[0].keys, out);
      return;
    }

    if (fanout < 2 || fanout > MAX_SPLIT_FANOUT) {
      out.push(prefix);
      return;
    }

    if (split.exact.length) out.push(prefix);
    split.groups.forEach(function (group) { emitOrDivide(group, out); });
  }

  function deriveChapters(keys) {
    var list = [];
    (keys || []).forEach(function (key) {
      var text = reviewKey(key);
      if (text) list.push(text);
    });
    var chapters = [];
    if (list.length) partition('', list, chapters);
    return chapters;
  }

  function orderChapters(chapters) {
    return (chapters || []).slice().sort(function (a, b) {
      var ia = Object.prototype.hasOwnProperty.call(NAV_INDEX, a) ? NAV_INDEX[a] : null;
      var ib = Object.prototype.hasOwnProperty.call(NAV_INDEX, b) ? NAV_INDEX[b] : null;
      if (ia != null && ib != null) return ia - ib;
      if (ia != null) return -1;
      if (ib != null) return 1;
      return String(a).localeCompare(String(b), undefined, { numeric: true });
    });
  }

  function chapterOf(key, chapters) {
    var text = reviewKey(key);
    if (!text) return '';
    var best = '';
    (chapters || []).forEach(function (chapter) {
      if (!chapter) return;
      if (text === chapter || text.indexOf(chapter + '.') === 0) {
        if (chapter.length > best.length) best = chapter;
      }
    });
    return best || text.split('.')[0];
  }

  function splitCamel(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .trim();
  }

  function titleWord(value) {
    if (!value) return '';
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function humanize(prefix) {
    var parts = String(prefix || '').split('.');
    var last = parts[parts.length - 1] || prefix;
    var prev = parts.length > 1 ? parts[parts.length - 2] : '';
    if (prev === 'sections' && /^\d+$/.test(last)) {
      var topic = parts.length > 2 ? parts[parts.length - 3] : 'Section';
      return titleWord(splitCamel(topic)) + ' §' + last;
    }
    return splitCamel(last).split(/\s+/).map(titleWord).join(' ');
  }

  function label(prefix) {
    if (Object.prototype.hasOwnProperty.call(NAV_LABELS, prefix)) return NAV_LABELS[prefix];
    return humanize(prefix);
  }

  function groupOf(key, chapter) {
    var parts = String(key || '').split('.');
    var chapterParts = chapter ? String(chapter).split('.') : [];
    if (chapterParts.length <= 1) {
      if (parts.length < 2) return parts[0] || 'root';
      if (parts[0] === 'player') return parts.slice(0, 3).join('.');
      return parts.slice(0, 2).join('.');
    }
    if (parts.length <= chapterParts.length) return chapter;
    var rel0 = parts[chapterParts.length];
    var rel1 = parts[chapterParts.length + 1];
    if (rel0 === 'questions' && rel1) return chapter + '.questions.' + rel1;
    return chapter + '.' + rel0;
  }

  function groupLabel(group, chapter) {
    var chapterParts = chapter ? String(chapter).split('.') : [];
    if (chapterParts.length <= 1 || !chapter || group === chapter) return group;
    var dot = chapter + '.';
    if (String(group).indexOf(dot) !== 0) return group;
    var rel = String(group).slice(dot.length);
    var question = /^questions\.(\d+)$/.exec(rel);
    if (question) return 'Question ' + question[1];
    return rel;
  }

  return {
    MAX_CHAPTER_KEYS: MAX_CHAPTER_KEYS,
    NAV_ORDER: NAV_ORDER,
    deriveChapters: deriveChapters,
    orderChapters: orderChapters,
    chapterOf: chapterOf,
    label: label,
    groupOf: groupOf,
    groupLabel: groupLabel,
  };
});
