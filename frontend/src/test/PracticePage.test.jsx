import { describe, expect, test } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PracticePage from '../pages/PracticePage.jsx';
import { mockFetch, renderAt } from './helpers.jsx';

const workspace = {
  connection: { mode: 'local', status: 'connected', database: 'mongodb_practice' },
  workspace: { mode: 'local', status: 'ready' },
  database: { name: 'mongodb_practice' },
  collections: [
    { name: 'students', count: 12, fields: [] },
    { name: 'products', count: 16, fields: [] },
  ],
};
const question = {
  questionId: 'Q001', title: 'Find all active students', topic: 'find() basics', difficulty: 'beginner', points: 10,
  collection: 'students', description: 'Return active students', requirements: 'Complete documents', allowedOperations: ['find'],
  testCases: [{ id: 'count', name: 'Returns the correct number of documents' }],
  progress: { attempts: 0, bestScore: 0, completed: false },
};

const setup = (executeHandler, extra = {}) =>
  mockFetch({
    'POST /api/workspace/ensure': workspace,
    'GET /api/questions': { questions: [question] },
    'POST /api/query/execute': executeHandler,
    ...extra,
  });

const docs = (documents, over = {}) => ({
  status: 200,
  body: { ok: true, operation: 'find', collection: 'students', resultType: 'documents', documents, count: documents.length, truncated: false, durationMs: 4, ...over },
});

describe('Coding practice IDE', () => {
  test('bootstraps the workspace, runs a query and shows the JSON output', async () => {
    const { calls } = setup(() => docs([{ name: 'Diya' }]));
    renderAt('/practice', <PracticePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Run/ }));
    expect(screen.getByTestId('mongo-documents')).toHaveTextContent('"Diya"');
    expect(calls.some((c) => c.path === '/api/workspace/ensure' && c.method === 'POST')).toBe(true);
    expect(calls.find((c) => c.path === '/api/query/execute').body).toEqual({ query: 'db.students.find({})' });
  });

  test('shows a clear empty-result state', async () => {
    setup(() => docs([]));
    renderAt('/practice', <PracticePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Run/ }));
    expect(await screen.findByTestId('empty-result')).toHaveTextContent('0 documents');
  });

  test('shows query errors in the error panel with location', async () => {
    setup(() => ({ status: 400, body: { error: { code: 'INVALID_SYNTAX', message: "Expected '}'", line: 1, column: 22 } } }));
    renderAt('/practice', <PracticePage />);
    await userEvent.click(await screen.findByRole('button', { name: /Run/ }));
    const panel = await screen.findByTestId('error-panel');
    expect(panel).toHaveTextContent('INVALID_SYNTAX');
    expect(panel).toHaveTextContent('Line 1, column 22');
  });

  test('opening a question loads its starter query, which can be restored', async () => {
    setup(() => docs([]));
    renderAt('/practice/Q001', <PracticePage />, '/practice/:questionId');
    const editor = await screen.findByLabelText('MongoDB query editor');
    expect(editor).toHaveValue('db.students.find({})');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'db.students.countDocuments({{}})');
    await userEvent.click(screen.getByRole('button', { name: 'Reset Code' }));
    expect(editor).toHaveValue('db.students.find({})');
  });

  test('submits a solution and displays pass/fail per test case', async () => {
    setup(() => docs([]), {
      'POST /api/questions/Q001/submit': {
        status: 'passed', passed: true, score: 10, maxScore: 10, attemptNumber: 2,
        testResults: [{ id: 'count', name: 'Returns the correct number of documents', passed: true, message: 'Passed' }],
        output: { count: 9, documents: [] },
      },
    });
    renderAt('/practice/Q001', <PracticePage />, '/practice/:questionId');
    expect(await screen.findByText('Find all active students', { selector: 'h1' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByTestId('submission-result')).toHaveTextContent('✓ Passed · 10/10 points · attempt #2');
  });

  test('shows the collections of the question in MongoDB document format', async () => {
    setup(() => docs([]), {
      'GET /api/workspace/collections/students/sample*': {
        collection: 'students',
        total: 12,
        fields: [{ name: '_id', types: ['objectId'] }, { name: 'name', types: ['string'] }],
        documents: [{ _id: { $oid: '65a100000000000000000001' }, name: 'Aarav Sharma', age: 20, isActive: true }],
      },
    });
    renderAt('/practice/Q001', <PracticePage />, '/practice/:questionId');
    await userEvent.click(await screen.findByRole('button', { name: /SHOW COLLECTIONS/ }));
    const drawer = await screen.findByTestId('collections-drawer');
    expect(within(drawer).getByRole('tab', { name: /students/ })).toHaveAttribute('aria-selected', 'true');
    expect(await within(drawer).findByText('ObjectId("65a100000000000000000001")')).toBeInTheDocument();
    expect(within(drawer).getByText('"Aarav Sharma"')).toBeInTheDocument();

    // Atlas' other two view modes render the same documents.
    await userEvent.click(within(drawer).getByRole('button', { name: 'Table view' }));
    expect(within(drawer).getByRole('columnheader', { name: 'isActive' })).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole('button', { name: 'JSON view' }));
    expect(within(drawer).getByTestId('mongo-json')).toHaveTextContent('"$oid"');

    await userEvent.click(within(drawer).getByRole('tab', { name: /Schema/ }));
    expect(within(drawer).getByRole('row', { name: /name string/ })).toBeInTheDocument();
  });

  test('warns when the workspace is not ready', async () => {
    mockFetch({
      'POST /api/workspace/ensure': { ...workspace, connection: { status: 'not_configured' }, workspace: { status: 'not_initialized' }, collections: [] },
      'GET /api/questions': { questions: [] },
    });
    renderAt('/practice', <PracticePage />);
    expect(await screen.findByText('Workspace not ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run/ })).toBeDisabled();
  });
});
