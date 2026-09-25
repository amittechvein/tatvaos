// End-to-end check of TatvaOS Bugs against a real server on a throwaway
// database. Run:  node apps/bugs/test/flow.mjs
//
// It walks the requirement document's own example (TV-000001 standing in for
// TV-000125): tester reports with a screenshot, admin assigns, developer
// reviews and asks for information, tester replies with a recording,
// developer fixes, tester reopens, developer fixes again, tester closes. On the
// way it checks the refusals that matter: who can see what, who can move what,
// that history cannot be changed, and that a module with reports cannot be
// deleted.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bugs-test-'));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); } };

const srv = spawn(process.execPath, [path.join(HERE, '..', 'src', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, PUBLIC_URL: BASE, DEV_LOGIN: '1', BOOTSTRAP_ADMIN_EMAILS: 'amit@techvein.com', OIDC_CLIENT_ID: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d; });
await new Promise((resolve, reject) => {
  srv.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  srv.on('exit', (c) => reject(new Error('server exited ' + c + ' ' + srvErr)));
  setTimeout(() => reject(new Error('server did not start')), 10000);
});

function client() {
  let cookie = '';
  const req = async (method, url, body, headers = {}) => {
    const h = { ...(cookie ? { Cookie: cookie } : {}), ...headers };
    if (method !== 'GET' && !('X-Bug-Tracker' in headers)) h['X-Bug-Tracker'] = '1';
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.startsWith('bt_session=')) cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return { req, login: (email) => req('GET', '/auth/dev?email=' + encodeURIComponent(email)) };
}

try {
  const amit = client(), rahul = client(), priya = client(), outsider = client(), dev2 = client();

  console.log('Sign-in and roles');
  check('unknown person refused', !(await outsider.login('stranger@example.com')).headers.get('set-cookie'));
  await amit.login('amit@techvein.com');
  const me = await amit.req('GET', '/api/me');
  check('bootstrap admin gets all three roles', JSON.stringify(me.json.user.roles) === '["admin","developer","tester"]', JSON.stringify(me.json));
  check('no session without cookie', (await outsider.req('GET', '/api/me')).status === 401);

  check('add Rahul (developer)', (await amit.req('POST', '/api/users', { email: 'rahul@techvein.com', name: 'Rahul', roles: ['developer'] })).status === 201);
  check('add Priya (tester)', (await amit.req('POST', '/api/users', { email: 'priya@techvein.com', name: 'Priya', roles: ['tester'] })).status === 201);
  check('add Dev Two (developer)', (await amit.req('POST', '/api/users', { email: 'dev2@techvein.com', name: 'Dev Two', roles: ['developer'] })).status === 201);
  check('duplicate person refused', (await amit.req('POST', '/api/users', { email: 'RAHUL@techvein.com', roles: ['tester'] })).status === 400);
  check('person with no role refused', (await amit.req('POST', '/api/users', { email: 'x@techvein.com', roles: [] })).status === 400);
  await rahul.login('rahul@techvein.com'); await priya.login('priya@techvein.com'); await dev2.login('dev2@techvein.com');
  check('tester cannot add users', (await priya.req('POST', '/api/users', { email: 'y@techvein.com', roles: ['admin'] })).status === 403);
  check('tester cannot switch to admin mode', (await priya.req('POST', '/api/me/mode', { mode: 'admin' })).status === 403);
  check('change without the request header refused (CSRF)', (await amit.req('POST', '/api/modules', { name: 'X' }, { 'X-Bug-Tracker': '' })).status === 403);
  check('change from another origin refused', (await amit.req('POST', '/api/modules', { name: 'X' }, { Origin: 'https://evil.example' })).status === 403);

  console.log('Modules');
  const mail = (await amit.req('POST', '/api/modules', { name: 'TatvaOS Mail', description: 'Webmail' })).json.id;
  const core = (await amit.req('POST', '/api/modules', { name: 'Core' })).json.id;
  const search = (await amit.req('POST', '/api/submodules', { module_id: mail, name: 'Search' })).json.id;
  const inbox = (await amit.req('POST', '/api/submodules', { module_id: mail, name: 'Inbox' })).json.id;
  const dash = (await amit.req('POST', '/api/submodules', { module_id: core, name: 'Dashboard' })).json.id;
  check('module + sub-modules created', mail && core && search && inbox && dash);
  check('duplicate module name refused', (await amit.req('POST', '/api/modules', { name: 'tatvaos mail' })).status === 400);
  check('tester cannot add modules', (await priya.req('POST', '/api/modules', { name: 'Space' })).status === 403);
  await amit.req('PATCH', '/api/submodules/' + inbox, { active: false });

  console.log('Report (tester)');
  check('sub-module of another module refused', (await priya.req('POST', '/api/issues', { module_id: mail, submodule_id: dash, type: 'bug', title: 't', details: 'd', priority: 'high' })).status === 400);
  check('inactive sub-module refused', (await priya.req('POST', '/api/issues', { module_id: mail, submodule_id: inbox, type: 'bug', title: 't', details: 'd', priority: 'high' })).status === 400);
  check('developer mode cannot report', (await rahul.req('POST', '/api/issues', { module_id: mail, submodule_id: search, type: 'bug', title: 't', details: 'd', priority: 'high' })).status === 403);
  const created = (await priya.req('POST', '/api/issues', { module_id: mail, submodule_id: search, type: 'bug', title: 'Search button is not visible', details: 'Search button is too small and not clearly visible on desktop.', priority: 'high' })).json;
  check('issue key is TV-000001', created.key === 'TV-000001', JSON.stringify(created));
  const id = created.id;
  const png = Uint8Array.from(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100)]));
  const up = await priya.req('POST', `/api/issues/${id}/attachments?activity=${created.activity_id}&name=Screenshot.png`, png, { 'Content-Type': 'application/octet-stream' });
  check('screenshot uploaded and sniffed as PNG', up.status === 201 && up.json.mime === 'image/png', up.text);
  const html = new TextEncoder().encode('<script>alert(1)</script>');
  const up2 = await priya.req('POST', `/api/issues/${id}/attachments?activity=${created.activity_id}&name=evil.html`, html, { 'Content-Type': 'text/html' });
  check('HTML upload stored as a download, not a page', up2.json.mime === 'application/octet-stream');
  const dl = await priya.req('GET', '/api/attachments/' + up2.json.id);
  check('HTML attachment served as attachment + nosniff + sandbox', /attachment/.test(dl.headers.get('content-disposition')) && dl.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(dl.headers.get('content-security-policy')));
  // Amit 25 Sept: everyone sees every issue; changing stays limited by role.
  const rv = await rahul.req('GET', '/api/issues/' + id);
  check('Rahul (not assigned) CAN see it', rv.status === 200);
  check('…but is offered no status moves', rv.json.can.moves.length === 0 && rv.json.can.assign === false, JSON.stringify(rv.json.can));
  check('…and cannot move it', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'under_review' })).status === 403);
  check('Rahul can open its attachment', (await rahul.req('GET', '/api/attachments/' + up.json.id)).status === 200);
  check("Rahul cannot attach to Priya's entry", (await rahul.req('POST', `/api/issues/${id}/attachments?activity=${created.activity_id}&name=x.png`, png)).status === 400);
  check('unsigned visitor still cannot open the attachment', (await outsider.req('GET', '/api/attachments/' + up.json.id)).status === 401);

  console.log('Assign and work (developer)');
  check('developer cannot hand an unassigned issue to someone else', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'assign', assignee_id: 4 /* Dev Two */ })).status === 403);
  const users = (await amit.req('GET', '/api/users')).json;
  const rahulId = users.find((u) => u.email === 'rahul@techvein.com').id;
  const dev2Id = users.find((u) => u.email === 'dev2@techvein.com').id;
  const priyaId = users.find((u) => u.email === 'priya@techvein.com').id;
  check('cannot assign to a tester', (await amit.req('POST', `/api/issues/${id}/actions`, { action: 'assign', assignee_id: priyaId })).status === 400);
  check('admin assigns to Rahul', (await amit.req('POST', `/api/issues/${id}/actions`, { action: 'assign', assignee_id: rahulId })).status === 200);
  check('Rahul now sees it', (await rahul.req('GET', '/api/issues/' + id)).status === 200);
  check('Dev Two (other developer) sees it', (await dev2.req('GET', '/api/issues/' + id)).status === 200);
  check('…but cannot move it', (await dev2.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'under_review' })).status === 403);
  check('tester cannot move Pending → Under Review', (await priya.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'under_review' })).status === 403);
  check('Pending → Under Review', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'under_review' })).status === 200);
  check('cannot jump Under Review → Fixed', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'fixed', fix_details: 'x' })).status === 403);
  check('ask for info needs a question', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'request_info', body: '' })).status === 400);
  check('developer requests more information', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'request_info', body: 'Which browser?' })).status === 200);
  const reply = await priya.req('POST', `/api/issues/${id}/actions`, { action: 'comment', body: 'Chrome 130 on Windows; recording attached.' });
  const mp4 = Uint8Array.from(Buffer.concat([Buffer.from('00000018', 'hex'), Buffer.from('ftypmp42'), Buffer.alloc(2000)]));
  const vid = await priya.req('POST', `/api/issues/${id}/attachments?activity=${reply.json.activity_id}&name=Screen-recording.mp4`, mp4);
  check('tester replies with a screen recording', reply.status === 200 && vid.json.mime === 'video/mp4');
  const range = await priya.req('GET', '/api/attachments/' + vid.json.id, undefined, { Range: 'bytes=0-99' });
  check('recording can be scrubbed (Range → 206)', range.status === 206 && range.headers.get('content-range') === `bytes 0-99/${mp4.length}`);
  check('More Information Required → Under Development', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'under_dev' })).status === 200);
  check('Fixed needs fix details', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'fixed' })).status === 400);
  check('developer marks Fixed with details', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'fixed', fix_details: 'Made the search button 40px and high-contrast.' })).status === 200);
  check("another tester cannot close Priya's report", (await amit.req('POST', '/api/me/mode', { mode: 'tester' })).status === 200 && (await amit.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'closed' })).status === 403);
  await amit.req('POST', '/api/me/mode', { mode: 'admin' });
  check('developer cannot close their own fix', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'closed' })).status === 403);

  console.log('Verify (tester)');
  check('reopen needs a reason', (await priya.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'reopened' })).status === 400);
  check('tester reopens', (await priya.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'reopened', body: 'Still small on 1366px screens.' })).status === 200);
  check('Reopened → Under Development', (await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'under_dev' })).status === 200);
  await rahul.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'fixed', fix_details: 'Also fixed at 1366px.' });
  check('tester verifies and closes', (await priya.req('POST', `/api/issues/${id}/actions`, { action: 'status', to: 'closed' })).status === 200);
  const full = (await priya.req('GET', '/api/issues/' + id)).json;
  check('status is Closed with closed_at', full.issue.status === 'closed' && !!full.issue.closed_at);
  const kinds = full.activity.map((a) => a.kind).join(',');
  check('history is complete and in order', kinds === 'created,assigned,status,info_request,reply,status,fixed,reopened,status,fixed,closed', kinds);
  check('history records the role of each actor', full.activity[0].actor_role === 'tester' && full.activity[1].actor_role === 'admin' && full.activity[2].actor_role === 'developer');
  check('files are linked to their entries', full.activity[0].files.length === 2 && full.activity[4].files.length === 1);

  console.log('Admin working as tester and developer');
  await amit.req('POST', '/api/me/mode', { mode: 'tester' });
  const amitIssue = (await amit.req('POST', '/api/issues', { module_id: core, submodule_id: dash, type: 'feature', title: 'Dark mode toggle', details: 'Add a toggle.', priority: 'low' })).json;
  const ai = (await amit.req('GET', '/api/issues/' + amitIssue.id)).json;
  check("admin's report stored with role Tester", ai.issue.reporter_role === 'tester');
  await amit.req('POST', '/api/me/mode', { mode: 'developer' });
  check('admin in developer mode cannot move an issue not assigned to him', (await amit.req('POST', `/api/issues/${amitIssue.id}/actions`, { action: 'status', to: 'under_review' })).status === 403);
  await amit.req('POST', '/api/me/mode', { mode: 'admin' });
  await amit.req('POST', `/api/issues/${amitIssue.id}/actions`, { action: 'assign', assignee_id: users.find((u) => u.email === 'amit@techvein.com').id });
  await amit.req('POST', '/api/me/mode', { mode: 'developer' });
  check('…but can once assigned to himself', (await amit.req('POST', `/api/issues/${amitIssue.id}/actions`, { action: 'status', to: 'under_review' })).status === 200);
  const ai2 = (await amit.req('GET', '/api/issues/' + amitIssue.id)).json;
  check('that move is recorded as Developer', ai2.activity.at(-1).actor_role === 'developer');
  await amit.req('POST', '/api/me/mode', { mode: 'admin' });
  check('admin close-without-fix needs a reason', (await amit.req('POST', `/api/issues/${amitIssue.id}/actions`, { action: 'status', to: 'closed' })).status === 400);

  console.log('Dashboards, lists, reports');
  const d1 = (await amit.req('GET', '/api/dashboard')).json.counts;
  check('admin dashboard counts everything', d1.total === 2 && d1.bug === 1 && d1.feature === 1 && d1.closed === 1 && d1.under_review === 1, JSON.stringify(d1));
  const d2 = (await priya.req('GET', '/api/dashboard')).json.counts;
  check('tester dashboard opens on her own reports', d2.total === 1);
  check('tester dashboard "Everyone" counts all', (await priya.req('GET', '/api/dashboard?scope=all')).json.counts.total === 2);
  const d3 = (await dev2.req('GET', '/api/dashboard')).json.counts;
  check('other developer: nothing assigned to him', d3.total === 0);
  check('other developer: All issues lists both', (await dev2.req('GET', '/api/issues')).json.length === 2);
  check('other developer: "Assigned to me" lists none', (await dev2.req('GET', '/api/issues?mine=1')).json.length === 0);
  check('tester: "My reports" lists only hers', (await priya.req('GET', '/api/issues?mine=1')).json.length === 1);
  const names = (await priya.req('GET', '/api/users')).json;
  check('non-admins get names, never emails', names.length >= 4 && names.every((u) => !('email' in u)));
  check('filter by module', (await amit.req('GET', '/api/issues?module=' + core)).json.length === 1);
  check('search by issue key', (await amit.req('GET', '/api/issues?q=TV-000001')).json[0]?.id === id);
  await amit.req('POST', `/api/issues/${amitIssue.id}/actions`, { action: 'due', due_date: '2020-01-01' });
  check('overdue counted', (await amit.req('GET', '/api/dashboard')).json.counts.overdue === 1);
  const rep = (await amit.req('GET', '/api/reports?group=developer')).json;
  check('developer report groups by developer', rep.some((r) => r.label === 'Rahul' && r.closed === 1), JSON.stringify(rep));
  check('tester cannot read reports', (await priya.req('GET', '/api/reports?group=module')).status === 403);
  const csv = await amit.req('GET', '/api/issues.csv');
  check('CSV export', csv.status === 200 && csv.text.includes('TV-000001'));

  console.log('Assign to me');
  const free = (await priya.req('POST', '/api/issues', { module_id: mail, submodule_id: search, type: 'bug', title: 'Nobody has this yet', details: 'x', priority: 'low' })).json.id;
  const dev2Me = (await dev2.req('GET', '/api/me')).json.user.id;
  check('developer is offered Assign to me on a free issue', (await dev2.req('GET', '/api/issues/' + free)).json.can.take === true);
  check('developer cannot hand a free issue to someone else', (await dev2.req('POST', `/api/issues/${free}/actions`, { action: 'assign', assignee_id: rahulId })).status === 403);
  check('tester cannot take an issue', (await priya.req('POST', `/api/issues/${free}/actions`, { action: 'assign', assignee_id: priyaId })).status === 403);
  check('developer takes it', (await dev2.req('POST', `/api/issues/${free}/actions`, { action: 'assign', assignee_id: dev2Me })).status === 200);
  const took = (await dev2.req('GET', '/api/issues/' + free)).json;
  check('…now assigned to him, recorded as Developer', took.issue.assignee_id === dev2Me && took.activity.at(-1).kind === 'assigned' && took.activity.at(-1).actor_role === 'developer');
  check('…and he can work on it', took.can.moves.includes('under_review'));
  check('Rahul cannot take it from him', (await rahul.req('POST', `/api/issues/${free}/actions`, { action: 'assign', assignee_id: rahulId })).status === 403);
  check('…and is not offered the button', (await rahul.req('GET', '/api/issues/' + free)).json.can.take === false);
  const shut = (await priya.req('POST', '/api/issues', { module_id: mail, submodule_id: search, type: 'feature', title: 'Declined idea', details: 'x', priority: 'low' })).json.id;
  await amit.req('POST', `/api/issues/${shut}/actions`, { action: 'status', to: 'closed', body: 'Will not do.' });
  check('a closed issue cannot be taken', (await dev2.req('POST', `/api/issues/${shut}/actions`, { action: 'assign', assignee_id: dev2Me })).status === 403);

  console.log('Rules that protect history');
  check('module with reports cannot be deleted', (await amit.req('DELETE', '/api/modules/' + mail)).status === 409);
  check('sub-module with reports cannot be deleted', (await amit.req('DELETE', '/api/submodules/' + search)).status === 409);
  check('empty sub-module can be deleted', (await amit.req('DELETE', '/api/submodules/' + inbox)).status === 200);
  await amit.req('PATCH', '/api/modules/' + mail, { active: false });
  check('deactivated module keeps its old report', (await priya.req('GET', '/api/issues/' + id)).json.issue.module_name === 'TatvaOS Mail');
  check('last admin cannot remove their own admin role', (await amit.req('PATCH', '/api/users/' + users.find((u) => u.email === 'amit@techvein.com').id, { roles: ['tester'] })).status === 400);
  const raw = new DatabaseSync(path.join(DATA, 'bugs.db'));
  let blocked = 0;
  try { raw.exec('DELETE FROM activity'); } catch { blocked++; }
  try { raw.exec("UPDATE activity SET body = 'changed'"); } catch { blocked++; }
  try { raw.exec('DELETE FROM attachments'); } catch { blocked++; }
  raw.close();
  check('database refuses to change or delete history', blocked === 3);
  check('disabled user loses access at once', (await amit.req('PATCH', '/api/users/' + priyaId, { active: false })).status === 200 && (await priya.req('GET', '/api/me')).status === 401);
  check('mail log records unsent mail (no key yet)', (await amit.req('GET', '/api/settings')).json.mail_log.length > 0);
  check('XSS text stored verbatim (page escapes it)', (await amit.req('POST', `/api/issues/${id}/actions`, { action: 'comment', body: '<img src=x onerror=alert(1)>' })).status === 200);
} catch (e) {
  fail++;
  console.log('  FAIL (exception)', e);
} finally {
  srv.kill();
  if (srvErr.trim()) console.log('server stderr:\n' + srvErr.split('\n').filter((l) => !l.includes('ExperimentalWarning')).join('\n'));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
