import { useApiFetch } from './sessionAccess';
import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from 'react';
import type { MediaType } from './music';

export interface Assignment {
  tag_key: string; ha_tag_id: string; spotify_uri: string; media_type: MediaType;
  enabled: boolean; shuffle: boolean; playback_profile_id: 'default'; version: number; updated_at: string;
}
interface State { version: number; assignment: Assignment | null }
interface Props { csrf: string; onExpired: () => void }

function validState(value: unknown, tagKey: string, tagId: string): value is State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<State>;
  if (Object.keys(value).length !== 2 || !Number.isSafeInteger(state.version) || Number(state.version) < 0) return false;
  const row = state.assignment;
  if (row === null) return true;
  return Boolean(row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === 9
    && row.tag_key === tagKey && row.ha_tag_id === tagId
    && (row.media_type === 'album' || row.media_type === 'playlist')
    && typeof row.spotify_uri === 'string' && new RegExp(`^spotify:${row.media_type}:[A-Za-z0-9]{22}$`).test(row.spotify_uri)
    && typeof row.enabled === 'boolean' && typeof row.shuffle === 'boolean' && row.playback_profile_id === 'default'
    && row.version === state.version && row.version > 0
    && typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at)));
}

export function AssignmentEditor({ tagKey, tagId, csrf, onExpired, onChanged, onRead }: Props & {
  tagKey: string; tagId: string; onChanged: (assignment: Assignment | null) => void; onRead?: (assignment: Assignment | null) => void;
}) {
  const apiFetch = useApiFetch();
  const id = useId();
  const [state, setState] = useState<State | null>(null);
  const [uri, setUri] = useState('');
  const [type, setType] = useState<MediaType>('album');
  const [enabled, setEnabled] = useState(true);
  const [shuffle, setShuffle] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [reload, setReload] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState('');
  const removeButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const reportRead = useEffectEvent((assignment: Assignment | null) => onRead?.(assignment));
  useEffect(() => { if (message) saveButton.current?.focus(); }, [message]);
  useEffect(() => { if (removing) confirmButton.current?.focus(); }, [removing]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true); setError('');
      try {
        const response = await apiFetch(`tags/${tagKey}/assignment`, { credentials: 'same-origin', signal: controller.signal });
        if (response.status === 401) { onExpired(); return; }
        if (!response.ok) throw new Error();
        const current: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (!validState(current, tagKey, tagId)) throw new Error();
        setState(current); setUri(current.assignment?.spotify_uri ?? ''); setType(current.assignment?.media_type ?? 'album');
        setEnabled(current.assignment?.enabled ?? true); setShuffle(current.assignment?.shuffle ?? false); setConflict(false); setNeedsReload(false); setRemoving(false);
        reportRead(current.assignment);
      } catch { if (!controller.signal.aborted) { setNeedsReload(true); setError('Unable to load the local draft. Previous form retained; reload before editing.'); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [tagKey, tagId, onExpired, reload]);
  async function write(remove = false) {
    if (!state || busy || loading || conflict || needsReload) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await apiFetch(`tags/${tagKey}/assignment`, {
        method: remove ? 'DELETE' : 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify(remove ? { expected_version: state.version } : {
          ha_tag_id: tagId, input: uri, media_type: type, enabled, shuffle, playback_profile_id: 'default', expected_version: state.version,
        }),
      });
      if (response.status === 401) { onExpired(); return; }
      if (response.status === 409) { setConflict(true); setError('Another edit changed this draft. Your form is retained. Reload current draft to review before saving again.'); return; }
      if (response.status === 422) { setError('Check the Spotify URI, media type and preferences. Your form is retained; correct it and save again.'); return; }
      if (!response.ok) throw new Error();
      const current: unknown = await response.json();
      if (!validState(current, tagKey, tagId) || current.version !== state.version + 1
        || (remove ? current.assignment !== null : current.assignment === null)) throw new Error();
      setState(current); setRemoving(false); if (current.assignment) setUri(current.assignment.spotify_uri);
      setMessage(remove ? 'Local draft removed. Check publication status: the prior HA mapping may still play until a newer snapshot is verified active.' : 'Local draft saved. Check publication status: the prior HA mapping may still play until a newer snapshot is verified active.'); onChanged(current.assignment);
    } catch { setNeedsReload(true); setError('Unable to save. Reload current draft to reconcile an uncertain outcome. Your form is retained.'); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void write(); }
  return <section aria-label="Local draft editor" className="draft-editor">
    <h4>Local draft</h4><p>Saving never starts playback. Publication and independent playback verification have separate outcomes. Pending removal or disable may leave the prior HA mapping playable until verified publication.</p>
    {loading && <p role="status">Loading local draft…</p>}
    {state && <p>{state.assignment ? `${state.assignment.enabled ? 'Enabled' : 'Disabled'} draft · Revision ${state.version}` : 'No saved local draft'}</p>}
    <form onSubmit={submit}><fieldset disabled={loading || busy}><legend>Assignment preferences</legend>
      <label htmlFor={`${id}-type`}>Draft media type</label><select id={`${id}-type`} value={type} onChange={event => setType(event.target.value as MediaType)}><option value="album">Album</option><option value="playlist">Playlist</option></select>
      <label htmlFor={`${id}-uri`}>Draft Spotify URI or link</label><input id={`${id}-uri`} required maxLength={512} value={uri} onChange={event => setUri(event.target.value)} />
      <p>A valid URI can be saved even when music metadata is unavailable.</p>
      <label className="check-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Enabled draft</label>
      <label className="check-label"><input type="checkbox" checked={shuffle} onChange={event => setShuffle(event.target.checked)} />Shuffle</label>
      <p>Playback profile: default (local reference only).</p>
      </fieldset><button ref={saveButton} disabled={loading || busy || !state || conflict || needsReload}>{busy ? 'Saving local change…' : 'Save local draft'}</button>
    </form>
    <button disabled={loading || busy} onClick={() => { setReload(value => value + 1); setMessage(''); }}>Reload current draft</button>
    {state?.assignment && <button ref={removeButton} disabled={loading || busy || conflict || needsReload} onClick={() => setRemoving(true)}>Remove local draft</button>}
    {removing && <div role="group" aria-label="Confirm local removal"><p>Remove this local draft? The HA tag remains. The prior HA mapping may still play until a newer snapshot is verified active.</p><button ref={confirmButton} disabled={busy || loading || conflict || needsReload} onClick={() => { void write(true); }}>Confirm removal</button><button disabled={busy} onClick={() => { setRemoving(false); removeButton.current?.focus(); }}>Keep draft</button></div>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}

export function DraftList({ csrf, onExpired, onChanged, revision, manage }: Props & { revision: number; manage: boolean; onChanged: () => void }) {
  const apiFetch = useApiFetch();
  const [page, setPage] = useState<{ assignments: Assignment[]; total: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Assignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (selected) heading.current?.focus(); }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      try {
        const response = await apiFetch(`assignments?offset=${offset}&limit=100`, { credentials: 'same-origin', signal: controller.signal });
        if (response.status === 401) { onExpired(); return; }
        if (!response.ok) throw new Error();
        const result = await response.json() as { assignments: Assignment[]; total: number };
        if (!Array.isArray(result.assignments)) throw new Error();
        if (!controller.signal.aborted) { setPage(result); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [offset, revision, onExpired]);
  return <section id="drafts" aria-label="Saved local drafts"><h2 ref={listHeading} tabIndex={-1}>Saved local drafts</h2>
    <p>All saved mappings, including tags missing from the HA registry. Exact IDs are preserved independently of registry and music availability.</p>
    {loading && <p role="status">Loading saved drafts…</p>}{error && <p role="alert">Unable to refresh drafts. {page ? 'Previous list may be stale.' : 'No local snapshot loaded.'}</p>}
    <button disabled={loading} onClick={onChanged}>Refresh saved drafts</button>
    {page?.total === 0 && <p>No saved local drafts. {manage && 'Choose a tag in the inventory to create one.'}</p>}
    <ul className="tag-list">{page?.assignments.map(row => <li key={row.tag_key}><code className="exact-id">{row.ha_tag_id}</code><code className="exact-id">{row.spotify_uri}</code><p>{row.enabled ? 'Enabled' : 'Disabled'} local draft · Shuffle {row.shuffle ? 'on' : 'off'} · Revision {row.version}</p>
      {manage && <button onClick={event => { origin.current = event.currentTarget; setSelected(row); }}>Edit draft {row.ha_tag_id}</button>}</li>)}</ul>
    <nav aria-label="Draft pages"><button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous drafts</button><button disabled={!page || offset + 100 >= page.total || loading} onClick={() => setOffset(offset + 100)}>Next drafts</button></nav>
    {selected && manage && <section aria-label="Saved draft detail"><button onClick={() => { setSelected(null); if (origin.current?.isConnected) origin.current.focus(); else listHeading.current?.focus(); }}>Back to saved drafts</button><h3 ref={heading} tabIndex={-1}>Edit saved draft</h3><code className="exact-id">{selected.ha_tag_id}</code><AssignmentEditor key={selected.tag_key} tagKey={selected.tag_key} tagId={selected.ha_tag_id} csrf={csrf} onExpired={onExpired} onChanged={onChanged} /></section>}
  </section>;
}
