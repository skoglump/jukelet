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
const emptyReview = { action: 'publish', review_token: 'synthetic-review', desired_version: 3, checksum: 'a'.repeat(64), mapping_count: 0, empty: true, mappings: [], shuffle_conflict: false };
function deferredReply() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('distinguishes saved, pending removal, dispatch and independently unknown playback', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(status)));
  render(<Publication {...props} />);
  await screen.findByText(/Saved app revision: 3/);
  expect(screen.getByText(/prior HA mapping may still play/)).toBeInTheDocument();
  expect(screen.getByText(/Dispatch: disabled in HA/)).toHaveTextContent('Playback: independently unverified');
  expect(screen.getByText(/Pending or unverified/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review automatic publication opt-in' })).toBeDisabled();
  expect(screen.getByText('Synthetic:Å').textContent).toBe('  Synthetic:Å  ');
});

it('requires content-bound empty confirmation and never presents queue acknowledgment as success', async () => {
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => { void _options; return reply(url.endsWith('/review') ? emptyReview : status); });
  vi.stubGlobal('fetch', fetchMock);
  render(<Publication {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review snapshot publication' }));
  // The heading can be present before the effect transfers keyboard focus.
  await waitFor(() => expect(screen.getByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus());
  const confirm = screen.getByRole('button', { name: 'Confirm snapshot publication' });
  fireEvent.click(screen.getByLabelText('I reviewed this exact snapshot and its preferences'));
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I explicitly confirm this empty snapshot/));
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
  expect(screen.getByRole('status')).toHaveTextContent(/Immutable snapshot queued/);
  expect(screen.queryByText('Published: exact saved content verified active in HA.')).not.toBeInTheDocument();
  expect(JSON.parse((fetchMock.mock.calls.find(call => call[0].endsWith('/confirm')) as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ review_token: emptyReview.review_token, confirmed: true, confirm_empty: true });
});

it('waits for the review response, returns focus on cancel and requires fresh empty confirmations when reopened', async () => {
  const pending = deferredReply();
  let firstReview = true;
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.endsWith('/review')) return reply(status);
    if (firstReview) { firstReview = false; return pending.promise; }
    return reply(emptyReview);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<Publication {...props} />);
  const open = await screen.findByRole('button', { name: 'Review snapshot publication' });
  open.focus();
  fireEvent.click(open);
  expect(open).toBeDisabled();
  expect(screen.queryByRole('heading', { name: /^Review snapshot$/ })).not.toBeInTheDocument();
  pending.resolve(reply(emptyReview));
  await waitFor(() => expect(screen.getByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus());
  fireEvent.click(screen.getByLabelText('I reviewed this exact snapshot and its preferences'));
  fireEvent.click(screen.getByLabelText(/I explicitly confirm this empty snapshot/));
  expect(screen.getByRole('button', { name: 'Confirm snapshot publication' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel publication review' }));
  expect(screen.queryByRole('region', { name: 'Review immutable snapshot' })).not.toBeInTheDocument();
  expect(open).toHaveFocus();
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/confirm'))).toBe(false);
  fireEvent.click(open);
  await waitFor(() => expect(screen.getByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus());
  expect(screen.getByLabelText('I reviewed this exact snapshot and its preferences')).not.toBeChecked();
  expect(screen.getByLabelText(/I explicitly confirm this empty snapshot/)).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Confirm snapshot publication' })).toBeDisabled();
});

it('focuses a review preparation error and the exact heading after a new review succeeds', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/review')
    ? fail ? reply({ detail: { code: 'bridge_unavailable' } }, 409) : reply(emptyReview)
    : reply(status)));
  render(<Publication {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review snapshot publication' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  expect(screen.getByRole('alert')).toHaveTextContent('Companion status is unavailable');
  expect(screen.queryByRole('region', { name: 'Review immutable snapshot' })).not.toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Review snapshot publication' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('preserves keyboard position on a successful status refresh and fences a review of older content', async () => {
  let current = status;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.endsWith('/review') ? emptyReview : current)));
  render(<Publication {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review snapshot publication' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus());
  const reviewed = screen.getByLabelText('I reviewed this exact snapshot and its preferences');
  fireEvent.click(reviewed);
  fireEvent.click(screen.getByLabelText(/I explicitly confirm this empty snapshot/));
  reviewed.focus();
  current = { ...status, desired_version: 4 };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh publication status' }));
  await screen.findByText(/Saved app revision: 4/);
  expect(reviewed).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Confirm snapshot publication' })).toBeDisabled();
});

it('focuses failed confirmation feedback and fences retry until status is refreshed and content reviewed again', async () => {
  const pending = deferredReply();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/review') ? reply(emptyReview)
    : url.endsWith('/confirm') ? pending.promise : reply(status)));
  render(<Publication {...props} />);
  const open = await screen.findByRole('button', { name: 'Review snapshot publication' });
  fireEvent.click(open);
  await waitFor(() => expect(screen.getByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus());
  fireEvent.click(screen.getByLabelText('I reviewed this exact snapshot and its preferences'));
  fireEvent.click(screen.getByLabelText(/I explicitly confirm this empty snapshot/));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm snapshot publication' }));
  expect(screen.getByRole('button', { name: 'Cancel publication review' })).toBeDisabled();
  pending.resolve(reply({ detail: { code: 'review_stale' } }, 409));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  expect(screen.getByRole('alert')).toHaveTextContent('Content or HA state changed');
  expect(screen.queryByRole('region', { name: 'Review immutable snapshot' })).not.toBeInTheDocument();
  expect(open).toBeDisabled();
  expect(screen.queryByText(/Immutable snapshot queued/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh publication status' }));
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  await waitFor(() => expect(screen.getByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus());
  expect(screen.getByLabelText('I reviewed this exact snapshot and its preferences')).not.toBeChecked();
  expect(screen.getByLabelText(/I explicitly confirm this empty snapshot/)).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Confirm snapshot publication' })).toBeDisabled();
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

it('requires automatic publication attestation and preserves separate rename outcomes', async () => {
  const confirmed = { ...status, verified: true, pending_removals: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => reply(url.endsWith('/review') ? { action: 'activate', review_token: 'synthetic-review', desired_version: 3, checksum: 'a'.repeat(64), mapping_count: 1, empty: false, mappings: [], shuffle_conflict: false } : confirmed)));
  render(<Publication {...props} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review automatic publication opt-in' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Review automatic publication opt-in' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Review automatic publication opt-in' })).toHaveFocus());
  fireEvent.click(screen.getByLabelText('I reviewed this exact snapshot and its preferences'));
  expect(screen.getByRole('button', { name: 'Confirm automatic publication opt-in' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/I reviewed backups, exclusive tag-playback dispatch/));
  expect(screen.getByRole('button', { name: 'Confirm automatic publication opt-in' })).toBeEnabled();
  expect(screen.getByText(/Tag rename has its own registry readback/)).toBeInTheDocument();
});
