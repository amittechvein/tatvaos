// The stock Expo babel config. Written out because jest-expo does not apply it by default.
module.exports = function (api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
