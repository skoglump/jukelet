/** Joined read-only native manager acceptance; importing performs no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ALBUM_TAG, PLAYLIST_TAG, ALBUM_URI, PLAYLIST_URI } from './browser_manager.mjs';
import { FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, ingressPrefix, readOnlyRequestAllowed, readPublicInputs } from './browser_inputs.mjs';
import { withinDeadline } from './browser_progress.mjs';
import { MINIMUM_CORE_VERSION, reviewedCoreProfile } from './browser_core_profiles.mjs';

const CHECKSUM = '8974c85c2240c7cc189ada36350dc9de6259f0165517289fd707c517fe2f0043';
const PUBLISHER_HASH = '0ebe610e3be178fbd77e7d9b34b3245f202acd3d04f1d787d2aa749d0d50c85a';
const PREVIEW = JSON.stringify({ input: ALBUM_URI, media_type: 'album' });
const ENDPOINTS = new Set(['status', 'tags?offset=0&limit=100', 'assignments?offset=0&limit=100', 'recovery',
  'publication', 'playback-status', 'tags/inbox?view=unassigned&offset=0&limit=100', 'tags/inbox?view=observed&offset=0&limit=100']);
const validTime = value => assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)));
const plain = value => assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
const sorted = rows => [...rows].sort((a, b) => a.tag_key.localeCompare(b.tag_key));

export function assessManagerRows({ assignments, inventory }) {
  plain(assignments); plain(inventory);
  assert.equal(assignments.revision, 13); assert.equal(assignments.total, 2); assert.equal(assignments.assignments.length, 2);
  assert.equal(inventory.total, 2); assert.equal(inventory.tags.length, 2);
  assert.equal(inventory.registry_available, true); assert.equal(inventory.stale, false); assert.equal(inventory.discovery_gap, false);
  validTime(inventory.updated_at);
  const rows = sorted(assignments.assignments);
  assert.equal(new Set(rows.map(row => row.tag_key)).size, 2);
  for (const [id, uri, media, version, shuffle] of [[ALBUM_TAG, ALBUM_URI, 'album', 9, false], [PLAYLIST_TAG, PLAYLIST_URI, 'playlist', 5, true]]) {
    const row = rows.find(value => value.ha_tag_id === id), tag = inventory.tags.find(value => value.ha_tag_id === id);
    assert.ok(row && tag); assert.equal(row.tag_key, hash(id)); assert.equal(tag.tag_key, hash(id));
    assert.equal(row.spotify_uri, uri); assert.equal(row.media_type, media); assert.equal(row.version, version);
    assert.equal(row.enabled, true); assert.equal(row.shuffle, shuffle); assert.equal(row.playback_profile_id, 'default'); validTime(row.updated_at);
    assert.deepEqual(tag.saved_assignment, row); assert.equal(tag.state, 'registered');
    assert.ok(tag.name === null || typeof tag.name === 'string' && tag.name.length <= 1024);
    assert.equal(tag.last_scanned, null); assert.equal(tag.last_reader, null);
  }
  return { global_revision: 13, total: 2, row_versions: { album: 9, playlist: 5 }, opaque_ids_exact: true,
    names_utf8_sha256: inventory.tags.map(tag => ({ tag_key: tag.tag_key, name: tag.name === null ? null : hash(tag.name) })),
    snapshot_sha256: hash(JSON.stringify(rows)), media_and_preferences_match: true };
}

export function managerConnectionVersionText(coreVersion = MINIMUM_CORE_VERSION) {
  return `Home Assistant connected. Version ${reviewedCoreProfile(coreVersion).core_version}`;
}
export function assessManagerConnection(status, coreVersion = MINIMUM_CORE_VERSION) {
  const profile = reviewedCoreProfile(coreVersion);
  plain(status); assert.equal(status.connection, 'connected'); assert.equal(status.version, profile.core_version);
  assert.equal(status.tag_list, 'supported'); assert.equal(status.scan_subscription, 'supported'); assert.equal(status.subscribed, true);
  assert.equal(status.inventory_stale, false); assert.equal(status.discovery_gap, false); assert.equal(status.error, null);
  validTime(status.inventory_updated_at); validTime(status.services_updated_at);
  assert.deepEqual(Object.keys(status.services).sort(), ['get_album', 'get_playlist', 'get_album_favorites', 'get_playlist_favorites', 'search_albums', 'search_playlists'].sort());
  for (const service of Object.values(status.services)) assert.equal(service.state, 'supported');
  return { connected: true, core_version: status.version, registry_fresh: true, subscribed: true,
    declared_capabilities: 6, capabilities_executed: false, cache_times_valid: true, errors: 0, discovery_gap: false };
}

export function assessManagerPublication(value) {
  plain(value); assert.equal(hash(value.publisher_id), PUBLISHER_HASH);
  assert.equal(value.desired_version, 13); assert.equal(value.mapping_count, 2); assert.equal(value.desired_checksum, CHECKSUM);
  assert.equal(value.active_desired_version, 13); assert.equal(value.active_revision, 1); assert.equal(value.active_checksum, CHECKSUM);
  assert.equal(value.healthy, true); assert.equal(value.verified, true); assert.equal(value.actual_stale, false);
  assert.equal(value.reconciliation_required, false); assert.equal(value.automatic_enabled, false); assert.equal(value.playback_verified, null);
  assert.equal(value.error, null); assert.equal(value.shuffle_conflict, false); assert.deepEqual(value.pending_removals, []);
  assert.equal(value.high_water, 1); assert.equal(value.jobs.length, 1);
  const job = value.jobs[0]; assert.equal(job.revision, 1); assert.equal(job.desired_version, 13); assert.equal(job.state, 'verified');
  assert.equal(job.checksum, CHECKSUM); assert.equal(job.recovery, 1); validTime(job.created_at); validTime(value.checked_at);
  assert.equal(value.actual.publisher_id, value.publisher_id); assert.equal(value.actual.active_revision, 1);
  assert.equal(value.actual.active_checksum, CHECKSUM); assert.equal(value.actual.persistence, 'healthy'); assert.equal(value.actual.dispatch_enabled, false);
  return { saved_revision: 13, mappings: 2, active_saved_revision: 13, active_revision: 1,
    checksum: CHECKSUM, publisher_id_sha256: PUBLISHER_HASH, verified_job: 1, healthy: true,
    automatic_publication: 'disabled', dispatch: 'disabled', playback_verified: null };
}

export function assessManagerPlayback(value, now = Date.now()) {
  plain(value); assert.equal(value.connection, 'connected'); assert.equal(value.stale, false); assert.equal(value.error, null);
  const diagnostic = value.diagnostics; plain(diagnostic); assert.equal(diagnostic.diagnostics_version, 1);
  for (const time of [value.checked_at, diagnostic.observed_at]) {
    validTime(time); const age = now - Date.parse(time); assert.ok(age >= -5000 && age <= 30000);
  }
  validTime(diagnostic.started_at); assert.equal(diagnostic.dispatch_enabled, false); assert.equal(diagnostic.ready, false);
  assert.equal(diagnostic.busy, false); assert.equal(diagnostic.execution_uncertain, true); assert.equal(diagnostic.readiness_error, 'execution_uncertain');
  assert.ok(diagnostic.pause_reason === null || typeof diagnostic.pause_reason === 'string' && diagnostic.pause_reason.length <= 128);
  assert.equal(diagnostic.last_scan_at, null); assert.equal(diagnostic.last_attempt, null); assert.equal(diagnostic.playback_verification, 'unavailable');
  assert.ok(Array.isArray(diagnostic.diagnostics) && diagnostic.diagnostics.length <= 32);
  for (const row of diagnostic.diagnostics) { validTime(row.observed_at); assert.equal(typeof row.reason, 'string'); assert.ok(row.reason.length <= 128); }
  return { connected: true, fresh: true, diagnostics_version: 1, dispatch: 'disabled', ready: false,
    busy: false, execution_uncertain: true, pause_reason_sha256: diagnostic.pause_reason === null ? null : hash(diagnostic.pause_reason),
    retained_attempts: 0, retained_scans: 0, observations: diagnostic.diagnostics.length, playback_verification: 'unavailable' };
}

export function assessManagerInbox(value, view) {
  assert.ok(['unassigned', 'observed'].includes(view)); plain(value);
  assert.equal(value.registry_available, true); assert.equal(value.assignments_available, true);
  assert.equal(value.stale, false); assert.equal(value.discovery_gap, false); validTime(value.updated_at);
  assert.equal(value.total, 0); assert.deepEqual(value.tags, []);
  return { view, total: 0, rows: 0, membership_available: true, registry_available: true,
    stale: false, assigned_tags_excluded: true, populated_observation_demonstrated: false };
}

// JSON.parse validates the complete grammar first; this second token walk rejects
// duplicate decoded object keys at every level, without confusing quoted braces.
export function parseManagerBody(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 65536);
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(raw); plain(value);
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const stack = []; assert.ok(tokens.length <= 16384);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '{' || token === '[') { stack.push(token === '{' ? new Set() : null); assert.ok(stack.length <= 32); }
    else if (token === '}' || token === ']') stack.pop();
    else if (tokens[i + 1] === ':') { const keys = stack.at(-1), key = JSON.parse(token); assert.ok(keys && !keys.has(key)); keys.add(key); }
  }
  return value;
}

export class ManagerReadGate {
  #binding; #phase = 0; #records = []; #seen = new WeakSet(); #starts = new WeakMap(); #closed = false; #failure = null;
  #admitted = new WeakMap(); #recorded = new WeakSet();
  #mutations = new WeakSet();
  #stats = { metadata_previews: 0, mutation_attempts: 0, unexpected_mutations: 0, reads: 0, observed_requests: 0 };
  check() {
    assert.equal(this.#closed, false); assert.equal(this.#failure, null);
    if (!this.#binding) return;
    const b = this.#binding;
    try {
      b.verify(); assert.equal(b.page.context(), b.context); assert.equal(b.context.browser(), b.browser);
      assert.equal(b.frame.page(), b.page); assert.equal(b.frame.isDetached(), false); assert.equal(b.page.isClosed(), false);
      assert.equal(b.frame.url(), LOCAL_ORIGIN + b.prefix); assert.ok(Date.parse(b.expiresAt) > Date.now());
      assert.match(b.principalHash, /^[a-f0-9]{64}$/);
    } catch { this.fail('manager_source_or_owner_expired'); throw new Error('manager_source_or_owner_expired'); }
  }
  fail(reason) { this.#failure ??= reason; this.#closed = true; }
  close() { this.#closed = true; }
  bind(binding) {
    assert.equal(this.#binding, undefined); assert.equal(ingressPrefix(LOCAL_ORIGIN + binding.prefix), binding.prefix);
    this.#binding = binding; this.check(); assert.equal(this.#stats.metadata_previews, 1);
  }
  mark() { this.check(); assert.ok(this.#binding); return ++this.#phase; }
  observeAttempt(request) {
    try {
      const path = new URL(request.url()).pathname;
      if (/^\/(?:api\/v1\/|api\/hassio_ingress\/[^/]+\/api\/v1\/)/.test(path)
        && !['GET', 'HEAD'].includes(request.method()) && !this.#mutations.has(request)) {
        this.#mutations.add(request); this.#stats.mutation_attempts += 1; this.#stats.unexpected_mutations += 1;
        this.fail('manager_mutation_attempt');
      }
    } catch { this.fail('manager_request_observation_failed'); }
  }
  started(request) {
    this.observeAttempt(request);
    try {
      this.check(); const target = new URL(request.url());
      if (this.#binding && target.href.startsWith(LOCAL_ORIGIN + this.#binding.prefix + 'api/v1/')) {
        assert.equal(request.frame(), this.#binding.frame);
        if (!this.#starts.has(request)) this.#starts.set(request, { phase: this.#phase, at: performance.now() });
        this.#record(request);
      }
    } catch { this.fail('manager_request_start_unverified'); }
  }
  #record(request) {
    const start = this.#starts.get(request), endpoint = this.#admitted.get(request);
    if (start && endpoint && !this.#recorded.has(request)) {
      this.#recorded.add(request); this.#records.push({ request, endpoint, ...start });
    }
  }
  allow(request, scope) {
    try {
      this.check(); const target = new URL(request.url());
      if (target.origin === LOCAL_ORIGIN && /^\/(?:api\/v1\/|api\/hassio_ingress\/[^/]+\/api\/v1\/)/.test(target.pathname)) {
        if (!['GET', 'HEAD'].includes(request.method())) {
          if (!this.#binding && this.#stats.metadata_previews === 0 && request.method() === 'POST'
            && scope.fromFrame === true && target.href === LOCAL_ORIGIN + scope.prefix + 'api/v1/music/resolve' && request.postData() === PREVIEW) {
            this.#mutations.add(request); this.#stats.mutation_attempts += 1; this.#stats.metadata_previews += 1; return true;
          }
          this.observeAttempt(request); throw new Error('manager_mutation_denied');
        }
        if (this.#binding) {
          assert.equal(scope.fromFrame, true); assert.equal(scope.prefix, this.#binding.prefix);
          assert.equal(request.frame(), this.#binding.frame); assert.ok(target.href.startsWith(LOCAL_ORIGIN + this.#binding.prefix + 'api/v1/'));
          if (!this.#seen.has(request)) {
            this.#seen.add(request); this.#stats.observed_requests += 1; assert.ok(this.#stats.observed_requests <= 256);
            const endpoint = target.href.slice((LOCAL_ORIGIN + this.#binding.prefix + 'api/v1/').length);
            if (ENDPOINTS.has(endpoint) && request.method() === 'GET') { this.#admitted.set(request, endpoint); this.#record(request); }
          }
        }
      }
      return readOnlyRequestAllowed(request.url(), request.method());
    } catch { this.fail('manager_request_denied'); return false; }
  }
  async read(endpoint, mark) {
    this.check(); assert.ok(ENDPOINTS.has(endpoint)); assert.equal(mark, this.#phase); assert.ok(mark > 0);
    try {
      const record = await withinDeadline('response_headers', async () => {
        while (true) {
          this.check(); assert.equal(mark, this.#phase);
          const found = this.#records.find(row => row.endpoint === endpoint && row.phase === mark);
          if (found) return found;
          await new Promise(done => setTimeout(done, 25));
        }
      }, { timeoutMs: 15000 });
      this.check(); assert.equal(record.phase, this.#phase);
      const response = await withinDeadline('response_headers', () => record.request.response(), { timeoutMs: 5000 });
      this.check(); assert.ok(response); assert.equal(response.request(), record.request);
      assert.equal(response.url(), LOCAL_ORIGIN + this.#binding.prefix + 'api/v1/' + endpoint);
      assert.equal(record.request.url(), response.url()); assert.equal(record.request.method(), 'GET');
      assert.equal(record.request.frame(), this.#binding.frame); assert.equal(response.status(), 200);
      const contentType = await withinDeadline('response_headers', () => response.headerValue('content-type'), { timeoutMs: 5000 });
      this.check(); assert.equal(contentType?.split(';')[0].trim().toLowerCase(), 'application/json');
      const bytes = await withinDeadline('response_body', () => response.body(), { timeoutMs: 5000 });
      this.check(); assert.equal(mark, this.#phase); const body = parseManagerBody(bytes);
      this.#stats.reads += 1;
      return { body, receipt: { phase: mark, method_GET: true, status: 200, exact_query: true, frame_bound: true,
        page_context_bound: true, principal_source_bound: true, bounded_body: true, bytes: bytes.length,
        sha256: hash(bytes), elapsed_ms: Math.floor(performance.now() - record.at) } };
    } catch { this.fail('manager_fresh_response_unverified'); throw new Error('manager_fresh_response_unverified'); }
  }
  evidence() { return { ...this.#stats, phase: this.#phase, closed: this.#closed, failure: this.#failure }; }
}

async function dom(gate, operation) {
  gate.check(); const result = await withinDeadline('dom', operation, { timeoutMs: 5000 }); gate.check(); return result;
}
async function rendered(manager, gate, region, expected) {
  await dom(gate, () => manager.expect(region).toBeVisible({ timeout: 5000 }));
  for (const text of expected) await dom(gate, () => manager.expect(region).toContainText(text, { timeout: 5000 }));
  await dom(gate, () => manager.expect(region.getByRole('alert')).toHaveCount(0, { timeout: 5000 }));
}
async function localTimes(manager, gate, values) {
  return dom(gate, () => manager.frame.evaluate(times => times.map(value => new Date(value).toLocaleString()), values));
}
export async function assertManagerList(manager, gate, region, expected, saved = false) {
  await dom(gate, () => manager.expect.poll(async () => dom(gate, () => region.locator(':scope > ul.tag-list > li').evaluateAll(elements =>
    elements.map(element => ({ codes: [...element.querySelectorAll(':scope > code.exact-id, :scope > div > code.exact-id')].map(code => code.textContent),
      name: element.querySelector(':scope > strong')?.textContent ?? null,
      saved: element.querySelector(':scope > p')?.textContent ?? null })))), { timeout: 5000 }).toEqual(expected.map(row => ({
    codes: [row.ha_tag_id, row.spotify_uri], name: saved ? null : row.name ?? 'Unnamed tag',
    saved: saved ? `${row.enabled ? 'Enabled' : 'Disabled'} local draft · Shuffle ${row.shuffle ? 'on' : 'off'} · Revision ${row.version}`
      : 'Registered · Last scan: Not observed',
  }))));
}

export async function exerciseManagerReadonly(manager, gate, evidence, setStage = () => {}, coreVersion = MINIMUM_CORE_VERSION) {
  reviewedCoreProfile(coreVersion);
  const { frame } = manager;
  const stage = value => { gate.check(); setStage(value); };
  const region = name => frame.getByRole('region', { name, exact: true });
  const read = async (endpoint, mark) => { const result = await gate.read(endpoint, mark); gate.check(); return result; };
  stage('manager_saved_refresh');
  const drafts = region('Saved local drafts'), refresh = drafts.getByRole('button', { name: 'Refresh saved drafts', exact: true });
  await dom(gate, () => manager.expect(refresh).toBeEnabled({ timeout: 5000 }));
  const savedMark = gate.mark(); await dom(gate, () => refresh.click({ timeout: 5000 }));
  const assignments = await read('assignments?offset=0&limit=100', savedMark), recovery = await read('recovery', savedMark);
  assert.deepEqual(recovery.body, { reconciliation_required: false });
  await rendered(manager, gate, region('Export and recovery'), ['Export local mappings and preferences as portable JSON.']);
  for (const warning of ['Reconciliation required.', 'Loading recovery state…']) {
    await dom(gate, () => manager.expect(region('Export and recovery')).not.toContainText(warning, { timeout: 5000 }));
  }
  evidence.recovery = { reconciliation_required: false, receipt: recovery.receipt, guard_generation_source: 'separate_Root_SQL_only' };
  const overviewMark = gate.mark();
  const inventory = await read('tags?offset=0&limit=100', overviewMark), status = await read('status', overviewMark);
  evidence.saved_drafts = { ...assessManagerRows({ inventory: inventory.body, assignments: assignments.body }), receipt: assignments.receipt };
  const tags = region('Tag inventory');
  await rendered(manager, gate, tags, ['2 tags. Registry updated:', 'Has saved assignment']);
  await assertManagerList(manager, gate, tags, inventory.body.tags.map(tag => ({ ...tag.saved_assignment, name: tag.name })));
  await rendered(manager, gate, drafts, ['All saved mappings, including tags missing from the HA registry.']);
  await assertManagerList(manager, gate, drafts, assignments.body.assignments, true);
  evidence.inventory = { receipt: inventory.receipt, exact_rows: 2, raw_id_text_matches: true, fresh_names_match: true, saved_uris_match: true };
  stage('manager_connection');
  evidence.connection = { ...assessManagerConnection(status.body, coreVersion), receipt: status.receipt };
  const connection = region('Home Assistant status'), times = await localTimes(manager, gate, [status.body.inventory_updated_at, status.body.services_updated_at]);
  await rendered(manager, gate, connection, [managerConnectionVersionText(coreVersion), 'Tag reads: supported. Scan notifications: supported (subscribed).',
    `Tag cache updated: ${times[0]}`, `Capabilities updated: ${times[1]}`,
    ...Object.keys(status.body.services).map(name => `SpotifyPlus ${name.replaceAll('_', ' ')}: supported`)]);
  for (const text of ['Tag cache is stale', 'Some scan notifications may have been missed', 'Last HA error:']) {
    await dom(gate, () => manager.expect(connection).not.toContainText(text, { timeout: 5000 }));
  }
  evidence.connection.details_rendered = true;
  stage('manager_publication');
  const publicationRegion = region('Publication status'), publicationMark = gate.mark();
  await dom(gate, () => publicationRegion.getByRole('button', { name: 'Refresh publication status', exact: true }).click({ timeout: 5000 }));
  const publication = await read('publication', publicationMark);
  evidence.publication = { ...assessManagerPublication(publication.body), receipt: publication.receipt };
  await dom(gate, () => publicationRegion.getByText('Publication identity and checksums', { exact: true }).click({ timeout: 5000 }));
  await rendered(manager, gate, publicationRegion, ['Saved app revision: 13 · 2 mappings', 'Published: exact saved content verified active in HA.',
    'Last verified app publication: 1 · Saved revision at publication: 13', 'Actual HA revision: 1 · Persistence: healthy',
    'Dispatch: disabled in HA · Playback: independently unverified', 'Automatic publication: disabled; explicit persistent opt-in required',
    `Checked: ${publication.body.checked_at}`, 'Snapshot 1 · Saved revision 13 · verified']);
  const publicationCodes = await dom(gate, () => publicationRegion.locator('details code.exact-id').allTextContents());
  assert.deepEqual(publicationCodes, [publication.body.publisher_id, CHECKSUM, CHECKSUM]); evidence.publication.identity_details_rendered = true;
  stage('manager_playback');
  const playbackRegion = region('Tag playback readiness'), playbackMark = gate.mark();
  await dom(gate, () => playbackRegion.getByRole('button', { name: 'Refresh playback status', exact: true }).click({ timeout: 5000 }));
  const playback = await read('playback-status', playbackMark);
  evidence.playback = { ...assessManagerPlayback(playback.body), receipt: playback.receipt };
  const diagnostic = playback.body.diagnostics, playbackTimes = await localTimes(manager, gate, [playback.body.checked_at, diagnostic.observed_at, diagnostic.started_at]);
  await dom(gate, () => playbackRegion.getByText('Recent diagnostic observations', { exact: true }).click({ timeout: 5000 }));
  const pauseText = diagnostic.pause_reason === 'startup' ? 'No healthy remembered enable choice was restored at startup.'
    : diagnostic.pause_reason === 'administrator_disabled' ? 'Dispatch was deliberately left disabled by an administrator.'
      : 'Dispatch is paused; a healthy snapshot alone does not enable it.';
  await rendered(manager, gate, playbackRegion, ['Playback: independently unverified.', 'Dispatch: disabled. Readiness: not ready at observation.',
    'Previous startup work may still be running.', 'Do not scan again or retry blindly.', pauseText,
    `Status checked: ${playbackTimes[0]}.`, `Companion observation: ${playbackTimes[1]}. Diagnostic window began: ${playbackTimes[2]}.`,
    'No scan observed by this companion since it loaded.', 'No startup attempt retained in this diagnostic window.',
    'At most 32 observations plus the latest attempt, held in memory.']);
  await dom(gate, () => manager.expect(playbackRegion).not.toContainText('Current playback readiness unknown.', { timeout: 5000 }));
  await dom(gate, () => manager.expect(playbackRegion.locator('details[open] > ul > li')).toHaveCount(diagnostic.diagnostics.length, { timeout: 5000 }));
  const observationTimes = await localTimes(manager, gate, diagnostic.diagnostics.map(row => row.observed_at));
  const reasons = { ignored_disabled: 'Scan ignored while dispatch was disabled', ignored_busy: 'Scan ignored while startup was busy; it will not be replayed',
    ignored_duplicate: 'Rapid duplicate scan suppressed', rejected_event: 'Malformed scan rejected', rejected_mapping: 'Scan rejected: no enabled mapping',
    invocation_requested: 'Startup invocation requested', execution_result: 'Startup result received', execution_error: 'Startup result unknown', execution_cancelled: 'Startup waiter cancelled' };
  const readinessReasons = new Set(['snapshot_unavailable', 'snapshot_invalid', 'preference_conflict', 'profile_unconfigured', 'script_unavailable_or_running', 'shutting_down', 'execution_uncertain']);
  await dom(gate, () => manager.expect(playbackRegion.locator('details[open] > ul > li')).toHaveText(diagnostic.diagnostics.map((row, i) =>
    `${observationTimes[i]} · ${reasons[row.reason] ?? (readinessReasons.has(row.reason) ? 'Readiness condition observed; inspect current readiness above' : 'Diagnostic reason unavailable')}`), { timeout: 5000 }));
  evidence.playback.diagnostic_details_rendered = true;
  evidence.inbox = {};
  const inbox = region('Tag onboarding');
  for (const [key, view, action] of [['unassigned', 'unassigned', 'open'], ['observed', 'observed', 'select'], ['refreshed_unassigned', 'unassigned', 'refresh']]) {
    stage('manager_inbox_' + key);
    if (action === 'refresh') {
      // Select the view and prove it loaded before testing its explicit refresh.
      const selectMark = gate.mark(); await dom(gate, () => inbox.getByLabel('Discovery view', { exact: true }).selectOption('unassigned', { timeout: 5000 }));
      const selected = await read('tags/inbox?view=unassigned&offset=0&limit=100', selectMark); assessManagerInbox(selected.body, 'unassigned');
      await dom(gate, () => manager.expect(inbox.getByRole('button', { name: 'Refresh discovery', exact: true })).toBeEnabled({ timeout: 5000 }));
    }
    const mark = gate.mark();
    if (action === 'open') await dom(gate, () => tags.getByRole('button', { name: 'Add tag / unassigned inbox', exact: true }).click({ timeout: 5000 }));
    else if (action === 'select') await dom(gate, () => inbox.getByLabel('Discovery view', { exact: true }).selectOption(view, { timeout: 5000 }));
    else await dom(gate, () => inbox.getByRole('button', { name: 'Refresh discovery', exact: true }).click({ timeout: 5000 }));
    const found = await read('tags/inbox?view=' + view + '&offset=0&limit=100', mark);
    evidence.inbox[key] = { ...assessManagerInbox(found.body, view), receipt: found.receipt };
    const [time] = await localTimes(manager, gate, [found.body.updated_at]);
    await rendered(manager, gate, inbox, [`Registry updated: ${time}.`, view === 'observed'
      ? 'No scans observed by this app. Waiting for a reader event; discovery refreshes automatically.' : 'No tags without local assignments in this snapshot.']);
    await dom(gate, () => manager.expect(inbox.getByLabel('Discovery view', { exact: true })).toHaveValue(view, { timeout: 5000 }));
    await dom(gate, () => manager.expect(inbox.locator(':scope > ul.tag-list > li')).toHaveCount(0, { timeout: 5000 }));
    for (const warning of ['Showing previous', 'Loading discovery', 'Registry snapshot is stale', 'Local assignment membership is unknown', 'Scans may have been missed']) {
      await dom(gate, () => manager.expect(inbox).not.toContainText(warning, { timeout: 5000 }));
    }
    evidence.inbox[key].current_empty_state_rendered = true;
  }
  await dom(gate, () => inbox.getByRole('button', { name: 'Close onboarding', exact: true }).click({ timeout: 5000 }));
  await dom(gate, () => manager.expect(inbox).toHaveCount(0, { timeout: 5000 }));
  assert.equal(gate.evidence().unexpected_mutations, 0); assert.equal(gate.evidence().metadata_previews, 1);
}

export async function runManagerReadonly(path) {
  const report = { fixture: FIXTURE, phase: 'external-manager-readonly', result: 'FAIL', checks: {}, limitations: [
    'Joined current two-tag read-only manager/diagnostics only; original issue62 remains PARTIAL.',
    'Empty inbox membership is demonstrated; populated/observed event flows are not demonstrated.',
    'Six declared capabilities are inspected, not executed. No save/rename/restore/publication/dispatch/service write is authorized.',
    'Root must independently bind immutable candidate/bridge/platform and logical/audit/history/guards/roles/image/script0 before/after.',
    'Root must verify normal actor/Chrome/WM/Xvfb exits and no forced/outside/owned-leftover cleanup.',
  ] };
  const gate = new ManagerReadGate(); let stage = 'local_inputs', manager;
  const attempted = request => gate.started(request);
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_manager_readonly.mjs', 'browser_external.mjs', 'browser.mjs', 'browser_inputs.mjs',
      'browser_manager.mjs', 'browser_core_profiles.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = readPublicInputs(path);
    Object.assign(report, { configuration_sha256: inputs.configuration_sha256, declared_candidate: inputs.document.candidate, declared_bridge: inputs.document.bridge });
    manager = await openNativeManager(inputs, report, { externalBrowser: true, requestAllowed: (request, scope) => gate.allow(request, scope),
      setStage: value => { stage = value; } });
    const binding = manager.externalSession.managerReadonlyBinding(); reviewedCoreProfile(binding.coreVersion); gate.bind(binding);
    // Observe attempted mutations independently of route admission: the outer
    // external guard can abort an intent before our allow callback is reached.
    manager.page.on('request', attempted);
    report.checks.manager_readonly = {};
    await exerciseManagerReadonly(manager, gate, report.checks.manager_readonly, value => { stage = value; }, binding.coreVersion);
    gate.check(); await manager.externalSession.checkWorkers(true); gate.check();
    stage = 'manager_cleanup'; gate.close(); assert.equal((await manager.cleanup()).cleanup_confirmed, true);
    report.checks.external.guard = manager.externalSession.evidence(); assert.equal(report.checks.external.guard.failure, null);
    const { expected_fixture_warning, ...network } = assessNetworkBoundaries(manager.network, manager.networkCategories);
    report.checks.network_assessment = network; report.checks.expected_fixture_warning = expected_fixture_warning;
    assert.equal(gate.evidence().failure, null); report.result = 'PASS'; stage = 'complete';
  } catch { report.code = 'native_manager_readonly_failed'; }
  finally {
    gate.close(); if (manager) { await manager.cleanup(); manager.page.off('request', attempted); report.checks.network = { ...manager.network }; }
    report.checks.manager_readonly_gate = gate.evidence(); report.stage = stage;
  }
  return report;
}
