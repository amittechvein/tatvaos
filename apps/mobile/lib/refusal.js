/**
 * Reading a screen-capture rejection. Deliberately free of any React Native
 * import, so it can be run by plain `node` — see refusal.check.js beside it.
 *
 * ---------------------------------------------------------------------------
 *  THE TRAP THIS FILE EXISTS FOR.
 *
 *  The W3C shape is `err.name === 'NotAllowedError'`, and every example
 *  anywhere writes exactly that. On this stack it SILENTLY NEVER MATCHES.
 *
 *  Measured 9 September 2026, Android API 36,
 *  @livekit/react-native-webrtc 144.1.2: refusing consent rejects with
 *
 *      { name: 'Error', message: 'NotAllowedError' }
 *
 *  — the name is the generic string and the meaning is in the message. So the
 *  standard check returns false for a real refusal, the denial falls through
 *  to whatever generic branch is last, and the person is told the wrong thing
 *  about their own decision. Which is this codebase's signature failure: not a
 *  crash, just the wrong story.
 *
 *  `MediaStreamError` is also NOT an Error subclass — no `.stack`, and
 *  `instanceof Error` is false. Do not reach for either.
 * ---------------------------------------------------------------------------
 */

export function isRefusal(err) {
  const name = err?.name ?? '';
  const message = err?.message ?? '';
  return name === 'NotAllowedError'
    || message === 'NotAllowedError'
    || /permission|denied|not ?allowed|user cancel/i.test(message);
}

export function describeError(err) {
  const name = err?.name ?? 'unknown';
  const message = err?.message ?? String(err);
  return `name=${name} message=${message}`;
}
