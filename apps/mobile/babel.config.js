// The stock Expo babel config — what `create-expo-app` writes. Metro applies
// this same preset by default when the file is absent; it is written out here
// because jest-expo's per-platform presets do NOT apply it by default, and
// without it the checks in __checks__/ cannot parse React Native's own Flow-
// typed test setup. No effect on the app bundle.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
