/**
 * Runs the rejection-reading logic against the shapes actually observed, and
 * proves it can go red before believing the greens.
 *
 *     node apps/mobile/lib/refusal.check.js
 *
 * Exit 0 = all good. Exit 1 = something is wrong and the message says what.
 * No test runner, no dependency: it reads refusal.js, strips the `export`
 * keywords and evaluates it, so it tests THE SHIPPED SOURCE rather than a copy
 * that can drift away from it.
 *
 * The last check is the one that matters. It asserts that the standard
 * `err.name === 'NotAllowedError'` test — the one every example writes — FAILS
 * on the refusal Android actually produces. If that ever starts passing, the
 * library has been fixed upstream, isRefusal can be simplified, and the long
 * comment in refusal.js has become a lie. Delete both together.
 */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'refusal.js');
const source = fs.readFileSync(file, 'utf8').replace(/\bexport\s+/g, '');
eval(source); // defines isRefusal and describeError

// The check everyone writes, kept here only so it can be shown to fail.
const standardW3CCheck = (err) => (err && err.name) === 'NotAllowedError';

const cases = [
  ['the refusal Android actually produces', { name: 'Error', message: 'NotAllowedError' }, true],
  ['the W3C shape, if this is ever fixed', { name: 'NotAllowedError', message: 'Permission denied' }, true],
  ['a worded refusal', { name: 'Error', message: 'User cancelled the request' }, true],
  ['a network failure is NOT a refusal', { name: 'TypeError', message: 'Network request failed' }, false],
  ['a missing track is NOT a refusal', { name: 'Error', message: 'no track in the returned stream' }, false],
  ['undefined does not throw', undefined, false],
  ['null does not throw', null, false],
];

let failures = 0;

for (const [label, err, expected] of cases) {
  let actual;
  try {
    actual = isRefusal(err);
  } catch (e) {
    actual = `THREW: ${e.message}`;
  }
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${actual}`);
}

const naive = standardW3CCheck({ name: 'Error', message: 'NotAllowedError' });
const calibrated = naive === false;
if (!calibrated) failures += 1;
console.log();
console.log(`  ${calibrated ? 'PASS' : 'FAIL'}  CALIBRATION: the standard err.name check misses the real refusal -> ${naive}`);
if (!calibrated) {
  console.log('        If this fails, upstream has changed. Simplify isRefusal and delete');
  console.log('        the comment in refusal.js that says otherwise — it is now wrong.');
}

console.log();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
