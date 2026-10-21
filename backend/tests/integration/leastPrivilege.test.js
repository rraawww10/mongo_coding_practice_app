'use strict';

const { startMongo } = require('../helpers/mongo');
const { createTestContext } = require('../helpers/context');

/**
 * With WORKSPACE_DB_USERS=true and an auth-enabled MongoDB, each workspace gets its own
 * MongoDB user holding readWrite on that single database. Student queries run as that user,
 * so even a bug in the validator could not reach another database.
 */
let mongo;
let ctx;
beforeAll(async () => {
  mongo = await startMongo({ auth: true });
  ctx = await createTestContext({ mongoUri: mongo.uri, overrides: { workspaceDbUsers: true } });
});
afterAll(async () => {
  await ctx?.cleanup();
  await mongo?.stop();
});

const workspaceOf = async (s) => {
  const user = await ctx.services.mongo.collection('users').findOne({ email: s.email });
  return ctx.services.mongo.collection('workspaces').findOne({ userId: user._id });
};

describe('Least-privilege database credentials', () => {
  test('each workspace has a dedicated MongoDB user limited to its own database', async () => {
    const a = await ctx.readyStudent('LP A');
    const ws = await workspaceOf(a);
    expect(ws.dbUser.username).toBe(`${ws.dbName}_user`);
    expect(ws.dbUser.encryptedPassword).toMatch(/^v1:/);
    const info = await ctx.services.mongo.adminClient.db(ws.dbName).command({ usersInfo: ws.dbUser.username });
    expect(info.users[0].roles).toEqual([{ role: 'readWrite', db: ws.dbName }]);
    const res = await ctx.api.post('/api/query/execute').set(a.auth).send({ query: 'db.students.countDocuments({})' });
    expect(res.body.value).toBe(12);
  });

  test('the student query identity cannot read other workspaces, the app database or admin', async () => {
    const a = await ctx.readyStudent('LP Reader');
    const b = await ctx.readyStudent('LP Other');
    const wsA = await workspaceOf(a);
    const wsB = await workspaceOf(b);
    const dbA = await ctx.services.connections.getLocalWorkspaceDb(wsA);
    const client = dbA.client;
    await expect(client.db(wsB.dbName).collection('students').findOne({})).rejects.toMatchObject({ code: 13 });
    await expect(client.db(ctx.config.appDbName).collection('users').findOne({})).rejects.toMatchObject({ code: 13 });
    // listDatabases is permitted for any user but only lists databases the user is authorized for.
    const { databases } = await client.db('admin').command({ listDatabases: 1, nameOnly: true });
    expect(databases.map((d) => d.name)).toEqual([wsA.dbName]);
    await expect(client.db('admin').command({ createUser: 'evil', pwd: 'x', roles: ['root'] })).rejects.toMatchObject({ code: 13 });
    await expect(dbA.collection('students').findOne({})).resolves.toBeTruthy();
  });

  test('reset keeps the workspace user working', async () => {
    const a = await ctx.readyStudent('LP Reset');
    await ctx.api.post('/api/query/execute').set(a.auth).send({ query: 'db.students.deleteMany({})' });
    await ctx.api.post('/api/workspace/reset').set(a.auth);
    const res = await ctx.api.post('/api/query/execute').set(a.auth).send({ query: 'db.students.countDocuments({})' });
    expect(res.body.value).toBe(12);
  });
});
