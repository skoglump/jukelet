import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TagName } from './TagName';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const props = { tagKey: 'hashed-fixture-key', tagId: '  Synthetic:Å/04:AB  ', name: 'Old label', pending: false, csrf: 'synthetic-csrf', onExpired: vi.fn(), onRenamed: vi.fn() };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('reports forbidden separately, retries the narrow name request, and only reports verified readback', async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn().mockResolvedValueOnce(reply({ detail: { code: 'forbidden', state: 'rejected' } }, 403))
    .mockResolvedValueOnce(reply({ name: 'Dinner Å', state: 'verified' }));
  vi.stubGlobal('fetch', fetcher);
  render(<TagName {...props} />);
  await user.clear(screen.getByLabelText('Requested HA tag name')); await user.type(screen.getByLabelText('Requested HA tag name'), 'Dinner Å');
  await user.click(screen.getByRole('button', { name: 'Rename HA tag' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Home Assistant denied');
  expect(screen.getByRole('alert')).toHaveFocus();
  expect(props.onRenamed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Retry HA rename' }));
  expect(await screen.findByRole('status')).toHaveTextContent('HA rename verified by registry readback');
  expect(props.onRenamed).toHaveBeenCalledWith('Dinner Å');
  for (const [url, options] of fetcher.mock.calls) {
    expect(url).toBe('/api/v1/tags/hashed-fixture-key/name');
    expect(options.method).toBe('PATCH');
    expect(options.headers['X-CSRF-Token']).toBe('synthetic-csrf');
    expect(JSON.parse(options.body)).toEqual({ ha_tag_id: props.tagId, expected_name: 'Old label', name: 'Dinner Å' });
  }
});

test.each(['network', 'mismatch', 'conflict'])('requires explicit successful readback before retrying after %s', async kind => {
  const user = userEvent.setup();
  const fetcher = vi.fn();
  if (kind === 'network') fetcher.mockRejectedValueOnce(new Error('offline'));
  else fetcher.mockResolvedValueOnce(reply({ detail: { code: kind === 'conflict' ? 'name_conflict' : 'readback_mismatch', state: kind === 'conflict' ? 'conflict' : 'uncertain' } }, kind === 'conflict' ? 409 : 503));
  fetcher.mockResolvedValueOnce(reply({ detail: { code: 'unavailable' } }, 503))
    .mockResolvedValueOnce(reply({ name: 'Other browser label', state: 'current' }))
    .mockResolvedValueOnce(reply({ name: 'My requested name', state: 'verified' }));
  vi.stubGlobal('fetch', fetcher);
  render(<TagName {...props} />);
  await user.clear(screen.getByLabelText('Requested HA tag name')); await user.type(screen.getByLabelText('Requested HA tag name'), 'My requested name');
  await user.click(screen.getByRole('button', { name: 'Rename HA tag' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Retry HA rename' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Check HA name' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Retry HA rename' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Check HA name' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Current HA name checked: Other browser label');
  expect(screen.getByLabelText('Requested HA tag name')).toHaveValue('My requested name');
  await user.click(screen.getByRole('button', { name: 'Rename HA tag' }));
  expect(await screen.findByRole('status')).toHaveTextContent('HA rename verified');
  expect(fetcher.mock.calls.map(([, options]) => options.method)).toEqual(['PATCH', 'GET', 'GET', 'PATCH']);
  expect(JSON.parse(fetcher.mock.calls[3][1].body).expected_name).toBe('Other browser label');
});

test('pending discovery cannot rename; loading and cancellation do not claim success', async () => {
  let finish: (response: Response) => void = () => undefined;
  const fetcher = vi.fn().mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const { rerender, unmount } = render(<TagName {...props} pending />);
  expect(screen.getByRole('button', { name: 'Rename HA tag' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check HA name' })).toBeDisabled();
  rerender(<TagName {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Rename HA tag' }));
  expect(screen.getByRole('status')).toHaveTextContent('Waiting for HA response and inventory readback');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  unmount(); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => finish(reply({ name: 'Old label', state: 'verified' })));
  expect(props.onRenamed).not.toHaveBeenCalled();
});
