'use strict';

/**
 * Isolated MongoDB for integration/e2e tests.
 *  - Default: a throw-away mongod started by mongodb-memory-server (no Docker, no Atlas).
 *  - MONGODB_TEST_URI: use an existing local/Docker instance instead (each test file still
 *    uses unique database names and drops them afterwards).
 * Fails loudly (never skips) when MongoDB cannot be started.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

async function startMongo({ auth = false } = {}) {
  if (process.env.MONGODB_TEST_URI && !auth) {
    return { uri: process.env.MONGODB_TEST_URI, stop: async () => {} };
  }
  try {
    const server = await MongoMemoryServer.create(
      auth ? { auth: { enable: true, customRootName: 'root', customRootPwd: 'root-test-password' } } : {},
    );
    const uri = server.getUri();
    const authUri = auth ? uri.replace('mongodb://', 'mongodb://root:root-test-password@') : uri;
    return { uri: authUri, plainUri: uri, stop: () => server.stop() };
  } catch (err) {
    throw new Error(
      `PREREQUISITE MISSING: could not start a local MongoDB for tests (${err.message}). ` +
        'Ensure internet access for the first mongod download, or set MONGODB_TEST_URI to a running MongoDB ' +
        '(e.g. docker compose up -d mongo  ->  MONGODB_TEST_URI=mongodb://127.0.0.1:27017).',
    );
  }
}

module.exports = { startMongo };
