import { useEffect, useRef, useState } from 'react';
import { AssignmentEditor, type Assignment } from './Assignments';
import { TagName } from './TagName';
import { TagOnboarding } from './TagOnboarding';
import { Freshness, ItemLabel, SpotifyLink, useMusicResolution, type Result } from './music';

interface Tag {
  tag_key: string; ha_tag_id: string; name: string | null; last_scanned: string | null;
  saved_assignment: Assignment | null;
  last_reader: string | null; state: 'registered' | 'pending_discovery';
}
interface Inventory {
  tags: Tag[]; total: number; registry_available: boolean; stale: boolean;
  updated_at: string | null; discovery_gap: boolean;
}
function validSaved(value: unknown): value is Assignment | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<Assignment>;
  return typeof row.ha_tag_id === 'string' && typeof row.tag_key === 'string'
    && typeof row.spotify_uri === 'string' && (row.media_type === 'album' || row.media_type === 'playlist')
    && typeof row.enabled === 'boolean' && typeof row.shuffle === 'boolean'
    && row.playback_profile_id === 'default' && Number.isSafeInteger(row.version) && Number(row.version) > 0;
}
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not observed';

function MappingMusic({ row, csrf, onExpired, initial, onResult }: {
  row: Assignment; csrf: string; onExpired: () => void; initial: Result | null; onResult: (result: Result) => void;
}) {
  const { preview, error, resolving, resolve } = useMusicResolution(csrf, onExpired, initial, onResult);
  return <div className="mapping-music">
    <p>Saved assignment · {row.enabled ? 'enabled mapping' : 'disabled mapping'}</p>
    <p>{row.media_type}</p>
    <code className="exact-id">{row.spotify_uri}</code>
    <>
      <button disabled={resolving} onClick={() => { void resolve(row.spotify_uri, row.media_type); }}>
        {resolving ? 'Looking up mapping…' : preview ? 'Refresh mapping metadata' : 'Look up mapping metadata'}
      </button>
      {!preview && !resolving && <p>Music metadata not requested.</p>}
    </>
    {resolving && <p role="status">Loading mapping metadata…{preview && ' Previous metadata remains below.'}</p>}
    {error && <p role="alert">{error} Mapping retained.{preview && ' Previous metadata retained.'}</p>}
    {preview && <div aria-label="Mapping music metadata">
      <p>Music title</p>
      {preview.item ? <ItemLabel item={preview.item} /> : <p>Title and artwork unavailable. Mapping URI retained above.</p>}
      <Freshness result={preview} />
    </div>}
  </div>;
}

export function Inventory({ csrf, onExpired, manage = false, onDraftChanged = () => undefined }: { csrf: string; onExpired: () => void; manage?: boolean; onDraftChanged?: () => void }) {
  const [onboarding, setOnboarding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  function renamed(key: string, name: string | null) {
    setInventory(previous => previous && ({ ...previous, tags: previous.tags.map(tag => tag.tag_key === key ? { ...tag, name } : tag) }));
    setSelected(previous => previous?.tag_key === key ? { ...previous, name } : previous);
  }
  function assignmentRead(key: string, assignment: Assignment | null) {
    setInventory(previous => previous && ({ ...previous, tags: previous.tags.map(tag => tag.tag_key === key ? { ...tag, saved_assignment: assignment } : tag) }));
    setSelected(previous => previous?.tag_key === key ? { ...previous, saved_assignment: assignment } : previous);
  }
  function assignmentChanged(key: string, assignment: Assignment | null) {
    assignmentRead(key, assignment);
    setRefresh(value => value + 1);
    onDraftChanged();
  }
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [inventoryOffset, setInventoryOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<(Tag & { snapshot_updated_at: string | null }) | null>(null);
  const [metadata, setMetadata] = useState<Record<string, Result>>({});
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const detailOrigin = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { detailHeading.current?.focus(); }, [selected?.tag_key]);
  const [inventoryError, setInventoryError] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      try {
        const response = await fetch(`/api/v1/tags?offset=${offset}&limit=100`, { signal: controller.signal, credentials: 'same-origin' });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onExpired(); return; }
        if (!response.ok) throw new Error();
        const result = await response.json() as Inventory;
        if (!Array.isArray(result.tags) || typeof result.total !== 'number' || !result.tags.every(tag => tag && typeof tag.tag_key === 'string' && typeof tag.ha_tag_id === 'string' && validSaved(tag.saved_assignment) && (!tag.saved_assignment || (tag.saved_assignment.tag_key === tag.tag_key && tag.saved_assignment.ha_tag_id === tag.ha_tag_id)))) throw new Error();
        if (!controller.signal.aborted) { setInventory(result); setInventoryOffset(offset); setInventoryError(false); }
      } catch { if (!controller.signal.aborted) setInventoryError(true); }
      finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = window.setTimeout(() => { void poll(); }, 5000);
        }
      }
    }
    setLoading(true);
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [offset, onExpired, refresh]);

  const visibleTags = inventory?.tags.filter(tag => {
    const saved = tag.saved_assignment;
    const matchesFilter = filter === 'all' || (filter === 'assigned' ? Boolean(saved) : saved === null);
    const searchable = [tag.name, tag.ha_tag_id, saved?.spotify_uri, saved ? metadata[saved.spotify_uri]?.item?.title : null].join(' ').toLocaleLowerCase();
    return matchesFilter && searchable.includes(query.toLocaleLowerCase());
  }) ?? [];
  const loadedTag = selected && inventory?.tags.find(tag => tag.tag_key === selected.tag_key);
  const currentTag = loadedTag || selected;
  const detailUpdatedAt = loadedTag ? inventory?.updated_at ?? null : selected?.snapshot_updated_at ?? null;
  return <>
    <section id="tags" aria-label="Tag inventory">
      <h2 ref={listHeading} tabIndex={-1}>Tag inventory</h2>
      <p>Browse HA tags and saved assignments. Saving, publication, dispatch enablement and playback verification are separate states.</p>
      <button ref={addButton} aria-expanded={onboarding} onClick={() => setOnboarding(true)}>Add tag / unassigned inbox</button>
      {onboarding && <TagOnboarding csrf={csrf} manage={manage} onExpired={onExpired} onRenamed={renamed} onClose={() => { setOnboarding(false); addButton.current?.focus(); }} />}
      <label htmlFor="tag-query">Search this tag page</label>
      <input id="tag-query" type="search" maxLength={512} value={query} onChange={event => setQuery(event.target.value)} placeholder="HA label, exact ID, saved URI or loaded music title" />
      <label htmlFor="mapping-filter">Mapping filter</label>
      <select id="mapping-filter" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">All tags</option>
        <option value="assigned">Has saved assignment</option>
        <option value="unassigned">No saved assignment</option>
      </select>
      <p>Filters apply to this page of up to 100 tags. Use the page controls to search other pages. Music titles become searchable after explicit lookup.</p>
      <p>Filters describe saved assignments, including disabled mappings. They do not describe active HA state; inspect Publication for verified active content.</p>
      {loading && <p role="status">Loading tag inventory…{inventory && ' Previous page remains below.'}</p>}
      {inventoryError && <p role="alert">{inventory ? 'Unable to refresh inventory. Displayed tags may be stale.' : 'Unable to load inventory. No registry snapshot is available.'}</p>}
      {inventory && <>
        {!inventory.registry_available ? <p>Registry unavailable. Connect Home Assistant to load registered tags.</p>
          : <p>{inventory.total} tags. Registry updated: {date(inventory.updated_at)}.</p>}
        {inventory.stale && <p>Inventory is stale or has not been loaded.</p>}
        {inventoryOffset !== offset && <p>Displaying previous page at offset {inventoryOffset}; requested page at offset {offset} has not loaded.</p>}
        {inventory.discovery_gap && <p>Some scans may have been missed; registry reconciliation cannot replay them.</p>}
        {inventory.registry_available && inventory.total === 0 && <p>No registered tags.</p>}
        {inventory.tags.length > 0 && visibleTags.length === 0 && <p>No tags match the filters on this page.</p>}
        <ul className="tag-list">{visibleTags.map(tag => <li key={tag.tag_key}>
          <span className="eyebrow">HA tag label</span><strong>{tag.name ?? 'Unnamed tag'}</strong><code className="exact-id">{tag.ha_tag_id}</code>
          <p>{tag.state === 'pending_discovery' ? 'Pending registry discovery' : 'Registered'} · Last scan: {date(tag.last_scanned)}</p>
          {tag.last_reader && <p>Reader: <code className="exact-id">{tag.last_reader}</code></p>}
          <p>{tag.saved_assignment ? 'Has saved assignment' : 'No saved assignment'}</p>
          {tag.saved_assignment && <div>
            <code className="exact-id">{tag.saved_assignment.spotify_uri}</code>
            {metadata[tag.saved_assignment.spotify_uri]?.item && <div>
              <p>Music title: {metadata[tag.saved_assignment.spotify_uri].item!.title}</p>
              <SpotifyLink item={metadata[tag.saved_assignment.spotify_uri].item!} />
              <Freshness result={metadata[tag.saved_assignment.spotify_uri]} />
            </div>}
          </div>}
          <button aria-label={`View tag ${tag.name ?? 'Unnamed tag'}`} aria-expanded={selected?.tag_key === tag.tag_key}
            onClick={event => { detailOrigin.current = event.currentTarget; setSelected({ ...tag, snapshot_updated_at: inventory?.updated_at ?? null }); }}>View tag</button>
        </li>)}</ul>
        <nav aria-label="Inventory pages">
          <button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous tags</button>{' '}
          <button disabled={offset + 100 >= inventory.total || loading} onClick={() => setOffset(offset + 100)}>Next tags</button>
        </nav>
      </>}
      {currentTag && <section aria-label="Tag detail" className="tag-detail">
        <button onClick={() => { setSelected(null); if (detailOrigin.current?.isConnected) detailOrigin.current.focus(); else listHeading.current?.focus(); }}>Back to tag list</button>
        <p className="eyebrow">HA tag label</p><h3 ref={detailHeading} tabIndex={-1}>{currentTag.name ?? 'Unnamed tag'}</h3>
        <code className="exact-id">{currentTag.ha_tag_id}</code>
        <p>{currentTag.state === 'pending_discovery' ? 'Pending registry discovery' : 'Registered'}</p>
        <p>Last scan: {date(currentTag.last_scanned)}</p><p>Reader: <code className="exact-id">{currentTag.last_reader ?? 'Not observed'}</code></p>
        {(inventoryError || inventory?.stale || !inventory?.tags.some(tag => tag.tag_key === currentTag.tag_key)) && <p>Tag detail uses a stale or previously loaded registry snapshot. Updated: {date(detailUpdatedAt)}.</p>}
        {!currentTag.saved_assignment ? <p>No saved assignment.</p> : <MappingMusic
          key={`${currentTag.tag_key}-${currentTag.saved_assignment.spotify_uri}`}
          row={currentTag.saved_assignment} csrf={csrf} onExpired={onExpired}
          initial={metadata[currentTag.saved_assignment.spotify_uri] ?? null}
          onResult={result => { const uri = currentTag.saved_assignment!.spotify_uri; setMetadata(previous => Object.fromEntries([...Object.entries(previous).filter(([key]) => key !== uri), [uri, result]].slice(-128))); }} />}
        {manage && <TagName key={`name-${currentTag.tag_key}`} tagKey={currentTag.tag_key} tagId={currentTag.ha_tag_id} name={currentTag.name} pending={currentTag.state === 'pending_discovery'} csrf={csrf} onExpired={onExpired} onRenamed={name => renamed(currentTag.tag_key, name)} />}
        {manage && <AssignmentEditor key={currentTag.tag_key} tagKey={currentTag.tag_key} tagId={currentTag.ha_tag_id} csrf={csrf} onExpired={onExpired} onRead={assignment => assignmentRead(currentTag.tag_key, assignment)} onChanged={assignment => assignmentChanged(currentTag.tag_key, assignment)} />}
      </section>}
    </section>
  </>;
}
