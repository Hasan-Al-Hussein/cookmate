const path = require('node:path');
// Expo owns this dependency; npm may keep it nested after an SDK patch update.
// Resolve the preset's direct imports to the same copy selected by Expo itself.
const expoRoot = path.dirname(require.resolve('expo/package.json'));
const expoCoreRoot = path.dirname(
  require.resolve('expo-modules-core/package.json', { paths: [expoRoot] }),
);

module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  testMatch: ['**/src/**/*.test.ts', '**/src/**/*.test.tsx'],
  maxWorkers: 1,
  clearMocks: true,
  // Shared ESM imports name emitted .js files; Jest executes their TypeScript sources.
  moduleNameMapper: {
    '^expo-modules-core$': require.resolve('expo-modules-core', { paths: [expoRoot] }),
    '^expo-modules-core/(.*)$': path.join(expoCoreRoot, '$1'),
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Cold native module transforms on the shared laptop can exceed five seconds.
  // This harness timeout is unrelated to the product's native performance goals.
  testTimeout: 30000,
};
