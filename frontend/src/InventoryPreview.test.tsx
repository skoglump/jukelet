import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { InventoryPreview } from './InventoryPreview';

const inventory = { tags: [{ tag_key: 'stable', ha_tag_id: '  Å/01  ', name: 'Synthetic tag', state: 'pending_discovery', last_scanned: null, last_reader: null }], total: 1, registry_available: true, stale: true, updated_at: '2026-10-19T12:00:00Z' };
const report = { source: 'configured', fingerprint: 'a'.repeat(64), registry_stale: true, registry_updated_at: null,
  counts: { mappings: 1, accepted: 0, rejected: 1, matched: 1, unassigned: 0, orphaned: 0 }, warnings: ['source_changed_review_again'],
  rows: [{ row: 1, ha_tag_id: '  Å/01  ', accepted: false, registry_state: 'matched', media_content_type: 'track', media_content_id: 'spotify:track:synthetic', diagnostics: ['unsupported_media_type'] }],
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('shows pending exact IDs, stale status and rejection diagnostics; exports the normalized report', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inventory)).mockResolvedValueOnce(reply(report));
  vi.stubGlobal('fetch', fetcher);
  const create = vi.fn().mockReturnValue('blob:synthetic');
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  render(<InventoryPreview csrf="synthetic-csrf" onExpired={vi.fn()} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading tag inventory');
  expect(await screen.findByText('Synthetic tag')).toBeInTheDocument();
  expect(screen.getByText(/Pending registry discovery/)).toBeInTheDocument();
  expect(screen.getByText('Inventory is stale or has not been loaded.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview configured source' }));
  expect(await screen.findByText('Only albums and playlists are supported')).toBeInTheDocument();
  expect(screen.getByText(/Source changed since/)).toBeInTheDocument();
  const ids = screen.getAllByText((_, node) => node?.tagName === 'CODE' && node.textContent === '  Å/01  ');
  expect(ids).toHaveLength(2);
  expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': 'synthetic-csrf' } });
  fireEvent.click(screen.getByRole('button', { name: 'Download preview report' }));
  expect(create).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
});

test('uploads a file, sends the previous source fingerprint and preserves the prior report on errors', async () => {
  const uploaded = { ...report, source: 'upload' };
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ ...inventory, tags: [], total: 0, stale: false }))
    .mockResolvedValueOnce(reply(uploaded)).mockResolvedValueOnce(reply({ detail: 'invalid_source' }, 422));
  vi.stubGlobal('fetch', fetcher);
  render(<InventoryPreview csrf="synthetic-csrf" onExpired={vi.fn()} />);
  expect(await screen.findByText('No registered tags.')).toBeInTheDocument();
  const file = new File(['variables: {tags: {}}'], 'synthetic.yaml', { type: 'text/yaml' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('variables: {tags: {}}').buffer });
  fireEvent.change(screen.getByLabelText('JSON or YAML file (up to 1 MiB)'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview file' }));
  expect(await screen.findByText('Only albums and playlists are supported')).toBeInTheDocument();
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ source: 'upload', format: 'yaml', content: 'variables: {tags: {}}' });
  fireEvent.click(screen.getByRole('button', { name: 'Preview file' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Previous report retained');
  expect(JSON.parse(fetcher.mock.calls[2][1].body).expected_fingerprint).toBe('a'.repeat(64));
  expect(screen.getByText('Only albums and playlists are supported')).toBeInTheDocument();
});

test('poll failure keeps last tags visibly stale, cancels on unmount and expires unauthorized sessions', async () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inventory)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reply({}, 401));
  vi.stubGlobal('fetch', fetcher);
  const rendered = render(<InventoryPreview csrf="csrf" onExpired={expired} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(screen.getByRole('alert')).toHaveTextContent('Displayed tags may be stale');
  expect(screen.getByText('Synthetic tag')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(expired).toHaveBeenCalledOnce();
  rendered.unmount();
  expect(fetcher.mock.calls[2][1].signal.aborted).toBe(true);
});

test('browses a tag by keyboard and filters preview membership without treating rejected rows as unassigned', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ ...inventory, stale: false, tags: [...inventory.tags,
    { ...inventory.tags[0], tag_key: 'empty', ha_tag_id: 'synthetic-empty', name: 'Empty fixture' }], total: 2 }))
    .mockResolvedValueOnce(reply(report)));
  render(<InventoryPreview csrf="csrf" onExpired={vi.fn()} />);
  const filter = await screen.findByLabelText('Mapping filter');
  expect(screen.getByText(/Mapping status unknown/)).toBeInTheDocument();
  expect(within(filter).getByRole('option', { name: 'Unassigned in preview' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Preview configured source' }));
  await screen.findByText('Only albums and playlists are supported');
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
  expect(within(detail).getByText(/Rejected mapping/)).toBeInTheDocument();
  expect(within(detail).getByText('spotify:track:synthetic')).toBeInTheDocument();
  await user.click(within(detail).getByRole('button', { name: 'Back to tag list' }));
  expect(entry).toHaveFocus();
  expect(screen.getByText(/Filters apply to this page/)).toBeInTheDocument();
});

const albumUri = 'spotify:album:0123456789ABCDEFGHIJKL';
const recognized = { ...report, warnings: [], rows: [{ ...report.rows[0], accepted: true, name: 'Source label', media_content_type: 'album', media_content_id: albumUri, diagnostics: [] }] };
const goodMetadata = { uri: albumUri, item: { uri: albumUri, media_type: 'album', title: 'Fixture music title', subtitle: 'Fixture artist', artwork_url: 'https://i.scdn.co/image/synthetic' },
  items: [], total: null, next_offset: null, state: 'fresh', error: null, retry_after: null, last_success_at: new Date().toISOString(), last_attempt_at: new Date().toISOString() };

test('explicit mapping metadata preserves the exact mapping, title and artwork through upstream and network failures', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inventory)).mockResolvedValueOnce(reply(recognized))
    .mockResolvedValueOnce(reply(goodMetadata)).mockResolvedValueOnce(reply({ ...goodMetadata, item: null, state: 'unavailable', error: 'unauthorized', last_success_at: null }, 503))
    .mockRejectedValueOnce(new Error('Network unavailable'));
  vi.stubGlobal('fetch', fetcher);
  render(<InventoryPreview csrf="csrf" onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'Preview configured source' }));
  await screen.findByLabelText('Preview report');
  await user.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  expect(fetcher).toHaveBeenCalledTimes(2); // No automatic metadata lookup for the page or detail.
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
  expect(screen.getByLabelText('Preview report')).toHaveTextContent(albumUri);
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
    { ...inventory.tags[0], tag_key: 'other', ha_tag_id: 'synthetic-other', name: 'Other fixture' }] }))
    .mockResolvedValueOnce(reply(recognized)).mockReturnValueOnce(pending);
  vi.stubGlobal('fetch', fetcher);
  render(<InventoryPreview csrf="csrf" onExpired={expired} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'Preview configured source' }));
  await screen.findByLabelText('Preview report');
  await user.click(screen.getByRole('button', { name: 'View tag Synthetic tag' }));
  await user.click(screen.getByRole('button', { name: 'Look up mapping metadata' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading mapping metadata');
  await user.click(screen.getByRole('button', { name: 'View tag Other fixture' }));
  expect(fetcher.mock.calls[2][1].signal.aborted).toBe(true);
  await act(async () => { finish(reply({}, 401)); });
  expect(expired).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'Tag detail' })).toHaveTextContent('Unassigned in this preview');
  expect(screen.queryByText('Fixture music title')).not.toBeInTheDocument();
});

test('page filters never hide pagination and a failed next page identifies the retained page', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ ...inventory, total: 101 })).mockRejectedValueOnce(new Error('offline')));
  render(<InventoryPreview csrf="csrf" onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.type(screen.getByLabelText('Search this tag page'), 'no fixture matches');
  expect(screen.getByText('No tags match the filters on this page.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Next tags' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Displayed tags may be stale');
  expect(screen.getByText(/Displaying previous page at offset 0/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous tags' })).toBeEnabled();
});

test('metadata refresh loading is distinct from failure and retains the source preview and last good metadata', async () => {
  const user = userEvent.setup();
  let finish: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(inventory)).mockResolvedValueOnce(reply(recognized))
    .mockResolvedValueOnce(reply(goodMetadata)).mockReturnValueOnce(pending));
  render(<InventoryPreview csrf="csrf" onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'Preview configured source' }));
  await screen.findByLabelText('Preview report');
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
  expect(screen.getByLabelText('Preview report')).toHaveTextContent(albumUri);
  await act(async () => { finish(reply({ ...goodMetadata, item: null, state: 'unavailable', error: 'unavailable', last_success_at: null }, 503)); });
  expect(within(detail).queryByText(/Loading mapping metadata/)).not.toBeInTheDocument();
  expect(within(detail).getByText(/Metadata: stale/)).toBeInTheDocument();
  expect(within(detail).getByText(/Music lookup: unavailable/)).toBeInTheDocument();
  expect(within(detail).getByText('Fixture music title')).toBeInTheDocument();
  expect(within(detail).getByRole('img', { name: 'Artwork for Fixture music title' })).toBeInTheDocument();
  expect(screen.getByLabelText('Preview report')).toHaveTextContent(albumUri);
});

test('opens the onboarding inbox by keyboard without discarding the mapping report', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(inventory)).mockResolvedValueOnce(reply(report))
    .mockResolvedValueOnce(reply({ ...inventory, assignments_available: true, tags: [{ ...inventory.tags[0], observed_at: null, local_assignment: 'unassigned' }] })));
  render(<InventoryPreview csrf="csrf" onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'Preview configured source' }));
  await screen.findByLabelText('Preview report');
  const add = screen.getByRole('button', { name: 'Add tag / unassigned inbox' });
  add.focus(); await user.keyboard('{Enter}');
  const inbox = screen.getByRole('region', { name: 'Tag onboarding' });
  expect(within(inbox).getByRole('heading', { name: 'Add tag and unassigned inbox' })).toHaveFocus();
  expect(await within(inbox).findByText('No local assignment')).toBeInTheDocument();
  expect(within(inbox).getByText('No scan observed by this app.')).toBeInTheDocument();
  expect(screen.getByLabelText('Preview report')).toHaveTextContent('spotify:track:synthetic');
  await user.click(within(inbox).getByRole('button', { name: 'Close onboarding' }));
  expect(add).toHaveFocus();
});

test('rename keeps unsaved assignment form, mapping URI, report and last good metadata through failure and retry', async () => {
  const user = userEvent.setup();
  let renameCalls = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/name')) {
      renameCalls++;
      return Promise.resolve(renameCalls === 1 ? reply({ detail: { code: 'forbidden', state: 'rejected' } }, 403) : reply({ state: 'verified', name: 'New HA label' }));
    }
    if (url.endsWith('/assignment')) return Promise.resolve(reply({ assignment: null, version: 0 }));
    if (url.endsWith('/imports/preview')) return Promise.resolve(reply(recognized));
    if (url.endsWith('/music/resolve')) return Promise.resolve(options?.body && renameCalls > 0 ? reply({ ...goodMetadata, item: null, state: 'unavailable', error: 'unavailable', last_success_at: null }, 503) : reply(goodMetadata));
    return Promise.resolve(reply({ ...inventory, stale: false, tags: [{ ...inventory.tags[0], state: 'registered' }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<InventoryPreview csrf="csrf" manage onExpired={vi.fn()} />);
  await screen.findByText('Synthetic tag');
  await user.click(screen.getByRole('button', { name: 'Preview configured source' }));
  await screen.findByLabelText('Preview report');
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
  expect(screen.getByLabelText('Preview report')).toHaveTextContent(albumUri);
  expect(fetcher.mock.calls.filter(([url, options]) => url.endsWith('/assignment') && options?.method && options.method !== 'GET')).toHaveLength(0);
});
