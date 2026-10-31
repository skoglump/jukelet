import { useApiFetch } from './sessionAccess';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useInputDraft } from './inputDrafts';

export function TagName({ view, tagKey, tagId, name, pending, csrf, onExpired, onRenamed }: {
  view: 'inventory' | 'onboarding'; tagKey: string; tagId: string; name: string | null; pending: boolean; csrf: string;
  onExpired: () => void; onRenamed: (name: string | null) => void;
}) {
  const apiFetch = useApiFetch();
  const id = useId();
  const inputDraft = useInputDraft(JSON.stringify(['tag-name', view, tagKey, tagId]), name ?? '');
  const input = inputDraft.value;
  const [expectedName, setExpectedName] = useState(name);
  const [busy, setBusy] = useState(false);
  const [needsCheck, setNeedsCheck] = useState(inputDraft.restored);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { if (error || message) feedback.current?.focus(); }, [error, message]);

  async function request(check: boolean) {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await apiFetch(`tags/${tagKey}/name`, {
        method: check ? 'GET' : 'PATCH', credentials: 'same-origin', signal: controller.signal,
        ...(!check && { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ ha_tag_id: tagId, expected_name: expectedName, name: input }) }),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onExpired(); return; }
      const result = await response.json() as { name?: string | null; state?: string; detail?: { code?: string; state?: string } };
      if (!response.ok) {
        const code = result.detail?.code;
        const ambiguous = check || result.detail?.state === 'uncertain' || response.status === 409 || (response.status >= 500 && result.detail?.state !== 'rejected');
        setNeedsCheck(ambiguous);
        setError(code === 'forbidden' ? 'Home Assistant denied the rename. Check the deployment credential permissions, then retry rename.'
          : code === 'name_conflict' ? 'The HA name changed since you opened this tag. Check HA name and review before retrying.'
          : ambiguous ? 'Rename outcome is unverified. Check HA name before another rename; your requested name is retained.'
          : 'HA rename failed. Your requested name is retained; retry rename separately.');
        return;
      }
      if ((result.state !== 'verified' && result.state !== 'current') || (typeof result.name !== 'string' && result.name !== null)) throw new Error('Invalid readback');
      setExpectedName(result.name); setNeedsCheck(false); onRenamed(result.name);
      if (!check) inputDraft.clear();
      setMessage(check ? `Current HA name checked: ${result.name ?? 'Unnamed tag'}. Review your requested name before renaming.` : 'HA rename verified by registry readback. Local assignments were not saved.');
    } catch {
      if (!controller.signal.aborted) {
        setNeedsCheck(true);
        setError('Rename outcome is unverified. Check HA name before another rename; your requested name is retained.');
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!needsCheck && !pending) void request(false); }
  return <section aria-label="HA tag name" className="name-editor">
    <h4>Rename in Home Assistant</h4>
    <p>This changes the HA label only. Saved assignments, publication and playback stay separate.</p>
    {pending && <p>Waiting for HA registry discovery before renaming. No tag is created by Jukelet.</p>}
    {inputDraft.restored && needsCheck && <p role="note">Recovered requested name is unsaved. Check HA name before another rename.</p>}
    <form onSubmit={submit}>
      <label htmlFor={id}>Requested HA tag name</label>
      <input id={id} value={input} maxLength={512} required disabled={busy || pending} onChange={event => inputDraft.set(event.target.value)} />
      <p>Expected HA name: {expectedName ?? 'Unnamed tag'}</p>
      <button disabled={busy || pending || needsCheck || !input.trim()}>{busy ? 'Checking HA…' : error ? 'Retry HA rename' : 'Rename HA tag'}</button>{' '}
      <button type="button" disabled={busy || pending} onClick={() => void request(true)}>Check HA name</button>
    </form>
    {busy && <p role="status">{needsCheck ? 'Reading current HA name…' : 'Waiting for HA response and inventory readback…'}</p>}
    {(error || message) && <p ref={feedback} tabIndex={-1} role={error ? 'alert' : 'status'}>{error || message}</p>}
  </section>;
}
