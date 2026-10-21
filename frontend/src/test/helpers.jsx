import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthContext.jsx';

/** Mocks fetch with a route table: { 'GET /api/x': body | (req) => ({ status, body }) }. */
export function mockFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && (p === path || (p.endsWith('*') && path.startsWith(p.slice(0, -1))));
    });
    if (!key) return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_MOCKED', message: `${method} ${path}` } }) };
    const handler = routes[key];
    const out = typeof handler === 'function' ? handler({ method, path, body }) : { status: 200, body: handler };
    return { ok: out.status < 400, status: out.status, json: async () => out.body };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export function renderAt(path, element, routePath = path) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}
