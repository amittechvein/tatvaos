// TatvaOS Bugs — "Improve my report" (Amit, 26 Sept 2026). OFF by default.
//
// A tester's rough note becomes a clear report (steps / what happened / what
// was expected) with a suggested type, priority and sub-module. The tester
// reviews every word before submitting; nothing is filed by the AI.
//
// It follows the product gateway's rules (apps/api/Shared/Ai/OpenAiGateway.cs),
// which Mr. Singh has already read for Mail AI:
//   · an OpenAI-compatible /chat/completions endpoint, its OWN key (pasted in
//     Settings like the mail key — never the product's key);
//   · a key with no stated data location is REFUSED, and a known host whose
//     country disagrees with the stated location is REFUSED;
//   · the provider's reply body is never logged (it can echo what we sent);
//   · input capped, 30 s timeout, a daily limit.
// What is sent: the draft's title, details and type, and the list of module
// names. NOT sent: files, anyone's name or email, other issues.

import { getSetting } from './db.mjs';

const KNOWN_HOSTS = [['api.openai.com', 'United States']];
const MAX_INPUT = 8000;

export const AI_KEYS = ['ai_enabled', 'ai_base_url', 'ai_api_key', 'ai_model', 'ai_data_location', 'ai_daily_limit'];

export function aiConfig(db) {
  const c = {
    enabled: getSetting(db, 'ai_enabled') === '1',
    baseUrl: (getSetting(db, 'ai_base_url') || '').replace(/\/+$/, ''),
    key: getSetting(db, 'ai_api_key'),
    model: getSetting(db, 'ai_model'),
    location: getSetting(db, 'ai_data_location'),
    dailyLimit: Number(getSetting(db, 'ai_daily_limit') || 100),
  };
  let problem = '';
  if (!c.baseUrl || !c.key || !c.model) problem = 'TatvaOS AI is not set up (needs an address, a key and a model name).';
  else if (!c.location) problem = 'TatvaOS AI is refused: say where the data goes (data location) before it can be used.';
  else {
    let host = '';
    try { host = new URL(c.baseUrl).host.toLowerCase(); } catch { problem = 'The TatvaOS AI address is not a valid web address.'; }
    for (const [h, country] of KNOWN_HOSTS) {
      if (host === h && !c.location.toLowerCase().includes(country.toLowerCase())) {
        problem = `TatvaOS AI is refused: that address is in ${country}, but the data location says "${c.location}".`;
      }
    }
    if (!problem && !/^https:\/\//.test(c.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(c.baseUrl + '/')) {
      problem = 'The TatvaOS AI address must start with https://.';
    }
  }
  return { ...c, ready: c.enabled && !problem, problem: c.enabled ? problem : 'TatvaOS AI is switched off in Settings.' };
}

const INSTRUCTION = `You help testers write clear reports for TatvaOS, a workplace software suite (mail, meetings, files, admin).
Rewrite the tester's rough draft so a developer can act on it without asking questions.
RULES:
- Never invent facts. If steps, the result, or the expectation are not in the draft, write "Not given — please add." in that section.
- Keep the tester's own facts, names of screens and exact error messages.
- Plain text only, no markdown symbols.
- For a bug, details must have these sections, each on its own line: "Steps to reproduce:", "What happened:", "What was expected:", "Other notes:". Number the steps.
- For a feature request, use: "What is needed:", "Why it helps:", "Who needs it:".
- title: specific, at most 100 characters, says where and what (e.g. "Mail search: Search button too small to see on desktop").
- type: "bug" or "feature". priority: "low", "medium", "high" or "critical" (critical = work stopped or data lost for many people).
- area: exactly one entry copied from the AREAS list, or null if none fits.
- missing: up to 4 short questions the tester should answer to complete the report.
Reply with JSON only: {"title": "", "details": "", "type": "", "priority": "", "area": null, "missing": []}`;

export async function improveReport(cfg, draft, areas) {
  const user = JSON.stringify({
    AREAS: areas,
    DRAFT: { type: draft.type, area: draft.area || null, title: draft.title, details: draft.details },
  }).slice(0, MAX_INPUT);
  return chatJson(cfg, INSTRUCTION, user);
}

// The one call to TatvaOS AI. Status only is reported on failure: the body can
// echo the text we sent, so it is never logged or passed on.
async function chatJson(cfg, instruction, user) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: instruction }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e && e.name === 'TimeoutError' ? 'TatvaOS AI took too long. Try again.' : 'TatvaOS AI could not be reached.' };
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    // Status only — the body can echo the report text.
    const why = res.status === 401 || res.status === 403 ? 'The TatvaOS AI key was refused. An admin should check Settings.'
      : res.status === 429 ? 'TatvaOS AI is busy or out of credit. Try again later.' : `TatvaOS AI answered with an error (${res.status}).`;
    return { ok: false, ms, status: res.status, error: why };
  }
  let text = '';
  try { text = (await res.json())?.choices?.[0]?.message?.content || ''; } catch { /* handled below */ }
  let out;
  try { out = JSON.parse(text); } catch { return { ok: false, ms, error: 'The TatvaOS AI answer could not be read. Try again.' }; }
  return { ok: true, ms, raw: out };
}

// Everything the model says is checked before the page sees it: unknown values
// are dropped, lengths capped, the area must be one we offered.
export function cleanSuggestion(raw, draft, areaMap) {
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const out = {
    title: s(raw.title, 200) || draft.title,
    details: s(raw.details, 20000) || draft.details,
    type: ['bug', 'feature'].includes(raw.type) ? raw.type : draft.type,
    priority: ['low', 'medium', 'high', 'critical'].includes(raw.priority) ? raw.priority : null,
    area: null,
    missing: Array.isArray(raw.missing) ? raw.missing.filter((q) => typeof q === 'string' && q.trim()).slice(0, 4).map((q) => q.trim().slice(0, 200)) : [],
  };
  if (typeof raw.area === 'string' && areaMap.has(raw.area)) out.area = { label: raw.area, ...areaMap.get(raw.area) };
  return out;
}

// ---- Summarise this issue (Amit, 26 Sept 2026: "for developers") ----------
//
// Sent: title, details, type, status, priority, module, and the history as
// {when, role, what, from, to, text}. People appear ONLY as their role
// (Tester / Developer / Admin) — never a name or email; no files; no other
// issues. Long histories keep the report and the NEWEST entries.
const SUMMARY_INSTRUCTION = `You summarise one issue from a software bug tracker for the developer who has to act on it.
RULES:
- Use only what is in the ISSUE. Never invent facts, causes or fixes.
- People appear only as roles (Tester, Developer, Admin); refer to them that way.
- Plain text, no markdown symbols.
- summary: 2 or 3 short sentences: what the problem is, what has happened so far, and where it stands now.
- next_step: one sentence saying what should happen next and who (by role) should do it.
- open_questions: up to 3 questions still unanswered in the history (empty list if none).
Reply with JSON only: {"summary": "", "next_step": "", "open_questions": []}`;

const MAX_ENTRY = 1500;
const MAX_SUMMARY_INPUT = 12000;

export function summaryPayload(issue, activity, roleLabel, statusLabel) {
  const entries = activity.map((a) => ({
    when: a.at.slice(0, 16).replace('T', ' ') + ' UTC',
    role: roleLabel[a.actor_role] || a.actor_role,
    what: a.kind,
    ...(a.from_status ? { from: statusLabel[a.from_status] } : {}),
    ...(a.to_status ? { to: statusLabel[a.to_status] } : {}),
    ...(a.body ? { text: a.body.slice(0, MAX_ENTRY) } : {}),
  }));
  const head = {
    title: issue.title, type: issue.type, status: statusLabel[issue.status], priority: issue.priority,
    area: issue.module_name + ' › ' + issue.submodule_name, details: issue.details.slice(0, 4000),
    ...(issue.fix_details ? { fix_details: issue.fix_details.slice(0, 2000) } : {}),
  };
  // Keep the first entry (the report) and as many of the newest as fit.
  let kept = entries.slice();
  let dropped = 0;
  const size = () => JSON.stringify({ ISSUE: head, HISTORY: kept }).length;
  while (size() > MAX_SUMMARY_INPUT && kept.length > 2) { kept.splice(1, 1); dropped++; }
  const out = { ISSUE: head, HISTORY: kept };
  if (dropped) out.NOTE = dropped + ' older history entries were left out for length.';
  return JSON.stringify(out).slice(0, MAX_SUMMARY_INPUT + 200);
}

export async function summariseIssue(cfg, payload) {
  return chatJson(cfg, SUMMARY_INSTRUCTION, payload);
}

export function cleanSummary(raw) {
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    summary: s(raw.summary, 1200),
    next_step: s(raw.next_step, 400),
    open_questions: Array.isArray(raw.open_questions) ? raw.open_questions.filter((q) => typeof q === 'string' && q.trim()).slice(0, 3).map((q) => q.trim().slice(0, 200)) : [],
  };
}
