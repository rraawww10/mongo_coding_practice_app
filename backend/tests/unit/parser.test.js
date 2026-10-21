'use strict';

const { ObjectId } = require('mongodb');
const { parseQuery } = require('../../src/query/parser');

const expectError = (src, code) => {
  let err;
  try {
    parseQuery(src);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.name).toBe('QuerySyntaxError');
  if (code) expect(err.code).toBe(code);
  return err;
};

describe('query parser (no eval)', () => {
  test('parses find with filter, projection and chained modifiers', () => {
    const p = parseQuery('db.products.find({ price: { $gt: 1000 } }, { name: 1, _id: 0 }).sort({ price: -1 }).limit(5);');
    expect(p.collection).toBe('products');
    expect(p.method).toBe('find');
    expect(p.args).toEqual([{ price: { $gt: 1000 } }, { name: 1, _id: 0 }]);
    expect(p.chain).toEqual([
      { method: 'sort', args: [{ price: -1 }] },
      { method: 'limit', args: [5] },
    ]);
  });

  test('supports quoted keys, single quotes, trailing commas, comments and nested arrays', () => {
    const p = parseQuery(`// find orders
      db.orders.find({ 'products.name': "USB-C Cable", status: { $in: ['shipped', "pending",], }, })`);
    expect(p.args[0]).toEqual({ 'products.name': 'USB-C Cable', status: { $in: ['shipped', 'pending'] } });
  });

  test('supports BSON helpers and regex literals', () => {
    const p = parseQuery('db.orders.find({ createdAt: { $gte: ISODate("2024-03-01T00:00:00Z") }, _id: ObjectId("65a300000000000000000001"), name: /^lap/i, d: new Date("2024-01-01") })');
    const f = p.args[0];
    expect(f.createdAt.$gte).toBeInstanceOf(Date);
    expect(f._id).toBeInstanceOf(ObjectId);
    expect(f.name).toBeInstanceOf(RegExp);
    expect(f.name.flags).toBe('i');
    expect(f.d.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  test('supports db.getCollection("name") and system collection names via dots', () => {
    expect(parseQuery('db.getCollection("students").findOne()').collection).toBe('students');
    expect(parseQuery('db.system.users.find()').collection).toBe('system.users');
  });

  test('parses aggregation pipelines', () => {
    const p = parseQuery('db.orders.aggregate([{ $match: { status: "delivered" } }, { $group: { _id: "$status", n: { $sum: 1 } } }])');
    expect(p.args[0]).toHaveLength(2);
  });

  test('parses negative, decimal and exponent numbers', () => {
    expect(parseQuery('db.p.find({ a: -1.5, b: 2e3, c: .5 })').args[0]).toEqual({ a: -1.5, b: 2000, c: 0.5 });
  });

  test.each([
    ['db.students.find({ $where: function() { return true } })', 'JS_NOT_ALLOWED'],
    ['db.students.find({ name: this.name })', 'JS_NOT_ALLOWED'],
    ['function x() { return db }', 'JS_NOT_ALLOWED'],
    ['db.students.find({ a: eval("1") })', 'JS_NOT_ALLOWED'],
    ['db.students.find({ a: require("fs") })', 'JS_NOT_ALLOWED'],
    ['db.students.find({ a: `x` })', 'JS_NOT_ALLOWED'],
    ['db.students.find({ a: process.env })', 'JS_NOT_ALLOWED'],
    ['db.students.find({ a: new Function("return 1") })', 'JS_NOT_ALLOWED'],
  ])('rejects JavaScript: %s', (src, code) => {
    expectError(src, code);
  });

  test('rejects a second statement (no query chaining/injection)', () => {
    expectError('db.students.find({}); db.students.drop()', 'INVALID_SYNTAX');
  });

  test('rejects database-level commands', () => {
    expectError('db.dropDatabase()', 'UNSUPPORTED_OPERATION');
    expectError('db.runCommand({ shutdown: 1 })', 'UNSUPPORTED_OPERATION');
  });

  test('rejects __proto__ keys (prototype pollution)', () => {
    expectError('db.students.find({ __proto__: { admin: true } })', 'FORBIDDEN_OPERATOR');
  });

  test.each([
    ['', 'EMPTY_QUERY'],
    ['db.students.find({ age: { $gt: 21 }', 'INVALID_SYNTAX'],
    ['db.students.find({ name: "unterminated })', 'INVALID_SYNTAX'],
    ['students.find({})', 'INVALID_SYNTAX'],
    ['db.students.find({ age 21 })', 'INVALID_SYNTAX'],
    ['db.students.find({ name: Alice })', 'INVALID_SYNTAX'],
  ])('reports syntax errors with location: %p', (src, code) => {
    const err = expectError(src, code);
    if (src) expect(err.message).toMatch(/line \d+, column \d+/);
  });

  test('rejects excessively deep nesting', () => {
    const deep = `${'{ a: '.repeat(40)}1${' }'.repeat(40)}`;
    expectError(`db.students.find(${deep})`, 'QUERY_TOO_COMPLEX');
  });
});
