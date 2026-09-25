// LOCAL TEST ONLY — the fake provider for tests/ai/mail-ai.test.mjs. Never a real key.
//   POST /v1/chat/completions → "REWRITTEN: <the user message, upper-cased>"
//   GET  /last  → { system, user } of the last completion: the witness for WHAT WAS SENT
//   GET  /hits  → how many completions were served
import http from 'node:http';
let hits = 0;
let last = null;
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/hits') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ hits }));
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
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'REWRITTEN: ' + user.toUpperCase() } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  });
}).listen(5199, '127.0.0.1', () => console.log('fake AI on :5199'));
