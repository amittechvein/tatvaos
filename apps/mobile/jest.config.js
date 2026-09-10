// Render-level checks for the screens, with the native SDK and the API
// replaced by steerable fakes. See __checks__/README.md for what these prove
// and — more importantly — what they cannot.
module.exports = {
  preset: 'jest-expo/android',
  setupFilesAfterEnv: ['<rootDir>/__checks__/setup.js'],
  testMatch: ['**/__checks__/**/*.check.js'],
};
