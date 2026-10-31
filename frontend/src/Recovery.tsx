import { useApiFetch } from './sessionAccess';
import { useEffect, useRef, useState } from 'react';
import { useInputDraft } from './inputDrafts';

export interface RestoreReport {
  preview_token: string; local_revision: number; accepted: number; rejected: number; conflicts: number;
  rows: { row: number; source: Record<string, unknown>; accepted: boolean; conflict: boolean; diagnostics: string[] }[];
}
const MAX_BYTES = 4 * 1024 * 1024;
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Recovery({ csrf, manage, revision, onExpired, onChanged }: {
  csrf: string; manage: boolean; revision: number; onExpired: () => void; onChanged: () => void;
}) {
  const apiFetch = useApiFetch();
  const selection = useInputDraft<File | null>('restore:file', null);
  const file = selection.value;
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [stale, setStale] = useState(false);
  const [policy, setPolicy] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [guard, setGuard] = useState<boolean | null>(null);
  const [guardError, setGuardError] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const pendingPreview = useRef<AbortController | null>(null);
  useEffect(() => () => pendingPreview.current?.abort(), []);
  useEffect(() => {
    if (restoreFocus && busy === null) (file ? previewButton.current : fileInput.current)?.focus();
  }, [restoreFocus, busy, file]);
  useEffect(() => { if (report) heading.current?.focus(); }, [report]);
  useEffect(() => { if (message || error) feedback.current?.focus(); }, [message, error]);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('recovery', { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      if (response.status === 401) { onExpired(); return; }
      if (!response.ok) throw new Error();
      const value = await response.json() as { reconciliation_required: boolean };
      if (!controller.signal.aborted) { setGuard(value.reconciliation_required); setGuardError(false); }
    }).catch(() => { if (!controller.signal.aborted) setGuardError(true); });
    return () => controller.abort();
  }, [revision, onExpired]);
  async function exportMappings() {
    setExporting(true); setExportError('');
    try {
      const response = await apiFetch('export', { credentials: 'same-origin' });
      if (response.status === 401) { onExpired(); return; }
      if (!response.ok) throw new Error();
      download(await response.blob(), 'jukelet-export-v1.json');
    } catch { setExportError('Export unavailable. Retry, or use the documented protected database backup for oversized collections.'); }
    finally { setExporting(false); }
  }
  async function preview() {
    if (!file || busy) return;
    pendingPreview.current?.abort();
    const request = new AbortController(); pendingPreview.current = request;
    setBusy('preview'); setRestoreFocus(false); setError(''); setMessage(''); setStale(true); setReviewed(false);
    try {
      if (file.size > MAX_BYTES) throw new Error('Choose a UTF-8 JSON export no larger than 4 MiB.');
      const bytes = await file.arrayBuffer();
      if (request.signal.aborted) return;
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Preserve exact JSON fields, including duplicates, for server-side validation.
      const response = await apiFetch('restores/preview', { method: 'POST', credentials: 'same-origin', signal: request.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: `{"document":${content}}`,
      });
      if (request.signal.aborted) return;
      if (response.status === 401) { onExpired(); return; }
      if (!response.ok) throw new Error(response.status === 422 || response.status === 413 ? 'Invalid or unsupported export. Check the schema, JSON and size.' : 'Restore preview unavailable. Try previewing again.');
      const next = await response.json() as RestoreReport;
      if (request.signal.aborted) return;
      setReport(next); setStale(false); setPolicy('');
    } catch (cause) { if (!request.signal.aborted) setError(`${cause instanceof Error ? cause.message : 'Unable to read this export.'} Previous report retained, if available; preview again before confirming.`); }
    finally { if (!request.signal.aborted && pendingPreview.current === request) { pendingPreview.current = null; setBusy(null); } }
  }
  function cancelPreview(clearFile = false) {
    if (busy === 'confirm') return;
    pendingPreview.current?.abort(); pendingPreview.current = null;
    setBusy(null); setReport(null); setPolicy(''); setReviewed(false); setStale(true); setError(''); setMessage('');
    if (clearFile) { selection.initialize(null, true); if (fileInput.current) fileInput.current.value = ''; }
    setRestoreFocus(true);
  }
  async function confirm() {
    if (!report || stale || !manage || busy || !reviewed || !policy || report.accepted === 0) return;
    setBusy('confirm'); setError(''); setMessage('');
    try {
      const response = await apiFetch('restores/confirm', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ preview_token: report.preview_token, conflict_policy: policy, confirmed: true }),
      });
      if (response.status === 401) { onExpired(); return; }
      if (!response.ok) throw new Error(response.status === 409 ? 'Preview expired, another edit changed local drafts, or the selected policy rejected a conflict. Preview again and review.' : 'Restore outcome is unverified. Reload local drafts and preview again before retrying.');
      const result = await response.json() as { restored: number; skipped: number };
      selection.clear();
      setGuard(true); setMessage(`${result.restored} local drafts restored; ${result.skipped} conflicts skipped. Recovery reconciliation required before future publication. Active HA content is unchanged until a separately reviewed publication.`); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Restore outcome is unverified. Reload local drafts and preview again before retrying.'); }
    finally { setStale(true); setReviewed(false); setBusy(null); }
  }
  return <section id="recovery" aria-label="Export and recovery">
    <h3>Export and recovery</h3><p>Export local mappings and preferences as portable JSON. Tag names are informational snapshots. Restoring changes local drafts only; it never renames HA tags or starts playback.</p>
    <button disabled={exporting} onClick={() => { void exportMappings(); }}>{exporting ? 'Exporting mappings…' : 'Download mapping export'}</button>
    {exportError && <p role="alert">{exportError}</p>}
    {guard === null && !guardError && <p role="status">Loading recovery state…</p>}
    {guardError && <p role="alert">Recovery state unavailable; any previous state is stale.</p>}
    {guard && <p role="note">Reconciliation required. Future publication must compare restored state with HA before it can proceed. Use the separate publication recovery review; HA operator recovery may also be required.</p>}
    <p>For a full SQLite backup and guarded offline recovery, follow the development guide. Logical exports exclude runtime identity, sessions and metadata caches.</p>
    <label htmlFor="restore-file">Logical export JSON file</label><input id="restore-file" ref={fileInput} type="file" accept=".json,application/json" disabled={busy !== null} onChange={event => { selection.set(event.target.files?.[0] ?? null); setRestoreFocus(false); setStale(true); setReviewed(false); setPolicy(''); setMessage(''); }} />
    {file && <p>Selected export: <strong>{file.name}</strong>{selection.restored && ' Retained for this authorized user; preview again before choosing a new restore policy and confirmation.'}</p>}
    <button ref={previewButton} disabled={!file || busy !== null} onClick={() => { void preview(); }}>{busy === 'preview' ? 'Previewing restore…' : 'Preview restore'}</button>
    {(report || busy === 'preview') && <button disabled={busy === 'confirm'} onClick={() => cancelPreview()}>Cancel restore preview</button>}
    {file && <button disabled={busy === 'confirm'} onClick={() => cancelPreview(true)}>Clear selected export</button>}
    {busy && <p role="status">{busy === 'preview' ? 'Loading restore preview…' : 'Restoring local drafts…'}</p>}
    {report && <section aria-label="Restore preview"><h4 tabIndex={-1} ref={heading}>Reviewed restore</h4>
      {stale && <p role="note">This preview is stale or already used. Preview again before confirming.</p>}
      <p>{report.accepted} supported rows · {report.rejected} rejected rows · {report.conflicts} existing draft conflicts · Local revision {report.local_revision}</p>
      <p>Only supported rows are restored. Keep the report for unsupported content. Unlisted drafts remain unchanged.</p>
      <button onClick={() => { const { preview_token: _token, ...portable } = report; void _token; download(new Blob([JSON.stringify(portable, null, 2)], { type: 'application/json' }), 'jukelet-restore-report.json'); }}>Download restore report</button>
      <details><summary>Inspect restore rows</summary><ul className="restore-rows">{report.rows.map(row => <li key={row.row}><strong>Row {row.row}: {row.accepted ? 'Supported' : 'Rejected'}{row.conflict ? ' · Existing draft' : ''}</strong><pre>{JSON.stringify(row.source, null, 2)}</pre>{row.diagnostics.join(', ')}</li>)}</ul></details>
      {manage ? <fieldset disabled={busy !== null || stale}><legend>Confirm local restore</legend>
        <label htmlFor="restore-policy">Restore conflict policy</label><select id="restore-policy" value={policy} onChange={event => { setPolicy(event.target.value); setReviewed(false); }}><option value="">Choose explicitly…</option><option value="reject">Reject entire restore if any draft exists</option><option value="skip">Keep existing drafts; skip conflicts</option><option value="replace">Replace matching drafts with reviewed rows</option></select>
        <label className="check-label"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed the restore rows and conflict policy</label>
        <button disabled={!reviewed || !policy || report.accepted === 0} onClick={() => { void confirm(); }}>Confirm local restore</button>
      </fieldset> : <p>Read-only mode permits previews. Restoring requires manage mode.</p>}
    </section>}
    {error && <p role="alert" tabIndex={-1} ref={feedback}>{error}</p>}{message && <p role="status" tabIndex={-1} ref={feedback}>{message}</p>}
  </section>;
}
