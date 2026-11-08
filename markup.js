/**
 * Split catalog HTML into plain segments + a markup template, then join them back.
 * Mirrors scripts/uaoa_i18n.py (split_html_for_csv / join_html_from_csv) so the
 * review page can hide tags and still save the English styling structure.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UAOAMarkup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SEG_SEP = ' ¦ ';
  var TAG_SPLIT_RE = /(<\/?[a-zA-Z][^>]*\/?>)/;
  var TAG_FULL_RE = /^<\/?[a-zA-Z][^>]*\/?>$/;
  var ALLOWED = {
    P: 1, SPAN: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1,
    BR: 1, UL: 1, OL: 1, LI: 1, DIV: 1,
  };

  function splitHtml(raw) {
    raw = raw == null ? '' : String(raw);
    if (raw.indexOf('<') < 0 || !TAG_SPLIT_RE.test(raw)) {
      return { text: raw, markup: '', segments: [raw] };
    }
    var parts = raw.split(TAG_SPLIT_RE);
    var segments = [];
    var markupBits = [];
    var idx = 0;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '') continue;
      if (TAG_FULL_RE.test(part)) {
        markupBits.push(part);
        continue;
      }
      markupBits.push('{' + idx + '}');
      segments.push(part);
      idx += 1;
    }
    if (!segments.length) {
      return { text: raw, markup: '', segments: [raw] };
    }
    var text = segments.length > 1 ? segments.join(SEG_SEP) : segments[0];
    return { text: text, markup: markupBits.join(''), segments: segments };
  }

  function placeholderCount(markup) {
    var n = 0;
    while (markup.indexOf('{' + n + '}') !== -1) n += 1;
    return n;
  }

  function cleanup(html) {
    var prev = null;
    var out = html;
    while (prev !== out) {
      prev = out;
      out = out.replace(/<(em|strong|b|i|u)>\s*<\/\1>/gi, '');
      out = out.replace(/<span([^>]*)>\s*(<br\s*\/?>)\s*<\/span>/gi, '$2');
      out = out.replace(/<span[^>]*>\s*<\/span>/gi, '');
      out = out.replace(/(?:<br\s*\/?>\s*)+$/gi, '');
    }
    return out;
  }

  function fallbackSegments(text, markup) {
    var n = placeholderCount(markup);
    if (n <= 1) return [text];
    var patterns = [
      /<span\b[^>]*style\s*=\s*"[^"]*color[^"]*"[^>]*>\{(\d+)\}<\/span>/i,
      /<strong>\{(\d+)\}<\/strong>/i,
      /<b>\{(\d+)\}<\/b>/i,
      /<em>\{(\d+)\}<\/em>/i,
      /<i>\{(\d+)\}<\/i>/i,
      /<p\b[^>]*>\{(\d+)\}<\/p>/i,
      /<span\b[^>]*>\{(\d+)\}<\/span>/i,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = patterns[i].exec(markup);
      if (!m) continue;
      var segs = [];
      for (var j = 0; j < n; j++) segs.push('');
      segs[Number(m[1])] = text;
      return segs;
    }
    var rest = [text];
    for (var k = 1; k < n; k++) rest.push('');
    return rest;
  }

  function joinSegments(segments, markup) {
    markup = (markup || '').trim();
    if (!markup) {
      return segments && segments.length ? segments.join('') : '';
    }
    if (markup.indexOf('{0}') < 0) {
      var any = segments && segments.join('');
      return any ? any : markup;
    }
    var out = markup;
    var list = segments || [];
    for (var i = 0; i < list.length; i++) {
      var seg = list[i] == null ? '' : String(list[i]);
      out = out.split('{' + i + '}').join(seg);
    }
    out = out.replace(/\{\d+\}/g, '');
    return cleanup(out);
  }

  function joinHtml(text, markup) {
    markup = (markup || '').trim();
    text = text == null ? '' : String(text);
    if (!markup) return text;
    if (markup.indexOf('{0}') < 0) return text ? text : markup;
    var segments = text.indexOf(SEG_SEP) >= 0 ? text.split(SEG_SEP) : fallbackSegments(text, markup);
    return joinSegments(segments, markup);
  }

  function describeStack(stack) {
    var bits = [];
    stack.forEach(function (frame) {
      var label = '';
      if (frame.tag === 'strong' || frame.tag === 'b') label = 'Bold';
      else if (frame.tag === 'em' || frame.tag === 'i') label = 'Emphasis';
      else if (frame.tag === 'li') label = 'List item';
      else if (frame.tag === 'span' && /color\s*:/i.test(frame.style || '')) label = 'Colored';
      if (label && bits.indexOf(label) < 0) bits.push(label);
    });
    return bits.length ? bits.join(', ') : 'Text';
  }

  function segmentHints(markup) {
    var hints = [];
    if (!markup) return hints;
    var re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>|\{(\d+)\}/g;
    var stack = [];
    var m;
    while ((m = re.exec(markup))) {
      if (m[2] != null) {
        hints[Number(m[2])] = describeStack(stack);
        continue;
      }
      var tok = m[0];
      var tagName = (m[1] || '').toLowerCase();
      if (tok.charAt(1) === '/') {
        // Anchors are never pushed; ignore their closers too.
        if (tagName !== 'a') stack.pop();
        continue;
      }
      if (/\/\s*>$/.test(tok)) continue;
      // Href destinations stay English — skip anchors in segment hints.
      if (tagName === 'a') continue;
      var style = '';
      var styleMatch = /style\s*=\s*"([^"]*)"/i.exec(tok);
      if (styleMatch) style = styleMatch[1];
      stack.push({ tag: tagName, style: style });
    }
    return hints;
  }

  function alignLocaleSegments(enHtml, locHtml) {
    var en = splitHtml(enHtml || '');
    var loc = splitHtml(locHtml || '');
    var hints = segmentHints(en.markup);
    if (!en.markup) {
      return { segments: [locHtml || ''], markup: '', hints: [], collapsed: false };
    }
    if (loc.segments.length === en.segments.length) {
      return {
        segments: loc.segments.slice(),
        markup: en.markup,
        hints: hints,
        collapsed: false,
      };
    }
    var plain = loc.markup ? loc.segments.join('') : (locHtml || '');
    return {
      segments: fallbackSegments(plain, en.markup),
      markup: en.markup,
      hints: hints,
      collapsed: true,
    };
  }

  function plainText(html) {
    var split = splitHtml(html || '');
    if (!split.markup) return split.text;
    return split.segments.join(' ');
  }

  function sanitizeStyle(tag, style) {
    if (!style) return '';
    var out = [];
    style.split(';').forEach(function (part) {
      var bits = part.split(':');
      if (bits.length < 2) return;
      var prop = bits.shift().trim().toLowerCase();
      var val = bits.join(':').trim();
      if (prop === 'color' && /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|var\(--[a-z0-9-]+\))$/i.test(val)) {
        out.push('color: ' + val);
      } else if (prop === 'font-size' && /^[0-9.]+(px|em|rem|%)$/.test(val)) {
        out.push('font-size: ' + val);
      } else if (prop === 'text-align' && /^(left|right|center|justify)$/i.test(val)) {
        out.push('text-align: ' + val.toLowerCase());
      } else if ((tag === 'UL' || tag === 'OL') && prop === 'list-style' && /^(disc|circle|square|decimal)$/i.test(val)) {
        out.push('list-style: ' + val.toLowerCase());
      }
    });
    return out.join('; ');
  }

  function appendSafe(dest, node) {
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) {
        dest.appendChild(document.createTextNode(child.nodeValue));
        return;
      }
      if (child.nodeType !== 1) return;
      var tag = child.tagName;
      // Never render hyperlinks — keep the linked words, drop the href UI.
      // English markup still re-wraps those words in <a> on save.
      if (!ALLOWED[tag] || tag === 'A') {
        appendSafe(dest, child);
        return;
      }
      var el = document.createElement(tag.toLowerCase());
      var style = sanitizeStyle(tag, child.getAttribute('style') || '');
      if (style) el.setAttribute('style', style);
      if (tag !== 'BR') appendSafe(el, child);
      dest.appendChild(el);
    });
  }

  function mountPreview(el, html) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    var raw = html == null ? '' : String(html);
    if (!raw) {
      el.textContent = '—';
      return;
    }
    var split = splitHtml(raw);
    if (!split.markup) {
      el.textContent = raw;
      return;
    }
    if (typeof DOMParser === 'undefined') {
      el.textContent = plainText(raw);
      return;
    }
    var doc = new DOMParser().parseFromString('<div id="uaoa-root">' + raw + '</div>', 'text/html');
    var rootNode = doc.getElementById('uaoa-root');
    if (!rootNode) {
      el.textContent = plainText(raw);
      return;
    }
    appendSafe(el, rootNode);
  }

  function readEditor(node) {
    if (!node) return '';
    if (node._markup) {
      var areas = node.querySelectorAll('textarea');
      var segs = [];
      for (var i = 0; i < areas.length; i++) segs.push(areas[i].value);
      return joinSegments(segs, node._markup);
    }
    return node.value == null ? '' : node.value;
  }

  return {
    SEG_SEP: SEG_SEP,
    splitHtml: splitHtml,
    joinHtml: joinHtml,
    joinSegments: joinSegments,
    segmentHints: segmentHints,
    alignLocaleSegments: alignLocaleSegments,
    plainText: plainText,
    mountPreview: mountPreview,
    readEditor: readEditor,
  };
});
