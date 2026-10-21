import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const LINKS = [
  ['/practice', 'Coding Practice'],
  ['/dashboard', 'Dashboard'],
  ['/connection', 'Database'],
];

const initials = (name = '') =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    const close = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ◆
          </span>
          MongoDB Practice
        </div>
        <nav className="topnav">
          {LINKS.map(([to, label]) => (
            <NavLink key={to} to={to} className="topnav-link">
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right" ref={wrap}>
          <button type="button" className="avatar" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
            {initials(user?.name) || '?'}
          </button>
          {menu && (
            <div className="menu" role="menu">
              <div className="menu-head">
                <div className="menu-name">{user?.name}</div>
                <div className="menu-mail">{user?.email}</div>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  logout();
                  navigate('/login');
                }}
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

      {user?.practiceDisabled && (
        <div className="alert alert-error banner">Your practice access has been disabled. You can still read questions and your progress.</div>
      )}

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
