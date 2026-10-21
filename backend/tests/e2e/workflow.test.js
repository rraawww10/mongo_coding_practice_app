'use strict';

/**
 * G. End-to-end workflow over real HTTP: the API is started on an ephemeral port and driven
 * exactly as the React frontend drives it (fetch + JSON + Bearer token).
 */
const { startMongo } = require('../helpers/mongo');
const { createTestContext, INSTRUCTOR } = require('../helpers/context');

let mongo;
let ctx;
let server;
let base;

async function http(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  mongo = await startMongo();
  ctx = await createTestContext({ mongoUri: mongo.uri });
  await new Promise((resolve) => {
    server = ctx.app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await ctx?.cleanup();
  await mongo?.stop();
});

describe('G. End-to-end student and instructor workflow', () => {
  const state = {};

  test('health check', async () => {
    const res = await http('GET', '/api/health');
    expect(res).toMatchObject({ status: 200, body: { status: 'ok', database: 'up' } });
  });

  test('1. register a student', async () => {
    const res = await http('POST', '/api/auth/register', { body: { name: 'E2E Student', email: 'e2e.student@test.local', password: 'E2E#Password1' } });
    expect(res.status).toBe(201);
    state.studentId = res.body.user.id;
  });

  test('2. log in', async () => {
    const res = await http('POST', '/api/auth/login', { body: { email: 'e2e.student@test.local', password: 'E2E#Password1' } });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('student');
    state.token = res.body.token;
    const dash = await http('GET', '/api/dashboard', { token: state.token });
    expect(dash.body.connection.status).toBe('not_configured');
    expect(dash.body.modules.length).toBeGreaterThan(0);
  });

  test('3. open the MongoDB connection page', async () => {
    const res = await http('GET', '/api/connection', { token: state.token });
    expect(res.body.connection).toEqual(expect.objectContaining({ mode: null, status: 'not_configured' }));
  });

  test('4. connect to the local simulated database', async () => {
    const res = await http('POST', '/api/connection', { token: state.token, body: { mode: 'local' } });
    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ mode: 'local', status: 'connected' });
  });

  test('5. initialize the assigned practice workspace', async () => {
    const res = await http('POST', '/api/workspace/initialize', { token: state.token, body: {} });
    expect(res.status).toBe(200);
    const ws = await http('GET', '/api/workspace', { token: state.token });
    expect(ws.body.workspace.status).toBe('ready');
    expect(ws.body.collections.map((c) => [c.name, c.count])).toEqual([
      ['students', 12], ['products', 16], ['orders', 16], ['employees', 12], ['courses', 12],
    ]);
  });

  test('6. open the IDE (questions and sample documents load)', async () => {
    const qs = await http('GET', '/api/questions', { token: state.token });
    expect(qs.body.questions.length).toBeGreaterThanOrEqual(20);
    const sample = await http('GET', '/api/workspace/collections/products/sample?limit=3', { token: state.token });
    expect(sample.body).toMatchObject({ collection: 'products', total: 16 });
    expect(sample.body.documents).toHaveLength(3);
  });

  test('7. run a valid query', async () => {
    const res = await http('POST', '/api/query/execute', { token: state.token, body: { query: 'db.products.find({ stock: { $lt: 20 } }, { name: 1, stock: 1, _id: 0 }).sort({ stock: 1 })', collection: 'products' } });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(8);
    expect(res.body.documents[0]).toEqual({ name: 'Football', stock: 0 });
    // the student also modifies their own workspace, which the instructor will later reset
    const del = await http('POST', '/api/query/execute', { token: state.token, body: { query: 'db.products.deleteMany({ category: "Books" })' } });
    expect(del.body.value.deletedCount).toBe(3);
  });

  test('8. run an invalid query', async () => {
    const res = await http('POST', '/api/query/execute', { token: state.token, body: { query: 'db.products.find({ stock: { $lt: 20 }' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_SYNTAX', line: 1 });
  });

  test('9. submit a correct answer', async () => {
    const res = await http('POST', '/api/questions/Q011/submit', { token: state.token, body: { query: 'db.products.find({ stock: { $lt: 20 } })' } });
    expect(res.body).toMatchObject({ status: 'passed', score: 10, attemptNumber: 1 });
  });

  test('10. submit an incorrect answer', async () => {
    const res = await http('POST', '/api/questions/Q010/submit', { token: state.token, body: { query: 'db.employees.aggregate([{ $group: { _id: "$department", avgSalary: { $sum: "$salary" } } }])' } });
    expect(res.body).toMatchObject({ status: 'failed', score: 0, attemptNumber: 1 });
    expect(res.body.testResults.find((t) => t.id === 'documents').passed).toBe(false);
  });

  test('11. verify the score and attempt history', async () => {
    const res = await http('GET', '/api/progress', { token: state.token });
    expect(res.body.progress).toMatchObject({ completed: 1, attempted: 2, totalAttempts: 2, score: 10 });
    expect(res.body.attempts.map((a) => [a.questionId, a.status])).toEqual([['Q010', 'failed'], ['Q011', 'passed']]);
  });

  test('12. log in as an instructor', async () => {
    const res = await http('POST', '/api/auth/login', { body: INSTRUCTOR });
    expect(res.status).toBe(200);
    expect(['instructor', 'admin']).toContain(res.body.user.role);
    state.instructorToken = res.body.token;
  });

  test("13. view the student's progress", async () => {
    const list = await http('GET', '/api/admin/students', { token: state.instructorToken });
    const row = list.body.students.find((s) => s.id === state.studentId);
    expect(row).toMatchObject({ connection: { status: 'connected', mode: 'local' }, progress: { score: 10, completed: 1, attempts: 2 } });
    const detail = await http('GET', `/api/admin/students/${state.studentId}`, { token: state.instructorToken });
    expect(detail.body.questions.find((q) => q.questionId === 'Q011')).toMatchObject({ completed: true, bestScore: 10 });
  });

  test("14. reset the student's practice dataset", async () => {
    // A second student exists with modified data that must survive the reset.
    const other = await ctx.readyStudent('Bystander');
    await ctx.api.post('/api/query/execute').set(other.auth).send({ query: 'db.courses.deleteMany({ level: "advanced" })' });
    state.other = other;
    const res = await http('POST', `/api/admin/students/${state.studentId}/reset`, { token: state.instructorToken });
    expect(res.status).toBe(200);
  });

  test("15. the reset worked and other students' data is unchanged", async () => {
    const books = await http('POST', '/api/query/execute', { token: state.token, body: { query: 'db.products.countDocuments({ category: "Books" })' } });
    expect(books.body.value).toBe(3);
    const otherCourses = await ctx.api.post('/api/query/execute').set(state.other.auth).send({ query: 'db.courses.countDocuments({})' });
    expect(otherCourses.body.value).toBe(8);
    // Attempt history is preserved across a data reset.
    const progress = await http('GET', '/api/progress', { token: state.token });
    expect(progress.body.progress.score).toBe(10);
    const audit = await http('GET', `/api/admin/audit-logs?studentId=${state.studentId}`, { token: state.instructorToken });
    expect(audit.body.logs.map((l) => l.action)).toContain('admin.workspace.reset');
  });
});
