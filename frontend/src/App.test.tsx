import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';

const session = () => ({
  authenticated: true, mode: 'read_only', csrf_token: 'synthetic-csrf',
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
const musicReply = () => reply(200, Object.fromEntries(['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search'].map(name => [name, 'unsupported'])));
const inventoryReply = () => reply(200, { tags: [], total: 0, registry_available: false, stale: true });
const statusReply = () => reply(200, { connection: 'not_configured', services: {}, inventory_stale: true });
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('loads, signs in, clears the secret, and signs out with CSRF', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(reply(401))
    .mockResolvedValueOnce(reply(200, session())).mockResolvedValueOnce(statusReply()).mockResolvedValueOnce(inventoryReply()).mockResolvedValueOnce(musicReply()).mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(screen.getByRole('status')).toHaveTextContent('Checking your session');
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('App secret'), 'synthetic-login-secret');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Home Assistant is not configured.')).toBeInTheDocument();
  expect(screen.getByText('Read-only')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByLabelText('App secret')).toHaveValue('');
  expect(fetchMock.mock.calls[5][1]).toMatchObject({
    method: 'DELETE', headers: { 'X-CSRF-Token': 'synthetic-csrf' },
  });
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

test.each([401, 429, 500])('handles login failure %s without retaining credentials', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(401)).mockResolvedValueOnce(reply(status)));
  render(<App />);
  const input = await screen.findByLabelText('App secret');
  fireEvent.change(input, { target: { value: 'synthetic-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(input).toHaveValue('');
  expect(screen.queryByText('Home Assistant is not configured.')).not.toBeInTheDocument();
});

test('reports connection failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unavailable')));
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to reach Jukelet');
});

test('failed logout keeps the authenticated state visible', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, session())).mockResolvedValueOnce(statusReply()).mockResolvedValueOnce(inventoryReply()).mockResolvedValueOnce(musicReply()).mockResolvedValueOnce(reply(500)));
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to sign out');
  expect(screen.getByText('Home Assistant is not configured.')).toBeInTheDocument();
});

test('expires the session and asks the owner to sign in again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, session())).mockImplementation((url: string) => Promise.resolve(url.startsWith('/api/v1/tags') ? inventoryReply() : url.startsWith('/api/v1/music') ? musicReply() : statusReply())));
  render(<App />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('Read-only')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(3600_000); });
  expect(screen.getByRole('alert')).toHaveTextContent('session expired');
  expect(screen.getByLabelText('App secret')).toHaveValue('');
});
