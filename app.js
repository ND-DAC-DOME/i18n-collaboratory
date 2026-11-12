(function () {
  'use strict';

  var CFG = window.UAOA_I18N_REVIEW || {};
  var Hub = window.I18nHub;
  // Preferred order for known UAOA elearning prefixes; other top-level key
  // segments (e.g. ORP ui / content) are appended alphabetically from the catalog.
  var MODULE_ORDER = ['common', 'course', 'welcome', 'survey', 'm1', 'm2', 'm3', 'm4', 'm5', 'summary', 'embeds', 'player'];
  var MODULE_LABELS = {
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
    ui: 'UI chrome',
    content: 'Page & assessment copy',
  };

  var state = {
    user: null,
    hubAdmin: false,
    projects: [],
    project: null,
    membership: null,
    locales: [],
    locale: '',
    module: 'common',
    sourceRows: [],
    translations: {},
    canEdit: false,
    isAdmin: false,
    focuses: {},
    focusHeartbeatTimer: null,
    editingKey: null,
    editingDraft: null,
    editingDraftKey: null,
    pendingKey: null,
    pendingAction: null,
    filter: '',
    rowsCache: [],
    approveQueue: {},
    approveHeld: [],
    approveErrors: {},
    approveFlushTimer: null,
    approveFlushing: false,
    approveFlushPromise: null,
    realtimeChannel: null,
    localWriteUntil: {},
  };

  var el = {
    projectSelect: document.getElementById('projectSelect'),
    projectLabel: document.getElementById('projectLabel'),
    localeSelect: document.getElementById('localeSelect'),
    localeLabel: document.getElementById('localeLabel'),
    reviewerPill: document.getElementById('reviewerPill'),
    adminBtn: document.getElementById('adminBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    signOutBtn: document.getElementById('signOutBtn'),
    modList: document.getElementById('modList'),
    rows: document.getElementById('rows'),
    stats: document.getElementById('stats'),
    search: document.getElementById('search'),
    banner: document.getElementById('statusBanner'),
    wakeBanner: document.getElementById('wakeBanner'),
    wakeTitle: document.getElementById('wakeBannerTitle'),
    wakeBody: document.getElementById('wakeBannerBody'),
    authScreen: document.getElementById('authScreen'),
    emptyHub: document.getElementById('emptyHub'),
    hubAdminHint: document.getElementById('hubAdminHint'),
    appLayout: document.getElementById('appLayout'),
    githubSignIn: document.getElementById('githubSignIn'),
    magicSignIn: document.getElementById('magicSignIn'),
    magicEmail: document.getElementById('magicEmail'),
    authNote: document.getElementById('authNote'),
    adminModal: document.getElementById('adminModal'),
    adminBody: document.getElementById('adminBody'),
    adminClose: document.getElementById('adminClose'),
    toast: document.getElementById('toast'),
  };

  function toast(msg, kind) {
    el.toast.textContent = msg;
    el.toast.className = 'toast show' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.toast.classList.remove('show');
    }, 2800);
  }

  function showWake(failed, detail) {
    if (!el.wakeBanner) return;
    el.wakeBanner.hidden = false;
    el.wakeBanner.classList.toggle('is-failed', !!failed);
    if (el.wakeTitle) {
      el.wakeTitle.textContent = failed ? 'Database unavailable' : 'Database is starting';
    }
    if (el.wakeBody) {
      el.wakeBody.textContent = detail ||
        'Please wait a moment and retry. A daily keep-alive workflow resumes a paused free project.';
    }
  }

  function hideWake() {
    if (!el.wakeBanner) return;
    el.wakeBanner.hidden = true;
    el.wakeBanner.classList.remove('is-failed');
  }

  function displayName(user) {
    if (!user) return '';
    var meta = user.user_metadata || {};
    return meta.full_name || meta.name || meta.user_name || user.email || user.id.slice(0, 8);
  }

  function setPending(key, action) {
    state.pendingKey = key || null;
    state.pendingAction = action || null;
  }

  function clearPending() {
    state.pendingKey = null;
    state.pendingAction = null;
  }

  function btnLabel(text, busy) {
    if (!busy) return text;
    return '<span class="btn-spinner" aria-hidden="true"></span><span>' + text + '</span>';
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isUrlOnlyString(key, text) {
    var k = String(key || '');
    if (/\.(url|href|image)$/i.test(k)) return true;
    var plain = window.UAOAMarkup
      ? window.UAOAMarkup.plainText(text || '').trim()
      : String(text || '').replace(/<[^>]+>/g, '').trim();
    return /^https?:\/\/\S+$/i.test(plain);
  }

  function moduleOf(key) {
    return key.split('.')[0] || 'other';
  }

  function widgetOf(key) {
    var parts = key.split('.');
    if (parts.length < 2) return parts[0] || 'root';
    if (parts[0] === 'player') return parts.slice(0, 3).join('.');
    return parts.slice(0, 2).join('.');
  }

  function approvalEntry(key) {
    return state.translations[key] || null;
  }

  function isApproved(key) {
    var a = approvalEntry(key);
    return !!(a && a.approved && !a.stale);
  }

  function isStale(key) {
    var a = approvalEntry(key);
    return !!(a && a.stale && !a.approved);
  }

  function formatStampAt(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch (e) {
      return String(iso);
    }
  }

  function rebuildRowsCache() {
    state.rowsCache = state.sourceRows
      .filter(function (r) { return !isUrlOnlyString(r.key, r.text); })
      .map(function (r) {
        return { key: r.key, text: r.text, note: r.note || '', previous_text: r.previous_text || null };
      });
  }

  function projectFromUrl() {
    return new URLSearchParams(location.search).get('project') || '';
  }

  function localeFromUrl() {
    return (new URLSearchParams(location.search).get('locale') || '').toLowerCase();
  }

  function setUrlParams(projectSlug, locale) {
    var u = new URL(location.href);
    if (projectSlug) u.searchParams.set('project', projectSlug);
    else u.searchParams.delete('project');
    if (locale) u.searchParams.set('locale', locale);
    else u.searchParams.delete('locale');
    history.replaceState(null, '', u.toString());
  }

  var FOCUS_STALE_MS = 45000;

  function refreshCanEdit() {
    state.canEdit = !!(
      state.user &&
      state.project &&
      state.locale &&
      allowedLocales().some(function (l) { return l.locale === state.locale; })
    );
  }

  function focusForKey(key) {
    var f = state.focuses[key];
    if (!f) return null;
    if (new Date(f.updated_at).getTime() <= Date.now() - FOCUS_STALE_MS) return null;
    return f;
  }

  function focusHeldByOther(key) {
    var f = focusForKey(key);
    return !!(f && state.user && f.user_id !== state.user.id);
  }

  function setFocusMap(rows) {
    var map = {};
    (rows || []).forEach(function (row) {
      if (row && row.key) map[row.key] = row;
    });
    state.focuses = map;
  }

  function stopFocusHeartbeat() {
    if (state.focusHeartbeatTimer) {
      clearInterval(state.focusHeartbeatTimer);
      state.focusHeartbeatTimer = null;
    }
  }

  function startFocusHeartbeat(key) {
    stopFocusHeartbeat();
    state.focusHeartbeatTimer = setInterval(function () {
      if (!state.project || !state.locale || state.editingKey !== key) {
        stopFocusHeartbeat();
        return;
      }
      Hub.heartbeatFocus(state.project.id, state.locale, key)
        .then(function (row) {
          if (row) state.focuses[key] = row;
        })
        .catch(function () { /* ignore */ });
    }, 15000);
  }

  function beginEdit(key) {
    if (state.pendingKey) return;
    Hub.claimFocus(state.project.id, state.locale, key, displayName(state.user))
      .then(function (row) {
        if (!row || (state.user && row.user_id !== state.user.id)) {
          if (row) state.focuses[key] = row;
          toast(
            'Being edited by ' + ((row && row.display_name) || 'someone else'),
            'error',
          );
          renderRows();
          return;
        }
        state.focuses[key] = row;
        state.editingKey = key;
        state.editingDraft = null;
        state.editingDraftKey = null;
        startFocusHeartbeat(key);
        renderRows();
      })
      .catch(function (e) {
        toast(e.message || 'Could not start edit', 'error');
      });
  }

  function endEdit(opts) {
    opts = opts || {};
    var key = state.editingKey;
    stopFocusHeartbeat();
    state.editingKey = null;
    state.editingDraft = null;
    state.editingDraftKey = null;
    if (!key || !state.project || !state.locale || opts.skipRelease) {
      if (opts.rerender !== false) renderRows();
      return Promise.resolve();
    }
    return Hub.releaseFocus(state.project.id, state.locale, key)
      .then(function () {
        delete state.focuses[key];
      })
      .catch(function () { /* ignore */ })
      .then(function () {
        if (opts.rerender !== false) renderRows();
      });
  }

  function updateChrome() {
    el.reviewerPill.textContent = state.user
      ? ('Signed in: ' + displayName(state.user))
      : 'Signed out';
    el.signOutBtn.hidden = !state.user;

    el.adminBtn.hidden = !(state.isAdmin || state.hubAdmin);
    el.downloadBtn.hidden = !(state.isAdmin || state.hubAdmin) || !state.project;

    if (!state.project || !state.locale) {
      el.banner.hidden = true;
      return;
    }

    if (!state.canEdit) {
      el.banner.hidden = false;
      el.banner.className = 'banner';
      el.banner.textContent = 'View only — this locale is not assigned to you.';
    } else {
      el.banner.hidden = false;
      el.banner.className = 'banner ok';
      el.banner.textContent = 'Reviewing ' + state.locale.toUpperCase() +
        '. Approve stamps a line; Edit to change the translation (Save clears approval). Others may review the same locale.';
    }
  }

  function moduleStats(allRows) {
    var by = {};
    allRows.forEach(function (r) {
      var m = moduleOf(r.key);
      if (!by[m]) by[m] = { total: 0, approved: 0 };
      by[m].total += 1;
      if (isApproved(r.key)) by[m].approved += 1;
    });
    return by;
  }

  /** Modules that actually have strings, preferred order first then extras A–Z. */
  function modulesPresent(allRows) {
    var stats = moduleStats(allRows);
    var seen = {};
    var list = [];
    MODULE_ORDER.forEach(function (m) {
      if (stats[m] && stats[m].total && !seen[m]) {
        seen[m] = true;
        list.push(m);
      }
    });
    Object.keys(stats).sort().forEach(function (m) {
      if (stats[m].total && !seen[m]) {
        seen[m] = true;
        list.push(m);
      }
    });
    return list;
  }

  function pickDefaultModule(allRows) {
    var present = modulesPresent(allRows);
    if (present.indexOf(state.module) !== -1) return state.module;
    return present[0] || 'common';
  }

  function renderModules(allRows) {
    var stats = moduleStats(allRows);
    el.modList.innerHTML = '';
    modulesPresent(allRows).forEach(function (m) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mod-btn' + (state.module === m ? ' active' : '');
      btn.innerHTML = '<span>' + (MODULE_LABELS[m] || m) + '</span>' +
        '<span class="meta">' + stats[m].approved + ' / ' + stats[m].total + ' approved</span>';
      btn.addEventListener('click', function () {
        state.module = m;
        endEdit({ rerender: false }).then(function () {
          renderModules(allRows);
          renderRows();
        });
      });
      el.modList.appendChild(btn);
    });
  }

  function filteredRows() {
    var q = (state.filter || '').trim().toLowerCase();
    return state.rowsCache.filter(function (r) {
      if (moduleOf(r.key) !== state.module) return false;
      if (!q) return true;
      var tr = (state.translations[r.key] && state.translations[r.key].text) || '';
      var enPlain = window.UAOAMarkup ? window.UAOAMarkup.plainText(r.text) : r.text;
      var trPlain = window.UAOAMarkup ? window.UAOAMarkup.plainText(tr) : tr;
      return (r.key + ' ' + enPlain + ' ' + trPlain + ' ' + r.note).toLowerCase().indexOf(q) !== -1;
    });
  }

  function snapshotEditDraft() {
    if (!state.editingKey) return;
    var box = document.getElementById('edit-' + state.editingKey);
    if (!box) return;
    if (window.UAOAMarkup && typeof box._markup === 'string') {
      state.editingDraft = window.UAOAMarkup.readEditor(box);
    } else if ('value' in box) {
      state.editingDraft = box.value;
    }
    state.editingDraftKey = state.editingKey;
  }

  function makeStamp(entry, opts) {
    opts = opts || {};
    var stamp = document.createElement('div');
    stamp.className = 'approval-stamp';
    stamp.setAttribute('role', 'status');
    var mark = document.createElement('div');
    mark.className = 'approval-stamp-mark';
    mark.textContent = 'Approved';
    stamp.appendChild(mark);
    var meta = document.createElement('div');
    meta.className = 'approval-stamp-meta';
    var by = entry && entry.approved_by_name
      ? entry.approved_by_name
      : (entry && entry.approved_at && !entry.approved_by ? 'initial import'
        : (entry && entry.approved_by ? 'reviewer' : '—'));
    var at = formatStampAt(entry && entry.approved_at);
    meta.innerHTML =
      '<span class="approval-stamp-by">by ' + escapeHtml(by) + '</span>' +
      (at ? '<span class="approval-stamp-at">' + escapeHtml(at) + '</span>' : '');
    stamp.appendChild(meta);
    if (opts.canUnapprove && opts.onUnapprove) {
      var un = document.createElement('button');
      un.type = 'button';
      un.className = 'btn-stamp-unapprove' + (opts.pending ? ' is-busy' : '');
      un.innerHTML = btnLabel(opts.pending ? '…' : 'Unapprove', !!opts.pending);
      un.disabled = !!opts.pending || !!opts.disabled;
      un.addEventListener('click', function () {
        if (state.pendingKey) return;
        opts.onUnapprove();
      });
      stamp.appendChild(un);
    }
    return stamp;
  }

  function buildSegmentEditor(enText, locText, disabled) {
    var aligned = window.UAOAMarkup
      ? window.UAOAMarkup.alignLocaleSegments(enText, locText)
      : { segments: [locText || ''], markup: '', hints: [], collapsed: false };
    if (!aligned.markup || (state.project && !state.project.rich_text)) {
      var plain = document.createElement('textarea');
      plain.className = 'tr-box editable' + (disabled ? ' is-busy' : '');
      plain.value = locText || '';
      if (disabled) plain.disabled = true;
      return plain;
    }
    var box = document.createElement('div');
    box.className = 'tr-box editable segment-editor' + (disabled ? ' is-busy' : '');
    box._markup = aligned.markup;
    var note = document.createElement('p');
    note.className = 'seg-note';
    note.textContent = aligned.collapsed
      ? 'This translation is not split like the English. The full text is in one field. Saving reapplies the English styling.'
      : 'Edit the words only. Saving reapplies the English styling.';
    box.appendChild(note);
    aligned.segments.forEach(function (seg, i) {
      var label = document.createElement('label');
      label.className = 'seg-field';
      var hint = document.createElement('span');
      hint.className = 'seg-hint';
      hint.textContent = aligned.hints[i] || 'Text';
      var area = document.createElement('textarea');
      area.value = seg;
      area.rows = Math.min(8, Math.max(2, Math.ceil(String(seg || '').length / 72)));
      if (disabled) area.disabled = true;
      label.appendChild(hint);
      label.appendChild(area);
      box.appendChild(label);
    });
    return box;
  }

  function renderRow(r) {
    var approved = isApproved(r.key);
    var stale = isStale(r.key);
    var editing = state.editingKey === r.key;
    var pending = state.pendingKey === r.key;
    var pendingSave = pending && state.pendingAction === 'save';
    var pendingUnlock = pending && state.pendingAction === 'unapprove';
    var saveError = state.approveErrors[r.key] || '';
    var trEntry = state.translations[r.key];
    var trText = (trEntry && trEntry.text) || '';
    if (editing && state.editingDraft != null && state.editingDraftKey === r.key) {
      trText = state.editingDraft;
    }

    var foreignFocus = focusHeldByOther(r.key);
    var focusInfo = focusForKey(r.key);
    var row = document.createElement('article');
    row.className = 'row' +
      (pending ? ' is-pending' : '') +
      (stale ? ' is-stale' : '') +
      (foreignFocus ? ' is-focused-other' : '') +
      (saveError && !approved ? ' is-save-failed' : '');
    row.dataset.key = r.key;

    var keyEl = document.createElement('div');
    keyEl.className = 'key';
    keyEl.textContent = r.key;
    row.appendChild(keyEl);

    if (r.note) {
      var note = document.createElement('p');
      note.className = 'note';
      note.textContent = r.note;
      row.appendChild(note);
    }

    if (stale && r.previous_text != null) {
      var diff = document.createElement('div');
      diff.className = 'en-diff';
      diff.innerHTML =
        '<div class="panel-label">English changed</div>' +
        '<div class="en-diff-old"><span class="diff-label">Was</span></div>' +
        '<div class="en-diff-new"><span class="diff-label">Now</span></div>';
      var oldBox = document.createElement('div');
      oldBox.className = 'en-box muted';
      if (window.UAOAMarkup) window.UAOAMarkup.mountPreview(oldBox, r.previous_text);
      else oldBox.textContent = r.previous_text;
      var newBox = document.createElement('div');
      newBox.className = 'en-box';
      if (window.UAOAMarkup) window.UAOAMarkup.mountPreview(newBox, r.text);
      else newBox.textContent = r.text;
      diff.querySelector('.en-diff-old').appendChild(oldBox);
      diff.querySelector('.en-diff-new').appendChild(newBox);
      var hint = document.createElement('p');
      hint.className = 'note';
      hint.textContent = 'Only the changed English must be re-approved. The translation below is unchanged until you edit it.';
      diff.appendChild(hint);
      row.appendChild(diff);
    } else {
      var left = document.createElement('div');
      left.innerHTML = '<div class="panel-label">English</div>';
      var enBox = document.createElement('div');
      enBox.className = 'en-box';
      if (window.UAOAMarkup) window.UAOAMarkup.mountPreview(enBox, r.text);
      else enBox.textContent = r.text;
      left.appendChild(enBox);
      row.appendChild(left);
    }

    var right = document.createElement('div');
    right.innerHTML = '<div class="panel-label">Translation (' + state.locale + ')</div>';
    var trBox;
    if (editing) {
      trBox = buildSegmentEditor(r.text, trText, pendingSave);
      trBox.id = 'edit-' + r.key;
    } else {
      trBox = document.createElement('div');
      trBox.className = 'tr-box' + (approved ? ' locked' : '');
      if (window.UAOAMarkup) window.UAOAMarkup.mountPreview(trBox, trText);
      else trBox.textContent = trText || '—';
    }
    right.appendChild(trBox);
    row.appendChild(right);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var entry = approvalEntry(r.key);

    if (foreignFocus) {
      var focusPill = document.createElement('span');
      focusPill.className = 'pill busy';
      focusPill.textContent = 'Editing: ' + (focusInfo.display_name || 'someone');
      actions.appendChild(focusPill);
      if (approved) {
        actions.appendChild(makeStamp(entry, { canUnapprove: false }));
      }
    } else if (!state.canEdit) {
      if (approved) {
        actions.appendChild(makeStamp(entry, { canUnapprove: false }));
      } else if (stale) {
        var staleRo = document.createElement('span');
        staleRo.className = 'pill busy';
        staleRo.textContent = 'Source updated — re-approve';
        actions.appendChild(staleRo);
      } else {
        var ro = document.createElement('span');
        ro.className = 'pill ro';
        ro.textContent = 'Read-only';
        actions.appendChild(ro);
      }
    } else if (editing) {
      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-save' + (pendingSave ? ' is-busy' : '');
      save.innerHTML = btnLabel(pendingSave ? 'Saving…' : 'Save', pendingSave);
      save.disabled = pendingSave;
      save.addEventListener('click', function () {
        if (state.pendingKey) return;
        var next = window.UAOAMarkup && typeof trBox._markup === 'string'
          ? window.UAOAMarkup.readEditor(trBox)
          : trBox.value;
        saveEdit(r.key, next);
      });
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-cancel';
      cancel.textContent = 'Cancel';
      cancel.disabled = pendingSave;
      cancel.addEventListener('click', function () {
        if (state.pendingKey) return;
        endEdit();
      });
      actions.appendChild(save);
      actions.appendChild(cancel);
    } else if (approved) {
      actions.appendChild(makeStamp(entry, {
        canUnapprove: true,
        pending: pendingUnlock,
        disabled: pendingUnlock,
        onUnapprove: function () { unapprove(r.key); },
      }));
      actions.appendChild(makeEditButton(r.key, pendingUnlock));
    } else {
      if (stale) {
        var stalePill = document.createElement('span');
        stalePill.className = 'pill busy';
        stalePill.textContent = 'Source updated — re-approve';
        actions.appendChild(stalePill);
      }
      actions.appendChild(makeApproveButton(r.key, stale));
      actions.appendChild(makeEditButton(r.key, false));
    }

    row.appendChild(actions);
    if (saveError && state.canEdit && !editing && !approved) {
      var errEl = document.createElement('p');
      errEl.className = 'row-save-error';
      errEl.setAttribute('role', 'alert');
      errEl.textContent = 'Did not save (' + saveError + '). Press Approve to retry.';
      row.appendChild(errEl);
    }
    return row;
  }

  function makeEditButton(key, disabled) {
    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-edit';
    edit.textContent = 'Edit';
    edit.disabled = !!disabled || focusHeldByOther(key);
    edit.addEventListener('click', function () {
      if (state.pendingKey || focusHeldByOther(key)) return;
      if (state.editingKey && state.editingKey !== key) {
        endEdit({ rerender: false }).then(function () { beginEdit(key); });
        return;
      }
      beginEdit(key);
    });
    return edit;
  }

  function makeApproveButton(key, stale) {
    var approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'btn btn-approve';
    approve.textContent = stale ? 'Re-approve' : 'Approve';
    approve.disabled = focusHeldByOther(key);
    approve.addEventListener('click', function () {
      if (focusHeldByOther(key)) return;
      approveKey(key);
    });
    return approve;
  }

  function renderRows() {
    snapshotEditDraft();
    var rows = filteredRows();
    var approved = rows.filter(function (r) { return isApproved(r.key); }).length;
    var stale = rows.filter(function (r) { return isStale(r.key); }).length;
    el.stats.textContent = (MODULE_LABELS[state.module] || state.module) +
      ' · ' + rows.length + ' strings · ' + approved + ' approved' +
      (stale ? ' · ' + stale + ' stale' : '');

    if (!rows.length) {
      el.rows.innerHTML = '<div class="empty">No strings in this module' +
        (state.filter ? ' match your filter' : '') + '.</div>';
      return;
    }

    var groups = {};
    var order = [];
    rows.forEach(function (r) {
      var w = widgetOf(r.key);
      if (!groups[w]) { groups[w] = []; order.push(w); }
      groups[w].push(r);
    });

    el.rows.innerHTML = '';
    order.forEach(function (w) {
      var block = document.createElement('section');
      block.className = 'widget-block';
      var head = document.createElement('header');
      head.textContent = w;
      block.appendChild(head);
      groups[w].forEach(function (r) {
        block.appendChild(renderRow(r));
      });
      el.rows.appendChild(block);
    });
  }

  var APPROVE_FLUSH_MS = 2500;

  function scheduleApproveFlush() {
    clearTimeout(state.approveFlushTimer);
    state.approveFlushTimer = setTimeout(function () {
      flushApprovals();
    }, APPROVE_FLUSH_MS);
  }

  function approveKey(key) {
    if (!state.canEdit || !state.locale || !key) return;
    if (state.pendingKey === key) return;
    delete state.approveErrors[key];
    var prev = state.translations[key] ? Object.assign({}, state.translations[key]) : null;
    var entry = Object.assign({}, state.translations[key] || { key: key, text: '' }, {
      approved: true,
      stale: false,
      approved_at: new Date().toISOString(),
      approved_by: state.user && state.user.id,
      approved_by_name: displayName(state.user),
      _local: true,
    });
    state.translations[key] = entry;
    state.approveQueue[key] = { key: key, prev: prev };
    scheduleApproveFlush();
    renderModules(state.rowsCache);
    renderRows();
  }

  function flushApprovals() {
    if (state.approveFlushing) return state.approveFlushPromise;
    var keys = Object.keys(state.approveQueue);
    if (!keys.length) return Promise.resolve();
    var payload = {
      keys: keys,
      prevByKey: {},
    };
    keys.forEach(function (k) {
      payload.prevByKey[k] = state.approveQueue[k].prev;
      delete state.approveQueue[k];
    });
    state.approveHeld.push(payload);
    state.approveFlushing = true;
    payload.keys.forEach(markLocalWrite);
    state.approveFlushPromise = Hub.approveKeys(
      state.project.id,
      state.locale,
      payload.keys,
      displayName(state.user),
    )
      .then(function (rows) {
        (rows || []).forEach(function (row) {
          state.translations[row.key] = row;
          delete state.approveErrors[row.key];
          markLocalWrite(row.key);
        });
        state.approveHeld = state.approveHeld.filter(function (p) { return p !== payload; });
        renderModules(state.rowsCache);
        renderRows();
      })
      .catch(function (e) {
        payload.keys.forEach(function (key) {
          state.approveErrors[key] = e.message || 'approve failed';
          if (payload.prevByKey[key]) state.translations[key] = payload.prevByKey[key];
          else delete state.translations[key];
        });
        state.approveHeld = state.approveHeld.filter(function (p) { return p !== payload; });
        toast(e.message || 'Approve failed', 'error');
        renderModules(state.rowsCache);
        renderRows();
      })
      .finally(function () {
        state.approveFlushing = false;
        state.approveFlushPromise = null;
        if (Object.keys(state.approveQueue).length) flushApprovals();
      });
    return state.approveFlushPromise;
  }

  function settleApproveQueue() {
    clearTimeout(state.approveFlushTimer);
    return flushApprovals().then(function step() {
      if (state.approveFlushing || state.approveHeld.length || Object.keys(state.approveQueue).length) {
        return (state.approveFlushPromise || Promise.resolve()).then(step);
      }
    });
  }

  function unapprove(key) {
    if (state.pendingKey) return;
    delete state.approveQueue[key];
    delete state.approveErrors[key];
    setPending(key, 'unapprove');
    renderRows();
    settleApproveQueue().then(function () {
      markLocalWrite(key);
      return Hub.unapproveKey(state.project.id, state.locale, key);
    }).then(function () {
      markLocalWrite(key);
      if (state.translations[key]) {
        state.translations[key] = Object.assign({}, state.translations[key], {
          approved: false,
          stale: false,
          approved_by: null,
          approved_by_name: null,
          approved_at: null,
          en_fp: null,
        });
      }
      clearPending();
      toast('Unapproved', 'ok');
      renderModules(state.rowsCache);
      renderRows();
    }).catch(function (e) {
      clearPending();
      toast(e.message || 'Unapprove failed', 'error');
      renderRows();
    });
  }

  function saveEdit(key, text) {
    if (state.pendingKey) return;
    delete state.approveQueue[key];
    delete state.approveErrors[key];
    setPending(key, 'save');
    renderRows();
    settleApproveQueue().then(function () {
      markLocalWrite(key);
      return Hub.saveTranslation(state.project.id, state.locale, key, text);
    }).then(function (row) {
      state.translations[key] = row;
      markLocalWrite(key);
      clearPending();
      return endEdit({ skipRelease: false, rerender: false }).then(function () {
        toast('Saved — re-approve when ready', 'ok');
        renderModules(state.rowsCache);
        renderRows();
      });
    }).catch(function (e) {
      clearPending();
      toast(e.message || 'Save failed', 'error');
      renderRows();
    });
  }

  function allowedLocales() {
    if (state.isAdmin || state.hubAdmin) return state.locales;
    var langs = (state.membership && state.membership.member_languages) || [];
    var codes = langs.map(function (l) { return l.locale; });
    return state.locales.filter(function (l) { return codes.indexOf(l.locale) !== -1; });
  }

  function fillLocaleSelect() {
    var allowed = allowedLocales();
    el.localeSelect.innerHTML = '';
    allowed.forEach(function (loc) {
      var opt = document.createElement('option');
      opt.value = loc.locale;
      opt.textContent = (loc.label || loc.locale) + ' (' + loc.locale + ')';
      el.localeSelect.appendChild(opt);
    });
    el.localeLabel.hidden = !allowed.length;
  }

  function fillProjectSelect() {
    el.projectSelect.innerHTML = '';
    state.projects.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.slug;
      opt.textContent = p.name;
      el.projectSelect.appendChild(opt);
    });
    el.projectLabel.hidden = !state.projects.length;
  }

  function markLocalWrite(key) {
    state.localWriteUntil[key] = Date.now() + 2500;
  }

  function isLocalWrite(key) {
    var until = state.localWriteUntil[key];
    if (!until) return false;
    if (Date.now() > until) {
      delete state.localWriteUntil[key];
      return false;
    }
    return true;
  }

  function stopRealtime() {
    if (!state.realtimeChannel) return Promise.resolve();
    var ch = state.realtimeChannel;
    state.realtimeChannel = null;
    return Hub.removeChannel(ch).catch(function () { /* ignore */ });
  }

  function startRealtime(projectId, locale) {
    return stopRealtime().then(function () {
      state.realtimeChannel = Hub.subscribeLocale(projectId, locale, {
        onTranslation: function (payload) {
          var row = payload.new;
          var old = payload.old;
          var key = (row && row.key) || (old && old.key);
          if (!key || state.locale !== locale) return;
          if (isLocalWrite(key)) return;
          if (payload.eventType === 'DELETE') {
            delete state.translations[key];
          } else if (row) {
            state.translations[key] = row;
          }
          renderModules(state.rowsCache);
          renderRows();
        },
        onFocus: function (payload) {
          var row = payload.new;
          var old = payload.old;
          var key = (row && row.key) || (old && old.key);
          if (!key || state.locale !== locale) return;
          if (payload.eventType === 'DELETE') {
            delete state.focuses[key];
          } else if (row) {
            state.focuses[key] = row;
          }
          renderRows();
        },
      });
    });
  }

  function loadLocale(code) {
    if (!state.project || !code) return Promise.resolve();
    return endEdit({ skipRelease: false, rerender: false }).then(function () {
      state.locale = code;
      state.approveErrors = {};
      setUrlParams(state.project.slug, code);
      el.localeSelect.value = code;

      return Promise.all([
        Hub.loadTranslations(state.project.id, code),
        Hub.loadFocuses(state.project.id, code),
      ]).then(function (parts) {
        var map = {};
        (parts[0] || []).forEach(function (row) { map[row.key] = row; });
        state.translations = map;
        setFocusMap(parts[1]);
        refreshCanEdit();
        hideWake();
        updateChrome();
        renderModules(state.rowsCache);
        renderRows();
        return startRealtime(state.project.id, code);
      });
    });
  }

  function loadProject(slug) {
    var project = state.projects.find(function (p) { return p.slug === slug; }) || state.projects[0];
    if (!project) {
      el.appLayout.hidden = true;
      el.emptyHub.hidden = false;
      el.hubAdminHint.hidden = !state.hubAdmin;
      return Promise.resolve();
    }
    el.emptyHub.hidden = true;
    el.appLayout.hidden = false;
    state.project = project;
    el.projectSelect.value = project.slug;

    return Promise.all([
      Hub.getMembership(project.id),
      Hub.listLocales(project.id),
      Hub.loadSourceStrings(project.id),
    ]).then(function (parts) {
      state.membership = parts[0];
      state.isAdmin = !!(state.hubAdmin || (parts[0] && parts[0].role === 'admin'));
      state.locales = parts[1] || [];
      state.sourceRows = parts[2] || [];
      rebuildRowsCache();
      fillLocaleSelect();

      var allowed = allowedLocales();
      var wanted = localeFromUrl() || (allowed[0] && allowed[0].locale) || '';
      if (wanted && !allowed.some(function (l) { return l.locale === wanted; })) {
        wanted = allowed[0] && allowed[0].locale;
      }
      state.module = pickDefaultModule(state.rowsCache);
      if (!wanted) {
        state.locale = '';
        updateChrome();
        el.rows.innerHTML = '<div class="empty">No review locales assigned to you for this project.</div>';
        return;
      }
      return loadLocale(wanted);
    });
  }

  function showSignedOut() {
    endEdit({ skipRelease: true, rerender: false });
    stopRealtime();
    state.user = null;
    state.projects = [];
    state.project = null;
    state.focuses = {};
    el.authScreen.hidden = false;
    el.emptyHub.hidden = true;
    el.appLayout.hidden = true;
    el.projectLabel.hidden = true;
    el.localeLabel.hidden = true;
    updateChrome();
  }

  function showSignedIn(user) {
    state.user = user;
    el.authScreen.hidden = true;
    el.signOutBtn.hidden = false;
    updateChrome();

    return Hub.probeHealth()
      .then(function () {
        hideWake();
        return Hub.acceptInvites();
      })
      .then(function () {
        return Promise.all([Hub.listMyProjects(), Hub.isHubAdmin()]);
      })
      .then(function (parts) {
        state.projects = parts[0] || [];
        state.hubAdmin = !!parts[1];
        fillProjectSelect();
        if (!state.projects.length) {
          el.appLayout.hidden = true;
          el.emptyHub.hidden = false;
          el.hubAdminHint.hidden = !state.hubAdmin;
          updateChrome();
          return;
        }
        var slug = projectFromUrl() || state.projects[0].slug;
        return loadProject(slug);
      })
      .catch(function (e) {
        showWake(true, e.message || 'Could not reach Supabase. Retry shortly.');
        toast(e.message || 'API unavailable', 'error');
      });
  }

  function unapprovedCounts() {
    var counts = {};
    state.locales.forEach(function (l) { counts[l.locale] = null; });
    return counts;
  }

  async function downloadZip() {
    if (!state.project || !window.JSZip) {
      toast('JSZip is not loaded', 'error');
      return;
    }
    toast('Building zip…');
    try {
      var sources = state.sourceRows;
      var sourceFlat = {};
      sources.forEach(function (s) {
        sourceFlat[s.key] = { text: s.text, note: s.note || '' };
      });
      var mode = state.project.rich_text ? 'rich' : 'plain';
      var zip = new JSZip();
      var folder = zip.folder('locales');
      folder.file(
        state.project.source_locale + '.json',
        JSON.stringify(Hub.nestFlat(sourceFlat, mode), null, 2) + '\n'
      );

      var unapproved = {};
      var localeList = state.locales.slice();
      for (var i = 0; i < localeList.length; i++) {
        var code = localeList[i].locale;
        var rows = await Hub.loadTranslations(state.project.id, code);
        var flat = {};
        var open = 0;
        rows.forEach(function (r) {
          flat[r.key] = { text: r.text, note: r.note || '' };
          if (!r.approved || r.stale) open += 1;
        });
        Object.keys(sourceFlat).forEach(function (k) {
          if (!flat[k]) {
            flat[k] = { text: '', note: '' };
            open += 1;
          }
        });
        unapproved[code] = open;
        folder.file(code + '.json', JSON.stringify(Hub.nestFlat(flat, mode), null, 2) + '\n');
        if (mode === 'plain') {
          var notes = {};
          Object.keys(flat).forEach(function (k) {
            if (flat[k].note) notes[k] = { text: flat[k].note, note: '' };
          });
          folder.file(code + '.notes.json', JSON.stringify(Hub.nestFlat(notes, 'plain'), null, 2) + '\n');
        }
      }

      var openSummary = Object.keys(unapproved)
        .map(function (c) { return c + ': ' + unapproved[c] + ' unapproved'; })
        .join(', ');
      if (!window.confirm('Download locales zip?\n\n' + (openSummary || 'All approved'))) {
        return;
      }

      folder.file('manifest.json', JSON.stringify({
        project: state.project.slug,
        versionHash: state.project.head_version_hash,
        sourceLocale: state.project.source_locale,
        richText: state.project.rich_text,
        unapproved: unapproved,
        exportedAt: new Date().toISOString(),
      }, null, 2) + '\n');

      var blob = await zip.generateAsync({ type: 'blob' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.project.slug + '-locales.zip';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Download started', 'ok');
    } catch (e) {
      toast(e.message || 'Download failed', 'error');
    }
  }

  function localeCodeFromPath(path) {
    var parts = String(path || '').replace(/\\/g, '/').split('/');
    var name = parts[parts.length - 1] || '';
    if (!name.endsWith('.json')) return null;
    if (name.endsWith('.notes.json') || name === 'manifest.json') return null;
    return name.replace(/\.json$/, '');
  }

  function parseLocalesFiles(fileList, sourceLocale) {
    var files = Array.prototype.slice.call(fileList || []);
    var byCode = {};
    var reads = files.map(function (file) {
      var code = localeCodeFromPath(file.webkitRelativePath || file.name);
      if (!code) return Promise.resolve(null);
      return file.text().then(function (text) {
        byCode[code] = JSON.parse(text);
      });
    });
    return Promise.all(reads).then(function () {
      if (!(sourceLocale in byCode)) {
        throw new Error('Missing source locale file ' + sourceLocale + '.json');
      }
      if (!Object.keys(byCode).length) {
        throw new Error('No locale JSON files found');
      }
      return byCode;
    });
  }

  function parseLocalesZip(file, sourceLocale) {
    if (!window.JSZip) return Promise.reject(new Error('JSZip is not loaded'));
    return window.JSZip.loadAsync(file).then(function (zip) {
      var byCode = {};
      var jobs = [];
      zip.forEach(function (relativePath, entry) {
        if (entry.dir) return;
        var code = localeCodeFromPath(relativePath);
        if (!code) return;
        jobs.push(
          entry.async('string').then(function (text) {
            byCode[code] = JSON.parse(text);
          }),
        );
      });
      return Promise.all(jobs).then(function () {
        if (!(sourceLocale in byCode)) {
          throw new Error('Missing source locale file ' + sourceLocale + '.json');
        }
        if (!Object.keys(byCode).length) {
          throw new Error('No locale JSON files found in zip');
        }
        return byCode;
      });
    });
  }

  function renderAdmin() {
    var p = state.project;
    var html = '';
    if (state.hubAdmin) {
      html += '<section class="admin-section"><h3>Create project</h3>' +
        '<label>Slug <input id="newSlug" placeholder="my-site"></label>' +
        '<label>Name <input id="newName" placeholder="My Site"></label>' +
        '<label>GitHub repo <input id="newRepo" placeholder="org/repo"></label>' +
        '<label><input type="checkbox" id="newRich"> Rich text HTML</label>' +
        '<button type="button" class="btn btn-approve" id="createProjectBtn">Create</button></section>';
    }
    if (p) {
      html += '<section class="admin-section"><h3>' + escapeHtml(p.name) + '</h3>' +
        '<p class="note">slug: ' + escapeHtml(p.slug) +
        ' · head: ' + escapeHtml(p.head_version_hash || '(none)') + '</p>' +
        '<label>GitHub repo <input id="admRepo" value="' + escapeHtml(p.github_repo || '') + '"></label>' +
        '<label>Branch <input id="admBranch" value="' + escapeHtml(p.github_branch || 'main') + '"></label>' +
        '<label>Locales path <input id="admPath" value="' + escapeHtml(p.locales_path || 'locales') + '"></label>' +
        '<label>Locales (comma codes) <input id="admLocales" value="' +
          escapeHtml(state.locales.map(function (l) { return l.locale; }).join(', ')) + '"></label>' +
        '<button type="button" class="btn btn-ghost" id="saveProjectBtn">Save project</button>' +
        '<button type="button" class="btn btn-approve" id="pushRepoBtn">Push to repo</button></section>';

      html += '<section class="admin-section"><h3>Upload locales</h3>' +
        '<p class="note">Load catalogs from a locales folder or zip. Skip *.notes.json and manifest.json. Requires ' +
        escapeHtml(p.source_locale || 'en') + '.json. Same sticky-approval rules as GitHub ingest.</p>' +
        '<label>Folder <input type="file" id="uploadDir" webkitdirectory multiple></label>' +
        '<label>Zip <input type="file" id="uploadZip" accept=".zip,application/zip"></label>' +
        '<label><input type="checkbox" id="uploadInitialApproved"> Mark non-empty translations approved (first import only)</label>' +
        '<button type="button" class="btn btn-approve" id="uploadLocalesBtn">Upload</button></section>';

      html += '<section class="admin-section"><h3>Credentials</h3>' +
        '<button type="button" class="btn btn-ghost" id="rotateSecretBtn">Rotate push secret</button>' +
        '<label>GitHub token <input id="ghToken" type="password" autocomplete="off" placeholder="fine-grained PAT"></label>' +
        '<button type="button" class="btn btn-ghost" id="saveTokenBtn">Save GitHub token</button>' +
        '<pre id="secretOut" class="secret-out" hidden></pre></section>';

      html += '<section class="admin-section"><h3>Invite member</h3>' +
        '<label>Email <input id="invEmail" type="email"></label>' +
        '<label>or GitHub login <input id="invGithub"></label>' +
        '<label>Role <select id="invRole"><option value="reviewer">reviewer</option><option value="admin">admin</option></select></label>' +
        '<label>Locales <input id="invLocales" placeholder="es, fr"></label>' +
        '<button type="button" class="btn btn-approve" id="inviteBtn">Invite</button>' +
        '<div id="inviteList"></div></section>';
    }
    el.adminBody.innerHTML = html || '<p>No admin actions available.</p>';

    var createBtn = document.getElementById('createProjectBtn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        var slug = (document.getElementById('newSlug').value || '').trim();
        var name = (document.getElementById('newName').value || '').trim();
        var repo = (document.getElementById('newRepo').value || '').trim();
        var rich = document.getElementById('newRich').checked;
        Hub.createProject({
          slug: slug,
          name: name || slug,
          github_repo: repo || null,
          rich_text: rich,
          placeholder_style: 'auto',
        }).then(function (created) {
          toast('Project created', 'ok');
          return Hub.listMyProjects().then(function (list) {
            state.projects = list;
            fillProjectSelect();
            return loadProject(created.slug).then(renderAdmin);
          });
        }).catch(function (e) { toast(e.message || 'Create failed', 'error'); });
      });
    }

    var saveProjectBtn = document.getElementById('saveProjectBtn');
    if (saveProjectBtn) {
      saveProjectBtn.addEventListener('click', function () {
        var locales = (document.getElementById('admLocales').value || '')
          .split(',')
          .map(function (s) { return s.trim(); })
          .filter(Boolean);
        Hub.updateProject(p.id, {
          github_repo: document.getElementById('admRepo').value.trim() || null,
          github_branch: document.getElementById('admBranch').value.trim() || 'main',
          locales_path: document.getElementById('admPath').value.trim() || 'locales',
        }).then(function (updated) {
          state.project = updated;
          return Hub.setLocales(p.id, locales);
        }).then(function () {
          toast('Project saved', 'ok');
          return loadProject(p.slug).then(renderAdmin);
        }).catch(function (e) { toast(e.message || 'Save failed', 'error'); });
      });
    }

    var pushBtn = document.getElementById('pushRepoBtn');
    if (pushBtn) {
      pushBtn.addEventListener('click', function () {
        if (!window.confirm('Push current locale files to ' + (p.github_repo || 'repo') + '?')) return;
        Hub.pushToRepo(p.id).then(function (data) {
          toast('Pushed to ' + data.repo, 'ok');
        }).catch(function (e) { toast(e.message || 'Push failed', 'error'); });
      });
    }

    var uploadBtn = document.getElementById('uploadLocalesBtn');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', function () {
        var dirInput = document.getElementById('uploadDir');
        var zipInput = document.getElementById('uploadZip');
        var initial = document.getElementById('uploadInitialApproved').checked
          ? 'approved'
          : 'unapproved';
        var sourceLocale = p.source_locale || 'en';
        var zipFile = zipInput && zipInput.files && zipInput.files[0];
        var dirFiles = dirInput && dirInput.files && dirInput.files.length
          ? Array.prototype.slice.call(dirInput.files)
          : [];
        var parsePromise;
        if (zipFile) {
          parsePromise = parseLocalesZip(zipFile, sourceLocale);
        } else if (dirFiles.length) {
          parsePromise = parseLocalesFiles(dirFiles, sourceLocale);
        } else {
          toast('Choose a locales folder or zip first', 'error');
          return;
        }
        uploadBtn.disabled = true;
        parsePromise
          .then(function (locales) {
            return Hub.importCatalog(p.id, locales, {
              sourceLocale: sourceLocale,
              initialApproval: initial,
            });
          })
          .then(function (data) {
            if (data && data.noop) {
              toast('Catalog unchanged (same content hash)', 'ok');
            } else {
              toast(
                'Imported ' + (data.sourceKeys || 0) + ' keys' +
                  (data.changedKeys ? ' · ' + data.changedKeys + ' English changed' : ''),
                'ok',
              );
            }
            if (dirInput) dirInput.value = '';
            if (zipInput) zipInput.value = '';
            return Hub.listMyProjects().then(function (list) {
              state.projects = list;
              fillProjectSelect();
              return loadProject(p.slug).then(renderAdmin);
            });
          })
          .catch(function (e) {
            toast(e.message || 'Upload failed', 'error');
          })
          .finally(function () {
            uploadBtn.disabled = false;
          });
      });
    }

    var rotateBtn = document.getElementById('rotateSecretBtn');
    if (rotateBtn) {
      rotateBtn.addEventListener('click', function () {
        Hub.rotatePushSecret(p.id).then(function (data) {
          var out = document.getElementById('secretOut');
          out.hidden = false;
          out.textContent = data.pushSecret;
          toast('Copy the push secret now — it is shown only once', 'ok');
        }).catch(function (e) { toast(e.message || 'Rotate failed', 'error'); });
      });
    }

    var saveTokenBtn = document.getElementById('saveTokenBtn');
    if (saveTokenBtn) {
      saveTokenBtn.addEventListener('click', function () {
        var token = document.getElementById('ghToken').value.trim();
        Hub.setGithubToken(p.id, token).then(function () {
          document.getElementById('ghToken').value = '';
          toast('GitHub token saved', 'ok');
        }).catch(function (e) { toast(e.message || 'Token save failed', 'error'); });
      });
    }

    var inviteBtn = document.getElementById('inviteBtn');
    if (inviteBtn) {
      inviteBtn.addEventListener('click', function () {
        var locales = (document.getElementById('invLocales').value || '')
          .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        Hub.createInvite(p.id, {
          email: document.getElementById('invEmail').value.trim() || null,
          github_login: document.getElementById('invGithub').value.trim() || null,
          role: document.getElementById('invRole').value,
          locales: locales,
        }).then(function () {
          toast('Invite created', 'ok');
          renderAdmin();
        }).catch(function (e) { toast(e.message || 'Invite failed', 'error'); });
      });
      Hub.listInvites(p.id).then(function (invites) {
        var box = document.getElementById('inviteList');
        if (!box) return;
        box.innerHTML = invites.map(function (inv) {
          return '<div class="invite-row">' +
            escapeHtml(inv.email || inv.github_login || '') +
            ' · ' + escapeHtml(inv.role) +
            ' · ' + escapeHtml((inv.locales || []).join(', ')) +
            '</div>';
        }).join('') || '<p class="note">No open invites.</p>';
      }).catch(function () { /* ignore */ });
    }
  }

  function boot() {
    if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
      el.authScreen.hidden = false;
      el.authNote.hidden = false;
      el.authNote.textContent = 'Set supabaseUrl and supabaseAnonKey in config.js, then reload.';
      return;
    }

    try {
      Hub.ensureClient();
    } catch (e) {
      el.authScreen.hidden = false;
      el.authNote.hidden = false;
      el.authNote.textContent = e.message || String(e);
      return;
    }

    el.githubSignIn.addEventListener('click', function () {
      Hub.signInWithGitHub().catch(function (e) {
        toast(e.message || 'GitHub sign-in failed', 'error');
      });
    });

    el.magicSignIn.addEventListener('click', function () {
      var email = (el.magicEmail.value || '').trim();
      if (!email) {
        el.magicEmail.focus();
        return;
      }
      Hub.signInWithMagicLink(email).then(function () {
        el.authNote.hidden = false;
        el.authNote.textContent = 'Check your email for the magic link.';
      }).catch(function (e) {
        toast(e.message || 'Magic link failed', 'error');
      });
    });

    el.signOutBtn.addEventListener('click', function () {
      Hub.signOut().then(showSignedOut);
    });

    el.projectSelect.addEventListener('change', function () {
      settleApproveQueue().then(function () {
        loadProject(el.projectSelect.value);
      });
    });

    el.localeSelect.addEventListener('change', function () {
      var next = el.localeSelect.value;
      var prev = state.locale;
      settleApproveQueue().then(function () {
        if (Object.keys(state.approveErrors).length) {
          el.localeSelect.value = prev;
          toast('Some approvals did not save — retry the highlighted rows', 'error');
          return;
        }
        loadLocale(next);
      });
    });

    el.search.addEventListener('input', function () {
      state.filter = el.search.value;
      renderRows();
    });

    el.adminBtn.addEventListener('click', function () {
      el.adminModal.hidden = false;
      renderAdmin();
    });
    el.adminClose.addEventListener('click', function () {
      el.adminModal.hidden = true;
    });
    el.downloadBtn.addEventListener('click', function () {
      downloadZip();
    });

    Hub.onAuthChange(function (_event, session) {
      if (session && session.user) showSignedIn(session.user);
      else showSignedOut();
    });

    Hub.getSession().then(function (session) {
      if (session && session.user) showSignedIn(session.user);
      else showSignedOut();
    }).catch(function (e) {
      showWake(true, e.message || 'Could not reach Supabase');
      showSignedOut();
    });
  }

  boot();
})();
