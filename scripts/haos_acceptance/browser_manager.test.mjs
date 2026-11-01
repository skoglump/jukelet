/** Local synthetic readiness and mutation-boundary tests; no native HA access. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { ALBUM_TAG, ALBUM_URI, PLAYLIST_TAG, PLAYLIST_URI, RENAMED_LABEL, ManagerWriteGate,
  assessAssignmentState, assessManagerGuards, assessTwoAdmins, assignmentInput,
  parseManagerReceipt, validateManagerReadiness } from './browser_manager.mjs';

function receipt() {
  return { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN,
    configuration_A_sha256: 'a'.repeat(64), configuration_B_sha256: 'b'.repeat(64),
    actual_candidate_image_manifest_digest: 'sha256:' + 'c'.repeat(64), actual_bridge_archive_sha256: 'd'.repeat(64),
    backup_id_sha256: 'e'.repeat(64), backup_artifact_sha256: 'f'.repeat(64),
    backup_readback_verified: true, backup_protected: true,
    admin_A_user_id_sha256: '1'.repeat(64), admin_B_user_id_sha256: '2'.repeat(64),
    automatic_publication_disabled: true, dispatch_disabled: true, observed_at: '2026-11-01T13:00:00.000Z' };
}

function inputs() {
  const document = { fixture: FIXTURE, origin: LOCAL_ORIGIN, denied_credentials_file: 'credentials-denied.json',
    admin_credentials_file: 'credentials-admin.json', candidate: { image_manifest_digest: 'sha256:' + 'c'.repeat(64) },
    bridge: { archive_sha256: 'd'.repeat(64) } };
  return { A: { document, configuration_sha256: 'a'.repeat(64), certificate: Buffer.from('SYNTHETIC_SAME_CERT') },
    B: { document: { ...structuredClone(document), admin_credentials_file: 'credentials-admin2.json' },
      configuration_sha256: 'b'.repeat(64), certificate: Buffer.from('SYNTHETIC_SAME_CERT') } };
}

test('manager writes refuse an unprotected or unverified backup receipt before native activity', () => {
  for (const field of ['backup_protected', 'backup_readback_verified']) {
    const value = receipt(); value[field] = false;
    assert.throws(() => validateManagerReadiness(value, {}, Date.parse('2026-11-01T13:01:00Z')));
  }
});

test('readiness binds fresh root facts, exact A/B configurations, artifacts and distinct admin identities', () => {
  const value = receipt(), pair = inputs(), now = Date.parse('2026-11-01T13:01:00Z');
  const evidence = validateManagerReadiness(value, pair, now);
  assert.equal(evidence.root_receipt_verified, true);
  assert.equal(evidence.backup_protection_scope, 'task_owned_private_directory_and_archive_hash_readback_only');
  for (const damage of [
    value => { value.schema_version = 2; }, value => { value.fixture += '-other'; },
    value => { value.synthetic = false; }, value => { value.origin = 'https://example.invalid'; },
    value => { value.configuration_A_sha256 = '0'.repeat(64); }, value => { value.configuration_B_sha256 = '0'.repeat(64); },
    value => { value.actual_candidate_image_manifest_digest = 'sha256:' + '0'.repeat(64); },
    value => { value.actual_bridge_archive_sha256 = '0'.repeat(64); },
    value => { value.backup_artifact_sha256 = 'not-a-hash'; },
    value => { value.admin_B_user_id_sha256 = value.admin_A_user_id_sha256; },
    value => { value.automatic_publication_disabled = false; }, value => { value.dispatch_disabled = false; },
    value => { value.observed_at = '2026-11-01T11:59:59Z'; }, value => { value.observed_at = '2026-11-01T13:01:01Z'; },
    value => { value.access_token = 'SYNTHETIC_PRIVATE_SENTINEL'; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => validateManagerReadiness(changed, pair, now)); }
  for (const damage of [
    value => { value.B.document.admin_credentials_file = value.A.document.admin_credentials_file; },
    value => { value.B.document.origin = 'https://example.invalid'; },
    value => { value.B.document.bridge.archive_sha256 = '0'.repeat(64); },
    value => { value.B.certificate = Buffer.from('OTHER_CERT'); },
  ]) { const changed = { A: { ...pair.A, document: structuredClone(pair.A.document) }, B: { ...pair.B, document: structuredClone(pair.B.document) } }; damage(changed); assert.throws(() => validateManagerReadiness(value, changed, now)); }
});

test('receipt parsing detects duplicate and escaped duplicate keys without requiring key order', () => {
  const raw = JSON.stringify(receipt()); assert.deepEqual(parseManagerReceipt(raw), receipt());
  assert.deepEqual(parseManagerReceipt(JSON.stringify(Object.fromEntries(Object.entries(receipt()).reverse()), null, 2)), receipt());
  for (const changed of [raw.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
    raw.replace('"schema_version":1', '"schema_version":1,"\\u0073chema_version":1'),
    JSON.stringify({ ...receipt(), token: 'SYNTHETIC_PRIVATE_SENTINEL' })]) assert.throws(() => parseManagerReceipt(changed));
});

test('two actual native admin summaries must match the receipt and each other only at the app prefix', () => {
  const value = receipt(), prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
  const A = { user_id_sha256: value.admin_A_user_id_sha256, prefix }, B = { user_id_sha256: value.admin_B_user_id_sha256, prefix };
  assert.equal(assessTwoAdmins(value, A, B).actual_distinct_admins, true);
  assert.equal(JSON.stringify(assessTwoAdmins(value, A, B)).includes(prefix), false);
  assert.throws(() => assessTwoAdmins(value, A, A));
  assert.throws(() => assessTwoAdmins(value, A, { ...B, user_id_sha256: '0'.repeat(64) }));
  assert.throws(() => assessTwoAdmins(value, A, { ...B, prefix: prefix + 'other/' }));
});

function request(body, { method = 'PUT', endpoint = `tags/${hash(ALBUM_TAG)}/assignment`, origin = LOCAL_ORIGIN, raw } = {}) {
  return { url: () => origin + scope.prefix + 'api/v1/' + endpoint, method: () => method,
    postData: () => raw ?? JSON.stringify(body) };
}
const scope = { fromFrame: true, prefix: '/api/hassio_ingress/SYNTHETIC_PREFIX/' };

test('write gate permits exactly one armed synthetic UI request and denies implicit retries', () => {
  const gate = new ManagerWriteGate(), body = assignmentInput(ALBUM_TAG, 0), endpoint = `tags/${hash(ALBUM_TAG)}/assignment`;
  assert.equal(gate.allow(request(body), scope), false);
  assert.throws(() => gate.grant('PUT', endpoint, body));
  gate.enable(); gate.grant('PUT', endpoint, body);
  assert.equal(gate.allow(request(body), scope), true);
  assert.equal(gate.allow(request(body), scope), false);
  const evidence = gate.settled(); assert.equal(evidence.length, 1);
  assert.equal(evidence[0].body_sha256, hash(JSON.stringify(body)));
  assert.equal(JSON.stringify(evidence).includes(ALBUM_TAG), false);
});

test('write gate rejects unauthorized targets, stale CAS, extra/duplicate fields and cross-frame writes', () => {
  const body = assignmentInput(ALBUM_TAG, 0), endpoint = `tags/${hash(ALBUM_TAG)}/assignment`;
  for (const variant of [
    [request({ ...body, ha_tag_id: ALBUM_TAG.trim() }), scope],
    [request({ ...body, expected_version: 1 }), scope],
    [request({ ...body, input: PLAYLIST_URI }), scope],
    [request({ ...body, version: 0 }), scope],
    [request(body, { origin: 'https://example.invalid' }), scope],
    [request(body, { endpoint: 'publication/confirm', method: 'POST' }), scope],
    [request(body, { endpoint: 'restores/confirm', method: 'POST' }), scope],
    [request(body, { endpoint: `tags/${hash(PLAYLIST_TAG)}/assignment` }), scope],
    [request(body), { ...scope, fromFrame: false }],
    [request(body, { raw: JSON.stringify(body).replace('"expected_version":0', '"expected_version":0,"expected_version":0') }), scope],
  ]) {
    const gate = new ManagerWriteGate(); gate.enable(); gate.grant('PUT', endpoint, body);
    assert.equal(gate.allow(...variant), false); assert.throws(() => gate.settled());
  }
  for (const [method, path, changed] of [
    ['PUT', endpoint, { ...body, ha_tag_id: ALBUM_TAG.normalize('NFC') }],
    ['PUT', endpoint, { ...body, enabled: 'true' }], ['PUT', endpoint, { ...body, expected_version: -1 }],
    ['PATCH', `tags/${hash(PLAYLIST_TAG)}/name`, { ha_tag_id: PLAYLIST_TAG, expected_name: null, name: RENAMED_LABEL }],
    ['DELETE', endpoint, { expected_version: 1 }],
    ['POST', 'publication/confirm', { confirmed: true }],
  ]) { const gate = new ManagerWriteGate(); gate.enable(); assert.throws(() => gate.grant(method, path, changed)); }
});

test('rename/removal are fixed synthetic actions and read-only HA login/metadata stay available', () => {
  const gate = new ManagerWriteGate(); gate.enable();
  const endpoint = `tags/${hash(ALBUM_TAG)}/name`, body = { ha_tag_id: ALBUM_TAG, expected_name: null, name: RENAMED_LABEL };
  gate.grant('PATCH', endpoint, body); assert.equal(gate.allow(request(body, { method: 'PATCH', endpoint }), scope), true);
  const removal = `tags/${hash(PLAYLIST_TAG)}/assignment`;
  gate.grant('DELETE', removal, { expected_version: 2 });
  assert.equal(gate.allow(request({ expected_version: 2 }, { method: 'DELETE', endpoint: removal }), scope), true);
  for (const [url, method] of [[LOCAL_ORIGIN + '/auth/login_flow', 'POST'],
    [LOCAL_ORIGIN + scope.prefix + 'api/v1/music/resolve', 'POST'], [LOCAL_ORIGIN + '/', 'GET']]) {
    assert.equal(gate.allow({ url: () => url, method: () => method }, { fromFrame: false }), true);
  }
});

function assignmentState(input) {
  return { version: input.expected_version + 1, assignment: { tag_key: hash(input.ha_tag_id), ha_tag_id: input.ha_tag_id,
    spotify_uri: input.input, media_type: input.media_type, enabled: input.enabled, shuffle: input.shuffle,
    playback_profile_id: 'default', version: input.expected_version + 1, updated_at: '2026-11-01T13:01:00Z' } };
}

test('saved readback requires exact opaque ID, canonical URI, preferences and incremented CAS version', () => {
  const input = assignmentInput(ALBUM_TAG, 2), state = assignmentState(input);
  assert.equal(assessAssignmentState(state, input).exact_opaque_id, true);
  for (const damage of [
    value => { value.version = 2; }, value => { value.assignment.version = 2; },
    value => { value.assignment.ha_tag_id = ALBUM_TAG.trim(); }, value => { value.assignment.ha_tag_id = ALBUM_TAG.normalize('NFC'); },
    value => { value.assignment.tag_key = hash(PLAYLIST_TAG); }, value => { value.assignment.spotify_uri = PLAYLIST_URI; },
    value => { value.assignment.enabled = false; }, value => { value.assignment.shuffle = true; },
    value => { value.assignment.updated_at = 'invalid'; }, value => { value.assignment.access_token = 'SYNTHETIC_PRIVATE_SENTINEL'; },
  ]) { const changed = structuredClone(state); damage(changed); assert.throws(() => assessAssignmentState(changed, input)); }
});

function guards() {
  return { publication: { status: 200, body: { automatic_enabled: false, actual_stale: false, publisher_id: 'SYNTHETIC_PUBLISHER',
    desired_version: 0, jobs: [], playback_verified: null,
    actual: { publisher_id: 'SYNTHETIC_PUBLISHER', dispatch_enabled: false, persistence: 'empty', active_revision: 0, active_checksum: null } } },
  playback: { status: 200, body: { connection: 'connected', stale: false,
    diagnostics: { diagnostics_version: 1, dispatch_enabled: false, busy: false, last_attempt: null, playback_verification: 'unavailable' } } } };
}

test('independent current app guards require fresh HA dispatch OFF, auto OFF and no jobs or playback attempts', () => {
  const value = guards(), evidence = assessManagerGuards(value.publication, value.playback);
  assert.equal(evidence.saved_revision, 0); assert.equal(evidence.independently_verified_playback, false);
  assert.equal(JSON.stringify(evidence).includes('SYNTHETIC_PUBLISHER'), false);
  for (const damage of [
    value => { value.publication.status = 503; }, value => { value.publication.body.automatic_enabled = true; },
    value => { value.publication.body.actual_stale = true; }, value => { value.publication.body.actual.dispatch_enabled = true; },
    value => { value.publication.body.jobs = [{ state: 'pending' }]; },
    value => { value.publication.body.actual.publisher_id = 'OTHER_PUBLISHER'; },
    value => { value.playback.body.stale = true; }, value => { value.playback.body.connection = 'disconnected'; },
    value => { value.playback.body.diagnostics.dispatch_enabled = true; }, value => { value.playback.body.diagnostics.busy = true; },
    value => { value.playback.body.diagnostics.last_attempt = {}; }, value => { value.playback.body.diagnostics.playback_verification = 'verified'; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => assessManagerGuards(changed.publication, changed.playback)); }
});

test('manager imports/help need no frontend dependency and invalid local paths disclose no private data', () => {
  const root = mkdtempSync(join(tmpdir(), 'jukelet62-manager-import-'));
  try {
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const name of ['browser_manager.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs']) copyFileSync(join(directory, name), join(root, name));
    mkdirSync(join(root, 'empty'));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(root, 'browser_manager.mjs')).href)});`], { cwd: join(root, 'empty'), encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
    const help = spawnSync(process.execPath, [join(root, 'browser_manager.mjs'), '--help'], { encoding: 'utf8' }); assert.equal(help.status, 0);
    const failed = spawnSync(process.execPath, [join(root, 'browser_manager.mjs'), 'manager-edit', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(failed.stderr, ''); assert.equal(JSON.parse(failed.stdout).stage, 'local_inputs');
    assert.equal(failed.stdout.includes('SYNTHETIC_PRIVATE'), false);
  } finally { rmSync(root, { recursive: true }); }
});
