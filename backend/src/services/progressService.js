'use strict';

/** Attempts, scores and completion tracking. */
class ProgressService {
  constructor({ mongo }) {
    this.mongo = mongo;
  }

  get attempts() {
    return this.mongo.collection('attempts');
  }

  async recordAttempt({ userId, question, query, evaluation, durationMs }) {
    const previous = await this.attempts.countDocuments({ userId, questionId: question.questionId });
    const attempt = {
      userId,
      questionId: question.questionId,
      questionTitle: question.title,
      query,
      status: evaluation.status,
      passed: evaluation.passed,
      score: evaluation.score,
      maxScore: evaluation.maxScore,
      testResults: evaluation.testResults,
      error: evaluation.error || null,
      attemptNumber: previous + 1,
      durationMs,
      createdAt: new Date(),
    };
    const { insertedId } = await this.attempts.insertOne(attempt);
    return { ...attempt, _id: insertedId };
  }

  /** Per-question summary: attempts, best score, completion. */
  async questionProgress(userId) {
    const rows = await this.attempts
      .aggregate([
        { $match: { userId } },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: '$questionId',
            attempts: { $sum: 1 },
            bestScore: { $max: '$score' },
            maxScore: { $last: '$maxScore' },
            completed: { $max: '$passed' },
            lastStatus: { $last: '$status' },
            lastAttemptAt: { $last: '$createdAt' },
          },
        },
      ])
      .toArray();
    return Object.fromEntries(rows.map((r) => [r._id, { ...r, questionId: r._id, completed: Boolean(r.completed) }]));
  }

  async summary(userId, assignedQuestions) {
    const perQuestion = await this.questionProgress(userId);
    const assignedIds = new Set(assignedQuestions.map((q) => q.questionId));
    const relevant = Object.values(perQuestion).filter((p) => assignedIds.has(p.questionId));
    return {
      totalQuestions: assignedQuestions.length,
      completed: relevant.filter((p) => p.completed).length,
      attempted: relevant.length,
      totalAttempts: relevant.reduce((s, p) => s + p.attempts, 0),
      score: relevant.reduce((s, p) => s + (p.bestScore || 0), 0),
      maxScore: assignedQuestions.reduce((s, q) => s + q.points, 0),
      perQuestion,
    };
  }

  async listAttempts(filter = {}, limit = 100) {
    return this.attempts.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).toArray();
  }
}

module.exports = { ProgressService };
