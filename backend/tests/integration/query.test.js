'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');
const { startMongo } = require('../helpers/mongo');
const { createTestContext } = require('../helpers/context');
const { createMongoClient } = require('../../src/db/createClient');

let mongo;
let ctx;
let student;
let other;

const run = (s, query, extra = {}) => ctx.api.post('/api/query/execute').set(s.auth).send({ query, ...extra });

beforeAll(async () => {
  mongo = await startMongo();
  ctx = await createTestContext({ mongoUri: mongo.uri });
  student = await ctx.readyStudent('Querier');
  other = await ctx.readyStudent('Other');
});
afterAll(async () => {
  await ctx?.cleanup();
  await mongo?.stop();
});

describe('D. Query execution - valid queries', () => {
  test('find()', async () => {
    const res = await run(student, 'db.students.find({ isActive: true })');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, operation: 'find', collection: 'students', resultType: 'documents', count: 9, truncated: false });
    expect(res.body.database).toBe(ctx.config.templateDbName);
    expect(res.body.documents.every((d) => d.isActive === true)).toBe(true);
    expect(res.body.documents[0]._id).toEqual({ $oid: expect.any(String) });
  });

  test('findOne()', async () => {
    const res = await run(student, 'db.students.findOne({ email: "diya.patel@example.com" })');
    expect(res.body).toMatchObject({ resultType: 'document', count: 1 });
    expect(res.body.documents[0].name).toBe('Diya Patel');
  });

  test('projection', async () => {
    const res = await run(student, 'db.products.find({}, { name: 1, price: 1, _id: 0 })');
    expect(res.body.count).toBe(16);
    for (const d of res.body.documents) expect(Object.keys(d).sort()).toEqual(['name', 'price']);
  });

  test('comparison operators', async () => {
    const res = await run(student, 'db.products.find({ price: { $gte: 1000, $lt: 5000 }, category: { $in: ["Electronics", "Books"] }, stock: { $ne: 0 } })');
    expect(res.body.documents.map((d) => d.name).sort()).toEqual(['Clean Code', 'Mechanical Keyboard', 'MongoDB: The Definitive Guide']);
  });

  test('logical operators', async () => {
    const or = await run(student, 'db.students.find({ $or: [{ score: { $gt: 90 } }, { age: { $lt: 19 } }] }, { name: 1, _id: 0 })');
    expect(or.body.documents.map((d) => d.name).sort()).toEqual(['Diya Patel', 'Kabir Khan', 'Priya Joshi']);
    const nor = await run(student, 'db.employees.countDocuments({ $nor: [{ department: "Engineering" }, { isActive: false }] })');
    expect(nor.body.value).toBe(7);
    const not = await run(student, 'db.courses.countDocuments({ price: { $not: { $gt: 3000 } } })');
    expect(not.body.value).toBe(7);
  });

  test('sorting and limiting', async () => {
    const res = await run(student, 'db.products.find({}, { name: 1, price: 1, _id: 0 }).sort({ price: -1 }).limit(3)');
    expect(res.body.documents).toEqual([
      { name: 'Laptop Pro 14', price: 89999 },
      { name: '4K Monitor', price: 27999 },
      { name: 'Standing Desk', price: 24999 },
    ]);
    const skip = await run(student, 'db.products.find({}, { name: 1, _id: 0 }).sort({ price: 1 }).skip(1).limit(1)');
    expect(skip.body.documents).toEqual([{ name: 'Cotton T-Shirt' }]);
  });

  test('aggregation pipeline with $match, $group, $sort, $project, $unwind and $lookup', async () => {
    const res = await run(
      student,
      `db.orders.aggregate([
        { $match: { status: "delivered" } },
        { $unwind: "$products" },
        { $group: { _id: "$studentId", items: { $sum: "$products.quantity" } } },
        { $lookup: { from: "students", localField: "_id", foreignField: "_id", as: "s" } },
        { $unwind: "$s" },
        { $project: { _id: 0, name: "$s.name", items: 1 } },
        { $sort: { items: -1, name: 1 } }
      ])`,
    );
    expect(res.status).toBe(200);
    expect(res.body.documents[0]).toEqual({ name: 'Kabir Khan', items: 4 });
  });

  test('array and nested-document queries, counting and distinct', async () => {
    const arr = await run(student, 'db.employees.find({ skills: { $all: ["MongoDB"] } }, { name: 1, _id: 0 })');
    expect(arr.body.count).toBe(3);
    const nested = await run(student, 'db.orders.find({ "products.name": "Clean Code" }, { orderId: 1, _id: 0 })');
    expect(nested.body.documents).toEqual([{ orderId: 'ORD1010' }]);
    const elem = await run(student, 'db.orders.countDocuments({ products: { $elemMatch: { quantity: { $gte: 2 } } } })');
    expect(elem.body.value).toBe(6);
    const distinct = await run(student, 'db.courses.distinct("level")');
    expect(distinct.body.value.sort()).toEqual(['advanced', 'beginner', 'intermediate']);
    const cnt = await run(student, 'db.students.find({ course: "Data Science" }).count()');
    expect(cnt.body.value).toBe(3);
  });

  test('regex and date helpers', async () => {
    const res = await run(student, 'db.orders.find({ createdAt: { $gte: ISODate("2024-06-01"), $lt: ISODate("2024-07-01") } }, { orderId: 1, _id: 0 })');
    expect(res.body.documents.map((d) => d.orderId).sort()).toEqual(['ORD1014', 'ORD1015', 'ORD1016']);
    const rx = await run(student, 'db.products.find({ name: /^c/i }, { name: 1, _id: 0 })');
    expect(rx.body.documents.map((d) => d.name).sort()).toEqual(['Clean Code', 'Cotton T-Shirt']);
  });

  test('empty results', async () => {
    const res = await run(student, 'db.courses.find({ level: "expert" })');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 0, documents: [] });
    const one = await run(student, 'db.courses.findOne({ title: "Nope" })');
    expect(one.body).toMatchObject({ count: 0, documents: [] });
  });

  test('query history is recorded', async () => {
    const res = await ctx.api.get('/api/query/history').set(student.auth);
    expect(res.body.history.length).toBeGreaterThan(5);
    expect(res.body.history[0]).toEqual(expect.objectContaining({ ok: expect.any(Boolean), query: expect.any(String) }));
  });
});

describe('D. Query execution - invalid input', () => {
  test('invalid query syntax returns the location of the error', async () => {
    const res = await run(student, 'db.students.find({ age: { $gt: 21 }');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SYNTAX');
    expect(res.body.error).toEqual(expect.objectContaining({ line: 1, column: expect.any(Number) }));
  });

  test.each([
    ['db.students.drop()'],
    ['db.students.createIndex({ name: 1 })'],
    ['db.dropDatabase()'],
    ['db.students.mapReduce({}, {})'],
  ])('unsupported operation %s', async (q) => {
    const res = await run(student, q);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_OPERATION');
  });

  test('invalid collection name', async () => {
    const res = await run(student, 'db.customers.find({})');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_COLLECTION');
    expect(res.body.error.message).toMatch(/Available collections/);
  });

  test('selected collection must match the query', async () => {
    const res = await run(student, 'db.products.find({})', { collection: 'students' });
    expect(res.body.error.code).toBe('COLLECTION_MISMATCH');
  });

  test.each([
    ['db.orders.aggregate({ $match: {} })', 'INVALID_PIPELINE'],
    ['db.orders.aggregate([{ $match: { status: "x" }, $limit: 1 }])', 'INVALID_PIPELINE'],
    ['db.orders.aggregate([{ group: { _id: "$status" } }])', 'INVALID_PIPELINE'],
    ['db.orders.aggregate([{ $group: { total: { $sum: 1 } } }])', 'QUERY_FAILED'],
  ])('malformed aggregation pipeline %s', async (q, code) => {
    const res = await run(student, q);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  test('excessive result requests', async () => {
    const res = await run(student, 'db.products.find({}).limit(1000)');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EXCESSIVE_RESULTS');
  });

  test('results are capped at the configured maximum', async () => {
    const capped = await createTestContext({ mongoUri: mongo.uri, overrides: { queryMaxResults: 5 } });
    try {
      const s = await capped.readyStudent('Capped');
      const res = await capped.api.post('/api/query/execute').set(s.auth).send({ query: 'db.products.find({})' });
      expect(res.body).toMatchObject({ count: 5, truncated: true });
      const agg = await capped.api.post('/api/query/execute').set(s.auth).send({ query: 'db.orders.aggregate([{ $unwind: "$products" }])' });
      expect(agg.body).toMatchObject({ count: 5, truncated: true });
    } finally {
      await capped.cleanup();
    }
  });

  test('excessive request payload', async () => {
    const huge = await run(student, `db.students.find({ name: "${'x'.repeat(20000)}" })`);
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const long = await run(student, `db.students.find({ name: "${'x'.repeat(5000)}" })`);
    expect(long.status).toBe(413);
    expect(long.body.error.code).toBe('QUERY_TOO_LARGE');
  });

  test('per-student rate limit', async () => {
    const limited = await createTestContext({ mongoUri: mongo.uri, overrides: { queryRateLimitPerMinute: 3 } });
    try {
      const a = await limited.readyStudent('Spammer');
      const b = await limited.readyStudent('Patient');
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        statuses.push((await limited.api.post('/api/query/execute').set(a.auth).send({ query: 'db.students.findOne({})' })).status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      const ok = await limited.api.post('/api/query/execute').set(b.auth).send({ query: 'db.students.findOne({})' });
      expect(ok.status).toBe(200);
    } finally {
      await limited.cleanup();
    }
  });
});

describe('D. Query execution - security', () => {
  test('unauthorized database access', async () => {
    for (const database of ['admin', 'local', 'config', ctx.config.appDbName]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await run(student, 'db.students.find({})', { database });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_DATABASE');
    }
  });

  test.each([
    ['db.system.users.find({})'],
    ['db.system.profile.find({})'],
    ['db.getCollection("system.views").find({})'],
    ['db.orders.aggregate([{ $lookup: { from: "system.users", localField: "a", foreignField: "b", as: "x" } }])'],
  ])('reading system collections is blocked: %s', async (q) => {
    const res = await run(student, q);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN_COLLECTION');
  });

  test.each([
    ['db.users.find({})', 'INVALID_COLLECTION'],
    ['db.attempts.find({})', 'INVALID_COLLECTION'],
    ['db.orders.aggregate([{ $lookup: { from: "users", localField: "studentId", foreignField: "_id", as: "u" } }])', 'INVALID_COLLECTION'],
    ['db.orders.aggregate([{ $unionWith: { coll: "audit_logs" } }])', 'INVALID_COLLECTION'],
  ])('application metadata is not reachable: %s', async (q, code) => {
    const res = await run(student, q);
    expect(res.body.error.code).toBe(code);
  });

  test("another student's workspace cannot be reached by name or via cross-database operators", async () => {
    const otherWs = await ctx.services.mongo.collection('workspaces').findOne({ userId: (await ctx.services.mongo.collection('users').findOne({ email: other.email }))._id });
    const byName = await run(student, 'db.students.find({})', { database: otherWs.dbName });
    expect(byName.status).toBe(403);
    const sibling = await run(student, `db.getSiblingDB("${otherWs.dbName}").students.find({})`);
    expect(sibling.status).toBe(400);
    const lookupDb = await run(student, `db.orders.aggregate([{ $lookup: { from: { db: "${otherWs.dbName}", coll: "students" }, pipeline: [], as: "x" } }])`);
    expect(lookupDb.status).toBe(403);
    expect(lookupDb.body.error.code).toBe('FORBIDDEN_DATABASE');
  });

  test.each([
    ['db.students.find({ $where: "this.age > 20" })', 403, 'FORBIDDEN_OPERATOR'],
    ['db.students.find({ $where: function() { return true } })', 400, 'JS_NOT_ALLOWED'],
    ['db.students.find({ $expr: { $function: { body: "function() { return 1 }", args: [], lang: "js" } } })', 403, 'FORBIDDEN_OPERATOR'],
    ['db.orders.aggregate([{ $group: { _id: null, x: { $accumulator: { init: "function(){}", accumulate: "", accumulateArgs: [], merge: "", lang: "js" } } } }])', 403, 'FORBIDDEN_OPERATOR'],
    ['process.exit(1)', 400, 'JS_NOT_ALLOWED'],
    ['db.students.find({ a: require("child_process") })', 400, 'JS_NOT_ALLOWED'],
    ['db.students.find({}); while(true) {}', 400, 'INVALID_SYNTAX'],
  ])('arbitrary JavaScript is rejected: %s', async (q, status, code) => {
    const res = await run(student, q);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  test.each([
    ['unicode-escaped operator', 'db.students.find({ "\\u0024where": "sleep(5000)" })', 'FORBIDDEN_OPERATOR'],
    ['$out hidden in $facet', 'db.orders.aggregate([{ $facet: { a: [{ $out: "pwned" }] } }])', 'FORBIDDEN_OPERATOR'],
    ['$merge into another db', 'db.orders.aggregate([{ $merge: { into: { db: "admin", coll: "x" } } }])', 'FORBIDDEN_OPERATOR'],
    ['second limit to raise the cap', 'db.products.find({}).limit(10).limit(1000)', 'EXCESSIVE_RESULTS'],
    ['bracket access', 'db["system.users"].find({})', 'INVALID_SYNTAX'],
    ['prototype pollution', 'db.students.find({ __proto__: { isAdmin: true } })', 'FORBIDDEN_OPERATOR'],
    ['$currentOp', 'db.orders.aggregate([{ $currentOp: { allUsers: true } }])', 'FORBIDDEN_OPERATOR'],
  ])('attempts to bypass restrictions are blocked: %s', async (_label, q, code) => {
    const res = await run(student, q);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe(code);
  });

  test('blocked attempts are written to the audit log', async () => {
    const logs = await ctx.services.mongo.collection('audit_logs').find({ action: 'query.blocked' }).toArray();
    expect(logs.length).toBeGreaterThan(5);
    expect(logs.map((l) => l.details.code)).toEqual(expect.arrayContaining(['FORBIDDEN_OPERATOR', 'FORBIDDEN_COLLECTION', 'JS_NOT_ALLOWED', 'FORBIDDEN_DATABASE']));
  });
});

describe('D. Query execution - write operations', () => {
  const wsDb = async (s) => {
    const user = await ctx.services.mongo.collection('users').findOne({ email: s.email });
    const ws = await ctx.services.mongo.collection('workspaces').findOne({ userId: user._id });
    return ctx.services.mongo.adminClient.db(ws.dbName);
  };

  test('valid insert, update and delete in the assigned practice collection', async () => {
    const writer = await ctx.readyStudent('Writer');
    const db = await wsDb(writer);
    const ins = await run(writer, 'db.courses.insertOne({ title: "GraphQL Basics", category: "Backend", duration: 8, price: 999, level: "beginner", isPublished: false })');
    expect(ins.status).toBe(200);
    expect(ins.body.value.insertedCount).toBe(1);
    const many = await run(writer, 'db.courses.insertMany([{ title: "A1" }, { title: "A2" }])');
    expect(many.body.value.insertedCount).toBe(2);
    const upd = await run(writer, 'db.products.updateOne({ name: "Wireless Mouse" }, { $set: { stock: 75 }, $inc: { rating: 0.1 } })');
    expect(upd.body.value).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    const updMany = await run(writer, 'db.employees.updateMany({ department: "HR" }, { $push: { skills: "Onboarding" } })');
    expect(updMany.body.value.modifiedCount).toBe(2);
    const del = await run(writer, 'db.orders.deleteMany({ status: "cancelled" })');
    expect(del.body.value.deletedCount).toBe(2);
    const delOne = await run(writer, 'db.students.deleteOne({ name: "Rahul Das" })');
    expect(delOne.body.value.deletedCount).toBe(1);

    expect(await db.collection('courses').countDocuments()).toBe(15);
    expect((await db.collection('products').findOne({ name: 'Wireless Mouse' })).stock).toBe(75);
    expect(await db.collection('orders').countDocuments()).toBe(14);
    // Template and other students untouched
    const tpl = ctx.services.mongo.adminClient.db(ctx.config.templateDbName);
    expect(await tpl.collection('orders').countDocuments()).toBe(16);
    expect((await (await wsDb(other)).collection('products').findOne({ name: 'Wireless Mouse' })).stock).toBe(150);
  });

  test('unauthorized insert, update and delete operations are rejected', async () => {
    const s = await ctx.readyStudent('BadWriter');
    const cases = [
      ['db.users.insertOne({ email: "x@y.z", role: "admin" })', 400, 'INVALID_COLLECTION'],
      ['db.system.users.deleteMany({})', 403, 'FORBIDDEN_COLLECTION'],
      ['db.audit_logs.deleteMany({})', 400, 'INVALID_COLLECTION'],
      ['db.products.updateMany({}, { price: 0 })', 400, 'INVALID_ARGUMENT'],
      ['db.products.updateOne({ $where: "1" }, { $set: { a: 1 } })', 403, 'FORBIDDEN_OPERATOR'],
      ['db.products.insertOne({ $set: { a: 1 } })', 400, 'INVALID_ARGUMENT'],
      ['db.products.deleteMany()', 400, 'INVALID_ARGUMENT'],
    ];
    for (const [q, status, code] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const res = await run(s, q);
      expect([q, res.status, res.body.error.code]).toEqual([q, status, code]);
    }
    const inst = await ctx.loginInstructor();
    await ctx.api.patch(`/api/admin/students/${s.user.id}/access`).set(inst.auth).send({ practiceDisabled: true });
    const disabled = await run(s, 'db.products.deleteMany({})');
    expect(disabled.status).toBe(403);
    expect(disabled.body.error.code).toBe('PRACTICE_DISABLED');
    expect(await (await wsDb(s)).collection('products').countDocuments()).toBe(16);
  });

  test('duplicate key errors are reported clearly', async () => {
    const s = await ctx.readyStudent('Dupe');
    const res = await run(s, 'db.students.insertOne({ name: "Copy", email: "diya.patel@example.com" })');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_KEY');
  });
});

describe('D. Query execution - timeouts', () => {
  test('a query exceeding its time limit is stopped (API, mocked slow database)', async () => {
    const slow = await createTestContext({ mongoUri: mongo.uri, overrides: { queryTimeoutMs: 100 } });
    try {
      const s = await slow.readyStudent('Slow');
      jest.spyOn(slow.services.workspaces, 'resolveDb').mockResolvedValue({
        db: { collection: () => ({ countDocuments: () => new Promise(() => {}) }) },
      });
      const res = await slow.api.post('/api/query/execute').set(s.auth).send({ query: 'db.students.countDocuments({})' });
      expect(res.status).toBe(408);
      expect(res.body.error.code).toBe('QUERY_TIMEOUT');
    } finally {
      jest.restoreAllMocks();
      await slow.cleanup();
    }
  });

  test('MongoDB maxTimeMS expiry is reported as a timeout (real mongod with a fail point)', async () => {
    const server = await MongoMemoryServer.create({ instance: { args: ['--setParameter', 'enableTestCommands=1'] } });
    const timed = await createTestContext({ mongoUri: server.getUri() });
    const admin = createMongoClient(server.getUri());
    try {
      const s = await timed.readyStudent('MaxTime');
      await admin.connect();
      await admin.db('admin').command({ configureFailPoint: 'maxTimeAlwaysTimeOut', mode: 'alwaysOn' });
      const res = await timed.api.post('/api/query/execute').set(s.auth).send({ query: 'db.orders.aggregate([{ $group: { _id: "$status" } }])' });
      expect(res.status).toBe(408);
      expect(res.body.error.code).toBe('QUERY_TIMEOUT');
      await admin.db('admin').command({ configureFailPoint: 'maxTimeAlwaysTimeOut', mode: 'off' });
    } finally {
      await admin.close();
      await timed.cleanup();
      await server.stop();
    }
  });
});
