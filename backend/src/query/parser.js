'use strict';

/**
 * Safe parser for MongoDB shell-style queries such as
 *
 *   db.products.find({ price: { $gt: 1000 } }, { name: 1, _id: 0 }).sort({ price: -1 }).limit(5)
 *
 * It is a hand-written recursive-descent parser that understands *data literals only*
 * (objects, arrays, strings, numbers, booleans, null, regex literals and a handful of
 * BSON helpers such as ISODate()/ObjectId()). Nothing is ever evaluated as JavaScript:
 * there is no use of eval, Function, vm or similar. Any other identifier or expression is
 * rejected with a clear error.
 */
const { ObjectId } = require('mongodb');

class QuerySyntaxError extends Error {
  constructor(message, code = 'INVALID_SYNTAX', position) {
    super(message);
    this.name = 'QuerySyntaxError';
    this.code = code;
    this.status = 400;
    if (position) Object.assign(this, position);
  }
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const FORBIDDEN_KEYS = new Set(['__proto__']);
const JS_KEYWORDS = new Set([
  'function', 'return', 'var', 'let', 'const', 'this', 'while', 'for', 'if', 'else', 'eval', 'require',
  'process', 'global', 'globalThis', 'import', 'class', 'async', 'await', 'Function', 'constructor',
  'sleep', 'load', 'print', 'printjson', 'Mongo', 'connect', 'setTimeout', 'Math', 'JSON',
]);

class Parser {
  constructor(source, { maxDepth = 24 } = {}) {
    this.src = String(source);
    this.pos = 0;
    this.maxDepth = maxDepth;
  }

  // ---- low level helpers -------------------------------------------------------------------
  location(pos = this.pos) {
    const before = this.src.slice(0, pos).split('\n');
    return { position: pos, line: before.length, column: before[before.length - 1].length + 1 };
  }

  error(message, code = 'INVALID_SYNTAX', pos = this.pos) {
    const loc = this.location(pos);
    return new QuerySyntaxError(`${message} (line ${loc.line}, column ${loc.column})`, code, loc);
  }

  peek() {
    return this.src[this.pos];
  }

  skipWs() {
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos += 1;
      } else if (ch === '/' && this.src[this.pos + 1] === '/') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
      } else if (ch === '/' && this.src[this.pos + 1] === '*') {
        const end = this.src.indexOf('*/', this.pos + 2);
        if (end === -1) throw this.error('Unterminated comment');
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  expect(ch) {
    this.skipWs();
    if (this.src[this.pos] !== ch) {
      const found = this.pos >= this.src.length ? 'end of query' : `'${this.src[this.pos]}'`;
      throw this.error(`Expected '${ch}' but found ${found}`);
    }
    this.pos += 1;
  }

  tryConsume(ch) {
    this.skipWs();
    if (this.src[this.pos] === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  readIdentifier() {
    this.skipWs();
    const start = this.pos;
    if (!IDENT_START.test(this.src[this.pos] || '')) {
      const found = this.pos >= this.src.length ? 'end of query' : `'${this.src[this.pos]}'`;
      throw this.error(`Expected a name but found ${found}`);
    }
    while (this.pos < this.src.length && IDENT_PART.test(this.src[this.pos])) this.pos += 1;
    return this.src.slice(start, this.pos);
  }

  // ---- statement -----------------------------------------------------------------------------
  parseStatement() {
    this.skipWs();
    if (this.pos >= this.src.length) throw this.error('Query is empty. Example: db.students.find({})', 'EMPTY_QUERY');
    const start = this.pos;
    const head = this.readIdentifier();
    if (head !== 'db') {
      if (JS_KEYWORDS.has(head)) {
        throw this.error(`JavaScript ('${head}') is not allowed. Write a MongoDB query that starts with db.<collection>`, 'JS_NOT_ALLOWED', start);
      }
      throw this.error(`Queries must start with 'db.' (found '${head}')`, 'INVALID_SYNTAX', start);
    }

    let collection;
    const segments = [];
    let method;
    for (;;) {
      this.expect('.');
      const segStart = this.pos;
      const name = this.readIdentifier();
      this.skipWs();
      if (this.peek() === '(') {
        if (name === 'getCollection' && segments.length === 0 && collection === undefined) {
          this.expect('(');
          this.skipWs();
          const arg = this.parseValue(0);
          if (typeof arg !== 'string') throw this.error('getCollection() expects a collection name string', 'INVALID_SYNTAX', segStart);
          this.expect(')');
          collection = arg;
          continue;
        }
        if (collection === undefined && segments.length === 0) {
          throw this.error(`Database-level command '${name}()' is not allowed. Use db.<collection>.<operation>()`, 'UNSUPPORTED_OPERATION', segStart);
        }
        method = name;
        break;
      }
      if (collection !== undefined) throw this.error(`Expected an operation such as find() after the collection`, 'INVALID_SYNTAX', segStart);
      segments.push(name);
    }
    if (collection === undefined) collection = segments.join('.');

    const args = this.parseArguments();
    const chain = [];
    for (;;) {
      this.skipWs();
      if (this.peek() !== '.') break;
      this.pos += 1;
      const nameStart = this.pos;
      const name = this.readIdentifier();
      this.skipWs();
      if (this.peek() !== '(') throw this.error(`Expected '(' after '${name}'`, 'INVALID_SYNTAX', nameStart);
      chain.push({ method: name, args: this.parseArguments() });
    }
    this.tryConsume(';');
    this.skipWs();
    if (this.pos < this.src.length) {
      throw this.error('Unexpected input after the query. Only one query can be run at a time', 'INVALID_SYNTAX');
    }
    return { collection, method, args, chain, raw: this.src.slice(start).trim() };
  }

  parseArguments() {
    this.expect('(');
    const args = [];
    this.skipWs();
    if (this.tryConsume(')')) return args;
    for (;;) {
      args.push(this.parseValue(0));
      this.skipWs();
      if (this.tryConsume(',')) {
        this.skipWs();
        if (this.peek() === ')') {
          this.pos += 1;
          return args;
        }
        continue;
      }
      this.expect(')');
      return args;
    }
  }

  // ---- values --------------------------------------------------------------------------------
  parseValue(depth) {
    if (depth > this.maxDepth) throw this.error('Query is nested too deeply', 'QUERY_TOO_COMPLEX');
    this.skipWs();
    const ch = this.peek();
    if (ch === undefined) throw this.error('Unexpected end of query');
    if (ch === '{') return this.parseObject(depth);
    if (ch === '[') return this.parseArray(depth);
    if (ch === '"' || ch === "'") return this.parseString();
    if (ch === '`') throw this.error('Template literals are not supported', 'JS_NOT_ALLOWED');
    if (ch === '/') return this.parseRegex();
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) return this.parseNumber();
    if (IDENT_START.test(ch)) return this.parseIdentifierValue(depth);
    throw this.error(`Unexpected character '${ch}'`);
  }

  parseObject(depth) {
    this.expect('{');
    const obj = {};
    this.skipWs();
    if (this.tryConsume('}')) return obj;
    for (;;) {
      this.skipWs();
      const keyPos = this.pos;
      let key;
      const ch = this.peek();
      if (ch === '"' || ch === "'") key = this.parseString();
      else if (ch !== undefined && /[0-9]/.test(ch)) key = String(this.parseNumber());
      else if (ch !== undefined && IDENT_START.test(ch)) key = this.readIdentifier();
      else throw this.error(ch === undefined ? "Expected '}' to close the object" : `Unexpected '${ch}' where a field name was expected`);
      if (FORBIDDEN_KEYS.has(key)) throw this.error(`Field name '${key}' is not allowed`, 'FORBIDDEN_OPERATOR', keyPos);
      this.skipWs();
      if (this.peek() === '(') throw this.error(`Functions are not allowed ('${key}(...)')`, 'JS_NOT_ALLOWED', keyPos);
      this.expect(':');
      obj[key] = this.parseValue(depth + 1);
      this.skipWs();
      if (this.tryConsume(',')) {
        this.skipWs();
        if (this.tryConsume('}')) return obj;
        continue;
      }
      this.expect('}');
      return obj;
    }
  }

  parseArray(depth) {
    this.expect('[');
    const arr = [];
    this.skipWs();
    if (this.tryConsume(']')) return arr;
    for (;;) {
      arr.push(this.parseValue(depth + 1));
      this.skipWs();
      if (this.tryConsume(',')) {
        this.skipWs();
        if (this.tryConsume(']')) return arr;
        continue;
      }
      this.expect(']');
      return arr;
    }
  }

  parseString() {
    const quote = this.src[this.pos];
    const start = this.pos;
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === quote) {
        this.pos += 1;
        return out;
      }
      if (ch === '\n') break;
      if (ch === '\\') {
        const next = this.src[this.pos + 1];
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', '"': '"', "'": "'", '/': '/' };
        if (next === 'u') {
          const hex = this.src.slice(this.pos + 2, this.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error('Invalid unicode escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 6;
          continue;
        }
        if (next === undefined) break;
        out += map[next] ?? next;
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw this.error('Unterminated string', 'INVALID_SYNTAX', start);
  }

  parseNumber() {
    const m = NUMBER_RE.exec(this.src.slice(this.pos));
    if (!m) throw this.error('Invalid number');
    this.pos += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) throw this.error('Invalid number');
    return n;
  }

  parseRegex() {
    const start = this.pos;
    this.pos += 1;
    let pattern = '';
    let inClass = false;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\n') break;
      if (ch === '\\') {
        pattern += ch + (this.src[this.pos + 1] ?? '');
        this.pos += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        this.pos += 1;
        let flags = '';
        while (/[a-z]/i.test(this.src[this.pos] || '')) flags += this.src[this.pos++];
        if (!/^[imsx]*$/.test(flags)) throw this.error(`Unsupported regular expression flags '${flags}'`);
        if (pattern.length > 200) throw this.error('Regular expression is too long', 'QUERY_TOO_COMPLEX', start);
        try {
          // Validates syntax only; matching is performed by MongoDB, not by Node.js.
          return new RegExp(pattern, flags.replace('x', ''));
        } catch (e) {
          throw this.error(`Invalid regular expression: ${e.message}`, 'INVALID_SYNTAX', start);
        }
      }
      pattern += ch;
      this.pos += 1;
    }
    throw this.error('Unterminated regular expression', 'INVALID_SYNTAX', start);
  }

  parseIdentifierValue(depth) {
    const start = this.pos;
    let name = this.readIdentifier();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null' || name === 'undefined') return null;
    if (name === 'new') {
      name = this.readIdentifier();
      if (!['Date', 'ISODate', 'ObjectId'].includes(name)) {
        throw this.error(`'new ${name}' is not supported`, 'JS_NOT_ALLOWED', start);
      }
    }
    this.skipWs();
    if (this.peek() === '(') {
      const args = this.parseArguments();
      return this.buildHelper(name, args, start, depth);
    }
    if (JS_KEYWORDS.has(name)) {
      throw this.error(`JavaScript ('${name}') is not allowed in queries`, 'JS_NOT_ALLOWED', start);
    }
    throw this.error(`Unknown value '${name}'. Use quotes for strings, e.g. "${name}"`, 'INVALID_SYNTAX', start);
  }

  buildHelper(name, args, start) {
    switch (name) {
      case 'ISODate':
      case 'Date': {
        if (args.length === 0) return new Date();
        if (args.length !== 1 || !['string', 'number'].includes(typeof args[0])) {
          throw this.error(`${name}() expects one date string`, 'INVALID_SYNTAX', start);
        }
        const d = new Date(args[0]);
        if (Number.isNaN(d.getTime())) throw this.error(`Invalid date '${args[0]}'`, 'INVALID_SYNTAX', start);
        return d;
      }
      case 'ObjectId': {
        if (args.length === 0) return new ObjectId();
        if (typeof args[0] !== 'string' || !ObjectId.isValid(args[0]) || args[0].length !== 24) {
          throw this.error('ObjectId() expects a 24 character hex string', 'INVALID_SYNTAX', start);
        }
        return new ObjectId(args[0]);
      }
      case 'NumberInt':
      case 'NumberLong':
      case 'NumberDecimal': {
        const n = Number(args[0]);
        if (args.length !== 1 || !Number.isFinite(n)) throw this.error(`${name}() expects a number`, 'INVALID_SYNTAX', start);
        return n;
      }
      default:
        throw this.error(`Function calls are not allowed ('${name}(...)'). Only MongoDB query syntax is supported`, 'JS_NOT_ALLOWED', start);
    }
  }
}

function parseQuery(source, options) {
  return new Parser(source, options).parseStatement();
}

module.exports = { parseQuery, QuerySyntaxError };
