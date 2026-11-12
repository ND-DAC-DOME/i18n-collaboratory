/**
 * Supabase data layer for the translation hub.
 * Expects window.supabase (UMD) and window.UAOA_I18N_REVIEW config.
 */
(function (root) {
  'use strict';

  var CFG = root.UAOA_I18N_REVIEW || {};
  var client = null;

  function ensureClient() {
    if (client) return client;
    if (!root.supabase || !root.supabase.createClient) {
      throw new Error('supabase-js is not loaded');
    }
    if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
      throw new Error('Set supabaseUrl and supabaseAnonKey in config.js');
    }
    client = root.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: {
        persistSession: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
    return client;
  }

  function sb() {
    return ensureClient();
  }

  function functionsUrl(name) {
    return CFG.supabaseUrl.replace(/\/$/, '') + '/functions/v1/' + name;
  }

  async function invokeFunction(name, body) {
    var session = await getSession();
    if (!session) throw new Error('Not signed in');
    var res = await fetch(functionsUrl(name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
        apikey: CFG.supabaseAnonKey,
      },
      body: JSON.stringify(body || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  async function getSession() {
    var c = sb();
    var result = await c.auth.getSession();
    return result.data.session || null;
  }

  async function getUser() {
    var session = await getSession();
    return session ? session.user : null;
  }

  async function signInWithGitHub() {
    var c = sb();
    var redirectTo = location.origin + location.pathname;
    var result = await c.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: redirectTo },
    });
    if (result.error) throw result.error;
    return result.data;
  }

  async function signInWithMagicLink(email) {
    var c = sb();
    var redirectTo = location.origin + location.pathname;
    var result = await c.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: redirectTo },
    });
    if (result.error) throw result.error;
    return result.data;
  }

  async function signOut() {
    var c = sb();
    await c.auth.signOut();
  }

  function onAuthChange(cb) {
    var c = sb();
    return c.auth.onAuthStateChange(function (event, session) {
      cb(event, session);
    });
  }

  async function acceptInvites() {
    var c = sb();
    await c.rpc('accept_my_invites');
  }

  async function isHubAdmin() {
    var c = sb();
    var result = await c.rpc('is_hub_admin');
    if (result.error) throw result.error;
    return !!result.data;
  }

  async function listMyProjects() {
    var c = sb();
    var result = await c.from('projects').select('*').order('name');
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function getProject(projectId) {
    var c = sb();
    var result = await c.from('projects').select('*').eq('id', projectId).single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function getMembership(projectId) {
    var c = sb();
    var user = await getUser();
    if (!user) return null;
    var result = await c
      .from('project_members')
      .select('id, role, member_languages(locale)')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (result.error) throw result.error;
    return result.data;
  }

  async function listLocales(projectId) {
    var c = sb();
    var result = await c
      .from('project_locales')
      .select('locale, label')
      .eq('project_id', projectId)
      .order('locale');
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function loadSourceStrings(projectId) {
    var c = sb();
    var all = [];
    var from = 0;
    var page = 1000;
    for (;;) {
      var result = await c
        .from('source_strings')
        .select('key, text, note, text_fp, previous_text')
        .eq('project_id', projectId)
        .range(from, from + page - 1);
      if (result.error) throw result.error;
      var rows = result.data || [];
      all = all.concat(rows);
      if (rows.length < page) break;
      from += page;
    }
    return all;
  }

  async function loadTranslations(projectId, locale) {
    var c = sb();
    var all = [];
    var from = 0;
    var page = 1000;
    for (;;) {
      var result = await c
        .from('translations')
        .select('key, text, note, approved, approved_by, approved_by_name, approved_at, en_fp, stale, stale_reason')
        .eq('project_id', projectId)
        .eq('locale', locale)
        .range(from, from + page - 1);
      if (result.error) throw result.error;
      var rows = result.data || [];
      all = all.concat(rows);
      if (rows.length < page) break;
      from += page;
    }
    return all;
  }

  async function loadFocuses(projectId, locale) {
    var c = sb();
    var result = await c
      .from('translation_focus')
      .select('*')
      .eq('project_id', projectId)
      .eq('locale', locale);
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function claimFocus(projectId, locale, key, holderName) {
    var c = sb();
    var result = await c.rpc('claim_translation_focus', {
      pid: projectId,
      loc: locale,
      k: key,
      holder_display: holderName || '',
    });
    if (result.error) throw result.error;
    return result.data;
  }

  async function releaseFocus(projectId, locale, key) {
    var c = sb();
    var result = await c.rpc('release_translation_focus', {
      pid: projectId,
      loc: locale,
      k: key,
    });
    if (result.error) throw result.error;
  }

  async function heartbeatFocus(projectId, locale, key) {
    var c = sb();
    var result = await c.rpc('heartbeat_translation_focus', {
      pid: projectId,
      loc: locale,
      k: key,
    });
    if (result.error) throw result.error;
    return result.data;
  }

  async function approveKeys(projectId, locale, keys, approverDisplay) {
    var c = sb();
    var result = await c.rpc('approve_translation_keys', {
      pid: projectId,
      loc: locale,
      keys: keys,
      approver_display: approverDisplay || '',
    });
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function unapproveKey(projectId, locale, key) {
    var c = sb();
    var result = await c.rpc('unapprove_translation_key', {
      pid: projectId,
      loc: locale,
      k: key,
    });
    if (result.error) throw result.error;
  }

  async function saveTranslation(projectId, locale, key, text, note) {
    var c = sb();
    var result = await c.rpc('save_translation', {
      pid: projectId,
      loc: locale,
      k: key,
      new_text: text,
      new_note: note == null ? null : note,
    });
    if (result.error) throw result.error;
    return result.data;
  }

  async function createProject(fields) {
    var c = sb();
    var result = await c.from('projects').insert(fields).select('*').single();
    if (result.error) throw result.error;
    var user = await getUser();
    if (user) {
      await c.from('project_members').insert({
        project_id: result.data.id,
        user_id: user.id,
        role: 'admin',
      });
    }
    return result.data;
  }

  async function updateProject(projectId, fields) {
    var c = sb();
    var result = await c.from('projects').update(fields).eq('id', projectId).select('*').single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function setLocales(projectId, locales) {
    var c = sb();
    await c.from('project_locales').delete().eq('project_id', projectId);
    if (locales && locales.length) {
      var rows = locales.map(function (loc) {
        return {
          project_id: projectId,
          locale: typeof loc === 'string' ? loc : loc.locale,
          label: typeof loc === 'string' ? loc : (loc.label || loc.locale),
        };
      });
      var result = await c.from('project_locales').insert(rows);
      if (result.error) throw result.error;
    }
  }

  async function listMembers(projectId) {
    var c = sb();
    var result = await c
      .from('project_members')
      .select('id, user_id, role, member_languages(locale)')
      .eq('project_id', projectId);
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function listInvites(projectId) {
    var c = sb();
    var result = await c
      .from('project_invites')
      .select('*')
      .eq('project_id', projectId)
      .is('accepted_at', null)
      .order('created_at', { ascending: false });
    if (result.error) throw result.error;
    return result.data || [];
  }

  async function createInvite(projectId, invite) {
    var c = sb();
    var user = await getUser();
    var result = await c.from('project_invites').insert({
      project_id: projectId,
      email: invite.email || null,
      github_login: invite.github_login || null,
      role: invite.role || 'reviewer',
      locales: invite.locales || [],
      invited_by: user ? user.id : null,
    }).select('*').single();
    if (result.error) throw result.error;
    return result.data;
  }

  async function deleteInvite(inviteId) {
    var c = sb();
    var result = await c.from('project_invites').delete().eq('id', inviteId);
    if (result.error) throw result.error;
  }

  async function rotatePushSecret(projectId) {
    return invokeFunction('credentials', {
      projectId: projectId,
      action: 'rotate_push_secret',
    });
  }

  async function setGithubToken(projectId, githubToken) {
    return invokeFunction('credentials', {
      projectId: projectId,
      action: 'set_github_token',
      githubToken: githubToken,
    });
  }

  async function pushToRepo(projectId, message) {
    return invokeFunction('push', {
      projectId: projectId,
      message: message || null,
    });
  }

  async function importCatalog(projectId, locales, opts) {
    opts = opts || {};
    return invokeFunction('import-catalog', {
      projectId: projectId,
      locales: locales,
      sourceLocale: opts.sourceLocale || null,
      initialApproval: opts.initialApproval || 'unapproved',
    });
  }

  function subscribeLocale(projectId, locale, handlers) {
    var c = sb();
    var channel = c.channel('review:' + projectId + ':' + locale);
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'translations',
        filter: 'project_id=eq.' + projectId,
      },
      function (payload) {
        var row = payload.new || payload.old;
        if (!row || row.locale !== locale) return;
        if (handlers && handlers.onTranslation) handlers.onTranslation(payload);
      },
    );
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'translation_focus',
        filter: 'project_id=eq.' + projectId,
      },
      function (payload) {
        var row = payload.new || payload.old;
        if (!row || row.locale !== locale) return;
        if (handlers && handlers.onFocus) handlers.onFocus(payload);
      },
    );
    channel.subscribe();
    return channel;
  }

  function removeChannel(channel) {
    if (!channel) return Promise.resolve();
    var c = sb();
    return c.removeChannel(channel);
  }

  async function probeHealth() {
    try {
      ensureClient();
      var session = await getSession();
      // A lightweight auth call proves the project is reachable.
      var c = sb();
      var result = await c.auth.getSession();
      if (result.error) throw result.error;
      return { ok: true, signedIn: !!session };
    } catch (e) {
      var err = e instanceof Error ? e : new Error(String(e));
      err.pausedLikely = true;
      throw err;
    }
  }

  /**
   * Build nested catalog objects for zip/export from flat rows.
   * Arrays only when siblings are all decimal and include "0" (0-based).
   * 1-based numbered objects ("1","2",…) stay objects — no leading null.
   * Keep in sync with supabase/functions/_shared/catalog.ts nestStrings.
   */
  function childSegmentsByPrefix(keys) {
    var map = Object.create(null);
    keys.forEach(function (key) {
      var parts = key.split('.');
      var prefix = '';
      for (var i = 0; i < parts.length; i++) {
        if (!map[prefix]) map[prefix] = Object.create(null);
        map[prefix][parts[i]] = true;
        prefix = prefix ? prefix + '.' + parts[i] : parts[i];
      }
    });
    return map;
  }

  function wantArrayChildren(siblings) {
    if (!siblings) return false;
    var keys = Object.keys(siblings);
    if (!keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (!/^\d+$/.test(keys[i])) return false;
    }
    return !!siblings['0'];
  }

  function nestFlat(flatLeaves, mode) {
    var root = {};
    var children = childSegmentsByPrefix(Object.keys(flatLeaves));
    Object.keys(flatLeaves).forEach(function (key) {
      var leaf = flatLeaves[key];
      var parts = key.split('.');
      var cur = root;
      var prefix = '';
      for (var i = 0; i < parts.length - 1; i++) {
        var p = parts[i];
        var childPrefix = prefix ? prefix + '.' + p : p;
        var asArray = wantArrayChildren(children[childPrefix]);
        if (Array.isArray(cur)) {
          var idx = Number(p);
          if (cur[idx] == null) cur[idx] = asArray ? [] : {};
          cur = cur[idx];
        } else {
          if (cur[p] == null) cur[p] = asArray ? [] : {};
          cur = cur[p];
        }
        prefix = childPrefix;
      }
      var last = parts[parts.length - 1];
      var value = mode === 'rich'
        ? (leaf.note ? { text: leaf.text, note: leaf.note } : { text: leaf.text })
        : leaf.text;
      if (Array.isArray(cur)) cur[Number(last)] = value;
      else cur[last] = value;
    });
    return root;
  }

  root.I18nHub = {
    ensureClient: ensureClient,
    getSession: getSession,
    getUser: getUser,
    signInWithGitHub: signInWithGitHub,
    signInWithMagicLink: signInWithMagicLink,
    signOut: signOut,
    onAuthChange: onAuthChange,
    acceptInvites: acceptInvites,
    isHubAdmin: isHubAdmin,
    listMyProjects: listMyProjects,
    getProject: getProject,
    getMembership: getMembership,
    listLocales: listLocales,
    loadSourceStrings: loadSourceStrings,
    loadTranslations: loadTranslations,
    loadFocuses: loadFocuses,
    claimFocus: claimFocus,
    releaseFocus: releaseFocus,
    heartbeatFocus: heartbeatFocus,
    subscribeLocale: subscribeLocale,
    removeChannel: removeChannel,
    approveKeys: approveKeys,
    unapproveKey: unapproveKey,
    saveTranslation: saveTranslation,
    createProject: createProject,
    updateProject: updateProject,
    setLocales: setLocales,
    listMembers: listMembers,
    listInvites: listInvites,
    createInvite: createInvite,
    deleteInvite: deleteInvite,
    rotatePushSecret: rotatePushSecret,
    setGithubToken: setGithubToken,
    pushToRepo: pushToRepo,
    importCatalog: importCatalog,
    probeHealth: probeHealth,
    nestFlat: nestFlat,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
