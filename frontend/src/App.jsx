import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import AppShell from './components/AppShell.jsx';
import { Spinner } from './components/ui.jsx';
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx';
import Dashboard from './pages/Dashboard.jsx';
import ConnectionPage from './pages/ConnectionPage.jsx';
import PracticePage from './pages/PracticePage.jsx';

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Restoring session…" />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/practice" replace /> : <LoginPage />} />
      <Route path="/register" element={user ? <Navigate to="/practice" replace /> : <RegisterPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/connection" element={<ConnectionPage />} />
        <Route path="/practice" element={<PracticePage />} />
        <Route path="/practice/:questionId" element={<PracticePage />} />
      </Route>
      <Route path="*" element={<Navigate to={user ? '/practice' : '/login'} replace />} />
    </Routes>
  );
}
