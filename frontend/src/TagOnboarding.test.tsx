import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TagOnboarding } from './TagOnboarding';

const tag = { tag_key: 'fixture-key', ha_tag_id: 'exact fixture', name: 'Observed fixture', last_scanned: '2026-10-21T12:00:00Z', observed_at: '2026-10-21T12:00:00Z', observed_reader: 'synthetic-reader', state: 'pending_discovery', local_assignment: 'unassigned' };
const inbox = { tags: [tag], total: 1, registry_available: true, stale: false, updated_at: '2026-10-21T12:00:00Z', discovery_gap: false, assignments_available: true };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const props = { csrf: 'csrf', manage: true, onExpired: vi.fn(), onClose: vi.fn(), onRenamed: vi.fn() };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

test('reconciles selected observed pending tag without creation and refresh failure retains stale membership honestly', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(reply(inbox)).mockResolvedValueOnce(reply({ ...inbox, tags: [{ ...tag, state: 'registered' }], discovery_gap: true }))
    .mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  render(<TagOnboarding {...props} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading discovery');
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Choose discovered tag Observed fixture' }));
  const detail = screen.getByRole('region', { name: 'Discovered tag' });
  expect(within(detail).getByRole('heading', { name: 'Observed fixture' })).toHaveFocus();
  expect(within(detail).getByRole('button', { name: 'Rename HA tag' })).toBeDisabled();
  expect(screen.getByText('synthetic-reader')).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTime(5000));
  expect(within(detail).getByText('Registered tag')).toBeInTheDocument();
  expect(within(detail).getByRole('button', { name: 'Rename HA tag' })).toBeEnabled();
  expect(screen.getByText(/Registry reconciliation recovers tags/)).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTime(5000));
  expect(screen.getByRole('alert')).toHaveTextContent('Retained registry and local membership may be stale');
  expect(within(detail).getByText(/No local assignment/)).toHaveTextContent('retained snapshot may be stale');
  expect(fetcher.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
});

test('pages complete-inventory membership, identifies prior view on failed navigation, and distinguishes disabled/unknown membership', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ ...inbox, total: 101, tags: [{ ...tag, observed_at: null, state: 'registered' }] }))
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reply({ ...inbox, tags: [{ ...tag, local_assignment: 'disabled' }] }))
    .mockResolvedValueOnce(reply({ ...inbox, assignments_available: false, tags: [{ ...tag, local_assignment: 'unknown' }] })));
  render(<TagOnboarding {...props} manage={false} />);
  expect(await screen.findByText('No scan observed by this app.')).toBeInTheDocument();
  expect(screen.getByText(/HA registry last scan/)).toHaveTextContent('Reader not observed');
  await user.click(screen.getByRole('button', { name: 'Next discoveries' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('refresh failed');
  expect(screen.getByText(/Showing previous unassigned snapshot at offset 0/)).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Discovery view'), 'observed');
  expect(await screen.findByText('Disabled local draft (still assigned)')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Refresh discovery' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('not confirmed unassigned');
  expect(screen.getByText('Local assignment membership unknown')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Choose discovered tag Observed fixture' }));
  expect(screen.getByText('Renaming requires APP_MODE=manage. Discovery is read-only.')).toBeInTheDocument();
});
