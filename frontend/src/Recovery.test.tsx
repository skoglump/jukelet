import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Recovery, type RestoreReport } from './Recovery';
const report: RestoreReport = { preview_token: 'synthetic-reviewed-token', local_revision: 2, accepted: 1, rejected: 1, conflicts: 1,
  rows: [{ row: 1, source: { ha_tag_id: '  Å/04:ab  ', shuffle: true }, accepted: true, conflict: true, diagnostics: [] }, { row: 2, source: { media_type: 'track' }, accepted: false, conflict: false, diagnostics: ['unsupported_or_invalid_row'] }],
};
const response = (value: unknown, status = 200) => ({ ok: status === 200, status, json: async () => value });
function upload() {
  const file = new File(['{"schema_version":1}'], 'synthetic.json', { type: 'application/json' });
  file.arrayBuffer = async () => new TextEncoder().encode('{"schema_version":1}').buffer;
  fireEvent.change(screen.getByLabelText('Logical export JSON file'), { target: { files: [file] } });
}
afterEach(() => vi.unstubAllGlobals());
it('requires reviewed policy, preserves rows on stale conflicts and blocks retry until re-preview', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ reconciliation_required: false })).mockResolvedValueOnce(response(report)).mockResolvedValueOnce(response({}, 409));
  vi.stubGlobal('fetch', fetchMock);
  render(<Recovery csrf="csrf" manage revision={0} onExpired={() => undefined} onChanged={() => undefined} />);
  upload(); fireEvent.click(screen.getByRole('button', { name: 'Preview restore' }));
  const confirm = await screen.findByRole('button', { name: 'Confirm local restore' });
  expect(confirm).toBeDisabled();
  expect(screen.getByRole('heading', { name: 'Reviewed restore' })).toHaveFocus();
  fireEvent.change(screen.getByLabelText('Restore conflict policy'), { target: { value: 'replace' } });
  fireEvent.click(screen.getByLabelText('I reviewed the restore rows and conflict policy'));
  fireEvent.click(confirm);
  expect(await screen.findByRole('alert')).toHaveTextContent('Preview expired');
  expect(confirm).toBeDisabled();
  expect(screen.getByRole('region', { name: 'Restore preview' })).toHaveTextContent('unsupported_or_invalid_row');
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ preview_token: report.preview_token, confirmed: true, conflict_policy: 'replace' });
});
it('retains the previous report through pending and failed previews and invalidates on file changes', async () => {
  let finish: (value: unknown) => void = () => undefined;
  const fetchMock = vi.fn().mockResolvedValueOnce(response({ reconciliation_required: true })).mockResolvedValueOnce(response(report)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  render(<Recovery csrf="csrf" manage revision={0} onExpired={() => undefined} onChanged={() => undefined} />);
  upload(); fireEvent.click(screen.getByRole('button', { name: 'Preview restore' }));
  await screen.findByRole('heading', { name: 'Reviewed restore' });
  upload();
  expect(screen.getByText(/This preview is stale/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Preview restore' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(screen.getByText('Loading restore preview…')).toBeVisible();
  expect(screen.getByRole('region', { name: 'Restore preview' })).toHaveTextContent('1 rejected rows');
  finish(response({}, 503));
  expect(await screen.findByRole('alert')).toHaveTextContent('Previous report retained');
  expect(screen.getByRole('button', { name: 'Confirm local restore' })).toBeDisabled();
});
it('read-only preview does not expose confirmation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ reconciliation_required: false })).mockResolvedValueOnce(response(report)));
  render(<Recovery csrf="csrf" manage={false} revision={0} onExpired={() => undefined} onChanged={() => undefined} />);
  upload(); fireEvent.click(screen.getByRole('button', { name: 'Preview restore' }));
  await screen.findByRole('heading', { name: 'Reviewed restore' });
  expect(screen.queryByRole('button', { name: 'Confirm local restore' })).not.toBeInTheDocument();
});
