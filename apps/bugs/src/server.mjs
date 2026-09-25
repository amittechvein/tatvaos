// TatvaOS Bugs — bug.tatvaos.com
//
// Techvein's own tracker for TatvaOS bugs and feature requests (requirement
// document v1.1, 25 Sept 2026). A small separate app, NOT part of the product:
// its own container, its own SQLite file, sign-in through "Sign in with
// TatvaOS" (the OIDC provider, decision 0004). Nothing here reads or writes the
// product database.
//
// Zero npm dependencies: node:http, node:sqlite, node:crypto, fetch.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, now, tx, getSetting, setSetting, issueKey, STATUSES, STATUS_LABEL, PRIORITIES, TYPES, ROLES } from './db.mjs';
import { createMailer } from './mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');

const cfg = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || path.join(HERE, '..', '.data'),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  issuer: process.env.OIDC_ISSUER || 'https://core.tatvaos.com/',
  clientId: process.env.OIDC_CLIENT_ID || '',
  clientSecret: process.env.OIDC_CLIENT_SECRET || '',
  bootstrapAdmins: (process.env.BOOTSTRAP_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  mailApiUrl: process.env.MAIL_API_URL || 'https://core.tatvaos.com/api/v1/mail/send',
  maxUpload: Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024,
  // Local testing only. Three conditions, all required: the flag, a loopback
  // PUBLIC_URL, and a loopback caller. Production has none of the three.
  devLogin: process.env.DEV_LOGIN === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(process.env.PUBLIC_URL || 'http://localhost:3000'),
};
const secureCookies = cfg.publicUrl.startsWith('https://');
const ORIGIN = new URL(cfg.publicUrl).origin;

const db = openDb(cfg.dataDir);
const mailer = createMailer(db, cfg);
const FILES = path.join(cfg.dataDir, 'files');

// ============================================================================
//  HTTP helpers
// ============================================================================

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'You do not have access to that.') => new HttpError(403, m);
const notFound = (m = 'Not found.') => new HttpError(404, m);

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw bad('Request too large.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Request is not valid JSON.'); }
}

const str = (v, max, field, required = false) => {
  const s = (v ?? '').toString().trim();
  if (required && !s) throw bad(`${field} is required.`);
  if (s.length > max) throw bad(`${field} is too long (max ${max} characters).`);
  return s;
};
const int = (v) => (v === null || v === undefined || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

// ============================================================================
//  Sessions and roles
// ============================================================================

const SESSION_DAYS = 30;

function rolesOf(u) {
  return ROLES.filter((r) => u['is_' + r]);
}

function defaultMode(u) {
  return rolesOf(u)[0] || 'tester';
}

function createSession(res, user) {
  const id = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(id, user_id, mode, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(id, user.id, defaultMode(user), now(), new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), user.id);
  res.setHeader('Set-Cookie', cookie('bt_session', id, SESSION_DAYS * 86400));
}

function currentSession(req) {
  const id = parseCookies(req).bt_session;
  if (!id) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, now());
  if (!s) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(s.user_id);
  if (!user || !rolesOf(user).length) return null;
  // A role taken away while signed in takes effect on the next request.
  let mode = s.mode;
  if (!user['is_' + mode]) {
    mode = defaultMode(user);
    db.prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(mode, s.id);
  }
  return { id: s.id, user, mode };
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name || u.email, roles: rolesOf(u), active: !!u.active };
}

// ============================================================================
//  Sign in with TatvaOS (authorization code + PKCE)
// ============================================================================

let discovery = null;
async function getDiscovery() {
  if (discovery) return discovery;
  const url = cfg.issuer.replace(/\/?$/, '/') + '.well-known/openid-configuration';
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new HttpError(502, 'TatvaOS sign-in is not reachable right now.');
  discovery = await res.json();
  return discovery;
}

const redirectUri = () => cfg.publicUrl + '/auth/callback';

async function authLogin(req, res) {
  if (!cfg.clientId) throw new HttpError(503, 'Sign-in is not configured yet (OIDC_CLIENT_ID).');
  const d = await getDiscovery();
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  db.prepare("DELETE FROM login_states WHERE created_at < ?").run(new Date(Date.now() - 15 * 60000).toISOString());
  db.prepare('INSERT INTO login_states(state, verifier, nonce, created_at) VALUES (?,?,?,?)').run(state, verifier, nonce, now());
  const q = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: redirectUri(),
    scope: 'openid profile email', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  res.writeHead(302, { Location: d.authorization_endpoint + '?' + q, 'Set-Cookie': cookie('bt_state', state, 900), 'Cache-Control': 'no-store' });
  res.end();
}

function decodeJwtPayload(jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

async function authCallback(req, res, url) {
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  const cookieState = parseCookies(req).bt_state || '';
  if (url.searchParams.get('error')) return messagePage(res, 'Sign-in was cancelled', 'You did not finish signing in with TatvaOS.');
  if (!state || !code || state !== cookieState) return messagePage(res, 'Sign-in expired', 'That sign-in link is no longer valid. Please try again.');
  const row = db.prepare('SELECT * FROM login_states WHERE state = ?').get(state);
  db.prepare('DELETE FROM login_states WHERE state = ?').run(state);
  if (!row) return messagePage(res, 'Sign-in expired', 'That sign-in link is no longer valid. Please try again.');

  const d = await getDiscovery();
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: cfg.clientId, code_verifier: row.verifier });
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  const tokRes = await fetch(d.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15000) });
  if (!tokRes.ok) {
    console.warn('token exchange failed', tokRes.status);
    return messagePage(res, 'Sign-in failed', 'TatvaOS did not accept the sign-in. Please try again.');
  }
  const tok = await tokRes.json();

  // The id_token came straight from the token endpoint over TLS, so its
  // issuer is already proven (OIDC Core 3.1.3.7); we still check audience,
  // issuer and nonce so a token minted for another application is refused.
  const idt = decodeJwtPayload(tok.id_token);
  const aud = idt && (Array.isArray(idt.aud) ? idt.aud : [idt.aud]);
  if (!idt || idt.nonce !== row.nonce || !aud.includes(cfg.clientId) || String(idt.iss).replace(/\/$/, '') !== d.issuer.replace(/\/$/, '')) {
    return messagePage(res, 'Sign-in failed', 'The sign-in answer did not match this application.');
  }
  const uiRes = await fetch(d.userinfo_endpoint, { headers: { Authorization: 'Bearer ' + tok.access_token }, signal: AbortSignal.timeout(15000) });
  if (!uiRes.ok) return messagePage(res, 'Sign-in failed', 'Could not read your TatvaOS profile.');
  const info = await uiRes.json();
  if (!info.sub || info.sub !== idt.sub) return messagePage(res, 'Sign-in failed', 'The sign-in answer did not match this application.');

  const user = linkUser(info);
  if (!user) {
    return messagePage(res, 'You are not on the tracker yet',
      `You signed in as ${info.email || 'an account without an email'}, but that account has not been added to TatvaOS Bugs. Ask an admin to add you under Users.`);
  }
  createSession(res, user);
  res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
  res.end();
}

// Find the tracker user for a TatvaOS identity. A person is matched by the
// stable subject once linked; the FIRST sign-in links by email, and only when
// TatvaOS vouches that the email is verified.
function linkUser(info) {
  let user = db.prepare('SELECT * FROM users WHERE sub = ?').get(info.sub);
  const email = (info.email || '').trim().toLowerCase();
  if (!user && email && info.email_verified === true) {
    user = db.prepare('SELECT * FROM users WHERE email = ? AND sub IS NULL').get(email);
    if (user) db.prepare('UPDATE users SET sub = ?, name = CASE WHEN name = \'\' THEN ? ELSE name END WHERE id = ?').run(info.sub, info.name || '', user.id);
    else if (cfg.bootstrapAdmins.includes(email) && !db.prepare('SELECT 1 FROM users WHERE is_admin = 1 AND active = 1').get()) {
      // Bootstrap: only while the tracker has no admin at all.
      const r = db.prepare('INSERT INTO users(sub, email, name, is_admin, is_developer, is_tester, admin_summary, created_at) VALUES (?,?,?,1,1,1,1,?)')
        .run(info.sub, email, info.name || '', now());
      user = { id: Number(r.lastInsertRowid) };
    }
    if (user) user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  if (!user || !user.active || !rolesOf(user).length) return null;
  return user;
}

function messagePage(res, title, text) {
  const e = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  send(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TatvaOS Bugs</title><link rel="stylesheet" href="/style.css"></head>
<body class="signin"><main class="signin-card"><div class="brand-mark">TV</div><h1>${e(title)}</h1><p>${e(text)}</p><a class="btn primary" href="/auth/login">Sign in with TatvaOS</a></main></body></html>`, securityHeaders());
}

// ============================================================================
//  Issue access and the status flow
// ============================================================================

function canSee(user, issue) {
  return !!(user.is_admin || issue.reporter_id === user.id || (user.is_developer && issue.assignee_id === user.id));
}

// What the person may do in their CURRENT mode. Admin mode can do everything
// a developer or tester can on any issue; developer mode works on issues
// assigned to them; tester mode verifies the reports they filed.
function actsAsDeveloper(s, issue) {
  return s.mode === 'admin' || (s.mode === 'developer' && issue.assignee_id === s.user.id);
}
function actsAsTester(s, issue) {
  return s.mode === 'admin' || (s.mode === 'tester' && issue.reporter_id === s.user.id);
}

const DEV_FLOW = {
  pending: ['under_review', 'under_dev', 'more_info'],
  under_review: ['more_info', 'under_dev'],
  more_info: ['under_review', 'under_dev'],
  under_dev: ['more_info', 'fixed'],
  reopened: ['under_review', 'under_dev'],
  fixed: [],
  closed: [],
};
const TESTER_FLOW = { fixed: ['closed', 'reopened'] };

function allowedMoves(s, issue) {
  const out = new Set();
  if (actsAsDeveloper(s, issue)) (DEV_FLOW[issue.status] || []).forEach((x) => out.add(x));
  if (actsAsTester(s, issue)) (TESTER_FLOW[issue.status] || []).forEach((x) => out.add(x));
  // Admins may reopen a closed issue, and may close an open one that will not
  // be worked on (a duplicate, a declined feature) — with a reason, recorded.
  if (s.mode === 'admin') {
    if (issue.status === 'closed') out.add('reopened');
    else out.add('closed');
  }
  return [...out];
}

function loadIssue(id) {
  return db.prepare(`
    SELECT i.*, m.name module_name, sm.name submodule_name,
           r.name reporter_name, r.email reporter_email,
           a.name assignee_name, a.email assignee_email
      FROM issues i
      JOIN modules m ON m.id = i.module_id
      JOIN submodules sm ON sm.id = i.submodule_id
      JOIN users r ON r.id = i.reporter_id
 LEFT JOIN users a ON a.id = i.assignee_id
     WHERE i.id = ?`).get(id);
}

function addActivity(issueId, s, kind, fields = {}) {
  const r = db.prepare('INSERT INTO activity(issue_id, at, actor_id, actor_role, kind, from_status, to_status, body, meta) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(issueId, now(), s.user.id, s.mode, kind, fields.from ?? null, fields.to ?? null, fields.body ?? '', fields.meta ? JSON.stringify(fields.meta) : null);
  return Number(r.lastInsertRowid);
}

const todayIst = () => mailer.istDate();

function presentIssue(i) {
  return {
    ...i,
    key: issueKey(i.id),
    status_label: STATUS_LABEL[i.status],
    overdue: !!(i.due_date && i.due_date < todayIst() && !['fixed', 'closed'].includes(i.status)),
  };
}

// The list a person sees in their current mode, plus filters.
function issueQuery(s, q, { scopeMine = false } = {}) {
  const where = [];
  const p = [];
  if (s.mode === 'admin') {
    if (scopeMine) { where.push('(i.assignee_id = ? OR i.reporter_id = ?)'); p.push(s.user.id, s.user.id); }
  } else if (s.mode === 'developer') {
    where.push('i.assignee_id = ?'); p.push(s.user.id);
  } else {
    where.push('i.reporter_id = ?'); p.push(s.user.id);
  }
  const eq = (col, v) => { if (v !== null && v !== undefined && v !== '') { where.push(`${col} = ?`); p.push(v); } };
  eq('i.module_id', int(q.get('module')));
  eq('i.submodule_id', int(q.get('submodule')));
  if (TYPES.includes(q.get('type'))) eq('i.type', q.get('type'));
  if (PRIORITIES.includes(q.get('priority'))) eq('i.priority', q.get('priority'));
  if (STATUSES.includes(q.get('status'))) eq('i.status', q.get('status'));
  if (q.get('assignee') === 'none') where.push('i.assignee_id IS NULL');
  else eq('i.assignee_id', int(q.get('assignee')));
  eq('i.reporter_id', int(q.get('reporter')));
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '')) { where.push('i.created_at >= ?'); p.push(q.get('from')); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '')) { where.push('i.created_at < ?'); p.push(new Date(Date.parse(q.get('to')) + 864e5).toISOString().slice(0, 10)); }
  if (q.get('overdue') === '1') { where.push("i.due_date IS NOT NULL AND i.due_date < ? AND i.status NOT IN ('fixed','closed')"); p.push(todayIst()); }
  const text = (q.get('q') || '').trim();
  if (text) {
    const m = /^tv-?0*(\d+)$/i.exec(text);
    if (m) { where.push('i.id = ?'); p.push(Number(m[1])); }
    else { where.push('(i.title LIKE ? OR i.details LIKE ?)'); p.push('%' + text + '%', '%' + text + '%'); }
  }
  for (const v of p) if (Number.isNaN(v)) throw bad('A filter value is not valid.');
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params: p };
}

// ============================================================================
//  Attachments
// ============================================================================

// The stored type comes from the file's own bytes, never from what the browser
// claimed. Only these are shown inline; everything else downloads.
function sniff(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('474946383')) return 'image/gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  return 'application/octet-stream';
}

async function uploadAttachment(req, res, s, issueId, url) {
  const issue = loadIssue(issueId);
  if (!issue || !canSee(s.user, issue)) throw notFound();
  const activityId = int(url.searchParams.get('activity'));
  const act = activityId && db.prepare('SELECT * FROM activity WHERE id = ? AND issue_id = ?').get(activityId, issueId);
  // Files attach to an entry the SAME person just wrote, so an attachment can
  // never be slipped under someone else's comment.
  if (!act || act.actor_id !== s.user.id || Date.parse(act.at) < Date.now() - 3600e3) throw bad('Attach files to your own new entry.');
  const name = str(url.searchParams.get('name'), 200, 'File name', true).replace(/[\\/\u0000-\u001f]/g, '_');
  const len = Number(req.headers['content-length'] || 0);
  if (len > cfg.maxUpload) throw new HttpError(413, `Files can be up to ${cfg.maxUpload / 1048576} MB.`);

  const stored = crypto.randomBytes(16).toString('hex');
  const full = path.join(FILES, stored);
  const out = fs.createWriteStream(full, { flags: 'wx' });
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > cfg.maxUpload) throw new HttpError(413, `Files can be up to ${cfg.maxUpload / 1048576} MB.`);
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16)]);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    fs.rmSync(full, { force: true });
    throw e;
  }
  if (!size) { fs.rmSync(full, { force: true }); throw bad('The file is empty.'); }
  const mime = sniff(head);
  const r = db.prepare('INSERT INTO attachments(issue_id, activity_id, name, mime, size, stored, uploaded_by, at) VALUES (?,?,?,?,?,?,?,?)')
    .run(issueId, activityId, name, mime, size, stored, s.user.id, now());
  send(res, 201, { id: Number(r.lastInsertRowid), name, mime, size });
}

function serveAttachment(req, res, s, id) {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  const issue = a && loadIssue(a.issue_id);
  if (!a || !issue || !canSee(s.user, issue)) throw notFound();
  const full = path.join(FILES, a.stored);
  const stat = fs.statSync(full);
  // Pictures and recordings open in the browser; everything else (PDFs
  // included: Chrome's viewer refuses a sandboxed response) downloads.
  const inline = /^(image|video)\//.test(a.mime);
  const headers = {
    'Content-Type': a.mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    'Cache-Control': 'private, max-age=3600',
    'Accept-Ranges': 'bytes',
  };
  if (new URL(req.url, ORIGIN).searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`;
  // Range, so a screen recording can be scrubbed rather than downloaded whole.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : stat.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : stat.size - 1;
    start = Math.max(0, start); end = Math.min(end, stat.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(full).pipe(res);
}

// ============================================================================
//  API
// ============================================================================

const requireMode = (s, ...modes) => { if (!modes.includes(s.mode)) throw forbidden(`Switch to ${modes.join(' or ')} mode to do that.`); };
const requireAdmin = (s) => requireMode(s, 'admin');

const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, pattern, handler, auth });

// ---- Me --------------------------------------------------------------------
route('GET', /^\/api\/me$/, (req, res, s) => send(res, 200, {
  user: publicUser(s.user), mode: s.mode,
  prefs: { daily_summary: !!s.user.daily_summary, admin_summary: !!s.user.admin_summary },
  mail_configured: mailer.configured(),
  statuses: STATUS_LABEL,
}));

route('POST', /^\/api\/me\/mode$/, async (req, res, s) => {
  const { mode } = await readJson(req);
  if (!ROLES.includes(mode) || !s.user['is_' + mode]) throw forbidden('You do not have that role.');
  db.prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(mode, s.id);
  send(res, 200, { mode });
});

route('POST', /^\/api\/me\/prefs$/, async (req, res, s) => {
  const b = await readJson(req);
  db.prepare('UPDATE users SET daily_summary = ?, admin_summary = ? WHERE id = ?')
    .run(b.daily_summary ? 1 : 0, s.user.is_admin && b.admin_summary ? 1 : 0, s.user.id);
  send(res, 200, { ok: true });
});

// ---- Modules ---------------------------------------------------------------
route('GET', /^\/api\/modules$/, (req, res, s) => {
  const mods = db.prepare('SELECT m.*, (SELECT COUNT(*) FROM issues i WHERE i.module_id = m.id) issue_count FROM modules m ORDER BY m.name').all();
  const subs = db.prepare('SELECT s.*, (SELECT COUNT(*) FROM issues i WHERE i.submodule_id = s.id) issue_count FROM submodules s ORDER BY s.name').all();
  send(res, 200, mods.map((m) => ({ ...m, active: !!m.active, submodules: subs.filter((x) => x.module_id === m.id).map((x) => ({ ...x, active: !!x.active })) })));
});

route('POST', /^\/api\/modules$/, async (req, res, s) => {
  requireAdmin(s);
  const b = await readJson(req);
  const name = str(b.name, 80, 'Module name', true);
  if (db.prepare('SELECT 1 FROM modules WHERE name = ?').get(name)) throw bad('A module with that name already exists.');
  const r = db.prepare('INSERT INTO modules(name, description, active, created_at) VALUES (?,?,?,?)').run(name, str(b.description, 500, 'Description'), b.active === false ? 0 : 1, now());
  send(res, 201, { id: Number(r.lastInsertRowid) });
});

route('PATCH', /^\/api\/modules\/(\d+)$/, async (req, res, s, [id]) => {
  requireAdmin(s);
  const m = db.prepare('SELECT * FROM modules WHERE id = ?').get(id);
  if (!m) throw notFound();
  const b = await readJson(req);
  const name = b.name !== undefined ? str(b.name, 80, 'Module name', true) : m.name;
  if (db.prepare('SELECT 1 FROM modules WHERE name = ? AND id <> ?').get(name, id)) throw bad('A module with that name already exists.');
  db.prepare('UPDATE modules SET name = ?, description = ?, active = ? WHERE id = ?')
    .run(name, b.description !== undefined ? str(b.description, 500, 'Description') : m.description, b.active !== undefined ? (b.active ? 1 : 0) : m.active, id);
  send(res, 200, { ok: true });
});

route('DELETE', /^\/api\/modules\/(\d+)$/, (req, res, s, [id]) => {
  requireAdmin(s);
  if (db.prepare('SELECT 1 FROM issues WHERE module_id = ?').get(id)) throw new HttpError(409, 'This module has reports, so it cannot be deleted. Deactivate it instead.');
  tx(db, () => {
    db.prepare('DELETE FROM submodules WHERE module_id = ?').run(id);
    if (!db.prepare('DELETE FROM modules WHERE id = ?').run(id).changes) throw notFound();
  });
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/submodules$/, async (req, res, s) => {
  requireAdmin(s);
  const b = await readJson(req);
  const moduleId = int(b.module_id);
  if (!moduleId || !db.prepare('SELECT 1 FROM modules WHERE id = ?').get(moduleId)) throw bad('Choose the parent module.');
  const name = str(b.name, 80, 'Sub-module name', true);
  if (db.prepare('SELECT 1 FROM submodules WHERE module_id = ? AND name = ?').get(moduleId, name)) throw bad('That module already has a sub-module with that name.');
  const r = db.prepare('INSERT INTO submodules(module_id, name, description, active, created_at) VALUES (?,?,?,?,?)')
    .run(moduleId, name, str(b.description, 500, 'Description'), b.active === false ? 0 : 1, now());
  send(res, 201, { id: Number(r.lastInsertRowid) });
});

route('PATCH', /^\/api\/submodules\/(\d+)$/, async (req, res, s, [id]) => {
  requireAdmin(s);
  const sm = db.prepare('SELECT * FROM submodules WHERE id = ?').get(id);
  if (!sm) throw notFound();
  const b = await readJson(req);
  // Moving a sub-module to another module would silently re-file every
  // historical report under it (requirement rule 9), so the parent is fixed.
  const name = b.name !== undefined ? str(b.name, 80, 'Sub-module name', true) : sm.name;
  if (db.prepare('SELECT 1 FROM submodules WHERE module_id = ? AND name = ? AND id <> ?').get(sm.module_id, name, id)) throw bad('That module already has a sub-module with that name.');
  db.prepare('UPDATE submodules SET name = ?, description = ?, active = ? WHERE id = ?')
    .run(name, b.description !== undefined ? str(b.description, 500, 'Description') : sm.description, b.active !== undefined ? (b.active ? 1 : 0) : sm.active, id);
  send(res, 200, { ok: true });
});

route('DELETE', /^\/api\/submodules\/(\d+)$/, (req, res, s, [id]) => {
  requireAdmin(s);
  if (db.prepare('SELECT 1 FROM issues WHERE submodule_id = ?').get(id)) throw new HttpError(409, 'This sub-module has reports, so it cannot be deleted. Deactivate it instead.');
  if (!db.prepare('DELETE FROM submodules WHERE id = ?').run(id).changes) throw notFound();
  send(res, 200, { ok: true });
});

// ---- Users -----------------------------------------------------------------
route('GET', /^\/api\/users$/, (req, res, s) => {
  // Everyone may read the developer list (to see who an issue is with);
  // only admins get the full list with emails and state.
  if (s.user.is_admin) {
    return send(res, 200, db.prepare('SELECT * FROM users ORDER BY active DESC, name, email').all().map((u) => ({
      ...publicUser(u), linked: !!u.sub, last_seen_at: u.last_seen_at, daily_summary: !!u.daily_summary,
    })));
  }
  send(res, 200, db.prepare('SELECT * FROM users WHERE active = 1 AND is_developer = 1 ORDER BY name').all().map((u) => ({ id: u.id, name: u.name || u.email, roles: rolesOf(u), active: true })));
});

function rolesFrom(b) {
  const r = { is_admin: b.roles?.includes('admin') ? 1 : 0, is_developer: b.roles?.includes('developer') ? 1 : 0, is_tester: b.roles?.includes('tester') ? 1 : 0 };
  if (!r.is_admin && !r.is_developer && !r.is_tester) throw bad('Give the person at least one role.');
  return r;
}

route('POST', /^\/api\/users$/, async (req, res, s) => {
  requireAdmin(s);
  const b = await readJson(req);
  const email = str(b.email, 200, 'Email', true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('That email address does not look right.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw bad('That person is already on the tracker.');
  const r = rolesFrom(b);
  const ins = db.prepare('INSERT INTO users(email, name, is_admin, is_developer, is_tester, created_at) VALUES (?,?,?,?,?,?)')
    .run(email, str(b.name, 100, 'Name'), r.is_admin, r.is_developer, r.is_tester, now());
  send(res, 201, { id: Number(ins.lastInsertRowid) });
});

route('PATCH', /^\/api\/users\/(\d+)$/, async (req, res, s, [id]) => {
  requireAdmin(s);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw notFound();
  const b = await readJson(req);
  const r = b.roles ? rolesFrom(b) : { is_admin: u.is_admin, is_developer: u.is_developer, is_tester: u.is_tester };
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  tx(db, () => {
    db.prepare('UPDATE users SET name = ?, is_admin = ?, is_developer = ?, is_tester = ?, active = ? WHERE id = ?')
      .run(b.name !== undefined ? str(b.name, 100, 'Name') : u.name, r.is_admin, r.is_developer, r.is_tester, active, id);
    // Never leave the tracker with nobody able to manage it.
    if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1 AND active = 1').get()) throw bad('The tracker must keep at least one active admin.');
  });
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  send(res, 200, { ok: true });
});

// ---- Issues ----------------------------------------------------------------
route('GET', /^\/api\/issues$/, (req, res, s, _, url) => {
  const { where, params } = issueQuery(s, url.searchParams, { scopeMine: url.searchParams.get('mine') === '1' });
  const rows = db.prepare(`
    SELECT i.id, i.type, i.title, i.priority, i.status, i.due_date, i.created_at, i.updated_at, i.reporter_role,
           i.assignee_id, i.reporter_id, m.name module_name, sm.name submodule_name,
           r.name reporter_name, r.email reporter_email, a.name assignee_name, a.email assignee_email
      FROM issues i JOIN modules m ON m.id = i.module_id JOIN submodules sm ON sm.id = i.submodule_id
      JOIN users r ON r.id = i.reporter_id LEFT JOIN users a ON a.id = i.assignee_id
      ${where} ORDER BY i.updated_at DESC LIMIT 1000`).all(...params);
  send(res, 200, rows.map(presentIssue));
});

route('GET', /^\/api\/issues\.csv$/, (req, res, s, _, url) => {
  const { where, params } = issueQuery(s, url.searchParams, { scopeMine: url.searchParams.get('mine') === '1' });
  const rows = db.prepare(`
    SELECT i.*, m.name module_name, sm.name submodule_name, r.name reporter_name, r.email reporter_email, a.name assignee_name
      FROM issues i JOIN modules m ON m.id = i.module_id JOIN submodules sm ON sm.id = i.submodule_id
      JOIN users r ON r.id = i.reporter_id LEFT JOIN users a ON a.id = i.assignee_id
      ${where} ORDER BY i.id`).all(...params);
  // Leading = + - @ would run as a formula when the file is opened in Excel.
  const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  const cols = ['Issue ID', 'Type', 'Module', 'Sub-Module', 'Title', 'Priority', 'Status', 'Reported by', 'Reported as', 'Assigned to', 'Due', 'Created', 'Updated', 'Closed'];
  const lines = [cols.map(cell).join(',')].concat(rows.map((i) => [issueKey(i.id), i.type, i.module_name, i.submodule_name, i.title, i.priority, STATUS_LABEL[i.status], i.reporter_name || i.reporter_email, i.reporter_role, i.assignee_name, i.due_date, i.created_at, i.updated_at, i.closed_at].map(cell).join(',')));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tatvaos-issues-${todayIst()}.csv"`, 'Cache-Control': 'no-store' });
  res.end('﻿' + lines.join('\r\n'));
});

route('POST', /^\/api\/issues$/, async (req, res, s) => {
  requireMode(s, 'tester', 'admin');
  const b = await readJson(req);
  const moduleId = int(b.module_id);
  const subId = int(b.submodule_id);
  const mod = moduleId && db.prepare('SELECT * FROM modules WHERE id = ? AND active = 1').get(moduleId);
  if (!mod) throw bad('Choose an active module.');
  const sub = subId && db.prepare('SELECT * FROM submodules WHERE id = ? AND module_id = ? AND active = 1').get(subId, moduleId);
  if (!sub) throw bad('Choose an active sub-module of that module.');
  if (!TYPES.includes(b.type)) throw bad('Choose Bug or Feature Request.');
  if (!PRIORITIES.includes(b.priority)) throw bad('Choose a priority.');
  const title = str(b.title, 200, 'Title', true);
  const details = str(b.details, 20000, 'Details', true);
  const out = tx(db, () => {
    const t = now();
    const r = db.prepare('INSERT INTO issues(module_id, submodule_id, type, title, details, priority, status, reporter_id, reporter_role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(moduleId, subId, b.type, title, details, b.priority, 'pending', s.user.id, s.mode, t, t);
    const id = Number(r.lastInsertRowid);
    // The names at the time of reporting are kept in the history, so a later
    // rename of a module never rewrites what the report originally said.
    const activityId = addActivity(id, s, 'created', { to: 'pending', meta: { module: mod.name, submodule: sub.name, type: b.type, priority: b.priority } });
    return { id, activityId };
  });
  const issue = loadIssue(out.id);
  mailer.issueEvent(issue, s.user, { kind: 'created', subjectPrefix: 'New ' + (issue.type === 'bug' ? 'bug' : 'feature request'), line: `New ${issue.type === 'bug' ? 'bug' : 'feature request'} in ${issue.module_name} › ${issue.submodule_name}, reported` }, details);
  send(res, 201, { id: out.id, key: issueKey(out.id), activity_id: out.activityId });
});

route('GET', /^\/api\/issues\/(\d+)$/, (req, res, s, [id]) => {
  const issue = loadIssue(id);
  if (!issue || !canSee(s.user, issue)) throw notFound();
  const activity = db.prepare(`SELECT a.*, u.name actor_name, u.email actor_email FROM activity a JOIN users u ON u.id = a.actor_id WHERE a.issue_id = ? ORDER BY a.id`).all(id);
  const files = db.prepare('SELECT id, activity_id, name, mime, size, at FROM attachments WHERE issue_id = ? ORDER BY id').all(id);
  send(res, 200, {
    issue: presentIssue(issue),
    activity: activity.map((a) => ({ ...a, meta: a.meta ? JSON.parse(a.meta) : null, files: files.filter((f) => f.activity_id === a.id) })),
    can: {
      moves: allowedMoves(s, issue),
      comment: true,
      assign: s.mode === 'admin' || (s.mode === 'developer' && issue.assignee_id === s.user.id),
      due: actsAsDeveloper(s, issue),
      edit: s.mode === 'admin' || (s.mode === 'tester' && issue.reporter_id === s.user.id && ['pending', 'more_info'].includes(issue.status)),
      request_info: actsAsDeveloper(s, issue) && ['pending', 'under_review', 'under_dev', 'reopened'].includes(issue.status),
    },
  });
});

route('POST', /^\/api\/issues\/(\d+)\/actions$/, async (req, res, s, [id]) => {
  const issue = loadIssue(id);
  if (!issue || !canSee(s.user, issue)) throw notFound();
  const b = await readJson(req, 64 * 1024);
  const body = str(b.body, 20000, 'Text');
  let activityId;
  let mail = null;

  switch (b.action) {
    case 'comment': {
      if (!body) throw bad('Write something first.');
      const isReply = issue.status === 'more_info' && issue.reporter_id === s.user.id;
      activityId = addActivity(id, s, isReply ? 'reply' : 'comment', { body });
      db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), id);
      mail = { kind: 'comment', subjectPrefix: isReply ? 'Tester replied' : 'New comment', line: isReply ? 'The tester replied with more information' : 'A comment was added' };
      break;
    }
    case 'request_info': {
      if (!actsAsDeveloper(s, issue)) throw forbidden();
      if (!body) throw bad('Say what information you need.');
      if (issue.status === 'more_info' || issue.status === 'fixed' || issue.status === 'closed') throw bad('Information cannot be requested at this stage.');
      activityId = addActivity(id, s, 'info_request', { from: issue.status, to: 'more_info', body });
      db.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?').run('more_info', now(), id);
      mail = { kind: 'info_request', subjectPrefix: 'More information required', line: 'The developer asked for more information' };
      break;
    }
    case 'status': {
      const to = b.to;
      if (!allowedMoves(s, issue).includes(to)) throw forbidden(`You cannot move this issue from ${STATUS_LABEL[issue.status]} to ${STATUS_LABEL[to] || to} in ${s.mode} mode.`);
      let fix = issue.fix_details;
      if (to === 'fixed') {
        fix = str(b.fix_details, 20000, 'Fix details', true);
      }
      const adminOverride = to === 'closed' && issue.status !== 'fixed';
      if ((to === 'reopened' || adminOverride) && !body) throw bad(to === 'reopened' ? 'Say what is still wrong.' : 'Give the reason for closing without a fix.');
      const kind = to === 'fixed' ? 'fixed' : to === 'closed' ? 'closed' : to === 'reopened' ? 'reopened' : 'status';
      activityId = addActivity(id, s, kind, { from: issue.status, to, body: to === 'fixed' ? fix + (body ? '\n\n' + body : '') : body, meta: adminOverride ? { closed_without_fix: true } : null });
      db.prepare('UPDATE issues SET status = ?, fix_details = ?, updated_at = ?, closed_at = ? WHERE id = ?')
        .run(to, fix, now(), to === 'closed' ? now() : null, id);
      mail = {
        kind: to === 'reopened' ? 'reopened' : 'status',
        subjectPrefix: to === 'fixed' ? 'Fixed — please verify' : to === 'closed' ? 'Closed' : to === 'reopened' ? 'Reopened' : 'Status: ' + STATUS_LABEL[to],
        line: `Status changed from ${STATUS_LABEL[issue.status]} to ${STATUS_LABEL[to]}`,
      };
      break;
    }
    case 'assign': {
      if (!(s.mode === 'admin' || (s.mode === 'developer' && issue.assignee_id === s.user.id))) throw forbidden();
      const to = b.assignee_id === null ? null : int(b.assignee_id);
      if (to !== null && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1 AND is_developer = 1').get(to)) throw bad('Choose an active developer.');
      if (to === issue.assignee_id) throw bad('The issue is already with that person.');
      const toUser = to && db.prepare('SELECT * FROM users WHERE id = ?').get(to);
      activityId = addActivity(id, s, 'assigned', { body, meta: { from: issue.assignee_name || issue.assignee_email || null, to: toUser ? toUser.name || toUser.email : null } });
      db.prepare('UPDATE issues SET assignee_id = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
      mail = { kind: 'assigned', subjectPrefix: toUser ? 'Assigned to ' + (toUser.name || toUser.email) : 'Unassigned', line: toUser ? `Assigned to ${toUser.name || toUser.email}` : 'Unassigned' };
      break;
    }
    case 'due': {
      if (!actsAsDeveloper(s, issue)) throw forbidden();
      const due = b.due_date ? String(b.due_date) : null;
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw bad('Choose a valid date.');
      activityId = addActivity(id, s, 'due', { body, meta: { from: issue.due_date, to: due } });
      db.prepare('UPDATE issues SET due_date = ?, updated_at = ? WHERE id = ?').run(due, now(), id);
      break;
    }
    case 'edit': {
      const canEdit = s.mode === 'admin' || (s.mode === 'tester' && issue.reporter_id === s.user.id && ['pending', 'more_info'].includes(issue.status));
      if (!canEdit) throw forbidden();
      const changes = {};
      const title = b.title !== undefined ? str(b.title, 200, 'Title', true) : issue.title;
      const details = b.details !== undefined ? str(b.details, 20000, 'Details', true) : issue.details;
      const priority = b.priority !== undefined ? b.priority : issue.priority;
      if (!PRIORITIES.includes(priority)) throw bad('Choose a priority.');
      if (title !== issue.title) changes.title = { from: issue.title, to: title };
      if (details !== issue.details) changes.details = { from: issue.details, to: details };
      if (priority !== issue.priority) changes.priority = { from: issue.priority, to: priority };
      if (!Object.keys(changes).length) throw bad('Nothing changed.');
      activityId = addActivity(id, s, 'edited', { body, meta: changes });
      db.prepare('UPDATE issues SET title = ?, details = ?, priority = ?, updated_at = ? WHERE id = ?').run(title, details, priority, now(), id);
      break;
    }
    case 'attach': {
      // An entry that exists only to carry files ("Tester replied with screen
      // recording"). The files follow as uploads against this entry.
      activityId = addActivity(id, s, 'attachment', { body });
      db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), id);
      mail = { kind: 'comment', subjectPrefix: 'Files added', line: 'Files were added' };
      break;
    }
    default:
      throw bad('Unknown action.');
  }
  if (mail) mailer.issueEvent(loadIssue(id), s.user, mail, body);
  send(res, 200, { ok: true, activity_id: activityId });
});

route('POST', /^\/api\/issues\/(\d+)\/attachments$/, (req, res, s, [id], url) => uploadAttachment(req, res, s, Number(id), url));
route('GET', /^\/api\/attachments\/(\d+)$/, (req, res, s, [id]) => serveAttachment(req, res, s, Number(id)));

// ---- Dashboard and reports -------------------------------------------------
route('GET', /^\/api\/dashboard$/, (req, res, s, _, url) => {
  const { where, params } = issueQuery(s, url.searchParams);
  const rows = db.prepare(`SELECT i.status, i.type, COUNT(*) n FROM issues i ${where} GROUP BY i.status, i.type`).all(...params);
  const counts = { total: 0, bug: 0, feature: 0 };
  for (const st of STATUSES) counts[st] = 0;
  for (const r of rows) { counts.total += r.n; counts[r.type] += r.n; counts[r.status] += r.n; }
  const od = issueQuery(s, new URLSearchParams([...url.searchParams, ['overdue', '1']]));
  counts.overdue = db.prepare(`SELECT COUNT(*) n FROM issues i ${od.where}`).get(...od.params).n;
  send(res, 200, { mode: s.mode, counts });
});

route('GET', /^\/api\/reports$/, (req, res, s, _, url) => {
  requireAdmin(s);
  const group = url.searchParams.get('group');
  const groups = {
    type: { label: "CASE i.type WHEN 'bug' THEN 'Bug' ELSE 'Feature Request' END", join: '' },
    developer: { label: "COALESCE(NULLIF(a.name,''), a.email, '(unassigned)')", join: 'LEFT JOIN users a ON a.id = i.assignee_id' },
    tester: { label: "COALESCE(NULLIF(r.name,''), r.email)", join: 'JOIN users r ON r.id = i.reporter_id' },
    module: { label: 'm.name', join: 'JOIN modules m ON m.id = i.module_id' },
    submodule: { label: "m.name || ' › ' || sm.name", join: 'JOIN modules m ON m.id = i.module_id JOIN submodules sm ON sm.id = i.submodule_id' },
    priority: { label: 'i.priority', join: '' },
  };
  const g = groups[group];
  if (!g) throw bad('Unknown report.');
  const { where, params } = issueQuery(s, url.searchParams);
  const rows = db.prepare(`SELECT ${g.label} label, i.status, COUNT(*) n FROM issues i ${g.join} ${where} GROUP BY 1, 2 ORDER BY 1`).all(...params);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.label)) out.set(r.label, { label: r.label, total: 0, ...Object.fromEntries(STATUSES.map((x) => [x, 0])) });
    const o = out.get(r.label); o[r.status] += r.n; o.total += r.n;
  }
  send(res, 200, [...out.values()]);
});

// ---- Settings (admin) ------------------------------------------------------
route('GET', /^\/api\/settings$/, (req, res, s) => {
  requireAdmin(s);
  send(res, 200, {
    mail_from: getSetting(db, 'mail_from'),
    mail_api_key_set: !!getSetting(db, 'mail_api_key'),
    mail_log: db.prepare('SELECT l.at, l.subject, l.ok, l.detail, u.name user_name, u.email user_email FROM mail_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 50').all(),
  });
});

route('PUT', /^\/api\/settings$/, async (req, res, s) => {
  requireAdmin(s);
  const b = await readJson(req);
  if (b.mail_from !== undefined) {
    const f = str(b.mail_from, 200, 'Sender address');
    if (f && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(f)) throw bad('The sender must be a plain email address.');
    setSetting(db, 'mail_from', f);
  }
  if (b.mail_api_key) {
    const k = String(b.mail_api_key).trim();
    if (!/^tvos_[A-Za-z0-9_\-]{10,}$/.test(k)) throw bad('That does not look like a TatvaOS Mail API key (it starts with tvos_).');
    setSetting(db, 'mail_api_key', k);
  }
  if (b.clear_mail_api_key) setSetting(db, 'mail_api_key', '');
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/settings\/test-mail$/, async (req, res, s) => {
  requireAdmin(s);
  mailer.enqueue(s.user, 'TatvaOS Bugs — test email', ['This is a test email from TatvaOS Bugs.', '', 'If you can read this, notifications are working.'], cfg.publicUrl + '/');
  await mailer._drain();
  const last = db.prepare('SELECT ok, detail FROM mail_log WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(s.user.id);
  send(res, 200, { ok: !!last?.ok, detail: last?.detail || '' });
});

route('POST', /^\/api\/settings\/send-summaries$/, async (req, res, s) => {
  requireAdmin(s);
  send(res, 200, { queued: mailer.dailySummaries(true) });
});

// ============================================================================
//  Static files and the server
// ============================================================================

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
  };
}

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
const TYPES_BY_EXT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const file = STATIC[pathname];
  if (!file) return false;
  const full = path.join(PUBLIC_DIR, file);
  res.writeHead(200, { 'Content-Type': TYPES_BY_EXT[path.extname(file)], 'Cache-Control': 'no-cache', ...securityHeaders() });
  fs.createReadStream(full).pipe(res);
  return true;
}

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/auth/login') return authLogin(req, res);
  if (req.method === 'GET' && p === '/auth/callback') return authCallback(req, res, url);
  if (req.method === 'POST' && p === '/auth/logout') {
    const sid = parseCookies(req).bt_session;
    if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    res.writeHead(303, { Location: '/', 'Set-Cookie': cookie('bt_session', '', 0) });
    return res.end();
  }
  if (cfg.devLogin && req.method === 'GET' && p === '/auth/dev') {
    const ra = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) throw notFound();
    const user = linkUser({ sub: 'dev:' + url.searchParams.get('email'), email: url.searchParams.get('email'), email_verified: true, name: url.searchParams.get('name') || '' });
    if (!user) return messagePage(res, 'Not on the tracker', 'That email has not been added.');
    createSession(res, user);
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  if (p.startsWith('/api/')) {
    // Every change needs our own header, which a cross-site form cannot send
    // and a cross-site fetch cannot send without a preflight we never answer.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['x-bug-tracker'] !== '1') throw forbidden('Missing request header.');
      if (req.headers.origin && req.headers.origin !== ORIGIN) throw forbidden('Wrong origin.');
    }
    const s = currentSession(req);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(p);
      if (!m) continue;
      if (r.auth && !s) throw new HttpError(401, 'Please sign in.');
      return await r.handler(req, res, s, m.slice(1).map(Number), url);
    }
    throw notFound();
  }

  if (req.method === 'GET' && serveStatic(req, res, p)) return;
  throw notFound();
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('error', req.method, new URL(req.url, ORIGIN).pathname, e && e.stack || e);
    if (res.headersSent) return res.destroy();
    const msg = status === 500 ? 'Something went wrong. Please try again.' : e.message;
    if ((req.url || '').startsWith('/api/')) send(res, status, { error: msg });
    else send(res, status, `<!doctype html><title>TatvaOS Bugs</title><p>${msg.replace(/[<>&]/g, '')}</p><p><a href="/">Back</a></p>`, securityHeaders());
  }
});
server.requestTimeout = 30 * 60 * 1000; // screen recordings on slow links
server.listen(cfg.port, () => console.log(`TatvaOS Bugs listening on :${cfg.port} (${cfg.publicUrl})${cfg.devLogin ? ' — DEV LOGIN ON' : ''}`));

// Housekeeping and the daily summary, every ten minutes.
setInterval(() => {
  try {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    mailer.dailySummaries();
  } catch (e) { console.error('housekeeping', e); }
}, 10 * 60 * 1000).unref();

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
