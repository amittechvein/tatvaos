/**
 * A version-4 UUID for a chat line's clientId.
 *
 * The server keeps one copy of each chat line for the minutes and refuses a
 * clientId that is not a GUID (ConnectMinutesEndpoints.cs declares it as
 * Guid?). Duplicates are dropped on that id, which is the whole point of
 * sending one: a line re-posted after a reconnect is kept once.
 *
 * crypto.getRandomValues when the runtime has it; Math.random otherwise. A
 * de-duplication key is not a secret, and a collision here means one chat
 * line missing from the minutes, not a security failure.
 */
export function uuid4() {
  const b = new Uint8Array(16);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;   // version 4
  b[8] = (b[8] & 0x3f) | 0x80;   // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
