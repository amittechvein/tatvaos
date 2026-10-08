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

// Typst quotes source values in its messages, so the disk-full test must not
// read a document's own words as the OS error (Mr. Singh, 8 Oct 2026).
import { typstSaysNoRoom, TYPST_NO_ROOM } from '../src/render-pdf.mjs';

test("Typst's real disk-full message is recognised", () => {
  assert.equal(typstSaysNoRoom('error: failed to write PDF file (No space left on device (os error 28))'), true);
  assert.equal(typstSaysNoRoom('error: failed to write PDF file (os error 28)'), true);
});

test('the same words inside a quoted document value are NOT a full /tmp', () => {
  const quoted = 'error: unknown variable: "no space left on device"\n  ┌─ main.typ:12:3';
  assert.equal(typstSaysNoRoom(quoted), false);
  // Calibration: the raw-text check this replaces WAS fooled by it.
  assert.equal(TYPST_NO_ROOM.test(quoted), true, 'the old check matched the quoted words - the reason for the change');
});
