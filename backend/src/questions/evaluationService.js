'use strict';

const { compareResults, stableStringify } = require('../utils/canonical');
const { isQueryError } = require('../query/executor');

/** Default test cases derived from the question kind; instructors may add their own. */
function buildTestCases(question) {
  const cases = [{ id: 'target', name: `Uses the ${question.collection} collection with an allowed operation`, type: 'target' }];
  if (question.kind === 'write') {
    cases.push({ id: 'state', name: 'The target data was changed correctly', type: 'state' });
    cases.push({ id: 'scope', name: 'No other documents were changed', type: 'scope' });
    return cases;
  }
  const valueOps = ['countDocuments', 'distinct'];
  if (question.allowedOperations.every((op) => valueOps.includes(op))) {
    cases.push({ id: 'value', name: 'Returns the correct value', type: 'value' });
    return cases;
  }
  cases.push({ id: 'count', name: 'Returns the correct number of documents', type: 'count' });
  cases.push({ id: 'documents', name: 'Returned documents have the correct content', type: 'documents' });
  if (question.ordered) cases.push({ id: 'order', name: 'Documents are in the required order', type: 'order' });
  return cases;
}

const resultRows = (res) => {
  if (res.resultType === 'value') return null;
  return res.raw || [];
};

/**
 * Grades submissions by running them inside a throw-away sandbox database cloned from the
 * canonical dataset, so grading is deterministic and independent of the student's workspace.
 */
class EvaluationService {
  constructor({ provisioning, executor }) {
    this.provisioning = provisioning;
    this.executor = executor;
    this.expectedCache = new Map();
  }

  /** Runs a query string inside a db and returns the raw executor result. */
  async runText(db, text) {
    return this.executor.run(db, this.executor.prepare(text));
  }

  async outcome(db, question, text) {
    const primary = await this.runText(db, text);
    if (question.kind !== 'write') return { primary };
    const verify = await this.runText(db, question.verifyQuery);
    const scope = await this.runText(db, question.scopeQuery);
    return { primary, verify, scope };
  }

  /** Expected outcome of the reference solution on pristine data (cached per solution). */
  async expected(question) {
    const key = `${question.questionId}:${question.solution}:${question.verifyQuery || ''}:${question.scopeQuery || ''}`;
    if (this.expectedCache.has(key)) return this.expectedCache.get(key);
    const sandbox = await this.provisioning.createSandbox(`ref_${question.questionId}`);
    try {
      const result = await this.outcome(sandbox.db, question, question.solution);
      this.expectedCache.set(key, result);
      return result;
    } finally {
      await sandbox.drop();
    }
  }

  clearCache() {
    this.expectedCache.clear();
  }

  /**
   * @returns {Promise<{status, passed, score, maxScore, testResults, output, error?}>}
   */
  async evaluate(question, queryText, label = 'anon') {
    const testCases = question.testCases?.length ? question.testCases : buildTestCases(question);
    const maxScore = question.points;
    const failAll = (message) =>
      testCases.map((tc) => ({ id: tc.id, name: tc.name, passed: false, message }));

    let plan;
    try {
      plan = this.executor.prepare(queryText);
    } catch (err) {
      if (!isQueryError(err)) throw err;
      return { status: 'error', passed: false, score: 0, maxScore, error: { code: err.code, message: err.message }, testResults: failAll('Query could not be run.') };
    }

    const targetOk = plan.collection === question.collection && question.allowedOperations.includes(plan.operation);
    if (!targetOk) {
      const message =
        plan.collection !== question.collection
          ? `This question must be answered using the '${question.collection}' collection (your query used '${plan.collection}').`
          : `Use one of these operations for this question: ${question.allowedOperations.join(', ')} (your query used ${plan.operation}).`;
      return {
        status: 'failed',
        passed: false,
        score: 0,
        maxScore,
        testResults: testCases.map((tc) => ({ id: tc.id, name: tc.name, passed: false, message: tc.type === 'target' ? message : 'Skipped because the query targets the wrong collection or operation.' })),
        output: null,
      };
    }

    const expected = await this.expected(question);
    const sandbox = await this.provisioning.createSandbox(label);
    let actual;
    try {
      actual = await this.outcome(sandbox.db, question, queryText);
    } catch (err) {
      if (!isQueryError(err)) throw err;
      return { status: 'error', passed: false, score: 0, maxScore, error: { code: err.code, message: err.message }, testResults: failAll('Query failed while running.') };
    } finally {
      await sandbox.drop();
    }

    const testResults = testCases.map((tc) => this.runTestCase(tc, question, actual, expected));
    const passed = testResults.every((t) => t.passed);
    const primary = actual.primary;
    return {
      status: passed ? 'passed' : 'failed',
      passed,
      score: passed ? maxScore : 0,
      maxScore,
      testResults,
      output: {
        resultType: primary.resultType,
        count: primary.count,
        documents: primary.documents ? primary.documents.slice(0, 20) : undefined,
        value: primary.value,
      },
    };
  }

  runTestCase(tc, question, actual, expected) {
    const result = (passed, message) => ({ id: tc.id, name: tc.name, passed, message: passed ? 'Passed' : message });
    const opts = { ordered: question.ordered, ignoreFields: question.ignoreFields || [] };
    switch (tc.type) {
      case 'target':
        return result(true);
      case 'count': {
        const a = resultRows(actual.primary);
        const e = resultRows(expected.primary);
        if (a === null) return result(false, 'Expected a list of documents but your query returned a single value.');
        if (a.length === 0 && e.length > 0) return result(false, 'Your query returned no documents, but matching documents exist.');
        if (a.length > 0 && e.length === 0) return result(false, 'No documents should match this question, but your query returned some.');
        return result(a.length === e.length, `Expected ${e.length} document(s) but your query returned ${a.length}.`);
      }
      case 'documents': {
        const a = resultRows(actual.primary);
        if (a === null) return result(false, 'Expected documents but your query returned a single value.');
        const cmp = compareResults(a, resultRows(expected.primary), { ...opts, ordered: false });
        return result(cmp.equal, cmp.reason);
      }
      case 'order': {
        const a = resultRows(actual.primary);
        if (a === null) return result(false, 'Expected documents in a specific order.');
        const cmp = compareResults(a, resultRows(expected.primary), { ...opts, ordered: true });
        return result(cmp.equal, cmp.equal ? '' : 'Documents are not in the required order (check your sort).');
      }
      case 'value': {
        const norm = (v) => (Array.isArray(v) ? [...v].map((x) => stableStringify(x)).sort() : stableStringify(v));
        const equal = JSON.stringify(norm(actual.primary.raw ?? actual.primary.value)) === JSON.stringify(norm(expected.primary.raw ?? expected.primary.value));
        return result(equal, 'The returned value is not correct.');
      }
      case 'state': {
        const pick = (o) => (o.verify.resultType === 'value' ? o.verify.raw ?? o.verify.value : o.verify.raw);
        const cmp = Array.isArray(pick(expected))
          ? compareResults(pick(actual), pick(expected), { ordered: false })
          : { equal: stableStringify(pick(actual)) === stableStringify(pick(expected)) };
        return result(cmp.equal, 'The target data does not match the expected result after your operation.');
      }
      case 'scope': {
        const cmp = compareResults(actual.scope.raw, expected.scope.raw, { ordered: true });
        return result(cmp.equal, 'Other documents in the collection were changed, added or removed.');
      }
      default:
        return result(false, `Unknown test case type '${tc.type}'.`);
    }
  }
}

module.exports = { EvaluationService, buildTestCases };
