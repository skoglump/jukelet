import { useCallback, useEffect, useRef, useState } from 'react';

interface Actual { publisher_id: string; active_revision: number | null; active_checksum: string | null; persistence: string; dispatch_enabled: boolean }
export interface PublicationStatus {
  publisher_id: string; desired_version: number; desired_checksum: string | null; mapping_count: number;
  active_revision: number | null; active_checksum: string | null; active_desired_version: number | null;
  automatic_enabled: boolean; healthy: boolean; reconciliation_required: boolean; verified: boolean;
  actual: Actual | null; actual_stale: boolean; checked_at: string | null; error: string | null;
  shuffle_conflict: boolean; pending_removals: string[]; playback_verified: null;
  jobs: { revision: number; desired_version: number; state: string }[];
}
interface Mapping { tag_id: string; media_type: string; spotify_uri: string; enabled: boolean; shuffle: boolean }
interface Review { review_token: string; action: string; desired_version: number; checksum: string; mapping_count: number; empty: boolean; mappings: Mapping[]; shuffle_conflict: boolean }
const errors: Record<string, string> = {
  bridge_unavailable: 'Companion status is unavailable. Reconnect and check actual state before retrying.',
  operator_ha_recovery_required: 'HA operator recovery is required. Preserve backups and use the companion Configure flow; damaged history requires a coherent HA backup.',
  recovery_required: 'Publication is fenced. Compare protected app and HA backups, then review recovery.',
  review_stale: 'Content or HA state changed. Review the current snapshot again.',
  review_expired: 'This review expired or was already used. Review again.',
  empty_confirmation_required: 'Explicit confirmation of this exact empty snapshot is required.',
  migration_attestation_required: 'Attest that the external migration and cutover prerequisites are complete.',
  reviewed_publication_required: 'Publish and verify the current reviewed content before enabling automatic publication.',
  shuffle_conflict: 'Conflicting shuffle preferences must be resolved by an explicit assignment edit before activation.',
  job_pending: 'An earlier publication is pending. Refresh actual state before reviewing recovery or activation.',
};

export function Publication({ csrf, manage, revision, onExpired }: { csrf: string; manage: boolean; revision: number; onExpired: () => void }) {
  const [status, setStatus] = useState<PublicationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(true);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [attested, setAttested] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const pendingRefresh = useRef<AbortController | null>(null);
  useEffect(() => { if (review) heading.current?.focus(); }, [review]);
  useEffect(() => { if (error || statusError || message) feedback.current?.focus(); }, [error, statusError, message]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    pendingRefresh.current?.abort();
    const request = new AbortController();
    pendingRefresh.current = request;
    const abort = () => request.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch('/api/v1/publication', { credentials: 'same-origin', signal: request.signal });
      if (request.signal.aborted) return;
      if (response.status === 401) { onExpired(); return; }
      if (!response.ok) throw new Error();
      const next = await response.json() as PublicationStatus;
      if (!Array.isArray(next.jobs) || !Array.isArray(next.pending_removals)) throw new Error();
      if (!request.signal.aborted) { setStatus(next); setStale(false); setStatusError(''); }
    } catch { if (!request.signal.aborted) { setStale(true); setStatusError('Publication status unavailable. Previous information is stale; refresh actual state before taking action.'); } }
    finally { signal?.removeEventListener('abort', abort); if (!request.signal.aborted) setLoading(false); }
  }, [onExpired]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      await refresh(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(() => { void poll(); }, 3000);
    }
    void poll();
    return () => { controller.abort(); pendingRefresh.current?.abort(); window.clearTimeout(timer); };
  }, [revision, refresh]);
  async function post(path: string, body: object) {
    const response = await fetch(`/api/v1/publication/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    if (response.status === 401) { onExpired(); return null; }
    if (!response.ok) {
      const detail = await response.json() as { detail?: { code?: string } };
      throw new Error(errors[detail.detail?.code ?? ''] ?? 'Outcome is unverified. Refresh actual state and review again before retrying.');
    }
    return response;
  }
  async function begin(action: string) {
    setBusy(true); setError(''); setMessage(''); setReview(null); setReviewed(false); setEmpty(false); setAttested(false);
    try {
      const response = await post('review', { action });
      if (response) setReview(await response.json() as Review);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to prepare review. Refresh actual state.'); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!review) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await post('confirm', { review_token: review.review_token, confirmed: true, confirm_empty: empty, migration_attested: attested });
      if (response) {
        setStatus(await response.json() as PublicationStatus); setReview(null);
        setMessage(review.action === 'activate' ? 'Automatic publication opted in for later saves. HA dispatch is controlled separately.' : 'Immutable snapshot queued. Publication remains pending until separate HA status readback verifies the active revision and checksum.');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Outcome is unverified. Refresh actual state.'); setReview(null); setStale(true); }
    finally { setBusy(false); }
  }
  async function suspend() {
    setBusy(true); setError('');
    try { const response = await post('suspend', {}); if (response) { setStatus(await response.json() as PublicationStatus); setMessage('Automatic publication suspended. Already queued snapshots retain their reviewed content.'); } }
    catch { setError('Unable to verify suspension. Refresh actual state.'); }
    finally { setBusy(false); }
  }
  const fresh = !stale && !status?.actual_stale;
  return <section id="publication" aria-label="Publication status">
    <h2>Publication and active HA snapshot</h2>
    <p>Saving owns the app draft. Publication copies an immutable execution snapshot to HA. It never starts playback or enables dispatch. Tag rename has its own registry readback and outcome.</p>
    {loading && <p role="status">Checking publication state…</p>}
    <button disabled={busy || loading} onClick={() => { setError(''); void refresh(); }}>Refresh publication status</button>
    {status && <>
      <p>Saved app revision: {status.desired_version} · {status.mapping_count} mappings</p>
      <p>{fresh && status.verified ? 'Published: exact saved content verified active in HA.' : 'Pending or unverified: saved content is not confirmed active in HA.'}</p>
      <p>Last verified app publication: {status.active_revision ?? 'none'} · Saved revision at publication: {status.active_desired_version ?? 'none'}</p>
      <p>Actual HA revision: {status.actual?.active_revision ?? 'none'} · Persistence: {status.actual?.persistence ?? 'unknown'}{!fresh && ' · Stale or unavailable'}</p>
      <p>Dispatch: {fresh && status.actual ? (status.actual.dispatch_enabled ? 'enabled in HA' : 'disabled in HA') : 'unknown (status unavailable)'} · Playback: independently unverified</p>
      <p>Automatic publication: {status.automatic_enabled ? 'opted in for later saves' : 'disabled; explicit migration opt-in required'}</p>
      <details><summary>Publication identity and checksums</summary><p>Publisher: <code className="exact-id">{status.publisher_id}</code></p><p>Saved checksum: <code className="exact-id">{status.desired_checksum ?? 'invalid snapshot'}</code></p><p>Actual HA checksum: <code className="exact-id">{status.actual?.active_checksum ?? 'none'}</code></p><p>Checked: {status.checked_at ?? 'never'}</p></details>
      {status.reconciliation_required && <p role="alert">Recovery reconciliation required. Automatic publication is suspended. Preserve protected app and coherent HA backups; compare identities and revisions before reviewed recovery. A matching status alone cannot clear this guard.</p>}
      {status.error && <p role="note">Publication condition: {status.error.replaceAll('_', ' ')}. Saved mappings and last-good metadata are retained.</p>}
      {status.shuffle_conflict && <p role="alert">Conflicting shuffle preferences: the approved HA behavior expects albums unshuffled and playlists shuffled. Review enabled assignments and explicitly edit conflicts before migration activation. Saved preferences have not been changed.</p>}
      {status.pending_removals.length > 0 && <div role="note"><p>Pending removal or disable: the prior HA mapping may still play until a newer snapshot is verified active.</p><ul>{status.pending_removals.map(id => <li key={id}><code className="exact-id">{id}</code></li>)}</ul></div>}
      <ul aria-label="Publication jobs">{status.jobs.slice(0, 8).map(job => <li key={job.revision}>Snapshot {job.revision} · Saved revision {job.desired_version} · {job.state.replaceAll('_', ' ')}</li>)}</ul>
      {manage && <div className="publication-controls"><button ref={reviewButton} disabled={busy || stale || status.actual_stale || status.reconciliation_required} onClick={() => { void begin('publish'); }}>Review snapshot publication</button>
        {status.reconciliation_required && <button disabled={busy || stale || status.actual_stale} onClick={() => { void begin('recover'); }}>Review publication recovery</button>}
        {status.automatic_enabled ? <button disabled={busy} onClick={() => { void suspend(); }}>Suspend automatic publication</button> : <button disabled={busy || stale || !status.verified || status.reconciliation_required || status.shuffle_conflict} onClick={() => { void begin('activate'); }}>Review migration opt-in</button>}</div>}
    </>}
    {review && <section aria-label="Review immutable snapshot"><h3 ref={heading} tabIndex={-1}>{review.action === 'recover' ? 'Review recovery snapshot' : review.action === 'activate' ? 'Review migration opt-in' : 'Review snapshot'}</h3>
      <p>Saved revision {review.desired_version} · {review.mapping_count} mappings · <code className="exact-id">{review.checksum}</code></p>
      <ul>{review.mappings.map(row => <li key={row.tag_id}><code className="exact-id">{row.tag_id}</code><code className="exact-id">{row.spotify_uri}</code><p>{row.enabled ? 'Enabled' : 'Disabled'} · {row.media_type} · Shuffle {row.shuffle ? 'on' : 'off'} · Profile default</p></li>)}</ul>
      {review.action === 'recover' && <p>Recovery publishes reviewed content at a new higher revision. It clears the durable guard only after healthy, exact HA readback. It leaves automatic publication suspended.</p>}
      {review.action === 'activate' && <p>This persistent app opt-in applies to later saves while reconciliation is healthy. Recovery or conflicts suspend it. Complete household migration, backup, single-dispatcher cutover and rollback prerequisites outside this app first.</p>}
      <label className="check-label"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed this exact snapshot and its preferences</label>
      {review.empty && <label className="check-label"><input type="checkbox" checked={empty} onChange={event => setEmpty(event.target.checked)} />I explicitly confirm this empty snapshot removes every HA mapping</label>}
      {review.action === 'activate' && <label className="check-label"><input type="checkbox" checked={attested} onChange={event => setAttested(event.target.checked)} />I attest external migration and cutover prerequisites are complete</label>}
      <button disabled={busy || (status !== null && status.desired_version !== review.desired_version) || !reviewed || (review.empty && !empty) || (review.action === 'activate' && !attested)} onClick={() => { void confirm(); }}>{review.action === 'activate' ? 'Confirm automatic publication opt-in' : review.action === 'recover' ? 'Confirm reviewed recovery' : 'Confirm snapshot publication'}</button>
      <button disabled={busy} onClick={() => { setReview(null); reviewButton.current?.focus(); }}>Cancel publication review</button>
    </section>}
    {(error || statusError) && <p role="alert" ref={feedback} tabIndex={-1}>{error || statusError}</p>}{message && <p role="status" ref={feedback} tabIndex={-1}>{message}</p>}
  </section>;
}
