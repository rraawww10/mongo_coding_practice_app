'use strict';

const { ObjectId, Decimal128, Long, Int32, Double } = require('mongodb');

/**
 * Converts BSON values into plain, order-independent (for object keys) JSON
 * values so results can be compared deterministically.
 */
function normalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) return { $oid: value.toHexString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Decimal128) return Number(value.toString());
  if (value instanceof Long || value instanceof Int32 || value instanceof Double) return Number(value.valueOf());
  if (value instanceof RegExp) return { $regex: value.source, $options: value.flags };
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'number') return Number.isInteger(value) ? value : Math.round(value * 1e6) / 1e6;
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

const stableStringify = (value) => JSON.stringify(normalize(value));

function stripFields(doc, fields) {
  if (!fields?.length || doc === null || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const copy = { ...doc };
  for (const f of fields) delete copy[f];
  return copy;
}

/**
 * Compares two result sets.
 * @returns {{ equal: boolean, reason?: string }}
 */
function compareResults(actual, expected, { ordered = false, ignoreFields = [] } = {}) {
  const a = (actual || []).map((d) => stableStringify(stripFields(d, ignoreFields)));
  const e = (expected || []).map((d) => stableStringify(stripFields(d, ignoreFields)));
  if (a.length !== e.length) {
    return { equal: false, reason: `Expected ${e.length} document(s) but your query returned ${a.length}.` };
  }
  if (!ordered) {
    a.sort();
    e.sort();
  }
  for (let i = 0; i < e.length; i += 1) {
    if (a[i] !== e[i]) {
      return {
        equal: false,
        reason: ordered
          ? `Document at position ${i + 1} does not match the expected result (check filter, projection and sort order).`
          : 'The returned documents do not match the expected documents (check your filter, projection and field names).',
      };
    }
  }
  return { equal: true };
}

module.exports = { normalize, stableStringify, compareResults, stripFields };
