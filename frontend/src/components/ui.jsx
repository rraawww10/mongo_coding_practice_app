import { useEffect, useState, useCallback } from 'react';

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" /> {label}
    </div>
  );
}

export function Alert({ kind = 'info', title, children, onClose }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div>
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {onClose && (
        <button type="button" className="link" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function ErrorAlert({ error, onClose }) {
  if (!error) return null;
  return (
    <Alert kind="error" title={error.code ? `${error.code}` : 'Error'} onClose={onClose}>
      {error.message}
      {error.line ? ` (line ${error.line}, column ${error.column})` : ''}
    </Alert>
  );
}

const BADGE = {
  connected: 'ok', ready: 'ok', passed: 'ok', ok: 'ok',
  error: 'bad', failed: 'bad', disabled: 'bad', denied: 'bad',
  not_configured: 'muted', not_initialized: 'muted', needs_initialization: 'warn', pending: 'warn',
};

export function Badge({ value, label }) {
  return <span className={`badge badge-${BADGE[value] || 'muted'}`}>{label || String(value).replace(/_/g, ' ')}</span>;
}

export function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export const PAGE_SIZE = 20;

/** "1 – 20 of 240" with Previous / Next. `page` is zero-based; renders nothing for a single page. */
export function Pagination({ page, pageSize = PAGE_SIZE, total, onChange }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, from + pageSize - 1);
  return (
    <nav className="pager" aria-label="Pagination">
      <button type="button" className="btn btn-sm btn-ghost-dark" onClick={() => onChange(page - 1)} disabled={page === 0}>
        ‹ Prev
      </button>
      <span className="muted small" data-testid="pager-range">
        {from} – {to} of {total}
      </span>
      <button type="button" className="btn btn-sm btn-ghost-dark" onClick={() => onChange(page + 1)} disabled={page >= pages - 1}>
        Next ›
      </button>
    </nav>
  );
}

/** Small data-loading hook: { data, error, loading, reload }. */
export function useApi(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loader();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState({ data: null, error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}

export const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');
