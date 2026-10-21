'use strict';

const { createMongoClient } = require('../../src/db/createClient');
const logger = require('../../src/utils/logger');
const { startMongo } = require('../helpers/mongo');
const { createTestContext } = require('../helpers/context');

/**
 * The "Atlas" side is simulated by a second, auth-enabled local mongod reachable at 127.0.0.1.
 * Failure modes that need a real network (timeouts, IP access list) are simulated with a
 * mocked client factory for specific fake hostnames.
 */
let platform;
let atlas;
let ctx;
let root;
let atlasPort;
const logLines = [];
let removeSink;

const ATLAS_DB = 'student_practice';
const STUDENT_DB_USER = { user: 'atlas_student', pwd: 'Atl@s-Student-Pw1' };
const ADMIN_DB_USER = { user: 'atlas_admin', pwd: 'Atl@s-Admin-Pw1' };

function clientFactory(uri, opts) {
  if (uri.includes('timeout-sim.mongodb.net')) {
    return {
      connect: async () => {
        throw Object.assign(new Error('Server selection timed out after 1500 ms'), { name: 'MongoServerSelectionError' });
      },
      close: async () => {},
    };
  }
  if (uri.includes('ipblocked-sim.mongodb.net')) {
    return {
      connect: async () => {
        throw Object.assign(
          new Error("Could not connect to any servers in your MongoDB Atlas cluster. One common reason is that you're trying to access the database from an IP that isn't whitelisted."),
          { name: 'MongoServerSelectionError' },
        );
      },
      close: async () => {},
    };
  }
  return createMongoClient(uri, opts);
}

const atlasBody = (overrides = {}) => ({
  mode: 'atlas',
  connectionUrl: `mongodb://<username>:<password>@127.0.0.1:${atlasPort}/?authSource=${ATLAS_DB}`,
  username: STUDENT_DB_USER.user,
  password: STUDENT_DB_USER.pwd,
  database: ATLAS_DB,
  ...overrides,
});

const responses = [];
const track = (res) => {
  responses.push(JSON.stringify(res.body));
  return res;
};

beforeAll(async () => {
  removeSink = logger.addSink((line) => logLines.push(line));
  platform = await startMongo();
  atlas = await startMongo({ auth: true });
  atlasPort = new URL(atlas.plainUri).port;
  root = await createMongoClient(atlas.uri).connect();
  const sdb = root.db(ATLAS_DB);
  await sdb.command({ createUser: STUDENT_DB_USER.user, pwd: STUDENT_DB_USER.pwd, roles: [{ role: 'readWrite', db: ATLAS_DB }] });
  await root.db('admin').command({ createUser: ADMIN_DB_USER.user, pwd: ADMIN_DB_USER.pwd, roles: ['root'] });
  await sdb.collection('personal_notes').insertOne({ note: 'student data that must never be touched' });
  ctx = await createTestContext({ mongoUri: platform.uri, clientFactory });
});

afterAll(async () => {
  removeSink?.();
  await root?.close();
  await ctx?.cleanup();
  await atlas?.stop();
  await platform?.stop();
});

describe('B. MongoDB connection management', () => {
  test('valid local (simulated) database connection', async () => {
    const s = await ctx.registerStudent('Local');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send({ mode: 'local' }));
    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ mode: 'local', status: 'connected', host: 'local-simulation' });
    const t = track(await ctx.api.post('/api/connection/test').set(s.auth));
    expect(t.status).toBe(200);
    expect(t.body.connection.status).toBe('connected');
  });

  test('valid Atlas URL format connects and reports which practice collections are missing', async () => {
    const s = await ctx.registerStudent('AtlasOk');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody()));
    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ mode: 'atlas', status: 'connected', host: '127.0.0.1', database: ATLAS_DB });
    expect(res.body.connection.missingCollections).toEqual(['students', 'products', 'orders', 'employees', 'courses']);
    const ws = track(await ctx.api.get('/api/workspace').set(s.auth));
    expect(ws.body.workspace.status).toBe('needs_initialization');
  });

  test('Atlas workspace is only initialized with explicit confirmation and only touches practice collections', async () => {
    const s = await ctx.registerStudent('AtlasInit');
    await ctx.api.post('/api/connection').set(s.auth).send(atlasBody());
    const noConfirm = track(await ctx.api.post('/api/workspace/initialize').set(s.auth).send({}));
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error.code).toBe('CONFIRMATION_REQUIRED');
    const ok = track(await ctx.api.post('/api/workspace/initialize').set(s.auth).send({ confirm: true }));
    expect(ok.status).toBe(200);
    const q = track(await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.students.countDocuments({})' }));
    expect(q.body.value).toBe(12);
    // Data really lives in the student's own database; unrelated collections untouched.
    expect(await root.db(ATLAS_DB).collection('students').countDocuments()).toBe(12);
    expect(await root.db(ATLAS_DB).collection('personal_notes').countDocuments()).toBe(1);
  });

  test.each([
    ['http://cluster0.abcde.mongodb.net/', 'INVALID_URL'],
    ['cluster0.abcde.mongodb.net', 'INVALID_URL'],
    ['mongodb+srv://', 'INVALID_URL'],
  ])('invalid URL format %p -> %s', async (connectionUrl, code) => {
    const s = await ctx.registerStudent('BadUrl');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ connectionUrl })));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  test('missing username or password', async () => {
    const s = await ctx.registerStudent('NoCreds');
    const noUser = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ username: '', connectionUrl: `mongodb://127.0.0.1:${atlasPort}/` })));
    const noPass = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ password: undefined })));
    expect(noUser.body.error.code).toBe('MISSING_CREDENTIALS');
    expect(noPass.body.error.code).toBe('MISSING_CREDENTIALS');
  });

  test('incorrect credentials', async () => {
    const s = await ctx.registerStudent('WrongPw');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ password: 'Wrong-Password-99' })));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_FAILED');
    expect(res.body.error.message).toMatch(/Database Access/);
  });

  test('invalid hostname', async () => {
    const s = await ctx.registerStudent('BadHost');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ connectionUrl: 'mongodb://no-such-cluster.invalid:27017/' })));
    expect(res.body.error.code).toBe('HOST_NOT_FOUND');
  });

  test('host outside the Atlas allowlist is rejected before any network call', async () => {
    const s = await ctx.registerStudent('Ssrf');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ connectionUrl: 'mongodb://169.254.169.254:27017/' })));
    expect(res.body.error.code).toBe('HOST_NOT_ALLOWED');
  });

  test('connection timeout (simulated)', async () => {
    const s = await ctx.registerStudent('Timeout');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ connectionUrl: 'mongodb+srv://timeout-sim.mongodb.net/' })));
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('TIMEOUT');
  });

  test('network access denied (simulated Atlas IP access list)', async () => {
    const s = await ctx.registerStudent('IpBlocked');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ connectionUrl: 'mongodb+srv://ipblocked-sim.mongodb.net/' })));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NETWORK_ACCESS_DENIED');
    expect(res.body.error.message).toMatch(/Network Access/);
  });

  test('database unavailable (nothing listening)', async () => {
    const s = await ctx.registerStudent('Down');
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ connectionUrl: 'mongodb://127.0.0.1:1/' })));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
  });

  test('administrator-level database users are refused', async () => {
    const s = await ctx.registerStudent('Admin');
    const res = track(
      await ctx.api.post('/api/connection').set(s.auth).send(
        atlasBody({ username: ADMIN_DB_USER.user, password: ADMIN_DB_USER.pwd, connectionUrl: `mongodb://127.0.0.1:${atlasPort}/?authSource=admin` }),
      ),
    );
    expect(res.body.error.code).toBe('ADMIN_CREDENTIALS_NOT_ALLOWED');
  });

  test('a failed connection attempt does not replace a working connection', async () => {
    const s = await ctx.registerStudent('KeepWorking');
    await ctx.api.post('/api/connection').set(s.auth).send({ mode: 'local' });
    await ctx.api.post('/api/connection').set(s.auth).send(atlasBody({ password: 'bad-password-1' }));
    const res = track(await ctx.api.get('/api/connection').set(s.auth));
    expect(res.body.connection).toMatchObject({ mode: 'local', status: 'connected' });
  });

  test('connection replacement closes the previous pooled client', async () => {
    const s = await ctx.registerStudent('Replace');
    await ctx.api.post('/api/connection').set(s.auth).send(atlasBody());
    await ctx.api.post('/api/workspace/initialize').set(s.auth).send({ confirm: true });
    await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.students.findOne({})' });
    const key = `atlas:${s.user.id}`;
    expect(ctx.services.connections.pool.has(key)).toBe(true);
    const res = track(await ctx.api.post('/api/connection').set(s.auth).send({ mode: 'local' }));
    expect(res.body.connection.mode).toBe('local');
    expect(ctx.services.connections.pool.has(key)).toBe(false);
    // Local workspace must be initialized before queries run again.
    const q = track(await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.students.findOne({})' }));
    expect(q.status).toBe(409);
    expect(q.body.error.code).toBe('WORKSPACE_NOT_READY');
  });

  test('disconnect and reconnect', async () => {
    const s = await ctx.readyStudent('Reconnect');
    const del = track(await ctx.api.delete('/api/connection').set(s.auth));
    expect(del.body.disconnected).toBe(true);
    const after = track(await ctx.api.get('/api/connection').set(s.auth));
    expect(after.body.connection.status).toBe('not_configured');
    const q = track(await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.students.findOne({})' }));
    expect(q.status).toBe(409);
    expect(q.body.error.code).toBe('NOT_CONNECTED');
    await ctx.api.post('/api/connection').set(s.auth).send({ mode: 'local' });
    const q2 = track(await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.students.countDocuments({})' }));
    expect(q2.status).toBe(200);
    expect(q2.body.value).toBe(12);
  });

  test('stored Atlas credentials are encrypted at rest', async () => {
    const docs = await ctx.services.mongo.collection('connections').find({ mode: 'atlas' }).toArray();
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect(d.encryptedUri).toMatch(/^v1:/);
      expect(JSON.stringify(d)).not.toContain(STUDENT_DB_USER.pwd);
    }
  });

  test('credentials are not exposed to the frontend via any student or admin endpoint', async () => {
    const s = await ctx.registerStudent('Expose');
    await ctx.api.post('/api/connection').set(s.auth).send(atlasBody());
    const inst = await ctx.loginInstructor();
    const bodies = [
      await ctx.api.get('/api/connection').set(s.auth),
      await ctx.api.get('/api/dashboard').set(s.auth),
      await ctx.api.get('/api/workspace').set(s.auth),
      await ctx.api.post('/api/connection/test').set(s.auth),
      await ctx.api.get('/api/admin/students').set(inst.auth),
      await ctx.api.get(`/api/admin/students/${s.user.id}`).set(inst.auth),
      await ctx.api.get('/api/admin/audit-logs').set(inst.auth),
    ].map((r) => JSON.stringify(r.body));
    for (const b of bodies) {
      expect(b).not.toContain(STUDENT_DB_USER.pwd);
      expect(b).not.toContain(STUDENT_DB_USER.user);
      expect(b).not.toMatch(/mongodb(\+srv)?:\/\/[^"]*@/);
      expect(b).not.toMatch(/encryptedUri/);
    }
  });

  test('connection URLs and passwords never appear in any API response or log line', () => {
    const everything = [...responses, ...logLines].join('\n');
    expect(responses.length).toBeGreaterThan(20);
    expect(everything).not.toContain(STUDENT_DB_USER.pwd);
    expect(everything).not.toContain(ADMIN_DB_USER.pwd);
    expect(everything).not.toContain('Wrong-Password-99');
    expect(everything).not.toMatch(/mongodb(\+srv)?:\/\/[^\s"]*:[^\s"]*@/);
  });
});
