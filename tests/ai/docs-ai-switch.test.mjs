// ============================================================================
//  Docs AI's own switch (#406, 10 Oct 2026) — against a running API
// ============================================================================
//
//  The approved sentence (AiDisclosure.DocsWhoDecides) promises "Docs AI is
//  off by default. Only your organisation's administrator can turn it on".
//  Until #406 Docs AI rode on allow_ai, the meeting-minutes consent. This
//  proves the promise is now what the code does.
//
//  Same harness as tests/ai/mail-ai.test.mjs: a FAKE provider, never a key.
//    - the API with Ai__BaseUrl=http://127.0.0.1:5199/v1, any
//      Ai__ApiKey/Model/DataLocation, and Ai__Vendor=OpenAI;
//    - node tests/ai/fake-ai-mail.mjs on :5199. GET /hits counts what reached
//      the provider (the witness that a refusal sent NOTHING); GET /last is
//      what it received (the witness for WHAT was sent).
//    - TATVAOS_PSQL ("<psql> -d <db> -Atc", tests/lib/throwaway-db.sh, rule 13)
//      for the audit rows.
//
//    node tests/ai/docs-ai-switch.test.mjs
//
//  Environment: DOCSAI_API (default http://localhost:5171/api), FAKE (default
//  http://127.0.0.1:5199), AI_ADMIN "email,password" (the platform operator,
//  who is also the organisation's administrator in the local seed). Puts back
//  every ai.* setting and every switch it changed, whatever it found.
//
//  What would make this wrong: a refusal asserted only by the absence of
//  text. Every refusal here asserts the provider's hit count did not move AND
//  the sentence the person sees; every success asserts the provider received
//  exactly the text sent.
// ============================================================================

import { execSync } from 'node:child_process';

const API = process.env.DOCSAI_API ?? 'http://localhost:5171/api';
const FAKE = process.env.FAKE ?? 'http://127.0.0.1:5199';
const [EMAIL, PASSWORD] = (process.env.AI_ADMIN ?? 'platform@docs.local,dev-only-platform-pass').split(',');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ok    ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `  — ${String(detail).slice(0, 200)}` : ''}`); }
};
const psql = (sql) => {
  if (!process.env.TATVAOS_PSQL) return null;
  return execSync(`${process.env.TATVAOS_PSQL} "${sql}"`, { encoding: 'utf8' }).trim().split('\n').pop();
};

const login = await (await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})).json();
if (!login.accessToken) { console.log('sign-in failed'); process.exit(2); }
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` };
const call = async (method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const hits = async () => (await (await fetch(`${FAKE}/hits`)).json()).hits;
const last = async () => (await fetch(`${FAKE}/last`)).json();
const org = () => call('GET', '/org/ai');
const setAi = (change) => call('PUT', '/org/ai', change);

const me = (await call('GET', '/auth/me')).body;
const TENANT = me.organisation?.id;
if (!TENANT) { console.log('no organisation for this sign-in'); process.exit(2); }
console.log(`Docs AI switch against ${API} (fake provider ${FAKE}), organisation ${TENANT}\n`);

const OFF = 'Docs AI is switched off for your organisation. An administrator can turn it on.';
const NOT_OFFERED = 'TatvaOS AI in Docs is not available for your organisation yet.';
const TEXT = 'The school picnic is on 14 November. Parents should send a packed lunch and a water bottle.';

// Remember what we change, to put it back.
const settingsNow = async () => Object.fromEntries((await call('GET', '/admin/settings')).body
  .filter((i) => i.key.startsWith('ai.')).map((i) => [i.key, i.value ?? '']));
const found = await settingsNow();
const foundSwitches = (await org()).body;
const docsWasOn = (await call('GET', `/admin/organisations/${TENANT}/docs`)).body?.enabled === true;

try {
  // Docs (the product) on, so there is a document to ask about; AI limits lifted.
  await call('PUT', `/admin/organisations/${TENANT}/docs`, { enabled: true });
  await call('PUT', '/admin/settings', { 'ai.paused': 'false', 'ai.limit.per_person_per_hour': '', 'ai.limit.org_monthly_tokens': '', 'ai.docs.organisations': '' });
  await setAi({ enabled: true, docs: false });
  const doc = await call('POST', '/docs', { title: 'Docs AI switch test' });
  check('a document to ask about (201)', doc.status === 201, `${doc.status} ${JSON.stringify(doc.body)}`);
  const id = doc.body.id;
  const ask = () => call('POST', `/docs/${id}/ai`, { action: 'summarize', text: TEXT });

  // ── 1. Not offered (ai.docs.organisations empty = nobody) ─────────────────
  console.log('1. Not offered');
  let o = (await org()).body;
  check('GET /org/ai: not offered, the sentence, and off', o.docsOffered === false && o.docsNotOffered === NOT_OFFERED && o.docsEnabled === false, JSON.stringify({ o: o.docsOffered, n: o.docsNotOffered, e: o.docsEnabled }));
  let put = await setAi({ docs: true });
  check('turning Docs AI ON is refused while not offered (400, the sentence)', put.status === 400 && put.body.error === NOT_OFFERED, JSON.stringify(put.body));
  check('…and it stays off', (await org()).body.docsEnabled === false);
  check('the editor offers no AI, saying why', (await call('GET', `/docs/${id}`)).body.ai?.available === false);
  let h0 = await hits();
  let r = await ask();
  check('a Docs AI request is refused (403)', r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
  check('…and NOTHING reached the provider', (await hits()) === h0);

  // ── 2. Offered, but off — the default this PR adds ───────────────────────
  console.log('2. Offered, off by default');
  await call('PUT', '/admin/settings', { 'ai.docs.organisations': 'all' });
  o = (await org()).body;
  check('offered now, but OFF by default (minutes consent alone does not turn it on)', o.docsOffered === true && o.docsEnabled === false && o.enabled === true, JSON.stringify({ o: o.docsOffered, e: o.docsEnabled, ai: o.enabled }));
  const editor = (await call('GET', `/docs/${id}`)).body.ai;
  check('the editor says Docs AI is switched off, in the person\'s words', editor?.available === false && editor?.reason === OFF, JSON.stringify(editor));
  h0 = await hits();
  r = await ask();
  check('a Docs AI request is refused with the sentence (403)', r.status === 403 && JSON.stringify(r.body).includes(OFF), `${r.status} ${JSON.stringify(r.body)}`);
  check('…and NOTHING reached the provider', (await hits()) === h0);

  // ── 3. The administrator turns it on ─────────────────────────────────────
  console.log('3. Turned on by the administrator');
  for (const s of ['the text of the document, when a person asks for a summary',
    'Pictures, comments, earlier versions and the names of the people who edited a document are never sent.',
    "Docs AI is off by default. Only your organisation's administrator can turn it on",
    'OpenAI, in the United States']) {
    check(`the disclosure shown before agreeing carries: "${s.slice(0, 50)}…"`, o.docsDisclosure.includes(s), o.docsDisclosure);
  }
  put = await setAi({ docs: true });
  check('PUT {docs:true} is 200 and says on', put.status === 200 && put.body.docsEnabled === true, JSON.stringify(put.body));
  check('…again is idempotent (200, still on)', (await setAi({ docs: true })).body.docsEnabled === true);
  const audited = psql("select count(*) from core.audit_logs where action = 'org.ai.docs.enabled' and occurred_at > now() - interval '10 minutes'");
  check('…and audited by name (org.ai.docs.enabled, once)', audited === null || audited === '1', `rows ${audited}`);
  if (audited === null) console.log('        (audit not checked: TATVAOS_PSQL not set)');
  check('the editor now offers Docs AI', (await call('GET', `/docs/${id}`)).body.ai?.available === true);
  h0 = await hits();
  r = await ask();
  check('a Docs AI request succeeds (200)', r.status === 200 && typeof r.body.text === 'string', `${r.status} ${JSON.stringify(r.body)}`);
  check('…one request reached the provider', (await hits()) === h0 + 1);
  check('…and it received exactly the text sent', (await last()).user === TEXT, JSON.stringify(await last()));

  // ── 4. The organisation's consent still governs ──────────────────────────
  console.log('4. Organisation consent off');
  await setAi({ enabled: false });
  h0 = await hits();
  r = await ask();
  check('with TatvaOS AI off for the organisation, Docs AI is refused even with its own switch on', r.status === 403, `${r.status}`);
  check('…and NOTHING reached the provider', (await hits()) === h0);
  await setAi({ enabled: true });

  // ── 5. A spreadsheet's AI is not governed by the Docs switch ─────────────
  console.log('5. Spreadsheets untouched');
  await setAi({ docs: false });
  const sheet = await call('POST', '/docs', { title: 'Docs AI switch test sheet', kind: 'spreadsheet' });
  if (sheet.status === 201) {
    const s = (await call('GET', `/docs/${sheet.body.id}`)).body.ai;
    check('a spreadsheet\'s AI state never carries the Docs sentence', s?.reason !== OFF && s?.reason !== NOT_OFFERED, JSON.stringify(s));
    await call('DELETE', `/space/files/${sheet.body.id}`);
  } else {
    console.log(`        (Sheets is off here, ${sheet.status}: spreadsheet check skipped)`);
  }

  // ── 6. Off again ─────────────────────────────────────────────────────────
  console.log('6. Turned off again');
  check('Docs AI is off', (await org()).body.docsEnabled === false);
  const auditedOff = psql("select count(*) from core.audit_logs where action = 'org.ai.docs.disabled' and occurred_at > now() - interval '10 minutes'");
  check('…and the switch-off is audited (org.ai.docs.disabled)', auditedOff === null || Number(auditedOff) >= 1, `rows ${auditedOff}`);
  h0 = await hits();
  r = await ask();
  check('requests are refused again, and NOTHING reaches the provider', r.status === 403 && (await hits()) === h0, `${r.status}`);
  await call('DELETE', `/space/files/${id}`);
} finally {
  await call('PUT', '/admin/settings', found);
  await setAi({ enabled: foundSwitches.enabled, docs: false });
  if (!docsWasOn) await call('PUT', `/admin/organisations/${TENANT}/docs`, { enabled: false });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
