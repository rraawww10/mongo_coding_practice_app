'use strict';

const { getQuestionBank, POINTS, TOPIC_ORDER } = require('./questionBank');
const { buildTestCases } = require('./evaluationService');
const { badRequest, notFound } = require('../utils/errors');
const { isQueryError } = require('../query/executor');

const SERVER_ONLY_FIELDS = ['solution', 'verifyQuery', 'scopeQuery', '_id'];

class QuestionService {
  constructor({ mongo, executor, evaluation }) {
    this.mongo = mongo;
    this.executor = executor;
    this.evaluation = evaluation;
  }

  get questions() {
    return this.mongo.collection('questions');
  }

  /** Idempotent: upserts the bank by questionId. */
  async seedQuestions() {
    const bank = getQuestionBank();
    for (const question of bank) {
      const doc = { ...question, testCases: buildTestCases(question), source: 'seed', active: true };
      // eslint-disable-next-line no-await-in-loop
      await this.questions.updateOne(
        { questionId: question.questionId },
        { $set: { ...doc, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
    }
    this.evaluation.clearCache();
    return { count: bank.length };
  }

  /** Student view: never includes the reference solution or verification queries. */
  static publicView(question) {
    const out = {};
    for (const [k, v] of Object.entries(question)) if (!SERVER_ONLY_FIELDS.includes(k)) out[k] = v;
    out.testCases = (question.testCases || []).map(({ id, name }) => ({ id, name }));
    out.starterQuery = `db.${question.collection}.`;
    return out;
  }

  async getById(questionId) {
    const question = await this.questions.findOne({ questionId, active: { $ne: false } });
    if (!question) throw notFound('QUESTION_NOT_FOUND', `Question ${questionId} was not found.`);
    return question;
  }

  async assignedQuestionIds(studentId) {
    const assigned = await this.mongo.collection('assignments').find({ studentId }).project({ questionId: 1 }).toArray();
    return assigned.map((a) => a.questionId);
  }

  async isAssigned(question, studentId) {
    if (question.assignToAll) return true;
    return (await this.mongo.collection('assignments').countDocuments({ studentId, questionId: question.questionId })) > 0;
  }

  async listForStudent(studentId) {
    const ids = await this.assignedQuestionIds(studentId);
    const docs = await this.questions
      .find({ active: { $ne: false }, $or: [{ assignToAll: true }, { questionId: { $in: ids } }] })
      .sort({ questionId: 1 })
      .toArray();
    return docs;
  }

  async listAll() {
    return this.questions.find({}).sort({ questionId: 1 }).toArray();
  }

  static modules(questions, progressByQuestion = {}) {
    const byTopic = new Map();
    for (const q of questions) {
      if (!byTopic.has(q.topic)) byTopic.set(q.topic, []);
      byTopic.get(q.topic).push(q);
    }
    const ordered = [...byTopic.keys()].sort((a, b) => {
      const ia = TOPIC_ORDER.indexOf(a);
      const ib = TOPIC_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return ordered.map((topic) => {
      const qs = byTopic.get(topic);
      const completed = qs.filter((q) => progressByQuestion[q.questionId]?.completed).length;
      return {
        topic,
        questionCount: qs.length,
        completed,
        points: qs.reduce((s, q) => s + q.points, 0),
        questions: qs.map((q) => ({
          questionId: q.questionId,
          title: q.title,
          difficulty: q.difficulty,
          points: q.points,
          completed: Boolean(progressByQuestion[q.questionId]?.completed),
        })),
      };
    });
  }

  /** Instructor-authored question. The reference solution is validated and executed before saving. */
  async createQuestion(input, actorId) {
    const difficulty = input.difficulty;
    const question = {
      questionId: input.questionId || (await this.nextQuestionId()),
      title: input.title,
      topic: input.topic || 'Custom',
      difficulty,
      collection: input.collection,
      description: input.description,
      requirements: input.requirements || '',
      kind: input.kind || 'read',
      ordered: Boolean(input.ordered),
      ignoreFields: input.ignoreFields ?? ['_id'],
      allowedOperations: input.allowedOperations,
      points: input.points ?? POINTS[difficulty],
      solution: input.solution,
      verifyQuery: input.verifyQuery,
      scopeQuery: input.scopeQuery,
      assignToAll: Boolean(input.assignToAll),
      source: 'instructor',
      active: true,
      createdBy: actorId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (question.kind === 'write' && (!question.verifyQuery || !question.scopeQuery)) {
      throw badRequest('INVALID_QUESTION', 'Write questions require verifyQuery and scopeQuery.');
    }
    if (await this.questions.findOne({ questionId: question.questionId })) {
      throw badRequest('DUPLICATE_QUESTION', `Question ${question.questionId} already exists.`);
    }
    try {
      const plan = this.executor.prepare(question.solution);
      if (plan.collection !== question.collection) throw badRequest('INVALID_QUESTION', 'The solution must query the question collection.');
      if (!question.allowedOperations.includes(plan.operation)) {
        throw badRequest('INVALID_QUESTION', `The solution uses ${plan.operation}, which is not in allowedOperations.`);
      }
      await this.evaluation.expected(question);
    } catch (err) {
      if (isQueryError(err)) throw badRequest('INVALID_SOLUTION', `Reference solution is invalid: ${err.message}`);
      throw err;
    }
    question.testCases = input.testCases?.length ? input.testCases : buildTestCases(question);
    await this.questions.insertOne(question);
    return question;
  }

  async nextQuestionId() {
    const last = await this.questions.find({ questionId: /^Q\d+$/ }).sort({ questionId: -1 }).limit(1).toArray();
    const n = last.length ? Number(last[0].questionId.slice(1)) + 1 : 1;
    return `Q${String(n).padStart(3, '0')}`;
  }

  async assign(questionId, { studentIds = [], all = false }, actorId) {
    await this.getById(questionId);
    if (all) {
      await this.questions.updateOne({ questionId }, { $set: { assignToAll: true, updatedAt: new Date() } });
      return { questionId, assignToAll: true, assigned: 'all' };
    }
    const students = await this.mongo
      .collection('users')
      .find({ _id: { $in: studentIds }, role: 'student' })
      .project({ _id: 1 })
      .toArray();
    if (students.length !== studentIds.length) throw badRequest('INVALID_STUDENT', 'One or more students were not found.');
    for (const s of students) {
      // eslint-disable-next-line no-await-in-loop
      await this.mongo.collection('assignments').updateOne(
        { studentId: s._id, questionId },
        { $setOnInsert: { studentId: s._id, questionId, assignedBy: actorId, assignedAt: new Date() } },
        { upsert: true },
      );
    }
    return { questionId, assigned: students.length };
  }
}

module.exports = { QuestionService };
