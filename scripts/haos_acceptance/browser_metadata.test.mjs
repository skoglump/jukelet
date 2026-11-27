/** Local synthetic controls only; no HA, browser or external service access. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALBUM_TAG, ALBUM_URI, CONTINUED_LABEL, PLAYLIST_TAG, assignmentInput } from './browser_manager.mjs';
import { FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { createProgressStream } from './browser_progress.mjs';
import { assessFixtureStatus, assessMetadataFailure, assessMetadataPreview, assessMetadataRecovery, assessMetadataState,
  callFixtureControl, finishMetadataFixture, metadataUIRequest, parseMetadataReceipt, validateMetadataReceipt, waitNaturalDeadline } from './browser_metadata.mjs';

function preview(kind = 'fresh') {
  return { status: kind === 'fresh' ? 200 : 503, body: { uri: ALBUM_URI,
    item: { uri: ALBUM_URI, media_type: 'album', title: 'Synthetic Jukelet62 album', subtitle: 'Synthetic fixture artist', artwork_url: null },
    items: [], total: null, next_offset: null, state: kind, last_success_at: '2026-11-01T18:00:00Z',
    last_attempt_at: kind === 'fresh' ? '2026-11-01T18:00:00Z' : '2026-11-01T18:05:02Z', error: kind === 'fresh' ? null : 'unavailable', retry_after: kind === 'fresh' ? null : 30 } };
}

const counters = (mode, calls) => ({ instance_sha256: 'a'.repeat(64), metadata_mode: mode,
  metadata_calls: calls, script_invocations: 0, unexpected_script_calls: 0 });

test('a cached stale503 with no real provider attempt cannot satisfy metadata fallback', () => {
  assert.throws(() => assessMetadataFailure(preview(), preview('stale'), counters('unavailable', 2), counters('unavailable', 2)));
  assert.equal(assessMetadataFailure(preview(), preview('stale'), counters('unavailable', 2), counters('unavailable', 3)).actual_provider_call_delta, 1);
});

test('stale metadata must preserve the exact URI/last-good item/success time and prove one unavailable-provider call', () => {
  for (const damage of [
    value => { value.failure.status = 200; }, value => { value.failure.body.uri += 'x'; },
    value => { value.failure.body.item.title = 'OTHER'; }, value => { value.failure.body.item.artwork_url = 'https://example.invalid/'; },
    value => { value.failure.body.last_success_at = '2026-11-01T18:01:00Z'; },
    value => { value.failure.body.last_attempt_at = '2026-11-01T18:04:59Z'; },
    value => { value.failure.body.error = 'unauthorized'; }, value => { value.failure.body.retry_after = 0; },
    value => { value.after.metadata_calls = 4; }, value => { value.after.instance_sha256 = 'b'.repeat(64); },
    value => { value.after.script_invocations = 1; }, value => { value.after.metadata_mode = 'fresh'; },
  ]) {
    const value = { failure: preview('stale'), after: counters('unavailable', 3) }; damage(value);
    assert.throws(() => assessMetadataFailure(preview(), value.failure, counters('unavailable', 2), value.after));
  }
});

test('fresh recovery needs a later success after the actual backoff and another real provider attempt', () => {
  const recovered = preview(); recovered.body.last_success_at = recovered.body.last_attempt_at = '2026-11-01T18:05:34Z';
  assert.equal(assessMetadataRecovery(preview(), preview('stale'), recovered, counters('fresh', 3), counters('fresh', 4)).recovered_after_real_backoff, true);
  for (const time of ['2026-11-01T18:00:00Z', '2026-11-01T18:05:31Z']) {
    const changed = structuredClone(recovered); changed.body.last_success_at = time;
    assert.throws(() => assessMetadataRecovery(preview(), preview('stale'), changed, counters('fresh', 3), counters('fresh', 4)));
  }
  assert.throws(() => assessMetadataRecovery(preview(), preview('stale'), recovered, counters('fresh', 3), counters('fresh', 3)));
  assert.throws(() => assessMetadataPreview({ ...recovered, status: 503 }, 'fresh'));
});

function status(mode = 'fresh', calls = 2) {
  return { fixture: FIXTURE, synthetic: true, instance: '12345678-1234-1234-1234-123456789abc', metadata_mode: mode,
    metadata_calls: calls, script_invocations: 0, unexpected_script_calls: 0, captures: [], independent_playback_verification: 'unavailable' };
}

test('fixture observations stay bound to the same clearly synthetic instance with no script activity or captures', () => {
  const first = assessFixtureStatus(status(), 'fresh'); assert.equal(first.metadata_calls, 2);
  assert.equal(JSON.stringify(first).includes('12345678-1234'), false);
  for (const damage of [
    value => { value.synthetic = false; }, value => { value.fixture = 'other'; }, value => { value.instance = 'invalid'; },
    value => { value.metadata_calls = -1; }, value => { value.metadata_mode = 'malformed'; }, value => { value.script_invocations = 1; },
    value => { value.unexpected_script_calls = 1; }, value => { value.captures = ['SYNTHETIC_PRIVATE_SENTINEL']; },
    value => { value.secret = 'SYNTHETIC_PRIVATE_SENTINEL'; },
  ]) { const changed = status(); damage(changed); assert.throws(() => assessFixtureStatus(changed, 'fresh', first.instance_sha256)); }
  assert.throws(() => assessFixtureStatus(status(), 'fresh', '0'.repeat(64)));
});

function receipt() {
  return { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN, configuration_sha256: 'a'.repeat(64),
    admin_user_id_sha256: 'b'.repeat(64), actual_candidate_image_manifest_digest: 'sha256:' + 'c'.repeat(64),
    actual_bridge_archive_sha256: 'd'.repeat(64), publisher_id_sha256: 'e'.repeat(64), assignment_snapshot_sha256: 'f'.repeat(64),
    domain_revision: 11, source_concurrency_report_sha256: 'be2c277dd52a90d396aed73be9808487839dd689dc6aec138101556218fdc4d9',
    backup_artifact_sha256: '1'.repeat(64), backup_readback_verified: true, backup_protected: true, observed_at: '2026-11-01T18:00:00Z' };
}

test('metadata receipt binds exact current11/config/artifacts/prior native proof/protected backup before browser work', () => {
  const inputs = { configuration_sha256: 'a'.repeat(64), document: { candidate: { image_manifest_digest: 'sha256:' + 'c'.repeat(64) }, bridge: { archive_sha256: 'd'.repeat(64) } } };
  const now = Date.parse('2026-11-01T18:01:00Z'), value = receipt();
  assert.equal(validateMetadataReceipt(value, inputs, now).configuration_bound, true);
  assert.deepEqual(parseMetadataReceipt(JSON.stringify(value)), value);
  for (const damage of [
    value => { value.domain_revision = 9; }, value => { value.configuration_sha256 = '0'.repeat(64); },
    value => { value.admin_user_id_sha256 = 'raw'; }, value => { value.actual_candidate_image_manifest_digest = 'sha256:' + '0'.repeat(64); },
    value => { value.actual_bridge_archive_sha256 = '0'.repeat(64); }, value => { value.publisher_id_sha256 = 'raw'; },
    value => { value.source_concurrency_report_sha256 = '0'.repeat(64); }, value => { value.backup_protected = false; },
    value => { value.backup_readback_verified = false; }, value => { value.observed_at = '2026-11-01T17:00:59Z'; },
    value => { value.observed_at = '2026-11-01T18:01:01Z'; }, value => { value.token = 'SYNTHETIC_PRIVATE_SENTINEL'; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => validateMetadataReceipt(changed, inputs, now)); }
  assert.throws(() => parseMetadataReceipt(JSON.stringify(value).replace('"domain_revision":11', '"domain_revision":11,"\\u0064omain_revision":11')));
});

function parentScope() {
  const sent = [], user = 'SYNTHETIC_HA_ADMIN', hass = { connected: true, connection: { connected: true }, user: { id: user, is_admin: true },
    callWS(message) { assert.equal(this, hass); sent.push(message); return Promise.resolve(status(message.mode ?? 'fresh')); } };
  Object.defineProperty(hass, 'auth', { get() { throw new Error('PRIVATE_AUTH_MUST_NOT_BE_READ'); } });
  return { sent, hass, identity: hash(user), scope: { location: { origin: LOCAL_ORIGIN }, crypto: globalThis.crypto,
    document: { querySelector: selector => { assert.equal(selector, 'home-assistant'); return { tagName: 'HOME-ASSISTANT', hass }; } } } };
}

test('the actual serialized parent control uses only the initialized public client with the exact principal and fixed command', async () => {
  const value = parentScope();
  const a = await callFixtureControl({ action: 'status', mode: null, user_id_sha256: value.identity }, value.scope);
  assert.equal(a.outcome, 'PASS'); assert.equal(a.actual_admin_user_id_sha256, value.identity);
  const b = await callFixtureControl({ action: 'metadata', mode: 'unavailable', user_id_sha256: value.identity }, value.scope);
  assert.equal(b.status.metadata_mode, 'unavailable');
  assert.deepEqual(value.sent, [{ type: 'jukelet_acceptance/control', action: 'status' },
    { type: 'jukelet_acceptance/control', action: 'metadata', mode: 'unavailable' }]);
  assert.equal(JSON.stringify([a, b]).includes('SYNTHETIC_HA_ADMIN'), false);
});

test('missing client, wrong principal/origin, denied user and arbitrary controls refuse without any WS call', async () => {
  for (const change of [
    value => { value.hass.user.is_admin = false; }, value => { value.hass.user.id = 'OTHER'; },
    value => { value.hass.connected = false; }, value => { value.hass.connection.connected = false; },
    value => { value.scope.location.origin = 'https://example.invalid'; }, value => { value.hass.callWS = undefined; },
  ]) {
    const value = parentScope(); change(value);
    assert.notEqual((await callFixtureControl({ action: 'metadata', mode: 'fresh', user_id_sha256: value.identity }, value.scope)).outcome, 'PASS');
    assert.equal(value.sent.length, 0);
  }
  for (const extra of [{ action: 'scan', mode: null }, { action: 'metadata', mode: 'malformed' }, { action: 'status', mode: 'fresh' },
    { action: 'metadata', mode: 'fresh', type: 'call_service' }]) {
    const value = parentScope(); assert.notEqual((await callFixtureControl({ user_id_sha256: value.identity, ...extra }, value.scope)).outcome, 'PASS');
    assert.equal(value.sent.length, 0);
  }
});

test('control failure is finite/redacted and never retried, and unexpected captures stay inside the parent', async () => {
  const value = parentScope(); let calls = 0;
  value.hass.callWS = async () => { calls += 1; throw { code: 'unauthorized', message: 'SYNTHETIC_PRIVATE_SENTINEL' }; };
  const denied = await callFixtureControl({ action: 'status', mode: null, user_id_sha256: value.identity }, value.scope);
  assert.deepEqual(denied, { outcome: 'AUTH_DENIED' }); assert.equal(calls, 1);
  value.hass.callWS = async () => ({ ...status(), captures: ['SYNTHETIC_PRIVATE_SENTINEL'] });
  const unsafe = await callFixtureControl({ action: 'status', mode: null, user_id_sha256: value.identity }, value.scope);
  assert.deepEqual(unsafe, { outcome: 'UNSAFE_FIXTURE_STATUS' }); assert.equal(JSON.stringify([denied, unsafe]).includes('SYNTHETIC_PRIVATE'), false);
});

test('natural waits use bounded monotonic intervals and expose progress; simulated clock jumps cannot establish expiry', async () => {
  let wall = 1000000, mono = 10, ticks = 0; const sleeps = [], events = [];
  const result = await waitNaturalDeadline(wall + 32000, { maximumMs: 35000, now: () => wall, monotonic: () => mono,
    sleep: async ms => { sleeps.push(ms); wall += ms; mono += ms; }, onTick: async () => { ticks += 1; }, notify: event => events.push(event) });
  assert.deepEqual(sleeps, [15000, 15000, 2000]); assert.equal(ticks, 3); assert.equal(result.natural_elapsed_ms, 32000);
  assert.ok(events.every(event => event.operation === 'real_wait' && Number.isInteger(event.count)));
  await assert.rejects(waitNaturalDeadline(wall + 1000, { maximumMs: 2000, now: () => wall, monotonic: () => mono,
    sleep: async ms => { wall += 100000; mono += ms; } }), /clock_changed/);
  await assert.rejects(waitNaturalDeadline(wall + 400000, { maximumMs: 310000 }));
});

test('fixture cleanup restores fresh once after expected provider503 but never follows auth denial or uncertain outcome', async () => {
  const state = { faultApplied: true, freshApplied: false, expectedProviderFailure: true, authorityDenied: false, controlUncertain: false }, report = {};
  const calls = [], control = async (...args) => { calls.push(args); };
  await finishMetadataFixture({ state, report, control }); await finishMetadataFixture({ state, report, control });
  assert.deepEqual(calls, [['metadata', 'fresh']]); assert.equal(report.fixture_cleanup.restored_fresh, true);
  for (const changed of [{ authorityDenied: true }, { controlUncertain: true }, { expectedProviderFailure: false }]) {
    const blocked = { ...state, freshApplied: false, ...changed }, evidence = {};
    await finishMetadataFixture({ state: blocked, report: evidence, control }); assert.equal(evidence.fixture_cleanup.attempted, false);
  }
  assert.equal(calls.length, 1);
});

function UIRequestFixture(code = 503, { duplicate = false, wrongBody = false, deniedProvider = false } = {}) {
  const page = new EventEmitter(), prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/', frame = {};
  const target = LOCAL_ORIGIN + prefix + 'api/v1/music/resolve'; let resolve, jsonCalls = 0;
  const request = { url: () => target, method: () => 'POST', frame: () => frame,
    postData: () => JSON.stringify({ input: wrongBody ? 'OTHER' : ALBUM_URI, media_type: 'album' }) };
  const body = preview(code === 200 ? 'fresh' : 'stale').body; if (deniedProvider) body.error = 'forbidden';
  const response = { url: () => target, request: () => request, status: () => code, finished: async () => null,
    json: async () => { jsonCalls += 1; return body; } };
  page.waitForResponse = predicate => new Promise(done => { resolve = () => { assert.equal(predicate(response), true); done(response); }; });
  const music = { getByLabel: () => ({ selectOption: async () => {}, fill: async () => {} }),
    getByRole: () => ({ click: async () => { page.emit('request', request); if (duplicate) page.emit('request', request); resolve(); } }) };
  frame.getByRole = () => music;
  return { manager: { page, frame, prefix }, state: { authorityDenied: false }, jsonCalls: () => jsonCalls };
}

test('the real UI-capture path requires one exact synthetic POST and consumes actual200/503 bodies without cloning', async () => {
  for (const code of [200, 503]) {
    const value = UIRequestFixture(code), result = await metadataUIRequest(value.manager, value.state);
    assert.equal(result.status, code); assert.equal(result.actual_UI_request_count, 1); assert.equal(result.exact_synthetic_input, true);
    assert.equal(value.jsonCalls(), 1); assert.equal(value.manager.page.listenerCount('request'), 0);
  }
  for (const options of [{ duplicate: true }, { wrongBody: true }]) {
    const value = UIRequestFixture(503, options); await assert.rejects(metadataUIRequest(value.manager, value.state));
    assert.equal(value.manager.page.listenerCount('request'), 0);
  }
});

test('actual UI auth denial is terminal before reading the denial body and cannot authorize fixture cleanup', async () => {
  for (const code of [401, 403]) {
    const value = UIRequestFixture(code); await assert.rejects(metadataUIRequest(value.manager, value.state), /authority_denied_terminal/);
    assert.equal(value.state.authorityDenied, true); assert.equal(value.jsonCalls(), 0);
    let cleanupCalls = 0;
    await finishMetadataFixture({ state: { ...value.state, faultApplied: true, expectedProviderFailure: true }, report: {},
      control: async () => { cleanupCalls += 1; } });
    assert.equal(cleanupCalls, 0);
  }
  const denied = UIRequestFixture(503, { deniedProvider: true });
  await assert.rejects(metadataUIRequest(denied.manager, denied.state), /authority_denied_terminal/); assert.equal(denied.state.authorityDenied, true);
});

test('metadata progress admits only the bounded phase/control/wait projection', () => {
  const lines = [], emit = createProgressStream(value => lines.push(JSON.parse(value)));
  emit({ role: 'A', stage: 'metadata_cache_wait', operation: 'real_wait', checkpoint: 'complete', count: 287 });
  emit({ role: 'A', stage: 'metadata_fault', operation: 'fixture_control', checkpoint: 'begin' });
  assert.equal(lines.length, 2);
  assert.throws(() => emit({ role: 'A', stage: 'metadata_fault', operation: 'fixture_control', checkpoint: 'begin', raw: 'SYNTHETIC_PRIVATE_SENTINEL' }));
});

test('current11 state checks refuse all assignment/recovery/floor/publisher/dispatch changes', () => {
  const rows = [ALBUM_TAG, PLAYLIST_TAG].map(tag => { const input = assignmentInput(tag, tag === ALBUM_TAG ? 6 : 3);
    return { tag_key: hash(tag), ha_tag_id: tag, spotify_uri: input.input, media_type: input.media_type, enabled: true,
      shuffle: input.shuffle, playback_profile_id: 'default', version: input.expected_version + 1, updated_at: '2026-11-01T18:00:00Z' }; });
  const page = { status: 200, body: { total: 2, revision: 11, assignments: rows } };
  const pub = 'SYNTHETIC_PUBLISHER', proof = { publisher_id_sha256: hash(pub), assignment_snapshot_sha256: hash(JSON.stringify(page.body)) };
  const value = { page, name: { status: 200, body: { tag_key: hash(ALBUM_TAG), state: 'current', name: CONTINUED_LABEL } },
    publication: { status: 200, body: { publisher_id: pub, desired_version: 11, high_water: 0, reconciliation_required: false,
      automatic_enabled: false, actual_stale: false, playback_verified: null, jobs: [], actual: { publisher_id: pub, dispatch_enabled: false,
        persistence: 'empty', active_revision: null, active_checksum: null } } },
    playback: { status: 200, body: { connection: 'connected', stale: false, diagnostics: { diagnostics_version: 1, dispatch_enabled: false,
      busy: false, last_attempt: null, playback_verification: 'unavailable' } } }, recovery: { status: 200, body: { reconciliation_required: false } } };
  assert.equal(assessMetadataState(value, proof).high_water, 0);
  for (const damage of [
    value => { value.page.body.revision = 12; }, value => { value.page.body.assignments[0].enabled = false; },
    value => { value.page.body.assignments[1].version = 5; }, value => { value.name.body.name = 'OTHER'; },
    value => { value.publication.body.high_water = 1; }, value => { value.publication.body.reconciliation_required = true; },
    value => { value.publication.body.automatic_enabled = true; }, value => { value.recovery.body.reconciliation_required = true; },
    value => { value.playback.body.diagnostics.dispatch_enabled = true; }, value => { value.publication.body.actual.active_revision = 1; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => assessMetadataState(changed, proof)); }
});

test('metadata imports/help need no frontend dependency, and invalid inputs fail before private reads without raw values', () => {
  const root = mkdtempSync(join(tmpdir(), 'jukelet62-metadata-import-'));
  try {
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const name of ['browser_metadata.mjs', 'browser_manager.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs', 'fetch_clone.mjs']) copyFileSync(join(directory, name), join(root, name));
    mkdirSync(join(root, 'empty'));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(root, 'browser_metadata.mjs')).href)});`], { cwd: join(root, 'empty'), encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
    const help = spawnSync(process.execPath, [join(root, 'browser_metadata.mjs'), '--help'], { encoding: 'utf8' }); assert.equal(help.status, 0);
    const failed = spawnSync(process.execPath, [join(root, 'browser_metadata.mjs'), 'metadata-fallback', '/tmp/SYNTHETIC_PRIVATE_SENTINEL'], { encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).stage, 'local_inputs');
    assert.equal((failed.stdout + failed.stderr).includes('SYNTHETIC_PRIVATE'), false);
  } finally { rmSync(root, { recursive: true }); }
});
