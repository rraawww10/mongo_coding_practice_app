import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, post } from '../api/client.js';
import { Alert, Badge, ErrorAlert, Spinner, fmtDate, useApi } from '../components/ui.jsx';

const EMPTY_ATLAS = { connectionUrl: '', username: '', password: '', database: '' };

export default function ConnectionPage() {
  const { data, error, loading, reload } = useApi(() => get('/api/connection'));
  const [mode, setMode] = useState('local');
  const [atlas, setAtlas] = useState(EMPTY_ATLAS);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [message, setMessage] = useState(null);

  const run = async (label, fn, success) => {
    setBusy(label);
    setActionError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(success);
      await reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const connectLocal = () => run('local', () => post('/api/connection', { mode: 'local' }), 'Connected to the local practice database.');
  const connectAtlas = (e) => {
    e.preventDefault();
    run(
      'atlas',
      async () => {
        await post('/api/connection', { mode: 'atlas', ...atlas });
        setAtlas(EMPTY_ATLAS); // never keep the password in memory longer than needed
      },
      'Connected to your MongoDB Atlas database.',
    );
  };

  if (loading && !data) return <Spinner />;
  const conn = data?.connection;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Database connection</h1>
          <p className="muted">Choose where your practice queries run.</p>
        </div>
      </header>
      <ErrorAlert error={error} />

      <section className="card">
        <div className="row between">
          <h2 className="m0">Current connection</h2>
          <Badge value={conn?.status || 'not_configured'} />
        </div>
        {conn?.status === 'not_configured' ? (
          <p className="muted">You are not connected yet.</p>
        ) : (
          <dl className="kv">
            <dt>Mode</dt>
            <dd>{conn.mode === 'local' ? 'Local simulation' : 'MongoDB Atlas'}</dd>
            <dt>Host</dt>
            <dd>{conn.host}</dd>
            <dt>Database</dt>
            <dd>{conn.database}</dd>
            {conn.usernameHint && (
              <>
                <dt>User</dt>
                <dd>{conn.usernameHint}</dd>
              </>
            )}
            <dt>Last tested</dt>
            <dd>{fmtDate(conn.lastTestedAt)}</dd>
          </dl>
        )}
        {conn?.lastError && <ErrorAlert error={conn.lastError} />}
        {conn?.warnings?.map((w) => (
          <Alert key={w} kind="warn">
            {w}
          </Alert>
        ))}
        {conn?.mode === 'atlas' && conn.missingCollections?.length > 0 && (
          <Alert kind="warn" title="Practice collections missing">
            <p className="m0">
              {conn.missingCollections.join(', ')} not found in “{conn.database}”. The platform can create them with the practice dataset.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!!busy}
              onClick={() => run('init', () => post('/api/workspace/initialize', { confirm: true }), 'Practice collections created.')}
            >
              {busy === 'init' ? 'Creating…' : 'Create practice collections'}
            </button>
          </Alert>
        )}
        {conn?.status && conn.status !== 'not_configured' && (
          <div className="row gap">
            <button type="button" className="btn" disabled={!!busy} onClick={() => run('test', () => post('/api/connection/test'), 'Connection test finished.')}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className="btn btn-danger-ghost" disabled={!!busy} onClick={() => run('disconnect', () => del('/api/connection'), 'Disconnected.')}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
            {conn.status === 'connected' && (
              <Link className="btn btn-primary" to="/practice">
                Continue to coding practice →
              </Link>
            )}
          </div>
        )}
      </section>

      {message && <Alert kind="success">{message}</Alert>}
      <ErrorAlert error={actionError} onClose={() => setActionError(null)} />

      <section className="card">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'local'} className={mode === 'local' ? 'tab active' : 'tab'} onClick={() => setMode('local')}>
            Local simulation
          </button>
          <button type="button" role="tab" aria-selected={mode === 'atlas'} className={mode === 'atlas' ? 'tab active' : 'tab'} onClick={() => setMode('atlas')}>
            MongoDB Atlas
          </button>
        </div>

        {mode === 'local' ? (
          <div className="stack">
            <p>
              Use the platform’s built-in MongoDB. You get a private copy of the <code>mongodb_practice</code> database (students, products,
              orders, employees, courses) that only you can query. No Atlas account needed.
            </p>
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={connectLocal}>
              {busy === 'local' ? 'Connecting…' : 'Connect to local practice database'}
            </button>
          </div>
        ) : (
          <div className="two-col">
            <form className="form" onSubmit={connectAtlas} autoComplete="off">
              <Alert kind="warn" title="Use a dedicated database user">
                Never enter your Atlas <em>account</em> password or an administrator connection string. Create a database user that only has
                the <code>readWrite</code> role on your practice database.
              </Alert>
              <label>
                Connection string
                <input
                  placeholder="mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/"
                  value={atlas.connectionUrl}
                  onChange={(e) => setAtlas({ ...atlas, connectionUrl: e.target.value })}
                  required
                />
              </label>
              <label>
                Database username
                <input value={atlas.username} onChange={(e) => setAtlas({ ...atlas, username: e.target.value })} autoComplete="off" />
              </label>
              <label>
                Database user password
                <input
                  type="password"
                  value={atlas.password}
                  onChange={(e) => setAtlas({ ...atlas, password: e.target.value })}
                  autoComplete="new-password"
                />
              </label>
              <label>
                Practice database name
                <input placeholder="e.g. mongodb_practice" value={atlas.database} onChange={(e) => setAtlas({ ...atlas, database: e.target.value })} required />
              </label>
              <button className="btn btn-primary" type="submit" disabled={!!busy}>
                {busy === 'atlas' ? 'Testing connection…' : 'Test & connect'}
              </button>
              <p className="muted small">
                Your connection string is sent once over HTTPS, encrypted on the server, and never shown again or stored in your browser.
              </p>
            </form>
            <div className="help">
              <h3>How to get your Atlas connection string</h3>
              <ol>
                <li>Sign in to MongoDB Atlas and open your cluster (a free M0 cluster is fine).</li>
                <li>
                  <strong>Security → Database Access</strong>: add a database user with password authentication and the built-in role
                  <code>readWrite</code> restricted to your practice database.
                </li>
                <li>
                  <strong>Security → Network Access</strong>: add the platform server’s IP address to the IP Access List.
                </li>
                <li>
                  Click <strong>Connect → Drivers</strong>, choose Node.js and copy the <code>mongodb+srv://…</code> string.
                </li>
                <li>Paste it here. Leave <code>&lt;password&gt;</code> in the string and type the password in the masked field instead.</li>
              </ol>
              <p className="muted small">The platform only ever touches the five practice collections in the database you name here.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
