import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssignmentEditor } from './Assignments';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('saves explicit local preferences without requiring metadata and requires reload after conflict', async () => {
  const requests: { url: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body as string });
    return { ok: !init?.method, status: init?.method ? 409 : 200, json: async () => init?.method ? { detail: { current_version: 1 } } : { version: 0, assignment: null } };
  }));
  render(<AssignmentEditor tagKey="synthetic-key" tagId="  Å/a  " csrf="csrf" onExpired={() => undefined} onChanged={() => undefined} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save local draft' })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Draft Spotify URI or link'), { target: { value: 'spotify:album:0123456789ABCDEFGHIJKL' } });
  fireEvent.click(screen.getByLabelText('Shuffle'));
  fireEvent.click(screen.getByRole('button', { name: 'Save local draft' }));
  await screen.findByText(/Another edit changed this draft/);
  expect(screen.getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue('spotify:album:0123456789ABCDEFGHIJKL');
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(JSON.parse(requests[1].body!)).toMatchObject({ ha_tag_id: '  Å/a  ', enabled: true, shuffle: true, playback_profile_id: 'default', expected_version: 0 });
  expect(requests.some(request => request.url.includes('music'))).toBe(false);
});

it('keeps form disabled while loading and preserves a previous draft on refresh failure', async () => {
  let resolveRead: (value: unknown) => void = () => undefined;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  const fetchMock = vi.fn().mockReturnValueOnce(pending).mockRejectedValue(new Error('network'));
  vi.stubGlobal('fetch', fetchMock);
  render(<AssignmentEditor tagKey="synthetic-key" tagId="orphan" csrf="csrf" onExpired={() => undefined} onChanged={() => undefined} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading local draft');
  expect(screen.getByRole('button', { name: 'Save local draft' })).toBeDisabled();
  resolveRead({ ok: true, status: 200, json: async () => ({ version: 8, assignment: { spotify_uri: 'spotify:playlist:0123456789ABCDEFGHIJKL', media_type: 'playlist', enabled: false, shuffle: true } }) });
  await waitFor(() => expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue('spotify:playlist:0123456789ABCDEFGHIJKL'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload current draft' }));
  await screen.findByText(/Previous form retained/);
  expect(screen.getByLabelText('Draft Spotify URI or link')).toHaveValue('spotify:playlist:0123456789ABCDEFGHIJKL');
  expect(screen.getByLabelText('Enabled draft')).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Save local draft' })).toBeDisabled();
});

it('allows correction after validation failure without losing preferences', async () => {
  const changed = vi.fn();
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ version: 0, assignment: null }) })
    .mockResolvedValueOnce({ ok: false, status: 422 })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ version: 1, assignment: { spotify_uri: 'spotify:album:0123456789ABCDEFGHIJKL', enabled: true } }) }));
  render(<AssignmentEditor tagKey="synthetic-key" tagId="orphan" csrf="csrf" onExpired={() => undefined} onChanged={changed} />);
  const save = screen.getByRole('button', { name: 'Save local draft' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Draft Spotify URI or link'), { target: { value: 'invalid' } });
  fireEvent.click(screen.getByLabelText('Shuffle'));
  fireEvent.click(save);
  await screen.findByText(/correct it and save again/);
  expect(save).toBeEnabled();
  expect(screen.getByLabelText('Shuffle')).toBeChecked();
  fireEvent.change(screen.getByLabelText('Draft Spotify URI or link'), { target: { value: 'spotify:album:0123456789ABCDEFGHIJKL' } });
  fireEvent.click(save);
  await screen.findByText('Local draft saved. Check publication status: the prior HA mapping may still play until a newer snapshot is verified active.');
  expect(changed).toHaveBeenCalledOnce();
});
