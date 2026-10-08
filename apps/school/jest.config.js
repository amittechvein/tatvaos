// Unit checks for the app's own logic (SRS section 12: "Unit tests for API client,
// permissions and offline sync"). Screens are checked on a phone or emulator.
module.exports = {
  preset: "jest-expo/android",
  testMatch: ["**/__tests__/**/*.test.ts"],
  testTimeout: 30000,
};
