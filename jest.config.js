// Suíte JS (jest-expo). Só lógica de serviços; sem rede, sem relógio real.
// https://docs.expo.dev/develop/unit-testing/
const preset = require('jest-expo/jest-preset');

module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts?(x)'],
  // @noble/* é ESM puro: precisa passar pelo Babel (jest não carrega ESM em CJS sozinho).
  transformIgnorePatterns: [
    preset.transformIgnorePatterns[0].replace('(?!(', '(?!(@noble|'),
    ...preset.transformIgnorePatterns.slice(1),
  ],
  testTimeout: 15000,
};
