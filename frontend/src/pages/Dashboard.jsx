import { Link } from 'react-router-dom';
import { get } from '../api/client.js';
import { Badge, ErrorAlert, Spinner, Stat, fmtDate, useApi } from '../components/ui.jsx';

/** The single dashboard: progress at a glance, the modules, and the submission history. */
export default function Dashboard() {
  const { data, error, loading } = useApi(() => Promise.all([get('/api/dashboard'), get('/api/progress')]));
  if (loading) return <Spinner />;
  if (error) return <ErrorAlert error={error} />;
  const [overview, history] = data;
  const { progress, modules } = overview;
  const attempts = history.attempts.slice(0, 15);
  const pct = progress.maxScore ? Math.round((progress.score / progress.maxScore) * 100) : 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Welcome back, {overview.user.name.split(' ')[0]}</h1>
          <p className="muted">
            Every query you write runs against your own private copy of <code>mongodb_practice</code>.
          </p>
        </div>
        <Link className="btn btn-primary" to="/practice">
          Open coding practice →
        </Link>
      </header>

      <section className="grid grid-4">
        <Stat label="Score" value={`${progress.score} / ${progress.maxScore}`} hint={`${pct}% of available points`} />
        <Stat label="Questions completed" value={`${progress.completed} / ${progress.totalQuestions}`} />
        <Stat label="Questions attempted" value={progress.attempted} />
        <Stat label="Submissions" value={progress.totalAttempts} />
      </section>

      <div className="progress-bar" aria-label="Overall progress">
        <div style={{ width: `${pct}%` }} />
      </div>

      <h2>Practice modules</h2>
      <section className="grid grid-3">
        {modules.map((m) => (
          <div className="card module-card" key={m.topic}>
            <div className="row between">
              <h3 className="m0">{m.topic}</h3>
              <span className="muted small">
                {m.completed}/{m.questionCount} done
              </span>
            </div>
            <ul className="module-list">
              {m.questions.map((q) => (
                <li key={q.questionId}>
                  <Link to={`/practice/${q.questionId}`}>
                    <span className={q.completed ? 'tick done' : 'tick'}>{q.completed ? '✓' : '○'}</span>
                    {q.title}
                  </Link>
                  <span className={`diff diff-${q.difficulty}`}>{q.points} pts</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <h2>Recent submissions</h2>
      <section className="card">
        {attempts.length === 0 ? (
          <p className="muted m0">
            No submissions yet. <Link to="/practice">Start practising →</Link>
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Question</th>
                <th>Attempt</th>
                <th>Result</th>
                <th>Score</th>
                <th>Query</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a._id}>
                  <td className="nowrap small">{fmtDate(a.createdAt)}</td>
                  <td>
                    <Link to={`/practice/${a.questionId}`}>{a.questionTitle}</Link>
                  </td>
                  <td>#{a.attemptNumber}</td>
                  <td>
                    <Badge value={a.status} />
                  </td>
                  <td>
                    {a.score}/{a.maxScore}
                  </td>
                  <td>
                    <code className="truncate">{a.query}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
