'use strict';

/**
 * Optional: real MongoDB Atlas integration. Runs ONLY when explicitly configured with a
 * dedicated test cluster/database. Never falls back to any other credentials.
 *
 *   ATLAS_TEST_URI="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/"
 *   ATLAS_TEST_DB="practice_platform_ci"   (a dedicated, disposable database)
 */
const { startMongo } = require('../helpers/mongo');
const { createTestContext } = require('../helpers/context');

const ATLAS_URI = process.env.ATLAS_TEST_URI;
const ATLAS_DB = process.env.ATLAS_TEST_DB;
const configured = Boolean(ATLAS_URI && ATLAS_DB);
const describeAtlas = configured ? describe : describe.skip;

if (!configured) {
  // eslint-disable-next-line no-console
  console.info('[atlas.optional] Skipped: set ATLAS_TEST_URI and ATLAS_TEST_DB to run real Atlas tests.');
}

describeAtlas('Real MongoDB Atlas (optional)', () => {
  let mongo;
  let ctx;
  beforeAll(async () => {
    if (/prod/i.test(ATLAS_DB)) throw new Error('Refusing to run Atlas tests against a database whose name contains "prod".');
    mongo = await startMongo();
    ctx = await createTestContext({ mongoUri: mongo.uri, overrides: { atlasAllowedHostSuffixes: ['.mongodb.net'], atlasConnectTimeoutMs: 15000 } });
  });
  afterAll(async () => {
    await ctx?.cleanup();
    await mongo?.stop();
  });

  test('connects, initializes the dedicated test database and runs a query', async () => {
    const s = await ctx.registerStudent('Atlas');
    const conn = await ctx.api.post('/api/connection').set(s.auth).send({ mode: 'atlas', connectionUrl: ATLAS_URI, database: ATLAS_DB });
    expect(conn.status).toBe(200);
    expect(JSON.stringify(conn.body)).not.toContain(ATLAS_URI);
    const init = await ctx.api.post('/api/workspace/initialize').set(s.auth).send({ confirm: true });
    expect(init.status).toBe(200);
    const q = await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.products.countDocuments({})' });
    expect(q.body.value).toBe(16);
    await ctx.api.delete('/api/connection').set(s.auth);
  }, 120000);
});
