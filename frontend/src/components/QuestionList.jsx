import { useEffect, useState } from 'react';

/** Left rail: practice modules (topics) with their questions, like a course outline. */
function groupByTopic(questions) {
  const groups = new Map();
  for (const q of questions) {
    if (!groups.has(q.topic)) groups.set(q.topic, []);
    groups.get(q.topic).push(q);
  }
  return [...groups].map(([topic, items]) => ({ topic, items }));
}

export default function QuestionList({ questions, activeId, onSelect }) {
  const groups = groupByTopic(questions);
  const activeTopic = questions.find((q) => q.questionId === activeId)?.topic;
  const [open, setOpen] = useState(() => new Set(activeTopic ? [activeTopic] : groups.slice(0, 1).map((g) => g.topic)));

  useEffect(() => {
    if (activeTopic) setOpen((prev) => (prev.has(activeTopic) ? prev : new Set([...prev, activeTopic])));
  }, [activeTopic]);

  const toggle = (topic) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });

  return (
    <nav className="modules" aria-label="Practice modules">
      <button type="button" className={`module-item ${activeId === null ? 'active' : ''}`} onClick={() => onSelect(null)}>
        <span className="item-icon" aria-hidden="true">
          ✎
        </span>
        <span className="item-title">Free practice</span>
      </button>

      {groups.map(({ topic, items }) => {
        const done = items.filter((q) => q.progress.completed).length;
        const isOpen = open.has(topic);
        return (
          <section className={`module ${isOpen ? 'open' : ''}`} key={topic}>
            <button type="button" className="module-head" onClick={() => toggle(topic)} aria-expanded={isOpen}>
              <span className="module-icon" aria-hidden="true">
                ◈
              </span>
              <span className="module-title">{topic}</span>
              <span className="module-progress">
                {done}/{items.length}
              </span>
              <span className="chevron" aria-hidden="true">
                {isOpen ? '⌃' : '⌄'}
              </span>
            </button>
            {isOpen && (
              <div className="module-body">
                {items.map((q) => (
                  <button
                    type="button"
                    key={q.questionId}
                    className={`module-item ${q.questionId === activeId ? 'active' : ''}`}
                    onClick={() => onSelect(q.questionId)}
                  >
                    <span className="item-icon" aria-hidden="true">
                      {'</>'}
                    </span>
                    <span className="item-title">{q.title}</span>
                    <span className={`item-state ${q.progress.completed ? 'done' : ''}`} aria-hidden="true">
                      {q.progress.completed ? '✓' : '○'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </nav>
  );
}
