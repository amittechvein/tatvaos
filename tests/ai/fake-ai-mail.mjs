// LOCAL TEST ONLY — the fake provider for tests/ai/mail-ai.test.mjs. Never a real key.
//   POST /v1/chat/completions
//     · a suggestions request (instruction says "suggest short replies") →
//         a JSON array of three replies; if the email contains FAKE:LINES, a
//         numbered list with a repeat and an over-long line instead (the
//         parser's fallback and its filters); FAKE:MARKUP puts HTML in one.
//     · a sorting request (instruction says "sort one incoming email") →
//         needs_reply by default; FAKE:PROMO → promotions; FAKE:FYI → a chatty
//         "Category: fyi."; FAKE:NOLABEL → an answer naming no label.
//     · anything else (Help me write) → "REWRITTEN: <the user message, upper-cased>"
//   GET  /last  → { system, user } of the last completion: the witness for WHAT WAS SENT
//   GET  /log   → every { system, user } since start, oldest first (the sorter sends several)
//   GET  /hits  → how many completions were served
//
//   node tests/ai/fake-ai-mail.mjs      (listens on 127.0.0.1:5199)
import http from 'node:http';
let hits = 0;
let last = null;
const log = [];
const answer = (system, user) => {
  if (system.includes('sort one incoming email')) {
    if (user.includes('FAKE:PROMO')) return 'promotions';
    if (user.includes('FAKE:FYI')) return 'Category: fyi.';
    if (user.includes('FAKE:NOLABEL')) return 'I cannot tell.';
    return 'needs_reply';
  }
  if (!system.includes('suggest short replies')) return 'REWRITTEN: ' + user.toUpperCase();
  if (user.includes('FAKE:LINES')) {
    return '1. Yes, that works for me.\n2) Yes, that works for me.\n- ' + 'x'.repeat(200) + '\n• Can we talk tomorrow?\n* Thanks, noted.';
  }
  if (user.includes('FAKE:MARKUP')) return '["<b>Sure</b> <img src=x onerror=alert(1)>", "Tell me more?", "Not this week."]';
  return 'Here you go: ["Yes, that works for me.", "Could you share more details?", "I will get back to you tomorrow."]';
};
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/hits') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hits }));
  if (req.method === 'GET' && req.url === '/log') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(log));
  if (req.method === 'GET' && req.url === '/last') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(last));
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!req.url?.endsWith('/chat/completions')) return res.writeHead(404).end();
    hits += 1;
    const msgs = JSON.parse(body).messages ?? [];
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const user = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    last = { system, user };
    log.push(last);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: answer(system, user) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  });
}).listen(5199, '127.0.0.1', () => console.log('fake AI on :5199'));
