import { apiFetch } from './urls';
import { useEffect, useState } from 'react';

interface Attempt {
  correlation_id: string; snapshot_revision: number; requested_at: string; completed_at: string | null;
  invocation: string; execution: string; error: string | null;
}
export interface PlaybackObservation {
  connection: string; checked_at: string | null; stale: boolean; error: string | null;
  diagnostics: {
    diagnostics_version: 1; started_at: string; observed_at: string; dispatch_enabled: boolean;
    ready: boolean; readiness_error: string | null; busy: boolean; execution_uncertain: boolean;
    pause_reason: string | null; last_scan_at: string | null; last_attempt: Attempt | null;
    diagnostics: { observed_at: string; reason: string }[]; playback_verification: 'unavailable';
  } | null;
}
const readiness: Record<string, string> = {
  snapshot_unavailable: 'No healthy execution snapshot is available. Review Publication and ask an HA administrator to check companion persistence.',
  snapshot_invalid: 'The execution snapshot is invalid. Ask an HA administrator to inspect companion health before any recovery.',
  preference_conflict: 'Published shuffle preferences conflict with the supported media rules. Review the authoritative assignments and publication.',
  profile_unconfigured: 'No local playback profile is configured. Ask an HA administrator to configure the reviewed startup script.',
  script_unavailable_or_running: 'The configured startup script is unavailable or already running. Ask an HA administrator to inspect its availability, single mode and actual execution state.',
  shutting_down: 'The companion is stopping. Wait for HA to finish restarting, then inspect fresh status.',
  execution_uncertain: 'Previous startup work may still be running. An HA administrator must establish that all prior startup work, including nested or external work, has stopped before explicit reconciliation. Reconciliation leaves dispatch disabled; enable is a separate step.',
};
const failures: Record<string, string> = {
  readiness_failed: 'Preparation reported that readiness failed. Ask an HA administrator to inspect the configured preparation conditions and the correlated script trace.',
  account_failed: 'Preparation reported an account failure. Ask an HA administrator to inspect the configured account preparation and correlated script trace.',
  transfer_failed: 'The script reported a transfer failure. Ask an HA administrator to inspect the configured target and correlated script trace.',
  playback_failed: 'The script reported a playback request failure. Ask an HA administrator to inspect the correlated script trace and provider state.',
  completion_unavailable: 'Outcome unknown: HA returned without correlated completion. The reason is unknown; inspect the correlated script trace. Do not retry blindly.',
  invalid_completion: 'Outcome unknown: completion was malformed or did not match this attempt. No specific preparation failure can be established.',
  timeout: 'Outcome unknown: the waiting deadline expired. This does not prove that startup or external effects stopped.',
  script_failed: 'HA reported a script error. The underlying preparation reason is unknown and partial effects may have occurred.',
  transport_error: 'Outcome unknown: execution transport failed. Inspect actual HA state before any recovery.',
  execution_cancelled: 'Outcome unknown: the execution waiter was cancelled. This does not prove startup work stopped.',
  execution_error: 'Outcome unknown: execution could not be confirmed. Inspect actual HA state before any recovery.',
  disabled: 'The adapter rejected this attempt because the mapping was disabled; execution was not started.',
  profile_unconfigured: 'The adapter rejected this attempt because the profile was unconfigured; execution was not started.',
  script_unavailable: 'The adapter rejected this attempt because the selected script was absent; execution was not started.',
};
const reasons: Record<string, string> = {
  ignored_disabled: 'Scan ignored while dispatch was disabled', ignored_busy: 'Scan ignored while startup was busy; it will not be replayed',
  ignored_duplicate: 'Rapid duplicate scan suppressed', rejected_event: 'Malformed scan rejected',
  rejected_mapping: 'Scan rejected: no enabled mapping', invocation_requested: 'Startup invocation requested',
  execution_result: 'Startup result received', execution_error: 'Startup result unknown', execution_cancelled: 'Startup waiter cancelled',
};
const showTime = (at: string) => new Date(at).toLocaleString();

export function PlaybackStatus({ onExpired }: { onExpired: () => void }) {
  const [status, setStatus] = useState<PlaybackObservation | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(clock);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let expired = false;
    void (async () => {
      setLoading(true);
      try {
        const response = await apiFetch('playback-status', { signal: controller.signal, credentials: 'same-origin' });
        if (controller.signal.aborted) return;
        if (response.status === 401) { expired = true; onExpired(); return; }
        if (!response.ok) throw new Error('Unavailable status');
        const result = await response.json() as PlaybackObservation;
        if (!result || typeof result.stale !== 'boolean' || typeof result.connection !== 'string' ||
          (result.diagnostics && (result.diagnostics.diagnostics_version !== 1 || !Array.isArray(result.diagnostics.diagnostics)))) throw new Error('Invalid status');
        if (!controller.signal.aborted) { setStatus(result); setFailed(false); setNow(Date.now()); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally {
        if (!controller.signal.aborted && !expired) {
          setLoading(false);
          timer = window.setTimeout(() => setRefresh(value => value + 1), 10_000);
        }
      }
    })();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [refresh, onExpired]);
  const diagnostic = status?.diagnostics;
  const age = status?.checked_at ? now - Date.parse(status.checked_at) : NaN;
  const sourceAge = diagnostic ? now - Date.parse(diagnostic.observed_at) : NaN;
  const fresh = !failed && !status?.stale && status?.connection === 'connected' &&
    Number.isFinite(age) && age >= -5_000 && age <= 30_000 && Number.isFinite(sourceAge) && sourceAge >= -5_000 && sourceAge <= 30_000;
  const attempt = diagnostic?.last_attempt;
  return <section id="playback" aria-label="Tag playback readiness">
    <h2>Tag playback readiness</h2>
    <p>HA connection and published content do not establish playback readiness. Publication is shown separately above. Playback: independently unverified.</p>
    <p>HA administrator controls: Settings → Devices &amp; services → Jukelet bridge → Configure → Inspect and control tag playback. Refresh actual state there; verify no other tag-playback dispatcher is active before enabling. Reconcile uncertainty separately only after all previous startup work, including nested and external work, has stopped. Script entities being off alone is insufficient. App sign-in grants no HA administrator authority.</p>
    <button disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh playback status</button>
    {loading && !status && <p role="status">Checking playback readiness…</p>}
    {(!fresh && (status || failed)) && <p role="status">Current playback readiness unknown. Diagnostics are stale or unavailable; an earlier success does not establish current health. Check the HA connection and companion, then refresh.</p>}
    {status && <p>App-to-HA connection at last check: {status.connection.replaceAll('_', ' ')}. Status checked: {status.checked_at ? showTime(status.checked_at) : 'never'}.</p>}
    {!diagnostic ? <p>No supported companion diagnostics available. Check the companion installation/version and HA permission; the reason for any missing scan or startup outcome is unknown.</p> : <>
      <p>Dispatch: {fresh ? diagnostic.dispatch_enabled ? 'enabled' : 'disabled' : 'unknown (stale or unavailable)'}. Readiness: {fresh ? diagnostic.ready ? 'ready at observation' : 'not ready at observation' : 'unknown'}.</p>
      {fresh && diagnostic.busy ? <p role="status">Startup is busy. Additional scans are ignored with no queue or replay. Wait for completion and refresh; a temporary execution fence during the attempt is expected.</p> : fresh && diagnostic.execution_uncertain ? <p role="note">{readiness.execution_uncertain} Do not scan again or retry blindly.</p> : fresh && diagnostic.readiness_error ? <p role="note">{readiness[diagnostic.readiness_error] ?? 'Readiness reason unknown. Ask an HA administrator to inspect the companion.'}</p> : null}
      {fresh && !diagnostic.dispatch_enabled && !diagnostic.busy && <p>{diagnostic.pause_reason === 'startup' ? 'No healthy remembered enable choice was restored at startup. Healthy matching enabled or disabled choices are remembered across restarts; uncertainty is never replayed.' : diagnostic.pause_reason === 'administrator_disabled' ? 'Dispatch was deliberately left disabled by an administrator.' : 'Dispatch is paused; a healthy snapshot alone does not enable it.'} Ask an HA administrator to review readiness and verify that no other tag-playback dispatcher is active before a separate deliberate enable. This screen only inspects status.</p>}
      <p>Companion observation: {showTime(diagnostic.observed_at)}. Diagnostic window began: {showTime(diagnostic.started_at)}.</p>
      <p>{diagnostic.last_scan_at ? `Last scan observed by this companion: ${showTime(diagnostic.last_scan_at)}.` : 'No scan observed by this companion since it loaded.'} Missing scan information does not prove a reader is offline. Check the intended reader and HA tag event path; scans during disconnection or before this window may be unknown.</p>
      {attempt ? <div aria-label="Most recent startup attempt"><h3>Most recent startup attempt (historical)</h3>
        <p>Requested: {showTime(attempt.requested_at)}. {attempt.completed_at ? `Result observed: ${showTime(attempt.completed_at)}.` : 'No result observed yet.'}</p>
        <p>Invocation: {attempt.invocation}. Execution: {attempt.execution}. {attempt.execution === 'finished' ? 'The script reported completion; this does not independently verify playback.' : attempt.error ? failures[attempt.error] ?? 'The specific failure reason is unknown. Ask an HA administrator to inspect the correlated trace.' : 'Startup outcome is still unknown.'}</p>
        <p>Snapshot revision: {attempt.snapshot_revision}. Correlation: <code className="exact-id">{attempt.correlation_id}</code>.</p>
      </div> : <p>No startup attempt retained in this diagnostic window.</p>}
      <details><summary>Recent diagnostic observations</summary><p>At most 32 observations plus the latest attempt, held in memory. This is not a complete durable scan audit. Restart/reload clears the window. No scans are retried by inspection.</p>
        <ul>{diagnostic.diagnostics.slice(-32).map((row, index) => <li key={index}>{showTime(row.observed_at)} · {reasons[row.reason] ?? (readiness[row.reason] ? 'Readiness condition observed; inspect current readiness above' : 'Diagnostic reason unavailable')}</li>)}</ul>
      </details>
    </>}
  </section>;
}
