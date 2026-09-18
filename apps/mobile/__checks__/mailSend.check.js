// What actually goes up when an email is sent.
//
// The screen checks mock lib/mail, so nothing there ever built a real
// FormData — and the first real send from the phone failed in 8 ms with
// "Unsupported FormDataPart implementation", reported to the person as
// "Cannot reach TatvaOS". Expo SDK 54+ replaces global fetch with its own,
// which accepts only strings, Blobs and objects with bytes(); the
// { uri, name, type } shape every React Native example uses is refused.
//
// So this file checks the parts themselves.

const parts = [];
class FakeFormData {
  append(name, value) { parts.push([name, value]); }
}
global.FormData = FakeFormData;

// expo-file-system's File: a Blob with bytes(), which is what Expo's fetch
// can actually read. The fake records the uri it was built from.
// Named with the mock prefix jest requires for a factory to reference it.
const mockBuilt = [];
class mockFile {
  constructor(uri) { mockBuilt.push(uri); this.uri = uri; this.name = String(uri).split('/').pop(); }
  async bytes() { return new Uint8Array([1, 2, 3]); }
}
jest.mock('expo-file-system', () => ({ File: mockFile }));

const sent = [];
jest.mock('../api', () => ({
  API_BASE: 'https://core.tatvaos.com',
  request: jest.fn(async (path, opts) => { sent.push({ path, opts }); return { id: 'm9' }; }),
}));

const { send } = require('../lib/mail');

beforeEach(() => { parts.length = 0; mockBuilt.length = 0; sent.length = 0; });

const get = (name) => parts.filter(([n]) => n === name).map(([, v]) => v);

test('the fields the API expects, as the web composer sends them', async () => {
  await send('AT', { to: 'ravi@example.com', cc: 'p@x.com', subject: 'Hi', bodyText: 'text' });
  expect(get('to')).toEqual(['ravi@example.com']);
  expect(get('cc')).toEqual(['p@x.com']);
  expect(get('subject')).toEqual(['Hi']);
  expect(get('bodyText')).toEqual(['text']);
  expect(sent[0].path).toBe('/api/mail/send');
  expect(sent[0].opts.form).toBeInstanceOf(FakeFormData);
  expect(sent[0].opts.token).toBe('AT');
});

test('empty cc and no reply id are left OUT, not sent as empty strings', async () => {
  await send('AT', { to: 'ravi@example.com' });
  expect(get('cc')).toEqual([]);
  expect(get('inReplyToId')).toEqual([]);
});

test('a reply carries inReplyToId', async () => {
  await send('AT', { to: 'r@x.com', inReplyToId: 'm1' });
  expect(get('inReplyToId')).toEqual(['m1']);
});

test('AN ATTACHMENT GOES UP AS A FILE, not as { uri, name, type }', async () => {
  await send('AT', { to: 'r@x.com', files: [{ uri: 'file:///cache/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }] });
  const files = get('files');
  expect(files).toHaveLength(1);
  // The shape Expo's fetch refuses. If this ever becomes a plain object again,
  // sending an attachment fails on the phone and looks like a network error.
  expect(typeof files[0].bytes).toBe('function');
  expect(files[0]).toBeInstanceOf(mockFile);
  expect(mockBuilt).toEqual(['file:///cache/a.pdf']);
});

test('a file the picker could not give a uri for is named, not sent as nothing', async () => {
  await expect(send('AT', { to: 'r@x.com', files: [{ name: 'photo.jpg' }] }))
    .rejects.toThrow(/photo\.jpg/);
  expect(sent).toHaveLength(0);
});

test('sending is given a long timeout — an attachment is not a 15-second call', async () => {
  await send('AT', { to: 'r@x.com' });
  expect(sent[0].opts.timeoutMs).toBeGreaterThanOrEqual(60000);
});
