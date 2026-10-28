import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { Inventory } from './Inventory';

const assignment = { tag_key: 'stable', ha_tag_id: '  Å/01  ', spotify_uri: 'spotify:album:0123456789ABCDEFGHIJKL', media_type: 'album', enabled: false, shuffle: false, playback_profile_id: 'default', version: 1, updated_at: '2026-10-28T00:00:00Z' };
const inventory = { tags: [{ tag_key: 'stable', ha_tag_id: '  Å/01  ', name: 'Synthetic tag', saved_assignment: assignment, state: 'pending_discovery', last_scanned: null, last_reader: null }], total: 1, registry_available: true, stale: true, updated_at: '2026-10-19T12:00:00Z' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('poll failure keeps last tags visibly stale, cancels on unmount and expires unauthorized sessions', async () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inventory)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reply({}, 401));
  vi.stubGlobal('fetch', fetcher);
  const rendered = render(<Inventory csrf="csrf" onExpired={expired} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(screen.getByRole('alert')).toHaveTextContent('Displayed tags may be stale');
  expect(screen.getByText('Synthetic tag')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(expired).toHaveBeenCalledOnce();
  rendered.unmount();
  expect(fetcher.mock.calls[2][1].signal.aborted).toBe(true);
});

test('browses a tag by keyboard and filters saved membership including disabled assignments without an import report', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ ...inventory, stale: false, tags: [...inventory.tags,
    { ...inventory.tags[0], tag_key: 'empty', ha_tag_id: 'synthetic-empty', name: 'Empty fixture', saved_assignment: null }], total: 2 })));
  render(<Inventory csrf="csrf" onExpired={vi.fn()} />);
  const filter = await screen.findByLabelText('Mapping filter');
  expect(screen.getByText(/Filters describe saved assignments/)).toBeInTheDocument();
  expect(screen.queryByText('Legacy mapping preview')).not.toBeInTheDocument();
  expect(within(filter).getByRole('option', { name: 'No saved assignment' })).toBeEnabled();
  await user.selectOptions(filter, 'unassigned');
  expect(screen.queryByRole('button', { name: 'View tag Synthetic tag' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View tag Empty fixture' })).toBeInTheDocument();
  await user.selectOptions(filter, 'assigned');
  const entry = screen.getByRole('button', { name: 'View tag Synthetic tag' });
  entry.focus();
  await user.keyboard('{Enter}');
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  expect(within(detail).getByRole('heading', { name: 'Synthetic tag' })).toHaveFocus();
  expect(within(detail).getByText('HA tag label')).toBeInTheDocument();
  expect(within(detail).getByText(/Saved assignment/)).toBeInTheDocument();
  expect(within(detail).getByText('spotify:album:0123456789ABCDEFGHIJKL')).toBeInTheDocument();
  await user.click(within(detail).getByRole('button', { name: 'Back to tag list' }));
  expect(entry).toHaveFocus();
  expect(screen.getByText(/Filters apply to this page/)).toBeInTheDocument();
});

const albumUri = 'spotify:album:0123456789ABCDEFGHIJKL';
const goodMetadata = { uri: albumUri, item: { uri: albumUri, media_type: 'album', title: 'Fixture music title', subtitle: 'Fixture artist', artwork_url: 'https://i.scdn.co/image/synthetic' },
  items: [], total: null, next_offset: null, state: 'fresh', error: null, retry_after: null, last_success_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() };

test('explicit mapping metadata preserves the exact mapping, title and artwork through upstream and network failures', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inventory))
    .mockResolvedValueOnce(reply(goodMetadata)).mockResolvedValueOnce(reply({ ...goodMetadata, item: null, state: 'unavailable', error: 'unauthorized', last_success_at: null }, 503))
    .mockRejectedValueOnce(new Error('Network unavailable'));
  vi.stubGlobal('fetch', fetcher);
  render(<Inventory csrf="csrf" onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  expect(fetcher).toHaveBeenCalledTimes(1); // No automatic metadata lookup for the page or detail.
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  await user.click(within(detail).getByRole('button', { name: 'Look up mapping metadata' }));
  expect(await within(detail).findByText('Fixture music title')).toBeInTheDocument();
  await user.click(within(detail).getByRole('button', { name: 'Refresh mapping metadata' }));
  expect(await within(detail).findByText(/Music lookup: unauthorized/)).toBeInTheDocument();
  expect(within(detail).getByText(/Metadata: stale/)).toBeInTheDocument();
  expect(within(detail).getByRole('img', { name: 'Artwork for Fixture music title' })).toBeInTheDocument();
  await user.click(within(detail).getByRole('button', { name: 'Refresh mapping metadata' }));
  expect(await within(detail).findByRole('alert')).toHaveTextContent('Mapping retained');
  expect(within(detail).getByText('Fixture music title')).toBeInTheDocument();
  expect(within(detail).getAllByText(albumUri)).toHaveLength(2);
  await user.click(within(detail).getByRole('button', { name: 'Back to tag list' }));
  await user.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  expect(within(screen.getByRole('region', { name: 'Tag detail' })).getByText(/Metadata: stale/)).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Tag detail' })).getByText(/network unavailable/)).toBeInTheDocument();
  await user.type(screen.getByLabelText('Search this tag page'), 'Fixture music title');
  expect(screen.getByRole('button', { name: 'View tag Synthetic tag' })).toBeInTheDocument();
});

test('aborts and ignores late metadata after selecting another tag', async () => {
  const user = userEvent.setup();
  let finish: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const expired = vi.fn();
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ ...inventory, tags: [...inventory.tags,
    { ...inventory.tags[0], tag_key: 'other', ha_tag_id: 'synthetic-other', name: 'Other fixture', saved_assignment: null }] }))
    .mockReturnValueOnce(pending);
  vi.stubGlobal('fetch', fetcher);
  render(<Inventory csrf="csrf" onExpired={expired} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  await user.click(screen.getByRole('button', { name: 'Look up mapping metadata' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading mapping metadata');
  await user.click(screen.getByRole('button', { name: 'View tag Other fixture' }));
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async () => { finish(reply({}, 401)); });
  expect(expired).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'Tag detail' })).toHaveTextContent('No saved assignment');
  expect(screen.queryByText('Fixture music title')).not.toBeInTheDocument();
});

test('page filters never hide pagination and a failed next page identifies the retained page', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ ...inventory, total: 101 })).mockRejectedValueOnce(new Error('offline')));
  render(<Inventory csrf="csrf" onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.type(screen.getByLabelText('Search this tag page'), 'no fixture matches');
  expect(screen.getByText('No tags match the filters on this page.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Displayed tags may be stale');
  expect(screen.getByText(/Displaying previous page at offset 0/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous tags' })).toBeEnabled();
});

test('metadata refresh loading is distinct from failure and retains the saved assignment and last good metadata', async () => {
  const user = userEvent.setup();
  let finish: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(inventory))
    .mockResolvedValueOnce(reply(goodMetadata)).mockReturnValueOnce(pending));
  render(<Inventory csrf="csrf" onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  await user.click(within(detail).getByRole('button', { name: 'Look up mapping metadata' }));
  await within(detail).findByText('Fixture music title');
  await user.click(within(detail).getByRole('button', { name: 'Refresh mapping metadata' }));
  expect(within(detail).getByRole('status')).toHaveTextContent('Loading mapping metadata');
  expect(within(detail).getByRole('button', { name: 'Looking up mapping…' })).toBeDisabled();
  expect(within(detail).queryByRole('alert')).not.toBeInTheDocument();
  expect(within(detail).getByText(/Metadata: fresh/)).toBeInTheDocument();
  expect(within(detail).getByRole('img', { name: 'Artwork for Fixture music title' })).toBeInTheDocument();
  await act(async () => { finish(reply({ ...goodMetadata, item: null, state: 'unavailable', error: 'unavailable', last_success_at: null }, 503)); });
  expect(within(detail).queryByText(/Loading mapping metadata/)).not.toBeInTheDocument();
  expect(within(detail).getByText(/Metadata: stale/)).toBeInTheDocument();
  expect(within(detail).getByText(/Music lookup: unavailable/)).toBeInTheDocument();
  expect(within(detail).getByText('Fixture music title')).toBeInTheDocument();
  expect(within(detail).getByRole('img', { name: 'Artwork for Fixture music title' })).toBeInTheDocument();
});

test('opens the onboarding inbox by keyboard without discarding the mapping report', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(inventory))
    .mockResolvedValueOnce(reply({ ...inventory, assignments_available: true, tags: [{ ...inventory.tags[0], observed_at: null, local_assignment: 'unassigned' }] })));
  render(<Inventory csrf="csrf" onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  const add = screen.getByRole('button', { name: 'Add tag / unassigned inbox' });
  add.focus(); await user.keyboard('{Enter}');
  const inbox = screen.getByRole('region', { name: 'Tag onboarding' });
  expect(within(inbox).getByRole('heading', { name: 'Add tag and unassigned inbox' })).toHaveFocus();
  expect(await within(inbox).findByText('No local assignment')).toBeInTheDocument();
  expect(within(inbox).getByText('No scan observed by this app.')).toBeInTheDocument();
  await user.click(within(inbox).getByRole('button', { name: 'Close onboarding' }));
  expect(add).toHaveFocus();
});

test('rename keeps unsaved assignment form, mapping URI, saved assignment and last good metadata through failure and retry', async () => {
  const user = userEvent.setup();
  let renameCalls = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/name')) {
      renameCalls++;
      return Promise.resolve(renameCalls === 1 ? reply({ detail: { code: 'forbidden', state: 'rejected' } }, 403) : reply({ state: 'verified', name: 'New HA label' }));
    }
    if (url.endsWith('/assignment')) return Promise.resolve(reply({ assignment: null, version: 0 }));
    if (url.endsWith('/music/resolve')) return Promise.resolve(options?.body && renameCalls > 0 ? reply({ ...goodMetadata, item: null, state: 'unavailable', error: 'unavailable', last_success_at: null }, 503) : reply(goodMetadata));
    return Promise.resolve(reply({ ...inventory, stale: false, tags: [{ ...inventory.tags[0], state: 'registered' }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  await user.type(within(detail).getByLabelText('Draft Spotify URI or link'), albumUri);
  await user.click(within(detail).getByRole('button', { name: 'Look up mapping metadata' }));
  await within(detail).findByText('Fixture music title');
  await user.clear(within(detail).getByLabelText('Requested HA tag name')); await user.type(within(detail).getByLabelText('Requested HA tag name'), 'New HA label');
  await user.click(within(detail).getByRole('button', { name: 'Rename HA tag' }));
  expect(await within(detail).findByRole('alert')).toHaveTextContent('Home Assistant denied');
  await user.click(within(detail).getByRole('button', { name: 'Refresh mapping metadata' }));
  expect(await within(detail).findByText(/Music lookup: unavailable/)).toBeInTheDocument();
  await user.click(within(detail).getByRole('button', { name: 'Retry HA rename' }));
  expect(await within(detail).findByText(/HA rename verified/)).toBeInTheDocument();
  expect(within(detail).getByLabelText('Draft Spotify URI or link')).toHaveValue(albumUri);
  expect(within(detail).getByRole('img', { name: 'Artwork for Fixture music title' })).toBeInTheDocument();
  expect(within(detail).getByText('Fixture music title')).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url, options]) => url.endsWith('/assignment') && options?.method && options.method !== 'GET')).toHaveLength(0);
});


test('malformed saved membership never becomes unassigned and retains the last good page', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inventory)).mockResolvedValueOnce(reply({ ...inventory, tags: [{ ...inventory.tags[0], saved_assignment: undefined }] }));
  vi.stubGlobal('fetch', fetcher);
  render(<Inventory csrf="csrf" onExpired={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(screen.getByRole('alert')).toHaveTextContent('Displayed tags may be stale');
  expect(screen.getByText('Has saved assignment', { selector: 'p' })).toBeInTheDocument();
  expect(screen.getByText(assignment.spotify_uri)).toBeInTheDocument();
});
