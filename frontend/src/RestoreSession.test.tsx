import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture() {
  let probes = 0; let previews = 0;
  const state = { user: 'a'.repeat(32), runtime: 'ingress', mode: 'manage' };
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/session')) {
      if (options?.method === 'DELETE') return new Response(null, { status: 204 });
      probes += 1;
      return reply({ authenticated: true, runtime: state.runtime, user_id: state.runtime === 'ingress' ? state.user : null,
        mode: state.mode, csrf_token: `csrf-session-${probes}`, expires_at: new Date(Date.now() + (probes === 1 ? 1000 : 3600_000)).toISOString() });
    }
    if (url.endsWith('/restores/preview')) return reply({ preview_token: `synthetic-preview-${++previews}`,
      local_revision: 3, accepted: 1, rejected: 0, conflicts: 0,
      rows: [{ row: 1, source: { ha_tag_id: '  Synthetic:Å  ' }, accepted: true, conflict: false, diagnostics: [] }] });
    if (url.endsWith('/restores/confirm')) return reply({ restored: 1, skipped: 0 });
    if (url.includes('/tags?')) return reply({ tags: [], total: 0, registry_available: true, stale: false });
    if (url.includes('/assignments?')) return reply({ assignments: [], total: 0, revision: 0 });
    if (url.includes('/music/capabilities')) return reply(Object.fromEntries(['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search'].map(name => [name, 'unsupported'])));
    if (url.endsWith('/publication')) return reply({ jobs: [], pending_removals: [], actual: null, actual_stale: true, desired_version: 0, mapping_count: 0 });
    if (url.endsWith('/recovery')) return reply({ reconciliation_required: false });
    return reply({ connection: 'not_configured', services: {}, inventory_stale: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { state, fetchMock };
}
function fileSelection() {
  const file = new File(['{}'], 'synthetic-export.json', { type: 'application/json' });
  file.arrayBuffer = async () => new TextEncoder().encode('{}').buffer;
  fireEvent.change(screen.getByLabelText('Logical export JSON file'), { target: { files: [file] } });
  return file;
}
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function mount() { render(<App />); await flush(); }
async function expire() { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); }
async function reopen() { fireEvent.click(screen.getByRole('button', { name: 'Check access again' })); await flush(); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('same user retains the selected file but needs a new preview, policy and confirmation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { fetchMock } = fixture();
  await mount(); fileSelection();
  fireEvent.click(screen.getByRole('button', { name: 'Preview restore' })); await flush();
  fireEvent.change(screen.getByLabelText('Restore conflict policy'), { target: { value: 'replace' } });
  fireEvent.click(screen.getByLabelText('I reviewed the restore rows and conflict policy'));
  expect(screen.getByRole('button', { name: 'Confirm local restore' })).toBeEnabled();
  await expire();
  expect(screen.queryByText('synthetic-export.json')).not.toBeInTheDocument();
  await reopen();
  expect(screen.getByText('synthetic-export.json')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview restore' })).toBeEnabled();
  expect(screen.queryByRole('region', { name: 'Restore preview' })).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/restores/preview'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Preview restore' })); await flush();
  expect(screen.getByLabelText('Restore conflict policy')).toHaveValue('');
  expect(screen.getByLabelText('I reviewed the restore rows and conflict policy')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Confirm local restore' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Restore conflict policy'), { target: { value: 'reject' } });
  fireEvent.click(screen.getByLabelText('I reviewed the restore rows and conflict policy'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm local restore' })); await flush();
  const confirmed = fetchMock.mock.calls.filter(([url]) => url.endsWith('/restores/confirm'));
  expect(confirmed).toHaveLength(1);
  expect(JSON.parse(String(confirmed[0][1]?.body))).toMatchObject({ preview_token: 'synthetic-preview-2', conflict_policy: 'reject' });
  expect(new Headers(confirmed[0][1]?.headers).get('X-CSRF-Token')).toBe('csrf-session-2');
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

test('cancelling a pending file read prevents its later preview request and preserves a fresh review', async () => {
  const { fetchMock } = fixture();
  await mount();
  const file = fileSelection();
  let finish!: (value: ArrayBuffer) => void;
  file.arrayBuffer = () => new Promise(resolve => { finish = resolve; });
  fireEvent.click(screen.getByRole('button', { name: 'Preview restore' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel restore preview' }));
  expect(screen.queryByRole('region', { name: 'Restore preview' })).not.toBeInTheDocument();
  file.arrayBuffer = async () => new TextEncoder().encode('{}').buffer;
  fireEvent.click(screen.getByRole('button', { name: 'Preview restore' })); await flush();
  fireEvent.change(screen.getByLabelText('Restore conflict policy'), { target: { value: 'reject' } });
  fireEvent.click(screen.getByLabelText('I reviewed the restore rows and conflict policy'));
  await act(async () => { finish(new TextEncoder().encode('{}').buffer); });
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/restores/preview'))).toHaveLength(1);
  expect(screen.getByLabelText('I reviewed the restore rows and conflict policy')).toBeChecked();
  expect(screen.getByRole('button', { name: 'Confirm local restore' })).toBeEnabled();
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/restores/confirm'))).toBe(false);
});

test.each(['user', 'mode', 'runtime'] as const)('a changed %s cannot recover the previous authority’s file', async changed => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  await mount(); fileSelection(); await expire();
  if (changed === 'user') state.user = 'b'.repeat(32);
  if (changed === 'mode') state.mode = 'read_only';
  if (changed === 'runtime') state.runtime = 'standalone';
  await reopen();
  expect(screen.queryByText('synthetic-export.json')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview restore' })).toBeDisabled();
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/restores/'))).toBe(false);
});

test('standalone logout discards the selected export', async () => {
  const { state } = fixture(); state.runtime = 'standalone';
  await mount(); fileSelection();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); await flush();
  fireEvent.change(screen.getByLabelText('App secret'), { target: { value: 'synthetic-owner-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' })); await flush();
  expect(screen.queryByText('synthetic-export.json')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview restore' })).toBeDisabled();
});

test('clearing the selected export removes its recovery state without a request', async () => {
  const { fetchMock } = fixture();
  await mount(); fileSelection();
  fireEvent.click(screen.getByRole('button', { name: 'Clear selected export' }));
  expect(screen.queryByText('synthetic-export.json')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Logical export JSON file')).toHaveFocus();
  act(() => { window.dispatchEvent(new Event('pagehide')); }); await reopen();
  expect(screen.queryByText('synthetic-export.json')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview restore' })).toBeDisabled();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

test('a cancelled preview response cannot replace a newer explicitly reviewed report', async () => {
  const { fetchMock } = fixture();
  const ordinary = fetchMock.getMockImplementation()!;
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  let first = true;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/restores/preview') && first) { first = false; return pending; }
    return ordinary(url, options);
  });
  await mount(); fileSelection();
  fireEvent.click(screen.getByRole('button', { name: 'Preview restore' })); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel restore preview' }));
  expect(screen.getByRole('button', { name: 'Preview restore' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Preview restore' })); await flush();
  fireEvent.change(screen.getByLabelText('Restore conflict policy'), { target: { value: 'reject' } });
  fireEvent.click(screen.getByLabelText('I reviewed the restore rows and conflict policy'));
  await act(async () => { finish(reply({ preview_token: 'cancelled-old-token', accepted: 1, rejected: 0, conflicts: 0, local_revision: 3,
    rows: [{ row: 1, source: { ha_tag_id: 'cancelled-old-row' }, accepted: true, conflict: false, diagnostics: [] }] })); });
  expect(screen.getByLabelText('I reviewed the restore rows and conflict policy')).toBeChecked();
  expect(screen.queryByText(/cancelled-old-row/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm local restore' })); await flush();
  const confirmed = fetchMock.mock.calls.filter(([url]) => url.endsWith('/restores/confirm'));
  expect(confirmed).toHaveLength(1);
  expect(JSON.parse(String(confirmed[0][1]?.body)).preview_token).toBe('synthetic-preview-1');
});
