import { useState } from 'react';

export interface ConfirmableReport { preview_token?: string | null; fingerprint: string; counts: { accepted: number } }
export interface PreviewSource { source: 'configured' | 'upload'; format?: string; content?: string }
export function ImportConfirmation({ report, source, csrf, onExpired, onChanged }: {
  report: ConfirmableReport; source: PreviewSource; csrf: string; onExpired: () => void; onChanged: () => void;
}) {
  const [policy, setPolicy] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [shuffle, setShuffle] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function confirm() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/imports/confirm', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ ...source, preview_token: report.preview_token, fingerprint: report.fingerprint, conflict_policy: policy, enabled, shuffle, playback_profile_id: 'default' }),
      });
      if (response.status === 401) { onExpired(); return; }
      if (!response.ok) throw new Error(response.status === 409 ? 'Source, local drafts or preview changed. Preview again and review before confirming.' : 'Import unavailable. Preview again before retrying; the report remains available.');
      const result = await response.json() as { imported: number; skipped: number };
      setMessage(`${result.imported} local drafts imported; ${result.skipped} existing drafts skipped. Rejected rows remain in the report. Legacy playback is unchanged.`);
      setDone(true); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to reach Jukelet. Preview again to reconcile the outcome.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Confirm local import"><h4>Import reviewed rows as local drafts</h4><p>Only the {report.counts.accepted} accepted rows will be imported. Unsupported rows remain in this downloadable report. The original automation is unchanged.</p>
    <label htmlFor="import-policy">Existing draft conflict policy</label><select id="import-policy" value={policy} onChange={event => setPolicy(event.target.value)} disabled={busy || done}><option value="">Choose explicitly…</option><option value="reject">Reject entire import if any draft exists</option><option value="skip">Keep existing drafts; skip conflicts</option><option value="replace">Replace existing drafts with reviewed mappings</option></select>
    <label className="check-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy || done} />Enable imported drafts</label>
    <label className="check-label"><input type="checkbox" checked={shuffle} onChange={event => setShuffle(event.target.checked)} disabled={busy || done} />Shuffle imported drafts</label>
    <p>Playback profile: default (local reference only). Preferences apply to every imported row.</p>
    <label className="check-label"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={busy || done} />I reviewed these rows, preferences and conflict policy</label>
    <button disabled={!report.preview_token || !policy || !reviewed || busy || done || Boolean(error)} onClick={() => { void confirm(); }}>{busy ? 'Importing local drafts…' : 'Confirm local import'}</button>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
