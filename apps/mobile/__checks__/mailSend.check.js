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

// ── THE PROGRESS BAR'S TRANSPORT ────────────────────────────────────────────
//  Amit, 18 Sept 2026: "give progress bar that attachment that much % is
//  uploaded". fetch cannot report upload progress — no browser's can, and
//  Expo's replacement is no different — so a send WITH files and a progress
//  callback goes over XMLHttpRequest, which in React Native is the native
//  uploader.
//
//  That means the part shape flips back to { uri, name, type }: the shape RN's
//  own uploader wants, and the shape Expo's fetch refused. Getting this
//  backwards is what cost the 8 ms failure, so it is checked in both
//  directions — the plain path above must still send File objects.
describe('uploading with progress', () => {
  let xhrs = [];

  class FakeXHR {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.status = 200;
      this.responseText = '{"id":"m9"}';
      xhrs.push(this);
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k.toLowerCase()] = v; }
    send(form) { this.sentForm = form; this.run?.(this); }
  }

  beforeEach(() => { xhrs = []; global.XMLHttpRequest = FakeXHR; });
  afterEach(() => { delete global.XMLHttpRequest; });

  // Drives one upload: two progress ticks, then the response.
  const drive = (xhr) => {
    xhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 200 });
    xhr.upload.onprogress({ lengthComputable: true, loaded: 200, total: 200 });
    xhr.onload();
  };

  const file = { uri: 'file:///cache/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' };

  test('a send with files and a callback goes over XHR, not fetch', async () => {
    FakeXHR.prototype.run = drive;
    const seen = [];
    const out = await send('AT', { to: 'r@x.com', files: [file] }, (f) => seen.push(f));
    expect(xhrs).toHaveLength(1);
    expect(sent).toHaveLength(0);                 // api.js request() was NOT used
    expect(out).toEqual({ id: 'm9' });
    expect(xhrs[0].method).toBe('POST');
    expect(xhrs[0].url).toMatch(/\/api\/mail\/send$/);
  });

  test('the fractions climb and end at exactly 1', async () => {
    FakeXHR.prototype.run = drive;
    const seen = [];
    await send('AT', { to: 'r@x.com', files: [file] }, (f) => seen.push(f));
    expect(seen[0]).toBeCloseTo(0.25);
    expect(seen[1]).toBeCloseTo(1);
    expect(seen[seen.length - 1]).toBe(1);        // the bar must not stop at 99%
  });

  test('a body of unknown size reports null, not a made-up number', async () => {
    FakeXHR.prototype.run = (xhr) => {
      xhr.upload.onprogress({ lengthComputable: false, loaded: 50, total: 0 });
      xhr.onload();
    };
    const seen = [];
    await send('AT', { to: 'r@x.com', files: [file] }, (f) => seen.push(f));
    expect(seen[0]).toBeNull();
  });

  test('THE PART SHAPE FLIPS: RN wants { uri, name, type }, not a File', async () => {
    FakeXHR.prototype.run = drive;
    await send('AT', { to: 'r@x.com', files: [file] }, () => {});
    const files = parts.filter(([n]) => n === 'files').map(([, v]) => v);
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      uri: 'file:///cache/a.pdf', name: 'a.pdf', type: 'application/pdf',
    });
    expect(mockBuilt).toEqual([]);                // no expo File was built
  });

  test('the token is carried and the boundary is left to the uploader', async () => {
    FakeXHR.prototype.run = drive;
    await send('AT', { to: 'r@x.com', files: [file] }, () => {});
    expect(xhrs[0].headers.authorization).toBe('Bearer AT');
    // Setting Content-Type by hand is how the multipart boundary goes missing.
    expect(xhrs[0].headers['content-type']).toBeUndefined();
  });

  test('empty cc is still left out entirely', async () => {
    FakeXHR.prototype.run = drive;
    await send('AT', { to: 'r@x.com', cc: '', files: [file] }, () => {});
    expect(parts.filter(([n]) => n === 'cc')).toEqual([]);
  });

  test('a refusal from the API is shown in its own words', async () => {
    FakeXHR.prototype.run = (xhr) => {
      xhr.status = 413;
      xhr.responseText = '{"error":"That attachment is too big."}';
      xhr.onload();
    };
    await expect(send('AT', { to: 'r@x.com', files: [file] }, () => {}))
      .rejects.toThrow('That attachment is too big.');
  });

  test('A FAILED SEND IS NEVER RETRIED DOWN THE OTHER PATH', async () => {
    // It may already have arrived. Sending twice is worse than no progress bar.
    FakeXHR.prototype.run = (xhr) => { xhr.status = 500; xhr.responseText = '{}'; xhr.onload(); };
    await expect(send('AT', { to: 'r@x.com', files: [file] }, () => {})).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  test('a dead connection and a timeout say different, actionable things', async () => {
    FakeXHR.prototype.run = (xhr) => xhr.onerror();
    await expect(send('AT', { to: 'r@x.com', files: [file] }, () => {}))
      .rejects.toThrow(/Cannot reach TatvaOS/);
    FakeXHR.prototype.run = (xhr) => xhr.ontimeout();
    await expect(send('AT', { to: 'r@x.com', files: [file] }, () => {}))
      .rejects.toThrow(/too long|smaller attachment/);
  });

  test('no callback, or no files: the proven fetch path, with File objects', async () => {
    FakeXHR.prototype.run = drive;
    await send('AT', { to: 'r@x.com', files: [file] });            // no callback
    expect(xhrs).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(mockBuilt).toEqual(['file:///cache/a.pdf']);

    await send('AT', { to: 'r@x.com' }, () => {});                 // no files
    expect(xhrs).toHaveLength(0);
    expect(sent).toHaveLength(2);
  });

  test('a file the picker gave no uri is named, and nothing is sent twice', async () => {
    FakeXHR.prototype.run = drive;
    await expect(send('AT', { to: 'r@x.com', files: [{ name: 'photo.jpg' }] }, () => {}))
      .rejects.toThrow(/photo\.jpg/);
    expect(xhrs[0]?.sentForm).toBeUndefined();   // nothing left the phone
    expect(sent).toHaveLength(0);
  });
});
