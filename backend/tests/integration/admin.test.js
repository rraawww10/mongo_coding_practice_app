'use strict';

const { startMongo } = require('../helpers/mongo');
const { createTestContext } = require('../helpers/context');

let mongo;
let ctx;
let inst;
let alice;
let bob;
beforeAll(async () => {
  mongo = await startMongo();
  ctx = await createTestContext({ mongoUri: mongo.uri });
  inst = await ctx.loginInstructor();
  alice = await ctx.readyStudent('Alice');
  bob = await ctx.registerStudent('Bob');
  await ctx.api.post('/api/questions/Q001/submit').set(alice.auth).send({ query: 'db.students.find({ isActive: true })' });
  await ctx.api.post('/api/questions/Q002/submit').set(alice.auth).send({ query: 'db.students.find({})' });
  await ctx.api.post('/api/query/execute').set(alice.auth).send({ query: 'db.nope.find(' });
});
afterAll(async () => {
  await ctx?.cleanup();
  await mongo?.stop();
});

describe('F. Instructor controls', () => {
  test('view student list with connection status and progress', async () => {
    const res = await ctx.api.get('/api/admin/students').set(inst.auth);
    expect(res.status).toBe(200);
    const a = res.body.students.find((s) => s.id === alice.user.id);
    const b = res.body.students.find((s) => s.id === bob.user.id);
    expect(a.connection).toMatchObject({ mode: 'local', status: 'connected' });
    expect(a.workspace.status).toBe('ready');
    expect(a.progress).toEqual({ score: 10, completed: 1, attempts: 2 });
    expect(b.connection.status).toBe('not_configured');
    expect(res.body.students.every((s) => s.role === 'student')).toBe(true);
  });

  test('view a single student with per-question progress', async () => {
    const res = await ctx.api.get(`/api/admin/students/${alice.user.id}`).set(inst.auth);
    expect(res.body.progress).toMatchObject({ completed: 1, totalAttempts: 2, score: 10 });
    expect(res.body.questions.find((q) => q.questionId === 'Q002')).toMatchObject({ attempts: 1, completed: false });
    expect((await ctx.api.get('/api/admin/students/000000000000000000000000').set(inst.auth)).status).toBe(404);
    expect((await ctx.api.get('/api/admin/students/not-an-id').set(inst.auth)).status).toBe(400);
  });

  test('view submissions and inspect query results/errors', async () => {
    const res = await ctx.api.get(`/api/admin/submissions?studentId=${alice.user.id}`).set(inst.auth);
    expect(res.body.submissions).toHaveLength(2);
    expect(res.body.submissions[0]).toEqual(expect.objectContaining({ studentName: 'Alice', query: expect.any(String), testResults: expect.any(Array) }));
    const failed = await ctx.api.get('/api/admin/submissions?status=failed').set(inst.auth);
    expect(failed.body.submissions.every((s) => s.status === 'failed')).toBe(true);
    const history = await ctx.api.get(`/api/admin/students/${alice.user.id}/query-history`).set(inst.auth);
    expect(history.body.history.find((h) => h.ok === false)).toEqual(expect.objectContaining({ errorCode: 'INVALID_SYNTAX' }));
    const attempts = await ctx.api.get(`/api/admin/students/${alice.user.id}/attempts`).set(inst.auth);
    expect(attempts.body.attempts).toHaveLength(2);
  });

  test('create a question (solution is validated) and assign it to one student', async () => {
    const bad = await ctx.api.post('/api/admin/questions').set(inst.auth).send({
      title: 'Broken', description: 'Bad solution', difficulty: 'beginner', collection: 'students', allowedOperations: ['find'], solution: 'db.students.find({ $where: "1" })',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_SOLUTION');
    const invalid = await ctx.api.post('/api/admin/questions').set(inst.auth).send({ title: 'x' });
    expect(invalid.status).toBe(400);

    const created = await ctx.api.post('/api/admin/questions').set(inst.auth).send({
      title: 'Cheap courses', description: 'Find courses cheaper than 2000.', difficulty: 'beginner', collection: 'courses',
      allowedOperations: ['find'], solution: 'db.courses.find({ price: { $lt: 2000 } })', assignToAll: false,
    });
    expect(created.status).toBe(201);
    const id = created.body.question.questionId;
    expect(id).toBe('Q027');
    const assign = await ctx.api.post(`/api/admin/questions/${id}/assign`).set(inst.auth).send({ studentIds: [bob.user.id] });
    expect(assign.body).toEqual({ questionId: id, assigned: 1 });
    const bobQs = await ctx.api.get('/api/questions').set(bob.auth);
    const aliceQs = await ctx.api.get('/api/questions').set(alice.auth);
    expect(bobQs.body.questions.map((q) => q.questionId)).toContain(id);
    expect(aliceQs.body.questions.map((q) => q.questionId)).not.toContain(id);
    const pass = await ctx.api.post(`/api/questions/${id}/submit`).set(bob.auth).send({ query: 'db.courses.find({ price: { $lte: 1999 } })' });
    expect(pass.body.passed).toBe(true);
    const all = await ctx.api.post(`/api/admin/questions/${id}/assign`).set(inst.auth).send({ all: true });
    expect(all.body.assignToAll).toBe(true);
    const list = await ctx.api.get('/api/admin/questions').set(inst.auth);
    expect(list.body.questions.find((q) => q.questionId === id).solution).toBeDefined(); // instructors can see solutions
  });

  test("reset a student's data without affecting other students", async () => {
    const carol = await ctx.readyStudent('Carol');
    await ctx.api.post('/api/query/execute').set(alice.auth).send({ query: 'db.employees.deleteMany({})' });
    await ctx.api.post('/api/query/execute').set(carol.auth).send({ query: 'db.employees.deleteOne({ name: "Neha Kapoor" })' });
    const res = await ctx.api.post(`/api/admin/students/${alice.user.id}/reset`).set(inst.auth);
    expect(res.status).toBe(200);
    const a = await ctx.api.post('/api/query/execute').set(alice.auth).send({ query: 'db.employees.countDocuments({})' });
    const c = await ctx.api.post('/api/query/execute').set(carol.auth).send({ query: 'db.employees.countDocuments({})' });
    expect([a.body.value, c.body.value]).toEqual([12, 11]);
  });

  test('initialize a workspace for a student', async () => {
    const res = await ctx.api.post(`/api/admin/students/${bob.user.id}/initialize`).set(inst.auth);
    expect(res.status).toBe(200);
    const q = await ctx.api.post('/api/query/execute').set(bob.auth).send({ query: 'db.courses.countDocuments({})' });
    expect(q.body.value).toBe(12);
  });

  test("disable and re-enable a student's practice access", async () => {
    const off = await ctx.api.patch(`/api/admin/students/${bob.user.id}/access`).set(inst.auth).send({ practiceDisabled: true });
    expect(off.body.student.practiceDisabled).toBe(true);
    const q = await ctx.api.post('/api/query/execute').set(bob.auth).send({ query: 'db.courses.find({})' });
    const sub = await ctx.api.post('/api/questions/Q013/submit').set(bob.auth).send({ query: 'db.courses.find({ isPublished: true })' });
    const reset = await ctx.api.post('/api/workspace/reset').set(bob.auth);
    expect([q.status, sub.status, reset.status]).toEqual([403, 403, 403]);
    expect(q.body.error.code).toBe('PRACTICE_DISABLED');
    const me = await ctx.api.get('/api/me').set(bob.auth);
    expect(me.body.user.practiceDisabled).toBe(true);
    await ctx.api.patch(`/api/admin/students/${bob.user.id}/access`).set(inst.auth).send({ practiceDisabled: false });
    expect((await ctx.api.post('/api/query/execute').set(bob.auth).send({ query: 'db.courses.find({})' })).status).toBe(200);
    expect((await ctx.api.patch(`/api/admin/students/${bob.user.id}/access`).set(inst.auth).send({})).status).toBe(400);
  });

  test('unauthorized admin operations are rejected', async () => {
    expect((await ctx.api.post(`/api/admin/students/${bob.user.id}/reset`)).status).toBe(401);
    expect((await ctx.api.post(`/api/admin/students/${bob.user.id}/reset`).set(alice.auth)).status).toBe(403);
    expect((await ctx.api.patch(`/api/admin/students/${alice.user.id}/access`).set(bob.auth).send({ practiceDisabled: true })).status).toBe(403);
    expect((await ctx.api.post('/api/admin/questions/Q001/assign').set(alice.auth).send({ all: true })).status).toBe(403);
    // Instructors cannot create other instructors (admin only); instructors cannot be reset as students.
    const created = await ctx.api.post('/api/admin/instructors').set(inst.auth).send({ name: 'Second Instructor', email: 'second@test.local', password: 'Second#Pass1' });
    expect(created.status).toBe(201);
    const second = await ctx.api.post('/api/auth/login').send({ email: 'second@test.local', password: 'Second#Pass1' });
    const secondAuth = { Authorization: `Bearer ${second.body.token}` };
    expect((await ctx.api.get('/api/admin/students').set(secondAuth)).status).toBe(200);
    expect((await ctx.api.post('/api/admin/instructors').set(secondAuth).send({ name: 'Third', email: 'third@test.local', password: 'Third#Pass12' })).status).toBe(403);
    expect((await ctx.api.post(`/api/admin/students/${second.body.user.id}/reset`).set(inst.auth)).status).toBe(404);
  });

  test('administrative actions are preserved in the audit history', async () => {
    const res = await ctx.api.get('/api/admin/audit-logs').set(inst.auth);
    const actions = res.body.logs.map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining([
      'admin.workspace.reset', 'admin.workspace.initialize', 'admin.student.access', 'admin.question.create',
      'admin.question.assign', 'admin.instructor.create',
    ]));
    const resetLog = res.body.logs.find((l) => l.action === 'admin.workspace.reset');
    expect(resetLog).toEqual(expect.objectContaining({ actorEmail: inst.user.email, actorRole: inst.user.role, targetUserId: alice.user.id, createdAt: expect.any(String) }));
    const filtered = await ctx.api.get(`/api/admin/audit-logs?studentId=${alice.user.id}`).set(inst.auth);
    expect(filtered.body.logs.every((l) => l.targetUserId === alice.user.id)).toBe(true);
    // Audit log is append-only from the API's perspective: no route deletes or edits it.
    expect((await ctx.api.delete('/api/admin/audit-logs').set(inst.auth)).status).toBe(404);
  });

  test('instructors can seed and reset the template dataset', async () => {
    const seed = await ctx.api.post('/api/admin/datasets/seed').set(inst.auth);
    expect(seed.body.collections.students.total).toBe(12);
    const reset = await ctx.api.post('/api/admin/datasets/reset').set(inst.auth);
    expect(reset.body.collections.orders.total).toBe(16);
  });
});
