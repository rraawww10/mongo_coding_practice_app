'use strict';

const express = require('express');
const { EJSON } = require('mongodb').BSON;
const schemas = require('./schemas');
const { validate, requirePracticeAccess } = require('../middleware');
const { AuthService } = require('../auth/authService');
const { ConnectionManager } = require('../connections/connectionManager');
const { QuestionService } = require('../questions/questionService');
const { PRACTICE_COLLECTIONS } = require('../provisioning/sampleData');
const { isQueryError } = require('../query/executor');
const { QueryValidationError } = require('../query/validator');
const { forbidden, badRequest, AppError } = require('../utils/errors');

const SECURITY_CODES = ['FORBIDDEN_COLLECTION', 'FORBIDDEN_OPERATOR', 'FORBIDDEN_DATABASE', 'JS_NOT_ALLOWED', 'UNSUPPORTED_OPERATION'];

/** BSON type name as the Mongo shell would call it, used by the collection browser. */
function bsonType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value && value._bsontype === 'ObjectId') return 'objectId';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int32' : 'double';
  if (typeof value === 'object') return 'object';
  return typeof value; // string | boolean
}

/** Field list (name + the types seen) for the schema view of a collection. */
function describeFields(docs) {
  const types = new Map();
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      if (!types.has(key)) types.set(key, new Set());
      types.get(key).add(bsonType(value));
    }
  }
  return [...types].map(([name, set]) => ({ name, types: [...set] }));
}

/** Routes used by students (and instructors trying things out). Mounted behind authenticate(). */
function studentRoutes(ctx) {
  const { config, workspaces, executor, questions, evaluation, progress, audit, mongo, limiters } = ctx;
  const router = express.Router();

  const queryErrorBody = (err) => ({
    error: { code: err.code, message: err.message, ...(err.line ? { line: err.line, column: err.column } : {}) },
  });

  const recordHistory = (req, entry) =>
    mongo.collection('query_history').insertOne({
      userId: req.user.id,
      userEmail: req.user.email,
      query: String(req.body?.query || '').slice(0, 2000),
      createdAt: new Date(),
      ...entry,
    });

  // ---- profile & dashboard -------------------------------------------------------------------
  router.get('/me', (req, res) => res.json({ user: AuthService.publicUser(req.user.doc) }));

  router.get('/dashboard', async (req, res) => {
    const assigned = await questions.listForStudent(req.user.id);
    const summary = await progress.summary(req.user.id, assigned);
    const conn = await workspaces.getConnection(req.user.id);
    const ws = await workspaces.getWorkspace(req.user.id);
    res.json({
      user: AuthService.publicUser(req.user.doc),
      connection: ConnectionManager.publicView(conn),
      workspace: ws ? { mode: ws.mode, status: ws.status } : { status: 'not_initialized' },
      progress: { ...summary, perQuestion: undefined },
      modules: QuestionService.modules(assigned, summary.perQuestion),
    });
  });

  // ---- connection ----------------------------------------------------------------------------
  router.get('/connection', async (req, res) => {
    res.json({ connection: ConnectionManager.publicView(await workspaces.getConnection(req.user.id)) });
  });

  router.post('/connection', limiters.connection, validate(schemas.connection), async (req, res) => {
    const record =
      req.body.mode === 'local'
        ? await workspaces.connectLocal(req.user.id)
        : await workspaces.connectAtlas(req.user.id, req.body);
    await audit.record({ actor: req.user, action: 'connection.connect', targetUserId: req.user.id, details: { mode: record.mode, host: record.host } });
    res.json({ connection: ConnectionManager.publicView(record) });
  });

  router.post('/connection/test', limiters.connection, async (req, res) => {
    const record = await workspaces.retest(req.user.id);
    res.status(record.status === 'connected' ? 200 : 502).json({ connection: ConnectionManager.publicView(record) });
  });

  router.delete('/connection', async (req, res) => {
    const result = await workspaces.disconnect(req.user.id);
    await audit.record({ actor: req.user, action: 'connection.disconnect', targetUserId: req.user.id });
    res.json(result);
  });

  // ---- workspace -----------------------------------------------------------------------------
  router.get('/workspace', async (req, res) => {
    res.json(await workspaces.describe(req.user.id));
  });

  router.post('/workspace/initialize', requirePracticeAccess, validate(schemas.initialize), async (req, res) => {
    const result = await workspaces.initialize(req.user.id, { confirm: req.body.confirm });
    await audit.record({ actor: req.user, action: 'workspace.initialize', targetUserId: req.user.id });
    res.json({ ok: true, collections: result.collections });
  });

  router.post('/workspace/reset', requirePracticeAccess, async (req, res) => {
    if (req.user.doc.allowSelfReset === false) {
      await audit.record({ actor: req.user, action: 'workspace.reset', targetUserId: req.user.id, outcome: 'denied' });
      throw forbidden('RESET_NOT_ALLOWED', 'Resetting your workspace has been disabled by your instructor.');
    }
    const result = await workspaces.reset(req.user.id);
    await audit.record({ actor: req.user, action: 'workspace.reset', targetUserId: req.user.id });
    res.json({ ok: true, collections: result.collections });
  });

  /**
   * One call to get a student ready to practise: connect to the local simulation if no
   * connection exists yet, then initialize the workspace if it is not ready. Idempotent, so
   * the IDE can call it on every load. Atlas databases are never written to without a
   * confirmation, so an Atlas student that needs initialization is reported, not touched.
   */
  router.post('/workspace/ensure', requirePracticeAccess, async (req, res) => {
    let conn = await workspaces.getConnection(req.user.id);
    if (!conn || conn.status !== 'connected') {
      conn = await workspaces.connectLocal(req.user.id);
      await audit.record({ actor: req.user, action: 'connection.connect', targetUserId: req.user.id, details: { mode: 'local', auto: true } });
    }
    const ws = await workspaces.getWorkspace(req.user.id);
    if (conn.mode === 'local' && (!ws || ws.status !== 'ready' || ws.mode !== 'local')) {
      await workspaces.initialize(req.user.id, {});
      await audit.record({ actor: req.user, action: 'workspace.initialize', targetUserId: req.user.id, details: { auto: true } });
    }
    res.json(await workspaces.describe(req.user.id));
  });

  /** Documents of one practice collection, for the "Show collections" browser in the IDE. */
  router.get('/workspace/collections/:name/sample', async (req, res) => {
    const { name } = req.params;
    if (!PRACTICE_COLLECTIONS.includes(name)) throw badRequest('INVALID_COLLECTION', `Unknown collection '${name}'.`);
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 5, 50);
    const { db } = await workspaces.resolveDb(req.user.id);
    const docs = await db.collection(name).find({}).limit(limit).toArray();
    const total = await db.collection(name).countDocuments();
    res.json({
      collection: name,
      total,
      fields: describeFields(docs),
      documents: EJSON.serialize(docs, { relaxed: true }),
    });
  });

  // ---- query IDE -----------------------------------------------------------------------------
  router.post('/query/execute', requirePracticeAccess, limiters.query, validate(schemas.execute), async (req, res) => {
    const { query, collection, database } = req.body;
    if (database && database !== config.templateDbName) {
      await recordHistory(req, { ok: false, errorCode: 'FORBIDDEN_DATABASE' });
      await audit.record({ actor: req.user, action: 'query.blocked', targetUserId: req.user.id, details: { code: 'FORBIDDEN_DATABASE', database }, outcome: 'denied' });
      throw forbidden('FORBIDDEN_DATABASE', 'You can only query your own practice workspace.');
    }
    let plan;
    try {
      plan = executor.prepare(query);
      if (collection && collection !== plan.collection) {
        throw new QueryValidationError(
          'COLLECTION_MISMATCH',
          `The query targets '${plan.collection}' but '${collection}' is selected. Change the selector or the query.`,
        );
      }
    } catch (err) {
      if (!isQueryError(err)) throw err;
      await recordHistory(req, { ok: false, errorCode: err.code, errorMessage: err.message });
      if (SECURITY_CODES.includes(err.code)) {
        await audit.record({ actor: req.user, action: 'query.blocked', targetUserId: req.user.id, details: { code: err.code }, outcome: 'denied' });
      }
      return res.status(err.status || 400).json(queryErrorBody(err));
    }

    const { db } = await workspaces.resolveDb(req.user.id);
    try {
      const result = await executor.run(db, plan);
      await recordHistory(req, {
        ok: true,
        collection: plan.collection,
        operation: plan.operation,
        count: result.count,
        durationMs: result.durationMs,
      });
      const { raw, ...payload } = result;
      return res.json({ ok: true, database: config.templateDbName, ...payload });
    } catch (err) {
      if (!isQueryError(err)) throw err;
      await recordHistory(req, { ok: false, collection: plan.collection, operation: plan.operation, errorCode: err.code, errorMessage: err.message });
      return res.status(err.status || 400).json(queryErrorBody(err));
    }
  });

  router.get('/query/history', async (req, res) => {
    const items = await mongo
      .collection('query_history')
      .find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .project({ userId: 0, userEmail: 0 })
      .toArray();
    res.json({ history: items });
  });

  // ---- questions & submissions ---------------------------------------------------------------
  router.get('/questions', async (req, res) => {
    const assigned = await questions.listForStudent(req.user.id);
    const perQuestion = await progress.questionProgress(req.user.id);
    res.json({
      questions: assigned.map((q) => ({
        ...QuestionService.publicView(q),
        progress: perQuestion[q.questionId] || { attempts: 0, bestScore: 0, completed: false },
      })),
    });
  });

  const loadAssigned = async (req) => {
    const question = await questions.getById(req.params.questionId);
    if (!(await questions.isAssigned(question, req.user.id))) {
      throw forbidden('QUESTION_NOT_ASSIGNED', 'This question is not assigned to you.');
    }
    return question;
  };

  router.get('/questions/:questionId', async (req, res) => {
    const question = await loadAssigned(req);
    const perQuestion = await progress.questionProgress(req.user.id);
    const attempts = await progress.listAttempts({ userId: req.user.id, questionId: question.questionId }, 20);
    res.json({
      question: QuestionService.publicView(question),
      progress: perQuestion[question.questionId] || { attempts: 0, bestScore: 0, completed: false },
      attempts: attempts.map(({ userId, ...a }) => a),
    });
  });

  router.post('/questions/:questionId/submit', requirePracticeAccess, limiters.query, validate(schemas.submit), async (req, res) => {
    const question = await loadAssigned(req);
    if (req.body.query.length > config.queryMaxLength) {
      throw new AppError(413, 'QUERY_TOO_LARGE', `Query exceeds the maximum length of ${config.queryMaxLength} characters.`);
    }
    const started = Date.now();
    const result = await evaluation.evaluate(question, req.body.query, String(req.user.id));
    const attempt = await progress.recordAttempt({
      userId: req.user.id,
      question,
      query: req.body.query,
      evaluation: result,
      durationMs: Date.now() - started,
    });
    const perQuestion = await progress.questionProgress(req.user.id);
    res.json({
      questionId: question.questionId,
      status: result.status,
      passed: result.passed,
      score: result.score,
      maxScore: result.maxScore,
      attemptNumber: attempt.attemptNumber,
      testResults: result.testResults,
      error: result.error || null,
      output: result.output || null,
      progress: perQuestion[question.questionId],
    });
  });

  router.get('/progress', async (req, res) => {
    const assigned = await questions.listForStudent(req.user.id);
    const summary = await progress.summary(req.user.id, assigned);
    const attempts = await progress.listAttempts({ userId: req.user.id }, 100);
    res.json({ progress: summary, attempts: attempts.map(({ userId, ...a }) => a) });
  });

  return router;
}

module.exports = { studentRoutes };
