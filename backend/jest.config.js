'use strict';

const common = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/helpers/setupEnv.js'],
};

module.exports = {
  // Separate configurations: unit tests use mocks only; integration and e2e tests need MongoDB.
  projects: [
    { ...common, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.js'] },
    { ...common, displayName: 'integration', testMatch: ['<rootDir>/tests/integration/**/*.test.js'], slowTestThreshold: 15 },
    { ...common, displayName: 'e2e', testMatch: ['<rootDir>/tests/e2e/**/*.test.js'], slowTestThreshold: 30 },
  ],
  collectCoverageFrom: ['src/**/*.js', '!src/server.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'text', 'html', 'json-summary'],
  testTimeout: 60000,
};
