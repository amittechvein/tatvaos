// Render-level checks for the screens, with the native SDK and the API
// replaced by steerable fakes. See __checks__/README.md for what these prove
// and — more importantly — what they cannot.
module.exports = {
  preset: 'jest-expo/android',
  setupFilesAfterEnv: ['<rootDir>/__checks__/setup.js'],
  testMatch: ['**/__checks__/**/*.check.js'],
  // jest's default is 5 s per test, and the FIRST test of each suite pays for
  // loading the screen and its fakes. 15 Sept 2026, on the 15 GB laptop with the
  // emulator booting: both suites failed their first test on "Exceeded timeout
  // of 5000 ms" and all 23 passed on a rerun with 30 s — a red that said nothing
  // about the app. A genuinely stuck check still fails, just later.
  testTimeout: 30000,
};
