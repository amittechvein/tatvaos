#!/usr/bin/env node
// Verifies an ID token the way a relying party does (decision 0004, test
// step 1): signature against the published key set, by the matching kid,
// then iss, aud, nonce, exp, sub and tid against what the script expects.
//
//   node verify-id-token.js <id_token> <jwks.json> <iss> <aud> <nonce> <sub> <tid>
//
// Prints "ok" and exits 0, or one line naming the first thing that is wrong
// and exits 1. Node's crypto imports a JWK directly, so this has no
// dependency — the CI runner and the laptop both have node.
//
// Prints NOTHING of the token itself: a claim value, yes; the token, never.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

const [token, jwksPath, iss, aud, nonce, sub, tid] = process.argv.slice(2);
if (!token || !jwksPath) { console.log('usage'); process.exit(2); }

function b64url(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
const parts = token.split('.');
if (parts.length !== 3) { console.log('not a JWS: expected three parts'); process.exit(1); }
const header = JSON.parse(b64url(parts[0]).toString('utf8'));
const payload = JSON.parse(b64url(parts[1]).toString('utf8'));

if (header.alg !== 'RS256') { console.log(`alg is ${header.alg}, not RS256`); process.exit(1); }
const jwks = JSON.parse(fs.readFileSync(jwksPath, 'utf8'));
const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
if (!jwk) { console.log(`kid ${header.kid} is not in the key set`); process.exit(1); }
for (const p of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
  if (p in jwk) { console.log(`the key set publishes a private parameter (${p})`); process.exit(1); }
}
const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, b64url(parts[2]));
if (!ok) { console.log('signature does not verify'); process.exit(1); }

const now = Math.floor(Date.now() / 1000);
const checks = [
  ['iss', payload.iss, iss],
  ['aud', Array.isArray(payload.aud) ? payload.aud.join(' ') : payload.aud, aud],
  ['nonce', payload.nonce, nonce],
  ['sub', payload.sub, sub],
  ['tid', payload.tid, tid],
];
for (const [name, got, want] of checks) {
  if (want === undefined) continue;
  if (got !== want) { console.log(`${name} is ${got}, expected ${want}`); process.exit(1); }
}
if (typeof payload.exp !== 'number' || payload.exp <= now) { console.log('exp is in the past'); process.exit(1); }
if (payload.exp - now > 6 * 60) { console.log(`exp is ${payload.exp - now}s away; ID tokens live five minutes`); process.exit(1); }
if (payload.sub && payload.email && payload.sub === payload.email) { console.log('sub is the email'); process.exit(1); }
console.log('ok');
