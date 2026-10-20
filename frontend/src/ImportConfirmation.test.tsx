import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportConfirmation } from './ImportConfirmation';
afterEach(() => vi.unstubAllGlobals());
it('requires explicit policy and reviewed preferences and sends the exact reviewed source', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ imported: 1, skipped: 2 }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<ImportConfirmation report={{ fingerprint: 'fingerprint', preview_token: 'review-token', counts: { accepted: 3 } }} source={{ source: 'upload', format: 'yaml', content: 'reviewed bytes' }} csrf="csrf" onExpired={() => undefined} onChanged={() => undefined} />);
  const confirm = screen.getByRole('button', { name: 'Confirm local import' });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Existing draft conflict policy'), { target: { value: 'skip' } });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByLabelText('I reviewed these rows, preferences and conflict policy'));
  fireEvent.click(confirm);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ source: 'upload', format: 'yaml', content: 'reviewed bytes', fingerprint: 'fingerprint', preview_token: 'review-token', conflict_policy: 'skip', enabled: true, shuffle: false, playback_profile_id: 'default' });
  expect(await screen.findByRole('status')).toHaveTextContent('1 local drafts imported; 2 existing drafts skipped');
  expect(confirm).toBeDisabled();
});
