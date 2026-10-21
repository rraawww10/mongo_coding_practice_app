'use strict';

const { parseQuery } = require('../../src/query/parser');
const { QueryValidator } = require('../../src/query/validator');

const validator = new QueryValidator({ maxResults: 100 });
const plan = (src) => validator.validate(parseQuery(src));
const rejects = (src, code) => {
  let err;
  try {
    plan(src);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.code).toBe(code);
  return err;
};

describe('query validator', () => {
  test('builds plans for supported read operations', () => {
    expect(plan('db.students.find({ age: { $gt: 21 } }).sort({ age: 1 }).limit(3).skip(1)')).toMatchObject({
      operation: 'find', filter: { age: { $gt: 21 } }, sort: { age: 1 }, limit: 3, skip: 1, isWrite: false,
    });
    expect(plan('db.students.findOne({ email: "x" }, { name: 1 })')).toMatchObject({ operation: 'findOne', projection: { name: 1 } });
    expect(plan('db.products.countDocuments({ isActive: false })').operation).toBe('countDocuments');
    expect(plan('db.employees.distinct("department")')).toMatchObject({ operation: 'distinct', field: 'department' });
    expect(plan('db.orders.aggregate([{ $unwind: "$products" }, { $lookup: { from: "students", localField: "studentId", foreignField: "_id", as: "s" } }])').operation).toBe('aggregate');
  });

  test('builds plans for write operations', () => {
    expect(plan('db.products.insertOne({ name: "X", price: 1 })')).toMatchObject({ operation: 'insertOne', isWrite: true });
    expect(plan('db.products.updateMany({ category: "Books" }, { $inc: { stock: 1 } })').update).toEqual({ $inc: { stock: 1 } });
    expect(plan('db.orders.deleteMany({ status: "cancelled" })').operation).toBe('deleteMany');
  });

  test.each([
    ['db.users.find({})', 'INVALID_COLLECTION'],
    ['db.system.users.find({})', 'FORBIDDEN_COLLECTION'],
    ['db.getCollection("system.profile").find({})', 'FORBIDDEN_COLLECTION'],
    ['db.audit_logs.find({})', 'INVALID_COLLECTION'],
  ])('enforces the collection allowlist: %s', (src, code) => {
    rejects(src, code);
  });

  test.each([
    ['db.students.drop()', 'UNSUPPORTED_OPERATION'],
    ['db.students.createIndex({ a: 1 })', 'UNSUPPORTED_OPERATION'],
    ['db.students.mapReduce({}, {})', 'UNSUPPORTED_OPERATION'],
    ['db.students.bulkWrite([])', 'UNSUPPORTED_OPERATION'],
    ['db.students.renameCollection("x")', 'UNSUPPORTED_OPERATION'],
    ['db.students.findOne({}).sort({ a: 1 })', 'UNSUPPORTED_OPERATION'],
    ['db.students.find({}).forEach({})', 'UNSUPPORTED_OPERATION'],
  ])('enforces the operation allowlist: %s', (src, code) => {
    rejects(src, code);
  });

  test.each([
    ['db.students.find({ $where: "sleep(1000)" })'],
    ['db.students.find({ $expr: { $function: { body: "x", args: [], lang: "js" } } })'],
    ['db.orders.aggregate([{ $group: { _id: null, x: { $accumulator: {} } } }])'],
    ['db.orders.aggregate([{ $out: "hacked" }])'],
    ['db.orders.aggregate([{ $merge: { into: "x" } }])'],
    ['db.orders.aggregate([{ $currentOp: {} }])'],
    ['db.orders.aggregate([{ $facet: { a: [{ $out: "x" }] } }])'],
  ])('blocks forbidden operators: %s', (src) => {
    rejects(src, 'FORBIDDEN_OPERATOR');
  });

  test('restricts $lookup / $unionWith targets to allowlisted collections in the same database', () => {
    rejects('db.orders.aggregate([{ $lookup: { from: "users", localField: "a", foreignField: "b", as: "c" } }])', 'INVALID_COLLECTION');
    rejects('db.orders.aggregate([{ $lookup: { from: "system.users", localField: "a", foreignField: "b", as: "c" } }])', 'FORBIDDEN_COLLECTION');
    rejects('db.orders.aggregate([{ $lookup: { from: { db: "admin", coll: "system.users" }, as: "c", pipeline: [] } }])', 'FORBIDDEN_DATABASE');
    rejects('db.orders.aggregate([{ $unionWith: "attempts" }])', 'INVALID_COLLECTION');
  });

  test.each([
    ['db.orders.aggregate({ $match: {} })', 'INVALID_PIPELINE'],
    ['db.orders.aggregate([{ $match: {}, $sort: { a: 1 } }])', 'INVALID_PIPELINE'],
    ['db.orders.aggregate([{ match: {} }])', 'INVALID_PIPELINE'],
    ['db.orders.aggregate(["$match"])', 'INVALID_PIPELINE'],
    ['db.orders.aggregate([{ $search: {} }])', 'UNSUPPORTED_STAGE'],
  ])('rejects malformed pipelines: %s', (src, code) => {
    rejects(src, code);
  });

  test('rejects excessive result requests', () => {
    rejects('db.products.find().limit(5000)', 'EXCESSIVE_RESULTS');
    rejects('db.products.aggregate([{ $limit: 1000 }])', 'EXCESSIVE_RESULTS');
    rejects(`db.products.insertMany([${Array(60).fill('{ a: 1 }').join(',')}])`, 'EXCESSIVE_RESULTS');
  });

  test('requires operator-based updates and filters for deletes', () => {
    rejects('db.products.updateOne({ name: "x" }, { stock: 5 })', 'INVALID_ARGUMENT');
    rejects('db.products.updateOne({ name: "x" })', 'INVALID_ARGUMENT');
    rejects('db.products.updateOne({}, { $set: { a: 1 } }, { writeConcern: { w: 0 } })', 'INVALID_ARGUMENT');
    rejects('db.products.deleteMany()', 'INVALID_ARGUMENT');
    rejects('db.products.insertOne({ $set: 1 })', 'INVALID_ARGUMENT');
    rejects('db.products.find("name")', 'INVALID_ARGUMENT');
  });

  test('rejects queries that are too complex', () => {
    const big = `db.products.find({ $or: [${Array(2100).fill('{ a: 1 }').join(',')}] })`;
    rejects(big, 'QUERY_TOO_COMPLEX');
  });
});
