// Picture shrinking before Typst (Mr. Singh's ruling of 9 Oct 2026;
// render-pdf.mjs "PICTURES ARE SHRUNK"). The pure parts, here; the shrinking
// itself, the 6 MB cap at full size and the location check run in the real
// container (tests/docs-render/container-test.sh §8 and §9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PICTURE_MAX_SIDE, PICTURE_JPEG_QUALITY, PICTURES_CAP_BYTES, SHRUNK_KIND,
  overPictureCap, shrinkTarget, templateInput,
} from '../src/render-pdf.mjs';

test('the ruled numbers: 1,600 px, JPEG quality 82, 6 MB after shrinking', () => {
  assert.equal(PICTURE_MAX_SIDE, 1600);
  assert.equal(PICTURE_JPEG_QUALITY, 82);
  assert.equal(PICTURES_CAP_BYTES, 6 * 1024 * 1024);
  assert.equal(overPictureCap(PICTURES_CAP_BYTES), false, 'exactly the cap fits');
  assert.equal(overPictureCap(PICTURES_CAP_BYTES + 1), true);
});

test('every output strips ALL metadata (keep=none); only JPEG takes a quality', () => {
  assert.equal(shrinkTarget('/tmp/pdf-x/pic-0.jpg', 'jpg'), '/tmp/pdf-x/pic-0.jpg[Q=82,keep=none]');
  assert.equal(shrinkTarget('/tmp/pdf-x/pic-1.png', 'png'), '/tmp/pdf-x/pic-1.png[keep=none]');
});

test('photos become JPEG, lossless kinds PNG; the template is given the SHRUNK file\'s name', () => {
  assert.deepEqual(SHRUNK_KIND, { jpg: 'jpg', webp: 'jpg', png: 'png', gif: 'png' });
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const img = (src) => ({ type: 'paragraph', content: [{ type: 'image', attrs: { src } }] });
  const json = { type: 'doc', content: [img('/api/a'), img('/api/b'), img('/api/c'), img('/api/d'), img('/api/a')] };
  const { data, files } = templateInput(json, new Map([['/api/a', jpg], ['/api/b', webp], ['/api/c', gif], ['/api/d', svg]]));
  assert.deepEqual(files.map((f) => [f.name, f.kind]), [['pic-0.jpg', 'jpg'], ['pic-1.jpg', 'webp'], ['pic-2.png', 'gif']],
    'the SVG is not a picture kind and is left out, as before; the repeated one is used once');
  const names = data.doc.content.map((p) => p.content[0].attrs._pic ?? null);
  assert.deepEqual(names, ['pic-0.jpg', 'pic-1.jpg', 'pic-2.png', null, 'pic-0.jpg']);
});
