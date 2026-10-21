'use strict';

const { QueryExecutor, translateDriverError } = require('../../src/query/executor');

/** Minimal mocked Db / Collection – no MongoDB needed. */
function mockDb(collectionImpl) {
  return { collection: jest.fn(() => collectionImpl) };
}

describe('query executor (mocked database)', () => {
  test('maps MongoDB MaxTimeMSExpired to QUERY_TIMEOUT', async () => {
    const executor = new QueryExecutor({ timeoutMs: 1000 });
    const err = Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired', name: 'MongoServerError' });
    const db = mockDb({ countDocuments: jest.fn().mockRejectedValue(err) });
    await expect(executor.run(db, executor.prepare('db.students.countDocuments({})'))).rejects.toMatchObject({ code: 'QUERY_TIMEOUT', status: 408 });
  });

  test('enforces a wall-clock timeout even if the driver hangs', async () => {
    const executor = new QueryExecutor({ timeoutMs: 50 });
    const db = mockDb({ countDocuments: jest.fn(() => new Promise(() => {})) });
    await expect(executor.run(db, executor.prepare('db.students.countDocuments({})'))).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
  });

  test('passes maxTimeMS and caps results', async () => {
    const executor = new QueryExecutor({ timeoutMs: 1234, maxResults: 3 });
    const cursor = { sort: jest.fn(), skip: jest.fn(), limit: jest.fn(), toArray: jest.fn().mockResolvedValue([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]) };
    const find = jest.fn(() => cursor);
    const res = await executor.run(mockDb({ find }), executor.prepare('db.products.find({})'));
    expect(find).toHaveBeenCalledWith({}, expect.objectContaining({ maxTimeMS: 1234 }));
    expect(cursor.limit).toHaveBeenCalledWith(4);
    expect(res.count).toBe(3);
    expect(res.truncated).toBe(true);
  });

  test('a student limit below the cap is not reported as truncated', async () => {
    const executor = new QueryExecutor({ maxResults: 100 });
    const cursor = { sort: jest.fn(), skip: jest.fn(), limit: jest.fn(), toArray: jest.fn().mockResolvedValue([{ a: 1 }, { a: 2 }]) };
    const res = await executor.run(mockDb({ find: () => cursor }), executor.prepare('db.products.find({}).limit(2)'));
    expect(cursor.limit).toHaveBeenCalledWith(2);
    expect(res).toMatchObject({ count: 2, truncated: false });
  });

  test('rejects oversized query text', () => {
    const executor = new QueryExecutor({ maxLength: 50 });
    expect(() => executor.prepare(`db.students.find({ name: "${'x'.repeat(100)}" })`)).toThrow(expect.objectContaining({ code: 'QUERY_TOO_LARGE', status: 413 }));
  });

  test('never leaks connection strings in translated errors', () => {
    const e = translateDriverError(Object.assign(new Error('failed for mongodb://admin:pw@internal:27017'), { name: 'MongoServerError' }));
    expect(e.message).not.toMatch(/admin:pw/);
  });

  test('translates duplicate keys and authorization errors', () => {
    expect(translateDriverError({ code: 11000, message: 'E11000' }).code).toBe('DUPLICATE_KEY');
    expect(translateDriverError({ code: 13, message: 'not authorized on admin' }).code).toBe('NOT_AUTHORIZED');
  });
});
