/** Opt-in synthetic metadata lifecycle; imports perform no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ALBUM_TAG, ALBUM_URI, CONTINUED_LABEL, PLAYLIST_TAG, ManagerWriteGate,
  assessAssignmentState, assessDiagnosticInventory, assessManagerGuards, assignmentInput } from './browser_manager.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, readBoundedFile, readPublicInputs } from './browser_inputs.mjs';
import { createProgressStream, nativeEndpointCategory, withinDeadline } from './browser_progress.mjs';

function exactKeys(value, keys) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

export function assessMetadataPreview(value, kind) {
  const body = value.body;
  exactKeys(body, ['uri', 'item', 'items', 'total', 'next_offset', 'state', 'last_attempt_at', 'last_success_at', 'error', 'retry_after']);
  assert.equal(body.uri, ALBUM_URI); assert.deepEqual(body.items, []); assert.equal(body.total, null); assert.equal(body.next_offset, null);
  assert.deepEqual(body.item, { uri: ALBUM_URI, media_type: 'album', title: 'Synthetic Jukelet62 album',
    subtitle: 'Synthetic fixture artist', artwork_url: null });
  for (const key of ['last_attempt_at', 'last_success_at']) assert.ok(typeof body[key] === 'string' && Number.isFinite(Date.parse(body[key])));
  assert.ok(['fresh', 'stale'].includes(kind)); assert.equal(body.state, kind);
  assert.equal(value.status, kind === 'fresh' ? 200 : 503);
  assert.equal(body.error, kind === 'fresh' ? null : 'unavailable'); assert.equal(body.retry_after, kind === 'fresh' ? null : 30);
  if (kind === 'fresh') assert.equal(body.last_attempt_at, body.last_success_at);
  return { actual_status: value.status, state: kind, uri_sha256: hash(body.uri), item_sha256: hash(JSON.stringify(body.item)),
    last_success_at: body.last_success_at, last_attempt_at: body.last_attempt_at, retry_after: body.retry_after, artwork_absent: true };
}

export function assessMetadataFailure(seed, failure, before, after) {
  const original = assessMetadataPreview(seed, 'fresh'), stale = assessMetadataPreview(failure, 'stale');
  assert.equal(stale.last_success_at, original.last_success_at); assert.equal(stale.item_sha256, original.item_sha256);
  assert.ok(Date.parse(stale.last_attempt_at) - Date.parse(original.last_success_at) >= 300000);
  assertFixtureDelta(before, after, 'unavailable', 1);
  return { ...stale, retained_last_good: true, actual_provider_call_delta: after.metadata_calls - before.metadata_calls };
}

function assertFixtureDelta(before, after, mode, delta) {
  assert.match(before.instance_sha256, /^[a-f0-9]{64}$/); assert.equal(after.instance_sha256, before.instance_sha256);
  assert.equal(before.metadata_mode, mode); assert.equal(after.metadata_mode, mode);
  assert.ok(Number.isSafeInteger(before.metadata_calls) && before.metadata_calls >= 0);
  assert.equal(after.metadata_calls - before.metadata_calls, delta);
  for (const value of [before, after]) { assert.equal(value.script_invocations, 0); assert.equal(value.unexpected_script_calls, 0); }
}

export function assessMetadataRecovery(seed, failure, recovered, before, after) {
  const original = assessMetadataPreview(seed, 'fresh'), stale = assessMetadataPreview(failure, 'stale');
  const fresh = assessMetadataPreview(recovered, 'fresh');
  assert.equal(fresh.item_sha256, original.item_sha256);
  assert.ok(Date.parse(fresh.last_success_at) > Date.parse(original.last_success_at));
  assert.ok(Date.parse(fresh.last_success_at) - Date.parse(stale.last_attempt_at) >= stale.retry_after * 1000);
  assertFixtureDelta(before, after, 'fresh', 1);
  return { ...fresh, actual_provider_call_delta: 1, recovered_after_real_backoff: true };
}

export function parseMetadataReceipt(raw) {
  const value = JSON.parse(raw), tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const keys = tokens.flatMap((token, index) => tokens[index + 1] === ':' ? [JSON.parse(token)] : []);
  assert.equal(keys.length, 16); assert.equal(new Set(keys).size, keys.length); return value;
}

export function validateMetadataReceipt(value, inputs, now = Date.now()) {
  exactKeys(value, ['schema_version', 'fixture', 'synthetic', 'origin', 'configuration_sha256', 'admin_user_id_sha256',
    'actual_candidate_image_manifest_digest', 'actual_bridge_archive_sha256', 'publisher_id_sha256', 'assignment_snapshot_sha256',
    'domain_revision', 'source_concurrency_report_sha256', 'backup_artifact_sha256', 'backup_readback_verified', 'backup_protected', 'observed_at']);
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, FIXTURE); assert.equal(value.synthetic, true);
  assert.equal(value.origin, LOCAL_ORIGIN); assert.equal(value.domain_revision, 11);
  assert.match(value.actual_candidate_image_manifest_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(value.backup_readback_verified, true); assert.equal(value.backup_protected, true);
  for (const key of ['configuration_sha256', 'admin_user_id_sha256', 'actual_bridge_archive_sha256', 'publisher_id_sha256',
    'assignment_snapshot_sha256', 'source_concurrency_report_sha256', 'backup_artifact_sha256']) assert.match(value[key], /^[a-f0-9]{64}$/);
  assert.equal(value.configuration_sha256, inputs.configuration_sha256);
  assert.equal(value.actual_candidate_image_manifest_digest, inputs.document.candidate.image_manifest_digest);
  assert.equal(value.actual_bridge_archive_sha256, inputs.document.bridge.archive_sha256);
  assert.equal(value.source_concurrency_report_sha256, 'be2c277dd52a90d396aed73be9808487839dd689dc6aec138101556218fdc4d9');
  const observed = Date.parse(value.observed_at);
  assert.ok(Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= 3600000);
  return { configuration_bound: true, backup_artifact_sha256: value.backup_artifact_sha256,
    backup_scope: 'task_owned_private_archive_hash_and_readback_only', observed_at: value.observed_at };
}

export function assessFixtureStatus(value, mode, instanceHash = null) {
  exactKeys(value, ['fixture', 'synthetic', 'instance', 'metadata_mode', 'metadata_calls', 'script_invocations',
    'unexpected_script_calls', 'captures', 'independent_playback_verification']);
  assert.equal(value.fixture, FIXTURE); assert.equal(value.synthetic, true);
  assert.match(value.instance, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.ok(['fresh', 'unavailable'].includes(mode)); assert.equal(value.metadata_mode, mode);
  assert.ok(Number.isSafeInteger(value.metadata_calls) && value.metadata_calls >= 0 && value.metadata_calls <= 1000000000);
  assert.equal(value.script_invocations, 0); assert.equal(value.unexpected_script_calls, 0); assert.deepEqual(value.captures, []);
  assert.equal(value.independent_playback_verification, 'unavailable');
  const instance_sha256 = hash(value.instance); if (instanceHash) assert.equal(instance_sha256, instanceHash);
  return { instance_sha256, metadata_mode: mode, metadata_calls: value.metadata_calls, script_invocations: 0, unexpected_script_calls: 0 };
}

// Serialized into the actual HA parent. Only the supported initialized client
// and public user fields are touched; no auth/token/storage objects are read.
export async function callFixtureControl(value, scope = globalThis) {
  if (!value || Object.keys(value).sort().join(',') !== 'action,mode,user_id_sha256') return { outcome: 'INVALID_CONTEXT' };
  const { action, mode, user_id_sha256 } = value;
  if (!['status', 'metadata'].includes(action) || (action === 'status' ? mode !== null : !['fresh', 'unavailable'].includes(mode))
    || !/^[a-f0-9]{64}$/.test(user_id_sha256) || scope.location?.origin !== 'https://127.0.0.1:18223') return { outcome: 'INVALID_CONTEXT' };
  if (typeof scope.document?.querySelector !== 'function') return { outcome: 'CLIENT_UNAVAILABLE' };
  const element = scope.document.querySelector('home-assistant'), hass = element?.hass;
  if (element?.tagName !== 'HOME-ASSISTANT' || !hass || typeof hass.callWS !== 'function'
    || hass.connected !== true || hass.connection?.connected !== true) return { outcome: 'CLIENT_UNAVAILABLE' };
  if (hass.user?.is_admin !== true || typeof hass.user.id !== 'string' || !hass.user.id.length || hass.user.id.length > 256) return { outcome: 'AUTH_DENIED' };
  const digest = await scope.crypto.subtle.digest('SHA-256', new TextEncoder().encode(hass.user.id));
  const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== user_id_sha256) return { outcome: 'AUTH_DENIED' };
  try {
    const message = { type: 'jukelet_acceptance/control', action, ...(action === 'metadata' ? { mode } : {}) };
    const status = await hass.callWS(message);
    // Unexpected captures never leave the browser, including on a failed run.
    if (!status || !Array.isArray(status.captures) || status.captures.length !== 0) return { outcome: 'UNSAFE_FIXTURE_STATUS' };
    return { outcome: 'PASS', actual_admin_user_id_sha256: actual, status };
  } catch (error) {
    return { outcome: ['unauthorized', 'forbidden', 'not_authorized'].includes(error?.code) ? 'AUTH_DENIED' : 'CONTROL_FAILED' };
  }
}

export function assessMetadataState(values, receipt) {
  const { page, name, publication, playback, recovery } = values;
  for (const value of Object.values(values)) assert.equal(value.status, 200);
  exactKeys(page.body, ['assignments', 'total', 'revision']); assert.equal(page.body.revision, 11);
  assert.equal(page.body.total, 2); assert.equal(page.body.assignments.length, 2);
  for (const [tag, prior] of [[ALBUM_TAG, 6], [PLAYLIST_TAG, 3]]) {
    const rows = page.body.assignments.filter(row => row.ha_tag_id === tag); assert.equal(rows.length, 1);
    assessAssignmentState({ version: rows[0].version, assignment: rows[0] }, assignmentInput(tag, prior));
  }
  assert.equal(hash(JSON.stringify(page.body)), receipt.assignment_snapshot_sha256);
  exactKeys(name.body, ['tag_key', 'state', 'name']); assert.equal(name.body.tag_key, hash(ALBUM_TAG));
  assert.equal(name.body.state, 'current'); assert.equal(name.body.name, CONTINUED_LABEL);
  const guards = assessManagerGuards(publication, playback);
  assert.equal(guards.publisher_id_sha256, receipt.publisher_id_sha256); assert.equal(guards.saved_revision, 11);
  assert.equal(guards.persistence, 'empty'); assert.equal(guards.active_revision, null); assert.equal(guards.active_checksum, null);
  assert.equal(publication.body.high_water, 0); assert.equal(publication.body.reconciliation_required, false);
  exactKeys(recovery.body, ['reconciliation_required']); assert.equal(recovery.body.reconciliation_required, false);
  return { assignment_snapshot_sha256: receipt.assignment_snapshot_sha256, name_sha256: hash(CONTINUED_LABEL),
    guards, high_water: 0, recovery_guard: false, reconciliation_required: false };
}

export async function waitNaturalDeadline(targetMs, { maximumMs, onTick = async () => {}, notify = () => {},
  now = Date.now, monotonic = () => performance.now(), sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  const started = now(), mono = monotonic(), required = targetMs - started;
  assert.ok(Number.isFinite(required) && required > 0 && required <= maximumMs && maximumMs <= 310000);
  notify({ operation: 'real_wait', checkpoint: 'begin', count: Math.ceil(required / 1000) });
  while (monotonic() - mono < required) {
    const elapsed = monotonic() - mono; assert.ok(elapsed >= 0 && elapsed <= maximumMs + 2000);
    const duration = Math.min(15000, required - elapsed);
    await withinDeadline('real_wait', () => sleep(duration), { timeoutMs: Math.ceil(duration) + 2000 });
    assert.ok(Math.abs((now() - started) - (monotonic() - mono)) <= 2000, 'clock_changed');
    await onTick(); notify({ operation: 'real_wait', checkpoint: 'complete', count: Math.max(0, Math.ceil((required - (monotonic() - mono)) / 1000)) });
  }
  assert.ok(now() >= targetMs); assert.ok(monotonic() - mono <= maximumMs + 2000);
  return { natural_elapsed_ms: Math.floor(monotonic() - mono), required_real_wait_ms: Math.ceil(required),
    target_utc: new Date(targetMs).toISOString(), clock_edits: false };
}

export async function finishMetadataFixture({ state, control, report }) {
  if (!state.faultApplied || state.freshApplied) return;
  if (!state.expectedProviderFailure || state.authorityDenied || state.controlUncertain) {
    report.fixture_cleanup = { attempted: false, reason: state.authorityDenied ? 'authority_denied_terminal' : 'reconciliation_required' }; return;
  }
  // One same-client cleanup is authorized after the expected provider error.
  // Unknown outcomes and authentication rejection never trigger a retry.
  state.controlUncertain = true;
  await control('metadata', 'fresh'); state.freshApplied = true; state.controlUncertain = false;
  report.fixture_cleanup = { attempted: true, restored_fresh: true };
}

async function nativeState(manager, receipt) {
  const endpoints = { page: 'assignments?offset=0&limit=100', name: `tags/${hash(ALBUM_TAG)}/name`,
    publication: 'publication', playback: 'playback-status', recovery: 'recovery' };
  const values = {};
  for (const [key, endpoint] of Object.entries(endpoints)) {
    const notify = value => manager.notify?.({ ...value, category: nativeEndpointCategory(endpoint) });
    values[key] = await withinDeadline('native_read', () => manager.frame.evaluate(async ({ base, endpoint }) => {
      const response = await fetch(new URL('api/v1/' + endpoint, base), { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000) });
      return { status: response.status, body: await response.json() };
    }, { base: manager.frame.url(), endpoint }), { notify });
  }
  return assessMetadataState(values, receipt);
}

export async function metadataUIRequest(manager, state) {
  const target = LOCAL_ORIGIN + manager.prefix + 'api/v1/music/resolve';
  const expected = JSON.stringify({ input: ALBUM_URI, media_type: 'album' });
  let count = 0, unexpected = 0;
  const observe = request => {
    if (request.url() !== target || request.method() !== 'POST') return;
    count += 1;
    try { assert.equal(request.frame(), manager.frame); assert.equal(request.postData(), expected); }
    catch { unexpected += 1; }
  };
  manager.page.on('request', observe);
  try {
    const music = manager.frame.getByRole('region', { name: 'Music preview', exact: true });
    await music.getByLabel('Music type', { exact: true }).selectOption('album');
    await music.getByLabel('Spotify URI or link', { exact: true }).fill(ALBUM_URI);
    const waiting = manager.page.waitForResponse(value => value.url() === target
      && value.request().method() === 'POST' && value.request().frame() === manager.frame, { timeout: 15000 }); waiting.catch(() => {});
    const [response] = await withinDeadline('response_headers', () => Promise.all([waiting,
      music.getByRole('button', { name: 'Preview URI', exact: true }).click()]), { timeoutMs: 20000, notify: manager.notify });
    if ([401, 403].includes(response.status())) { state.authorityDenied = true; throw new Error('authority_denied_terminal'); }
    assert.ok([200, 503].includes(response.status()));
    assert.equal(await withinDeadline('response_finished', () => response.finished(), { timeoutMs: 5000, notify: manager.notify }), null);
    const body = await withinDeadline('response_body', () => response.json(), { timeoutMs: 5000, notify: manager.notify });
    if (['unauthorized', 'forbidden'].includes(body?.error)) { state.authorityDenied = true; throw new Error('authority_denied_terminal'); }
    assert.equal(count, 1); assert.equal(unexpected, 0);
    return { status: response.status(), body, actual_UI_request_count: count, exact_synthetic_input: true };
  } finally { manager.page.off('request', observe); }
}

async function metadataDOM(manager, kind) {
  const music = manager.frame.getByRole('region', { name: 'Music preview', exact: true });
  const selected = music.getByLabel('Selected music preview', { exact: true });
  await withinDeadline('dom', async () => {
    await manager.expect(selected).toContainText('Synthetic Jukelet62 album');
    await manager.expect(selected.locator('code.exact-id')).toHaveText(ALBUM_URI);
    await manager.expect(selected).toContainText(`Metadata: ${kind}.`);
    await manager.expect(selected.getByRole('img', { name: /^Artwork for / })).toHaveCount(0);
    if (kind === 'stale') await manager.expect(selected.getByRole('status')).toContainText('Lookup availability does not determine playability.');
  }, { notify: manager.notify });
  return { actual_title_and_exact_URI_retained: true, state_displayed: kind, artwork_absent: true,
    ...(kind === 'stale' ? { availability_not_playability_caveat_displayed: true } : {}) };
}

export async function runMetadataFallback(path, { progress = () => {} } = {}) {
  const report = { fixture: FIXTURE, phase: 'metadata-fallback', stage: 'local_inputs', result: 'FAIL', checks: {}, limitations: [
    'Synthetic metadata in the owned HA OS fixture through actual native Ingress and Supervisor/Core; no Spotify account, external artwork or physical playback proof.',
    'Real300s cache expiry and observed30s negative-cache delay; no clock/cache/database edits. Explicit fresh recovery is a separate declared request, with no automatic mutation retry.',
    'Only existing authenticated parent.hass.callWS status and metadata fresh/unavailable controls are used; auth denial is terminal with no alternative credential or transport.',
    'Protected backup scope is task-owned private archive/hash/readback only; SQL/audit and installed artifact/script identities remain independent coordinator evidence.',
    'Blocked service workers retain the strict known-parent-warning assessment; normal service-worker behavior and other issue acceptance cases remain separate.',
  ] };
  const gate = new ManagerWriteGate(), state = { authorityDenied: false, controlUncertain: false, faultApplied: false,
    freshApplied: false, expectedProviderFailure: false, mode: 'fresh', instanceHash: null };
  let manager, receipt, inputs, control, detach;
  const notify = value => progress({ role: 'A', stage: report.stage, ...value });
  const stage = value => { report.stage = value; notify({ operation: 'phase', checkpoint: 'begin' }); };
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_metadata.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs',
      'browser_manager.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    inputs = readPublicInputs(path); stage('root_readiness_receipt');
    const bytes = readBoundedFile(join(CONTROL_ROOT, 'metadata-ready.json'), 16384); receipt = parseMetadataReceipt(bytes.toString('utf8'));
    report.checks.readiness = { ...validateMetadataReceipt(receipt, inputs), file_sha256: hash(bytes) };
    manager = await openNativeManager(inputs, report, { requestAllowed: (request, scope) => gate.allow(request, scope), setStage: stage, progress: notify });
    assert.equal(report.checks.native_reads.user_id_sha256, receipt.admin_user_id_sha256);
    report.checks.inventory = assessDiagnosticInventory(manager.observations.inventory);
    report.checks.bootstrap_network = assessNetworkBoundaries(manager.network, manager.networkCategories);
    const watchDenial = response => {
      try {
        if (response.request().frame() === manager.frame && response.url().startsWith(LOCAL_ORIGIN + manager.prefix + 'api/v1/')
          && [401, 403].includes(response.status())) state.authorityDenied = true;
      } catch { /* Detached frames confer no authority. */ }
    };
    manager.page.on('response', watchDenial); detach = () => manager.page.off('response', watchDenial);
    report.checks.fixture_observations = [];
    control = async (action, mode) => {
      validateMetadataReceipt(receipt, inputs); assert.equal(state.authorityDenied, false);
      const expectedMode = action === 'metadata' ? mode : state.mode;
      state.controlUncertain = true;
      let result;
      try {
        result = await withinDeadline('fixture_control', () => manager.page.mainFrame().evaluate(callFixtureControl,
          { action, mode, user_id_sha256: receipt.admin_user_id_sha256 }), { timeoutMs: 10000, notify });
      } catch (error) { state.controlUncertain = true; throw error; }
      if (result.outcome === 'AUTH_DENIED') state.authorityDenied = true;
      if (result.outcome !== 'PASS') { state.controlUncertain = true; throw new Error('fixture_control_failed'); }
      assert.equal(result.actual_admin_user_id_sha256, receipt.admin_user_id_sha256);
      const status = assessFixtureStatus(result.status, expectedMode, state.instanceHash);
      state.instanceHash ??= status.instance_sha256; state.mode = expectedMode; state.controlUncertain = false;
      assert.ok(report.checks.fixture_observations.length < 64);
      report.checks.fixture_observations.push({ action, ...status }); return status;
    };
    stage('metadata_state_before'); report.checks.state_before = await nativeState(manager, receipt);
    const before = await control('status', null);
    stage('metadata_seed'); const seed = await metadataUIRequest(manager, state);
    report.checks.seed = { ...assessMetadataPreview(seed, 'fresh'), actual_UI_request_count: seed.actual_UI_request_count,
      exact_synthetic_input: seed.exact_synthetic_input, ...await metadataDOM(manager, 'fresh') };
    const seeded = await control('status', null);
    assert.ok([0, 1].includes(seeded.metadata_calls - before.metadata_calls));
    report.checks.seed.provider_call_delta = seeded.metadata_calls - before.metadata_calls;
    const seedTime = Date.parse(seed.body.last_success_at);
    assert.ok(seedTime <= Date.now() + 5000 && Date.now() - seedTime <= 305000);
    const target = Math.max(seedTime + 302000, Date.now() + 2000);
    stage('metadata_cache_wait');
    report.checks.real_cache_wait = await waitNaturalDeadline(target, { maximumMs: 310000, notify,
      onTick: async () => { const status = await control('status', null); assertFixtureDelta(seeded, status, 'fresh', 0); assert.equal(state.authorityDenied, false); } });
    stage('metadata_fault'); const unavailable = await control('metadata', 'unavailable'); state.faultApplied = true;
    assert.equal(unavailable.metadata_calls, seeded.metadata_calls);
    stage('metadata_stale'); const failure = await metadataUIRequest(manager, state), failedAt = Date.now();
    assessMetadataPreview(failure, 'stale'); state.expectedProviderFailure = true;
    const failed = await control('status', null);
    report.checks.stale = { ...assessMetadataFailure(seed, failure, unavailable, failed), actual_UI_request_count: failure.actual_UI_request_count,
      exact_synthetic_input: failure.exact_synthetic_input, ...await metadataDOM(manager, 'stale') };
    report.checks.state_during_failure = await nativeState(manager, receipt);
    stage('metadata_restore_fresh'); const restored = await control('metadata', 'fresh'); state.freshApplied = true;
    assert.equal(restored.metadata_calls, failed.metadata_calls);
    stage('metadata_retry_wait');
    report.checks.real_retry_wait = await waitNaturalDeadline(Math.max(failedAt + failure.body.retry_after * 1000 + 2000, Date.now() + 2000),
      { maximumMs: 35000, notify, onTick: async () => { const status = await control('status', null); assertFixtureDelta(restored, status, 'fresh', 0); } });
    stage('metadata_recovery'); const recovered = await metadataUIRequest(manager, state), finalFixture = await control('status', null);
    report.checks.recovery = { ...assessMetadataRecovery(seed, failure, recovered, restored, finalFixture), actual_UI_request_count: recovered.actual_UI_request_count,
      exact_synthetic_input: recovered.exact_synthetic_input, ...await metadataDOM(manager, 'fresh') };
    stage('metadata_state_after'); report.checks.state_after = await nativeState(manager, receipt);
    assert.deepEqual(report.checks.state_after, report.checks.state_before);
    assert.equal(state.authorityDenied, false); assert.equal(gate.enabled, false); assert.equal(gate.settled().length, 0);
    stage('close_browsers_and_assess'); assert.equal((await manager.cleanup()).cleanup_confirmed, true);
    assert.equal(state.authorityDenied, false);
    report.checks.network_assessment = assessNetworkBoundaries(manager.network, manager.networkCategories);
    report.result = 'PASS'; stage('complete'); notify({ operation: 'phase', checkpoint: 'complete' });
  } catch (error) {
    report.code = state.authorityDenied ? 'authority_denied_terminal' : error?.code === 'native_deadline' ? 'native_deadline' : 'native_metadata_failed';
    notify({ operation: 'phase', checkpoint: 'failed' });
  } finally {
    gate.disable();
    if (manager) {
      try { await finishMetadataFixture({ state, control, report }); }
      catch { report.result = 'FAIL'; report.fixture_cleanup = { attempted: true, restored_fresh: false, reconciliation_required: true }; }
      if (!(await manager.cleanup()).cleanup_confirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
      detach?.(); report.checks.network = { ...manager.network };
      report.checks.write_gate_enabled = gate.enabled; report.checks.writes_forwarded = gate.observed.length;
    }
    report.fixture_final_observation = { last_observed_metadata_mode: state.mode, fault_applied: state.faultApplied,
      fresh_restored: state.freshApplied, authority_denied: state.authorityDenied, control_uncertain: state.controlUncertain };
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write('node scripts/haos_acceptance/browser_metadata.mjs metadata-fallback CONFIG_A\n');
  else if (args.length === 2 && args[0] === 'metadata-fallback') {
    const report = await runMetadataFallback(args[1], { progress: createProgressStream(line => process.stderr.write(line)) });
    const unconfirmed = report.checks.cleanup?.cleanup_confirmed === false;
    if (unconfirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; report.forced_exit_after_report = true; }
    process.exitCode = report.result === 'PASS' ? 0 : 1;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => { if (unconfirmed) process.stderr.write('', () => process.exit(1)); });
  } else { process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'invalid_phase_arguments' }) + '\n'); process.exitCode = 2; }
}
