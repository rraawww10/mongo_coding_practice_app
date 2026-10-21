'use strict';

const { EJSON } = require('mongodb').BSON;
const { parseQuery, QuerySyntaxError } = require('./parser');
const { QueryValidator, QueryValidationError } = require('./validator');

class QueryExecutionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'QueryExecutionError';
    this.code = code;
    this.status = status;
  }
}

/** Converts MongoDB driver errors into safe, student-friendly messages (never leaks hosts/URIs). */
function translateDriverError(err) {
  if (err instanceof QueryExecutionError) return err;
  const code = err?.code;
  const msg = String(err?.message || '');
  if (code === 50 || err?.codeName === 'MaxTimeMSExpired' || /operation exceeded time limit/i.test(msg)) {
    return new QueryExecutionError('QUERY_TIMEOUT', 'The query took too long and was stopped. Add a more selective filter or simplify the pipeline.', 408);
  }
  if (code === 11000) return new QueryExecutionError('DUPLICATE_KEY', 'Duplicate key: a document with the same unique value already exists.', 400);
  if (code === 13 || code === 8000 || /not authorized/i.test(msg)) {
    return new QueryExecutionError('NOT_AUTHORIZED', 'The database user is not allowed to perform this operation.', 403);
  }
  if (err?.name === 'MongoServerError' || err?.name === 'MongoInvalidArgumentError' || err?.name === 'BSONError') {
    // Server-side validation errors (bad operator, wrong argument types) are safe to show, minus any URI.
    const clean = msg.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[connection]').slice(0, 300);
    return new QueryExecutionError('QUERY_FAILED', `MongoDB rejected the query: ${clean}`, 400);
  }
  if (/server selection|ECONNREFUSED|topology|connection/i.test(msg)) {
    return new QueryExecutionError('DATABASE_UNAVAILABLE', 'The practice database is currently unavailable. Try again shortly.', 503);
  }
  const fallback = new QueryExecutionError('QUERY_FAILED', 'The query could not be executed.', 500);
  fallback.cause = err; // kept for server-side logging only
  return fallback;
}

const toOutput = (value) => EJSON.serialize(value, { relaxed: true });

class QueryExecutor {
  constructor({ maxResults = 100, timeoutMs = 3000, maxLength = 4000, allowedCollections } = {}) {
    this.maxResults = maxResults;
    this.timeoutMs = timeoutMs;
    this.maxLength = maxLength;
    this.validator = new QueryValidator({ maxResults, allowedCollections });
  }

  /** Parse + validate. Throws QuerySyntaxError / QueryValidationError. */
  prepare(queryText) {
    if (typeof queryText !== 'string' || !queryText.trim()) {
      throw new QueryValidationError('EMPTY_QUERY', 'Query is empty. Example: db.students.find({})');
    }
    if (queryText.length > this.maxLength) {
      throw new QueryValidationError('QUERY_TOO_LARGE', `Query exceeds the maximum length of ${this.maxLength} characters.`, 413);
    }
    const parsed = parseQuery(queryText);
    return this.validator.validate(parsed);
  }

  async withTimeout(promise) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new QueryExecutionError('QUERY_TIMEOUT', 'The query took too long and was stopped. Add a more selective filter or simplify the pipeline.', 408)),
        this.timeoutMs + 500,
      );
    });
    try {
      return await Promise.race([promise, guard]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Executes a validated plan against a Db handle (always the caller's own workspace).
   * @returns {Promise<{operation, collection, resultType, documents?, value?, count, truncated, durationMs}>}
   */
  async run(db, plan) {
    const started = Date.now();
    const coll = db.collection(plan.collection);
    const maxTimeMS = this.timeoutMs;
    const cap = this.maxResults;
    let result;
    try {
      result = await this.withTimeout(this.dispatch(coll, plan, { maxTimeMS, cap }));
    } catch (err) {
      throw translateDriverError(err);
    }
    return { operation: plan.operation, collection: plan.collection, ...result, durationMs: Date.now() - started };
  }

  async dispatch(coll, plan, { maxTimeMS, cap }) {
    switch (plan.operation) {
      case 'find': {
        if (plan.countOnly) {
          const value = await coll.countDocuments(plan.filter, { maxTimeMS, skip: plan.skip, limit: plan.limit });
          return { resultType: 'value', value, count: 1, truncated: false };
        }
        // A student-supplied limit (validated to be <= cap) is honoured exactly. Without one we
        // fetch cap + 1 documents so we can tell the student the output was cut off by the platform.
        const userLimit = plan.limit && plan.limit > 0 ? plan.limit : null;
        const cursor = coll.find(plan.filter, { projection: plan.projection, maxTimeMS });
        if (plan.sort) cursor.sort(plan.sort);
        if (plan.skip) cursor.skip(plan.skip);
        cursor.limit(userLimit ?? cap + 1);
        const docs = await cursor.toArray();
        const truncated = userLimit === null && docs.length > cap;
        const documents = docs.slice(0, cap);
        return { resultType: 'documents', documents: toOutput(documents), raw: documents, count: documents.length, truncated };
      }
      case 'findOne': {
        const doc = await coll.findOne(plan.filter, { projection: plan.projection, maxTimeMS });
        const documents = doc ? [doc] : [];
        return { resultType: 'document', documents: toOutput(documents), raw: documents, count: documents.length, truncated: false };
      }
      case 'countDocuments': {
        const value = await coll.countDocuments(plan.filter, { maxTimeMS });
        return { resultType: 'value', value, raw: value, count: 1, truncated: false };
      }
      case 'distinct': {
        const values = await coll.distinct(plan.field, plan.filter, { maxTimeMS });
        const truncated = values.length > cap;
        const value = values.slice(0, cap);
        return { resultType: 'value', value: toOutput(value), raw: value, count: value.length, truncated };
      }
      case 'aggregate': {
        const pipeline = [...plan.pipeline, { $limit: cap + 1 }];
        const docs = await coll.aggregate(pipeline, { maxTimeMS, allowDiskUse: false }).toArray();
        const truncated = docs.length > cap;
        const documents = docs.slice(0, cap);
        return { resultType: 'documents', documents: toOutput(documents), raw: documents, count: documents.length, truncated };
      }
      case 'insertOne':
      case 'insertMany': {
        const res = await coll.insertMany(plan.documents, { ordered: true });
        const value = { acknowledged: res.acknowledged, insertedCount: res.insertedCount, insertedIds: Object.values(res.insertedIds) };
        return { resultType: 'write', value: toOutput(value), raw: value, count: res.insertedCount, truncated: false };
      }
      case 'updateOne':
      case 'updateMany': {
        const fn = plan.operation === 'updateOne' ? 'updateOne' : 'updateMany';
        const res = await coll[fn](plan.filter, plan.update, { ...(plan.options || {}), maxTimeMS });
        const value = {
          acknowledged: res.acknowledged,
          matchedCount: res.matchedCount,
          modifiedCount: res.modifiedCount,
          upsertedCount: res.upsertedCount,
          upsertedId: res.upsertedId ?? null,
        };
        return { resultType: 'write', value: toOutput(value), raw: value, count: res.modifiedCount, truncated: false };
      }
      case 'deleteOne':
      case 'deleteMany': {
        const fn = plan.operation === 'deleteOne' ? 'deleteOne' : 'deleteMany';
        const res = await coll[fn](plan.filter, { maxTimeMS });
        const value = { acknowledged: res.acknowledged, deletedCount: res.deletedCount };
        return { resultType: 'write', value, raw: value, count: res.deletedCount, truncated: false };
      }
      default:
        throw new QueryExecutionError('UNSUPPORTED_OPERATION', `'${plan.operation}()' is not supported.`);
    }
  }
}

const isQueryError = (err) =>
  err instanceof QuerySyntaxError || err instanceof QueryValidationError || err instanceof QueryExecutionError;

module.exports = { QueryExecutor, QueryExecutionError, translateDriverError, isQueryError };
