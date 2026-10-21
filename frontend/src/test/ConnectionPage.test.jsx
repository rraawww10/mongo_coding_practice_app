import { describe, expect, test } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionPage from '../pages/ConnectionPage.jsx';
import { mockFetch, renderAt } from './helpers.jsx';

const notConnected = { connection: { mode: null, status: 'not_configured' } };

describe('Connection page', () => {
  test('explains how to get an Atlas URL, masks the password and warns about admin credentials', async () => {
    mockFetch({ 'GET /api/connection': notConnected });
    renderAt('/connection', <ConnectionPage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'MongoDB Atlas' }));
    expect(screen.getByText(/How to get your Atlas connection string/)).toBeInTheDocument();
    expect(screen.getByLabelText('Database user password')).toHaveAttribute('type', 'password');
    expect(screen.getByText(/Never enter your Atlas/)).toBeInTheDocument();
  });

  test('submits Atlas details to the backend, clears the form and never stores credentials in the browser', async () => {
    let connected = false;
    const { calls } = mockFetch({
      'GET /api/connection': () => ({
        status: 200,
        body: connected ? { connection: { mode: 'atlas', status: 'connected', host: 'cluster0.x.mongodb.net', database: 'practice', usernameHint: 'st***', missingCollections: [] } } : notConnected,
      }),
      'POST /api/connection': () => {
        connected = true;
        return { status: 200, body: { connection: { mode: 'atlas', status: 'connected' } } };
      },
    });
    renderAt('/connection', <ConnectionPage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'MongoDB Atlas' }));
    await userEvent.type(screen.getByLabelText('Connection string'), 'mongodb+srv://cluster0.x.mongodb.net/');
    await userEvent.type(screen.getByLabelText('Database username'), 'student1');
    await userEvent.type(screen.getByLabelText('Database user password'), 'S3cret-pass');
    await userEvent.type(screen.getByLabelText('Practice database name'), 'practice');
    await userEvent.click(screen.getByRole('button', { name: 'Test & connect' }));

    await screen.findByText('Connected to your MongoDB Atlas database.');
    const post = calls.find((c) => c.method === 'POST');
    expect(post.body).toEqual({ mode: 'atlas', connectionUrl: 'mongodb+srv://cluster0.x.mongodb.net/', username: 'student1', password: 'S3cret-pass', database: 'practice' });
    await waitFor(() => expect(screen.getByLabelText('Database user password')).toHaveValue(''));
    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain('S3cret-pass');
    expect(stored).not.toContain('mongodb+srv');
  });

  test('shows actionable connection errors', async () => {
    mockFetch({
      'GET /api/connection': notConnected,
      'POST /api/connection': () => ({ status: 401, body: { error: { code: 'AUTH_FAILED', message: 'Authentication failed: the database username or password is incorrect.' } } }),
    });
    renderAt('/connection', <ConnectionPage />);
    await userEvent.click(await screen.findByRole('tab', { name: 'MongoDB Atlas' }));
    await userEvent.type(screen.getByLabelText('Connection string'), 'mongodb+srv://u:p@c.mongodb.net/');
    await userEvent.type(screen.getByLabelText('Practice database name'), 'p');
    await userEvent.click(screen.getByRole('button', { name: 'Test & connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('AUTH_FAILED');
  });

  test('connects to the local simulation', async () => {
    let connected = false;
    mockFetch({
      'GET /api/connection': () => ({ status: 200, body: connected ? { connection: { mode: 'local', status: 'connected', host: 'local-simulation', database: 'mongodb_practice' } } : notConnected }),
      'POST /api/connection': () => {
        connected = true;
        return { status: 200, body: {} };
      },
    });
    renderAt('/connection', <ConnectionPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect to local practice database' }));
    expect(await screen.findByText('local-simulation')).toBeInTheDocument();
    expect(screen.getByText('connected')).toBeInTheDocument();
  });
});
