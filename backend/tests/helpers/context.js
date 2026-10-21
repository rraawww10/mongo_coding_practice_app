'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { bootstrap, seedAll } = require('../../src/bootstrap');
const { createApp } = require('../../src/app');

const INSTRUCTOR = { email: 'instructor@test.local', password: 'Instructor#Pass1' };

/**
 * Builds a full application instance bound to unique databases so test files never share data.
 */
async function createTestContext({ mongoUri, overrides = {}, clientFactory, seed = true } = {}) {
  const tag = crypto.randomBytes(3).toString('hex');
  const config = {
    mongoAdminUri: mongoUri,
    appDbName: `t_${tag}_app`,
    templateDbName: `t_${tag}_mongodb_practice`,
    workspaceDbPrefix: `t_${tag}_ws_`,
    jwtSecret: crypto.randomBytes(32).toString('hex'),
    credentialEncryptionKey: crypto.randomBytes(32).toString('hex'),
    instructorEmail: INSTRUCTOR.email,
    instructorPassword: INSTRUCTOR.password,
    instructorName: 'Test Instructor',
    bcryptRounds: 4,
    atlasAllowedHostSuffixes: ['.mongodb.net', '127.0.0.1', 'localhost', '.invalid', '10.255.255.1'],
    atlasConnectTimeoutMs: 1500,
    queryRateLimitPerMinute: 1000,
    authRateLimitPerMinute: 1000,
    ...overrides,
  };
  const services = await bootstrap({ overrides: config, clientFactory });
  if (seed) await seedAll(services);
  const app = createApp(services);
  const api = request(app);

  const ctx = {
    tag,
    services,
    app,
    api,
    config: services.config,
    async registerStudent(name = 'Student') {
      const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${crypto.randomBytes(3).toString('hex')}@test.local`;
      const password = 'Student#Pass1';
      const res = await api.post('/api/auth/register').send({ name, email, password });
      if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
      return { token: res.body.token, user: res.body.user, email, password, auth: { Authorization: `Bearer ${res.body.token}` } };
    },
    async loginInstructor() {
      const res = await api.post('/api/auth/login').send(INSTRUCTOR);
      if (res.status !== 200) throw new Error(`instructor login failed: ${res.status}`);
      return { token: res.body.token, user: res.body.user, auth: { Authorization: `Bearer ${res.body.token}` } };
    },
    /** Registers a student, connects to the local simulation and initializes the workspace. */
    async readyStudent(name = 'Student') {
      const s = await ctx.registerStudent(name);
      const c = await api.post('/api/connection').set(s.auth).send({ mode: 'local' });
      if (c.status !== 200) throw new Error(`connect failed: ${c.status} ${JSON.stringify(c.body)}`);
      const i = await api.post('/api/workspace/initialize').set(s.auth).send({});
      if (i.status !== 200) throw new Error(`init failed: ${i.status} ${JSON.stringify(i.body)}`);
      return s;
    },
    async cleanup() {
      const client = services.mongo.adminClient;
      const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
      await Promise.all(databases.filter((d) => d.name.startsWith(`t_${tag}_`)).map((d) => client.db(d.name).dropDatabase()));
      await services.shutdown();
    },
  };
  return ctx;
}

module.exports = { createTestContext, INSTRUCTOR };
