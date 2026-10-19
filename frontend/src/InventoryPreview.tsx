import { useEffect, useRef, useState } from 'react';

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

export function InventoryPreview({ csrf, onExpired }: { csrf: string; onExpired: () => void }) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
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
        if (!controller.signal.aborted) { setInventory(result); setInventoryError(false); }
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
    const controller = new AbortController();
    activePreview.current = controller;
    setBusy(true); setError('');
    try {
      if (source === 'upload' && (!file || file.size > 1024 * 1024)) throw new Error('Choose a JSON or YAML file up to 1 MiB.');
      const body = source === 'upload' ? {
        source, format: file!.name.toLowerCase().endsWith('.json') ? 'json' : 'yaml', content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file!.arrayBuffer()),
      } : { source };
      const response = await fetch('/api/v1/imports/preview', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ ...body, expected_fingerprint: report?.source === source ? report.fingerprint : undefined }),
      });
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
  return <>
    <section aria-label="Tag inventory">
      <h2>Tag inventory</h2>
      {loading && <p role="status">Loading tag inventory…</p>}
      {inventoryError && <p role="alert">Unable to refresh inventory. Displayed tags may be stale.</p>}
      {inventory && <>
        {!inventory.registry_available ? <p>Registry unavailable. Connect Home Assistant to load registered tags.</p>
          : <p>{inventory.total} tags. Registry updated: {date(inventory.updated_at)}.</p>}
        {inventory.stale && <p>Inventory is stale or has not been loaded.</p>}
        {inventory.discovery_gap && <p>Some scans may have been missed; registry reconciliation cannot replay them.</p>}
        {inventory.registry_available && inventory.total === 0 && <p>No registered tags.</p>}
        <ul className="tag-list">{inventory.tags.map(tag => <li key={tag.tag_key}>
          <strong>{tag.name ?? 'Unnamed tag'}</strong><code className="exact-id">{tag.ha_tag_id}</code>
          <p>{tag.state === 'pending_discovery' ? 'Pending registry discovery' : 'Registered'} · Last scan: {date(tag.last_scanned)}</p>
          {tag.last_reader && <p>Reader: <code>{tag.last_reader}</code></p>}
          {report && <p>{report.rows.some(row => row.ha_tag_id === tag.ha_tag_id) ? 'Present in preview mappings' : 'No mapping in this preview'}</p>}
        </li>)}</ul>
        <nav aria-label="Inventory pages">
          <button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous tags</button>{' '}
          <button disabled={offset + 100 >= inventory.total || loading} onClick={() => setOffset(offset + 100)}>Next tags</button>
        </nav>
      </>}
    </section>
    <section aria-label="Legacy mapping preview">
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
