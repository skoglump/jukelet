import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const uri = 'spotify:album:0123456789ABCDEFGHIJKL';
function fixture() {
  let probes = 0;
  const state = { user: 'a'.repeat(32), mode: 'manage', deny: false };
  const handlers = new Map<string, (options?: RequestInit) => Promise<Response>>();
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    const special = [...handlers].find(([suffix]) => url.endsWith(suffix));
    if (special) return special[1](options);
    if (url.endsWith('/session')) {
      if (state.deny) return reply({}, 403);
      probes += 1;
      return reply({ authenticated: true, runtime: 'ingress', user_id: state.user, mode: state.mode,
        csrf_token: `synthetic-session-${probes}`, expires_at: new Date(Date.now() + (probes === 1 ? 1000 : 3600_000)).toISOString() });
    }
    if (url.includes('/tags?')) return reply({ tags: [], total: 0, registry_available: true, stale: false });
    if (url.includes('/music/capabilities')) return reply(Object.fromEntries(['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search'].map(name => [name, 'unsupported'])));
    if (url.includes('/assignments?')) return reply({ assignments: [], total: 0, revision: 0 });
    if (url.endsWith('/publication')) return reply({ publisher_id: '00000000-0000-4000-8000-000000000030',
      jobs: [], pending_removals: [], actual: { dispatch_enabled: false }, actual_stale: false,
      desired_version: 3, desired_checksum: 'a'.repeat(64), mapping_count: 1, healthy: true,
      automatic_enabled: false, reconciliation_required: false, verified: false });
    if (url.endsWith('/recovery')) return reply({ reconciliation_required: false });
    return reply({ connection: 'not_configured', services: {}, inventory_stale: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { state, fetchMock, handlers };
}
async function mount() {
  render(<App />);
  await act(async () => { await Promise.resolve(); });
}
async function expire() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.queryByRole('region', { name: 'Music preview' })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(uri)).not.toBeInTheDocument();
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('a late rejection from the previous session cannot expire a newly verified user', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, handlers } = fixture();
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  handlers.set('/recovery', () => pending);
  await mount();
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: uri } });
  await expire();
  state.user = 'b'.repeat(32);
  handlers.delete('/recovery');
  fireEvent.click(screen.getByRole('button', { name: 'Check access again' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByLabelText('Spotify URI or link')).toHaveValue('');
  await act(async () => { finish(reply({}, 401)); });
  expect(screen.getByRole('heading', { name: 'Your tag and music manager' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

test('gateway denial at a protected endpoint removes cached manager content without offering app login', async () => {
  const { handlers, fetchMock } = fixture();
  await mount();
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: uri } });
  handlers.set('/playback-status', async () => reply({}, 403));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh playback status' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('region', { name: 'Music preview' })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(uri)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('App secret')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check access again' })).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/session'))).toHaveLength(1);
  expect(screen.getByRole('heading', { name: 'Check your access' })).toHaveFocus();
});

test('a delayed export body cannot download private data after another user authenticates', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, handlers } = fixture();
  let finish!: (blob: Blob) => void;
  const pending = new Promise<Blob>(resolve => { finish = resolve; });
  const exported = reply({ private: 'synthetic old-user export' });
  exported.blob = () => pending;
  handlers.set('/export', async () => exported);
  const objectUrl = vi.fn(() => 'blob:synthetic-private-export');
  const OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = objectUrl; });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Download mapping export' }));
  await act(async () => { await Promise.resolve(); });
  await expire();
  state.user = 'b'.repeat(32);
  fireEvent.click(screen.getByRole('button', { name: 'Check access again' }));
  await act(async () => { await Promise.resolve(); });
  await act(async () => { finish(new Blob(['synthetic old-user export'])); });
  expect(objectUrl).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'Your tag and music manager' })).toBeInTheDocument();
});

test('a file read begun by the old user cannot send a preview request after access changes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  let finish!: (value: ArrayBuffer) => void;
  const file = new File(['{}'], 'synthetic.json', { type: 'application/json' });
  file.arrayBuffer = () => new Promise(resolve => { finish = resolve; });
  await mount();
  fireEvent.change(screen.getByLabelText('Logical export JSON file'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview restore' }));
  await expire();
  state.user = 'b'.repeat(32);
  fireEvent.click(screen.getByRole('button', { name: 'Check access again' }));
  await act(async () => { await Promise.resolve(); });
  await act(async () => { finish(new TextEncoder().encode('{}').buffer); });
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/restores/preview'))).toBe(false);
  expect(screen.getByRole('heading', { name: 'Your tag and music manager' })).toBeInTheDocument();
});

test('a hidden or restored page requires a new explicit access check before showing private content', async () => {
  const { state } = fixture();
  await mount();
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: uri } });
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(screen.queryByDisplayValue(uri)).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Your tag and music manager' })).not.toBeInTheDocument();
  visibility.mockReturnValue('visible');
  state.user = 'b'.repeat(32);
  fireEvent.click(screen.getByRole('button', { name: 'Check access again' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByLabelText('Spotify URI or link')).toHaveValue('');
  expect(screen.getByRole('heading', { name: 'Your tag and music manager' })).toHaveFocus();
});

test('session renewal drops publication and restore confirmations and requires fresh explicit reviews', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { handlers, fetchMock } = fixture();
  let reviews = 0;
  let previews = 0;
  handlers.set('/publication/review', async () => reply({ action: 'publish', review_token: `review-${++reviews}`,
    desired_version: 3, checksum: 'a'.repeat(64), mapping_count: 1, empty: false, mappings: [], shuffle_conflict: false }));
  handlers.set('/restores/preview', async () => reply({ preview_token: `restore-${++previews}`, local_revision: 3,
    accepted: 1, rejected: 0, conflicts: 0, rows: [{ row: 1, source: { ha_tag_id: '  Synthetic:Å  ' }, accepted: true, conflict: false, diagnostics: [] }] }));
  handlers.set('/publication/confirm', async () => reply({ jobs: [], pending_removals: [] }));
  handlers.set('/restores/confirm', async () => reply({ restored: 1, skipped: 0 }));
  function selectFile() {
    const file = new File(['{}'], 'synthetic.json', { type: 'application/json' });
    file.arrayBuffer = async () => new TextEncoder().encode('{}').buffer;
    fireEvent.change(screen.getByLabelText('Logical export JSON file'), { target: { files: [file] } });
  }
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review snapshot publication' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByLabelText('I reviewed this exact snapshot and its preferences'));
  selectFile(); fireEvent.click(screen.getByRole('button', { name: 'Preview restore' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Restore conflict policy'), { target: { value: 'replace' } });
  fireEvent.click(screen.getByLabelText('I reviewed the restore rows and conflict policy'));
  expect(screen.getByRole('button', { name: 'Confirm snapshot publication' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Confirm local restore' })).toBeEnabled();
  await expire();
  expect(screen.queryByRole('region', { name: 'Review immutable snapshot' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Restore preview' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check access again' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole('button', { name: 'Confirm snapshot publication' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm local restore' })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/confirm'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Review snapshot publication' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByLabelText('I reviewed this exact snapshot and its preferences')).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel publication review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review snapshot publication' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByLabelText('I reviewed this exact snapshot and its preferences'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm snapshot publication' }));
  await act(async () => { await Promise.resolve(); });
  selectFile(); fireEvent.click(screen.getByRole('button', { name: 'Preview restore' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByLabelText('Restore conflict policy')).toHaveValue('');
  expect(screen.getByLabelText('I reviewed the restore rows and conflict policy')).not.toBeChecked();
  fireEvent.change(screen.getByLabelText('Restore conflict policy'), { target: { value: 'reject' } });
  fireEvent.click(screen.getByLabelText('I reviewed the restore rows and conflict policy'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm local restore' }));
  await act(async () => { await Promise.resolve(); });
  const confirmations = fetchMock.mock.calls.filter(([url]) => url.endsWith('/confirm'));
  expect(confirmations).toHaveLength(2);
  expect(JSON.parse(String(confirmations[0][1]?.body))).toMatchObject({ review_token: 'review-3' });
  expect(JSON.parse(String(confirmations[1][1]?.body))).toMatchObject({ preview_token: 'restore-2' });
  for (const [, options] of confirmations) expect(new Headers(options?.headers).get('X-CSRF-Token')).toBe('synthetic-session-2');
});

test('an HA rename permission rejection remains a separate domain outcome', async () => {
  const { handlers } = fixture();
  handlers.set('/tags?offset=0&limit=100', async () => reply({ tags: [{ tag_key: 'synthetic-key', ha_tag_id: '  Synthetic:Å  ',
    name: 'Synthetic tag', state: 'registered', saved_assignment: null, last_scanned: null, last_reader: null }],
  total: 1, registry_available: true, stale: false }));
  handlers.set('/tags/synthetic-key/assignment', async () => reply({ version: 0, assignment: null }));
  handlers.set('/tags/synthetic-key/name', async () => reply({ detail: { code: 'forbidden', state: 'rejected' } }, 403));
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  fireEvent.change(screen.getByLabelText('Requested HA tag name'), { target: { value: 'Requested label' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename HA tag' }));
  await act(async () => { await Promise.resolve(); });
  expect(within(screen.getByRole('region', { name: 'HA tag name' })).getByRole('alert')).toHaveTextContent('Home Assistant denied the rename');
  expect(screen.getByRole('heading', { name: 'Your tag and music manager' })).toBeInTheDocument();
  expect(screen.getByLabelText('Requested HA tag name')).toHaveValue('Requested label');
});

test('a page hidden during bootstrap cannot later accept that old authentication response', async () => {
  const { handlers } = fixture();
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  handlers.set('/session', () => pending);
  await mount();
  act(() => { window.dispatchEvent(new Event('pagehide')); });
  expect(screen.getByRole('button', { name: 'Check access again' })).toBeInTheDocument();
  handlers.delete('/session');
  await act(async () => { finish(reply({ authenticated: true, runtime: 'ingress', user_id: 'a'.repeat(32), mode: 'manage',
    csrf_token: 'old-in-flight-session', expires_at: new Date(Date.now() + 3600_000).toISOString() })); });
  expect(screen.queryByRole('heading', { name: 'Your tag and music manager' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check access again' })).toBeInTheDocument();
});
