import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';

const uri = 'spotify:album:0123456789ABCDEFGHIJKL';
const changedUri = 'spotify:playlist:ABCDEFGHIJKL0123456789';
const tagId = '  Synthetic:Å/04  ';
const tagKey = 'synthetic-key';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function fixture() {
  let probes = 0;
  const state = { user: 'a'.repeat(32), runtime: 'ingress', mode: 'manage', name: 'Original name', version: 3, savedUri: uri,
    enabled: true, shuffle: false, registry: true };
  const assignment = () => ({ tag_key: tagKey, ha_tag_id: tagId, spotify_uri: state.savedUri,
    media_type: state.savedUri.includes(':playlist:') ? 'playlist' : 'album', enabled: state.enabled, shuffle: state.shuffle,
    playback_profile_id: 'default', version: state.version, updated_at: new Date().toISOString() });
  const tag = () => ({ tag_key: tagKey, ha_tag_id: tagId, name: state.name, state: 'registered',
    saved_assignment: assignment(), last_scanned: null, last_reader: null, observed_reader: null,
    observed_at: null, local_assignment: 'enabled' });
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/session')) {
      if (options?.method === 'DELETE') return new Response(null, { status: 204 });
      probes += 1;
      return reply({ authenticated: true, runtime: state.runtime, user_id: state.runtime === 'ingress' ? state.user : null,
        mode: state.mode, csrf_token: `csrf-session-${probes}`, expires_at: new Date(Date.now() + (probes === 1 ? 1000 : 3600_000)).toISOString() });
    }
    if (url.includes('/tags/inbox?')) return reply({ tags: [tag()], total: 1, registry_available: true, stale: false,
      discovery_gap: false, assignments_available: true, updated_at: new Date().toISOString() });
    if (url.includes('/tags?')) return reply({ tags: state.registry ? [tag()] : [], total: state.registry ? 1 : 0, registry_available: state.registry, stale: false, updated_at: new Date().toISOString() });
    if (url.endsWith(`/tags/${tagKey}/assignment`)) {
      if (options?.method === 'PUT') {
        const input = JSON.parse(String(options.body)) as Record<string, unknown>;
        if (input.expected_version !== state.version) return reply({ detail: { code: 'assignment_conflict' } }, 409);
        state.savedUri = String(input.input); state.version += 1;
        state.enabled = Boolean(input.enabled); state.shuffle = Boolean(input.shuffle);
        return reply({ version: state.version, assignment: assignment() });
      }
      return reply({ version: state.version, assignment: assignment() });
    }
    if (url.endsWith(`/tags/${tagKey}/name`)) {
      if (options?.method === 'PATCH') state.name = String((JSON.parse(String(options.body)) as Record<string, unknown>).name);
      return reply({ name: state.name, state: options?.method === 'PATCH' ? 'verified' : 'current' });
    }
    if (url.includes('/assignments?')) return reply({ assignments: [assignment()], total: 1, revision: state.version });
    if (url.includes('/music/capabilities')) return reply(Object.fromEntries(['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search'].map(name => [name, 'unsupported'])));
    if (url.endsWith('/publication')) return reply({ jobs: [], pending_removals: [], actual: null, actual_stale: true, desired_version: 0, mapping_count: 0 });
    if (url.endsWith('/recovery')) return reply({ reconciliation_required: false });
    return reply({ connection: 'not_configured', services: {}, inventory_stale: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { state, fetchMock };
}
async function mount() { render(<App />); await act(async () => { await Promise.resolve(); }); }
async function expire() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.queryByRole('heading', { name: 'Your tag and music manager' })).not.toBeInTheDocument();
}
async function reopen() {
  fireEvent.click(screen.getByRole('button', { name: 'Check access again' }));
  await act(async () => { await Promise.resolve(); });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('same verified user recovers unsaved music input without any automatic mutation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { fetchMock } = fixture();
  await mount();
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: uri } });
  await expire();
  expect(screen.queryByDisplayValue(uri)).not.toBeInTheDocument();
  await reopen();
  expect(screen.getByLabelText('Spotify URI or link')).toHaveValue(uri);
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

test('recovered tag edits use exact IDs and fresh server state before a deliberate save or rename', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'View tag Original name' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Draft Spotify URI or link'), { target: { value: changedUri } });
  fireEvent.change(screen.getByLabelText('Draft media type'), { target: { value: 'playlist' } });
  fireEvent.click(screen.getByLabelText('Enabled draft'));
  fireEvent.click(screen.getByLabelText('Shuffle'));
  fireEvent.change(screen.getByLabelText('Requested HA tag name'), { target: { value: 'Requested new name' } });
  await expire();
  state.version = 4; state.name = 'Changed in HA';
  await reopen();
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  expect(within(detail).getByRole('heading', { name: 'Changed in HA' })).toBeInTheDocument();
  expect(within(detail).getByText(tagId.trim()).textContent).toBe(tagId);
  expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  expect(screen.getByLabelText('Draft media type')).toHaveValue('playlist');
  expect(screen.getByLabelText('Enabled draft')).not.toBeChecked();
  expect(screen.getByLabelText('Shuffle')).toBeChecked();
  expect(screen.getByText(/^Current saved preferences:/)).toHaveTextContent('media type album; enabled on; shuffle off; playback profile default');
  expect(screen.getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  expect(screen.getByLabelText('Requested HA tag name')).toHaveValue('Requested new name');
  expect(screen.getByRole('button', { name: 'Rename HA tag' })).toBeDisabled();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.click(screen.getByLabelText('I reviewed recovered input against the current draft'));
  fireEvent.click(screen.getByRole('button', { name: 'Save local draft' }));
  await act(async () => { await Promise.resolve(); });
  const save = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
  expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({ ha_tag_id: tagId, input: changedUri,
    expected_version: 4, media_type: 'playlist', enabled: false, shuffle: true });
  expect(new Headers(save?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-session-2');
  fireEvent.click(screen.getByRole('button', { name: 'Check HA name' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Rename HA tag' }));
  await act(async () => { await Promise.resolve(); });
  const rename = fetchMock.mock.calls.find(([, options]) => options?.method === 'PATCH');
  expect(JSON.parse(String(rename?.[1]?.body))).toMatchObject({ ha_tag_id: tagId,
    expected_name: 'Changed in HA', name: 'Requested new name' });
});

test('inventory and saved-draft editors recover their own inputs for the same exact target', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'View tag Original name' }));
  fireEvent.click(screen.getByRole('button', { name: /Edit draft/ }));
  await act(async () => { await Promise.resolve(); });
  const inventory = () => within(screen.getByRole('region', { name: 'Tag detail' }));
  const saved = () => within(screen.getByRole('region', { name: 'Saved draft detail' }));
  fireEvent.change(inventory().getByLabelText('Draft Spotify URI or link'), { target: { value: changedUri } });
  fireEvent.change(inventory().getByLabelText('Draft media type'), { target: { value: 'playlist' } });
  fireEvent.click(inventory().getByLabelText('Enabled draft'));
  fireEvent.click(saved().getByLabelText('Shuffle'));
  expect(inventory().getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  expect(saved().getByLabelText('Draft Spotify URI or link')).toHaveValue(uri);
  await expire(); state.version = 4; await reopen();
  expect(inventory().getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  expect(inventory().getByLabelText('Draft media type')).toHaveValue('playlist');
  expect(inventory().getByLabelText('Enabled draft')).not.toBeChecked();
  expect(inventory().getByLabelText('Shuffle')).not.toBeChecked();
  expect(saved().getByLabelText('Draft Spotify URI or link')).toHaveValue(uri);
  expect(saved().getByLabelText('Draft media type')).toHaveValue('album');
  expect(saved().getByLabelText('Enabled draft')).toBeChecked();
  expect(saved().getByLabelText('Shuffle')).toBeChecked();
  for (const view of [inventory(), saved()]) {
    expect(view.getByText(tagId.trim()).textContent).toBe(tagId);
    expect(view.getByLabelText('I reviewed recovered input against the current draft')).not.toBeChecked();
    expect(view.getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  }
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.click(inventory().getByLabelText('I reviewed recovered input against the current draft'));
  fireEvent.click(inventory().getByRole('button', { name: 'Save local draft' }));
  await act(async () => { await Promise.resolve(); });
  // A verified save clears only that view's pending input. The other view must
  // keep its distinct intent and compare against the newly saved server state.
  act(() => { window.dispatchEvent(new Event('pagehide')); });
  await reopen();
  expect(inventory().getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  expect(inventory().queryByLabelText('I reviewed recovered input against the current draft')).not.toBeInTheDocument();
  expect(saved().getByLabelText('Draft Spotify URI or link')).toHaveValue(uri);
  expect(saved().getByLabelText('Shuffle')).toBeChecked();
  expect(saved().getByText(/^Current saved URI:/)).toHaveTextContent(changedUri);
  expect(saved().getByText(/^Current saved preferences:/)).toHaveTextContent('media type playlist; enabled off; shuffle off');
  expect(saved().getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  const writes = fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ ha_tag_id: tagId, input: changedUri,
    media_type: 'playlist', enabled: false, shuffle: false, expected_version: 4 });
  expect(new Headers(writes[0][1]?.headers).get('X-CSRF-Token')).toBe('csrf-session-2');
});

test('inventory and onboarding recover independent requested names for the same exact target', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'View tag Original name' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add tag / unassigned inbox' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Choose discovered tag Original name' }));
  const inventory = () => within(screen.getByRole('region', { name: 'Tag detail' }));
  const onboarded = () => within(screen.getByRole('region', { name: 'Discovered tag' }));
  fireEvent.change(inventory().getByLabelText('Requested HA tag name'), { target: { value: 'Inventory requested name' } });
  fireEvent.change(onboarded().getByLabelText('Requested HA tag name'), { target: { value: 'Onboarding requested name' } });
  expect(inventory().getByLabelText('Requested HA tag name')).toHaveValue('Inventory requested name');
  expect(onboarded().getByLabelText('Requested HA tag name')).toHaveValue('Onboarding requested name');
  await expire(); state.name = 'Changed in HA'; await reopen();
  expect(inventory().getByLabelText('Requested HA tag name')).toHaveValue('Inventory requested name');
  expect(onboarded().getByLabelText('Requested HA tag name')).toHaveValue('Onboarding requested name');
  for (const view of [inventory(), onboarded()]) {
    expect(view.getByText(tagId.trim()).textContent).toBe(tagId);
    expect(view.getByRole('button', { name: 'Rename HA tag' })).toBeDisabled();
  }
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  fireEvent.click(inventory().getByRole('button', { name: 'Check HA name' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(inventory().getByRole('button', { name: 'Rename HA tag' }));
  await act(async () => { await Promise.resolve(); });
  act(() => { window.dispatchEvent(new Event('pagehide')); });
  await reopen();
  expect(inventory().getByLabelText('Requested HA tag name')).toHaveValue('Inventory requested name');
  expect(inventory().getByRole('button', { name: 'Rename HA tag' })).toBeEnabled();
  expect(onboarded().getByLabelText('Requested HA tag name')).toHaveValue('Onboarding requested name');
  expect(onboarded().getByRole('button', { name: 'Rename HA tag' })).toBeDisabled();
  fireEvent.click(onboarded().getByRole('button', { name: 'Check HA name' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(onboarded().getByRole('button', { name: 'Rename HA tag' }));
  await act(async () => { await Promise.resolve(); });
  const renames = fetchMock.mock.calls.filter(([, options]) => options?.method === 'PATCH');
  expect(renames).toHaveLength(2);
  expect(JSON.parse(String(renames[0][1]?.body))).toMatchObject({ ha_tag_id: tagId, expected_name: 'Changed in HA', name: 'Inventory requested name' });
  expect(JSON.parse(String(renames[1][1]?.body))).toMatchObject({ ha_tag_id: tagId, expected_name: 'Inventory requested name', name: 'Onboarding requested name' });
  expect(new Headers(renames[1][1]?.headers).get('X-CSRF-Token')).toBe('csrf-session-3');
});

test.each(['user', 'mode', 'runtime'] as const)('a changed %s discards another authority’s input and selection', async changed => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  await mount();
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: changedUri } });
  fireEvent.click(screen.getByRole('button', { name: 'View tag Original name' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Requested HA tag name'), { target: { value: 'Private requested name' } });
  await expire();
  if (changed === 'user') state.user = 'b'.repeat(32);
  if (changed === 'mode') state.mode = 'read_only';
  if (changed === 'runtime') state.runtime = 'standalone';
  await reopen();
  expect(screen.getByLabelText('Spotify URI or link')).toHaveValue('');
  expect(screen.queryByRole('region', { name: 'Tag detail' })).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue('Private requested name')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

test('standalone expiry preserves input but an explicit logout clears it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state } = fixture(); state.runtime = 'standalone';
  await mount();
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: changedUri } });
  await expire();
  fireEvent.change(screen.getByLabelText('App secret'), { target: { value: 'synthetic-owner-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByLabelText('Spotify URI or link')).toHaveValue(changedUri);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('App secret'), { target: { value: 'synthetic-owner-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByLabelText('Spotify URI or link')).toHaveValue('');
});

test('onboarding selection and requested name recover without restoring an old registry snapshot', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add tag / unassigned inbox' }));
  fireEvent.change(screen.getByLabelText('Discovery view'), { target: { value: 'observed' } });
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Choose discovered tag Original name' }));
  fireEvent.change(screen.getByLabelText('Requested HA tag name'), { target: { value: 'Unsaved onboarding name' } });
  await expire(); state.name = 'New registry label'; await reopen();
  expect(screen.getByLabelText('Discovery view')).toHaveValue('observed');
  const recovered = screen.getByRole('region', { name: 'Discovered tag' });
  expect(within(recovered).getByRole('heading', { name: 'New registry label' })).toBeInTheDocument();
  expect(within(recovered).getByText(tagId.trim()).textContent).toBe(tagId);
  expect(screen.getByLabelText('Requested HA tag name')).toHaveValue('Unsaved onboarding name');
  expect(screen.getByRole('button', { name: 'Rename HA tag' })).toBeDisabled();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

test('a recovered saved-draft editor survives a concurrent edit without a blind retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: /Edit draft/ }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Draft Spotify URI or link'), { target: { value: changedUri } });
  fireEvent.change(screen.getByLabelText('Draft media type'), { target: { value: 'playlist' } });
  await expire(); await reopen();
  expect(screen.getByRole('region', { name: 'Saved draft detail' })).toHaveTextContent(tagId.trim());
  expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  fireEvent.click(screen.getByLabelText('I reviewed recovered input against the current draft'));
  state.version += 1; state.enabled = false; state.shuffle = true; // Another writer changed the row after the fresh read.
  fireEvent.click(screen.getByRole('button', { name: 'Save local draft' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh current draft keeping recovered input' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  expect(screen.getByLabelText('I reviewed recovered input against the current draft')).not.toBeChecked();
  expect(screen.getByText(/^Current saved preferences:/)).toHaveTextContent('media type album; enabled off; shuffle on; playback profile default');
  expect(screen.getByLabelText('Draft media type')).toHaveValue('playlist');
  expect(screen.getByLabelText('Enabled draft')).toBeChecked();
  expect(screen.getByLabelText('Shuffle')).not.toBeChecked();
  fireEvent.click(screen.getByLabelText('I reviewed recovered input against the current draft'));
  fireEvent.click(screen.getByRole('button', { name: 'Save local draft' }));
  await act(async () => { await Promise.resolve(); });
  const saves = fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT');
  expect(saves).toHaveLength(2);
  expect(JSON.parse(String(saves[0][1]?.body)).expected_version).toBe(3);
  expect(JSON.parse(String(saves[1][1]?.body)).expected_version).toBe(4);
});

test('missing current HA details do not restore stale labels or discard the exact assignment target', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state } = fixture();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'View tag Original name' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Draft Spotify URI or link'), { target: { value: changedUri } });
  await expire(); state.registry = false; await reopen();
  expect(screen.queryByText('Original name')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Recovered tag selection' })).toHaveTextContent(tagId.trim());
  expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  expect(screen.queryByRole('button', { name: 'Rename HA tag' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save local draft' })).toBeDisabled();
});

test('an old save response cannot clear a newly verified user’s recoverable input', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { state, fetchMock } = fixture();
  const ordinary = fetchMock.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method !== 'PUT') return ordinary(url, options);
    const response = reply({}); response.json = () => pending;
    return response;
  });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'View tag Original name' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Draft Spotify URI or link'), { target: { value: uri } });
  fireEvent.click(screen.getByRole('button', { name: 'Save local draft' }));
  await act(async () => { await Promise.resolve(); });
  await expire(); state.user = 'b'.repeat(32); await reopen();
  fireEvent.click(screen.getByRole('button', { name: 'View tag Original name' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Draft Spotify URI or link'), { target: { value: changedUri } });
  await act(async () => { finish({ version: 4, assignment: { tag_key: tagKey, ha_tag_id: tagId, spotify_uri: uri,
    media_type: 'album', enabled: true, shuffle: false, playback_profile_id: 'default', version: 4, updated_at: new Date().toISOString() } }); });
  act(() => { window.dispatchEvent(new Event('pagehide')); });
  await reopen();
  expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue(changedUri);
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
});
