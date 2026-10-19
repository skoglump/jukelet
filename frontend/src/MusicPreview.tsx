import { useEffect, useRef, useState, type FormEvent } from 'react';

type MediaType = 'album' | 'playlist';
type Capabilities = Record<string, 'supported' | 'unsupported' | 'unknown'>;
interface Item { uri: string; media_type: MediaType; title: string; subtitle: string | null; artwork_url: string | null }
interface Result {
  uri: string | null; item: Item | null; items: Item[]; total: number | null; next_offset: number | null;
  state: 'fresh' | 'stale' | 'unavailable'; error: string | null; retry_after: number | null;
  last_attempt_at: string | null; last_success_at: string | null;
}
const capabilityNames = ['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search'];
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never';
function Freshness({ result }: { result: Result }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const state = result.state === 'fresh' && result.last_success_at && now - Date.parse(result.last_success_at) >= 300000 ? 'stale' : result.state;
  return <>
    <p>Metadata: {state}. Last success: {date(result.last_success_at)}. Last attempt: {date(result.last_attempt_at)}.</p>
    {result.error && <p role="status">Music lookup: {result.error.replaceAll('_', ' ')}.{result.retry_after ? ` Retry after ${result.retry_after} seconds.` : ''} Lookup availability does not determine playability.</p>}
  </>;
}
function ItemLabel({ item }: { item: Item }) {
  return <>
    {item.artwork_url && <img className="music-artwork" src={item.artwork_url} alt={`Artwork for ${item.title}`} loading="lazy" referrerPolicy="no-referrer" />}
    <strong>{item.title}</strong>{item.subtitle && <p>{item.subtitle}</p>}
    <code className="exact-id">{item.uri}</code>
  </>;
}
async function readResult(response: Response): Promise<Result> {
  const result = await response.json() as Result & { detail?: string };
  if (![200, 503].includes(response.status) || !['fresh', 'stale', 'unavailable'].includes(result.state) || !Array.isArray(result.items)) {
    throw new Error(typeof result.detail === 'string' ? result.detail : 'Music preview unavailable.');
  }
  return result;
}

export function MusicPreview({ csrf, onExpired }: { csrf: string; onExpired: () => void }) {
  const [caps, setCaps] = useState<Capabilities>({});
  const [capsError, setCapsError] = useState(false);
  const [kind, setKind] = useState<MediaType>('album');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'search' | 'library'>('search');
  const [refresh, setRefresh] = useState(0);
  const [offset, setOffset] = useState(0);
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([]);
  const [page, setPage] = useState<{ result: Result; label: string; offset: number } | null>(null);
  const [preview, setPreview] = useState<Result | null>(null);
  const [browseError, setBrowseError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const activeResolve = useRef<AbortController | null>(null);
  const canSearch = caps[`${kind}_search`] === 'supported';
  const canBrowse = caps[`${kind}_library`] === 'supported';
  useEffect(() => () => activeResolve.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      try {
        const response = await fetch('/api/v1/music/capabilities', { credentials: 'same-origin', signal: controller.signal });
        if (response.status === 401) { onExpired(); return; }
        if (!response.ok) throw new Error();
        const value = await response.json() as Capabilities;
        if (!capabilityNames.every(name => ['supported', 'unsupported', 'unknown'].includes(value[name]))) throw new Error();
        if (!controller.signal.aborted) { setCaps(value); setCapsError(false); }
      } catch { if (!controller.signal.aborted) { setCaps({}); setCapsError(true); } }
      finally { if (!controller.signal.aborted) timer = window.setTimeout(() => { void poll(); }, 30000); }
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    if (mode === 'search' ? !canSearch || !query.trim() : !canBrowse) {
      setBrowsing(false);
      return () => controller.abort();
    }
    setBrowsing(true); setBrowseError('');
    const timer = window.setTimeout(() => {
      async function load() {
        try {
          const params = new URLSearchParams({ media_type: kind, ...(mode === 'search' ? { q: query } : { offset: String(offset) }) });
          const response = await fetch(`/api/v1/music/${mode}?${params}`, { credentials: 'same-origin', signal: controller.signal });
          if (response.status === 401) { onExpired(); return; }
          const result = await readResult(response);
          if (!controller.signal.aborted) setPage({ result, label: mode === 'search' ? `${kind} search: ${query}` : `${kind} library`, offset });
        } catch (cause) { if (!controller.signal.aborted) setBrowseError(cause instanceof Error ? cause.message : 'Unable to reach Jukelet.'); }
        finally { if (!controller.signal.aborted) setBrowsing(false); }
      }
      void load();
    }, mode === 'search' ? 350 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [mode, kind, query, offset, canSearch, canBrowse, onExpired, refresh]);

  async function resolve(value: string, mediaType: MediaType) {
    activeResolve.current?.abort();
    const controller = new AbortController();
    activeResolve.current = controller;
    setResolving(true); setPreviewError('');
    try {
      const response = await fetch('/api/v1/music/resolve', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ input: value, media_type: mediaType }),
      });
      if (response.status === 401) { onExpired(); return; }
      const result = await readResult(response);
      if (!controller.signal.aborted) setPreview(result);
    } catch (cause) { if (!controller.signal.aborted) setPreviewError(cause instanceof Error ? cause.message : 'Unable to reach Jukelet.'); }
    finally { if (!controller.signal.aborted) setResolving(false); }
  }
  function resetPages() { setOffset(0); setPreviousOffsets([]); }
  function previousPage() {
    const previous = previousOffsets.at(-1);
    if (previous === undefined) return;
    setPreviousOffsets(previousOffsets.slice(0, -1));
    setOffset(previous);
  }
  function nextPage() {
    if (!page || page.offset !== offset || page.result.next_offset === null) return;
    setPreviousOffsets([...previousOffsets, offset]);
    setOffset(page.result.next_offset);
  }
  function submit(event: FormEvent) { event.preventDefault(); void resolve(input, kind); }
  return <section aria-label="Music preview">
    <h2>Music preview</h2>
    <p>Look up albums and playlists. Previews do not save assignments or start playback. Manual URI preview is always available.</p>
    {capsError && <p role="alert">Music capabilities unavailable. Manual URI preview remains available.</p>}
    <details><summary>Available music features</summary><ul>{capabilityNames.map(name => <li key={name}>
      {name[0].toUpperCase() + name.slice(1).replace('_', ' ')}: {caps[name] === 'supported' ? 'available' : caps[name] === 'unsupported' ? 'unavailable' : 'unknown'}
    </li>)}</ul></details>
    <label htmlFor="music-type">Music type</label>
    <select id="music-type" value={kind} disabled={resolving} onChange={event => { setKind(event.target.value as MediaType); resetPages(); }}>{['album', 'playlist'].map(value => <option value={value} key={value}>{value === 'album' ? 'Album' : 'Playlist'}</option>)}</select>
    <form onSubmit={submit}>
      <label htmlFor="music-uri">Spotify URI or link</label>
      <input id="music-uri" value={input} maxLength={512} required disabled={resolving} onChange={event => setInput(event.target.value)} placeholder="spotify:album:… or https://open.spotify.com/album/…" />
      <button disabled={resolving || !input}>{resolving ? 'Looking up…' : 'Preview URI'}</button>
    </form>
    {previewError && <p role="alert">{previewError}{preview && ' Previous preview retained; it does not describe the failed request.'}</p>}
    {preview && <div aria-label="Selected music preview">
      {preview.item ? <ItemLabel item={preview.item} /> : <code className="exact-id">{preview.uri}</code>}
      <Freshness result={preview} />
    </div>}
    <label htmlFor="music-query">Search music</label>
    <input id="music-query" value={query} maxLength={200} disabled={!canSearch} onChange={event => { setQuery(event.target.value); setMode('search'); resetPages(); }} />
    <button disabled={!canSearch || !query.trim() || browsing} onClick={() => { setMode('search'); resetPages(); setRefresh(value => value + 1); }}>Search again</button>
    {!canSearch && <p>Search unavailable for this music type. Paste a URI or link above.</p>}
    <button disabled={!canBrowse || browsing && mode === 'library'} onClick={() => { setMode('library'); resetPages(); setRefresh(value => value + 1); }}>Browse library</button>
    {!canBrowse && <p>Library unavailable for this music type.</p>}
    {browsing && <p role="status">Loading music… Previous results may refer to another request.</p>}
    {browseError && <p role="alert">{browseError} Previous results retained.</p>}
    {page && <div aria-label="Music results">
      <h3>Results for {page.label} (offset {page.offset})</h3>
      <Freshness result={page.result} />
      {page.result.state === 'fresh' && page.result.items.length === 0 && <p>No music found.</p>}
      <ul className="tag-list">{page.result.items.map((item, index) => <li key={`${item.uri}-${index}`}>
        <ItemLabel item={item} /><button disabled={resolving} onClick={() => { void resolve(item.uri, item.media_type); }}>Preview {item.title}</button>
      </li>)}</ul>
      {mode === 'library' && page.label === `${kind} library` && <nav aria-label="Library pages">
        <button disabled={browsing || previousOffsets.length === 0} onClick={previousPage}>Previous music</button>{' '}
        <button disabled={browsing || page.offset !== offset || page.result.next_offset === null || page.result.error !== null} onClick={nextPage}>Next music</button>
        <p>Up to 20 results per page; browsing stops at offset 1000. No automatic library scrape.</p>
      </nav>}
    </div>}
  </section>;
}
