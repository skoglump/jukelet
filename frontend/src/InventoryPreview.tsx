import { useEffect, useRef, useState } from 'react';
import { Freshness, ItemLabel, useMusicResolution, type Result } from './music';

interface Tag {
  tag_key: string; ha_tag_id: string; name: string | null; last_scanned: string | null;
  last_reader: string | null; state: 'registered' | 'pending_discovery';
}
interface Inventory {
  tags: Tag[]; total: number; registry_available: boolean; stale: boolean;
  updated_at: string | null; discovery_gap: boolean;
}
interface PreviewRow {
  row: number; ha_tag_id: string | null; key_literal: string | null; name: string | null;
  media_content_id: string | null; media_content_type: string | null;
  accepted: boolean; registry_state: string; diagnostics: string[];
}
interface Report {
  schema_version: number; fingerprint: string; source: 'upload' | 'configured';
  source_changed: boolean; registry_updated_at: string | null; registry_stale: boolean;
  counts: Record<'mappings' | 'accepted' | 'rejected', number> & Record<'matched' | 'unassigned' | 'orphaned', number | null>;
  rows: PreviewRow[]; warnings: string[];
}
const labels: Record<string, string> = {
  registry_unavailable: 'Registry unavailable: matching counts are unknown.',
  registry_stale: 'Matching uses a stale registry snapshot.',
  source_changed_review_again: 'Source changed since the previous preview. Review every row again.',
  duplicate_tag_id: 'Duplicate tag ID', invalid_tag_id: 'Unsupported tag ID length or encoding',
  tag_id_must_be_string: 'Tag ID must be a quoted string', template_not_supported: 'Templates are not supported',
  unsupported_media_type: 'Only albums and playlists are supported', invalid_spotify_uri: 'Invalid Spotify URI',
  media_type_mismatch: 'Media type and URI disagree', missing_registry_tag: 'Missing from registry',
  mapping_must_be_object: 'Mapping must be an object', unsupported_mapping_field: 'Unsupported mapping field',
  duplicate_mapping_field: 'Duplicate mapping field',
};
const label = (code: string) => labels[code] ?? code.replaceAll('_', ' ');
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not observed';

function MappingMusic({ row, csrf, onExpired, initial, onResult }: {
  row: PreviewRow; csrf: string; onExpired: () => void; initial: Result | null; onResult: (result: Result) => void;
}) {
  const { preview, error, resolving, resolve } = useMusicResolution(csrf, onExpired, initial, onResult);
  return <div className="mapping-music">
    <p>{row.accepted ? 'Recognized mapping' : 'Rejected mapping'} · Row {row.row}</p>
    {row.name && <p>Legacy source label: {row.name}</p>}
    <p>{row.media_content_type ?? 'Missing media type'}</p>
    <code className="exact-id">{row.media_content_id ?? 'No static URI'}</code>
    {row.diagnostics.length > 0 && <ul>{row.diagnostics.map(code => <li key={code}>{label(code)}</li>)}</ul>}
    {row.accepted && row.media_content_id && (row.media_content_type === 'album' || row.media_content_type === 'playlist') && <>
      <button disabled={resolving} onClick={() => { void resolve(row.media_content_id!, row.media_content_type as 'album' | 'playlist'); }}>
        {resolving ? 'Looking up mapping…' : preview ? 'Refresh mapping metadata' : 'Look up mapping metadata'}
      </button>
      {!preview && !resolving && <p>Music metadata not requested.</p>}
    </>}
    {resolving && <p role="status">Loading mapping metadata…{preview && ' Previous metadata remains below.'}</p>}
    {error && <p role="alert">{error} Mapping retained.{preview && ' Previous metadata retained.'}</p>}
    {preview && <div aria-label="Mapping music metadata">
      <p>Music title</p>
      {preview.item ? <ItemLabel item={preview.item} /> : <p>Title and artwork unavailable. Mapping URI retained above.</p>}
      <Freshness result={preview} />
    </div>}
  </div>;
}

export function InventoryPreview({ csrf, onExpired }: { csrf: string; onExpired: () => void }) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [inventoryOffset, setInventoryOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<(Tag & { snapshot_updated_at: string | null }) | null>(null);
  const [metadata, setMetadata] = useState<Record<string, Result>>({});
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const detailOrigin = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (selected) detailHeading.current?.focus(); }, [selected]);
  const [inventoryError, setInventoryError] = useState(false);
  const [offset, setOffset] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const activePreview = useRef<AbortController | null>(null);
  useEffect(() => () => { activePreview.current?.abort(); }, []);
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
        if (!Array.isArray(result.tags) || typeof result.total !== 'number') throw new Error();
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
  }, [offset, onExpired]);

  async function preview(source: 'upload' | 'configured') {
    activePreview.current?.abort();
    const controller = new AbortController();
    activePreview.current = controller;
    setBusy(true); setError('');
    try {
      if (source === 'upload' && (!file || file.size > 1024 * 1024)) throw new Error('Choose a JSON or YAML file up to 1 MiB.');
      const body = source === 'upload' ? {
        source, format: file!.name.toLowerCase().endsWith('.json') ? 'json' : 'yaml', content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file!.arrayBuffer()),
      } : { source };
      if (controller.signal.aborted) return;
      const response = await fetch('/api/v1/imports/preview', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ ...body, expected_fingerprint: report?.source === source ? report.fingerprint : undefined }),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onExpired(); return; }
      if (!response.ok) {
        const result = await response.json() as { detail?: string };
        throw new Error(typeof result.detail === 'string' ? label(result.detail) : 'Preview unavailable.');
      }
      const result = await response.json() as Report;
      if (!Array.isArray(result.rows) || !result.counts || !Array.isArray(result.warnings)) throw new Error('Invalid preview response.');
      if (!controller.signal.aborted) setReport(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to reach Jukelet.');
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'jukelet-preview-report.json'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const rowsFor = (tag: Tag) => report?.rows.filter(row => row.ha_tag_id === tag.ha_tag_id) ?? [];
  const visibleTags = inventory?.tags.filter(tag => {
    const rows = rowsFor(tag);
    const matchesFilter = filter === 'all' || !report || (filter === 'assigned' ? rows.length > 0 : rows.length === 0);
    const searchable = [tag.name, tag.ha_tag_id, ...rows.flatMap(row => [row.name, row.media_content_id, row.media_content_id ? metadata[row.media_content_id]?.item?.title : null])].join(' ').toLocaleLowerCase();
    return matchesFilter && searchable.includes(query.toLocaleLowerCase());
  }) ?? [];
  const loadedTag = selected && inventory?.tags.find(tag => tag.tag_key === selected.tag_key);
  const currentTag = loadedTag || selected;
  const detailUpdatedAt = loadedTag ? inventory?.updated_at ?? null : selected?.snapshot_updated_at ?? null;
  return <>
    <section id="tags" aria-label="Tag inventory">
      <h2 ref={listHeading} tabIndex={-1}>Tag inventory</h2>
      <p>Browse HA tags and compare them with a legacy source preview. Assignments are not saved, published or playback-verified here.</p>
      <label htmlFor="tag-query">Search this tag page</label>
      <input id="tag-query" type="search" maxLength={512} value={query} onChange={event => setQuery(event.target.value)} placeholder="HA label, exact ID, source label or loaded music title" />
      <label htmlFor="mapping-filter">Mapping filter</label>
      <select id="mapping-filter" value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">All tags</option>
        <option value="assigned" disabled={!report}>Assigned in preview</option>
        <option value="unassigned" disabled={!report}>Unassigned in preview</option>
      </select>
      <p>Filters apply to this page of up to 100 tags. Use the page controls to search other pages. Music titles become searchable after explicit lookup.</p>
      {!report ? <p>Mapping status unknown. Preview a configured source or file to compare assignments.</p>
        : <p>Mapping membership uses the {report.source} preview, including rejected rows. It is not saved app state. {report.registry_stale && 'Preview registry snapshot is stale.'}</p>}
      {error && report && <p>Previous source preview retained after a failed request; mapping filters still use that report.</p>}
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
          {report && <p>{rowsFor(tag).length > 0 ? 'Present in preview mappings' : 'No mapping in this preview'}</p>}
          {rowsFor(tag).map(row => <div key={row.row}>
            <p>{row.accepted ? 'Recognized mapping' : 'Rejected mapping'} · {row.media_content_type}</p>
            <code className="exact-id">{row.media_content_id}</code>
            {row.media_content_id && metadata[row.media_content_id]?.item && <div>
              <p>Music title: {metadata[row.media_content_id].item!.title}</p>
              <Freshness result={metadata[row.media_content_id]} />
            </div>}
          </div>)}
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
        {!report ? <p>Mapping status unknown until a source is previewed.</p> : <>
          <p>Mappings from {report.source} preview. Registry snapshot: {date(report.registry_updated_at)}. {report.registry_stale && 'Snapshot is stale.'}</p>
          {rowsFor(currentTag).length === 0 && <p>Unassigned in this preview. Other sources may differ.</p>}
          {rowsFor(currentTag).map(row => <MappingMusic key={`${report.fingerprint}-${row.row}`} row={row} csrf={csrf} onExpired={onExpired}
            initial={row.media_content_id ? metadata[row.media_content_id] ?? null : null}
            onResult={result => { if (row.media_content_id) setMetadata(previous => Object.fromEntries([...Object.entries(previous).filter(([uri]) => uri !== row.media_content_id), [row.media_content_id!, result]].slice(-128))); }} />)}
        </>}
      </section>}
    </section>
    <section id="legacy" aria-label="Legacy mapping preview">
      <h2>Legacy mapping preview</h2>
      <p>Review the configured automation or upload its JSON/YAML. Preview and report download do not save assignments or change playback.</p>
      <button disabled={busy} onClick={() => { void preview('configured'); }}>Preview configured source</button>
      <label htmlFor="mapping-file">JSON or YAML file (up to 1 MiB)</label>
      <input id="mapping-file" type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" disabled={busy}
        onChange={event => { setFile(event.target.files?.[0] ?? null); }} />
      <button disabled={busy || !file} onClick={() => { void preview('upload'); }}>Preview file</button>
      {busy && <p role="status">Preparing preview…</p>}
      {error && <p role="alert">{error}{report && ' Previous report retained; it does not describe the failed request.'}</p>}
      {report && <div aria-label="Preview report">
        <h3>Preview report · {report.source}</h3>
        <p>Registry snapshot: {date(report.registry_updated_at)}. {report.registry_stale && 'Snapshot is stale.'}</p>
        {report.warnings.map(warning => <p role="status" key={warning}>{label(warning)}</p>)}
        <dl className="counts">{Object.entries(report.counts).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? 'Unknown'}</dd></div>)}</dl>
        <p>Matched, unassigned and orphaned count distinct IDs, including rejected mappings. Accepted/rejected count source rows.</p>
        {report.rows.length === 0 && <p>No mappings in this source.</p>}
        <ol className="tag-list">{report.rows.map(row => <li key={row.row}>
          <strong>Row {row.row}: {row.accepted ? 'Accepted for preview' : 'Rejected'}</strong>
          <code className="exact-id">{row.ha_tag_id ?? row.key_literal ?? '(non-scalar key)'}</code>
          {row.name && <p>{row.name}</p>}
          <p>{row.media_content_type ?? 'Missing media type'} · {row.registry_state}</p>
          <code className="exact-id">{row.media_content_id ?? 'No static URI'}</code>
          <ul>{row.diagnostics.map(code => <li key={code}>{label(code)}</li>)}</ul>
        </li>)}</ol>
        <details><summary>Source fingerprint</summary><code className="exact-id">{report.fingerprint}</code></details>
        <button onClick={download}>Download preview report</button>
      </div>}
    </section>
  </>;
}
