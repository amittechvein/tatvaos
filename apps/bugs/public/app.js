// TatvaOS Bugs — the browser side. No framework, no build step.
//
// EVERY piece of text reaches the page through h() below, which sets
// textContent, never innerHTML. Reports are written by people pasting error
// messages and HTML snippets; this is what keeps them from running.
'use strict';

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'required' || k === 'multiple') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(method, url, body) {
  const opts = { method, headers: { 'X-Bug-Tracker': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (res.status === 401) { state.me = null; render(); throw new Error('Please sign in.'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong.');
  return data;
}

function upload(issueId, activityId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/issues/${issueId}/attachments?activity=${activityId}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Bug-Tracker', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error((() => { try { return JSON.parse(xhr.responseText).error; } catch { return 'Upload failed.'; } })())));
    xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
    xhr.send(file);
  });
}

async function uploadAll(issueId, activityId, files, statusEl) {
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      await upload(issueId, activityId, f, (p) => { statusEl.textContent = `Uploading ${f.name} (${i + 1} of ${files.length}) — ${Math.round(p * 100)}%`; });
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  statusEl.textContent = '';
  if (failed.length) toast('Some files did not upload — ' + failed.join('; '), true);
}

const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const fmtDay = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : '';
const ROLE_LABEL = { admin: 'Admin', developer: 'Developer', tester: 'Tester' };
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const STATUS_ORDER = ['pending', 'under_review', 'more_info', 'under_dev', 'fixed', 'closed', 'reopened'];

function toast(msg, isError) {
  const t = h('div', { class: 'toast' + (isError ? ' error' : '') }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), isError ? 7000 : 3000);
}

function statusBadge(status, label) {
  return h('span', { class: 'badge st-' + status }, label || state.me?.statuses?.[status] || status);
}
function priorityBadge(p) { return h('span', { class: 'badge pr-' + p }, cap(p)); }
function typeBadge(t) { return h('span', { class: 'badge ty-' + t }, t === 'bug' ? 'Bug' : 'Feature'); }

function modal(title, body, actions) {
  // The dialog must exist BEFORE actions(dlg) runs: building it in one
  // expression handed actions() an uninitialised `dlg` and threw, so no
  // pop-up in the app ever opened (25 Sept, "Add module not working").
  const dlg = h('dialog', { class: 'modal' });
  dlg.append(
    h('form', { method: 'dialog', onsubmit: (e) => e.preventDefault() },
      h('h2', {}, title), body,
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), actions(dlg))));
  // Remove on close synchronously. Relying on the 'close' event alone left
  // closed dialogs in the page (seen with the window in the background), and
  // the next "find the dialog" then found a dead one.
  // 'bt-closed' fires exactly once, synchronously, however the dialog ends
  // (Save, Cancel or Escape), so callers can undo a half-made choice.
  let ended = false;
  const end = () => { if (ended) return; ended = true; dlg.remove(); dlg.dispatchEvent(new Event('bt-closed')); };
  dlg.close = () => { HTMLDialogElement.prototype.close.call(dlg); end(); };
  dlg.addEventListener('close', end);
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// ---------------------------------------------------------------------------
//  State and routing
// ---------------------------------------------------------------------------
const state = { me: null, modules: null, developers: null };

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [p, qs] = hash.split('?');
  return { path: p, params: new URLSearchParams(qs || '') };
}
window.addEventListener('hashchange', render);

async function loadMe() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    state.me = res.ok ? await res.json() : null;
  } catch { state.me = null; }
}

async function modules(force) {
  if (!state.modules || force) state.modules = await api('GET', '/api/modules');
  return state.modules;
}
async function people(force) {
  if (!state.people || force) state.people = await api('GET', '/api/users');
  return state.people;
}

async function render() {
  const root = document.getElementById('app');
  if (!state.me) {
    root.replaceChildren(h('main', { class: 'signin-card' },
      h('div', { class: 'brand-mark' }, 'TV'),
      h('h1', {}, 'TatvaOS Bugs'),
      h('p', {}, 'Report bugs and feature requests for TatvaOS, and follow them to the fix.'),
      h('a', { class: 'btn primary', href: '/auth/login' }, 'Sign in with TatvaOS')));
    document.body.className = 'signin';
    return;
  }
  document.body.className = '';
  const { path, params } = route();
  const main = h('main', { class: 'content' }, h('div', { class: 'loading' }, 'Loading…'));
  root.replaceChildren(topbar(path), main);
  try {
    let view;
    if (path === '/') view = await dashboardView(params);
    else if (path === '/issues') view = await issuesView(params);
    else if (path === '/new') view = await newIssueView();
    else if (path.startsWith('/issue/')) view = await issueView(Number(path.split('/')[2]));
    else if (path === '/modules') view = await modulesView();
    else if (path === '/users') view = await usersView();
    else if (path === '/reports') view = await reportsView(params);
    else if (path === '/settings') view = await settingsView();
    else view = h('p', {}, 'Page not found.');
    main.replaceChildren(view);
  } catch (e) {
    main.replaceChildren(h('div', { class: 'empty' }, e.message));
  }
}

function topbar(path) {
  const me = state.me;
  const mode = me.mode;
  const link = (href, label, match) => h('a', { href: '#' + href, class: (match ? match(path) : path === href) ? 'active' : '' }, label);
  const nav = [
    link('/', 'Dashboard'),
    link('/issues', 'All issues', (p) => p === '/issues' || p.startsWith('/issue/')),
    (mode === 'tester' || mode === 'admin') && link('/new', 'Create issue'),
    mode === 'admin' && link('/modules', 'Modules'),
    mode === 'admin' && link('/users', 'Users'),
    mode === 'admin' && link('/reports', 'Reports'),
    link('/settings', 'Settings'),
  ];
  const modeSel = me.user.roles.length > 1
    ? h('label', { class: 'mode' }, h('span', {}, 'Working as'),
        h('select', { onchange: async (e) => { try { await api('POST', '/api/me/mode', { mode: e.target.value }); state.me.mode = e.target.value; location.hash = '#/'; render(); } catch (err) { toast(err.message, true); } } },
          me.user.roles.map((r) => h('option', { value: r, selected: r === mode }, ROLE_LABEL[r]))))
    : h('span', { class: 'mode single' }, ROLE_LABEL[mode]);
  // On a phone the links fold behind a Menu button; "Working as" stays in
  // view because it decides what every screen shows.
  const header = h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark small' }, 'TV'), h('span', {}, 'TatvaOS ', h('b', {}, 'Bugs'))),
    h('button', { class: 'btn menu-btn', type: 'button', 'aria-label': 'Menu', onclick: () => header.classList.toggle('open') }, '☰ Menu'),
    h('nav', { onclick: (e) => { if (e.target.closest('a')) header.classList.remove('open'); } }, nav),
    h('div', { class: 'who' }, modeSel,
      h('span', { class: 'who-name', title: me.user.email }, me.user.name),
      h('form', { method: 'post', action: '/auth/logout' }, h('button', { class: 'btn link', type: 'submit' }, 'Sign out'))));
  return header;
}

// ---------------------------------------------------------------------------
//  Filters (shared by dashboard, issues and reports)
// ---------------------------------------------------------------------------
async function filterBar(params, target, { full }) {
  const mods = await modules();
  const ppl = full ? await people() : [];
  const devs = ppl.filter((u) => u.roles.includes('developer'));
  const testers = ppl.filter((u) => u.roles.includes('tester') || u.roles.includes('admin'));
  const form = h('form', { class: 'filters', onsubmit: (e) => {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) q.set(k, v);
    location.hash = '#' + target + (q.toString() ? '?' + q : '');
  } });
  const sel = (name, label, options) => h('label', {}, h('span', {}, label),
    h('select', { name }, h('option', { value: '' }, 'All'), options.map(([v, t]) => h('option', { value: v, selected: params.get(name) === String(v) }, t))));
  const subSel = sel('submodule', 'Sub-module', []);
  const fillSubs = (modId) => {
    const s = subSel.querySelector('select');
    s.replaceChildren(h('option', { value: '' }, 'All'));
    const m = mods.find((x) => String(x.id) === String(modId));
    for (const sm of m ? m.submodules : []) s.append(h('option', { value: sm.id, selected: params.get('submodule') === String(sm.id) }, sm.name));
  };
  const modSel = sel('module', 'Module', mods.map((m) => [m.id, m.name]));
  modSel.querySelector('select').addEventListener('change', (e) => fillSubs(e.target.value));
  fillSubs(params.get('module'));
  form.append(...[
    h('label', { class: 'grow' }, h('span', {}, 'Search'), h('input', { name: 'q', value: params.get('q') || '', placeholder: 'Title, details or TV-000125' })),
    modSel, subSel,
    sel('type', 'Type', [['bug', 'Bug'], ['feature', 'Feature request']]),
    sel('status', 'Status', STATUS_ORDER.map((s) => [s, state.me.statuses[s]])),
    sel('priority', 'Priority', PRIORITIES.map((p) => [p, cap(p)])),
    target === '/issues' && h('label', {}, h('span', {}, 'Sort'), h('select', { name: 'sort' },
      [['', 'Last updated'], ['due_asc', 'Due date — soonest first'], ['due_desc', 'Due date — latest first']].map(([v, t]) => h('option', { value: v, selected: (params.get('sort') || '') === v }, t)))),
    sel('due', 'Due', [['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due in next 7 days'], ['set', 'Has a due date'], ['none', 'No due date']]),
    full && sel('assignee', 'Developer', [['none', '(unassigned)'], ...devs.map((u) => [u.id, u.name])]),
    full && sel('reporter', 'Tester', testers.map((u) => [u.id, u.name])),
    h('label', {}, h('span', {}, 'From'), h('input', { type: 'date', name: 'from', value: params.get('from') || '' })),
    h('label', {}, h('span', {}, 'To'), h('input', { type: 'date', name: 'to', value: params.get('to') || '' })),
    params.get('mine') && h('input', { type: 'hidden', name: 'mine', value: '1' }),
    params.get('scope') && h('input', { type: 'hidden', name: 'scope', value: params.get('scope') }),
    h('div', { class: 'filter-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Apply'), h('a', { class: 'btn', href: '#' + target }, 'Clear'))].filter(Boolean));
  // Folded on phones unless a filter is in use; always open on a wide screen.
  const active = [...params.keys()].filter((k) => !['r', 'mine', 'scope', 'sort'].includes(k)).length;
  return h('details', { class: 'filter-box', open: active > 0 || window.matchMedia('(min-width: 701px)').matches },
    h('summary', {}, 'Filters', active ? ` (${active} in use)` : ''), form);
}

// ---------------------------------------------------------------------------
//  Dashboard
// ---------------------------------------------------------------------------
async function dashboardView(params) {
  const mode = state.me.mode;
  const qs = params.toString();
  const { counts, scope } = await api('GET', '/api/dashboard' + (qs ? '?' + qs : ''));
  const personal = scope === 'mine';
  const st = state.me.statuses;
  const tiles = {
    admin: [['total', 'Total issues'], ['bug', 'Bugs', 'type=bug'], ['feature', 'Features', 'type=feature'], ...STATUS_ORDER.map((s) => [s, st[s], 'status=' + s]), ['overdue', 'Overdue', 'due=overdue']],
    developer: [['total', personal ? 'Assigned issues' : 'All issues'], ['pending', st.pending, 'status=pending'], ['under_review', st.under_review, 'status=under_review'], ['more_info', st.more_info, 'status=more_info'], ['under_dev', st.under_dev, 'status=under_dev'], ['reopened', st.reopened, 'status=reopened'], ['fixed', st.fixed, 'status=fixed'], ['overdue', 'Overdue issues', 'due=overdue']],
    tester: [['total', personal ? 'My reports' : 'All reports'], ['pending', st.pending, 'status=pending'], ['under_review', st.under_review, 'status=under_review'], ['more_info', st.more_info, 'status=more_info'], ['under_dev', st.under_dev, 'status=under_dev'], ['fixed', st.fixed, 'status=fixed'], ['closed', st.closed, 'status=closed'], ['reopened', st.reopened, 'status=reopened']],
  }[mode];
  const base = new URLSearchParams(params);
  base.delete('scope');
  if (personal) base.set('mine', '1');
  const title = { admin: 'Admin dashboard', developer: 'Developer dashboard', tester: 'Tester dashboard' }[mode];
  const hint = !personal ? 'Every issue in the tracker.' : { admin: 'Issues you reported or are working on.', developer: 'Issues assigned to you.', tester: 'Reports you filed.' }[mode];
  const scopeLink = (sc, label) => {
    const q = new URLSearchParams(params); q.set('scope', sc);
    return h('a', { class: 'btn small' + ((sc === 'mine') === personal ? ' primary' : ''), href: '#/?' + q }, label);
  };
  const scopeSwitch = h('div', { class: 'row scope-switch' }, scopeLink('mine', { admin: 'Mine', developer: 'Assigned to me', tester: 'My reports' }[mode]), scopeLink('all', 'Everyone'));
  const attention = mode === 'tester' && personal && counts.fixed
    ? h('div', { class: 'callout' }, `${counts.fixed} of your reports ${counts.fixed === 1 ? 'is' : 'are'} marked Fixed and waiting for you to verify. `, h('a', { href: '#/issues?mine=1&status=fixed' }, 'Verify now'))
    : mode === 'tester' && personal && counts.more_info
      ? h('div', { class: 'callout' }, `${counts.more_info} of your reports need${counts.more_info === 1 ? 's' : ''} more information from you. `, h('a', { href: '#/issues?mine=1&status=more_info' }, 'Answer now'))
      : null;
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), h('p', { class: 'muted' }, hint)),
      (mode === 'tester' || mode === 'admin') && h('a', { class: 'btn primary', href: '#/new' }, '+ Create issue')),
    scopeSwitch,
    attention,
    await filterBar(params, '/', { full: true }),
    h('div', { class: 'tiles' }, tiles.map(([k, label, filter]) => {
      const q = new URLSearchParams(base);
      if (filter) { const [fk, fv] = filter.split('='); q.set(fk, fv); }
      return h('a', { class: 'tile t-' + k + (k === 'overdue' && counts.overdue ? ' alert' : ''), href: '#/issues' + (q.toString() ? '?' + q : '') },
        h('span', { class: 'tile-n' }, counts[k] ?? 0), h('span', { class: 'tile-l' }, label));
    })));
}

// ---------------------------------------------------------------------------
//  Issue list
// ---------------------------------------------------------------------------
async function issuesView(params) {
  const mode = state.me.mode;
  const qs = params.toString();
  const rows = await api('GET', '/api/issues' + (qs ? '?' + qs : ''));
  const mine = params.get('mine') === '1';
  const MINE_LABEL = { admin: 'My issues', developer: 'Assigned to me', tester: 'My reports' };
  const title = mine ? MINE_LABEL[mode] : 'All issues';

  // Assign from the table (Amit, 25 Sept): admins pick the developer in the
  // Developer column; developers take a free issue with "Assign to me". The
  // server applies the same rules as on the issue page.
  const devs = mode === 'admin' ? (await people(true)).filter((u) => u.roles.includes('developer') && u.active !== false) : [];
  const assign = async (i, to, el) => {
    el.disabled = true;
    try {
      await api('POST', `/api/issues/${i.id}/actions`, { action: 'assign', assignee_id: to });
      toast(to === null ? `${i.key} unassigned.` : `${i.key} assigned to ${to === state.me.user.id ? 'you' : (devs.find((d) => d.id === to) || {}).name}.`);
      render();
    } catch (err) { toast(err.message, true); el.disabled = false; render(); }
  };
  const stop = (e) => e.stopPropagation();
  // Clicking "Due" sorts soonest first, then latest first, then back.
  const sort = params.get('sort') || '';
  const dueHeader = () => {
    const next = sort === 'due_asc' ? 'due_desc' : sort === 'due_desc' ? '' : 'due_asc';
    const q = new URLSearchParams(params); if (next) q.set('sort', next); else q.delete('sort');
    return h('th', { class: 'sortable' + (sort.startsWith('due') ? ' sorted' : '') },
      h('a', { href: '#/issues' + (q.toString() ? '?' + q : ''), title: 'Sort by due date' }, 'Due', sort === 'due_asc' ? ' ▲' : sort === 'due_desc' ? ' ▼' : ' ↕'));
  };
  // Change type, priority and status straight from the table (Amit, 25
  // Sept). Every change goes through the same actions as the issue page, so
  // the history records who changed what, from what to what, and in which role.
  const post = async (i, payload) => {
    await api('POST', `/api/issues/${i.id}/actions`, payload);
    toast(`${i.key} updated.`);
    render();
  };
  const cellSelect = (label, options, current, onPick) => h('select', {
    class: 'cell-select', 'aria-label': label, onclick: stop,
    onchange: async (e) => {
      const v = e.target.value;
      e.target.disabled = true;
      try { await onPick(v); } catch (err) { toast(err.message, true); render(); }
    },
  }, options.map(([v, t]) => h('option', { value: v, selected: v === current }, t)));

  // Status moves that need words open a small box; the others apply at once.
  const moveStatus = (i, to) => new Promise((resolve) => {
    const closeNoFix = to === 'closed' && i.status !== 'fixed';
    const needs = to === 'more_info' || to === 'fixed' || to === 'reopened' || closeNoFix;
    if (!needs) return resolve(post(i, { action: 'status', to }));
    const fix = h('textarea', { rows: 4, placeholder: 'What was changed, where, and how to check it' });
    const note = h('textarea', { rows: 3, placeholder: to === 'more_info' ? 'What do you need from the tester?' : to === 'reopened' ? 'What is still wrong?' : closeNoFix ? 'Why close without a fix? (duplicate, will not do…)' : 'Note to the tester (optional)' });
    let done = false;
    const dlg = modal(`${i.key}: ${state.me.statuses[i.status]} → ${state.me.statuses[to]}`, h('div', {},
      to === 'fixed' && h('label', {}, h('span', {}, 'Fix details'), fix),
      h('label', {}, h('span', {}, to === 'more_info' ? 'Question' : to === 'fixed' ? 'Note (optional)' : 'Reason'), note)),
      (d) => h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try {
          if (to === 'more_info') await api('POST', `/api/issues/${i.id}/actions`, { action: 'request_info', body: note.value });
          else await api('POST', `/api/issues/${i.id}/actions`, { action: 'status', to, fix_details: fix.value, body: note.value });
          done = true; d.close(); toast(`${i.key} updated.`);
        } catch (err) { toast(err.message, true); e.target.disabled = false; }
      } }, 'Save'));
    dlg.addEventListener('bt-closed', () => { render(); resolve(done); });
  });

  // Due date from the table: admin, or the developer it is assigned to.
  // Clearing the box removes the date; the history records every change.
  const dueCell = (i) => i.can && i.can.due
    ? h('input', { type: 'date', class: 'cell-date' + (i.overdue ? ' late' : ''), value: i.due_date || '', 'aria-label': 'Due date of ' + i.key, onclick: stop,
        onchange: async (e) => {
          const v = e.target.value || null;
          if (v === (i.due_date || null)) return;
          e.target.disabled = true;
          try { await post(i, { action: 'due', due_date: v }); } catch (err) { toast(err.message, true); render(); }
        } })
    : (i.due_date ? fmtDay(i.due_date) : h('span', { class: 'muted' }, '—'));
  const typeCell = (i) => i.can && i.can.edit
    ? cellSelect('Type of ' + i.key, [['bug', 'Bug'], ['feature', 'Feature']], i.type, (v) => post(i, { action: 'edit', type: v }))
    : typeBadge(i.type);
  const priorityCell = (i) => i.can && i.can.edit
    ? cellSelect('Priority of ' + i.key, PRIORITIES.map((p) => [p, cap(p)]), i.priority, (v) => post(i, { action: 'edit', priority: v }))
    : priorityBadge(i.priority);
  const statusCell = (i) => i.can && i.can.moves.length
    ? cellSelect('Status of ' + i.key, [[i.status, state.me.statuses[i.status]], ...i.can.moves.map((m) => [m, (m === 'closed' && i.status !== 'fixed' ? 'Close without fix' : m === 'closed' ? 'Verify & close' : '→ ' + state.me.statuses[m])])], i.status, (v) => (v === i.status ? null : moveStatus(i, v)))
    : statusBadge(i.status, i.status_label);

  const devCell = (i) => {
    const name = i.assignee_name || i.assignee_email;
    if (mode === 'admin' && i.status !== 'closed') {
      return h('select', { class: 'assign-select', 'aria-label': 'Developer for ' + i.key, onclick: stop,
        onchange: (e) => assign(i, e.target.value ? Number(e.target.value) : null, e.target) },
        h('option', { value: '' }, '— Assign —'),
        devs.map((u) => h('option', { value: u.id, selected: u.id === i.assignee_id }, u.name)));
    }
    if (mode === 'developer' && !i.assignee_id && i.status !== 'closed') {
      return h('button', { class: 'btn small primary', onclick: (e) => { stop(e); assign(i, state.me.user.id, e.target); } }, 'Assign to me');
    }
    return name || h('span', { class: 'muted' }, '—');
  };
  const table = rows.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'issues cards' },
        h('thead', {}, h('tr', {}, ['ID', 'Title', 'Type', 'Module', 'Priority', 'Status', 'Developer', 'Due', 'Reported by', 'Updated'].map((c) => c === 'Due' ? dueHeader() : h('th', {}, c)))),
        h('tbody', {}, rows.map((i) => h('tr', { onclick: () => { location.hash = '#/issue/' + i.id; } },
          h('td', { class: 'mono' }, h('a', { href: '#/issue/' + i.id }, i.key)),
          h('td', { class: 'title-cell' }, i.title, i.overdue && h('span', { class: 'badge overdue' }, 'Overdue')),
          h('td', { 'data-label': 'Type' }, typeCell(i)),
          h('td', { class: 'muted', 'data-label': 'Module' }, i.module_name, ' › ', i.submodule_name),
          h('td', { 'data-label': 'Priority' }, priorityCell(i)),
          h('td', { 'data-label': 'Status' }, statusCell(i)),
          h('td', { 'data-label': 'Developer' }, devCell(i)),
          h('td', { class: 'nowrap' + (i.overdue ? ' due-late' : ''), 'data-label': 'Due' }, dueCell(i)),
          h('td', { 'data-label': 'Reported by' }, i.reporter_name || i.reporter_email),
          h('td', { class: 'muted nowrap', 'data-label': 'Updated' }, fmtDate(i.updated_at)))))))
    : h('div', { class: 'empty' }, 'No issues match.');
  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), h('p', { class: 'muted' }, `${rows.length} issue${rows.length === 1 ? '' : 's'}${rows.length === 1000 ? ' (first 1000)' : ''}`)),
      h('div', { class: 'row' },
        h('a', { class: 'btn' + (mine ? ' primary' : ''), href: mine ? '#/issues' : '#/issues?mine=1' }, mine ? 'Show all issues' : MINE_LABEL[mode]),
        h('a', { class: 'btn', href: '/api/issues.csv' + (qs ? '?' + qs : '') }, 'Export CSV'),
        (mode === 'tester' || mode === 'admin') && h('a', { class: 'btn primary', href: '#/new' }, '+ Create issue'))),
    await filterBar(params, '/issues', { full: true }),
    table);
}

// ---------------------------------------------------------------------------
//  Create issue
// ---------------------------------------------------------------------------
async function newIssueView() {
  const mode = state.me.mode;
  if (mode !== 'tester' && mode !== 'admin') {
    return h('div', { class: 'empty' }, 'Switch to Tester mode to create a report.');
  }
  const mods = (await modules(true)).filter((m) => m.active && m.submodules.some((s) => s.active));
  if (!mods.length) {
    return h('div', { class: 'empty' }, 'No modules have been set up yet. ', mode === 'admin' ? h('a', { href: '#/modules' }, 'Add modules first.') : 'Ask an admin to add modules.');
  }
  const subSelect = h('select', { name: 'submodule_id', required: true }, h('option', { value: '' }, 'Choose a module first'));
  const modSelect = h('select', { name: 'module_id', required: true, onchange: (e) => {
    const m = mods.find((x) => String(x.id) === e.target.value);
    subSelect.replaceChildren(h('option', { value: '' }, m ? 'Choose a sub-module' : 'Choose a module first'),
      ...(m ? m.submodules.filter((s) => s.active).map((s) => h('option', { value: s.id }, s.name)) : []));
  } }, h('option', { value: '' }, 'Choose a module'), mods.map((m) => h('option', { value: m.id }, m.name)));
  const files = h('input', { type: 'file', name: 'files', multiple: true });
  const status = h('p', { class: 'muted' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Submit report');
  const titleIn = h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'e.g. Search button is not visible' });
  const detailsTa = h('textarea', { name: 'details', required: true, rows: 7, placeholder: 'What happened, what you expected, and the steps to see it again.' });
  const prioritySel = h('select', { name: 'priority', required: true }, PRIORITIES.map((p) => h('option', { value: p, selected: p === 'medium' }, cap(p))));
  let aiAssisted = false;

  // ---- Possible duplicates: plain text matching on the server, no AI. ----
  const dupes = h('div', { class: 'dupes', 'aria-live': 'polite' });
  let dupeTimer = null, dupeSeq = 0;
  const checkDupes = () => {
    clearTimeout(dupeTimer);
    dupeTimer = setTimeout(async () => {
      const seq = ++dupeSeq;
      const q = new URLSearchParams({ title: titleIn.value, details: detailsTa.value.slice(0, 1500) });
      if (modSelect.value) q.set('module', modSelect.value);
      if (subSelect.value) q.set('submodule', subSelect.value);
      let rows = [];
      try { rows = await api('GET', '/api/similar?' + q); } catch { return; }
      if (seq !== dupeSeq) return; // a newer keystroke already asked
      dupes.replaceChildren(...(rows.length ? [
        h('div', { class: 'dupes-head' }, 'Possible duplicates — please check these before submitting:'),
        h('ul', {}, rows.map((r) => h('li', {},
          h('a', { href: '#/issue/' + r.id, target: '_blank', rel: 'noopener' }, r.key), ' ', r.title, ' ',
          statusBadge(r.status, r.status_label), h('span', { class: 'muted small' }, ' ' + r.module_name + ' › ' + r.submodule_name)))),
        h('div', { class: 'muted small' }, 'If one of these is your problem, open it and add a comment instead of a new report.'),
      ] : []));
    }, 450);
  };
  titleIn.addEventListener('input', checkDupes);
  subSelect.addEventListener('change', checkDupes);

  // ---- Improve my report: AI, only when an admin has switched it on. ----
  const aiRow = h('div', { class: 'ai-row' });
  api('GET', '/api/ai/status').then((st) => {
    if (!st.ready) return;
    const btn = h('button', { class: 'btn ai-btn', type: 'button', onclick: async () => {
      if ((titleIn.value + detailsTa.value).trim().length < 10) return toast('Write a few words about the problem first.', true);
      btn.disabled = true; btn.textContent = 'Improving…';
      try {
        const type = form.querySelector('input[name=type]:checked')?.value || 'bug';
        const r = await api('POST', '/api/ai/improve', { title: titleIn.value, details: detailsTa.value, type, submodule_id: subSelect.value ? Number(subSelect.value) : null });
        showSuggestion(r.suggestion, r.data_location);
      } catch (err) { toast(err.message, true); }
      btn.disabled = false; btn.textContent = '✨ Improve my report';
    } }, '✨ Improve my report');
    aiRow.replaceChildren(btn, h('span', { class: 'muted small' },
      ' Sends only the title and details you typed (never files or names) to TatvaOS AI, processed in ' + st.data_location + '. You check every word before submitting. ' + st.remaining_today + ' left today.'));
  }).catch(() => {});

  const showSuggestion = (sg, where) => {
    const t = h('input', { value: sg.title, maxlength: 200 });
    const d = h('textarea', { rows: 12 }); d.value = sg.details;
    modal('Suggested report — check and edit before using it', h('div', {},
      h('label', {}, h('span', {}, 'Title'), t),
      h('label', {}, h('span', {}, 'Details'), d),
      h('p', { class: 'small' }, 'Type: ', h('b', {}, sg.type === 'bug' ? 'Bug' : 'Feature request'),
        sg.priority ? [' · Priority: ', h('b', {}, cap(sg.priority))] : '',
        sg.area ? [' · Area: ', h('b', {}, sg.area.label)] : ''),
      sg.missing.length ? h('div', { class: 'callout' }, 'Please also answer:', h('ul', {}, sg.missing.map((m) => h('li', {}, m)))) : null,
      h('p', { class: 'muted small' }, 'Written by TatvaOS AI (processed in ' + where + ') from your text. It can be wrong, and it must not add anything that did not happen.')),
      (dlg) => h('button', { class: 'btn primary', type: 'button', onclick: () => {
        titleIn.value = t.value; detailsTa.value = d.value;
        const radio = form.querySelector('input[name=type][value=' + sg.type + ']'); if (radio) radio.checked = true;
        if (sg.priority) prioritySel.value = sg.priority;
        if (sg.area && mods.some((m) => m.id === sg.area.module_id)) {
          modSelect.value = String(sg.area.module_id); modSelect.dispatchEvent(new Event('change'));
          subSelect.value = String(sg.area.submodule_id);
        }
        aiAssisted = true; dlg.close(); checkDupes(); toast('Filled in. Read it through, then submit.');
      } }, 'Use this'));
  };
  const form = h('form', { class: 'card form', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    submit.disabled = true;
    try {
      const r = await api('POST', '/api/issues', {
        module_id: Number(fd.get('module_id')), submodule_id: Number(fd.get('submodule_id')),
        type: fd.get('type'), title: fd.get('title'), details: fd.get('details'), priority: fd.get('priority'),
        ai_assisted: aiAssisted,
      });
      if (files.files.length) await uploadAll(r.id, r.activity_id, [...files.files], status);
      toast(`${r.key} submitted.`);
      location.hash = '#/issue/' + r.id;
    } catch (err) { toast(err.message, true); submit.disabled = false; }
  } },
    h('div', { class: 'grid2' },
      h('label', {}, h('span', {}, '1. Module'), modSelect),
      h('label', {}, h('span', {}, '2. Sub-module'), subSelect)),
    h('fieldset', { class: 'radios' }, h('legend', {}, '3. Type'),
      h('label', {}, h('input', { type: 'radio', name: 'type', value: 'bug', checked: true, required: true }), ' Bug'),
      h('label', {}, h('input', { type: 'radio', name: 'type', value: 'feature' }), ' Feature request')),
    h('label', {}, h('span', {}, '4. Title'), titleIn),
    dupes,
    h('label', {}, h('span', {}, 'Details'), detailsTa),
    aiRow,
    h('div', { class: 'grid2' },
      h('label', {}, h('span', {}, 'Priority'), prioritySel),
      h('label', {}, h('span', {}, 'Attachments (screenshots, screen recordings — up to 100 MB each)'), files)),
    h('p', { class: 'privacy-note' }, '⚠ Do not upload screenshots or recordings that show real customers’ mail or personal data. Crop or blur it first, or describe it in words.'),
    h('p', { class: 'muted small' }, `Reported by ${state.me.user.name} as ${ROLE_LABEL[mode]}.`),
    status,
    h('div', { class: 'row' }, submit, h('a', { class: 'btn', href: '#/' }, 'Cancel')));
  return h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'Create issue')), form);
}

// ---------------------------------------------------------------------------
//  One issue
// ---------------------------------------------------------------------------
const MOVE_LABEL = {
  under_review: 'Start review', more_info: 'Ask for information', under_dev: 'Start development',
  fixed: 'Mark fixed', closed: 'Verify & close', reopened: 'Reopen',
};

async function issueView(id) {
  const { issue: i, activity, can } = await api('GET', '/api/issues/' + id);
  const mode = state.me.mode;
  const refresh = () => render();

  const act = async (payload, files, statusEl) => {
    const r = await api('POST', `/api/issues/${id}/actions`, payload);
    if (files && files.length) await uploadAll(id, r.activity_id, files, statusEl);
    refresh();
  };

  // Status buttons
  const moveButtons = can.moves.map((to) => {
    let label = MOVE_LABEL[to] || state.me.statuses[to];
    if (to === 'closed' && i.status !== 'fixed') label = 'Close without fix';
    if (to === 'reopened' && i.status === 'closed') label = 'Reopen';
    const primary = (to === 'fixed' || to === 'closed') && !(to === 'closed' && i.status !== 'fixed');
    return h('button', { class: 'btn' + (primary ? ' primary' : '') + (to === 'reopened' ? ' warn' : ''), onclick: () => {
      if (to === 'more_info') return requestInfo();
      const needsText = to === 'fixed' || to === 'reopened' || (to === 'closed' && i.status !== 'fixed');
      const fix = h('textarea', { rows: 5, required: true, placeholder: 'What was changed, where, and how to check it' });
      const note = h('textarea', { rows: 3, required: to === 'reopened' || (to === 'closed' && i.status !== 'fixed'), placeholder: to === 'reopened' ? 'What is still wrong?' : to === 'closed' && i.status !== 'fixed' ? 'Why is this being closed without a fix? (duplicate, will not do…)' : 'Note (optional)' });
      const filesIn = h('input', { type: 'file', multiple: true });
      const st = h('p', { class: 'muted small' });
      modal(label + ' — ' + i.key, h('div', {},
        h('p', {}, `${state.me.statuses[i.status]} → ${state.me.statuses[to]}`),
        to === 'fixed' && h('label', {}, h('span', {}, 'Fix details'), fix),
        h('label', {}, h('span', {}, to === 'fixed' ? 'Note to the tester (optional)' : needsText ? 'Reason' : 'Note (optional)'), note),
        (to === 'reopened' || to === 'fixed') && h('label', {}, h('span', {}, 'Files (optional)'), filesIn), st),
      (dlg) => h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try { await act({ action: 'status', to, fix_details: fix.value, body: note.value }, [...filesIn.files], st); dlg.close(); toast('Status changed.'); }
        catch (err) { toast(err.message, true); e.target.disabled = false; }
      } }, label));
    } }, label);
  });

  function requestInfo() {
    const note = h('textarea', { rows: 4, required: true, placeholder: 'What do you need from the tester?' });
    modal('Ask for more information', h('label', {}, h('span', {}, 'Question'), note), (dlg) =>
      h('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try { await act({ action: 'request_info', body: note.value }); dlg.close(); toast('Request sent.'); }
        catch (err) { toast(err.message, true); e.target.disabled = false; }
      } }, 'Send request'));
  }

  // Side panel controls
  let assignCtl = null;
  if (can.assign) {
    const devs = (await people(true)).filter((u) => u.roles.includes('developer') && u.active !== false);
    const sel = h('select', {}, h('option', { value: '' }, '(unassigned)'), devs.map((u) => h('option', { value: u.id, selected: u.id === i.assignee_id }, u.name)));
    assignCtl = h('div', { class: 'inline' }, sel, h('button', { class: 'btn small', onclick: async () => {
      try { await act({ action: 'assign', assignee_id: sel.value ? Number(sel.value) : null }); toast('Assigned.'); } catch (err) { toast(err.message, true); }
    } }, 'Assign'));
  }
  let dueCtl = null;
  if (can.due) {
    const inp = h('input', { type: 'date', value: i.due_date || '' });
    dueCtl = h('div', { class: 'inline' }, inp, h('button', { class: 'btn small', onclick: async () => {
      try { await act({ action: 'due', due_date: inp.value || null }); toast('Due date saved.'); } catch (err) { toast(err.message, true); }
    } }, 'Save'));
  }
  const editBtn = can.edit && h('button', { class: 'btn small', onclick: () => {
    const t = h('input', { value: i.title, maxlength: 200 });
    const d = h('textarea', { rows: 8 }); d.value = i.details;
    const p = h('select', {}, PRIORITIES.map((x) => h('option', { value: x, selected: x === i.priority }, cap(x))));
    modal('Edit ' + i.key, h('div', {}, h('label', {}, h('span', {}, 'Title'), t), h('label', {}, h('span', {}, 'Details'), d), h('label', {}, h('span', {}, 'Priority'), p),
      h('p', { class: 'muted small' }, 'The previous text is kept in the history.')), (dlg) =>
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { await act({ action: 'edit', title: t.value, details: d.value, priority: p.value }); dlg.close(); toast('Saved.'); } catch (err) { toast(err.message, true); }
      } }, 'Save'));
  } }, 'Edit');

  // Comment box
  const cText = h('textarea', { rows: 3, placeholder: i.status === 'more_info' && i.reporter_id === state.me.user.id ? 'Reply with the information requested…' : 'Add a comment…' });
  const cFiles = h('input', { type: 'file', multiple: true });
  const cStatus = h('p', { class: 'muted small' });
  const cBtn = h('button', { class: 'btn primary', onclick: async () => {
    const files = [...cFiles.files];
    if (!cText.value.trim() && !files.length) return toast('Write something or choose a file.', true);
    cBtn.disabled = true;
    try {
      await act(cText.value.trim() ? { action: 'comment', body: cText.value } : { action: 'attach' }, files, cStatus);
      toast('Added.');
    } catch (err) { toast(err.message, true); cBtn.disabled = false; }
  } }, i.status === 'more_info' && i.reporter_id === state.me.user.id ? 'Send reply' : 'Add comment');

  return h('div', { class: 'issue' },
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'mono muted' }, h('a', { href: '#/issues' }, '← Issues'), '  ·  ', i.key),
        h('h1', {}, i.title),
        h('div', { class: 'row' }, typeBadge(i.type), statusBadge(i.status, i.status_label), priorityBadge(i.priority), i.overdue && h('span', { class: 'badge overdue' }, 'Overdue'))),
      h('div', { class: 'row wrap' },
        can.take && h('button', { class: 'btn primary', onclick: async (e) => {
          e.target.disabled = true;
          try { await act({ action: 'assign', assignee_id: state.me.user.id }); toast(`${i.key} is now assigned to you.`); }
          catch (err) { toast(err.message, true); e.target.disabled = false; }
        } }, 'Assign to me'),
        moveButtons, can.request_info && !can.moves.includes('more_info') && h('button', { class: 'btn', onclick: requestInfo }, 'Ask for information'))),
    h('div', { class: 'issue-grid' },
      h('div', {},
        h('section', { class: 'card' }, h('h3', {}, 'Details'), h('div', { class: 'prose' }, i.details)),
        i.fix_details && h('section', { class: 'card fix' }, h('h3', {}, 'Fix details'), h('div', { class: 'prose' }, i.fix_details)),
        h('section', { class: 'card' }, h('h3', {}, 'History'), h('ol', { class: 'timeline' }, activity.map(activityItem))),
        h('section', { class: 'card' }, h('h3', {}, 'Comment'), cText, h('div', { class: 'row between' }, cFiles, cBtn), h('p', { class: 'privacy-note' }, '⚠ Do not upload screenshots or recordings that show real customers’ mail or personal data. Crop or blur it first, or describe it in words.'), cStatus)),
      h('aside', { class: 'card side' },
        field('Module', i.module_name),
        field('Sub-module', i.submodule_name),
        field('Type', i.type === 'bug' ? 'Bug' : 'Feature request'),
        field('Priority', cap(i.priority)),
        field('Reported by', `${i.reporter_name || i.reporter_email} (as ${ROLE_LABEL[i.reporter_role] || i.reporter_role})`),
        field('Developer', assignCtl || (i.assignee_name || i.assignee_email || '—')),
        field('Due date', dueCtl || (i.due_date ? fmtDay(i.due_date) : '—')),
        field('Created', fmtDate(i.created_at)),
        field('Last updated', fmtDate(i.updated_at)),
        i.closed_at && field('Closed', fmtDate(i.closed_at)),
        editBtn && h('div', { class: 'side-actions' }, editBtn),
        h('p', { class: 'muted small' }, `You are working as ${ROLE_LABEL[mode]}.`))));
}

function field(label, value) {
  return h('div', { class: 'field' }, h('div', { class: 'field-l' }, label), h('div', { class: 'field-v' }, value));
}

function activityItem(a) {
  const who = a.actor_name || a.actor_email;
  const role = ROLE_LABEL[a.actor_role] || a.actor_role;
  const st = state.me.statuses;
  const text = {
    created: () => `Created by ${who} · role: ${role}` + (a.meta ? ` · ${a.meta.module} › ${a.meta.submodule}` : '') + (a.meta?.ai_assisted ? ' · written with TatvaOS AI' : ''),
    comment: () => `${who} commented`,
    reply: () => `${who} replied with the information requested`,
    info_request: () => `${who} requested more information`,
    assigned: () => a.meta?.to ? (a.meta.to === who ? `${who} assigned it to themselves` : `${who} assigned it to ${a.meta.to}`) : `${who} removed the developer`,
    status: () => `${who} changed status: ${st[a.from_status]} → ${st[a.to_status]}`,
    fixed: () => `${who} added fix details and marked it Fixed`,
    closed: () => a.meta?.closed_without_fix ? `${who} closed it without a fix` : `${who} verified the fix and closed it`,
    reopened: () => `${who} reopened it: ${st[a.from_status]} → Reopened`,
    due: () => a.meta?.to ? `${who} set the due date to ${fmtDay(a.meta.to)}` : `${who} removed the due date`,
    edited: () => {
      const m = a.meta || {};
      const short = ['priority', 'type'].filter((k) => m[k]).map((k) => `${k} ${k === 'type' ? (m[k].from === 'bug' ? 'Bug' : 'Feature') : cap(m[k].from)} → ${k === 'type' ? (m[k].to === 'bug' ? 'Bug' : 'Feature') : cap(m[k].to)}`);
      const long = ['title', 'details'].filter((k) => m[k]);
      return `${who} changed ` + [...short, ...long].join(', ');
    },
    attachment: () => `${who} added files`,
  }[a.kind] || (() => `${who}: ${a.kind}`);
  const edits = a.kind === 'edited' && a.meta && h('details', { class: 'small' }, h('summary', {}, 'Show previous values'),
    Object.entries(a.meta).map(([k, v]) => h('div', { class: 'prev' }, h('b', {}, cap(k) + ' was: '), String(v.from))));
  return h('li', { class: 'ev ev-' + a.kind },
    h('div', { class: 'ev-head' }, h('span', {}, text(), a.kind !== 'created' && h('span', { class: 'muted' }, ' · as ' + role)), h('span', { class: 'muted nowrap' }, fmtDate(a.at))),
    a.body && h('div', { class: 'prose ev-body' }, a.body),
    edits,
    a.files.length ? h('div', { class: 'files' }, a.files.map(fileView)) : null);
}

function fileView(f) {
  const url = '/api/attachments/' + f.id;
  if (f.mime.startsWith('image/')) return h('a', { class: 'file thumb', href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: f.name, loading: 'lazy' }), h('span', {}, f.name));
  if (f.mime.startsWith('video/')) return h('div', { class: 'file vid' }, h('video', { src: url, controls: true, preload: 'metadata' }), h('a', { href: url + '?download=1' }, f.name, ' · ', fmtSize(f.size)));
  return h('a', { class: 'file doc', href: url + '?download=1' }, '📎 ', f.name, ' · ', fmtSize(f.size));
}

// ---------------------------------------------------------------------------
//  Modules
// ---------------------------------------------------------------------------
async function modulesView() {
  const mods = await modules(true);
  const refresh = async () => { await modules(true); render(); };
  const run = async (fn, ok) => { try { await fn(); if (ok) toast(ok); await refresh(); } catch (e) { toast(e.message, true); } };

  const editDialog = (kind, item, save) => {
    const n = h('input', { value: item?.name || '', maxlength: 80, required: true });
    const d = h('textarea', { rows: 3 }); d.value = item?.description || '';
    const a = h('input', { type: 'checkbox', checked: item ? item.active : true });
    modal((item ? 'Edit ' : 'Add ') + kind, h('div', {},
      h('label', {}, h('span', {}, kind + ' name'), n),
      h('label', {}, h('span', {}, 'Description (optional)'), d),
      h('label', { class: 'check' }, a, ' Active')), (dlg) =>
      h('button', { class: 'btn primary', type: 'button', onclick: () => run(async () => { await save({ name: n.value, description: d.value, active: a.checked }); dlg.close(); }, 'Saved.') }, 'Save'));
  };

  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Modules'), h('p', { class: 'muted' }, 'The product structure testers choose from. A module or sub-module with reports cannot be deleted — deactivate it instead, and old reports keep it.')),
      h('button', { class: 'btn primary', onclick: () => editDialog('Module', null, (b) => api('POST', '/api/modules', b)) }, '+ Add module')),
    mods.length ? mods.map((m) => h('section', { class: 'card module' + (m.active ? '' : ' inactive') },
      h('div', { class: 'row between' },
        h('div', {}, h('h3', {}, m.name, !m.active && h('span', { class: 'badge off' }, 'Inactive')), m.description && h('p', { class: 'muted small' }, m.description), h('p', { class: 'muted small' }, `${m.issue_count} report${m.issue_count === 1 ? '' : 's'}`)),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => editDialog('Module', m, (b) => api('PATCH', '/api/modules/' + m.id, b)) }, 'Edit'),
          h('button', { class: 'btn small', onclick: () => run(() => api('PATCH', '/api/modules/' + m.id, { active: !m.active }), m.active ? 'Deactivated.' : 'Activated.') }, m.active ? 'Deactivate' : 'Activate'),
          h('button', { class: 'btn small danger', disabled: m.issue_count > 0, title: m.issue_count ? 'Has reports — deactivate instead' : '', onclick: () => { if (confirm(`Delete module "${m.name}" and its sub-modules?`)) run(() => api('DELETE', '/api/modules/' + m.id), 'Deleted.'); } }, 'Delete'))),
      h('table', { class: 'subs' }, h('tbody', {},
        m.submodules.map((s) => h('tr', { class: s.active ? '' : 'inactive' },
          h('td', {}, s.name, !s.active && h('span', { class: 'badge off' }, 'Inactive')),
          h('td', { class: 'muted small' }, s.description),
          h('td', { class: 'muted small nowrap' }, `${s.issue_count} report${s.issue_count === 1 ? '' : 's'}`),
          h('td', { class: 'nowrap right' },
            h('button', { class: 'btn small', onclick: () => editDialog('Sub-module', s, (b) => api('PATCH', '/api/submodules/' + s.id, b)) }, 'Edit'),
            h('button', { class: 'btn small', onclick: () => run(() => api('PATCH', '/api/submodules/' + s.id, { active: !s.active }), s.active ? 'Deactivated.' : 'Activated.') }, s.active ? 'Deactivate' : 'Activate'),
            h('button', { class: 'btn small danger', disabled: s.issue_count > 0, onclick: () => { if (confirm(`Delete sub-module "${s.name}"?`)) run(() => api('DELETE', '/api/submodules/' + s.id), 'Deleted.'); } }, 'Delete')))))),
      h('button', { class: 'btn small', onclick: () => editDialog('Sub-module', null, (b) => api('POST', '/api/submodules', { ...b, module_id: m.id })) }, '+ Add sub-module to ' + m.name)))
      : h('div', { class: 'empty' }, 'No modules yet. Add the first one — for example "TatvaOS Mail" with Inbox, Sent, Draft, Compose and Search.'));
}

// ---------------------------------------------------------------------------
//  Users
// ---------------------------------------------------------------------------
async function usersView() {
  const users = await people(true);
  const run = async (fn, ok) => { try { await fn(); toast(ok); await people(true); render(); } catch (e) { toast(e.message, true); } };
  const email = h('input', { type: 'email', required: true, placeholder: 'name@techvein.com' });
  const name = h('input', { placeholder: 'Name' });
  const boxes = ['admin', 'developer', 'tester'].map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: r, checked: r === 'tester' }), ' ' + ROLE_LABEL[r]));
  const add = h('form', { class: 'card form row wrap', onsubmit: (e) => {
    e.preventDefault();
    run(() => api('POST', '/api/users', { email: email.value, name: name.value, roles: boxes.map((b) => b.querySelector('input')).filter((b) => b.checked).map((b) => b.value) }), 'Added. They can sign in with their TatvaOS account now.');
  } }, email, name, boxes, h('button', { class: 'btn primary', type: 'submit' }, 'Add person'));

  return h('div', {},
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Users & roles'), h('p', { class: 'muted' }, 'Add people by their TatvaOS email. One account can hold any mix of Admin, Developer and Tester; they switch with "Working as" at the top.'))),
    add,
    h('div', { class: 'table-wrap' }, h('table', { class: 'issues users cards' },
      h('thead', {}, h('tr', {}, ['Name', 'Email', 'Admin', 'Developer', 'Tester', 'Signed in', 'Status', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, users.map((u) => {
        const cb = (r) => h('input', { type: 'checkbox', checked: u.roles.includes(r), onchange: (e) => {
          const roles = new Set(u.roles); e.target.checked ? roles.add(r) : roles.delete(r);
          run(() => api('PATCH', '/api/users/' + u.id, { roles: [...roles] }), 'Roles saved.');
        } });
        return h('tr', { class: u.active ? '' : 'inactive' },
          h('td', {}, u.name),
          h('td', { class: 'muted', 'data-label': 'Email' }, u.email),
          h('td', { class: 'center', 'data-label': 'Admin' }, cb('admin')), h('td', { class: 'center', 'data-label': 'Developer' }, cb('developer')), h('td', { class: 'center', 'data-label': 'Tester' }, cb('tester')),
          h('td', { class: 'muted small nowrap', 'data-label': 'Signed in' }, u.last_seen_at ? fmtDate(u.last_seen_at) : 'Not yet'),
          h('td', { 'data-label': 'Status' }, u.active ? 'Active' : h('span', { class: 'badge off' }, 'Disabled')),
          h('td', { class: 'nowrap right' },
            h('button', { class: 'btn small', onclick: () => { const n = prompt('Name', u.name); if (n !== null) run(() => api('PATCH', '/api/users/' + u.id, { name: n }), 'Saved.'); } }, 'Rename'),
            h('button', { class: 'btn small' + (u.active ? ' danger' : ''), onclick: () => run(() => api('PATCH', '/api/users/' + u.id, { active: !u.active }), u.active ? 'Disabled.' : 'Enabled.') }, u.active ? 'Disable' : 'Enable')));
      })))));
}

// ---------------------------------------------------------------------------
//  Reports
// ---------------------------------------------------------------------------
const REPORTS = [
  ['bug', 'Bug report', 'module', 'type=bug'],
  ['feature', 'Feature report', 'module', 'type=feature'],
  ['developer', 'Developer report', 'developer', ''],
  ['tester', 'Tester report', 'tester', ''],
  ['module', 'Module / Sub-module report', 'submodule', ''],
  ['priority', 'Priority report', 'priority', ''],
];

async function reportsView(params) {
  const which = REPORTS.find((r) => r[0] === params.get('r')) || REPORTS[0];
  const q = new URLSearchParams(params); q.delete('r');
  if (which[3]) { const [k, v] = which[3].split('='); q.set(k, v); }
  q.set('group', which[2]);
  const rows = await api('GET', '/api/reports?' + q);
  const st = state.me.statuses;
  const totals = rows.reduce((t, r) => { for (const k of ['total', ...STATUS_ORDER]) t[k] = (t[k] || 0) + r[k]; return t; }, {});
  const keep = new URLSearchParams(params); keep.delete('r');
  return h('div', {},
    h('div', { class: 'page-head' }, h('h1', {}, 'Reports')),
    h('div', { class: 'tabs' }, REPORTS.map(([k, label]) => h('a', { class: k === which[0] ? 'active' : '', href: '#/reports?r=' + k }, label))),
    await filterBar(new URLSearchParams([...keep]), '/reports', { full: true }).then((f) => { f.querySelector('form').append(h('input', { type: 'hidden', name: 'r', value: which[0] })); return f; }),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'issues report' },
      h('thead', {}, h('tr', {}, h('th', {}, which[2] === 'submodule' ? 'Module › Sub-module' : cap(which[2])), h('th', {}, 'Total'), STATUS_ORDER.map((s) => h('th', {}, st[s])))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, cap(r.label)), h('td', { class: 'num' }, h('b', {}, r.total)), STATUS_ORDER.map((s) => h('td', { class: 'num' + (r[s] ? '' : ' muted') }, r[s]))))),
      h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), h('td', { class: 'num' }, h('b', {}, totals.total || 0)), STATUS_ORDER.map((s) => h('td', { class: 'num' }, totals[s] || 0))))))
      : h('div', { class: 'empty' }, 'Nothing to report yet.'));
}

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------
async function settingsView() {
  const me = state.me;
  const isAdmin = me.user.roles.includes('admin');
  const daily = h('input', { type: 'checkbox', checked: me.prefs.daily_summary });
  const adminSum = h('input', { type: 'checkbox', checked: me.prefs.admin_summary });
  const mine = h('section', { class: 'card form' }, h('h3', {}, 'My emails'),
    h('p', { class: 'muted small' }, 'You are emailed straight away when something happens on an issue you reported or are working on.'),
    h('label', { class: 'check' }, daily, ' Send me a daily summary (9:00 India time)'),
    isAdmin && h('label', { class: 'check' }, adminSum, ' Also send me the overall admin summary'),
    h('div', {}, h('button', { class: 'btn primary', onclick: async () => {
      try { await api('POST', '/api/me/prefs', { daily_summary: daily.checked, admin_summary: adminSum.checked }); await loadMe(); toast('Saved.'); } catch (e) { toast(e.message, true); }
    } }, 'Save')));
  if (!isAdmin || me.mode !== 'admin') return h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), mine, isAdmin && h('p', { class: 'muted' }, 'Switch to Admin to set up email sending.'));

  const s = await api('GET', '/api/settings');
  const from = h('input', { type: 'email', value: s.mail_from, placeholder: 'bugs@techvein.com' });
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: s.mail_api_key_set ? 'A key is saved — paste a new one to replace it' : 'tvos_…' });
  const result = h('p', { class: 'small' });
  const mailCard = h('section', { class: 'card form' }, h('h3', {}, 'Email sending'),
    h('p', { class: 'muted small' }, 'Emails go out through TatvaOS Mail. In TatvaOS (Organisation → API keys → Mail API) create a NEW key used only by this tracker, allowed to send only from the address below, and paste it here. Never reuse a key another system uses: if this one leaks it can then only send as the tracker, and revoking it breaks nothing else. The key is never shown again.'),
    h('label', {}, h('span', {}, 'Send from'), from),
    h('label', {}, h('span', {}, 'Mail API key ' + (s.mail_api_key_set ? '(saved)' : '(not set)')), key),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('PUT', '/api/settings', { mail_from: from.value, mail_api_key: key.value || undefined }); key.value = ''; toast('Saved.'); await loadMe(); render(); } catch (e) { toast(e.message, true); }
      } }, 'Save'),
      h('button', { class: 'btn', onclick: async () => {
        result.textContent = 'Sending…';
        try { const r = await api('POST', '/api/settings/test-mail'); result.textContent = r.ok ? `Sent to ${me.user.email}. Check your inbox.` : 'Not sent: ' + r.detail; } catch (e) { result.textContent = e.message; }
      } }, 'Send me a test email'),
      h('button', { class: 'btn', onclick: async () => {
        try { const r = await api('POST', '/api/settings/send-summaries'); toast(`${r.queued} summaries queued.`); } catch (e) { toast(e.message, true); }
      } }, 'Send daily summaries now')),
    result);
  const log = h('section', { class: 'card' }, h('h3', {}, 'Recent emails'),
    s.mail_log.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'issues' }, h('tbody', {}, s.mail_log.map((l) => h('tr', {},
      h('td', { class: 'nowrap muted small' }, fmtDate(l.at)), h('td', {}, l.user_name || l.user_email || ''), h('td', {}, l.subject),
      h('td', {}, l.ok ? h('span', { class: 'badge st-closed' }, 'Sent') : h('span', { class: 'badge st-reopened', title: l.detail }, 'Failed')), h('td', { class: 'muted small' }, l.ok ? '' : l.detail)))))) : h('p', { class: 'muted' }, 'None yet.'));
  const st = s.storage; const pct = Math.min(100, Math.round((st.used / st.limit) * 100));
  const storageCard = h('section', { class: 'card' }, h('h3', {}, 'File storage'),
    h('p', {}, `${fmtSize(st.used)} of ${fmtSize(st.limit)} used (${pct}%).`),
    h('div', { class: 'meter' }, h('div', { class: 'meter-fill' + (pct >= 90 ? ' full' : ''), style: null, 'data-pct': pct })),
    h('p', { class: 'muted small' }, 'Screenshots and recordings share this budget. When it is full, new files are refused with a message; reports and comments still work.'));
  const fill = storageCard.querySelector('.meter-fill'); fill.style.width = pct + '%';
  // ---- AI: "Improve my report". Off until an admin turns it on. ----
  const ai = s.ai;
  const aiOn = h('input', { type: 'checkbox', checked: ai.enabled });
  const aiUrl = h('input', { value: ai.base_url, placeholder: 'The TatvaOS AI address you were given' });
  const aiModel = h('input', { value: ai.model, placeholder: 'The model name you were given' });
  const aiLoc = h('input', { value: ai.data_location, placeholder: 'e.g. United States' });
  const aiLimit = h('input', { type: 'number', min: 0, max: 10000, value: ai.daily_limit });
  const aiKey = h('input', { type: 'password', autocomplete: 'off', placeholder: ai.key_set ? 'A key is saved — paste a new one to replace it' : 'Paste the key' });
  const aiCard = h('section', { class: 'card form' }, h('h3', {}, 'TatvaOS AI: Improve my report'),
    h('p', { class: 'muted small' }, 'When on, testers get an "Improve my report" button. It sends only the title and details they typed (never files, names or other issues) to TatvaOS AI, and they check every word before submitting. Use a key made only for this tracker.'),
    h('p', { class: ai.ready ? 'small' : 'small warn-text' }, ai.ready ? 'Ready. Used ' + ai.used_today + ' of ' + ai.daily_limit + ' times today.' : 'Not in use: ' + ai.problem),
    h('label', { class: 'check' }, aiOn, ' Turn on Improve my report'),
    h('div', { class: 'grid2' },
      h('label', {}, h('span', {}, 'TatvaOS AI address'), aiUrl),
      h('label', {}, h('span', {}, 'Model name'), aiModel)),
    h('div', { class: 'grid2' },
      h('label', {}, h('span', {}, 'Where the data goes (shown to testers)'), aiLoc),
      h('label', {}, h('span', {}, 'Uses per day, whole team'), aiLimit)),
    h('label', {}, h('span', {}, 'TatvaOS AI key ' + (ai.key_set ? '(saved)' : '(not set)')), aiKey),
    h('div', {}, h('button', { class: 'btn primary', onclick: async () => {
      try {
        await api('PUT', '/api/settings', { ai: { enabled: aiOn.checked, base_url: aiUrl.value, model: aiModel.value, data_location: aiLoc.value, daily_limit: Number(aiLimit.value), api_key: aiKey.value || undefined } });
        aiKey.value = ''; toast('Saved.'); render();
      } catch (e) { toast(e.message, true); }
    } }, 'Save TatvaOS AI settings')));
  return h('div', {}, h('div', { class: 'page-head' }, h('h1', {}, 'Settings')), mine, mailCard, aiCard, storageCard, log);
}

// ---------------------------------------------------------------------------
loadMe().then(render);
