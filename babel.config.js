module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // react-native-reanimated/plugin DEVE ser o último plugin
      'react-native-reanimated/plugin',
    ],
  };
};
