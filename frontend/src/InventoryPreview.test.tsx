import { act, fireEvent, render, screen } from '@testing-library/react';
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
