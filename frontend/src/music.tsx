import { useEffect, useRef, useState } from 'react';

export type MediaType = 'album' | 'playlist';
export interface Item { uri: string; media_type: MediaType; title: string; subtitle: string | null; artwork_url: string | null }
export interface Result {
  uri: string | null; item: Item | null; items: Item[]; total: number | null; next_offset: number | null;
  state: 'fresh' | 'stale' | 'unavailable'; error: string | null; retry_after: number | null;
  last_attempt_at: string | null; last_success_at: string | null;
}
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never';
export function Freshness({ result }: { result: Result }) {
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
export function ItemLabel({ item }: { item: Item }) {
  return <>
    {item.artwork_url && <img className="music-artwork" src={item.artwork_url} alt={`Artwork for ${item.title}`} loading="lazy" referrerPolicy="no-referrer" />}
    <strong>{item.title}</strong>{item.subtitle && <p>{item.subtitle}</p>}
    <code className="exact-id">{item.uri}</code>
  </>;
}
type ResponseFailure = 'request_rejected' | 'unavailable' | 'unsupported_response';
class MusicResponseError extends Error {
  constructor(message: string, readonly category: ResponseFailure) { super(message); }
}
export async function readResult(response: Response): Promise<Result> {
  let body: unknown;
  try { body = await response.json(); }
  catch {
    if ([200, 503].includes(response.status)) throw new MusicResponseError('Music preview returned an invalid response.', 'unsupported_response');
    body = null;
  }
  const result = body as Result & { detail?: string };
  if (![200, 503].includes(response.status)) {
    throw new MusicResponseError(typeof result?.detail === 'string' ? result.detail : 'Music preview request failed.',
      response.status >= 400 && response.status < 500 ? 'request_rejected' : 'unavailable');
  }
  if (!result || !['fresh', 'stale', 'unavailable'].includes(result.state) || !Array.isArray(result.items)) {
    throw new MusicResponseError('Music preview returned an invalid response.', 'unsupported_response');
  }
  return result;
}

export function useMusicResolution(csrf: string, onExpired: () => void, initial: Result | null = null,
  onResult?: (result: Result) => void) {
  const [preview, setPreview] = useState<Result | null>(initial);
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState(false);
  const active = useRef<AbortController | null>(null);
  // Keep a bounded set of server-accepted aliases for the current canonical result.
  // Never infer equivalence by reparsing links or keep aliases across different resources.
  const displayedIdentity = useRef<{ uri: string | null; inputs: string[]; mediaType: MediaType } | null>(
    initial?.uri && initial.item ? { uri: initial.uri, inputs: [], mediaType: initial.item.media_type } : null,
  );
  useEffect(() => () => active.current?.abort(), []);
  async function resolve(value: string, mediaType: MediaType) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setResolving(true); setError('');
    let receivedResponse = false;
    try {
      const response = await fetch('/api/v1/music/resolve', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ input: value, media_type: mediaType }),
      });
      receivedResponse = true;
      if (controller.signal.aborted) return;
      if (response.status === 401) { onExpired(); return; }
      const result = await readResult(response);
      if (controller.signal.aborted) return;
      // A failed refresh must retain the last good display for this exact URI.
      const retained = result.error && !result.item && preview?.uri === result.uri && preview.item
        ? { ...result, item: preview.item, state: 'stale' as const, last_success_at: preview.last_success_at } : result;
      const identity = displayedIdentity.current;
      const aliases = result.uri && identity?.uri === result.uri && identity.mediaType === mediaType
        ? identity.inputs.filter(input => input !== value) : [];
      displayedIdentity.current = { uri: result.uri, inputs: [...aliases, value].slice(-8), mediaType };
      setPreview(retained); onResult?.(retained);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Unable to reach Jukelet.');
        const category = cause instanceof MusicResponseError ? cause.category : receivedResponse ? 'unsupported_response' : 'network_unavailable';
        const identity = displayedIdentity.current;
        const sameRequest = identity?.mediaType === mediaType && (identity.uri === value || identity.inputs.includes(value));
        if (preview && sameRequest && category !== 'request_rejected') {
          const stale = { ...preview, state: preview.last_success_at ? 'stale' as const : 'unavailable' as const,
            error: category, last_attempt_at: new Date().toISOString(), retry_after: null };
          setPreview(stale); onResult?.(stale);
        }
      }
    } finally { if (!controller.signal.aborted) setResolving(false); }
  }
  return { preview, error, resolving, resolve };
}
