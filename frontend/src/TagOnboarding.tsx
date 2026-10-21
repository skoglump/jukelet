import { useEffect, useRef, useState } from 'react';
import { TagName } from './TagName';

interface Tag {
  tag_key: string; ha_tag_id: string; name: string | null; last_scanned: string | null;
  observed_reader: string | null; observed_at: string | null; state: 'registered' | 'pending_discovery';
  local_assignment: 'unassigned' | 'enabled' | 'disabled' | 'unknown';
}
interface Inbox {
  tags: Tag[]; total: number; registry_available: boolean; stale: boolean; updated_at: string | null;
  discovery_gap: boolean; assignments_available: boolean;
}
const assignmentLabels = { unassigned: 'No local assignment', enabled: 'Enabled local draft', disabled: 'Disabled local draft (still assigned)', unknown: 'Local assignment membership unknown' };
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Unavailable';

export function TagOnboarding({ csrf, manage, onExpired, onClose, onRenamed }: {
  csrf: string; manage: boolean; onExpired: () => void; onClose: () => void;
  onRenamed: (key: string, name: string | null) => void;
}) {
  const [view, setView] = useState('unassigned');
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState<{ data: Inbox; view: string; offset: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Tag | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detail = useRef<HTMLHeadingElement>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { detail.current?.focus(); }, [selected?.tag_key]);
  useEffect(() => {
    const controller = new AbortController(); let timer: number | undefined;
    async function poll() {
      try {
        const response = await fetch(`/api/v1/tags/inbox?view=${view}&offset=${offset}&limit=100`, { credentials: 'same-origin', signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onExpired(); return; }
        if (!response.ok) throw new Error();
        const data = await response.json() as Inbox;
        if (!Array.isArray(data.tags) || typeof data.total !== 'number' || typeof data.assignments_available !== 'boolean') throw new Error();
        if (!controller.signal.aborted) { setLoaded({ data, view, offset }); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = window.setTimeout(() => void poll(), 5000); } }
    }
    setLoading(true); void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [view, offset, refresh, onExpired]);
  const data = loaded?.data;
  const current = (selected && data?.tags.find(tag => tag.tag_key === selected.tag_key)) || selected;
  function renamed(key: string, name: string | null) {
    setLoaded(previous => previous && ({ ...previous, data: { ...previous.data, tags: previous.data.tags.map(tag => tag.tag_key === key ? { ...tag, name } : tag) } }));
    setSelected(previous => previous?.tag_key === key ? { ...previous, name } : previous);
    onRenamed(key, name);
  }
  return <section aria-label="Tag onboarding" className="tag-onboarding">
    <button onClick={onClose}>Close onboarding</button>
    <h3 ref={heading} tabIndex={-1}>Add tag and unassigned inbox</h3>
    <p>Use an existing HA reader to observe a scan. Jukelet observes discovery only; HA continues to own scan handling.</p>
    <p>Unassigned means no saved local draft, across the complete inventory. Disabled drafts remain assigned. Legacy preview membership is separate; an unassigned tag may already have legacy playback.</p>
    <label htmlFor="inbox-view">Discovery view</label>
    <select id="inbox-view" value={view} onChange={event => { setView(event.target.value); setOffset(0); }}>
      <option value="unassigned">Unassigned inbox</option><option value="observed">Observed scans</option>
    </select>{' '}
    <button disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh discovery</button>
    <p>Observed scans show the latest event per tag seen during this app process. Existing registered tags are not evidence of a newly observed scan.</p>
    {loading && <p role="status">Loading discovery…{data && ' Previous snapshot remains below.'}</p>}
    {error && <p role="alert">{data ? 'Discovery refresh failed. Retained registry and local membership may be stale.' : 'Discovery unavailable. Registry and local membership are unknown.'}</p>}
    {data && <>
      <p>Registry updated: {date(data.updated_at)}.</p>
      {!data.registry_available && <p>Registry unavailable; observed tags may still be pending discovery.</p>}
      {data.stale && <p>Registry snapshot is stale. Names and registration may have changed.</p>}
      {!data.assignments_available && <p role="alert">Local assignment membership is unknown. These tags are not confirmed unassigned.</p>}
      {(loaded.view !== view || loaded.offset !== offset) && <p>Showing previous {loaded.view} snapshot at offset {loaded.offset}; requested view has not loaded.</p>}
      {data.discovery_gap && <p>Scans may have been missed while disconnected. Registry reconciliation recovers tags, not historical scan events.</p>}
      {data.total === 0 && <p>{view === 'observed' ? 'No scans observed by this app. Waiting for a reader event; discovery refreshes automatically.' : 'No tags without local assignments in this snapshot.'}</p>}
      <ul className="tag-list">{data.tags.map(tag => <li key={tag.tag_key}>
        <strong>{tag.name ?? 'Unnamed tag'}</strong><code className="exact-id">{tag.ha_tag_id}</code>
        <p>{tag.state === 'pending_discovery' ? 'Pending registry discovery' : 'Registered tag'}</p>
        <p>{assignmentLabels[tag.local_assignment]}</p>
        {tag.observed_at ? <p>Observed by this app: {date(tag.observed_at)} · Reader: <code className="exact-id">{tag.observed_reader ?? 'Not provided'}</code></p> : <p>No scan observed by this app.</p>}
        {!tag.observed_at && tag.last_scanned && <p>HA registry last scan: {date(tag.last_scanned)}. Reader not observed.</p>}
        <button aria-label={`Choose discovered tag ${tag.name ?? 'Unnamed tag'}`} onClick={event => { origin.current = event.currentTarget; setSelected(tag); }}>Choose tag</button>
      </li>)}</ul>
      <nav aria-label="Discovery pages">
        <button disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 100))}>Previous discoveries</button>{' '}
        <button disabled={offset + 100 >= data.total || loading} onClick={() => setOffset(value => value + 100)}>Next discoveries</button>
      </nav>
    </>}
    {current && <section aria-label="Discovered tag" className="tag-detail">
      <button onClick={() => { setSelected(null); if (origin.current?.isConnected) origin.current.focus(); else heading.current?.focus(); }}>Back to discoveries</button>
      <h4 ref={detail} tabIndex={-1}>{current.name ?? 'Unnamed tag'}</h4><code className="exact-id">{current.ha_tag_id}</code>
      <p>{current.state === 'pending_discovery' ? 'Pending registry discovery' : 'Registered tag'}</p>
      <p>{assignmentLabels[current.local_assignment]}{error && ' (retained snapshot may be stale)'}</p>
      {(!data?.tags.some(tag => tag.tag_key === current.tag_key) || error || data?.stale) && <p>This selection uses a retained discovery snapshot.</p>}
      {manage ? <TagName key={current.tag_key} tagKey={current.tag_key} tagId={current.ha_tag_id} name={current.name} pending={current.state === 'pending_discovery'} csrf={csrf} onExpired={onExpired} onRenamed={name => renamed(current.tag_key, name)} />
        : <p>Renaming requires APP_MODE=manage. Discovery is read-only.</p>}
      <p>Assignment editing is separate in tag detail. This onboarding flow does not save assignments or publish playback.</p>
    </section>}
  </section>;
}
