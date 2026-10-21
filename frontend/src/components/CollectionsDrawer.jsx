import { useEffect, useRef, useState } from 'react';
import { get } from '../api/client.js';
import { DocumentsViewer, SchemaTable, ViewModeSwitch } from './MongoDocuments.jsx';
import { ErrorAlert, Spinner } from './ui.jsx';

/**
 * "Show collections": browse the documents a question is asked about, straight from the
 * workspace. Laid out like the Atlas Data Explorer — collection tabs, a Documents/Schema
 * switch, the result range, and the list / JSON / table view modes.
 */
export default function CollectionsDrawer({ open, onToggle, collections, questionCollection, ready, counts = {} }) {
  const ordered = questionCollection
    ? [questionCollection, ...collections.filter((c) => c !== questionCollection)]
    : collections;
  const [active, setActive] = useState(ordered[0]);
  const [view, setView] = useState('documents');
  const [mode, setMode] = useState('list');
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const cache = useRef(new Map());

  useEffect(() => {
    if (questionCollection) setActive(questionCollection);
  }, [questionCollection]);

  useEffect(() => {
    if (!open || !ready || !active) return undefined;
    let cancelled = false;
    const cached = cache.current.get(active);
    if (cached) {
      setState({ loading: false, error: null, data: cached });
      return undefined;
    }
    setState({ loading: true, error: null, data: null });
    get(`/api/workspace/collections/${active}/sample?limit=20`)
      .then((data) => {
        cache.current.set(active, data);
        if (!cancelled) setState({ loading: false, error: null, data });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [open, ready, active]);

  return (
    <>
      <button
        type="button"
        className={`drawer-tab ${open ? 'drawer-tab-open' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="collections-drawer"
      >
        <span className="drawer-tab-caret">{open ? '›' : '‹'}</span>
        {open ? 'HIDE COLLECTIONS' : 'SHOW COLLECTIONS'}
      </button>

      {open && (
        <aside className="drawer" id="collections-drawer" data-testid="collections-drawer">
          <div className="drawer-tabs" role="tablist" aria-label="Collections">
            {ordered.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={name === active}
                className={`drawer-coll ${name === active ? 'active' : ''}`}
                onClick={() => setActive(name)}
              >
                <span className="coll-icon" aria-hidden="true">
                  ▤
                </span>
                {name}
                {counts[name] !== undefined && <span className="coll-count">{counts[name]}</span>}
              </button>
            ))}
          </div>

          <div className="drawer-views" role="tablist" aria-label="Collection view">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'documents'}
              className={`drawer-view ${view === 'documents' ? 'active' : ''}`}
              onClick={() => setView('documents')}
            >
              Documents
              {state.data && <span className="view-count">{state.data.total}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'schema'}
              className={`drawer-view ${view === 'schema' ? 'active' : ''}`}
              onClick={() => setView('schema')}
            >
              Schema
            </button>
          </div>

          <div className="drawer-sub">
            <code className="drawer-ns">db.{active}.find(&#123;&#125;)</code>
            <span className="spacer" />
            {state.data && view === 'documents' && (
              <>
                <span className="muted small">
                  1 – {state.data.documents.length} of {state.data.total}
                </span>
                <ViewModeSwitch value={mode} onChange={setMode} />
              </>
            )}
          </div>

          <div className="drawer-body">
            {!ready && <p className="muted">Your practice workspace is still being prepared.</p>}
            {ready && state.loading && <Spinner label="Loading documents…" />}
            {ready && state.error && <ErrorAlert error={state.error} />}
            {ready && state.data && view === 'schema' && <SchemaTable fields={state.data.fields} />}
            {ready && state.data && view === 'documents' && <DocumentsViewer documents={state.data.documents} mode={mode} />}
          </div>
        </aside>
      )}
    </>
  );
}
