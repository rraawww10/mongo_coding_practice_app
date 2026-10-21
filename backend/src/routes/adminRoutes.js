'use strict';

const express = require('express');
const { ObjectId } = require('mongodb');
const schemas = require('./schemas');
const { validate, objectIdParam, requireRole } = require('../middleware');
const { AuthService } = require('../auth/authService');
const { ConnectionManager } = require('../connections/connectionManager');
const { notFound, badRequest } = require('../utils/errors');

/** Instructor/admin API. Every route requires the instructor or admin role (checked server-side). */
function adminRoutes(ctx) {
  const { mongo, config, auth, workspaces, provisioning, questions, progress, audit } = ctx;
  const router = express.Router();
  router.use(requireRole('instructor', 'admin'));

  const users = () => mongo.collection('users');

  const loadStudent = async (id) => {
    const student = await users().findOne({ _id: id, role: 'student' });
    if (!student) throw notFound('STUDENT_NOT_FOUND', 'Student not found.');
    return student;
  };

  router.get('/students', async (req, res) => {
    const students = await users().find({ role: 'student' }).sort({ createdAt: 1 }).toArray();
    const ids = students.map((s) => s._id);
    const [conns, wss, totals] = await Promise.all([
      mongo.collection('connections').find({ userId: { $in: ids } }).toArray(),
      mongo.collection('workspaces').find({ userId: { $in: ids } }).toArray(),
      mongo
        .collection('attempts')
        .aggregate([
          { $match: { userId: { $in: ids } } },
          { $group: { _id: { u: '$userId', q: '$questionId' }, best: { $max: '$score' }, passed: { $max: '$passed' }, n: { $sum: 1 } } },
          { $group: { _id: '$_id.u', score: { $sum: '$best' }, completed: { $sum: { $cond: ['$passed', 1, 0] } }, attempts: { $sum: '$n' } } },
        ])
        .toArray(),
    ]);
    const byUser = (arr, key = 'userId') => Object.fromEntries(arr.map((x) => [String(x[key]), x]));
    const c = byUser(conns);
    const w = byUser(wss);
    const t = byUser(totals, '_id');
    res.json({
      students: students.map((s) => {
        const id = String(s._id);
        return {
          ...AuthService.publicUser(s),
          lastLoginAt: s.lastLoginAt || null,
          connection: ConnectionManager.publicView(c[id]),
          workspace: w[id] ? { mode: w[id].mode, status: w[id].status, lastResetAt: w[id].lastResetAt || null } : { status: 'not_initialized' },
          progress: { score: t[id]?.score || 0, completed: t[id]?.completed || 0, attempts: t[id]?.attempts || 0 },
        };
      }),
    });
  });

  router.get('/students/:id', objectIdParam('id'), async (req, res) => {
    const student = await loadStudent(req.params.idObj);
    const assigned = await questions.listForStudent(student._id);
    const summary = await progress.summary(student._id, assigned);
    const ws = await workspaces.getWorkspace(student._id);
    res.json({
      student: AuthService.publicUser(student),
      connection: ConnectionManager.publicView(await workspaces.getConnection(student._id)),
      workspace: ws ? { mode: ws.mode, status: ws.status, initializedAt: ws.initializedAt, lastResetAt: ws.lastResetAt, resetCount: ws.resetCount || 0 } : { status: 'not_initialized' },
      progress: summary,
      questions: assigned.map((q) => ({ questionId: q.questionId, title: q.title, difficulty: q.difficulty, points: q.points, ...(summary.perQuestion[q.questionId] || { attempts: 0, bestScore: 0, completed: false }) })),
    });
  });

  router.get('/students/:id/attempts', objectIdParam('id'), async (req, res) => {
    const student = await loadStudent(req.params.idObj);
    res.json({ attempts: await progress.listAttempts({ userId: student._id }, 200) });
  });

  router.get('/students/:id/query-history', objectIdParam('id'), async (req, res) => {
    const student = await loadStudent(req.params.idObj);
    const history = await mongo.collection('query_history').find({ userId: student._id }).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ history });
  });

  router.get('/submissions', async (req, res) => {
    const filter = {};
    if (req.query.studentId) {
      if (!ObjectId.isValid(req.query.studentId)) throw badRequest('INVALID_ID', 'Invalid studentId.');
      filter.userId = new ObjectId(req.query.studentId);
    }
    if (req.query.questionId) filter.questionId = String(req.query.questionId);
    if (req.query.status) filter.status = String(req.query.status);
    const attempts = await progress.listAttempts(filter, 300);
    const userIds = [...new Set(attempts.map((a) => String(a.userId)))].map((id) => new ObjectId(id));
    const names = Object.fromEntries((await users().find({ _id: { $in: userIds } }).project({ name: 1, email: 1 }).toArray()).map((u) => [String(u._id), u]));
    res.json({ submissions: attempts.map((a) => ({ ...a, studentName: names[String(a.userId)]?.name, studentEmail: names[String(a.userId)]?.email })) });
  });

  router.get('/query-history', async (req, res) => {
    const filter = {};
    if (req.query.studentId && ObjectId.isValid(req.query.studentId)) filter.userId = new ObjectId(req.query.studentId);
    if (req.query.ok === 'false') filter.ok = false;
    const history = await mongo.collection('query_history').find(filter).sort({ createdAt: -1 }).limit(300).toArray();
    res.json({ history });
  });

  router.post('/students/:id/initialize', objectIdParam('id'), async (req, res) => {
    const student = await loadStudent(req.params.idObj);
    const result = await provisioning.initializeLocalWorkspace(student._id);
    // Make sure the student is connected to the local simulation so the workspace is usable.
    const conn = await workspaces.getConnection(student._id);
    if (!conn) await workspaces.connectLocal(student._id);
    await audit.record({ actor: req.user, action: 'admin.workspace.initialize', targetUserId: student._id, details: { dbName: result.dbName } });
    res.json({ ok: true, collections: result.collections });
  });

  router.post('/students/:id/reset', objectIdParam('id'), async (req, res) => {
    const student = await loadStudent(req.params.idObj);
    const ws = await workspaces.getWorkspace(student._id);
    const result = ws?.mode === 'atlas' ? await workspaces.reset(student._id) : await provisioning.resetLocalWorkspace(student._id);
    await audit.record({ actor: req.user, action: 'admin.workspace.reset', targetUserId: student._id, details: { mode: ws?.mode || 'local' } });
    res.json({ ok: true, collections: result.collections });
  });

  router.patch('/students/:id/access', objectIdParam('id'), validate(schemas.access), async (req, res) => {
    const student = await loadStudent(req.params.idObj);
    const update = {};
    if (req.body.practiceDisabled !== undefined) update.practiceDisabled = req.body.practiceDisabled;
    if (req.body.allowSelfReset !== undefined) update.allowSelfReset = req.body.allowSelfReset;
    await users().updateOne({ _id: student._id }, { $set: update });
    await audit.record({ actor: req.user, action: 'admin.student.access', targetUserId: student._id, details: update });
    res.json({ student: AuthService.publicUser({ ...student, ...update }) });
  });

  // ---- questions -------------------------------------------------------------------------------
  router.get('/questions', async (req, res) => {
    const all = await questions.listAll();
    const assignments = await mongo.collection('assignments').aggregate([{ $group: { _id: '$questionId', n: { $sum: 1 } } }]).toArray();
    const counts = Object.fromEntries(assignments.map((a) => [a._id, a.n]));
    res.json({ questions: all.map((q) => ({ ...q, assignedCount: counts[q.questionId] || 0 })) });
  });

  router.post('/questions', validate(schemas.createQuestion), async (req, res) => {
    const question = await questions.createQuestion(req.body, req.user.id);
    await audit.record({ actor: req.user, action: 'admin.question.create', details: { questionId: question.questionId } });
    res.status(201).json({ question });
  });

  router.post('/questions/:questionId/assign', validate(schemas.assign), async (req, res) => {
    const studentIds = (req.body.studentIds || []).map((id) => new ObjectId(id));
    const result = await questions.assign(req.params.questionId, { studentIds, all: req.body.all }, req.user.id);
    await audit.record({ actor: req.user, action: 'admin.question.assign', details: { questionId: req.params.questionId, studentIds: req.body.studentIds, all: Boolean(req.body.all) } });
    res.json(result);
  });

  // ---- datasets --------------------------------------------------------------------------------
  router.get('/datasets', async (req, res) => {
    const template = await provisioning.describeDatabase(mongo.adminClient.db(config.templateDbName));
    res.json({ database: config.templateDbName, collections: template });
  });

  router.post('/datasets/seed', async (req, res) => {
    const summary = await provisioning.seedTemplate();
    await audit.record({ actor: req.user, action: 'admin.dataset.seed', details: { database: config.templateDbName } });
    res.json({ ok: true, database: config.templateDbName, collections: summary });
  });

  router.post('/datasets/reset', async (req, res) => {
    const summary = await provisioning.resetTemplate();
    await audit.record({ actor: req.user, action: 'admin.dataset.reset', details: { database: config.templateDbName } });
    res.json({ ok: true, database: config.templateDbName, collections: summary });
  });

  router.get('/audit-logs', async (req, res) => {
    const filter = {};
    if (req.query.studentId && ObjectId.isValid(req.query.studentId)) filter.targetUserId = new ObjectId(req.query.studentId);
    if (req.query.action) filter.action = String(req.query.action);
    res.json({ logs: await audit.list({ ...filter, limit: 300 }) });
  });

  // Admin-only: create additional instructor accounts.
  router.post('/instructors', requireRole('admin'), validate(schemas.register), async (req, res) => {
    const user = await auth.register(req.body, 'instructor');
    await audit.record({ actor: req.user, action: 'admin.instructor.create', targetUserId: user._id });
    res.status(201).json({ user: AuthService.publicUser(user) });
  });

  return router;
}

module.exports = { adminRoutes };
