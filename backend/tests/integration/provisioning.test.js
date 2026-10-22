'use strict';

const { startMongo } = require('../helpers/mongo');
const { createTestContext } = require('../helpers/context');
const { INDEXES } = require('../../src/provisioning/sampleData');

const EXPECTED_COUNTS = { students: 12, products: 16, orders: 16, employees: 12, courses: 12 };

let mongo;
let ctx;
let client;
beforeAll(async () => {
  mongo = await startMongo();
  ctx = await createTestContext({ mongoUri: mongo.uri });
  client = ctx.services.mongo.adminClient;
});
afterAll(async () => {
  await ctx?.cleanup();
  await mongo?.stop();
});

const counts = async (dbName) => {
  const db = client.db(dbName);
  const out = {};
  for (const name of Object.keys(EXPECTED_COUNTS)) out[name] = await db.collection(name).countDocuments();
  return out;
};

describe('C. Database provisioning', () => {
  test('creates the practice database with all required collections and sample documents', async () => {
    const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
    expect(databases.map((d) => d.name)).toContain(ctx.config.templateDbName);
    const names = (await client.db(ctx.config.templateDbName).listCollections().toArray()).map((c) => c.name).sort();
    expect(names).toEqual(['courses', 'employees', 'orders', 'products', 'students']);
    expect(await counts(ctx.config.templateDbName)).toEqual(EXPECTED_COUNTS);
  });

  test('sample documents contain the required fields, nested products and multiple statuses', async () => {
    const db = client.db(ctx.config.templateDbName);
    const keys = async (c) => Object.keys(await db.collection(c).findOne({}, { projection: { _id: 0 } })).sort();
    expect(await keys('students')).toEqual(['age', 'course', 'email', 'isActive', 'name', 'score']);
    expect(await keys('products')).toEqual(['category', 'isActive', 'name', 'price', 'rating', 'stock']);
    expect(await keys('orders')).toEqual(['createdAt', 'orderId', 'products', 'status', 'studentId', 'totalAmount']);
    expect(await keys('employees')).toEqual(['department', 'experience', 'isActive', 'name', 'salary', 'skills']);
    expect(await keys('courses')).toEqual(['category', 'duration', 'isPublished', 'level', 'price', 'title']);
    const order = await db.collection('orders').findOne({ orderId: 'ORD1001' });
    expect(order.products[0]).toEqual(expect.objectContaining({ name: 'Wireless Mouse', price: 799, quantity: 1 }));
    expect((await db.collection('orders').distinct('status')).sort()).toEqual(['cancelled', 'delivered', 'pending', 'shipped']);
  });

  test('creates the expected indexes', async () => {
    const db = client.db(ctx.config.templateDbName);
    for (const [coll, specs] of Object.entries(INDEXES)) {
      const names = (await db.collection(coll).indexes()).map((i) => i.name);
      for (const s of specs) expect(names).toContain(s.options.name);
    }
    const inst = await ctx.loginInstructor();
    const res = await ctx.api.get('/api/admin/datasets').set(inst.auth);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.collections.map((c) => [c.name, c]));
    for (const [name, n] of Object.entries(EXPECTED_COUNTS)) {
      expect(byName[name].count).toBe(n);
      expect(byName[name].indexes).toEqual(expect.arrayContaining(INDEXES[name].map((i) => i.options.name)));
    }
  });

  test('running the seed twice creates no duplicates and restores deleted sample documents', async () => {
    await client.db(ctx.config.templateDbName).collection('products').deleteOne({ name: 'Yoga Mat' });
    const second = await ctx.services.provisioning.seedTemplate();
    const third = await ctx.services.provisioning.seedTemplate();
    expect(second.products).toEqual({ upserted: 1, matched: 15, total: 16 });
    expect(third.products).toEqual({ upserted: 0, matched: 16, total: 16 });
    expect(await counts(ctx.config.templateDbName)).toEqual(EXPECTED_COUNTS);
    const questions = await ctx.services.questions.seedQuestions();
    await ctx.services.questions.seedQuestions();
    expect(await ctx.services.mongo.collection('questions').countDocuments()).toBe(questions.count);
  });

  test('reset restores the original dataset (modified, deleted and extra documents)', async () => {
    const db = client.db(ctx.config.templateDbName);
    await db.collection('products').updateMany({}, { $set: { price: 1 } });
    await db.collection('orders').deleteMany({});
    await db.collection('students').insertOne({ name: 'Extra', email: 'extra@x.com' });
    await ctx.services.provisioning.resetTemplate();
    expect(await counts(ctx.config.templateDbName)).toEqual(EXPECTED_COUNTS);
    expect((await db.collection('products').findOne({ name: 'Laptop Pro 14' })).price).toBe(89999);
    expect(await db.collection('students').findOne({ name: 'Extra' })).toBeNull();
  });

  test('each student gets an isolated workspace database', async () => {
    const a = await ctx.readyStudent('Iso A');
    const b = await ctx.readyStudent('Iso B');
    const all = await ctx.services.mongo.collection('workspaces').find({}).toArray();
    const dbA = all.find((w) => String(w.userId) === a.user.id).dbName;
    const dbB = all.find((w) => String(w.userId) === b.user.id).dbName;
    expect(dbA).not.toBe(dbB);
    expect(dbA.startsWith(ctx.config.workspaceDbPrefix)).toBe(true);
    expect(await counts(dbA)).toEqual(EXPECTED_COUNTS);

    // A deletes everything in their workspace; B and the template are unaffected.
    const del = await ctx.api.post('/api/query/execute').set(a.auth).send({ query: 'db.products.deleteMany({})' });
    expect(del.body.value.deletedCount).toBe(16);
    expect((await counts(dbA)).products).toBe(0);
    expect((await counts(dbB)).products).toBe(16);
    expect((await counts(ctx.config.templateDbName)).products).toBe(16);
  });

  test("one student cannot access another student's database", async () => {
    const a = await ctx.readyStudent('Victim');
    const b = await ctx.readyStudent('Attacker');
    const victimUser = await ctx.services.mongo.collection('users').findOne({ email: a.email });
    const ws = await ctx.services.mongo.collection('workspaces').findOne({ userId: victimUser._id });
    for (const database of [ws.dbName, 'admin', ctx.config.appDbName]) {
      const res = await ctx.api.post('/api/query/execute').set(b.auth).send({ query: 'db.students.find({})', database });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_DATABASE');
    }
    const sibling = await ctx.api.post('/api/query/execute').set(b.auth).send({ query: `db.getSiblingDB("${ws.dbName}").students.find({})` });
    expect(sibling.status).toBe(400);
    const sample = await ctx.api.get('/api/workspace/collections/users/sample').set(b.auth);
    expect(sample.status).toBe(400);
  });

  test('reset by the student restores their own workspace only', async () => {
    const a = await ctx.readyStudent('Resetter');
    const b = await ctx.readyStudent('Bystander');
    await ctx.api.post('/api/query/execute').set(a.auth).send({ query: 'db.orders.deleteMany({})' });
    await ctx.api.post('/api/query/execute').set(b.auth).send({ query: 'db.orders.deleteOne({ orderId: "ORD1001" })' });
    const res = await ctx.api.post('/api/workspace/reset').set(a.auth);
    expect(res.status).toBe(200);
    expect((await ctx.api.post('/api/query/execute').set(a.auth).send({ query: 'db.orders.countDocuments({})' })).body.value).toBe(16);
    expect((await ctx.api.post('/api/query/execute').set(b.auth).send({ query: 'db.orders.countDocuments({})' })).body.value).toBe(15);
  });

  test('reset operations by unauthorized students are prevented', async () => {
    const victim = await ctx.readyStudent('Target');
    const attacker = await ctx.readyStudent('Intruder');
    const viaAdmin = await ctx.api.post(`/api/admin/students/${victim.user.id}/reset`).set(attacker.auth);
    expect(viaAdmin.status).toBe(403);

    const inst = await ctx.loginInstructor();
    await ctx.api.patch(`/api/admin/students/${attacker.user.id}/access`).set(inst.auth).send({ allowSelfReset: false });
    const self = await ctx.api.post('/api/workspace/reset').set(attacker.auth);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('RESET_NOT_ALLOWED');
    const logs = await ctx.services.mongo.collection('audit_logs').find({ action: 'workspace.reset', outcome: 'denied' }).toArray();
    expect(logs.length).toBeGreaterThan(0);
  });

  test('one call connects and initializes a brand-new student, and is safe to repeat', async () => {
    const s = await ctx.registerStudent('Autostart');
    const first = await ctx.api.post('/api/workspace/ensure').set(s.auth);
    expect(first.status).toBe(200);
    expect(first.body.connection.mode).toBe('local');
    expect(first.body.workspace.status).toBe('ready');
    expect(Object.fromEntries(first.body.collections.map((c) => [c.name, c.count]))).toEqual(EXPECTED_COUNTS);

    // Repeating it must not wipe the work the student has already done.
    await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.orders.deleteMany({})' });
    const second = await ctx.api.post('/api/workspace/ensure').set(s.auth);
    expect(second.status).toBe(200);
    expect((await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.orders.countDocuments({})' })).body.value).toBe(0);
  });

  test('the collection browser returns documents and the field types of a collection', async () => {
    const s = await ctx.readyStudent('Browser');
    const res = await ctx.api.get('/api/workspace/collections/students/sample?limit=20').set(s.auth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(EXPECTED_COUNTS.students);
    expect(res.body.documents).toHaveLength(12);
    expect(res.body.documents[0]._id).toEqual({ $oid: expect.any(String) });
    expect(res.body.fields).toEqual(
      expect.arrayContaining([
        { name: '_id', types: ['objectId'] },
        { name: 'name', types: ['string'] },
        { name: 'age', types: ['int32'] },
        { name: 'isActive', types: ['boolean'] },
      ]),
    );
    const capped = await ctx.api.get('/api/workspace/collections/products/sample?limit=500').set(s.auth);
    expect(capped.body.documents.length).toBeLessThanOrEqual(50);
  });

  test('the collection browser pages through a collection with skip', async () => {
    const s = await ctx.readyStudent('Pager');
    const all = await ctx.api.get('/api/workspace/collections/products/sample?limit=50').set(s.auth);
    const page2 = await ctx.api.get('/api/workspace/collections/products/sample?limit=5&skip=5').set(s.auth);
    expect(page2.status).toBe(200);
    expect(page2.body).toMatchObject({ skip: 5, limit: 5, total: all.body.total });
    expect(page2.body.documents).toEqual(all.body.documents.slice(5, 10));
    const past = await ctx.api.get('/api/workspace/collections/products/sample?limit=5&skip=9999').set(s.auth);
    expect(past.body.documents).toEqual([]);
    const negative = await ctx.api.get('/api/workspace/collections/products/sample?limit=5&skip=-3').set(s.auth);
    expect(negative.body.skip).toBe(0);
  });

  test('workspace must be initialized before querying', async () => {
    const s = await ctx.registerStudent('Fresh');
    await ctx.api.post('/api/connection').set(s.auth).send({ mode: 'local' });
    const res = await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.students.find({})' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WORKSPACE_NOT_READY');
    const ws = await ctx.api.get('/api/workspace').set(s.auth);
    expect(ws.body.collections).toEqual([]);
    await ctx.api.post('/api/workspace/initialize').set(s.auth).send({});
    const ws2 = await ctx.api.get('/api/workspace').set(s.auth);
    expect(Object.fromEntries(ws2.body.collections.map((c) => [c.name, c.count]))).toEqual(EXPECTED_COUNTS);
  });
});
