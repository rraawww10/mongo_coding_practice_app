'use strict';

/**
 * Minimal structured logger that redacts connection strings and secrets
 * before anything is written. Tests attach a sink to assert on log output.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const URI_PATTERN = /mongodb(?:\+srv)?:\/\/[^\s"'`<>]+/gi;
const SECRET_KEYS = /^(password|pass|pwd|secret|token|authorization|connectionurl|connectionstring|uri|url|encrypteduri)$/i;

function redactString(str) {
  return String(str).replace(URI_PATTERN, 'mongodb://[REDACTED]');
}

function redact(value, depth = 0) {
  if (depth > 8) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: value.code };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const sinks = new Set();
let level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info');

function write(lvl, message, meta) {
  const entry = { time: new Date().toISOString(), level: lvl, message: redactString(message) };
  if (meta !== undefined) entry.meta = redact(meta);
  const line = JSON.stringify(entry);
  for (const sink of sinks) sink(line, entry);
  if (LEVELS[lvl] >= (LEVELS[level] ?? 20)) {
    (lvl === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  }
}

module.exports = {
  debug: (m, meta) => write('debug', m, meta),
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
  setLevel: (l) => {
    level = l;
  },
  addSink: (fn) => {
    sinks.add(fn);
    return () => sinks.delete(fn);
  },
  redact,
  redactString,
};
