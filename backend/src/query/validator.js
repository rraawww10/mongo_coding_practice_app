'use strict';

/**
 * Turns a parsed query into a validated execution plan, enforcing:
 *  - collection allowlist (never system.* or application collections)
 *  - operation allowlist
 *  - forbidden operators ($where, $function, $accumulator, $out, $merge, ...)
 *  - aggregation stage allowlist (+ allowlisted `from` targets for $lookup/$graphLookup/$unionWith)
 *  - result limits and structural complexity limits
 */
const { PRACTICE_COLLECTIONS } = require('../provisioning/sampleData');

class QueryValidationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'QueryValidationError';
    this.code = code;
    this.status = status;
  }
}

const READ_OPERATIONS = ['find', 'findOne', 'countDocuments', 'distinct', 'aggregate'];
const WRITE_OPERATIONS = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'];
const SUPPORTED_OPERATIONS = [...READ_OPERATIONS, ...WRITE_OPERATIONS];

const FIND_MODIFIERS = ['sort', 'limit', 'skip', 'projection', 'project', 'pretty', 'toArray', 'count'];

const FORBIDDEN_OPERATORS = new Set([
  '$where', '$function', '$accumulator', '$out', '$merge', '$currentOp', '$listSessions',
  '$listLocalSessions', '$planCacheStats', '$collStats', '$indexStats', '$changeStream',
  '$changeStreamSplitLargeEvent', '$listSearchIndexes', '$documents', '$querySettings',
  '$shardedDataDistribution', '$listSampledQueries', '$listClusterCatalog', '$queryStats',
]);

const ALLOWED_STAGES = new Set([
  '$match', '$group', '$sort', '$project', '$unwind', '$lookup', '$limit', '$skip', '$count',
  '$addFields', '$set', '$unset', '$facet', '$bucket', '$bucketAuto', '$sortByCount', '$replaceRoot',
  '$replaceWith', '$sample', '$unionWith', '$graphLookup',
]);

const UPDATE_OPERATORS = new Set([
  '$set', '$unset', '$inc', '$mul', '$min', '$max', '$rename', '$push', '$pull', '$pullAll',
  '$addToSet', '$pop', '$currentDate', '$setOnInsert',
]);

const MAX_NODES = 2000;
const MAX_INSERT_DOCS = 50;

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp) && v.constructor === Object;

function fail(code, message, status) {
  throw new QueryValidationError(code, message, status);
}

class QueryValidator {
  constructor({ allowedCollections = PRACTICE_COLLECTIONS, maxResults = 100 } = {}) {
    this.allowedCollections = new Set(allowedCollections);
    this.maxResults = maxResults;
  }

  checkCollection(name, context = 'collection') {
    if (typeof name !== 'string' || !name) fail('INVALID_COLLECTION', `A ${context} name is required.`);
    if (name.startsWith('system.') || name.includes('$') || name.includes('\0')) {
      fail('FORBIDDEN_COLLECTION', `Access to '${name}' is not allowed. System collections cannot be queried.`, 403);
    }
    if (!this.allowedCollections.has(name)) {
      fail(
        'INVALID_COLLECTION',
        `Unknown or unavailable collection '${name}'. Available collections: ${[...this.allowedCollections].join(', ')}.`,
      );
    }
  }

  /** Walks every value, rejecting forbidden operators and bounding size/complexity. */
  scan(value, counter = { n: 0 }) {
    counter.n += 1;
    if (counter.n > MAX_NODES) fail('QUERY_TOO_COMPLEX', 'Query is too large or complex.');
    if (Array.isArray(value)) {
      for (const v of value) this.scan(v, counter);
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, v] of Object.entries(value)) {
        if (FORBIDDEN_OPERATORS.has(key)) {
          fail('FORBIDDEN_OPERATOR', `The operator '${key}' is not allowed on this platform.`, 403);
        }
        if (key === '$lookup' || key === '$graphLookup' || key === '$unionWith') this.checkJoinTarget(key, v);
        this.scan(v, counter);
      }
    }
  }

  checkJoinTarget(stage, spec) {
    const target = stage === '$unionWith' && typeof spec === 'string' ? spec : spec?.from ?? spec?.coll;
    if (spec && typeof spec === 'object' && ('db' in spec || (spec.from && typeof spec.from === 'object'))) {
      fail('FORBIDDEN_DATABASE', `${stage} cannot reference another database.`, 403);
    }
    if (typeof target !== 'string') fail('INVALID_PIPELINE', `${stage} requires a 'from' collection name.`);
    this.checkCollection(target, `${stage} target collection`);
  }

  validatePipeline(pipeline, { nested = false } = {}) {
    if (!Array.isArray(pipeline)) fail('INVALID_PIPELINE', 'aggregate() expects an array of stages, e.g. db.orders.aggregate([{ $match: {...} }]).');
    if (pipeline.length > 30) fail('QUERY_TOO_COMPLEX', 'Aggregation pipelines are limited to 30 stages.');
    pipeline.forEach((stage, i) => {
      if (!isPlainObject(stage)) fail('INVALID_PIPELINE', `Pipeline stage ${i + 1} must be an object such as { $match: {...} }.`);
      const keys = Object.keys(stage);
      if (keys.length !== 1) fail('INVALID_PIPELINE', `Pipeline stage ${i + 1} must contain exactly one stage operator (found ${keys.length}).`);
      const [name] = keys;
      if (FORBIDDEN_OPERATORS.has(name)) fail('FORBIDDEN_OPERATOR', `The stage '${name}' is not allowed on this platform.`, 403);
      if (!name.startsWith('$')) fail('INVALID_PIPELINE', `Pipeline stage ${i + 1}: '${name}' is not a stage operator. Did you mean '$${name}'?`);
      if (!ALLOWED_STAGES.has(name)) fail('UNSUPPORTED_STAGE', `The aggregation stage '${name}' is not supported here.`);
      const body = stage[name];
      if (name === '$limit') {
        if (!Number.isInteger(body) || body < 1) fail('INVALID_PIPELINE', '$limit expects a positive integer.');
        if (!nested && body > this.maxResults) fail('EXCESSIVE_RESULTS', `$limit cannot exceed ${this.maxResults}.`);
      }
      if (name === '$facet') {
        if (!isPlainObject(body)) fail('INVALID_PIPELINE', '$facet expects an object of sub-pipelines.');
        Object.values(body).forEach((p) => this.validatePipeline(p, { nested: true }));
      }
      if (name === '$lookup' && body?.pipeline) this.validatePipeline(body.pipeline, { nested: true });
      if (name === '$unionWith' && body?.pipeline) this.validatePipeline(body.pipeline, { nested: true });
    });
  }

  validateFilter(filter, label = 'filter') {
    if (filter === undefined) return {};
    if (!isPlainObject(filter)) fail('INVALID_ARGUMENT', `The ${label} must be an object, e.g. { status: "delivered" }.`);
    return filter;
  }

  validateLimit(n, name = 'limit') {
    if (!Number.isInteger(n) || n < 0) fail('INVALID_ARGUMENT', `${name}() expects a non-negative integer.`);
    if (name === 'limit' && n > this.maxResults) {
      fail('EXCESSIVE_RESULTS', `limit(${n}) exceeds the maximum of ${this.maxResults} documents per query.`);
    }
    return n;
  }

  /** @returns {object} plan */
  validate(parsed) {
    const { collection, method, args, chain } = parsed;
    if (!SUPPORTED_OPERATIONS.includes(method)) {
      fail(
        'UNSUPPORTED_OPERATION',
        `'${method}()' is not supported. Supported operations: ${SUPPORTED_OPERATIONS.join(', ')}.`,
      );
    }
    this.checkCollection(collection);
    this.scan(args);
    chain.forEach((c) => this.scan(c.args));

    const plan = { collection, operation: method, isWrite: WRITE_OPERATIONS.includes(method) };
    const argCount = (max) => {
      if (args.length > max) fail('INVALID_ARGUMENT', `${method}() accepts at most ${max} argument(s).`);
    };

    if (chain.length && method !== 'find') {
      fail('UNSUPPORTED_OPERATION', `Chained methods like .${chain[0].method}() are only supported after find().`);
    }

    switch (method) {
      case 'find':
      case 'findOne': {
        argCount(2);
        plan.filter = this.validateFilter(args[0]);
        if (args[1] !== undefined) plan.projection = this.validateFilter(args[1], 'projection');
        if (method === 'find') {
          for (const { method: m, args: a } of chain) {
            if (!FIND_MODIFIERS.includes(m)) fail('UNSUPPORTED_OPERATION', `.${m}() is not supported. Use sort(), limit(), skip() or count().`);
            if (m === 'sort') plan.sort = this.validateFilter(a[0], 'sort specification');
            if (m === 'limit') plan.limit = this.validateLimit(a[0], 'limit');
            if (m === 'skip') plan.skip = this.validateLimit(a[0], 'skip');
            if (m === 'projection' || m === 'project') plan.projection = this.validateFilter(a[0], 'projection');
            if (m === 'count') plan.countOnly = true;
          }
        }
        break;
      }
      case 'countDocuments':
        argCount(1);
        plan.filter = this.validateFilter(args[0]);
        break;
      case 'distinct':
        argCount(2);
        if (typeof args[0] !== 'string' || !args[0]) fail('INVALID_ARGUMENT', 'distinct() expects a field name string, e.g. db.products.distinct("category").');
        plan.field = args[0];
        plan.filter = this.validateFilter(args[1]);
        break;
      case 'aggregate':
        argCount(1);
        this.validatePipeline(args[0]);
        plan.pipeline = args[0];
        break;
      case 'insertOne':
        argCount(1);
        if (!isPlainObject(args[0])) fail('INVALID_ARGUMENT', 'insertOne() expects a document object.');
        this.checkDocument(args[0]);
        plan.documents = [args[0]];
        break;
      case 'insertMany':
        argCount(1);
        if (!Array.isArray(args[0]) || args[0].length === 0) fail('INVALID_ARGUMENT', 'insertMany() expects a non-empty array of documents.');
        if (args[0].length > MAX_INSERT_DOCS) fail('EXCESSIVE_RESULTS', `insertMany() is limited to ${MAX_INSERT_DOCS} documents.`);
        args[0].forEach((d) => {
          if (!isPlainObject(d)) fail('INVALID_ARGUMENT', 'insertMany() expects an array of document objects.');
          this.checkDocument(d);
        });
        plan.documents = args[0];
        break;
      case 'updateOne':
      case 'updateMany': {
        argCount(3);
        if (args.length < 2) fail('INVALID_ARGUMENT', `${method}() expects a filter and an update, e.g. ${method}({ name: "x" }, { $set: { stock: 5 } }).`);
        plan.filter = this.validateFilter(args[0]);
        const update = args[1];
        if (!isPlainObject(update) || Object.keys(update).length === 0) fail('INVALID_ARGUMENT', 'The update must be an object with update operators such as $set.');
        for (const key of Object.keys(update)) {
          if (!UPDATE_OPERATORS.has(key)) {
            fail('INVALID_ARGUMENT', key.startsWith('$') ? `Update operator '${key}' is not supported.` : `Updates must use operators such as $set (found field '${key}').`);
          }
        }
        plan.update = update;
        if (args[2] !== undefined) {
          if (!isPlainObject(args[2])) fail('INVALID_ARGUMENT', 'Update options must be an object.');
          const allowed = ['upsert', 'arrayFilters'];
          for (const k of Object.keys(args[2])) if (!allowed.includes(k)) fail('INVALID_ARGUMENT', `Update option '${k}' is not supported.`);
          plan.options = args[2];
        }
        break;
      }
      case 'deleteOne':
      case 'deleteMany':
        argCount(1);
        if (args[0] === undefined) fail('INVALID_ARGUMENT', `${method}() requires a filter. Use {} to match every document.`);
        plan.filter = this.validateFilter(args[0]);
        break;
      default:
        fail('UNSUPPORTED_OPERATION', `'${method}()' is not supported.`);
    }
    return plan;
  }

  checkDocument(doc) {
    for (const key of Object.keys(doc)) {
      if (key.startsWith('$')) fail('INVALID_ARGUMENT', `Field names cannot start with '$' ('${key}').`);
    }
  }
}

module.exports = {
  QueryValidator,
  QueryValidationError,
  SUPPORTED_OPERATIONS,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  FORBIDDEN_OPERATORS,
  ALLOWED_STAGES,
};
