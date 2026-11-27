/** Synthetic public-boundary checks only, never native publication. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALBUM_TAG, PLAYLIST_TAG, assignmentInput } from './browser_manager.mjs';
import { FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { PublicationGate, assessAssignments, assessBridge, assessExecutionFence, assessPublicationCompletion,
  assessPublicationStart, assessQueueAcknowledgment, assessRecoveryReview, parsePublicationBaseline,
  publicationUIRequest, readBridgeInBrowser, validatePublicationBaseline } from './browser_publication.mjs';

const publisher = 'synthetic-publisher', checksum = 'a'.repeat(64), now = Date.parse('2026-11-01T20:30:00Z');
const target = { publisher_id_sha256: hash(publisher), checksum };
const reviewToken = 'R'.repeat(43), prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
const reviewBody = JSON.stringify({ action: 'recover' });
const confirmBody = JSON.stringify({ review_token: reviewToken, confirmed: true, confirm_empty: false, automatic_publication_attested: false });
function bridge(active = false) {
  return { protocol_version: 1, schema_version: 1, publisher_id: publisher, persistence: active ? 'healthy' : 'empty',
    active_revision: active ? 1 : null, active_checksum: active ? checksum : null, mapping_count: active ? 2 : 0, last_error: null,
    dispatch_enabled: false, supported_media: ['album', 'playlist'], supported_preferences: ['enabled', 'shuffle'], playback_profiles: ['default'] };
}
function publication(verified = false) {
  return { publisher_id: publisher, desired_version: 13, desired_checksum: checksum, mapping_count: 2,
    automatic_enabled: false, playback_verified: null, actual_stale: false, high_water: 1,
    verified, healthy: verified, reconciliation_required: !verified,
    active_revision: verified ? 1 : null, active_desired_version: verified ? 13 : null, active_checksum: verified ? checksum : null,
    actual: bridge(verified), shuffle_conflict: false, pending_removals: [], error: verified ? null : 'recovery_required',
    jobs: [{ revision: 1, desired_version: 13, checksum, state: verified ? 'verified' : 'queued', recovery: 1, created_at: '2026-11-01T20:20:00Z' }] };
}
function baseline() {
  return { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN,
    configuration_A_sha256: '1'.repeat(64), configuration_B_sha256: '2'.repeat(64), publisher_id_sha256: hash(publisher),
    assignment_snapshot_sha256: '3'.repeat(64), domain_revision: 13, album_version: 9,
    source_restore_report_sha256: 'ef005f8ba1e8f55c76e069079ed478f0f9ee3bc43f681e0cfeb7c722bf9e4110',
    current_backup_artifact_sha256: '4'.repeat(64), observed_at: new Date(now - 60000).toISOString() };
}
function review() {
  return { review_token: reviewToken, action: 'recover', desired_version: 13, checksum, mapping_count: 2, empty: false,
    pending_removals: [], shuffle_conflict: false, actual: bridge(), mappings: [ALBUM_TAG, PLAYLIST_TAG].map(tag => {
      const input = assignmentInput(tag, 0); return { tag_id: tag, media_type: input.media_type, spotify_uri: input.input,
        enabled: true, shuffle: input.shuffle, playback_profile_id: 'default' };
    }) };
}
function request(kind, body = kind === 'review' ? reviewBody : confirmBody, extra = {}) {
  return { url: () => LOCAL_ORIGIN + prefix + 'api/v1/publication/' + kind, method: () => 'POST', postData: () => body, ...extra };
}
function boundGate(verify = () => {}) { const gate = new PublicationGate(verify); gate.bindReview(reviewToken); return gate; }
const scope = { fromFrame: true, prefix };

test('app verified alone cannot establish publication when independent HA still reports an empty snapshot', () => {
  assert.throws(() => assessPublicationCompletion(publication(true), bridge(), target), /independent_HA_not_healthy/);
  assert.equal(assessPublicationCompletion(publication(true), bridge(true), target).complete, true);
});

test('queue acknowledgment remains distinct from exact completed readback even if its job is already verified', () => {
  assert.equal(assessQueueAcknowledgment(publication(), target).independently_verified, false);
  assert.equal(assessQueueAcknowledgment(publication(true), target).independently_verified, false);
  assert.deepEqual(assessPublicationCompletion(publication(), bridge(), target),
    { complete: false, observed_job_state: 'queued', direct_HA_revision: null, backend_HA_revision: null });
  assert.equal(assessPublicationCompletion(publication(), bridge(true), target).complete, false);
});

test('verified recovery requires the same owned publisher, immutable checksum, exact job and both independent readbacks', () => {
  for (const mutate of [v => { v.actual.active_checksum = 'b'.repeat(64); }, v => { v.actual.publisher_id += 'other'; },
    v => { v.jobs[0].state = 'uncertain'; }, v => { v.jobs[0].recovery = 0; }, v => { v.jobs[0].checksum = 'b'.repeat(64); },
    v => { v.jobs.push({ ...v.jobs[0], revision: 2 }); }, v => { v.high_water = 2; }, v => { v.desired_version = 14; },
    v => { v.active_desired_version = 12; }, v => { v.reconciliation_required = true; }, v => { v.automatic_enabled = true; },
    v => { v.actual_stale = true; }, v => { v.healthy = false; }, v => { v.playback_verified = true; }]) {
    const value = publication(true); mutate(value); assert.throws(() => assessPublicationCompletion(value, bridge(true), target));
  }
  for (const mutate of [v => { v.active_checksum = 'b'.repeat(64); }, v => { v.publisher_id += 'other'; },
    v => { v.active_revision = 2; }, v => { v.dispatch_enabled = true; }, v => { v.persistence = 'unavailable'; },
    v => { v.mapping_count = 1; }, v => { v.last_error = 'secret'; }, v => { v.supported_preferences = []; }]) {
    const value = bridge(true); mutate(value); assert.throws(() => assessPublicationCompletion(publication(true), value, target));
  }
  const evidence = JSON.stringify(assessPublicationCompletion(publication(true), bridge(true), target));
  assert.ok(!evidence.includes(publisher)); assert.ok(!evidence.includes('created_at')); assert.ok(!evidence.includes(reviewToken));
});

test('current13 guard and immutable review refuse preexisting publication, changed preferences or another action', () => {
  const initial = publication(); initial.high_water = 0; initial.jobs = [];
  assert.equal(assessPublicationStart(initial, bridge(), { reconciliation_required: true }, baseline()).high_water, 0);
  for (const mutate of [v => { v.high_water = 1; }, v => { v.reconciliation_required = false; }, v => { v.healthy = true; },
    v => { v.jobs = publication().jobs; }, v => { v.active_revision = 1; }, v => { v.actual_stale = true; }]) {
    const value = structuredClone(initial); mutate(value); assert.throws(() => assessPublicationStart(value, bridge(), { reconciliation_required: true }, baseline()));
  }
  assert.equal(assessRecoveryReview(review(), baseline(), checksum).expected_next_revision, 1);
  for (const mutate of [v => { v.action = 'activate'; }, v => { v.checksum = 'b'.repeat(64); }, v => { v.mappings[0].enabled = false; },
    v => { v.mappings[0].tag_id = ALBUM_TAG.trim(); }, v => { v.mappings[1].shuffle = false; }, v => { v.actual = bridge(true); },
    v => { v.pending_removals = [ALBUM_TAG]; }, v => { v.desired_version = 12; }, v => { v.extra = 'unexpected'; }]) {
    const value = review(); mutate(value); assert.throws(() => assessRecoveryReview(value, baseline(), checksum));
  }
});

test('receipt binds exact current13 history/configuration/backup and refuses duplicate, stale, future or unknown fields', () => {
  const value = baseline(), inputs = { A: { configuration_sha256: value.configuration_A_sha256 }, B: { configuration_sha256: value.configuration_B_sha256 } };
  const ready = { backup_artifact_sha256: value.current_backup_artifact_sha256 };
  assert.deepEqual(parsePublicationBaseline(JSON.stringify(value)), value);
  assert.equal(validatePublicationBaseline(value, inputs, ready, now).publisher_id_sha256, hash(publisher));
  for (const mutate of [v => { v.domain_revision = 11; }, v => { v.album_version = 7; }, v => { v.configuration_B_sha256 = 'f'.repeat(64); },
    v => { v.current_backup_artifact_sha256 = 'f'.repeat(64); }, v => { v.source_restore_report_sha256 = 'f'.repeat(64); },
    v => { v.observed_at = new Date(now - 3600001).toISOString(); }, v => { v.observed_at = new Date(now + 1).toISOString(); },
    v => { v.extra = true; }]) {
    const bad = structuredClone(value); mutate(bad); assert.throws(() => validatePublicationBaseline(bad, inputs, ready, now));
  }
  assert.throws(() => parsePublicationBaseline(JSON.stringify(value).replace('{', '{"domain_revision":13,')));
});

test('saved assignments and uncertain-execution fence must survive publication unchanged', () => {
  const page = { status: 200, body: { revision: 13, total: 2, assignments: [ALBUM_TAG, PLAYLIST_TAG].map(tag => {
    const input = assignmentInput(tag, 0); return { tag_key: hash(tag), ha_tag_id: tag, spotify_uri: input.input, media_type: input.media_type,
      enabled: true, shuffle: input.shuffle, playback_profile_id: 'default', version: tag === ALBUM_TAG ? 9 : 5, updated_at: '2026-11-01T20:00:00Z' };
  }) } };
  const receipt = { ...baseline(), assignment_snapshot_sha256: hash(JSON.stringify(page.body)) };
  assert.equal(assessAssignments(page, receipt).album_version, 9);
  for (const mutate of [v => { v.body.assignments[0].version = 8; }, v => { v.body.assignments[0].ha_tag_id = ALBUM_TAG.trim(); },
    v => { v.body.assignments[1].updated_at = '2026-11-01T20:01:00Z'; }, v => { v.body.revision = 14; }]) {
    const bad = structuredClone(page); mutate(bad); assert.throws(() => assessAssignments(bad, receipt));
  }
  const playback = { status: 200, body: { connection: 'connected', stale: false, diagnostics: { diagnostics_version: 1,
    dispatch_enabled: false, busy: false, execution_uncertain: true, last_attempt: null, playback_verification: 'unavailable' } } };
  assert.equal(assessExecutionFence(playback).execution_uncertain, true);
  for (const [key, value] of [['dispatch_enabled', true], ['execution_uncertain', false], ['busy', true], ['last_attempt', {}], ['playback_verification', 'verified']]) {
    const bad = structuredClone(playback); bad.body.diagnostics[key] = value; assert.throws(() => assessExecutionFence(bad));
  }
});

test('installed request gate forwards only exact reviewed one-shot intents, revalidates freshness and fences late requests', () => {
  let checks = 0; const gate = boundGate(() => { checks += 1; });
  for (const kind of ['review', 'confirm']) {
    const body = kind === 'review' ? reviewBody : confirmBody; gate.grant(kind, body);
    for (const [wire, place] of [[request(kind, body + ' '), scope], [request(kind, body, { method: () => 'PUT' }), scope],
      [request('automatic/disable', body), scope], [request(kind, body), { ...scope, fromFrame: false }],
      [request(kind, body), { ...scope, prefix: '/api/hassio_ingress/OTHER/' }]]) assert.equal(gate.allow(wire, place), false);
    assert.equal(gate.allow(request(kind, body), scope), true); assert.equal(gate.allow(request(kind, body), scope), false);
    assert.throws(() => gate.grant(kind, body));
  }
  assert.equal(checks, 2); assert.ok(gate.evidence().every(value => value.forwarded && !value.enabled));
  assert.ok(!JSON.stringify(gate.evidence()).includes(reviewToken));
  const late = boundGate(); late.grant('confirm', confirmBody); late.fence(); assert.equal(late.allow(request('confirm'), scope), false);
  const stale = boundGate(() => { throw new Error('stale receipt'); }); assert.throws(() => stale.grant('review', reviewBody)); assert.equal(stale.armed, null);
  const wrong = boundGate(); assert.throws(() => wrong.grant('confirm', confirmBody.replace(reviewToken, 'X'.repeat(43))));
});

function uiCapture({ status = 200, duplicate = false, wrongFrame = false, readFailure = false } = {}) {
  const page = new EventEmitter(), frame = {}, gate = boundGate(); let accept, clicks = 0;
  const wire = request('review', reviewBody, { frame: () => wrongFrame ? {} : frame });
  const response = { url: () => wire.url(), request: () => wire, status: () => status,
    finished: async () => null, json: async () => { if (readFailure) throw new Error('PRIVATE_BODY_FAILURE'); return review(); } };
  page.waitForResponse = () => new Promise(resolve => { accept = resolve; });
  const manager = { page, frame, prefix, authorityDenied: false };
  const click = async () => {
    clicks += 1; assert.equal(gate.allow(wire, scope), true); page.emit('request', wire);
    if (duplicate) page.emit('request', wire); accept(response);
  };
  return { manager, gate, click, clicks: () => clicks };
}

test('actual UI capture requires single matching frame/request, complete body, no auth denial and fences on every failure', async () => {
  const good = uiCapture(); const captured = await publicationUIRequest(good.manager, good.gate, 'review', reviewBody, good.click);
  assert.equal(captured.body.action, 'recover'); assert.equal(captured.evidence.one_exact_UI_request, true); assert.equal(good.clicks(), 1);
  for (const options of [{ duplicate: true }, { wrongFrame: true }, { readFailure: true }, { status: 403 }, { status: 409 }]) {
    const bad = uiCapture(options); await assert.rejects(publicationUIRequest(bad.manager, bad.gate, 'review', reviewBody, bad.click));
    assert.equal(bad.gate.armed, null); assert.equal(bad.manager.page.listenerCount('request'), 0); assert.equal(bad.clicks(), 1);
    assert.equal(bad.manager.authorityDenied, options.status === 403);
    assert.equal(bad.gate.allow(request('review'), scope), false);
  }
});

function publicClient({ isAdmin = true, connected = true, denied = false } = {}) {
  let calls = 0; const hass = { user: { id: 'synthetic-admin', is_admin: isAdmin }, connected, connection: { connected },
    callWS: async function (message) { assert.equal(this, hass); calls += 1; assert.deepEqual(message, { type: 'jukelet_bridge/status' });
      if (denied) throw { code: 'unauthorized', message: 'PRIVATE_ERROR' }; return bridge(true); } };
  Object.defineProperty(hass, 'auth', { get() { throw new Error('must never read auth'); } });
  return { scope: { location: { origin: LOCAL_ORIGIN }, crypto: globalThis.crypto,
    document: { querySelector: name => { assert.equal(name, 'home-assistant'); return { tagName: 'HOME-ASSISTANT', hass }; } } }, calls: () => calls };
}

test('independent read uses only the same public admin client, receiver and fixed status command without retries', async () => {
  const args = { user_id_sha256: hash('synthetic-admin') }, client = publicClient();
  assert.equal((await readBridgeInBrowser(args, client.scope)).outcome, 'PASS'); assert.equal(client.calls(), 1);
  for (const options of [{ isAdmin: false }, { connected: false }, { denied: true }]) {
    const bad = publicClient(options); const result = await readBridgeInBrowser(args, bad.scope);
    assert.notEqual(result.outcome, 'PASS'); assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(bad.calls(), options.denied ? 1 : 0);
  }
  const other = publicClient(); assert.equal((await readBridgeInBrowser({ user_id_sha256: 'f'.repeat(64) }, other.scope)).outcome, 'AUTH_DENIED'); assert.equal(other.calls(), 0);
  assert.equal((await readBridgeInBrowser({ ...args, command: 'publish' }, other.scope)).outcome, 'INVALID_CONTEXT');
  other.scope.location.origin = 'https://example.invalid'; assert.equal((await readBridgeInBrowser(args, other.scope)).outcome, 'INVALID_CONTEXT');
});

test('an unavailable public HA element API fails closed with a finite diagnostic and no client call', async () => {
  const client = publicClient(); client.scope.document = {};
  assert.deepEqual(await readBridgeInBrowser({ user_id_sha256: hash('synthetic-admin') }, client.scope), { outcome: 'CLIENT_UNAVAILABLE' });
  assert.equal(client.calls(), 0);
});

test('clean import/help need no browser dependencies and invalid invocation never opens native inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jukelet-publication-local-'));
  try {
    const scripts = join(directory, 'scripts', 'haos_acceptance'); mkdirSync(scripts, { recursive: true });
    for (const name of ['browser_publication.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_manager.mjs', 'browser_metadata.mjs', 'fetch_clone.mjs', 'browser_progress.mjs'])
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), name), join(scripts, name));
    const module = join(scripts, 'browser_publication.mjs');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(module).href)})`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(imported.status, 0); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
    const help = spawnSync(process.execPath, [module, '--help'], { encoding: 'utf8', timeout: 5000 }); assert.equal(help.status, 0); assert.match(help.stdout, /publication-recover CONFIG_A CONFIG_B/);
    const invalid = spawnSync(process.execPath, [module, 'publish'], { encoding: 'utf8', timeout: 5000 }); assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).code, 'invalid_phase_arguments');
    const privateInput = spawnSync(process.execPath, [module, 'publication-recover', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(privateInput.status, 1); assert.equal(JSON.parse(privateInput.stdout).stage, 'local_inputs');
    assert.equal((privateInput.stdout + privateInput.stderr).includes('SYNTHETIC_PRIVATE'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
