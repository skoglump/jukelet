import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PlaybackStatus, type PlaybackObservation } from './PlaybackStatus';

const at = () => new Date().toISOString();
function observation(): PlaybackObservation {
  return { connection: 'connected', checked_at: at(), stale: false, error: null,
    diagnostics: { diagnostics_version: 1, started_at: at(), observed_at: at(), dispatch_enabled: false,
      ready: true, readiness_error: null, busy: false, execution_uncertain: false, pause_reason: 'startup',
      last_scan_at: null, last_attempt: null, diagnostics: [], playback_verification: 'unavailable' } };
}
function attempt(execution = 'finished', error: string | null = null) {
  return { correlation_id: '00000000-0000-4000-8000-000000000036', snapshot_revision: 7,
    requested_at: at(), completed_at: at(), invocation: 'accepted', execution, error };
}
const reply = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('explains restart-disabled readiness and absent scans without diagnosing an offline reader', async () => {
  const fetch = vi.fn().mockResolvedValue(reply(observation()));
  vi.stubGlobal('fetch', fetch);
  render(<PlaybackStatus onExpired={vi.fn()} />);
  expect(await screen.findByText(/No healthy remembered enable choice was restored at startup/)).toBeInTheDocument();
  expect(screen.getByText(/Dispatch: disabled. Readiness: ready/)).toBeInTheDocument();
  expect(screen.getByText(/No scan observed by this companion/)).toHaveTextContent('does not prove a reader is offline');
  expect(screen.getByText(/verify that no other tag-playback dispatcher is active/)).toBeInTheDocument();
  expect(screen.getByText(/HA administrator controls:/)).toHaveTextContent('Settings → Devices & services → Jukelet bridge → Configure');
  expect(screen.getByText(/App sign-in grants no HA administrator authority/)).toHaveTextContent('Script entities being off alone is insufficient');
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(fetch.mock.calls[0][0]).toBe(`${window.location.origin}/api/v1/playback-status`);
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('method');
});

test.each([
  ['readiness_failed', 'Preparation reported that readiness failed'],
  ['account_failed', 'Preparation reported an account failure'],
  ['transfer_failed', 'The script reported a transfer failure'],
  ['playback_failed', 'The script reported a playback request failure'],
  ['completion_unavailable', 'The reason is unknown'],
  ['invalid_completion', 'No specific preparation failure can be established'],
  ['timeout', 'does not prove that startup or external effects stopped'],
])('shows bounded correlated %s with uncertainty guidance', async (error, explanation) => {
  const value = observation();
  Object.assign(value.diagnostics!, { ready: false, execution_uncertain: true, readiness_error: 'execution_uncertain',
    last_scan_at: at(), last_attempt: attempt(error.endsWith('_failed') ? 'failed' : 'unknown', error) });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(value)));
  render(<PlaybackStatus onExpired={vi.fn()} />);
  expect(await screen.findByText(new RegExp(explanation))).toBeInTheDocument();
  expect(screen.getByText(/all prior startup work, including nested or external work/)).toBeInTheDocument();
  expect(screen.getByText(/Correlation:/)).toHaveTextContent('00000000-0000-4000-8000-000000000036');
  expect(screen.getByText(/No scans are retried by inspection/)).toBeInTheDocument();
});

test('keeps finished script outcome historical and never claims independently verified playback', async () => {
  const value = observation();
  Object.assign(value.diagnostics!, { dispatch_enabled: true, last_attempt: attempt() });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(value)));
  render(<PlaybackStatus onExpired={vi.fn()} />);
  expect(await screen.findByText(/The script reported completion/)).toHaveTextContent('does not independently verify playback');
  expect(screen.getByRole('heading', { name: /Most recent startup attempt \(historical\)/ })).toBeInTheDocument();
});

test('busy startup is distinct from uncertainty recovery, without a queued scan or replay', async () => {
  const value = observation();
  Object.assign(value.diagnostics!, { dispatch_enabled: true, busy: true, execution_uncertain: true, ready: false, readiness_error: 'execution_uncertain', last_attempt: { ...attempt('unknown'), invocation: 'requested', completed_at: null } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(value)));
  render(<PlaybackStatus onExpired={vi.fn()} />);
  expect(await screen.findByText(/Startup is busy/)).toHaveTextContent('ignored with no queue or replay');
  expect(screen.queryByText(/must establish that all prior startup work/)).not.toBeInTheDocument();
});

test.each(['stale', 'disconnected', 'future'])('shows %s observations as unknown, retaining historical completion', async (mode) => {
  const value = observation();
  value.diagnostics!.last_attempt = attempt();
  if (mode === 'stale') value.stale = true;
  if (mode === 'disconnected') value.connection = 'disconnected';
  if (mode === 'future') value.checked_at = new Date(Date.now() + 10_000).toISOString();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(value)));
  render(<PlaybackStatus onExpired={vi.fn()} />);
  expect(await screen.findByText(/Current playback readiness unknown/)).toBeInTheDocument();
  expect(screen.getByText(/Dispatch: unknown/)).toBeInTheDocument();
  expect(screen.getByText(/The script reported completion/)).toBeInTheDocument();
});

test('expires freshness while a serial poll hangs, aborts teardown, and never sends writes', async () => {
  vi.useFakeTimers();
  const value = observation();
  value.diagnostics!.dispatch_enabled = true;
  const fetch = vi.fn().mockResolvedValueOnce(reply(value)).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetch);
  const { unmount } = render(<PlaybackStatus onExpired={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText(/Dispatch: enabled/)).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(10_000); });
  await act(async () => { vi.advanceTimersByTime(21_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Current playback readiness unknown/)).toBeInTheDocument();
  expect(screen.getByText(/Dispatch: unknown/)).toBeInTheDocument();
  unmount();
  expect((fetch.mock.calls[1][1].signal as AbortSignal).aborted).toBe(true);
  expect(fetch.mock.calls.every(call => call[0] === `${window.location.origin}/api/v1/playback-status` && !call[1].method)).toBe(true);
});

test('session expiry returns to authentication', async () => {
  const expired = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({}, 401)));
  render(<PlaybackStatus onExpired={expired} />);
  await act(async () => { await Promise.resolve(); });
  expect(expired).toHaveBeenCalledOnce();
});
