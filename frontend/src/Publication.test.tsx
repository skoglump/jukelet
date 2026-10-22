import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Publication, type PublicationStatus } from './Publication';

const status: PublicationStatus = {
  publisher_id: '00000000-0000-4000-8000-000000000030', desired_version: 3, desired_checksum: 'a'.repeat(64), mapping_count: 1,
  active_revision: 2, active_checksum: 'b'.repeat(64), active_desired_version: 2, automatic_enabled: false, healthy: true,
  reconciliation_required: false, verified: false, actual: { publisher_id: '00000000-0000-4000-8000-000000000030', active_revision: 2, active_checksum: 'b'.repeat(64), persistence: 'healthy', dispatch_enabled: false },
  actual_stale: false, checked_at: '2026-10-22T12:00:00Z', error: null, shuffle_conflict: false,
  pending_removals: ['  Synthetic:Å  '], playback_verified: null, jobs: [],
};
const props = { csrf: 'synthetic-csrf', manage: true, revision: 0, onExpired: () => undefined };
const reply = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('distinguishes saved, pending removal, dispatch and independently unknown playback', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(status)));
  render(<Publication {...props} />);
  await screen.findByText(/Saved app revision: 3/);
  expect(screen.getByText(/prior HA mapping may still play/)).toBeInTheDocument();
  expect(screen.getByText(/Dispatch: disabled in HA/)).toHaveTextContent('Playback: independently unverified');
  expect(screen.getByText(/Pending or unverified/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review migration opt-in' })).toBeDisabled();
  expect(screen.getByText('Synthetic:Å').textContent).toBe('  Synthetic:Å  ');
});

it('requires content-bound empty confirmation and never presents queue acknowledgment as success', async () => {
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => { void _options; return reply(url.endsWith('/review') ? { action: 'publish', review_token: 'synthetic-review', desired_version: 3, checksum: 'a'.repeat(64), mapping_count: 0, empty: true, mappings: [], shuffle_conflict: false } : status); });
  vi.stubGlobal('fetch', fetchMock);
  render(<Publication {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review snapshot publication' }));
  expect(await screen.findByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus();
  const confirm = screen.getByRole('button', { name: 'Confirm snapshot publication' });
  fireEvent.click(screen.getByLabelText('I reviewed this exact snapshot and its preferences'));
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I explicitly confirm this empty snapshot/));
  fireEvent.click(confirm);
  await screen.findByText(/Immutable snapshot queued/);
  expect(screen.queryByText('Published: exact saved content verified active in HA.')).not.toBeInTheDocument();
  expect(JSON.parse((fetchMock.mock.calls.find(call => call[0].endsWith('/confirm')) as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ confirmed: true, confirm_empty: true });
});

it('fences stale/error and recovery states without losing saved identity or claiming playback', async () => {
  let fail = false;
  vi.stubGlobal('fetch', vi.fn(async () => { if (fail) throw new Error('synthetic outage'); return reply({ ...status, reconciliation_required: true, shuffle_conflict: true }); }));
  render(<Publication {...props} />);
  await screen.findByText(/Recovery reconciliation required/);
  expect(screen.getByRole('button', { name: 'Review snapshot publication' })).toBeDisabled();
  expect(screen.getByText(/Conflicting shuffle preferences/)).toBeInTheDocument();
  fail = true;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh publication status' }));
  await screen.findByText(/Previous information is stale/);
  expect(screen.getByText(/Saved app revision: 3/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review publication recovery' })).toBeDisabled();
  expect(screen.getByText(/Dispatch: unknown/)).toHaveTextContent('independently unverified');
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh publication status' }));
  await waitFor(() => expect(screen.queryByText(/Previous information is stale/)).not.toBeInTheDocument());
});

it('requires external migration attestation and preserves separate rename outcomes', async () => {
  const confirmed = { ...status, verified: true, pending_removals: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.endsWith('/review') ? { action: 'activate', review_token: 'synthetic-review', desired_version: 3, checksum: 'a'.repeat(64), mapping_count: 1, empty: false, mappings: [], shuffle_conflict: false } : confirmed)));
  render(<Publication {...props} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review migration opt-in' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Review migration opt-in' }));
  await screen.findByLabelText(/I attest external migration/);
  fireEvent.click(screen.getByLabelText('I reviewed this exact snapshot and its preferences'));
  expect(screen.getByRole('button', { name: 'Confirm automatic publication opt-in' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I attest external migration/));
  expect(screen.getByRole('button', { name: 'Confirm automatic publication opt-in' })).toBeEnabled();
  expect(screen.getByText(/Tag rename has its own registry readback/)).toBeInTheDocument();
});
