'use strict';

const { ObjectId } = require('mongodb');
const { AppError, unauthorized, forbidden, badRequest } = require('../utils/errors');
const logger = require('../utils/logger');

/** Verifies the Bearer token and loads the user from the database on every request. */
const authenticate = (auth) => async (req, _res, next) => {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    const user = await auth.verify(token);
    req.user = { id: user._id, email: user.email, role: user.role, name: user.name, doc: user };
    return next();
  } catch (err) {
    return next(err);
  }
};

/** Role-based access control, enforced on the server for every protected route. */
const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(forbidden('FORBIDDEN_ROLE', 'This action requires instructor or administrator access.'));
  }
  return next();
};

const requirePracticeAccess = (req, _res, next) => {
  if (req.user?.doc?.practiceDisabled) {
    return next(forbidden('PRACTICE_DISABLED', 'Your practice access has been disabled by an instructor.'));
  }
  return next();
};

/** Validates req.body / req.query / req.params with a zod schema. */
const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ field: i.path.join('.') || source, message: i.message }));
    return next(badRequest('VALIDATION_ERROR', issues[0]?.message || 'Invalid request.', issues));
  }
  if (source === 'body') req.body = result.data;
  else req.validated = { ...(req.validated || {}), [source]: result.data };
  return next();
};

const objectIdParam = (name) => (req, _res, next) => {
  if (!ObjectId.isValid(req.params[name]) || String(req.params[name]).length !== 24) {
    return next(badRequest('INVALID_ID', `Invalid ${name}.`));
  }
  req.params[`${name}Obj`] = new ObjectId(req.params[name]);
  return next();
};

/** Fixed-window, in-memory rate limiter keyed per authenticated user (or IP if anonymous). */
function rateLimit({ windowMs = 60000, max = 60, name = 'requests' } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref?.();
  const middleware = (req, res, next) => {
    const key = req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return next(new AppError(429, 'RATE_LIMITED', `Too many ${name}. Please wait a moment and try again.`));
    }
    return next();
  };
  middleware.reset = () => hits.clear();
  return middleware;
}

const SAFE_ERRORS = ['ConnectionError', 'QueryExecutionError', 'QueryValidationError', 'QuerySyntaxError'];

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request is too large.' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
  }
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) logger.error('Unhandled error', { path: req.path, err });
  const safe = err instanceof AppError || SAFE_ERRORS.includes(err?.name);
  const body = {
    error: {
      code: safe && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR',
      message: safe ? logger.redactString(err.message) : 'An unexpected error occurred.',
    },
  };
  if (err?.details) body.error.details = err.details;
  if (err?.line) Object.assign(body.error, { line: err.line, column: err.column });
  return res.status(status).json(body);
}

module.exports = { authenticate, requireRole, requirePracticeAccess, validate, objectIdParam, rateLimit, errorHandler };
