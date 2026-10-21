import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, post, setToken, getToken, setUnauthorizedHandler } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) return;
    get('/api/me')
      .then((r) => setUser(r.user))
      .catch(() => logout())
      .finally(() => setLoading(false));
  }, [logout]);

  const login = useCallback(async (email, password) => {
    const r = await post('/api/auth/login', { email, password });
    setToken(r.token);
    setUser(r.user);
    return r.user;
  }, []);

  const register = useCallback(async (name, email, password) => {
    const r = await post('/api/auth/register', { name, email, password });
    setToken(r.token);
    setUser(r.user);
    return r.user;
  }, []);

  const refresh = useCallback(async () => {
    const r = await get('/api/me');
    setUser(r.user);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout, refresh, isStaff: user && ['instructor', 'admin'].includes(user.role) }),
    [user, loading, login, register, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
