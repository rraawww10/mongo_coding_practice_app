/** Read-only pretty JSON with lightweight syntax colouring (no HTML injection: React escapes text). */
function tokenize(json) {
  const parts = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let last = 0;
  let m;
  while ((m = re.exec(json))) {
    if (m.index > last) parts.push({ t: 'p', v: json.slice(last, m.index) });
    if (m[1]) {
      parts.push({ t: m[2] ? 'k' : 's', v: m[1] });
      if (m[2]) parts.push({ t: 'p', v: m[2] });
    } else if (m[3]) parts.push({ t: 'b', v: m[0] });
    else parts.push({ t: 'n', v: m[0] });
    last = re.lastIndex;
  }
  if (last < json.length) parts.push({ t: 'p', v: json.slice(last) });
  return parts;
}

export default function JsonView({ value, maxHeight, className = 'json', testId = 'json-view' }) {
  const json = JSON.stringify(value, null, 2) ?? 'undefined';
  return (
    <pre className={className} style={maxHeight ? { maxHeight } : undefined} data-testid={testId}>
      {tokenize(json).map((p, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i} className={`j-${p.t}`}>
          {p.v}
        </span>
      ))}
    </pre>
  );
}
