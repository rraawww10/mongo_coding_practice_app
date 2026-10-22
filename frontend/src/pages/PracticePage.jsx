import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import CodeEditor from '../components/CodeEditor.jsx';
import CollectionsDrawer from '../components/CollectionsDrawer.jsx';
import JsonView from '../components/JsonView.jsx';
import { PagedDocuments } from '../components/MongoDocuments.jsx';
import QuestionList from '../components/QuestionList.jsx';
import { Alert, ErrorAlert, Spinner, useApi } from '../components/ui.jsx';

const COLLECTIONS = ['students', 'products', 'orders', 'employees', 'courses'];
const SPLIT_KEY = 'mp_results_pct';
const SPLIT_DEFAULT = 40;
const clampSplit = (pct) => Math.min(80, Math.max(15, pct));

/** Height of the results panel as a % of the code column, dragged by the splitter and remembered per browser. */
function useResultsSplit(containerRef) {
  const [pct, setPct] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SPLIT_KEY));
      return saved ? clampSplit(saved) : SPLIT_DEFAULT;
    } catch {
      return SPLIT_DEFAULT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_KEY, String(pct));
    } catch {
      /* storage unavailable: the split just isn't remembered */
    }
  }, [pct]);

  const onPointerDown = (e) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    const move = (ev) => setPct(clampSplit(((box.bottom - ev.clientY) / box.height) * 100));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowUp') setPct((p) => clampSplit(p + 5));
    else if (e.key === 'ArrowDown') setPct((p) => clampSplit(p - 5));
    else return;
    e.preventDefault();
  };
  const reset = () => setPct(SPLIT_DEFAULT);
  return { pct, onPointerDown, onKeyDown, reset };
}

function ResultBody({ status, result, error }) {
  if (status === 'idle') return <p className="muted m0">Run your query to see the documents it returns.</p>;
  if (status === 'running') return <Spinner label="Executing query…" />;
  if (status === 'error') {
    return (
      <div className="error-panel" data-testid="error-panel">
        <div className="error-code">{error.code}</div>
        <div>{error.message}</div>
        {error.line && (
          <div className="muted small">
            Line {error.line}, column {error.column}
          </div>
        )}
      </div>
    );
  }
  if (result.resultType === 'documents' || result.resultType === 'document') {
    if (result.count === 0) {
      return (
        <div className="empty-result" data-testid="empty-result">
          Query ran successfully — <strong>0 documents</strong> matched.
        </div>
      );
    }
    return (
      <>
        {result.truncated && <Alert kind="warn">Output limited to the first {result.count} documents. Add a filter or limit().</Alert>}
        <PagedDocuments documents={result.documents} />
      </>
    );
  }
  return <JsonView value={result.value} />;
}

function TestBody({ submission, question }) {
  if (!submission) {
    return (
      <ul className="tests">
        {(question?.testCases || []).map((t) => (
          <li key={t.id}>
            <span>○</span>
            <div>{t.name}</div>
          </li>
        ))}
        {!question?.testCases?.length && <p className="muted m0">Pick a question to have your query graded.</p>}
      </ul>
    );
  }
  if (submission.loading) return <Spinner label="Grading your solution…" />;
  if (submission.error) return <ErrorAlert error={submission.error} />;
  const r = submission.result;
  return (
    <div className="stack" data-testid="submission-result">
      <div className={`verdict verdict-${r.status}`}>
        {r.status === 'passed' ? '✓ Passed' : r.status === 'error' ? '✗ Query error' : '✗ Not quite'} · {r.score}/{r.maxScore} points · attempt #
        {r.attemptNumber}
      </div>
      {r.error && <ErrorAlert error={r.error} />}
      <ul className="tests">
        {r.testResults.map((t) => (
          <li key={t.id} className={t.passed ? 'pass' : 'fail'}>
            <span>{t.passed ? '✓' : '✗'}</span>
            <div>
              <div>{t.name}</div>
              {!t.passed && <div className="muted small">{t.message}</div>}
            </div>
          </li>
        ))}
      </ul>
      {r.output && (
        <details>
          <summary>
            Your output ({r.output.count} result{r.output.count === 1 ? '' : 's'})
          </summary>
          {r.output.documents ? <PagedDocuments documents={r.output.documents} /> : <JsonView value={r.output.value} maxHeight={260} />}
        </details>
      )}
    </div>
  );
}

export default function PracticePage() {
  const { questionId = null } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const disabled = Boolean(user?.practiceDisabled);

  // One call gets the student practising: connect locally and initialize the workspace if needed.
  const ws = useApi(() => (disabled ? get('/api/workspace') : post('/api/workspace/ensure')), [disabled]);
  const qs = useApi(() => get('/api/questions'));

  const [query, setQuery] = useState('');
  const [exec, setExec] = useState({ status: 'idle' });
  const [submission, setSubmission] = useState(null);
  const [tab, setTab] = useState('output');
  const [drawer, setDrawer] = useState(false);
  const [descOpen, setDescOpen] = useState(true);
  const [fontSize, setFontSize] = useState(15);
  const [resetCount, setResetCount] = useState(0);
  const [busy, setBusy] = useState(null);
  const codePane = useRef(null);
  const split = useResultsSplit(codePane);

  const questions = qs.data?.questions || [];
  const question = useMemo(() => questions.find((q) => q.questionId === questionId) || null, [questions, questionId]);
  const collection = question?.collection || 'students';

  useEffect(() => {
    setQuery('');
    setExec({ status: 'idle' });
    setSubmission(null);
    setTab('output');
  }, [question?.questionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async () => {
    if (!query.trim()) return;
    setExec({ status: 'running' });
    setTab('output');
    try {
      setExec({ status: 'success', result: await post('/api/query/execute', { query }) });
    } catch (error) {
      setExec({ status: 'error', error });
    }
  }, [query]);

  const submit = async () => {
    if (!question || !query.trim()) return;
    setSubmission({ loading: true });
    setTab('tests');
    try {
      const result = await post(`/api/questions/${question.questionId}/submit`, { query });
      setSubmission({ result });
      qs.reload();
    } catch (error) {
      setSubmission({ error });
    }
  };

  /** Clears the editor; the workspace data is left alone. */
  const resetCode = () => {
    setQuery('');
    setExec({ status: 'idle' });
  };

  const resetDb = async () => {
    setBusy('reset');
    try {
      await post('/api/workspace/reset');
      setResetCount((n) => n + 1);
      ws.reload();
    } catch (error) {
      setExec({ status: 'error', error });
      setTab('output');
    } finally {
      setBusy(null);
    }
  };

  if (ws.loading || qs.loading) return <Spinner label="Preparing your workspace…" />;
  if (ws.error) return <ErrorAlert error={ws.error} />;

  const conn = ws.data.connection;
  const ready = ws.data.workspace.status === 'ready' && ws.data.workspace.mode === conn.mode;
  const counts = Object.fromEntries((ws.data.collections || []).map((c) => [c.name, c.count]));
  const canRun = ready && !disabled && exec.status !== 'running' && Boolean(query.trim());

  return (
    <div className={`ide ${descOpen ? '' : 'desc-collapsed'}`}>
      <aside className="ide-rail">
        <QuestionList questions={questions} activeId={questionId} onSelect={(id) => navigate(id ? `/practice/${id}` : '/practice')} />
      </aside>

      <div className="ide-main">
        <header className="crumbs">
          <div className="crumb-path">
            <span>{question ? question.topic : 'Practice'}</span>
            <span className="sep">›</span>
            <strong>Coding Practice</strong>
          </div>
          <div className="points">
            Win <span className="coin" aria-hidden="true">◉</span> {question ? question.points : 0} Points
          </div>
        </header>

        {!ready && (
          <Alert kind="warn" title="Workspace not ready">
            {conn.status !== 'connected' ? (
              <>
                Connect a database on the <Link to="/connection">Database</Link> page to start practising.
              </>
            ) : (
              <>
                Your Atlas database still needs the practice collections. Open <Link to="/connection">Database</Link> to initialize them.
              </>
            )}
          </Alert>
        )}

        <div className="panes">
          <section className="pane pane-desc">
            <div className="pane-head">
              <span className="pane-tab active">
                <span className="pane-tab-icon" aria-hidden="true">
                  ▤
                </span>
                Description
              </span>
              <span className="spacer" />
              <button type="button" className="icon-btn" title="Collapse description" onClick={() => setDescOpen(false)} aria-label="Collapse description">
                ‹
              </button>
            </div>
            <div className="pane-body desc-body">
              {question ? (
                <>
                  <h1 className="desc-title">{question.title}</h1>
                  <div className="desc-meta">
                    <span className={`diff diff-${question.difficulty}`}>{question.difficulty}</span>
                    <span className="chip">{question.points} points</span>
                    {question.progress.completed && <span className="chip chip-ok">completed</span>}
                    <span className="chip">attempts: {question.progress.attempts}</span>
                  </div>
                  <p>{question.description}</p>

                  <h3>Collection</h3>
                  <p>
                    This question runs against the <code>{question.collection}</code> collection of your private{' '}
                    <code>mongodb_practice</code> database
                    {counts[question.collection] !== undefined ? ` (${counts[question.collection]} documents)` : ''}.
                  </p>
                  <ul>
                    <li>
                      Allowed operations: {question.allowedOperations.map((op) => (
                        <code key={op}>{op}</code>
                      ))}
                    </li>
                    <li>Press Ctrl+Enter or Run to execute, Submit to be graded.</li>
                    <li>Open Show collections on the right to inspect the documents you are querying.</li>
                  </ul>

                  <div className="desc-questions">
                    <div className="desc-questions-head">QUESTION</div>
                    <p className="m0">{question.requirements || question.description}</p>
                  </div>

                  <h3>Test cases</h3>
                  <ul>
                    {question.testCases.map((t) => (
                      <li key={t.id}>{t.name}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <h1 className="desc-title">Free practice</h1>
                  <p>
                    Run any supported query against your own copy of the <code>mongodb_practice</code> database. Nothing is graded here —
                    pick a question on the left when you want feedback.
                  </p>
                  <h3>Collections</h3>
                  <ul>
                    {COLLECTIONS.map((c) => (
                      <li key={c}>
                        <code>{c}</code>
                        {counts[c] !== undefined ? ` — ${counts[c]} documents` : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="muted">Use Show collections on the right to browse the documents.</p>
                </>
              )}
            </div>
          </section>

          {!descOpen && (
            <button type="button" className="desc-reopen" onClick={() => setDescOpen(true)} aria-label="Show description">
              <span aria-hidden="true">›</span> DESCRIPTION
            </button>
          )}

          <section className="pane pane-code" ref={codePane}>
            <div className="code-card">
              <div className="code-head">
                <span className="code-file">
                  <span className="code-file-icon" aria-hidden="true">
                    ◆
                  </span>
                  Query.MONGO({question ? question.questionId : 'free'})
                </span>
                <span className="spacer" />
                <div className="zoom">
                  <button type="button" onClick={() => setFontSize((f) => Math.max(11, f - 1))} aria-label="Decrease font size">
                    −
                  </button>
                  <span>{fontSize}</span>
                  <button type="button" onClick={() => setFontSize((f) => Math.min(26, f + 1))} aria-label="Increase font size">
                    +
                  </button>
                </div>
              </div>

              <div className="code-area">
                <CodeEditor value={query} onChange={setQuery} onRun={run} disabled={disabled} fontSize={fontSize} placeholder="Write your query here" />
                <CollectionsDrawer
                  key={resetCount}
                  open={drawer}
                  onToggle={() => setDrawer((o) => !o)}
                  collections={COLLECTIONS}
                  questionCollection={question?.collection}
                  ready={ready}
                  counts={counts}
                />
              </div>

              <div className="code-foot">
                <button type="button" className="btn btn-ghost-dark" onClick={resetDb} disabled={!ready || disabled || busy === 'reset'}>
                  <span aria-hidden="true">⛁</span> {busy === 'reset' ? 'Resetting…' : 'Reset DB'}
                </button>
                <button type="button" className="btn btn-ghost-dark" onClick={resetCode} disabled={!query}>
                  <span aria-hidden="true">↺</span> Reset Code
                </button>
                <span className="spacer" />
                <span className="exec-state">
                  {exec.status === 'success' && `${exec.result.count ?? ''} ${exec.result.resultType === 'write' ? 'write ok' : 'docs'} · ${exec.result.durationMs} ms`}
                  {exec.status === 'running' && 'Running…'}
                </span>
                <button type="button" className="btn btn-run" onClick={run} disabled={!canRun}>
                  <span aria-hidden="true">▶</span> Run
                </button>
                <button type="button" className="btn btn-submit" onClick={submit} disabled={!question || !query.trim() || !ready || disabled || submission?.loading}>
                  {submission?.loading ? 'Grading…' : 'Submit'}
                </button>
              </div>
            </div>

            <div
              className="splitter"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize query results"
              aria-valuenow={Math.round(split.pct)}
              aria-valuemin={15}
              aria-valuemax={80}
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              onPointerDown={split.onPointerDown}
              onKeyDown={split.onKeyDown}
              onDoubleClick={split.reset}
            />

            <div className="results-card" style={{ flexBasis: `${split.pct}%` }}>
              <div className="results-head">
                <button type="button" className={`pane-tab ${tab === 'output' ? 'active' : ''}`} onClick={() => setTab('output')}>
                  Query Results
                </button>
                <button type="button" className={`pane-tab ${tab === 'tests' ? 'active' : ''}`} onClick={() => setTab('tests')}>
                  Test Results
                </button>
                <span className="spacer" />
                {exec.status === 'success' && (
                  <span className="muted small">
                    {exec.result.operation}() on <code>{exec.result.collection}</code>
                  </span>
                )}
              </div>
              <div className="results-body">
                {tab === 'output' ? <ResultBody {...exec} /> : <TestBody submission={submission} question={question} />}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
