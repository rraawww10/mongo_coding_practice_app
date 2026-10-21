'use strict';

const jwt = require('jsonwebtoken');
const { startMongo } = require('../helpers/mongo');
const { createTestContext } = require('../helpers/context');

let mongo;
let ctx;
beforeAll(async () => {
  mongo = await startMongo();
  ctx = await createTestContext({ mongoUri: mongo.uri });
});
afterAll(async () => {
  await ctx?.cleanup();
  await mongo?.stop();
});

describe('A. Authentication & authorization', () => {
  test('successful student registration returns a token and never the password hash', async () => {
    const res = await ctx.api.post('/api/auth/register').send({ name: 'Asha', email: 'Asha@Example.com', password: 'Correct#Horse1' });
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ name: 'Asha', email: 'asha@example.com', role: 'student' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|Correct#Horse1/);
    const me = await ctx.api.get('/api/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('asha@example.com');
  });

  test('registration cannot self-assign an elevated role', async () => {
    const res = await ctx.api.post('/api/auth/register').send({ name: 'Mallory', email: 'mallory@example.com', password: 'Password#123', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('student');
  });

  test('duplicate email registration is rejected (case-insensitive)', async () => {
    await ctx.api.post('/api/auth/register').send({ name: 'Dup', email: 'dup@example.com', password: 'Password#123' });
    const res = await ctx.api.post('/api/auth/register').send({ name: 'Dup2', email: 'DUP@example.com', password: 'Password#123' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test.each([
    [{ name: 'X', email: 'not-an-email', password: 'Password#123' }, 'email'],
    [{ name: 'Valid Name', email: 'a@b', password: 'Password#123' }, 'email'],
    [{ name: 'Valid Name', email: 'ok@example.com', password: 'short' }, 'password'],
    [{ email: 'ok2@example.com', password: 'Password#123' }, 'name'],
  ])('invalid registration input is rejected: %o', async (body, field) => {
    const res = await ctx.api.post('/api/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  test('incorrect password and unknown email return the same 401', async () => {
    await ctx.api.post('/api/auth/register').send({ name: 'Login', email: 'login@example.com', password: 'Password#123' });
    const wrong = await ctx.api.post('/api/auth/login').send({ email: 'login@example.com', password: 'Wrong#Password' });
    const unknown = await ctx.api.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'Wrong#Password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    const ok = await ctx.api.post('/api/auth/login').send({ email: 'LOGIN@example.com', password: 'Password#123' });
    expect(ok.status).toBe(200);
  });

  test.each([
    ['get', '/api/me'],
    ['get', '/api/dashboard'],
    ['post', '/api/query/execute'],
    ['post', '/api/connection'],
    ['get', '/api/questions'],
    ['get', '/api/admin/students'],
  ])('unauthenticated %s %s -> 401', async (method, url) => {
    const res = await ctx.api[method](url).send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('invalid, expired and forged tokens are rejected', async () => {
    const s = await ctx.registerStudent('Token');
    const forged = jwt.sign({ sub: s.user.id, role: 'admin' }, 'another-secret-another-secret-123456', { issuer: 'mongodb-practice-platform' });
    const expired = jwt.sign({ sub: s.user.id, role: 'student' }, ctx.config.jwtSecret, { issuer: 'mongodb-practice-platform', expiresIn: -10 });
    for (const token of ['garbage', forged, expired]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await ctx.api.get('/api/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    }
  });

  test('a role claim in the token cannot elevate privileges (role is read from the database)', async () => {
    const s = await ctx.registerStudent('Claim');
    const token = jwt.sign({ sub: s.user.id, role: 'admin' }, ctx.config.jwtSecret, { issuer: 'mongodb-practice-platform' });
    const res = await ctx.api.get('/api/admin/students').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('students cannot access admin APIs', async () => {
    const s = await ctx.registerStudent('Curious');
    const calls = [
      ['get', '/api/admin/students'],
      ['get', '/api/admin/submissions'],
      ['get', '/api/admin/audit-logs'],
      ['get', '/api/admin/questions'],
      ['post', '/api/admin/questions'],
      ['post', `/api/admin/students/${s.user.id}/reset`],
      ['patch', `/api/admin/students/${s.user.id}/access`],
      ['post', '/api/admin/datasets/reset'],
    ];
    for (const [method, url] of calls) {
      // eslint-disable-next-line no-await-in-loop
      const res = await ctx.api[method](url).set(s.auth).send({ practiceDisabled: false });
      expect([url, res.status]).toEqual([url, 403]);
      expect(res.body.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  test('instructors can access authorized admin APIs', async () => {
    const inst = await ctx.loginInstructor();
    expect(['admin', 'instructor']).toContain(inst.user.role);
    for (const url of ['/api/admin/students', '/api/admin/submissions', '/api/admin/audit-logs', '/api/admin/questions', '/api/admin/datasets']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await ctx.api.get(url).set(inst.auth);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  test('login is rate limited per client', async () => {
    const limited = await createTestContext({ mongoUri: mongo.uri, overrides: { authRateLimitPerMinute: 3 }, seed: false });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        statuses.push((await limited.api.post('/api/auth/login').send({ email: 'x@y.com', password: 'nope' })).status);
      }
      expect(statuses).toEqual([401, 401, 401, 429]);
    } finally {
      await limited.cleanup();
    }
  });
});
