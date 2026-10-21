// Development-only normalized DTO fixtures. This plugin never contacts a backend or HA.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Assignment } from '../src/Assignments.tsx';
import type { Plugin } from 'vite';

const uri = 'spotify:album:0123456789ABCDEFGHIJKL';
const playlistUri = 'spotify:playlist:ABCDEFGHIJKL0123456789';
const stamp = () => new Date().toISOString();
const tags = [
  { tag_key: 'fixture-album', ha_tag_id: '  Synthetic:Å/04:AB  ', name: 'Kitchen token', last_scanned: '2026-10-19T12:00:00Z', last_reader: 'synthetic-reader', state: 'registered' },
  { tag_key: 'fixture-empty', ha_tag_id: 'synthetic-unassigned', name: 'Empty token', last_scanned: null, last_reader: null, state: 'registered' },
  { tag_key: 'fixture-rejected', ha_tag_id: 'synthetic-track', name: 'Needs review token', last_scanned: null, last_reader: null, state: 'registered' },
  { tag_key: 'fixture-pending', ha_tag_id: 'synthetic-pending', name: 'Newly observed token', last_scanned: '2026-10-19T12:01:00Z', last_reader: 'synthetic-reader', state: 'pending_discovery' },
];
for (const tag of tags) tag.tag_key = createHash('sha256').update(tag.ha_tag_id).digest('hex');
const rows = [
  { row: 1, ha_tag_id: tags[0].ha_tag_id, key_literal: null, name: 'Legacy album label', media_content_id: uri, media_content_type: 'album', accepted: true, registry_state: 'matched', diagnostics: [] },
  { row: 2, ha_tag_id: tags[2].ha_tag_id, key_literal: null, name: null, media_content_id: 'spotify:track:0123456789ABCDEFGHIJKL', media_content_type: 'track', accepted: false, registry_state: 'matched', diagnostics: ['unsupported_media_type'] },
  { row: 3, ha_tag_id: 'synthetic-orphan', key_literal: null, name: 'Missing registry token', media_content_id: playlistUri, media_content_type: 'playlist', accepted: true, registry_state: 'orphaned', diagnostics: ['missing_registry_tag'] },
];
const item = (type: string, title = 'Northern lights fixture') => ({
  uri: type === 'album' ? uri : playlistUri, media_type: type, title, subtitle: 'Synthetic artist / owner', artwork_url: '/fixture-artwork.svg',
});
const result = (fields: Record<string, unknown> = {}) => ({
  uri: null, item: null, items: [], total: null, next_offset: null, state: 'fresh', error: null, retry_after: null, last_success_at: stamp(), last_attempt_at: stamp(), ...fields,
});
const scenarios = ['normal', 'metadata-failure', 'upstream-unauthorized', 'empty', 'unsupported', 'failed', 'stale', 'app-unauthorized', 'manage', 'onboarding-registered', 'rename-forbidden', 'rename-uncertain', 'assignments-unavailable'];

export function managerFixtures(): Plugin {
  let scenario = 'normal';
  let authenticated = false;
  let manage = false;
  let drafts: Record<string, Assignment> = {};
  let versions: Record<string, number> = {};
  let revision = 0;
  let previewRevision = 0;
  let pendingRegistered = false;
  let names: Record<string, string | null> = {};
  let uncertain = new Set<string>();
  const discoveryTags = () => tags.map(tag => ({ ...tag, name: Object.hasOwn(names, tag.tag_key) ? names[tag.tag_key] : tag.name,
    state: tag.state === 'pending_discovery' && pendingRegistered ? 'registered' : tag.state,
    observed_reader: tag.last_reader,
    observed_at: tag.last_reader ? tag.last_scanned : null,
    local_assignment: scenario === 'assignments-unavailable' ? 'unknown' : drafts[tag.tag_key] ? drafts[tag.tag_key].enabled ? 'enabled' : 'disabled' : 'unassigned',
  }));
  return {
    name: 'isolated-manager-fixtures',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (path === '/fixture-artwork.svg') {
          response.setHeader('Content-Type', 'image/svg+xml');
          response.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#365447"/><circle cx="80" cy="80" r="52" fill="#eadcbe"/><circle cx="80" cy="80" r="17" fill="#365447"/></svg>'); return;
        }
        if (!path.startsWith('/api/') && !path.startsWith('/__fixtures/') && !path.startsWith('/health/')) { next(); return; }
        void handle(request, response).catch(() => { response.statusCode = 400; response.end('{"detail":"invalid_fixture_request"}'); });
      });
    },
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (data: unknown, status = 200) => { response.statusCode = status; response.end(JSON.stringify(data)); };
    async function body(): Promise<Record<string, string>> {
      let text = '';
      for await (const chunk of request) { text += String(chunk); if (text.length > 8192) throw new Error('fixture body too large'); }
      return JSON.parse(text) as Record<string, string>;
    }
    if (url.pathname === '/__fixtures/state' && request.method === 'POST') {
      const state = await body();
      if (!scenarios.includes(state.scenario)) { send({ detail: 'unknown_fixture_scenario' }, 422); return; }
      scenario = state.scenario;
      if (scenario === 'onboarding-registered') pendingRegistered = true;
      if (state.reset === 'yes') { authenticated = false; manage = state.scenario === 'manage'; drafts = {}; versions = {}; revision = 0; pendingRegistered = false; names = {}; uncertain = new Set(); }
      send({ scenario, synthetic: true }); return;
    }
    if (url.pathname === '/api/v1/session') {
      if (request.method === 'DELETE') { authenticated = false; response.statusCode = 204; response.end(); return; }
      if (request.method === 'POST') { await body(); authenticated = true; }
      if (!authenticated || scenario === 'app-unauthorized') { send({}, 401); return; }
      send({ authenticated: true, mode: manage ? 'manage' : 'read_only', expires_at: new Date(Date.now() + 3600000).toISOString(), csrf_token: 'synthetic-fixture-csrf' }); return;
    }
    if (!authenticated || scenario === 'app-unauthorized') { send({}, 401); return; }
    const namePath = /^\/api\/v1\/tags\/([^/]+)\/name$/.exec(url.pathname);
    if (namePath) {
      const tag = discoveryTags().find(tag => tag.tag_key === namePath[1]);
      if (!tag || tag.state !== 'registered') { send({ detail: { code: 'not_registered' } }, 404); return; }
      if (request.method === 'GET') { uncertain.delete(tag.tag_key); send({ tag_key: tag.tag_key, name: tag.name, state: 'current' }); return; }
      if (request.method !== 'PATCH' || !manage) { send({}, 403); return; }
      const input = await body();
      if (uncertain.has(tag.tag_key)) { send({ detail: { code: 'reconciliation_required', state: 'uncertain' } }, 409); return; }
      if (scenario === 'rename-forbidden') { send({ detail: { code: 'forbidden', state: 'rejected' } }, 403); return; }
      if (input.expected_name !== tag.name) { send({ detail: { code: 'name_conflict', state: 'conflict' } }, 409); return; }
      if (input.name === tag.name) { send({ tag_key: tag.tag_key, name: tag.name, state: 'verified' }); return; }
      names[tag.tag_key] = input.name;
      if (scenario === 'rename-uncertain') { uncertain.add(tag.tag_key); send({ detail: { code: 'timeout', state: 'uncertain' } }, 503); return; }
      send({ tag_key: tag.tag_key, name: input.name, state: 'verified' }); return;
    }
    if (url.pathname === '/api/v1/tags/inbox') {
      if (scenario === 'failed') { send({}, 503); return; }
      let discovered = scenario === 'empty' ? [] : discoveryTags();
      discovered = url.searchParams.get('view') === 'observed' ? discovered.filter(tag => tag.observed_at).sort((a, b) => b.observed_at!.localeCompare(a.observed_at!)) : discovered.filter(tag => ['unassigned', 'unknown'].includes(tag.local_assignment));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      send({ tags: discovered.slice(offset, offset + 100), total: discovered.length, assignments_available: scenario !== 'assignments-unavailable', registry_available: true, stale: scenario === 'stale', updated_at: '2026-10-21T12:02:00Z', discovery_gap: scenario === 'onboarding-registered' }); return;
    }
    if (url.pathname === '/api/v1/assignments') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      send({ assignments: Object.values(drafts).slice(offset, offset + 100), total: Object.keys(drafts).length, revision }); return;
    }
    const draftPath = /^\/api\/v1\/tags\/([^/]+)\/assignment$/.exec(url.pathname);
    if (draftPath) {
      const key = draftPath[1];
      if (request.method === 'GET') { send({ version: versions[key] ?? 0, assignment: drafts[key] ?? null }); return; }
      if (!manage) { send({}, 403); return; }
      const input = await body();
      if (Number(input.expected_version) !== (versions[key] ?? 0)) { send({ detail: { current_version: versions[key] ?? 0 } }, 409); return; }
      versions[key] = (versions[key] ?? 0) + 1; revision++;
      if (request.method === 'DELETE') delete drafts[key];
      else drafts[key] = { tag_key: key, ha_tag_id: input.ha_tag_id, spotify_uri: input.input, media_type: input.media_type as 'album' | 'playlist', enabled: Boolean(input.enabled), shuffle: Boolean(input.shuffle), playback_profile_id: 'default', version: versions[key], updated_at: stamp() };
      send({ version: versions[key], assignment: drafts[key] ?? null }); return;
    }
    if (url.pathname === '/api/v1/imports/confirm') {
      const input = await body();
      if (!manage) { send({}, 403); return; }
      if (previewRevision !== revision) { send({}, 409); return; }
      const accepted = rows.filter(row => row.accepted);
      const existing = accepted.some(row => drafts[createHash('sha256').update(row.ha_tag_id).digest('hex')]);
      if (existing && input.conflict_policy === 'reject') { send({}, 409); return; }
      let imported = 0, skipped = 0;
      for (const row of accepted) {
        const key = createHash('sha256').update(row.ha_tag_id).digest('hex');
        if (drafts[key] && input.conflict_policy === 'skip') { skipped++; continue; }
        versions[key] = (versions[key] ?? 0) + 1;
        drafts[key] = { tag_key: key, ha_tag_id: row.ha_tag_id, spotify_uri: row.media_content_id, media_type: row.media_content_type as 'album' | 'playlist', enabled: Boolean(input.enabled), shuffle: Boolean(input.shuffle), playback_profile_id: 'default', version: versions[key], updated_at: stamp() }; imported++;
      }
      revision++; send({ imported, skipped }); return;
    }
    if (url.pathname === '/api/v1/status') {
      send({ connection: scenario === 'upstream-unauthorized' ? 'unauthorized' : 'connected', version: 'synthetic-fixture', tag_list: 'supported', scan_subscription: 'supported', subscribed: true, services: {}, inventory_stale: scenario === 'stale', inventory_updated_at: stamp(), services_updated_at: stamp(), discovery_gap: false, error: scenario === 'upstream-unauthorized' ? 'unauthorized' : null }); return;
    }
    if (url.pathname === '/api/v1/tags') {
      if (scenario === 'failed') { send({}, 503); return; }
      send({ tags: scenario === 'empty' ? [] : discoveryTags(), total: scenario === 'empty' ? 0 : tags.length, registry_available: true, stale: scenario === 'stale', updated_at: '2026-10-19T12:02:00Z', discovery_gap: false }); return;
    }
    if (url.pathname === '/api/v1/imports/preview' && request.method === 'POST') {
      const input = await body();
      previewRevision = revision;
      send({ preview_token: `synthetic-preview-${revision}-${Date.now()}`, local_revision: revision, schema_version: 1, fingerprint: 'f'.repeat(64), source: input.source === 'upload' ? 'upload' : 'configured', source_changed: false, registry_updated_at: stamp(), registry_stale: scenario === 'stale', counts: { mappings: 3, accepted: 2, rejected: 1, matched: 2, unassigned: 1, orphaned: 1 }, rows, warnings: scenario === 'stale' ? ['registry_stale'] : [] }); return;
    }
    if (url.pathname === '/api/v1/music/capabilities') {
      send(Object.fromEntries(['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search'].map(name => [name, scenario === 'unsupported' || name === 'playlist_search' ? 'unsupported' : 'supported']))); return;
    }
    if (url.pathname === '/api/v1/music/resolve' && request.method === 'POST') {
      const input = await body();
      const shareLink = /^https:\/\/open\.spotify\.com\/(album|playlist)\/([A-Za-z0-9]{22})(?:\?(?:si|utm_source)=[A-Za-z0-9_-]+)?$/.exec(input.input);
      if (shareLink) input.input = `spotify:${shareLink[1]}:${shareLink[2]}`;
      if (!/^spotify:(album|playlist):[A-Za-z0-9]{22}$/.test(input.input) || !input.input.startsWith(`spotify:${input.media_type}:`)) { send({ detail: 'Unsupported Spotify URI, link or media type' }, 422); return; }
      if (scenario === 'metadata-failure' || scenario === 'upstream-unauthorized' || scenario === 'unsupported') {
        send(result({ uri: input.input, state: 'unavailable', error: scenario === 'upstream-unauthorized' ? 'unauthorized' : scenario === 'unsupported' ? 'unsupported_operation' : 'unavailable', last_success_at: null, retry_after: 30 }), 503); return;
      }
      send(result({ uri: input.input, item: { ...item(input.media_type), uri: input.input } })); return;
    }
    if (url.pathname === '/api/v1/music/search' || url.pathname === '/api/v1/music/library') {
      const type = url.searchParams.get('media_type') ?? 'album';
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const library = url.pathname.endsWith('library');
      const empty = scenario === 'empty' || offset > 1;
      const title = library && offset === 1 ? 'Second library fixture' : 'Northern lights fixture';
      const entry = item(type, title);
      if (library && offset === 1) entry.uri = `spotify:${type}:ZYXWVUTSRQPONMLKJIHGFE`;
      send(result({ items: empty ? [] : [entry], total: scenario === 'empty' ? 0 : library ? 2 : 1, next_offset: library && offset === 0 && !empty ? 1 : null })); return;
    }
    // No API fallback or proxy exists, even for unknown fixture operations.
    send({ detail: 'operation_not_in_synthetic_fixture' }, 404);
  }
}
