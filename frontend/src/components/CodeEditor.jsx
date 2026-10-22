import { useLayoutEffect, useRef } from 'react';

/**
 * Query editor: a transparent textarea layered over a highlighted <pre>, with a line-number
 * gutter. Lines never wrap, so one gutter row always matches one editor row.
 */
const KEYWORDS = ['db', 'true', 'false', 'null', 'new', 'ISODate', 'ObjectId'];
const METHODS = [
  'find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne',
  'sort', 'limit', 'skip', 'project', 'count', 'toArray', 'pretty',
];

const TOKENS = new RegExp(
  [
    '(\\/\\/[^\\n]*)', // 1 comment
    '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')', // 2 string
    '(\\$[A-Za-z][A-Za-z0-9_]*)', // 3 operator ($gt, $group…)
    `\\b(${KEYWORDS.join('|')})\\b`, // 4 keyword
    `\\b(${METHODS.join('|')})\\b(?=\\s*\\()`, // 5 method
    '(-?\\d+(?:\\.\\d+)?)', // 6 number
    '([A-Za-z_][A-Za-z0-9_]*)(?=\\s*:)', // 7 field name
  ].join('|'),
  'g',
);
const CLASSES = ['cm-comment', 'cm-string', 'cm-operator', 'cm-keyword', 'cm-method', 'cm-number', 'cm-field'];

function highlight(code) {
  const out = [];
  let last = 0;
  let m;
  TOKENS.lastIndex = 0;
  while ((m = TOKENS.exec(code))) {
    if (m.index > last) out.push({ cls: null, text: code.slice(last, m.index) });
    const group = m.slice(1).findIndex((g) => g !== undefined);
    out.push({ cls: CLASSES[group], text: m[0] });
    last = TOKENS.lastIndex;
  }
  if (last < code.length) out.push({ cls: null, text: code.slice(last) });
  return out;
}

export default function CodeEditor({ value, onChange, onRun, disabled, fontSize = 15, placeholder }) {
  const input = useRef(null);
  const layer = useRef(null);
  const gutter = useRef(null);
  const lineCount = Math.max(value.split('\n').length, 12);

  // Keep the highlight layer and the gutter aligned with the textarea while it scrolls.
  const sync = () => {
    const el = input.current;
    if (!el) return;
    if (layer.current) {
      layer.current.scrollTop = el.scrollTop;
      layer.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };
  useLayoutEffect(sync, [value, fontSize]);

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun?.();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = input.current;
      const { selectionStart: start, selectionEnd: end } = el;
      onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
      requestAnimationFrame(() => {
        el.selectionStart = start + 2;
        el.selectionEnd = start + 2;
      });
    }
  };

  const metrics = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.6)}px` };

  return (
    <div className="code-editor" style={metrics}>
      <div className="code-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="code-surface">
        <pre className="code-layer" ref={layer} aria-hidden="true">
          {highlight(value).map((part, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} className={part.cls || undefined}>
              {part.text}
            </span>
          ))}
          {'\n'}
        </pre>
        <textarea
          ref={input}
          aria-label="MongoDB query editor"
          className="code-input"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={sync}
        />
      </div>
    </div>
  );
}
