// Development-only normalized DTO fixtures. This plugin never contacts a backend or HA.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { RestoreReport } from '../src/Recovery.tsx';
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
const item = (type: string, title = 'Northern lights fixture') => ({
  uri: type === 'album' ? uri : playlistUri, media_type: type, title, subtitle: 'Synthetic artist / owner', artwork_url: '/fixture-artwork.svg',
});
const result = (fields: Record<string, unknown> = {}) => ({
  uri: null, item: null, items: [], total: null, next_offset: null, state: 'fresh', error: null, retry_after: null, last_success_at: stamp(), last_attempt_at: stamp(), ...fields,
});
const scenarios = ['normal', 'metadata-failure', 'upstream-unauthorized', 'empty', 'unsupported', 'failed', 'stale', 'app-unauthorized', 'manage', 'onboarding-registered', 'rename-forbidden', 'rename-uncertain', 'assignments-unavailable', 'publication-stale', 'publication-error', 'publication-recovery', 'playback-ready', 'playback-failure', 'playback-unknown', 'playback-invalid', 'playback-busy', 'playback-stale', 'playback-disconnected'];

export function managerFixtures(): Plugin {
  let scenario = 'normal';
  let authenticated = false;
  let manage = false;
  let drafts: Record<string, Assignment> = {};
  let versions: Record<string, number> = {};
  let revision = 0;
  let restore: RestoreReport | null = null;
  let recoveryRequired = false;
  type Active = { revision: number; version: number; checksum: string; rows: Assignment[] };
  let publicationActive: Active | null = null;
  let publicationReview: { token: string; action: string; version: number } | null = null;
  let publicationQueued: Active | null = null;
  let publicationReads = 0;
  let automatic = false;
  const publisher = '00000000-0000-4000-8000-000000000030';
  const digest = () => createHash('sha256').update(JSON.stringify(Object.values(drafts))).digest('hex');
  const publicationStatus = () => ({ publisher_id: publisher, desired_version: revision, desired_checksum: digest(), mapping_count: Object.keys(drafts).length,
    active_revision: publicationActive?.revision ?? null, active_checksum: publicationActive?.checksum ?? null, active_desired_version: publicationActive?.version ?? null,
    automatic_enabled: automatic, healthy: !recoveryRequired && scenario !== 'publication-error', reconciliation_required: recoveryRequired || scenario === 'publication-recovery',
    verified: scenario !== 'publication-stale' && publicationActive?.version === revision,
    actual: { publisher_id: publisher, active_revision: publicationActive?.revision ?? null, active_checksum: publicationActive?.checksum ?? null, persistence: publicationActive ? 'healthy' : 'empty', dispatch_enabled: false },
    actual_stale: scenario === 'publication-stale', checked_at: stamp(), error: scenario === 'publication-error' ? 'unavailable' : null,
    shuffle_conflict: Object.values(drafts).some(row => row.enabled && row.shuffle !== (row.media_type === 'playlist')),
    pending_removals: (publicationActive?.rows ?? []).filter(row => row.enabled && !Object.values(drafts).some(current => current.ha_tag_id === row.ha_tag_id && current.enabled)).map(row => row.ha_tag_id),
    jobs: publicationQueued ? [{ revision: publicationQueued.revision, desired_version: publicationQueued.version, state: 'queued' }] : [], playback_verified: null });
  let pendingRegistered = false;
  let names: Record<string, string | null> = {};
  let uncertain = new Set<string>();
  const discoveryTags = () => tags.map(tag => ({ ...tag, name: Object.hasOwn(names, tag.tag_key) ? names[tag.tag_key] : tag.name,
    state: tag.state === 'pending_discovery' && pendingRegistered ? 'registered' : tag.state,
    observed_reader: tag.last_reader,
    observed_at: tag.last_reader ? tag.last_scanned : null,
    saved_assignment: drafts[tag.tag_key] ?? null,
    local_assignment: scenario === 'assignments-unavailable' ? 'unknown' : drafts[tag.tag_key] ? drafts[tag.tag_key].enabled ? 'enabled' : 'disabled' : 'unassigned',
  }));
  return {
    name: 'isolated-manager-fixtures',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
  function middleware(request: IncomingMessage, response: ServerResponse, next: () => void) {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/fixture-artwork.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#365447"/><circle cx="80" cy="80" r="52" fill="#eadcbe"/><circle cx="80" cy="80" r="17" fill="#365447"/></svg>'); return;
    }
    if (!path.startsWith('/api/') && !path.startsWith('/__fixtures/') && !path.startsWith('/health/')) { next(); return; }
    void handle(request, response).catch(() => { response.statusCode = 400; response.end('{"detail":"invalid_fixture_request"}'); });
  }
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
      if (state.reset === 'yes') { authenticated = false; manage = state.scenario === 'manage'; drafts = {}; versions = {}; revision = 0; pendingRegistered = false; names = {}; uncertain = new Set(); restore = null; recoveryRequired = false; publicationActive = null; publicationQueued = null; publicationReview = null; automatic = false; }
      if (state.reset === 'yes' && (!manage || state.seed === 'yes')) {
        for (const [id, input, kind] of [[tags[0].ha_tag_id, uri, 'album'], ['synthetic-orphan', playlistUri, 'playlist']]) {
          const key = createHash('sha256').update(id).digest('hex');
          versions[key] = 1;
          drafts[key] = { tag_key: key, ha_tag_id: id, spotify_uri: input, media_type: kind as 'album' | 'playlist', enabled: true, shuffle: kind === 'playlist', playback_profile_id: 'default', version: 1, updated_at: stamp() };
        }
        revision = 2;
      }
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
    if (url.pathname === '/api/v1/publication') {
      if (scenario === 'publication-error') { send({}, 503); return; }
      if (publicationQueued && ++publicationReads > 1) { publicationActive = publicationQueued; publicationQueued = null; recoveryRequired = false; }
      send(publicationStatus()); return;
    }
    if (url.pathname === '/api/v1/playback-status' && request.method === 'GET') {
      const uncertain = ['playback-failure', 'playback-unknown', 'playback-invalid', 'playback-busy'].includes(scenario);
      const hasAttempt = scenario.startsWith('playback-');
      const error = scenario === 'playback-failure' ? 'readiness_failed' : scenario === 'playback-unknown' ? 'completion_unavailable' : scenario === 'playback-invalid' ? 'invalid_completion' : null;
      const at = scenario === 'playback-stale' ? new Date(Date.now() - 60_000).toISOString() : stamp();
      send({ connection: scenario === 'playback-disconnected' ? 'disconnected' : 'connected', checked_at: at, stale: scenario === 'playback-stale' || scenario === 'playback-disconnected', error: null,
        diagnostics: { diagnostics_version: 1, started_at: at, observed_at: at, dispatch_enabled: hasAttempt && !uncertain || scenario === 'playback-busy', ready: !uncertain,
          readiness_error: uncertain ? 'execution_uncertain' : null, busy: scenario === 'playback-busy', execution_uncertain: uncertain,
          pause_reason: hasAttempt ? uncertain ? 'execution_uncertain' : null : 'startup', last_scan_at: hasAttempt ? at : null,
          last_attempt: hasAttempt ? { correlation_id: '00000000-0000-4000-8000-000000000036', snapshot_revision: 7, requested_at: at,
            completed_at: scenario === 'playback-busy' ? null : at, invocation: scenario === 'playback-busy' ? 'requested' : 'accepted',
            execution: scenario === 'playback-failure' ? 'failed' : uncertain ? 'unknown' : 'finished', error, playback_verification: 'unavailable' } : null,
          diagnostics: [], playback_verification: 'unavailable' } }); return;
    }
    if (url.pathname === '/api/v1/publication/review') {
      const input = await body();
      if (!manage) { send({}, 403); return; }
      if (scenario === 'publication-error') { send({ detail: { code: 'bridge_unavailable' } }, 409); return; }
      publicationReview = { token: `synthetic-publication-${revision}`, action: input.action, version: revision };
      send({ review_token: publicationReview.token, action: input.action, desired_version: revision, checksum: digest(), mapping_count: Object.keys(drafts).length, empty: Object.keys(drafts).length === 0,
        mappings: Object.values(drafts).map(row => ({ ...row, tag_id: row.ha_tag_id })), shuffle_conflict: publicationStatus().shuffle_conflict }); return;
    }
    if (url.pathname === '/api/v1/publication/confirm') {
      const input = await body();
      if (!publicationReview || publicationReview.token !== input.review_token || publicationReview.version !== revision) { send({ detail: { code: 'review_stale' } }, 409); return; }
      if (publicationReview.action === 'activate') automatic = true;
      else { publicationQueued = { revision: (publicationActive?.revision ?? 0) + 1, version: revision, checksum: digest(), rows: structuredClone(Object.values(drafts)) }; publicationReads = 0; }
      publicationReview = null; send(publicationStatus()); return;
    }
    if (url.pathname === '/api/v1/publication/suspend') { automatic = false; send(publicationStatus()); return; }
    if (url.pathname === '/api/v1/recovery') { send({ reconciliation_required: recoveryRequired }); return; }
    if (url.pathname === '/api/v1/export') {
      send({ schema_version: 1, provenance: { application: 'jukelet', exported_at: stamp(), local_revision: revision, names_updated_at: stamp(), names_stale: false }, assignments: Object.values(drafts).map(draft => ({ ha_tag_id: draft.ha_tag_id, spotify_uri: draft.spotify_uri, media_type: draft.media_type, enabled: draft.enabled, shuffle: draft.shuffle, playback_profile_id: draft.playback_profile_id, name: discoveryTags().find(tag => tag.ha_tag_id === draft.ha_tag_id)?.name ?? null })) }); return;
    }
    if (url.pathname === '/api/v1/restores/preview') {
      const input = await body() as unknown as { document: { schema_version: number; assignments: Record<string, unknown>[] } };
      if (input.document?.schema_version !== 1 || !Array.isArray(input.document.assignments)) { send({}, 422); return; }
      const reviewedRows = input.document.assignments.map((source, index) => {
        const accepted = ['album', 'playlist'].includes(String(source.media_type));
        return { row: index + 1, source, accepted, conflict: Boolean(drafts[createHash('sha256').update(String(source.ha_tag_id)).digest('hex')]), diagnostics: accepted ? [] : ['unsupported_or_invalid_row'] };
      });
      restore = { preview_token: `synthetic-restore-${revision}-${Date.now()}`, local_revision: revision, rows: reviewedRows, accepted: reviewedRows.filter(row => row.accepted).length, rejected: reviewedRows.filter(row => !row.accepted).length, conflicts: reviewedRows.filter(row => row.accepted && row.conflict).length };
      send(restore); return;
    }
    if (url.pathname === '/api/v1/restores/confirm') {
      const input = await body();
      if (!manage) { send({}, 403); return; }
      if (!restore || restore.preview_token !== input.preview_token || restore.local_revision !== revision || !input.confirmed || (restore.conflicts && input.conflict_policy === 'reject')) { send({}, 409); return; }
      let restored = 0, skipped = 0;
      for (const row of restore.rows.filter(row => row.accepted)) {
        if (row.conflict && input.conflict_policy === 'skip') { skipped++; continue; }
        const source = row.source as unknown as Assignment;
        const key = createHash('sha256').update(source.ha_tag_id).digest('hex');
        versions[key] = (versions[key] ?? 0) + 1;
        drafts[key] = { tag_key: key, ha_tag_id: source.ha_tag_id, spotify_uri: source.spotify_uri, media_type: source.media_type, enabled: source.enabled, shuffle: source.shuffle, playback_profile_id: 'default', version: versions[key], updated_at: stamp() };
        restored++;
      }
      revision++; recoveryRequired = true;
      send({ restored, skipped, report: restore, reconciliation_required: true }); restore = null; return;
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
    if (url.pathname === '/api/v1/status') {
      send({ connection: scenario === 'upstream-unauthorized' ? 'unauthorized' : 'connected', version: 'synthetic-fixture', tag_list: 'supported', scan_subscription: 'supported', subscribed: true, services: {}, inventory_stale: scenario === 'stale', inventory_updated_at: stamp(), services_updated_at: stamp(), discovery_gap: false, error: scenario === 'upstream-unauthorized' ? 'unauthorized' : null }); return;
    }
    if (url.pathname === '/api/v1/tags') {
      if (scenario === 'failed') { send({}, 503); return; }
      send({ tags: scenario === 'empty' ? [] : discoveryTags(), total: scenario === 'empty' ? 0 : tags.length, registry_available: true, stale: scenario === 'stale', updated_at: '2026-10-19T12:02:00Z', discovery_gap: false }); return;
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
