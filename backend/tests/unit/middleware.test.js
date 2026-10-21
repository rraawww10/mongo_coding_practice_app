'use strict';

const { requireRole, rateLimit, requirePracticeAccess } = require('../../src/middleware');

const run = (mw, req) =>
  new Promise((resolve) => {
    const res = { set: jest.fn() };
    mw(req, res, (err) => resolve(err));
  });

describe('role-based access control middleware', () => {
  test('allows permitted roles and rejects others', async () => {
    const mw = requireRole('instructor', 'admin');
    expect(await run(mw, { user: { role: 'instructor' } })).toBeUndefined();
    expect(await run(mw, { user: { role: 'admin' } })).toBeUndefined();
    expect(await run(mw, { user: { role: 'student' } })).toMatchObject({ status: 403, code: 'FORBIDDEN_ROLE' });
    expect(await run(mw, {})).toMatchObject({ status: 401 });
  });

  test('blocks students whose practice access is disabled', async () => {
    expect(await run(requirePracticeAccess, { user: { doc: { practiceDisabled: true } } })).toMatchObject({ status: 403, code: 'PRACTICE_DISABLED' });
    expect(await run(requirePracticeAccess, { user: { doc: {} } })).toBeUndefined();
  });
});

describe('per-user rate limiter', () => {
  test('limits each user independently', async () => {
    const mw = rateLimit({ max: 2, windowMs: 60000 });
    const a = { user: { id: 'a' } };
    const b = { user: { id: 'b' } };
    expect(await run(mw, a)).toBeUndefined();
    expect(await run(mw, a)).toBeUndefined();
    expect(await run(mw, a)).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(await run(mw, b)).toBeUndefined();
  });
});
