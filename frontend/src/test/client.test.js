import { describe, expect, test } from 'vitest';
import { api, ApiError, setToken } from '../api/client.js';
import { mockFetch } from './helpers.jsx';

describe('API client', () => {
  test('sends the bearer token and parses JSON', async () => {
    const { calls } = mockFetch({ 'GET /api/me': { user: { name: 'A' } } });
    setToken('abc');
    const r = await api('/api/me');
    expect(r.user.name).toBe('A');
    expect(calls[0].headers.Authorization).toBe('Bearer abc');
    setToken(null);
  });

  test('turns error responses into ApiError with code, message and location', async () => {
    mockFetch({ 'POST /api/query/execute': () => ({ status: 400, body: { error: { code: 'INVALID_SYNTAX', message: 'Expected }', line: 1, column: 9 } } }) });
    const err = await api('/api/query/execute', { method: 'POST', body: { query: 'x' } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'INVALID_SYNTAX', line: 1, column: 9 });
  });

  test('reports network failures clearly', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const err = await api('/api/health').catch((e) => e);
    expect(err.code).toBe('NETWORK_ERROR');
  });

  test('only the session token is stored in the browser', () => {
    setToken('tkn');
    expect(Object.keys(sessionStorage)).toEqual(['mp_session_token']);
    expect(Object.keys(localStorage)).toEqual([]);
    setToken(null);
    expect(sessionStorage.length).toBe(0);
  });
});
