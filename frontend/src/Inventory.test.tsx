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

test('saving an off-page tag updates its saved detail from the response without replacing the editor', async () => {
  const user = userEvent.setup();
  const savedUri = 'spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ';
  let saved = assignment;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/assignment')) {
      if (options?.method === 'PUT') saved = { ...assignment, spotify_uri: savedUri, version: 2 };
      return Promise.resolve(reply({ assignment: saved, version: saved.version }));
    }
    const tags = url.includes('offset=100')
      ? [{ ...inventory.tags[0], tag_key: 'other', ha_tag_id: 'synthetic-other', name: 'Second-page tag', saved_assignment: null }]
      : [{ ...inventory.tags[0], saved_assignment: saved }];
    return Promise.resolve(reply({ ...inventory, tags, total: 101 }));
  }));
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  const input = within(detail).getByLabelText('Draft Spotify URI or link');
  await user.clear(input);
  await user.type(input, 'https://open.spotify.com/album/ZZZZZZZZZZZZZZZZZZZZZZ');
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  await screen.findByRole('button', { name: 'View tag Second-page tag' });
  expect(input).toHaveValue('https://open.spotify.com/album/ZZZZZZZZZZZZZZZZZZZZZZ');
  await user.click(within(detail).getByRole('button', { name: 'Save local draft' }));
  await within(detail).findByText(/Local draft saved/);
  expect(await within(detail).findByText(savedUri)).toBeInTheDocument();
  expect(within(detail).queryByText(assignment.spotify_uri)).not.toBeInTheDocument();
  expect(within(detail).getByLabelText('Draft Spotify URI or link')).toBe(input);
  expect(input).toHaveValue(savedUri);
  expect(screen.getByRole('button', { name: 'View tag Second-page tag' })).toBeInTheDocument();
});

test('removing an off-page assignment clears its saved detail while retaining the editor and current page', async () => {
  const user = userEvent.setup();
  let removed = false;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/assignment')) {
      if (options?.method === 'DELETE') removed = true;
      return Promise.resolve(reply({ assignment: removed ? null : assignment, version: removed ? 2 : 1 }));
    }
    const tags = url.includes('offset=100')
      ? [{ ...inventory.tags[0], tag_key: 'other', ha_tag_id: 'synthetic-other', name: 'Second-page tag', saved_assignment: null }]
      : [{ ...inventory.tags[0], saved_assignment: removed ? null : assignment }];
    return Promise.resolve(reply({ ...inventory, tags, total: 101 }));
  }));
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  const input = within(detail).getByLabelText('Draft Spotify URI or link');
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  await screen.findByRole('button', { name: 'View tag Second-page tag' });
  await user.click(within(detail).getByRole('button', { name: 'Remove local draft' }));
  await user.click(within(detail).getByRole('button', { name: 'Confirm removal' }));
  await within(detail).findByText(/Local draft removed/);
  expect(await within(detail).findByText('No saved assignment.')).toBeInTheDocument();
  expect(within(detail).queryByText(assignment.spotify_uri)).not.toBeInTheDocument();
  expect(within(detail).queryByRole('button', { name: 'Look up mapping metadata' })).not.toBeInTheDocument();
  expect(within(detail).getByLabelText('Draft Spotify URI or link')).toBe(input);
  expect(input).toHaveValue(assignment.spotify_uri);
  expect(screen.getByRole('button', { name: 'View tag Second-page tag' })).toBeInTheDocument();
});

test('malformed successful save retains the off-page saved detail and unsaved form until reconciliation', async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/assignment')) return Promise.resolve(reply(options?.method ? {} : { assignment, version: 1 }));
    const tags = url.includes('offset=100') ? [] : inventory.tags;
    return Promise.resolve(reply({ ...inventory, tags, total: 101 }));
  }));
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} onDraftChanged={changed} />);
  await user.click(await screen.findByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  const editor = within(detail).getByRole('region', { name: 'Local draft editor' });
  await user.clear(within(editor).getByLabelText('Draft Spotify URI or link'));
  await user.type(within(editor).getByLabelText('Draft Spotify URI or link'), 'spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ');
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  await user.click(within(editor).getByRole('button', { name: 'Save local draft' }));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('reconcile an uncertain outcome');
  expect(within(detail).getByText(assignment.spotify_uri)).toBeInTheDocument();
  expect(within(detail).queryByText('No saved assignment.')).not.toBeInTheDocument();
  expect(within(editor).getByLabelText('Draft Spotify URI or link')).toHaveValue('spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ');
  expect(within(editor).getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  expect(within(editor).queryByText(/Local draft saved/)).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
});

test('conflict reconciliation updates the off-page saved detail only after a valid explicit reload', async () => {
  const user = userEvent.setup();
  const newUri = 'spotify:album:YYYYYYYYYYYYYYYYYYYYYY';
  const changed = vi.fn();
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/assignment')) {
      if (options?.method) return Promise.resolve(reply({}, 409));
      reads++;
      return Promise.resolve(reply(reads === 1 ? { assignment, version: 1 } : { assignment: { ...assignment, spotify_uri: newUri, version: 2 }, version: 2 }));
    }
    return Promise.resolve(reply({ ...inventory, tags: url.includes('offset=100') ? [] : inventory.tags, total: 101 }));
  }));
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} onDraftChanged={changed} />);
  await user.click(await screen.findByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  const editor = within(detail).getByRole('region', { name: 'Local draft editor' });
  await user.clear(within(editor).getByLabelText('Draft Spotify URI or link'));
  await user.type(within(editor).getByLabelText('Draft Spotify URI or link'), 'spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ');
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  await user.click(within(editor).getByRole('button', { name: 'Save local draft' }));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('Another edit changed this draft');
  expect(within(editor).getByLabelText('Draft Spotify URI or link')).toHaveValue('spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ');
  expect(within(detail).getByText(assignment.spotify_uri)).toBeInTheDocument();
  await user.click(within(editor).getByRole('button', { name: 'Reload current draft' }));
  expect(await within(detail).findByText(newUri)).toBeInTheDocument();
  expect(within(detail).queryByText(assignment.spotify_uri)).not.toBeInTheDocument();
  expect(within(editor).getByLabelText('Draft Spotify URI or link')).toHaveValue(newUri);
  expect(within(editor).getByRole('button', { name: 'Save local draft' })).toBeEnabled();
  expect(reads).toBe(2);
  expect(changed).not.toHaveBeenCalled();
});

test.each(['malformed', 'unavailable', 'network'] as const)('a %s off-page reload retains confirmed saved detail and the unsaved form', async failure => {
  const user = userEvent.setup();
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/assignment')) {
      reads++;
      if (reads === 2) return failure === 'network' ? Promise.reject(new Error('offline')) : Promise.resolve(reply(failure === 'malformed' ? {} : { detail: 'unavailable' }, failure === 'unavailable' ? 503 : 200));
      return Promise.resolve(reply({ assignment: reads === 1 ? assignment : null, version: reads === 1 ? 1 : 2 }));
    }
    return Promise.resolve(reply({ ...inventory, tags: url.includes('offset=100') ? [] : inventory.tags, total: 101 }));
  }));
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  const editor = within(detail).getByRole('region', { name: 'Local draft editor' });
  const input = within(editor).getByLabelText('Draft Spotify URI or link');
  await user.clear(input);
  await user.type(input, 'spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ');
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  await user.click(within(editor).getByRole('button', { name: 'Reload current draft' }));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('Previous form retained');
  expect(within(detail).getByText(assignment.spotify_uri)).toBeInTheDocument();
  expect(input).toHaveValue('spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ');
  expect(within(editor).getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  await user.click(within(editor).getByRole('button', { name: 'Reload current draft' }));
  expect(await within(detail).findByText('No saved assignment.')).toBeInTheDocument();
  expect(input).toHaveValue('');
  expect(within(editor).getByRole('button', { name: 'Save local draft' })).toBeEnabled();
  expect(reads).toBe(3);
});

test.each(['save', 'remove'] as const)('an unavailable off-page %s preserves saved detail and requires reconciliation', async action => {
  const user = userEvent.setup();
  const changed = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/assignment')) return Promise.resolve(options?.method ? reply({}, 503) : reply({ assignment, version: 1 }));
    return Promise.resolve(reply({ ...inventory, tags: url.includes('offset=100') ? [] : inventory.tags, total: 101 }));
  }));
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} onDraftChanged={changed} />);
  await user.click(await screen.findByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  const editor = within(detail).getByRole('region', { name: 'Local draft editor' });
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  if (action === 'remove') {
    await user.click(within(editor).getByRole('button', { name: 'Remove local draft' }));
    await user.click(within(editor).getByRole('button', { name: 'Confirm removal' }));
  } else await user.click(within(editor).getByRole('button', { name: 'Save local draft' }));
  expect(await within(editor).findByRole('alert')).toHaveTextContent('reconcile an uncertain outcome');
  expect(within(detail).getByText(assignment.spotify_uri)).toBeInTheDocument();
  expect(within(editor).getByLabelText('Draft Spotify URI or link')).toHaveValue(assignment.spotify_uri);
  expect(within(editor).getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  if (action === 'remove') expect(within(editor).getByRole('button', { name: 'Confirm removal' })).toBeDisabled();
  expect(changed).not.toHaveBeenCalled();
});

test('validated initial assignment read updates selected saved detail without looping or overwriting later form edits', async () => {
  const user = userEvent.setup();
  const newUri = 'spotify:album:YYYYYYYYYYYYYYYYYYYYYY';
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/assignment')) { reads++; return Promise.resolve(reply({ assignment: { ...assignment, spotify_uri: newUri, version: 2 }, version: 2 })); }
    return Promise.resolve(reply({ ...inventory, tags: url.includes('offset=100') ? [] : inventory.tags, total: 101 }));
  }));
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  expect(await within(detail).findByText(newUri)).toBeInTheDocument();
  const input = within(detail).getByLabelText('Draft Spotify URI or link');
  await user.clear(input);
  await user.type(input, 'spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ');
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  expect(within(detail).getByText(newUri)).toBeInTheDocument();
  expect(input).toHaveValue('spotify:album:ZZZZZZZZZZZZZZZZZZZZZZ');
  expect(reads).toBe(1);
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
    if (url.endsWith('/assignment')) return Promise.resolve(reply({ assignment, version: 1 }));
    if (url.endsWith('/music/resolve')) return Promise.resolve(options?.body && renameCalls > 0 ? reply({ ...goodMetadata, item: null, state: 'unavailable', error: 'unavailable', last_success_at: null }, 503) : reply(goodMetadata));
    return Promise.resolve(reply({ ...inventory, stale: false, tags: [{ ...inventory.tags[0], state: 'registered' }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<Inventory csrf="csrf" manage onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  const detail = screen.getByRole('region', { name: 'Tag detail' });
  await user.clear(within(detail).getByLabelText('Draft Spotify URI or link'));
  await user.type(within(detail).getByLabelText('Draft Spotify URI or link'), 'spotify:playlist:ABCDEFGHIJKL0123456789');
  await user.click(within(detail).getByRole('button', { name: 'Look up mapping metadata' }));
  await within(detail).findByText('Fixture music title');
  await user.clear(within(detail).getByLabelText('Requested HA tag name')); await user.type(within(detail).getByLabelText('Requested HA tag name'), 'New HA label');
  await user.click(within(detail).getByRole('button', { name: 'Rename HA tag' }));
  expect(await within(detail).findByRole('alert')).toHaveTextContent('Home Assistant denied');
  await user.click(within(detail).getByRole('button', { name: 'Refresh mapping metadata' }));
  expect(await within(detail).findByText(/Music lookup: unavailable/)).toBeInTheDocument();
  await user.click(within(detail).getByRole('button', { name: 'Retry HA rename' }));
  expect(await within(detail).findByText(/HA rename verified/)).toBeInTheDocument();
  expect(within(detail).getByLabelText('Draft Spotify URI or link')).toHaveValue('spotify:playlist:ABCDEFGHIJKL0123456789');
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
