import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ConnectionStatus } from './ConnectionStatus';

const status = (connection = 'connected') => ({
  connection, version: '2026.10.1', tag_list: 'supported', scan_subscription: 'unsupported',
  subscribed: false, services: { get_album: { state: 'supported' } },
  inventory_stale: false, inventory_updated_at: '2026-10-16T12:00:00Z',
  services_updated_at: '2026-10-16T12:00:00Z', discovery_gap: false, error: null,
});
const reply = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('shows loading, capabilities and fresh timestamps', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(status())));
  render(<ConnectionStatus onExpired={vi.fn()} />);
  expect(screen.getByText('Loading connection status…')).toBeInTheDocument();
  expect(await screen.findByText(/Home Assistant connected/)).toHaveTextContent('2026.10.1');
  expect(screen.getByText('SpotifyPlus get album: supported')).toBeInTheDocument();
  expect(screen.getByText(/Tag cache updated:/)).toBeInTheDocument();
  expect(screen.getByText(/Scan notifications: unsupported/)).toBeInTheDocument();
});

test.each([
  ['not_configured', 'Home Assistant is not configured.'],
  ['disconnected', 'Home Assistant disconnected.'],
  ['unauthorized', 'Home Assistant authentication rejected.'],
])('displays %s distinctly', async (connection, expected) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...status(connection), version: null, inventory_stale: true })));
  render(<ConnectionStatus onExpired={vi.fn()} />);
  expect(await screen.findByText(expected)).toBeInTheDocument();
  expect(screen.getByText(/Tag cache is stale/)).toBeInTheDocument();
});

test('polls without overlaps, preserves stale results on failure, and aborts on unmount', async () => {
  vi.useFakeTimers();
  let resolve: (value: Response) => void = () => {};
  const fetchMock = vi.fn().mockResolvedValueOnce(reply(status()))
    .mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
    .mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  const { unmount } = render(<ConnectionStatus onExpired={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(reply(status('disconnected'))); });
  expect(screen.getByText(/Home Assistant disconnected/)).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(screen.getByRole('alert')).toHaveTextContent('Displayed information may be stale');
  expect(screen.getByText(/Home Assistant disconnected/)).toBeInTheDocument();
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { vi.advanceTimersByTime(10_000); });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('expires authentication when status returns 401', async () => {
  const expired = vi.fn();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({}, 401)));
  render(<ConnectionStatus onExpired={expired} />);
  await act(async () => { await Promise.resolve(); });
  expect(expired).toHaveBeenCalledOnce();
});
