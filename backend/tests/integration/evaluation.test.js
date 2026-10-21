'use strict';

const { startMongo } = require('../helpers/mongo');
const { createTestContext } = require('../helpers/context');
const { getQuestionBank } = require('../../src/questions/questionBank');

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

const submit = (s, id, query) => ctx.api.post(`/api/questions/${id}/submit`).set(s.auth).send({ query });
const failedCases = (res) => res.body.testResults.filter((t) => !t.passed).map((t) => t.id);

describe('E. Question bank', () => {
  test('has at least 20 questions across all levels with the required fields', () => {
    const bank = getQuestionBank();
    expect(bank.length).toBeGreaterThanOrEqual(20);
    expect(new Set(bank.map((q) => q.difficulty))).toEqual(new Set(['beginner', 'intermediate', 'advanced']));
    for (const q of bank) {
      expect(q).toEqual(expect.objectContaining({
        questionId: expect.stringMatching(/^Q\d{3}$/), title: expect.any(String), description: expect.any(String),
        difficulty: expect.any(String), collection: expect.any(String), points: expect.any(Number), solution: expect.any(String),
      }));
    }
    expect(new Set(bank.map((q) => q.questionId)).size).toBe(bank.length);
  });

  test.each(getQuestionBank().map((q) => [q.questionId, q.title, q.solution]))(
    'reference solution for %s (%s) passes all test cases',
    async (id, _title, solution) => {
      const question = await ctx.services.questions.getById(id);
      const result = await ctx.services.evaluation.evaluate(question, solution, 'ref');
      expect(result.testResults.filter((t) => !t.passed)).toEqual([]);
      expect(result.status).toBe('passed');
    },
  );

  test('students never receive solutions or verification queries', async () => {
    const s = await ctx.registerStudent('Peeker');
    const list = await ctx.api.get('/api/questions').set(s.auth);
    expect(list.status).toBe(200);
    expect(list.body.questions.length).toBeGreaterThanOrEqual(20);
    const one = await ctx.api.get('/api/questions/Q020').set(s.auth);
    for (const body of [JSON.stringify(list.body), JSON.stringify(one.body)]) {
      expect(body).not.toMatch(/"solution"|"verifyQuery"|"scopeQuery"/);
      expect(body).not.toContain('$dateToString: { format');
    }
    expect(one.body.question.testCases.map((t) => Object.keys(t).sort())).toEqual(one.body.question.testCases.map(() => ['id', 'name']));
  });
});

describe('E. Evaluation', () => {
  test('correct solution passes and an equivalent formulation also passes', async () => {
    const s = await ctx.registerStudent('Correct');
    const a = await submit(s, 'Q018', 'db.students.find({ score: { $gte: 70, $lte: 90 } })');
    expect(a.body).toMatchObject({ status: 'passed', passed: true, score: 10, maxScore: 10 });
    const b = await submit(s, 'Q018', 'db.students.find({ $and: [{ score: { $gte: 70 } }, { score: { $lte: 90 } }] })');
    expect(b.body.passed).toBe(true);
  });

  test('incorrect solution fails with per-test-case feedback', async () => {
    const s = await ctx.registerStudent('Wrong');
    const res = await submit(s, 'Q002', 'db.students.find({ age: { $gte: 21 } })');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'failed', passed: false, score: 0 });
    expect(failedCases(res)).toEqual(['count', 'documents']);
    expect(res.body.testResults.find((t) => t.id === 'count').message).toMatch(/Expected 6 document\(s\) but your query returned 8/);
  });

  test('empty output is handled correctly', async () => {
    const s = await ctx.registerStudent('Empty');
    const noRows = await submit(s, 'Q001', 'db.students.find({ isActive: "yes" })');
    expect(noRows.body.passed).toBe(false);
    expect(noRows.body.testResults.find((t) => t.id === 'count').message).toMatch(/returned no documents/);
    const expectEmpty = await submit(s, 'Q026', 'db.courses.find({ level: "expert" })');
    expect(expectEmpty.body.passed).toBe(true);
    expect(expectEmpty.body.output).toMatchObject({ count: 0, documents: [] });
    const notEmpty = await submit(s, 'Q026', 'db.courses.find({ level: "advanced" })');
    expect(notEmpty.body.passed).toBe(false);
    expect(notEmpty.body.testResults.find((t) => t.id === 'count').message).toMatch(/No documents should match/);
  });

  test('document order is ignored unless the question requires it', async () => {
    const s = await ctx.registerStudent('Order');
    const unordered = await submit(s, 'Q007', 'db.orders.find({ status: "delivered" }).sort({ totalAmount: 1 })');
    expect(unordered.body.passed).toBe(true);
    const wrongOrder = await submit(s, 'Q004', 'db.products.find().sort({ price: 1 })');
    expect(wrongOrder.body.passed).toBe(false);
    expect(failedCases(wrongOrder)).toEqual(['order']);
    const rightOrder = await submit(s, 'Q005', 'db.products.find({}).sort({ price: -1 }).limit(5)');
    expect(rightOrder.body.passed).toBe(true);
  });

  test('projection must match the required shape', async () => {
    const s = await ctx.registerStudent('Shape');
    const extra = await submit(s, 'Q003', 'db.products.find({}, { name: 1, price: 1, category: 1, _id: 0 })');
    expect(failedCases(extra)).toEqual(['documents']);
    const withId = await submit(s, 'Q003', 'db.products.find({}, { name: 1, price: 1 })');
    expect(withId.body.passed).toBe(true); // _id is ignored for this question
  });

  test('nested documents are validated correctly (positional update)', async () => {
    const s = await ctx.registerStudent('Nested');
    const correct = await submit(s, 'Q019', 'db.orders.updateOne({ orderId: "ORD1005", "products.name": "USB-C Cable" }, { $set: { "products.$.quantity": 3 } })');
    expect(correct.body.passed).toBe(true);
    const wrongValue = await submit(s, 'Q019', 'db.orders.updateOne({ orderId: "ORD1005", "products.name": "USB-C Cable" }, { $set: { "products.$.quantity": 4 } })');
    expect(failedCases(wrongValue)).toEqual(['state', 'scope']);
    const tooBroad = await submit(s, 'Q019', 'db.orders.updateMany({ "products.name": "USB-C Cable" }, { $set: { "products.$.quantity": 3 } })');
    expect(failedCases(tooBroad)).toEqual(['scope']);
  });

  test('array results are validated correctly', async () => {
    const s = await ctx.registerStudent('Arrays');
    const distinct = await submit(s, 'Q022', 'db.employees.distinct("department", {})');
    expect(distinct.body.passed).toBe(true);
    const distinctWrong = await submit(s, 'Q022', 'db.employees.distinct("department", { isActive: true })');
    expect(distinctWrong.body.passed).toBe(true); // every department still has an active employee
    const distinctBad = await submit(s, 'Q022', 'db.employees.distinct("name")');
    expect(distinctBad.body.passed).toBe(false);
    const unwind = await submit(s, 'Q015', 'db.orders.aggregate([{ $unwind: "$products" }, { $project: { _id: 0, orderId: 1, productName: "$products.name", quantity: "$products.quantity" } }, { $sort: { quantity: -1 } }])');
    expect(unwind.body.passed).toBe(true);
    const skills = await submit(s, 'Q023', 'db.employees.find({ skills: { $in: ["MongoDB"] } }, { name: 1, department: 1, _id: 0 })');
    expect(skills.body.passed).toBe(true);
  });

  test('wrong collection or operation fails the target test case', async () => {
    const s = await ctx.registerStudent('Target');
    const coll = await submit(s, 'Q001', 'db.employees.find({ isActive: true })');
    expect(coll.body.status).toBe('failed');
    expect(coll.body.testResults[0].message).toMatch(/must be answered using the 'students' collection/);
    const op = await submit(s, 'Q006', 'db.products.find({})');
    expect(op.body.testResults[0].message).toMatch(/Use one of these operations for this question: aggregate/);
  });

  test('syntax errors and blocked queries are recorded as error attempts', async () => {
    const s = await ctx.registerStudent('Broken');
    const res = await submit(s, 'Q001', 'db.students.find({ isActive: true ');
    expect(res.body).toMatchObject({ status: 'error', passed: false, score: 0 });
    expect(res.body.error.code).toBe('INVALID_SYNTAX');
    const blocked = await submit(s, 'Q001', 'db.students.find({ $where: "1" })');
    expect(blocked.body.error.code).toBe('FORBIDDEN_OPERATOR');
    expect(await ctx.services.mongo.collection('attempts').countDocuments({ userId: (await ctx.services.mongo.collection('users').findOne({ email: s.email }))._id })).toBe(2);
  });

  test("grading runs in a sandbox and never modifies the student's workspace", async () => {
    const s = await ctx.readyStudent('Sandbox');
    const res = await submit(s, 'Q025', 'db.orders.deleteMany({ status: "cancelled" })');
    expect(res.body.passed).toBe(true);
    const count = await ctx.api.post('/api/query/execute').set(s.auth).send({ query: 'db.orders.countDocuments({})' });
    expect(count.body.value).toBe(16);
    const { databases } = await ctx.services.mongo.adminClient.db('admin').admin().listDatabases({ nameOnly: true });
    expect(databases.filter((d) => d.name.includes('_eval_'))).toEqual([]);
  });

  test('scores are calculated correctly, repeated submissions are tracked and saved', async () => {
    const s = await ctx.registerStudent('Scorer');
    await submit(s, 'Q001', 'db.students.find({ isActive: false })'); // fail
    const pass1 = await submit(s, 'Q001', 'db.students.find({ isActive: true })'); // pass 10
    const fail2 = await submit(s, 'Q001', 'db.students.find({})'); // fail again - best score kept
    expect([pass1.body.attemptNumber, fail2.body.attemptNumber]).toEqual([2, 3]);
    expect(fail2.body.progress).toMatchObject({ attempts: 3, bestScore: 10, completed: true });
    await submit(s, 'Q006', 'db.products.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }])'); // 20
    await submit(s, 'Q020', 'db.orders.find({})'); // wrong op -> 0

    const progress = await ctx.api.get('/api/progress').set(s.auth);
    expect(progress.body.progress).toMatchObject({ completed: 2, attempted: 3, totalAttempts: 5, score: 30 });
    const total = getQuestionBank().reduce((sum, q) => sum + q.points, 0);
    expect(progress.body.progress.maxScore).toBe(total);

    const userId = (await ctx.services.mongo.collection('users').findOne({ email: s.email }))._id;
    const saved = await ctx.services.mongo.collection('attempts').find({ userId, questionId: 'Q001' }).sort({ attemptNumber: 1 }).toArray();
    expect(saved.map((a) => [a.attemptNumber, a.status, a.score])).toEqual([[1, 'failed', 0], [2, 'passed', 10], [3, 'failed', 0]]);
    expect(saved[1]).toEqual(expect.objectContaining({ query: 'db.students.find({ isActive: true })', maxScore: 10, testResults: expect.any(Array), createdAt: expect.any(Date) }));

    const detail = await ctx.api.get('/api/questions/Q001').set(s.auth);
    expect(detail.body.attempts).toHaveLength(3);
    const dash = await ctx.api.get('/api/dashboard').set(s.auth);
    expect(dash.body.progress).toMatchObject({ score: 30, completed: 2 });
    expect(dash.body.modules.length).toBeGreaterThan(5);
  });

  test('questions that are not assigned cannot be viewed or submitted', async () => {
    const s = await ctx.registerStudent('Unassigned');
    const inst = await ctx.loginInstructor();
    const created = await ctx.api.post('/api/admin/questions').set(inst.auth).send({
      title: 'Private question', description: 'Only for one student', difficulty: 'beginner', collection: 'students',
      allowedOperations: ['find'], solution: 'db.students.find({ course: "Cloud Computing" })', assignToAll: false,
    });
    expect(created.status).toBe(201);
    const id = created.body.question.questionId;
    expect((await ctx.api.get(`/api/questions/${id}`).set(s.auth)).status).toBe(403);
    expect((await submit(s, id, 'db.students.find({})')).status).toBe(403);
  });
});
