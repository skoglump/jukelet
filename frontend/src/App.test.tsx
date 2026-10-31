import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';

const session = () => ({
  authenticated: true, mode: 'read_only', runtime: 'standalone', user_id: null, csrf_token: 'synthetic-csrf',
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
const musicReply = () => reply(200, Object.fromEntries(['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search'].map(name => [name, 'unsupported'])));
const inventoryReply = () => reply(200, { tags: [], total: 0, registry_available: false, stale: true });
const draftsReply = () => reply(200, { assignments: [], total: 0, revision: 0 });
const publicationReply = () => reply(200, { jobs: [], pending_removals: [], actual: null, actual_stale: true, desired_version: 0, mapping_count: 0 });
const statusReply = () => reply(200, { connection: 'not_configured', services: {}, inventory_stale: true });
const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const standaloneRequired = () => reply(401, { detail: { code: 'standalone_authentication_required', runtime: 'standalone' } });
const managerReply = (url: string) => url.includes('/api/v1/tags') ? inventoryReply()
  : url.includes('/api/v1/music') ? musicReply() : url.includes('/api/v1/assignments') ? draftsReply()
    : url.includes('/api/v1/publication') ? publicationReply() : statusReply();
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('an unsafe mount path fails closed before requesting the session', async () => {
  const fetchMock = vi.fn().mockResolvedValue(reply(401));
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/api/hassio_ingress/unsafe%2Fsegment/');
  try {
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid application path');
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

test.each(['/', '/api/hassio_ingress/synthetic_A-123/', '/another/Ingress_token_456/'])('session and manager reads stay at the same-origin mount %s', async prefix => {
  window.history.replaceState(null, '', prefix);
  const fetchMock = vi.fn().mockResolvedValueOnce(standaloneRequired()).mockImplementation((url: string) => {
    const path = new URL(url, window.location.origin).pathname;
    return Promise.resolve(path.endsWith('/session') ? reply(200, session())
      : path.includes('/api/v1/tags') ? inventoryReply() : path.includes('/api/v1/music') ? musicReply()
        : path.includes('/api/v1/assignments') ? draftsReply() : path.includes('/api/v1/publication') ? publicationReply() : statusReply());
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('App secret'), { target: { value: 'synthetic-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Sign out' });
    expect(screen.getByRole('link', { name: 'Third-party notices' })).toHaveAttribute('href', `${window.location.origin}${prefix}third-party-notices.txt`);
    const endpoints = new Set(fetchMock.mock.calls.map(([url]) => url));
    for (const endpoint of ['session', 'status', 'tags?offset=0&limit=100', 'music/capabilities', 'assignments?offset=0&limit=100', 'publication', 'playback-status', 'recovery']) {
      expect(endpoints).toContain(`${window.location.origin}${prefix}api/v1/${endpoint}`);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByLabelText('App secret');
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url.startsWith(`${window.location.origin}${prefix}api/v1/`)).toBe(true);
      expect(options).toMatchObject({ credentials: 'same-origin', redirect: 'error' });
    }
    expect(fetchMock.mock.calls.at(-1)![1]).toMatchObject({ method: 'DELETE', headers: { 'X-CSRF-Token': 'synthetic-csrf' } });
  } finally {
    window.history.replaceState(null, '', '/');
  }
});

test('loads, signs in, clears the secret, and signs out with CSRF', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(standaloneRequired())
    .mockResolvedValueOnce(reply(200, session())).mockResolvedValueOnce(statusReply()).mockResolvedValueOnce(inventoryReply()).mockResolvedValueOnce(musicReply()).mockResolvedValueOnce(draftsReply()).mockResolvedValueOnce(publicationReply()).mockResolvedValueOnce(reply(200, { connection: 'not_configured', stale: true, diagnostics: null, checked_at: null, error: 'unavailable' })).mockResolvedValueOnce(reply(200, { reconciliation_required: false })).mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(screen.getByRole('status')).toHaveTextContent('Checking your session');
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('App secret'), 'synthetic-login-secret');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Home Assistant is not configured.')).toBeInTheDocument();
  expect(screen.getByText('Read-only')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Tag playback readiness' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save local draft' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm local import' })).not.toBeInTheDocument();
  expect(screen.getByText(/Local drafts and active HA snapshots have separate outcomes/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByLabelText('App secret')).toHaveValue('');
  expect(fetchMock.mock.calls[9][1]).toMatchObject({
    method: 'DELETE', headers: { 'X-CSRF-Token': 'synthetic-csrf' },
  });
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

test.each([401, 429, 500])('handles login failure %s without retaining credentials', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(standaloneRequired()).mockResolvedValueOnce(reply(status)));
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
  expect(screen.queryByLabelText('App secret')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check access again' })).toBeInTheDocument();
});

test.each([
  () => reply(401),
  () => new Response('<h1>Home Assistant sign-in required</h1>', { status: 401, headers: { 'Content-Type': 'text/html' } }),
  () => reply(403),
  () => reply(401, { detail: { runtime: 'standalone' } }),
  () => reply(401, { detail: { code: 'standalone_authentication_required', runtime: 'ingress' } }),
])('gateway or denied access never falls back to the standalone secret form', async response => {
  const fetchMock = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Access');
  expect(screen.queryByLabelText('App secret')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check access again' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
});

test.each(['/', '/api/hassio_ingress/synthetic_A-123/'])('verified Ingress session at %s has no second login or app logout', async prefix => {
  window.history.replaceState(null, '', prefix);
  const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith('/session')
    ? reply(200, { ...session(), runtime: 'ingress', user_id: 'a'.repeat(32) }) : managerReply(url)));
  vi.stubGlobal('fetch', fetchMock);
  try {
    render(<App />);
    expect(await screen.findByText('Access is managed by Home Assistant. Manage sign-in there.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your tag and music manager' })).toBeInTheDocument();
    expect(screen.queryByLabelText('App secret')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  } finally { window.history.replaceState(null, '', '/'); }
});

test('denied access retries only on explicit action and recovers using the backend identity', async () => {
  let probes = 0;
  const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith('/session')
    ? ++probes === 1 ? reply(403) : reply(200, { ...session(), runtime: 'ingress', user_id: 'b'.repeat(32) })
    : managerReply(url)));
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Access was not accepted');
  expect(probes).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Check access again' }));
  expect(await screen.findByRole('heading', { name: 'Your tag and music manager' })).toBeInTheDocument();
  expect(probes).toBe(2);
  expect(screen.queryByLabelText('App secret')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

test('Ingress session expiry offers an access check instead of app-secret sign-in', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith('/session')
    ? reply(200, { ...session(), runtime: 'ingress', user_id: 'a'.repeat(32), expires_at: new Date(Date.now() + 1000).toISOString() })
    : managerReply(url)));
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('heading', { name: 'Your tag and music manager' })).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(screen.getByRole('alert')).toHaveTextContent('session expired');
  expect(screen.getByRole('button', { name: 'Check access again' })).toBeInTheDocument();
  expect(screen.queryByLabelText('App secret')).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Your tag and music manager' })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/session'))).toHaveLength(1);
});

test.each([
  { runtime: undefined },
  { runtime: 'from-header' },
  { runtime: 'ingress', user_id: null },
  { runtime: 'ingress', user_id: 'unknown' },
  { user_id: 'a'.repeat(32) },
  { authenticated: false },
  { mode: 'administrator' },
  { csrf_token: '' },
  { expires_at: 'not-a-date' },
  { expires_at: new Date(0).toISOString() },
])('malformed backend session stays outside the manager: %j', async changed => {
  const fetchMock = vi.fn().mockResolvedValue(reply(200, { ...session(), ...changed }));
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('verify your session');
  expect(screen.queryByRole('heading', { name: 'Your tag and music manager' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('App secret')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('failed logout keeps the authenticated state visible', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') return Promise.resolve(reply(500));
    return Promise.resolve(url.endsWith('/session') ? reply(200, session()) : new URL(url).pathname.startsWith('/api/v1/tags') ? inventoryReply() : new URL(url).pathname.startsWith('/api/v1/music') ? musicReply() : new URL(url).pathname.startsWith('/api/v1/assignments') ? draftsReply() : new URL(url).pathname.startsWith('/api/v1/publication') ? publicationReply() : statusReply());
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to sign out');
  expect(screen.getByText('Home Assistant is not configured.')).toBeInTheDocument();
});

test('expires the session and asks the owner to sign in again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(200, session())).mockImplementation((url: string) => Promise.resolve(new URL(url).pathname.startsWith('/api/v1/tags') ? inventoryReply() : new URL(url).pathname.startsWith('/api/v1/music') ? musicReply() : new URL(url).pathname.startsWith('/api/v1/assignments') ? draftsReply() : new URL(url).pathname.startsWith('/api/v1/publication') ? publicationReply() : statusReply())));
  render(<App />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('Read-only')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(3600_000); });
  expect(screen.getByRole('alert')).toHaveTextContent('session expired');
  expect(screen.getByLabelText('App secret')).toHaveValue('');
});
