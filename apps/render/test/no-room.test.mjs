// Which refusal a full /tmp gets (docs/DOCS_PDF_DESIGN.md §10). The sizes are
// case 0's measured ones: 16 MB of tmpfs, phone photos of 4.6 MB, and a PDF as
// big as its JPEGs (Typst puts them in unchanged), so a job needs 2 x its
// pictures. The container proves it end to end (container-test.sh §8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noRoomReason } from '../src/render-pdf.mjs';

const TMP = 16 * 1024 * 1024;
const PHOTO = 4_600_000;

test('a job whose own pictures can never fit is told to remove some', () => {
  assert.equal(noRoomReason(2 * PHOTO, TMP), 'pictures_too_large', '2 photos + their PDF > 16 MB (case 0: refused at Typst)');
  assert.equal(noRoomReason(8 * PHOTO, TMP), 'pictures_too_large');
});

test('a job that would have fitted on its own is NOT told to remove pictures', () => {
  // Cases 2 and 3: ten one-photo PDFs at once; the others' files filled /tmp.
  assert.equal(noRoomReason(PHOTO, TMP), 'no_room', '1 photo + its PDF fits in 16 MB (case 0: built)');
  assert.equal(noRoomReason(0, TMP), 'no_room', 'no pictures at all');
});

test('the boundary is the job needing more than the whole of /tmp', () => {
  assert.equal(noRoomReason(TMP / 2, TMP), 'no_room', 'exactly half: pictures + PDF just fit');
  assert.equal(noRoomReason(TMP / 2 + 1, TMP), 'pictures_too_large');
});

test('when /tmp cannot be measured, nobody is told to remove pictures', () => {
  assert.equal(noRoomReason(8 * PHOTO, Infinity), 'no_room');
});
