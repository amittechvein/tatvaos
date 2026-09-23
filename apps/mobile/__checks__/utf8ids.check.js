// UTF-8 for the data channel, and GUIDs for chat lines.
//
// The old decode (String.fromCharCode per byte) passed every ASCII check and
// garbled every emoji and every Hindi word. These use the bytes the WEB would
// produce, so the two ends cannot drift.

const { encodeUtf8, decodeUtf8, packJson, unpackJson } = require('../lib/utf8');
const { uuid4 } = require('../lib/ids');

// Node's own encoder is the reference — it is what a browser's TextEncoder does.
const ref = (s) => Uint8Array.from(Buffer.from(s, 'utf8'));

describe('utf8', () => {
  test.each([
    ['ascii', 'hello'],
    ['a reaction', '👍'],
    ['a Hindi line', 'नमस्ते, मीटिंग शुरू करते हैं'],
    ['mixed', 'ok 👏 ठीक है — “quotes”'],
    ['empty', ''],
  ])('%s: encodes exactly as the web would, and round-trips', (_, s) => {
    expect(Array.from(encodeUtf8(s))).toEqual(Array.from(ref(s)));
    expect(decodeUtf8(encodeUtf8(s))).toBe(s);
    expect(decodeUtf8(ref(s))).toBe(s);
  });

  test('THE OLD DECODE WOULD HAVE GARBLED THIS', () => {
    // What the meeting screen did until 23 Sept 2026.
    const old = (bytes) => { let t = ''; for (let i = 0; i < bytes.length; i++) t += String.fromCharCode(bytes[i]); return t; };
    const bytes = ref('{"react":"👍"}');
    expect(old(bytes)).not.toBe('{"react":"👍"}');
    expect(decodeUtf8(bytes)).toBe('{"react":"👍"}');
  });

  test('malformed bytes become U+FFFD instead of throwing', () => {
    expect(decodeUtf8(Uint8Array.from([0xff, 0x41]))).toBe('�A');
    expect(decodeUtf8(Uint8Array.from([0xe0, 0x41]))).toBe('�A');
    expect(decodeUtf8(Uint8Array.from([0xf0, 0x9f]))).toBe('�');
  });

  test('a lone surrogate encodes as U+FFFD, like the standard', () => {
    expect(Array.from(encodeUtf8('\ud83d'))).toEqual([0xef, 0xbf, 0xbd]);
  });

  test('packJson / unpackJson carry a message the way the web does', () => {
    const msg = { text: 'नमस्ते 👋', cid: 'x', at: '2026-09-23T11:00:00Z' };
    const bytes = packJson(msg);
    expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toEqual(msg);
    expect(unpackJson(bytes)).toEqual(msg);
    expect(unpackJson(ref('not json'))).toBeNull();
    expect(unpackJson(Uint8Array.from([]))).toBeNull();
  });
});

describe('uuid4', () => {
  const SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  test('is a GUID the server will accept, every time', () => {
    for (let i = 0; i < 200; i++) expect(uuid4()).toMatch(SHAPE);
  });
  test('does not repeat', () => {
    expect(new Set(Array.from({ length: 500 }, uuid4)).size).toBe(500);
  });
  test('works without crypto too (a bare Hermes)', () => {
    const saved = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try { expect(uuid4()).toMatch(SHAPE); }
    finally { Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true }); }
  });
});
