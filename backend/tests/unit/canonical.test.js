'use strict';

const { ObjectId } = require('mongodb');
const { compareResults, normalize } = require('../../src/utils/canonical');

describe('result comparison', () => {
  const a = { _id: new ObjectId('65a100000000000000000001'), name: 'A', tags: ['x', 'y'], nested: { b: 2, a: 1 } };
  const b = { _id: new ObjectId('65a100000000000000000002'), name: 'B', tags: [], nested: { a: 1, b: 3 } };

  test('ignores document order unless ordered comparison is requested', () => {
    expect(compareResults([a, b], [b, a]).equal).toBe(true);
    expect(compareResults([a, b], [b, a], { ordered: true }).equal).toBe(false);
    expect(compareResults([a, b], [a, b], { ordered: true }).equal).toBe(true);
  });

  test('ignores field order within documents and nested documents', () => {
    expect(compareResults([{ x: 1, y: { p: 1, q: 2 } }], [{ y: { q: 2, p: 1 }, x: 1 }]).equal).toBe(true);
  });

  test('detects differences in nested documents', () => {
    const res = compareResults([{ ...a, nested: { a: 1, b: 99 } }], [a]);
    expect(res.equal).toBe(false);
  });

  test('array element order matters inside documents', () => {
    expect(compareResults([{ tags: ['y', 'x'] }], [{ tags: ['x', 'y'] }]).equal).toBe(false);
  });

  test('handles empty results and count mismatches with a clear reason', () => {
    expect(compareResults([], []).equal).toBe(true);
    const r = compareResults([], [a]);
    expect(r.equal).toBe(false);
    expect(r.reason).toMatch(/Expected 1 document\(s\) but your query returned 0/);
  });

  test('can ignore _id', () => {
    expect(compareResults([{ ...a, _id: new ObjectId() }], [a], { ignoreFields: ['_id'] }).equal).toBe(true);
  });

  test('normalizes BSON values', () => {
    expect(normalize(new Date('2024-01-01T00:00:00Z'))).toEqual({ $date: '2024-01-01T00:00:00.000Z' });
    expect(normalize(0.1 + 0.2)).toBe(0.3);
  });
});
