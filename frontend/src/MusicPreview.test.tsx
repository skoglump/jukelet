import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MusicPreview } from './MusicPreview';

const uri = 'spotify:album:0123456789ABCDEFGHIJKL';
const capabilities = { album_detail: 'unsupported', playlist_detail: 'supported', album_library: 'unsupported', playlist_library: 'supported', album_search: 'unsupported', playlist_search: 'supported' };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const result = { uri, item: null, items: [], total: null, next_offset: null, state: 'unavailable', error: 'not_found', last_attempt_at: '2026-10-19T10:00:00Z', last_success_at: null, retry_after: 30 };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('independent capabilities leave manual URI preview available and preserve failed URI', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply(capabilities)).mockResolvedValueOnce(reply(result, 503));
  vi.stubGlobal('fetch', fetcher);
  render(<MusicPreview csrf="synthetic-csrf" onExpired={vi.fn()} />);
  expect(await screen.findByText('Album search: unavailable')).toBeInTheDocument();
  expect(screen.getByText('Playlist search: available')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Browse library' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: uri } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview URI' }));
  expect(await screen.findByText(uri)).toBeInTheDocument();
  expect(screen.getByText(/not found/i)).toBeInTheDocument();
  expect(screen.getByText(/does not determine playability/)).toBeInTheDocument();
  expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': 'synthetic-csrf' } });
});

test('debounces search, ignores superseded responses and keeps last preview when request fails', async () => {
  vi.useFakeTimers();
  let finishOld: (response: Response) => void = () => undefined;
  const oldRequest = new Promise<Response>(resolve => { finishOld = resolve; });
  const item = { uri, media_type: 'album', title: 'Latest synthetic result', subtitle: null, artwork_url: null };
  const fresh = { ...result, state: 'fresh', error: null, retry_after: null, last_success_at: result.last_attempt_at, items: [item], total: 1 };
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ ...capabilities, album_search: 'supported' }))
    .mockReturnValueOnce(oldRequest).mockResolvedValueOnce(reply(fresh))
    .mockResolvedValueOnce(reply({ ...fresh, uri, item, items: [] })).mockRejectedValueOnce(new Error('Network unavailable'));
  vi.stubGlobal('fetch', fetcher);
  render(<MusicPreview csrf="csrf" onExpired={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Search music'), { target: { value: 'old' } });
  await act(async () => { vi.advanceTimersByTime(349); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  fireEvent.change(screen.getByLabelText('Search music'), { target: { value: 'new' } });
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async () => { vi.advanceTimersByTime(350); });
  expect(screen.getByText('Latest synthetic result')).toBeInTheDocument();
  await act(async () => { finishOld(reply({ ...fresh, items: [{ ...item, title: 'Obsolete result' }] })); });
  expect(screen.queryByText('Obsolete result')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Preview Latest synthetic result' }));
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Preview Latest synthetic result' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('alert')).toHaveTextContent('Previous preview retained');
  expect(screen.getAllByText('Latest synthetic result')).toHaveLength(2);
});

test('pages the library explicitly, shows stale metadata and expires unauthorized sessions', async () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const item = { uri, media_type: 'album', title: 'Retained fixture', subtitle: 'Fixture artist', artwork_url: 'https://i.scdn.co/image/synthetic' };
  const page = { ...result, uri: null, items: Array.from({ length: 20 }, () => item), total: 21, next_offset: 20, state: 'fresh', error: null, last_success_at: result.last_attempt_at };
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ ...capabilities, album_library: 'supported' }))
    .mockResolvedValueOnce(reply(page)).mockResolvedValueOnce(reply({ ...page, total: 20, next_offset: null, items: [] }))
    .mockResolvedValueOnce(reply({ ...result, item, state: 'stale', last_success_at: result.last_attempt_at }, 503)).mockResolvedValueOnce(reply({}, 401));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<MusicPreview csrf="csrf" onExpired={expired} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('button', { name: 'Browse library' }));
  await act(async () => { vi.advanceTimersByTime(1); });
  fireEvent.click(screen.getByRole('button', { name: 'Next music' }));
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(fetcher.mock.calls[2][0]).toContain('offset=20');
  expect(screen.getByRole('button', { name: 'Next music' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: uri } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview URI' }));
  await act(async () => { await Promise.resolve(); });
  expect(within(screen.getByLabelText('Selected music preview')).getByText(/Metadata: stale/)).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Artwork for Retained fixture' })).toHaveAttribute('referrerpolicy', 'no-referrer');
  fireEvent.click(screen.getByRole('button', { name: 'Preview URI' }));
  await act(async () => { await Promise.resolve(); });
  expect(expired).toHaveBeenCalledOnce();
  view.unmount();
  expect(fetcher.mock.calls[4][1].signal.aborted).toBe(true);
});

test('ages a displayed successful preview to stale without a background lookup', async () => {
  vi.useFakeTimers();
  const stamp = new Date().toISOString();
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(reply(url.endsWith('capabilities') ? capabilities : { ...result, state: 'fresh', error: null, last_attempt_at: stamp, last_success_at: stamp })));
  vi.stubGlobal('fetch', fetcher);
  render(<MusicPreview csrf="csrf" onExpired={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(screen.getByLabelText('Spotify URI or link'), { target: { value: uri } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview URI' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText(/Metadata: fresh/)).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(300000); });
  expect(screen.getByText(/Metadata: stale/)).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/resolve'))).toHaveLength(1);
});

test('returns through visited short library pages and resets navigation for type and mode changes', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('capabilities')) return Promise.resolve(reply(Object.fromEntries(Object.keys(capabilities).map(key => [key, 'supported']))));
    const params = new URL(url, 'https://jukelet.example').searchParams;
    const offset = Number(params.get('offset') ?? 0);
    const type = params.get('media_type');
    const searching = url.includes('/search?');
    const items = searching ? [] : Array.from({ length: 5 }, (_, index) => ({
      uri: uri.replace('album', type!), media_type: type, title: `${type} fixture ${offset + index}`, subtitle: null, artwork_url: null,
    }));
    return Promise.resolve(reply({ ...result, uri: null, items, total: searching ? 0 : 15,
      state: 'fresh', error: null, next_offset: !searching && offset < 10 ? offset + 5 : null, last_success_at: new Date().toISOString() }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<MusicPreview csrf="csrf" onExpired={vi.fn()} />);
  await act(async () => { await Promise.resolve(); });
  async function click(name: string) {
    fireEvent.click(screen.getByRole('button', { name }));
    await act(async () => { vi.advanceTimersByTime(1); });
  }
  await click('Browse library');
  expect(screen.getByRole('button', { name: 'Previous music' })).toBeDisabled();
  await click('Next music');
  expect(screen.getByRole('heading', { name: 'Results for album library (offset 5)' })).toBeInTheDocument();
  await click('Next music');
  expect(screen.getByRole('heading', { name: 'Results for album library (offset 10)' })).toBeInTheDocument();
  await click('Previous music');
  expect(screen.getByRole('heading', { name: 'Results for album library (offset 5)' })).toBeInTheDocument();
  await click('Previous music');
  expect(screen.getByRole('heading', { name: 'Results for album library (offset 0)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous music' })).toBeDisabled();
  await click('Next music');
  fireEvent.change(screen.getByLabelText('Music type'), { target: { value: 'playlist' } });
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(screen.getByRole('heading', { name: 'Results for playlist library (offset 0)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous music' })).toBeDisabled();
  await click('Next music');
  fireEvent.change(screen.getByLabelText('Search music'), { target: { value: 'fixture' } });
  await act(async () => { vi.advanceTimersByTime(350); });
  expect(screen.queryByRole('button', { name: 'Previous music' })).not.toBeInTheDocument();
  await click('Browse library');
  expect(screen.getByRole('heading', { name: 'Results for playlist library (offset 0)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previous music' })).toBeDisabled();
  await click('Next music');
  await click('Previous music');
  expect(screen.getByRole('button', { name: 'Previous music' })).toBeDisabled();
  const offsets = fetcher.mock.calls.filter(([url]) => url.includes('/library?')).map(([url]) => Number(new URL(url, 'https://jukelet.example').searchParams.get('offset')));
  expect(offsets).toEqual([0, 5, 10, 5, 0, 5, 0, 5, 0, 5, 0]);
});
