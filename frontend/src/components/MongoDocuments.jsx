import { useEffect, useState } from 'react';
import JsonView from './JsonView.jsx';
import { PAGE_SIZE, Pagination } from './ui.jsx';

/**
 * Documents rendered the way MongoDB Atlas' Data Explorer renders them: one bordered card per
 * document, `key: value` per line in a monospace font, values coloured by BSON type, nested
 * values collapsed behind a caret and labelled with their type. Atlas' three view modes
 * (list / JSON / table) are available through <DocumentsViewer>.
 */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Extended-JSON wrappers coming back from the API, shown with their shell spelling. */
export function shellWrapper(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const [key] = keys;
  const inner = value[key];
  if (key === '$oid') return `ObjectId("${inner}")`;
  if (key === '$date') {
    const iso = typeof inner === 'string' ? inner : new Date(Number(inner.$numberLong ?? inner)).toISOString();
    return `ISODate("${iso}")`;
  }
  if (['$numberDecimal', '$numberLong', '$numberInt', '$numberDouble'].includes(key)) return String(inner);
  return null;
}

/** The type word Atlas prints next to a collapsed value. */
export function typeLabel(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'Array';
  if (isPlainObject(value)) return shellWrapper(value) ? 'ObjectId' : 'Object';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int32' : 'Double';
  return typeof value === 'string' ? 'String' : 'Boolean';
}

function Scalar({ value }) {
  const wrapped = shellWrapper(value);
  if (wrapped) return <span className="mv-oid">{wrapped}</span>;
  if (value === null) return <span className="mv-null">null</span>;
  if (typeof value === 'string') return <span className="mv-string">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="mv-number">{value}</span>;
  return <span className="mv-bool">{String(value)}</span>;
}

/** Compact one-line rendering, used inside the table view. */
function inlineValue(value) {
  const wrapped = shellWrapper(value);
  if (wrapped) return wrapped;
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array (${value.length})`;
  if (isPlainObject(value)) return 'Object';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function Field({ name, value, depth }) {
  const nested = (Array.isArray(value) || isPlainObject(value)) && !shellWrapper(value);
  const [open, setOpen] = useState(false);
  const indent = { paddingLeft: depth * 18 };

  if (!nested) {
    return (
      <div className="doc-line" style={indent}>
        <span className="doc-caret-space" />
        <span className="doc-key">{name}:</span>
        <Scalar value={value} />
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  return (
    <>
      <button type="button" className="doc-line doc-line-toggle" style={indent} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="doc-caret">{open ? '▾' : '▸'}</span>
        <span className="doc-key">{name}:</span>
        <span className="doc-type">{typeLabel(value)}</span>
      </button>
      {open && entries.map(([k, v]) => <Field key={k} name={k} value={v} depth={depth + 1} />)}
    </>
  );
}

export function DocumentCard({ doc }) {
  return (
    <article className="doc-card">
      {Object.entries(doc).map(([k, v]) => (
        <Field key={k} name={k} value={v} depth={0} />
      ))}
    </article>
  );
}

/** Atlas' list view: one card per document. */
export default function MongoDocuments({ documents }) {
  if (!documents.length) return <p className="muted m0">No documents.</p>;
  return (
    <div data-testid="mongo-documents">
      {documents.map((doc, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <DocumentCard key={doc?._id?.$oid || doc?._id || i} doc={doc} />
      ))}
    </div>
  );
}

/** Atlas' {} view: the documents as Extended JSON, exactly as the API returns them. */
export function MongoJson({ documents }) {
  return <JsonView value={documents} className="doc-json" testId="mongo-json" />;
}

/** Atlas' table view: fields as columns, documents as rows. */
export function MongoTable({ documents }) {
  const columns = [];
  for (const doc of documents) for (const key of Object.keys(doc)) if (!columns.includes(key)) columns.push(key);
  return (
    <div className="doc-table-wrap">
      <table className="doc-table" data-testid="mongo-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {documents.map((doc, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={doc?._id?.$oid || doc?._id || i}>
              {columns.map((c) => (
                <td key={c}>{c in doc ? inlineValue(doc[c]) : ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SchemaTable({ fields }) {
  return (
    <table className="schema-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.name}>
            <td className="doc-key">{f.name}</td>
            <td className="doc-type">{f.types.join(' | ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const VIEW_MODES = [
  { id: 'list', glyph: '☰', label: 'List view' },
  { id: 'json', glyph: '{ }', label: 'JSON view' },
  { id: 'table', glyph: '▦', label: 'Table view' },
];

/** The three view-mode buttons Atlas puts above the document list. */
export function ViewModeSwitch({ value, onChange }) {
  return (
    <div className="view-modes" role="group" aria-label="Document view mode">
      {VIEW_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`view-mode ${value === m.id ? 'active' : ''}`}
          aria-label={m.label}
          aria-pressed={value === m.id}
          onClick={() => onChange(m.id)}
        >
          {m.glyph}
        </button>
      ))}
    </div>
  );
}

/** Query output split into pages of PAGE_SIZE, so a 500-document result stays readable. */
export function PagedDocuments({ documents }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [documents]);
  const visible = documents.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return (
    <>
      <Pagination page={page} total={documents.length} onChange={setPage} />
      <MongoDocuments documents={visible} />
      <Pagination page={page} total={documents.length} onChange={setPage} />
    </>
  );
}

/** List / JSON / table, picked by `mode`. */
export function DocumentsViewer({ documents, mode = 'list' }) {
  if (mode === 'json') return <MongoJson documents={documents} />;
  if (mode === 'table') return <MongoTable documents={documents} />;
  return <MongoDocuments documents={documents} />;
}
