/** Owned-fixture reviewed recovery publication; imports perform no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ALBUM_TAG, PLAYLIST_TAG, assessAssignmentState, assessDiagnosticInventory, assignmentInput,
  parseManagerReceipt, validateManagerReadiness } from './browser_manager.mjs';
import { assessFixtureStatus, callFixtureControl } from './browser_metadata.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, readBoundedFile, readOnlyRequestAllowed, readPublicInputs } from './browser_inputs.mjs';
import { createProgressStream, nativeEndpointCategory, withinDeadline } from './browser_progress.mjs';

const TAGS = [ALBUM_TAG, PLAYLIST_TAG];
const keys = (value, expected) => { assert.ok(value && Object.getPrototypeOf(value) === Object.prototype); assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); };

export function parsePublicationBaseline(raw) {
  const value = JSON.parse(raw), tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const fields = tokens.flatMap((value, index) => tokens[index + 1] === ':' ? [JSON.parse(value)] : []);
  assert.equal(fields.length, 13); assert.equal(new Set(fields).size, fields.length); return value;
}

export function validatePublicationBaseline(value, inputs, ready, now = Date.now()) {
  keys(value, ['schema_version', 'fixture', 'synthetic', 'origin', 'configuration_A_sha256', 'configuration_B_sha256',
    'publisher_id_sha256', 'assignment_snapshot_sha256', 'domain_revision', 'album_version', 'source_restore_report_sha256', 'current_backup_artifact_sha256', 'observed_at']);
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, FIXTURE); assert.equal(value.synthetic, true); assert.equal(value.origin, LOCAL_ORIGIN);
  assert.equal(value.domain_revision, 13); assert.equal(value.album_version, 9);
  for (const key of ['configuration_A_sha256', 'configuration_B_sha256', 'publisher_id_sha256', 'assignment_snapshot_sha256', 'source_restore_report_sha256', 'current_backup_artifact_sha256']) assert.match(value[key], /^[a-f0-9]{64}$/);
  assert.equal(value.configuration_A_sha256, inputs.A.configuration_sha256); assert.equal(value.configuration_B_sha256, inputs.B.configuration_sha256);
  assert.equal(value.current_backup_artifact_sha256, ready.backup_artifact_sha256);
  assert.equal(value.source_restore_report_sha256, 'ef005f8ba1e8f55c76e069079ed478f0f9ee3bc43f681e0cfeb7c722bf9e4110');
  const observed = Date.parse(value.observed_at); assert.ok(Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= 3600000);
  return { publisher_id_sha256: value.publisher_id_sha256, assignment_snapshot_sha256: value.assignment_snapshot_sha256,
    backup_artifact_sha256: value.current_backup_artifact_sha256, observed_at: value.observed_at };
}

export function assessAssignments(page, baseline) {
  assert.equal(page.status, 200); keys(page.body, ['assignments', 'total', 'revision']);
  assert.equal(page.body.revision, 13); assert.equal(page.body.total, 2); assert.equal(page.body.assignments.length, 2);
  for (const [tag, prior] of [[ALBUM_TAG, 8], [PLAYLIST_TAG, 4]]) {
    const rows = page.body.assignments.filter(row => row.ha_tag_id === tag); assert.equal(rows.length, 1);
    assessAssignmentState({ version: rows[0].version, assignment: rows[0] }, assignmentInput(tag, prior));
  }
  assert.equal(hash(JSON.stringify(page.body)), baseline.assignment_snapshot_sha256);
  return { saved_revision: 13, album_version: 9, playlist_version: 5, assignment_snapshot_sha256: baseline.assignment_snapshot_sha256 };
}

export function assessBridge(bridge, publisherHash) {
  assert.equal(bridge.protocol_version, 1); assert.equal(bridge.schema_version, 1); assert.equal(hash(bridge.publisher_id), publisherHash);
  assert.equal(bridge.dispatch_enabled, false); assert.equal(bridge.last_error, null);
  assert.deepEqual(bridge.supported_media, ['album', 'playlist']); assert.deepEqual(bridge.supported_preferences, ['enabled', 'shuffle']); assert.deepEqual(bridge.playback_profiles, ['default']);
  if (bridge.persistence === 'empty') { assert.equal(bridge.active_revision, null); assert.equal(bridge.active_checksum, null); assert.equal(bridge.mapping_count, 0); }
  else { assert.equal(bridge.persistence, 'healthy'); assert.equal(bridge.active_revision, 1); assert.match(bridge.active_checksum, /^[a-f0-9]{64}$/); assert.equal(bridge.mapping_count, 2); }
  return { publisher_id_sha256: publisherHash, active_revision: bridge.active_revision, active_checksum: bridge.active_checksum,
    persistence: bridge.persistence, mappings: bridge.mapping_count, dispatch: 'disabled' };
}

function immutableAppStatus(publication, target) {
  assert.equal(hash(publication.publisher_id), target.publisher_id_sha256); assert.equal(publication.desired_version, 13);
  assert.equal(publication.desired_checksum, target.checksum); assert.equal(publication.mapping_count, 2);
  assert.equal(publication.automatic_enabled, false); assert.equal(publication.playback_verified, null); assert.equal(publication.actual_stale, false);
  assert.equal(publication.high_water, 1); assert.equal(publication.jobs.length, 1);
  const job = publication.jobs[0]; assert.equal(job.revision, 1); assert.equal(job.desired_version, 13);
  // The existing untyped SQLite SELECT exposes the recovery flag as integer 1.
  assert.equal(job.checksum, target.checksum); assert.equal(job.recovery, 1);
  assert.ok(Number.isFinite(Date.parse(job.created_at)));
  assert.equal(publication.shuffle_conflict, false); assert.deepEqual(publication.pending_removals, []);
  assert.ok(['queued', 'in_flight', 'uncertain', 'verified'].includes(job.state)); return job;
}

export function assessQueueAcknowledgment(publication, target) {
  const job = immutableAppStatus(publication, target);
  return { reservation_revision: 1, desired_revision: 13, target_checksum: target.checksum, observed_job_state: job.state,
    queue_acknowledgment_only: true, independently_verified: false };
}

export function assessPublicationCompletion(publication, bridge, target) {
  const job = immutableAppStatus(publication, target), actual = assessBridge(bridge, target.publisher_id_sha256);
  const backend = assessBridge(publication.actual, target.publisher_id_sha256);
  if (actual.persistence === 'healthy') assert.equal(actual.active_checksum, target.checksum);
  if (backend.persistence === 'healthy') assert.equal(backend.active_checksum, target.checksum);
  if (!publication.verified) {
    assert.equal(publication.verified, false); assert.ok(['queued', 'in_flight', 'uncertain'].includes(job.state));
    assert.equal(publication.reconciliation_required, true); assert.equal(publication.healthy, false);
    return { complete: false, observed_job_state: job.state, direct_HA_revision: actual.active_revision, backend_HA_revision: backend.active_revision };
  }
  assert.equal(publication.healthy, true); assert.equal(publication.reconciliation_required, false); assert.equal(job.state, 'verified');
  assert.equal(publication.active_revision, 1); assert.equal(publication.active_desired_version, 13); assert.equal(publication.active_checksum, target.checksum);
  assert.equal(actual.persistence, 'healthy', 'independent_HA_not_healthy'); assert.equal(backend.persistence, 'healthy');
  assert.equal(publication.error, null);
  assert.equal(actual.active_revision, 1); assert.equal(backend.active_revision, 1);
  return { complete: true, target_revision: 1, desired_revision: 13, checksum: target.checksum, one_verified_recovery_job: true,
    backend_and_independent_HA_exact: true, publisher_id_sha256: target.publisher_id_sha256, reconciliation_cleared: true,
    automatic_publication: 'disabled', dispatch: 'disabled', independently_playback_verified: false };
}

export function assessExecutionFence(value) {
  assert.equal(value.status, 200); const body = value.body;
  assert.equal(body.connection, 'connected'); assert.equal(body.stale, false);
  const diagnostic = body.diagnostics; assert.equal(diagnostic.diagnostics_version, 1); assert.equal(diagnostic.dispatch_enabled, false);
  assert.equal(diagnostic.busy, false); assert.equal(diagnostic.execution_uncertain, true); assert.equal(diagnostic.last_attempt, null);
  assert.equal(diagnostic.playback_verification, 'unavailable');
  return { dispatch: 'disabled', execution_uncertain: true, busy: false, attempts: 0, playback_verification: 'unavailable' };
}

export function assessRecoveryReview(body, baseline, checksum) {
  keys(body, ['review_token', 'action', 'mappings', 'desired_version', 'checksum', 'mapping_count', 'empty', 'pending_removals', 'shuffle_conflict', 'actual']);
  assert.ok(typeof body.review_token === 'string' && body.review_token.length >= 32 && body.review_token.length <= 128);
  assert.equal(body.action, 'recover'); assert.equal(body.desired_version, 13); assert.equal(body.checksum, checksum);
  assert.equal(body.mapping_count, 2); assert.equal(body.empty, false); assert.deepEqual(body.pending_removals, []); assert.equal(body.shuffle_conflict, false);
  assert.equal(body.mappings.length, 2);
  for (const tag of TAGS) {
    const rows = body.mappings.filter(row => row.tag_id === tag); assert.equal(rows.length, 1); const expected = assignmentInput(tag, 0);
    assert.deepEqual(rows[0], { tag_id: tag, media_type: expected.media_type, spotify_uri: expected.input, enabled: true,
      shuffle: expected.shuffle, playback_profile_id: 'default' });
  }
  const actual = assessBridge(body.actual, baseline.publisher_id_sha256); assert.equal(actual.persistence, 'empty');
  return { checksum: body.checksum, desired_revision: 13, expected_next_revision: 1, review_token_sha256: hash(body.review_token), action: 'recover', mappings: 2 };
}

export class PublicationGate {
  constructor(verify) { this.verify = verify; this.armed = null; this.records = new Map(); }
  bindReview(value) { assert.equal(this.reviewToken, undefined); assert.equal(typeof value, 'string'); this.reviewToken = value; }
  grant(kind, body) {
    assert.equal(this.armed, null); assert.equal(this.records.has(kind), false); this.verify();
    const value = JSON.parse(body); assert.equal(body, JSON.stringify(value));
    if (kind === 'review') assert.deepEqual(value, { action: 'recover' });
    else {
      assert.equal(kind, 'confirm'); assert.equal(typeof this.reviewToken, 'string');
      assert.deepEqual(value, { review_token: this.reviewToken, confirmed: true, confirm_empty: false, automatic_publication_attested: false });
    }
    this.records.set(kind, { body, forwarded: false }); this.armed = kind;
  }
  allow(request, { fromFrame, prefix }) {
    if (readOnlyRequestAllowed(request.url(), request.method())) return true;
    if (!fromFrame || !prefix || !this.armed) return false;
    const expected = this.records.get(this.armed);
    if (request.url() !== LOCAL_ORIGIN + prefix + 'api/v1/publication/' + this.armed || request.method() !== 'POST' || request.postData() !== expected.body) return false;
    expected.forwarded = true; this.armed = null; return true;
  }
  fence() { this.armed = null; }
  evidence() { return [...this.records].map(([intent, value]) => ({ intent, forwarded: value.forwarded, enabled: this.armed === intent, body_sha256: hash(value.body) })); }
}

// Only the supported initialized public client and one fixed read-only command.
export async function readBridgeInBrowser(value, scope = globalThis) {
  if (!value || Object.keys(value).join(',') !== 'user_id_sha256') return { outcome: 'INVALID_CONTEXT' };
  const { user_id_sha256 } = value;
  if (!/^[a-f0-9]{64}$/.test(user_id_sha256) || scope.location?.origin !== 'https://127.0.0.1:18223') return { outcome: 'INVALID_CONTEXT' };
  if (typeof scope.document?.querySelector !== 'function') return { outcome: 'CLIENT_UNAVAILABLE' };
  const element = scope.document?.querySelector('home-assistant'), hass = element?.hass;
  if (element?.tagName !== 'HOME-ASSISTANT' || !hass || typeof hass.callWS !== 'function' || hass.connected !== true || hass.connection?.connected !== true) return { outcome: 'CLIENT_UNAVAILABLE' };
  if (hass.user?.is_admin !== true || typeof hass.user.id !== 'string' || !hass.user.id.length || hass.user.id.length > 256) return { outcome: 'AUTH_DENIED' };
  const bytes = await scope.crypto.subtle.digest('SHA-256', new TextEncoder().encode(hass.user.id));
  const actual = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== user_id_sha256) return { outcome: 'AUTH_DENIED' };
  try { return { outcome: 'PASS', status: await hass.callWS({ type: 'jukelet_bridge/status' }) }; }
  catch (error) { return { outcome: ['unauthorized', 'forbidden', 'not_authorized'].includes(error?.code) ? 'AUTH_DENIED' : 'READ_FAILED' }; }
}

export function assessPublicationStart(publication, direct, recovery, baseline) {
  assert.equal(hash(publication.publisher_id), baseline.publisher_id_sha256); assert.equal(publication.desired_version, 13);
  assert.match(publication.desired_checksum, /^[a-f0-9]{64}$/); assert.equal(publication.mapping_count, 2);
  assert.equal(publication.high_water, 0); assert.equal(publication.automatic_enabled, false); assert.equal(publication.healthy, false);
  assert.equal(publication.reconciliation_required, true); assert.equal(publication.verified, false); assert.equal(publication.actual_stale, false);
  assert.equal(publication.active_revision, null); assert.equal(publication.active_desired_version, null); assert.equal(publication.active_checksum, null);
  assert.deepEqual(publication.jobs, []); assert.equal(publication.playback_verified, null);
  assert.equal(publication.shuffle_conflict, false); assert.deepEqual(publication.pending_removals, []);
  keys(recovery, ['reconciliation_required']); assert.equal(recovery.reconciliation_required, true);
  for (const value of [direct, publication.actual]) assert.equal(assessBridge(value, baseline.publisher_id_sha256).persistence, 'empty');
  return { desired_revision: 13, high_water: 0, jobs: 0, reconciliation_required: true, actual_snapshot: 'empty',
    desired_checksum: publication.desired_checksum, publisher_id_sha256: baseline.publisher_id_sha256, automatic_publication: 'disabled', dispatch: 'disabled' };
}

// The same real UI request, frame and completed body establish each intent.
// Success is never inferred from a click or a transport acknowledgment alone.
export async function publicationUIRequest(manager, gate, kind, body, click) {
  assert.equal(manager.authorityDenied, false);
  const target = LOCAL_ORIGIN + manager.prefix + 'api/v1/publication/' + kind;
  let request; const source = { requests: 0, unexpected: 0 };
  const started = value => {
    if (value.url() !== target || value.method() !== 'POST') return;
    source.requests += 1; if (!request) request = value;
    try { assert.equal(value.frame(), manager.frame); assert.equal(value.postData(), body); } catch { source.unexpected += 1; }
  };
  manager.page.on('request', started);
  try {
    gate.grant(kind, body);
    const waiting = manager.page.waitForResponse(value => value.url() === target && value.request().method() === 'POST'
      && value.request().frame() === manager.frame, { timeout: 15000 }); waiting.catch(() => {});
    const [response] = await withinDeadline('response_headers', () => Promise.all([waiting, click()]), { timeoutMs: 20000, notify: manager.notify });
    if ([401, 403].includes(response.status())) { manager.authorityDenied = true; throw new Error('authority_denied_terminal'); }
    assert.equal(response.status(), 200); assert.equal(response.request(), request);
    assert.equal(await withinDeadline('response_finished', () => response.finished(), { timeoutMs: 5000, notify: manager.notify }), null);
    const actual = await withinDeadline('response_body', () => response.json(), { timeoutMs: 5000, notify: manager.notify });
    assert.deepEqual(source, { requests: 1, unexpected: 0 }); assert.equal(gate.records.get(kind).forwarded, true);
    return { body: actual, evidence: { actual_status: 200, one_exact_UI_request: true, actual_PW_finished_null: true, body_sha256: hash(JSON.stringify(actual)) } };
  } finally { gate.fence(); manager.page.off('request', started); }
}

async function readNative(manager, endpoint) {
  assert.ok(['assignments?offset=0&limit=100', 'publication', 'recovery', 'playback-status'].includes(endpoint));
  assert.equal(manager.authorityDenied, false);
  const result = await withinDeadline('native_read', () => manager.frame.evaluate(async ({ base, endpoint }) => {
    const response = await fetch(new URL('api/v1/' + endpoint, base), { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  }, { base: manager.frame.url(), endpoint }), { notify: value => manager.notify?.({ ...value, category: nativeEndpointCategory(endpoint) }) });
  if ([401, 403].includes(result.status)) manager.authorityDenied = true;
  assert.equal(result.status, 200); return result;
}

async function parentRead(manager, operation, userHash) {
  assert.equal(manager.authorityDenied, false);
  const result = await withinDeadline('fixture_control', () => manager.page.mainFrame().evaluate(operation,
    operation === callFixtureControl ? { action: 'status', mode: null, user_id_sha256: userHash } : { user_id_sha256: userHash }), { timeoutMs: 10000, notify: manager.notify });
  if (result.outcome === 'AUTH_DENIED') manager.authorityDenied = true;
  assert.equal(result.outcome, 'PASS'); return result.status;
}

export async function runPublication(pathA, pathB, { progress = () => {} } = {}) {
  const report = { fixture: FIXTURE, phase: 'publication-recover', stage: 'local_inputs', result: 'FAIL', checks: {}, limitations: [
    'Only current13 reviewed recovery publication. The queued response is not completion; app verified-job state and a separate authenticated HA bridge/status read must agree on the exact immutable review target.',
    'Read-only HA commands use the existing public parent client and actual admin identity. No credential storage or alternative transport is accessed.',
    'Automatic publication and dispatch remain disabled; execution uncertainty remains fenced. No scans, startup invocation, physical playback, or whole-issue acceptance is claimed.',
    'Durable guard generation, establishment/history and protected backup artifact remain separate coordinator evidence. Service workers are blocked; normal HA service-worker behavior is not certified.',
  ] };
  let inputs, ready, baseline, manager, gate;
  const notify = value => progress({ role: 'A', stage: report.stage, ...value });
  const stage = value => { report.stage = value; notify({ operation: 'phase', checkpoint: 'begin' }); };
  const verify = () => { validateManagerReadiness(ready, inputs); validatePublicationBaseline(baseline, inputs, ready); assert.notEqual(manager?.authorityDenied, true); };
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_publication.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs',
      'browser_manager.mjs', 'browser_metadata.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    inputs = { A: readPublicInputs(pathA), B: readPublicInputs(pathB) }; stage('root_readiness_receipt');
    const readyBytes = readBoundedFile(join(CONTROL_ROOT, 'publication-ready.json'), 16384); ready = parseManagerReceipt(readyBytes.toString('utf8'));
    const baselineBytes = readBoundedFile(join(CONTROL_ROOT, 'publication-baseline.json'), 16384); baseline = parsePublicationBaseline(baselineBytes.toString('utf8')); verify();
    report.checks.readiness = { ...validateManagerReadiness(ready, inputs), file_sha256: hash(readyBytes) };
    report.checks.baseline = { ...validatePublicationBaseline(baseline, inputs, ready), file_sha256: hash(baselineBytes) };
    gate = new PublicationGate(verify);
    manager = await openNativeManager(inputs.A, report, { requestAllowed: (request, scope) => gate.allow(request, scope), setStage: stage, progress: notify });
    manager.authorityDenied = false;
    manager.page.on('response', response => {
      try { if (response.request().frame() === manager.frame && response.url().startsWith(LOCAL_ORIGIN + manager.prefix + 'api/v1/')
        && [401, 403].includes(response.status())) manager.authorityDenied = true; } catch { /* Detached frames confer no authority. */ }
    });
    assert.equal(report.checks.native_reads.user_id_sha256, ready.admin_A_user_id_sha256);
    report.checks.inventory = assessDiagnosticInventory(manager.observations.inventory);
    report.checks.bootstrap_network = assessNetworkBoundaries(manager.network, manager.networkCategories);
    stage('publication_state_before');
    report.checks.assignments_before = assessAssignments(await readNative(manager, 'assignments?offset=0&limit=100'), baseline);
    report.checks.execution_before = assessExecutionFence(await readNative(manager, 'playback-status'));
    const initial = (await readNative(manager, 'publication')).body;
    report.checks.initial = assessPublicationStart(initial, await parentRead(manager, readBridgeInBrowser, ready.admin_A_user_id_sha256),
      (await readNative(manager, 'recovery')).body, baseline);
    report.checks.fixture_before = assessFixtureStatus(await parentRead(manager, callFixtureControl, ready.admin_A_user_id_sha256), 'fresh');
    const publication = manager.frame.getByRole('region', { name: 'Publication status', exact: true });
    await manager.expect(publication.getByRole('button', { name: 'Review snapshot publication', exact: true })).toBeDisabled();
    await manager.expect(publication).toContainText('Recovery reconciliation required. Automatic publication is suspended.');
    stage('publication_recovery_review');
    const review = await publicationUIRequest(manager, gate, 'review', JSON.stringify({ action: 'recover' }),
      () => publication.getByRole('button', { name: 'Review publication recovery', exact: true }).click());
    report.checks.review = { ...assessRecoveryReview(review.body, baseline, initial.desired_checksum), source: review.evidence };
    gate.bindReview(review.body.review_token);
    const target = { publisher_id_sha256: baseline.publisher_id_sha256, checksum: review.body.checksum };
    const region = manager.frame.getByRole('region', { name: 'Review immutable snapshot', exact: true });
    await manager.expect(region.getByRole('heading', { name: 'Review recovery snapshot', exact: true })).toBeVisible();
    await manager.expect(region).toContainText('Saved revision 13 · 2 mappings');
    const codes = await region.locator('code').allTextContents();
    for (const tag of TAGS) { assert.ok(codes.includes(tag)); assert.ok(codes.includes(assignmentInput(tag, 0).input)); }
    await region.getByLabel('I reviewed this exact snapshot and its preferences', { exact: true }).check();
    stage('publication_recovery_confirm');
    const confirmation = JSON.stringify({ review_token: review.body.review_token, confirmed: true, confirm_empty: false, automatic_publication_attested: false });
    const ack = await publicationUIRequest(manager, gate, 'confirm', confirmation,
      () => region.getByRole('button', { name: 'Confirm reviewed recovery', exact: true }).click());
    report.checks.queue_acknowledgment = { ...assessQueueAcknowledgment(ack.body, target), source: ack.evidence };
    stage('publication_exact_readback'); report.checks.readback_observations = [];
    const deadline = performance.now() + 40000;
    for (;;) {
      assert.ok(performance.now() < deadline, 'publication_readback_deadline');
      const pub = (await readNative(manager, 'publication')).body;
      const direct = await parentRead(manager, readBridgeInBrowser, ready.admin_A_user_id_sha256);
      const observed = assessPublicationCompletion(pub, direct, target); report.checks.readback_observations.push(observed);
      notify({ operation: 'phase', checkpoint: 'body', count: report.checks.readback_observations.length, category: 'publication' });
      if (observed.complete) { report.checks.verified = observed; break; }
      assert.ok(report.checks.readback_observations.length < 40);
      await withinDeadline('real_wait', () => new Promise(resolve => setTimeout(resolve, 1000)), { timeoutMs: 2000, notify });
    }
    stage('publication_state_after');
    report.checks.assignments_after = assessAssignments(await readNative(manager, 'assignments?offset=0&limit=100'), baseline);
    assert.deepEqual(report.checks.assignments_after, report.checks.assignments_before);
    const recovery = (await readNative(manager, 'recovery')).body; keys(recovery, ['reconciliation_required']); assert.equal(recovery.reconciliation_required, false);
    report.checks.execution_after = assessExecutionFence(await readNative(manager, 'playback-status')); assert.deepEqual(report.checks.execution_after, report.checks.execution_before);
    report.checks.fixture_after = assessFixtureStatus(await parentRead(manager, callFixtureControl, ready.admin_A_user_id_sha256), 'fresh', report.checks.fixture_before.instance_sha256);
    assert.deepEqual(report.checks.fixture_after, report.checks.fixture_before);
    await manager.expect(publication).toContainText('Published: exact saved content verified active in HA.', { timeout: 15000 });
    await manager.expect(publication).toContainText('Actual HA revision: 1 · Persistence: healthy');
    await manager.expect(publication).toContainText('Dispatch: disabled in HA · Playback: independently unverified');
    await manager.expect(publication).toContainText('Automatic publication: disabled; explicit persistent opt-in required');
    await manager.expect(publication.getByRole('button', { name: 'Review publication recovery', exact: true })).toHaveCount(0);
    await manager.expect(publication.getByRole('button', { name: 'Review snapshot publication', exact: true })).toBeEnabled();
    const playback = manager.frame.getByRole('region', { name: 'Tag playback readiness', exact: true });
    await manager.expect(playback).toContainText('Dispatch: disabled.');
    await manager.expect(playback).toContainText('Previous startup work may still be running.');
    gate.fence(); stage('close_browsers_and_assess'); assert.equal(manager.authorityDenied, false);
    assert.deepEqual(gate.evidence().map(value => [value.intent, value.forwarded, value.enabled]), [['review', true, false], ['confirm', true, false]]);
    assert.equal((await manager.cleanup()).cleanup_confirmed, true);
    report.checks.network_assessment = assessNetworkBoundaries(manager.network, manager.networkCategories);
    report.result = 'PASS'; stage('complete'); notify({ operation: 'phase', checkpoint: 'complete' });
  } catch (error) {
    report.code = manager?.authorityDenied ? 'authority_denied_terminal' : error?.code === 'native_deadline' ? 'native_deadline' : 'native_publication_failed';
    notify({ operation: 'phase', checkpoint: 'failed' });
  } finally {
    gate?.fence();
    if (manager) {
      if (!(await manager.cleanup()).cleanup_confirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
      report.checks.network = { ...manager.network };
    }
    report.intent_ledger = gate?.evidence() ?? []; report.any_gate_enabled = gate?.armed != null;
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write('node scripts/haos_acceptance/browser_publication.mjs publication-recover CONFIG_A CONFIG_B\n');
  else if (args.length === 3 && args[0] === 'publication-recover') {
    const report = await runPublication(args[1], args[2], { progress: createProgressStream(line => process.stderr.write(line)) });
    const unconfirmed = report.checks.cleanup?.cleanup_confirmed === false;
    if (unconfirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; report.forced_exit_after_report = true; }
    process.exitCode = report.result === 'PASS' ? 0 : 1;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => { if (unconfirmed) process.stderr.write('', () => process.exit(1)); });
  } else { process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'invalid_phase_arguments' }) + '\n'); process.exitCode = 2; }
}
