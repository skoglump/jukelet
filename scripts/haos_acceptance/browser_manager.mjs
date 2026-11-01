/** Explicit synthetic manager operations; importing this module performs no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { createProgressStream, nativeEndpointCategory, withinDeadline } from './browser_progress.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, readBoundedFile,
  readOnlyRequestAllowed, readPublicInputs } from './browser_inputs.mjs';

export const ALBUM_TAG = '  Jukelet62:Å/e\u0301 album  ';
export const PLAYLIST_TAG = 'Jukelet62:playlist/🦊';
export const RENAMED_LABEL = 'Jukelet62 synthetic renamed Å';
export const ALBUM_URI = 'spotify:album:0123456789ABCDEFGHIJKL';
export const PLAYLIST_URI = 'spotify:playlist:ABCDEFGHIJKLMNOPQRSTUV';
const TAGS = [ALBUM_TAG, PLAYLIST_TAG];

function exactKeys(value, keys) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

export function validateManagerReadiness(value, inputs, now = Date.now()) {
  exactKeys(value, ['schema_version', 'fixture', 'synthetic', 'origin', 'configuration_A_sha256',
    'configuration_B_sha256', 'actual_candidate_image_manifest_digest', 'actual_bridge_archive_sha256',
    'backup_id_sha256', 'backup_artifact_sha256', 'backup_readback_verified', 'backup_protected',
    'admin_A_user_id_sha256', 'admin_B_user_id_sha256', 'automatic_publication_disabled', 'dispatch_disabled', 'observed_at']);
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, FIXTURE);
  assert.equal(value.synthetic, true); assert.equal(value.origin, LOCAL_ORIGIN);
  for (const key of ['backup_readback_verified', 'backup_protected', 'automatic_publication_disabled', 'dispatch_disabled']) assert.equal(value[key], true);
  for (const key of ['configuration_A_sha256', 'configuration_B_sha256', 'backup_id_sha256',
    'backup_artifact_sha256', 'admin_A_user_id_sha256', 'admin_B_user_id_sha256', 'actual_bridge_archive_sha256']) assert.match(value[key], /^[a-f0-9]{64}$/);
  assert.notEqual(value.admin_A_user_id_sha256, value.admin_B_user_id_sha256);
  assert.match(value.actual_candidate_image_manifest_digest, /^sha256:[a-f0-9]{64}$/);
  const observed = Date.parse(value.observed_at);
  assert.ok(Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= 3600000);
  assert.equal(value.configuration_A_sha256, inputs.A.configuration_sha256);
  assert.equal(value.configuration_B_sha256, inputs.B.configuration_sha256);
  const { admin_credentials_file: adminA, ...configA } = inputs.A.document;
  const { admin_credentials_file: adminB, ...configB } = inputs.B.document;
  assert.notEqual(adminA, adminB); assert.deepEqual(configA, configB);
  assert.equal(hash(inputs.A.certificate), hash(inputs.B.certificate));
  assert.equal(value.actual_candidate_image_manifest_digest, inputs.A.document.candidate.image_manifest_digest);
  assert.equal(value.actual_bridge_archive_sha256, inputs.A.document.bridge.archive_sha256);
  return { root_receipt_verified: true, backup_id_sha256: value.backup_id_sha256,
    backup_artifact_sha256: value.backup_artifact_sha256,
    backup_protection_scope: 'task_owned_private_directory_and_archive_hash_readback_only',
    receipt_observed_at: value.observed_at, distinct_declared_admins: true };
}

function parseFlatReceipt(raw, count) {
  const value = JSON.parse(raw);
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const keys = tokens.flatMap((token, index) => tokens[index + 1] === ':' ? [JSON.parse(token)] : []);
  assert.equal(keys.length, count); assert.equal(new Set(keys).size, keys.length);
  return value;
}

export const parseManagerReceipt = raw => parseFlatReceipt(raw, 17);
export const parseDiagnosticBaseline = raw => parseFlatReceipt(raw, 9);

export function validateDiagnosticBaseline(value, inputs, now = Date.now()) {
  exactKeys(value, ['schema_version', 'fixture', 'synthetic', 'origin', 'configuration_A_sha256',
    'configuration_B_sha256', 'publisher_id_sha256', 'source_reconciliation_sha256', 'observed_at']);
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, FIXTURE);
  assert.equal(value.synthetic, true); assert.equal(value.origin, LOCAL_ORIGIN);
  for (const key of ['configuration_A_sha256', 'configuration_B_sha256', 'publisher_id_sha256', 'source_reconciliation_sha256']) assert.match(value[key], /^[a-f0-9]{64}$/);
  assert.equal(value.configuration_A_sha256, inputs.A.configuration_sha256);
  assert.equal(value.configuration_B_sha256, inputs.B.configuration_sha256);
  const observed = Date.parse(value.observed_at);
  assert.ok(Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= 3600000);
  return { publisher_id_sha256: value.publisher_id_sha256, source_reconciliation_sha256: value.source_reconciliation_sha256,
    baseline_observed_at: value.observed_at };
}

export function assessTwoAdmins(receipt, A, B) {
  assert.equal(A.user_id_sha256, receipt.admin_A_user_id_sha256);
  assert.equal(B.user_id_sha256, receipt.admin_B_user_id_sha256);
  assert.notEqual(A.user_id_sha256, B.user_id_sha256); assert.equal(A.prefix, B.prefix);
  return { actual_distinct_admins: true, A_user_id_sha256: A.user_id_sha256,
    B_user_id_sha256: B.user_id_sha256, same_ingress_prefix_sha256: hash(A.prefix) };
}

export function assignmentInput(tagId, expectedVersion, { enabled = true, shuffle = tagId === PLAYLIST_TAG } = {}) {
  assert.ok(TAGS.includes(tagId)); assert.ok(Number.isSafeInteger(expectedVersion) && expectedVersion >= 0);
  assert.equal(typeof enabled, 'boolean'); assert.equal(typeof shuffle, 'boolean');
  return { ha_tag_id: tagId, input: tagId === ALBUM_TAG ? ALBUM_URI : PLAYLIST_URI,
    media_type: tagId === ALBUM_TAG ? 'album' : 'playlist', enabled, shuffle,
    playback_profile_id: 'default', expected_version: expectedVersion };
}

function validateWrite(method, endpoint, body) {
  if (endpoint === `tags/${hash(ALBUM_TAG)}/name` && method === 'PATCH') {
    exactKeys(body, ['ha_tag_id', 'expected_name', 'name']);
    assert.equal(body.ha_tag_id, ALBUM_TAG); assert.equal(body.name, RENAMED_LABEL);
    assert.ok(body.expected_name === null || (typeof body.expected_name === 'string' && body.expected_name.length <= 512));
    return 'explicit_synthetic_rename';
  }
  const tag = TAGS.find(value => endpoint === `tags/${hash(value)}/assignment`);
  assert.ok(tag);
  if (method === 'PUT') {
    exactKeys(body, ['ha_tag_id', 'input', 'media_type', 'enabled', 'shuffle', 'playback_profile_id', 'expected_version']);
    assert.deepEqual(body, assignmentInput(tag, body.expected_version, { enabled: body.enabled, shuffle: body.shuffle }));
    return 'synthetic_assignment_save';
  }
  assert.equal(method, 'DELETE'); assert.equal(tag, PLAYLIST_TAG);
  exactKeys(body, ['expected_version']);
  assert.ok(Number.isSafeInteger(body.expected_version) && body.expected_version > 0);
  return 'synthetic_playlist_removal';
}

export class ManagerWriteGate {
  constructor() { this.enabled = false; this.pending = null; this.observed = []; }
  enable() { this.enabled = true; }
  grant(method, endpoint, body) {
    assert.equal(this.enabled, true); assert.equal(this.pending, null);
    const kind = validateWrite(method, endpoint, body);
    this.pending = { method, endpoint, body: structuredClone(body), kind };
  }
  allow(request, { fromFrame, prefix }) {
    if (readOnlyRequestAllowed(request.url(), request.method())) return true;
    if (!this.enabled || !this.pending || !fromFrame || !prefix) return false;
    try {
      const target = new URL(request.url()), expected = this.pending;
      if (target.href !== LOCAL_ORIGIN + prefix + 'api/v1/' + expected.endpoint || request.method() !== expected.method) return false;
      const raw = request.postData(); assert.equal(typeof raw, 'string'); assert.ok(Buffer.byteLength(raw) <= 8192);
      const body = JSON.parse(raw);
      // The actual UI emits a canonical single object. This also refuses duplicate keys.
      assert.equal(raw, JSON.stringify(body)); assert.deepEqual(body, expected.body);
      assert.equal(validateWrite(request.method(), expected.endpoint, body), expected.kind);
      this.observed.push({ sequence: this.observed.length + 1, kind: expected.kind,
        method: expected.method, body_sha256: hash(raw) });
      this.pending = null; return true;
    } catch { return false; }
  }
  settled() { assert.equal(this.pending, null); return [...this.observed]; }
}

export function assessAssignmentState(state, expected) {
  exactKeys(state, ['version', 'assignment']);
  assert.equal(state.version, expected.expected_version + 1);
  const row = state.assignment;
  exactKeys(row, ['tag_key', 'ha_tag_id', 'spotify_uri', 'media_type', 'enabled', 'shuffle', 'playback_profile_id', 'version', 'updated_at']);
  assert.equal(row.tag_key, hash(expected.ha_tag_id)); assert.equal(row.ha_tag_id, expected.ha_tag_id);
  assert.equal(row.spotify_uri, expected.input); assert.equal(row.media_type, expected.media_type);
  assert.equal(row.enabled, expected.enabled); assert.equal(row.shuffle, expected.shuffle);
  assert.equal(row.playback_profile_id, 'default'); assert.equal(row.version, state.version);
  assert.ok(Number.isFinite(Date.parse(row.updated_at)));
  return { version: state.version, tag_id_sha256: hash(row.ha_tag_id), uri_sha256: hash(row.spotify_uri),
    enabled: row.enabled, shuffle: row.shuffle, exact_opaque_id: true };
}

export function assessManagerGuards(publication, playback) {
  assert.equal(publication.status, 200); assert.equal(playback.status, 200);
  const pub = publication.body, play = playback.body;
  assert.equal(pub.automatic_enabled, false); assert.equal(pub.actual_stale, false);
  assert.ok(pub.actual); assert.equal(pub.actual.dispatch_enabled, false);
  assert.equal(pub.actual.publisher_id, pub.publisher_id); assert.ok(['healthy', 'empty'].includes(pub.actual.persistence));
  assert.ok(Array.isArray(pub.jobs) && pub.jobs.length === 0);
  assert.equal(play.connection, 'connected'); assert.equal(play.stale, false);
  assert.equal(play.diagnostics?.diagnostics_version, 1);
  assert.equal(play.diagnostics.dispatch_enabled, false); assert.equal(play.diagnostics.busy, false);
  assert.equal(play.diagnostics.last_attempt, null); assert.equal(play.diagnostics.playback_verification, 'unavailable');
  assert.equal(pub.playback_verified, null);
  return { automatic_publication: 'disabled', dispatch: 'disabled', queued_jobs: 0,
    playback_attempts: 0, independently_verified_playback: false, saved_revision: pub.desired_version,
    active_revision: pub.actual.active_revision, publisher_id_sha256: hash(pub.publisher_id),
    active_checksum: pub.actual.active_checksum, persistence: pub.actual.persistence };
}

async function readNative(manager, endpoint) {
  // These are real same-origin browser reads. Only the fixed callers below can
  // select an endpoint; no auth token or write credential leaves the browser.
  const category = nativeEndpointCategory(endpoint);
  const notify = value => manager.notify?.({ ...value, category });
  const result = await withinDeadline('native_read', () => manager.frame.evaluate(async ({ base, endpoint }) => {
    const response = await fetch(new URL('api/v1/' + endpoint, base), {
      credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() };
  }, { base: manager.frame.url(), endpoint }), { notify });
  notify({ operation: 'native_read', checkpoint: 'body', status: result.status });
  return result;
}

async function readGuards(manager) {
  const [publication, playback] = await Promise.all(['publication', 'playback-status'].map(endpoint => readNative(manager, endpoint)));
  return assessManagerGuards(publication, playback);
}

async function openTag(manager, tag) {
  assert.ok(TAGS.includes(tag));
  const inventory = manager.frame.getByRole('region', { name: 'Tag inventory', exact: true });
  const rows = inventory.locator(':scope > ul.tag-list > li');
  let selected;
  for (let i = 0; i < await rows.count(); i += 1) {
    const row = rows.nth(i);
    // textContent preserves leading spaces and decomposed Unicode in opaque IDs.
    if (await row.locator('code.exact-id').first().textContent() === tag) { assert.equal(selected, undefined); selected = row; }
  }
  assert.ok(selected);
  await selected.getByRole('button', { name: /^View tag / }).click();
  const detail = inventory.getByRole('region', { name: 'Tag detail', exact: true });
  await manager.expect(detail).toBeVisible();
  assert.equal(await detail.locator(':scope > code.exact-id').textContent(), tag);
  const editor = detail.getByRole('region', { name: 'Local draft editor', exact: true });
  await manager.expect(editor.getByRole('button', { name: 'Save local draft', exact: true })).toBeEnabled();
  return { detail, editor };
}

async function observedUIRequest(manager, endpoint, method, click) {
  const [response] = await Promise.all([
    manager.page.waitForResponse(response => response.url() === LOCAL_ORIGIN + manager.prefix + 'api/v1/' + endpoint && response.request().method() === method, { timeout: 15000 }),
    click(),
  ]);
  return { status: response.status(), body: await withinDeadline('response_body', () => response.json(), { notify: manager.notify }) };
}

async function saveAssignment(manager, gate, editor, input, evidence, expectedStatus = 200) {
  await editor.getByLabel('Draft media type', { exact: true }).selectOption(input.media_type);
  await editor.getByLabel('Draft Spotify URI or link', { exact: true }).fill(input.input);
  await editor.getByLabel('Enabled draft', { exact: true }).setChecked(input.enabled);
  await editor.getByLabel('Shuffle', { exact: true }).setChecked(input.shuffle);
  const endpoint = `tags/${hash(input.ha_tag_id)}/assignment`;
  gate.grant('PUT', endpoint, input);
  const response = await observedUIRequest(manager, endpoint, 'PUT', () => editor.getByRole('button', { name: 'Save local draft', exact: true }).click());
  Object.assign(evidence, { actual_status: response.status, tag_id_sha256: hash(input.ha_tag_id),
    requested_version: input.expected_version, retained_uri_sha256: hash(input.input) });
  assert.equal(response.status, expectedStatus); gate.settled();
  if (expectedStatus === 200) {
    Object.assign(evidence, assessAssignmentState(response.body, input));
    await manager.expect(editor.getByRole('status')).toContainText('Local draft saved.');
  }
  return response;
}

async function runEdits(A, B, gates, report) {
  const checks = report.checks, step = name => { report.stage = name; checks[name] = {}; return checks[name]; };
  let evidence = step('initial_assignment_baseline');
  const [initialA, initialB] = await Promise.all([A, B].map(manager => readNative(manager, 'assignments?offset=0&limit=100')));
  for (const value of [initialA, initialB]) {
    assert.equal(value.status, 200); assert.equal(value.body.total, 0); assert.deepEqual(value.body.assignments, []);
    assert.equal(value.body.revision, 0);
  }
  evidence.pristine_local_assignments = true; evidence.initial_only = true;
  evidence.saved_revision = initialA.body.revision;
  evidence.expected_successful_assignment_increments = 7;
  const expectedFinalRevision = initialA.body.revision + 7;
  for (const manager of [A, B]) {
    for (const tag of TAGS) {
      const rows = manager.observations.inventory.body.tags.filter(row => row.ha_tag_id === tag);
      assert.equal(rows.length, 1); assert.equal(rows[0].tag_key, hash(tag)); assert.equal(rows[0].state, 'registered');
    }
  }
  const albumA = await openTag(A, ALBUM_TAG);
  evidence = step('create_album_assignment');
  const albumInitial = assignmentInput(ALBUM_TAG, 0);
  await saveAssignment(A, gates.A, albumA.editor, albumInitial, evidence);

  evidence = step('mapping_metadata_fresh');
  const endpoint = 'music/resolve';
  const preview = await observedUIRequest(A, endpoint, 'POST', () => albumA.detail.getByRole('button', { name: 'Look up mapping metadata', exact: true }).click());
  evidence.actual_status = preview.status; assert.equal(preview.status, 200);
  assert.equal(preview.body.state, 'fresh'); assert.equal(preview.body.item?.title, 'Synthetic Jukelet62 album');
  await A.expect(albumA.detail).toContainText('Synthetic Jukelet62 album');
  assert.equal(preview.body.uri, ALBUM_URI); assert.equal(preview.body.item.uri, ALBUM_URI);
  assert.ok(Number.isFinite(Date.parse(preview.body.last_success_at)));
  evidence.state = 'fresh'; evidence.last_success_at = preview.body.last_success_at;
  evidence.checked_at = new Date().toISOString(); evidence.fixture_text_displayed = true;

  evidence = step('explicit_rename_and_independent_readback');
  const nameA = albumA.detail.getByRole('region', { name: 'HA tag name', exact: true });
  const nameEndpoint = `tags/${hash(ALBUM_TAG)}/name`;
  const before = await observedUIRequest(A, nameEndpoint, 'GET', () => nameA.getByRole('button', { name: 'Check HA name', exact: true }).click());
  assert.equal(before.status, 200); assert.equal(before.body.state, 'current');
  await A.expect(nameA.getByRole('status')).toContainText('Current HA name checked:');
  await nameA.getByLabel('Requested HA tag name', { exact: true }).fill(RENAMED_LABEL);
  gates.A.grant('PATCH', nameEndpoint, { ha_tag_id: ALBUM_TAG, expected_name: before.body.name, name: RENAMED_LABEL });
  const renamed = await observedUIRequest(A, nameEndpoint, 'PATCH', () => nameA.getByRole('button', { name: 'Rename HA tag', exact: true }).click());
  evidence.actual_status = renamed.status; assert.equal(renamed.status, 200);
  assert.equal(renamed.body.state, 'verified'); assert.equal(renamed.body.name, RENAMED_LABEL); gates.A.settled();
  await A.expect(nameA.getByRole('status')).toContainText('HA rename verified by registry readback. Local assignments were not saved.');
  const albumB = await openTag(B, ALBUM_TAG);
  const nameB = albumB.detail.getByRole('region', { name: 'HA tag name', exact: true });
  const independent = await observedUIRequest(B, nameEndpoint, 'GET', () => nameB.getByRole('button', { name: 'Check HA name', exact: true }).click());
  assert.equal(independent.status, 200); assert.equal(independent.body.state, 'current'); assert.equal(independent.body.name, RENAMED_LABEL);
  const afterRename = await readNative(B, `tags/${hash(ALBUM_TAG)}/assignment`);
  assert.equal(afterRename.status, 200); assessAssignmentState(afterRename.body, albumInitial);
  Object.assign(evidence, { actual_ha_readback_from_B: true, exact_id_preserved: true,
    renamed_label_sha256: hash(RENAMED_LABEL), assignment_version_unchanged: 1 });

  evidence = step('B_concurrent_edit');
  await saveAssignment(B, gates.B, albumB.editor, assignmentInput(ALBUM_TAG, 1, { enabled: false, shuffle: false }), evidence);
  evidence = step('A_stale_edit_409');
  const conflict = await saveAssignment(A, gates.A, albumA.editor, assignmentInput(ALBUM_TAG, 1, { shuffle: true }), evidence, 409);
  assert.equal(conflict.body.detail?.code, 'assignment_conflict'); assert.equal(conflict.body.detail?.current_version, 2);
  await A.expect(albumA.editor.getByRole('alert')).toContainText('Another edit changed this draft. Your form is retained.');
  await A.expect(albumA.editor.getByLabel('Draft Spotify URI or link', { exact: true })).toHaveValue(ALBUM_URI);
  await A.expect(albumA.editor.getByLabel('Shuffle', { exact: true })).toBeChecked();
  await A.expect(albumA.editor.getByRole('button', { name: 'Save local draft', exact: true })).toBeDisabled();
  const winner = await readNative(B, `tags/${hash(ALBUM_TAG)}/assignment`);
  assert.equal(winner.status, 200); assessAssignmentState(winner.body, assignmentInput(ALBUM_TAG, 1, { enabled: false, shuffle: false }));
  Object.assign(evidence, { retained_unsaved_input: true, save_disabled: true, B_winner_unchanged: true });

  evidence = step('A_deliberate_reload_and_save');
  const reloaded = await observedUIRequest(A, `tags/${hash(ALBUM_TAG)}/assignment`, 'GET', () => albumA.editor.getByRole('button', { name: 'Reload current draft', exact: true }).click());
  assert.equal(reloaded.status, 200); assert.equal(reloaded.body.version, 2);
  await A.expect(albumA.editor.getByLabel('Shuffle', { exact: true })).not.toBeChecked();
  await A.expect(albumA.editor.getByLabel('Enabled draft', { exact: true })).not.toBeChecked();
  await saveAssignment(A, gates.A, albumA.editor, assignmentInput(ALBUM_TAG, 2), evidence);
  evidence.deliberate_reload_before_resave = true;

  const playlistA = await openTag(A, PLAYLIST_TAG);
  evidence = step('create_playlist_assignment');
  await saveAssignment(A, gates.A, playlistA.editor, assignmentInput(PLAYLIST_TAG, 0), evidence);
  evidence = step('disable_playlist_assignment');
  await saveAssignment(A, gates.A, playlistA.editor, assignmentInput(PLAYLIST_TAG, 1, { enabled: false }), evidence);
  await playlistA.editor.getByRole('button', { name: 'Remove local draft', exact: true }).click();
  evidence = step('remove_playlist_assignment');
  const playlistEndpoint = `tags/${hash(PLAYLIST_TAG)}/assignment`;
  gates.A.grant('DELETE', playlistEndpoint, { expected_version: 2 });
  const removed = await observedUIRequest(A, playlistEndpoint, 'DELETE', () => playlistA.editor.getByRole('button', { name: 'Confirm removal', exact: true }).click());
  evidence.actual_status = removed.status; assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { version: 3, assignment: null }); gates.A.settled();
  await A.expect(playlistA.editor.getByRole('status')).toContainText('Local draft removed.');
  await A.expect(playlistA.editor.getByRole('button', { name: 'Remove local draft', exact: true })).toHaveCount(0);
  evidence.tombstone_version = 3;
  evidence = step('deliberate_playlist_recreate');
  await saveAssignment(A, gates.A, playlistA.editor, assignmentInput(PLAYLIST_TAG, 3), evidence);

  evidence = step('final_assignment_and_guard_readback');
  for (const [role, manager] of [['A', A], ['B', B]]) {
    const final = await readNative(manager, 'assignments?offset=0&limit=100');
    assert.equal(final.status, 200); assert.equal(final.body.total, 2); assert.equal(final.body.revision, expectedFinalRevision);
    const rows = final.body.assignments; assert.equal(rows.length, 2);
    const summaries = [];
    for (const [tag, priorVersion] of [[ALBUM_TAG, 2], [PLAYLIST_TAG, 3]]) {
      const matches = rows.filter(row => row.ha_tag_id === tag); assert.equal(matches.length, 1);
      summaries.push(assessAssignmentState({ version: matches[0].version, assignment: matches[0] }, assignmentInput(tag, priorVersion)));
    }
    evidence[role] = { revision: final.body.revision, successful_assignment_increments: final.body.revision - initialA.body.revision,
      assignments: summaries, assignment_snapshot_sha256: hash(JSON.stringify(final.body)), guards: await readGuards(manager) };
    const original = checks.prewrite_guards[role], current = evidence[role].guards;
    assert.equal(current.saved_revision, expectedFinalRevision);
    for (const key of ['active_revision', 'publisher_id_sha256', 'active_checksum']) assert.equal(current[key], original[key]);
    await manager.expect(manager.frame.getByRole('region', { name: 'Publication status', exact: true })).toContainText('Playback: independently unverified');
    await manager.expect(manager.frame.getByRole('region', { name: 'Tag playback readiness', exact: true })).toContainText('Dispatch: disabled.');
  }
  evidence.saved_not_published_or_dispatched = true;
}

export function assessKnownPartialState(values, guards, expectedPublisherSha256) {
  const { page, album, playlist, name } = values;
  for (const value of [page, album, playlist, name]) assert.equal(value.status, 200);
  exactKeys(page.body, ['assignments', 'total', 'revision']);
  assert.equal(page.body.total, 1); assert.equal(page.body.revision, 2);
  assert.equal(page.body.assignments.length, 1);
  const saved = assessAssignmentState(album.body, assignmentInput(ALBUM_TAG, 1, { enabled: false, shuffle: false }));
  assert.deepEqual(page.body.assignments[0], album.body.assignment);
  assert.deepEqual(playlist.body, { version: 0, assignment: null });
  exactKeys(name.body, ['tag_key', 'state', 'name']);
  assert.equal(name.body.tag_key, hash(ALBUM_TAG)); assert.equal(name.body.state, 'current');
  assert.equal(name.body.name, RENAMED_LABEL);
  assert.match(expectedPublisherSha256, /^[a-f0-9]{64}$/);
  assert.equal(guards.publisher_id_sha256, expectedPublisherSha256);
  assert.equal(guards.saved_revision, 2); assert.equal(guards.persistence, 'empty');
  assert.equal(guards.active_revision, null); assert.equal(guards.active_checksum, null);
  assert.equal(guards.automatic_publication, 'disabled'); assert.equal(guards.dispatch, 'disabled');
  assert.equal(guards.queued_jobs, 0); assert.equal(guards.playback_attempts, 0);
  assert.equal(guards.independently_verified_playback, false);
  return { saved_revision: 2, album: saved, playlist_version: 0, playlist_absent: true,
    exact_current_HA_label_sha256: hash(name.body.name), publisher_id_sha256: guards.publisher_id_sha256,
    assignment_snapshot_sha256: hash(JSON.stringify(page.body)), active_snapshot: 'empty',
    old_A_409_or_retained_editor_proven: false };
}

export function assessDiagnosticInventory(inventory) {
  assert.equal(inventory.status, 200); assert.equal(inventory.body.registry_available, true);
  assert.equal(inventory.body.stale, false); assert.equal(inventory.body.total, 2);
  assert.equal(inventory.body.tags.length, 2);
  for (const tag of TAGS) {
    const found = inventory.body.tags.filter(row => row.ha_tag_id === tag); assert.equal(found.length, 1);
    assert.equal(found[0].tag_key, hash(tag)); assert.equal(found[0].state, 'registered');
  }
  return { known_registered_tags: 2, exact_opaque_ids: true };
}

export async function runManagerDiagnose(pathA, pathB, { progress = () => {} } = {}) {
  const report = { fixture: FIXTURE, phase: 'manager-diagnose', stage: 'local_inputs', result: 'FAIL', checks: {}, limitations: [
    'Read-only diagnosis of the reconciled revision2 state; the earlier native timeout cause remains UNPROVEN.',
    'No mutation continuation, stale-editor reconstruction, rename, restore, backup, restart or credential/transport retry.',
    'The existing protected backup covers initial state0; it is not claimed to back up partial state2.',
    'SQL high-water and fixture script-call observations remain separate coordinator evidence.',
  ] };
  const managers = {}, gates = { A: new ManagerWriteGate(), B: new ManagerWriteGate() }, stages = {};
  let activeRole = 'coordinator';
  const notify = (role, value) => progress({ role, stage: stages[role] ?? 'local_inputs', ...value });
  const stage = (role, value) => {
    activeRole = role; stages[role] = value; report.stage = role === 'coordinator' ? value : `${role}_${value}`;
    notify(role, { operation: 'phase', checkpoint: 'begin' });
  };
  try {
    stage('coordinator', 'local_inputs');
    report.probe_sources_sha256 = Object.fromEntries(['browser_manager.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs']
      .map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = { A: readPublicInputs(pathA), B: readPublicInputs(pathB) };
    stage('coordinator', 'root_readiness_receipt');
    const readyBytes = readBoundedFile(join(CONTROL_ROOT, 'manager-ready.json'), 16384);
    const ready = parseManagerReceipt(readyBytes.toString('utf8'));
    report.checks.readiness = { ...validateManagerReadiness(ready, inputs), file_sha256: hash(readyBytes),
      backup_scope: 'initial_state0_only_not_partial_state2' };
    const baselineBytes = readBoundedFile(join(CONTROL_ROOT, 'manager-diagnostic-baseline.json'), 16384);
    const baseline = parseDiagnosticBaseline(baselineBytes.toString('utf8'));
    report.checks.baseline = { ...validateDiagnosticBaseline(baseline, inputs), file_sha256: hash(baselineBytes) };
    for (const role of ['A', 'B']) {
      report.checks[role] = { checks: {} };
      managers[role] = await openNativeManager(inputs[role], report.checks[role], {
        requestAllowed: (request, scope) => gates[role].allow(request, scope),
        setStage: value => stage(role, value), progress: value => notify(role, value),
      });
      const manager = managers[role];
      report.checks[role].checks.exact_inventory = assessDiagnosticInventory(manager.observations.inventory);
      report.checks[role].checks.bootstrap_network_assessment = assessNetworkBoundaries(manager.network, manager.networkCategories);
      assert.equal(gates[role].enabled, false); assert.equal(gates[role].settled().length, 0);
      notify(role, { operation: 'write_ledger', checkpoint: 'ledger', count: 0 });
    }
    report.checks.actual_admin_pair = assessTwoAdmins(ready,
      { ...report.checks.A.checks.native_reads, prefix: managers.A.prefix },
      { ...report.checks.B.checks.native_reads, prefix: managers.B.prefix });
    validateManagerReadiness(ready, inputs); validateDiagnosticBaseline(baseline, inputs);
    for (const role of ['A', 'B']) {
      const manager = managers[role];
      validateManagerReadiness(ready, inputs); validateDiagnosticBaseline(baseline, inputs);
      stage(role, 'independent_native_prewrite_guards');
      const guards = await readGuards(manager); report.checks[role].checks.guards = guards;
      stage(role, 'diagnostic_partial_state');
      const [page, album, playlist] = await Promise.all(['assignments?offset=0&limit=100',
        `tags/${hash(ALBUM_TAG)}/assignment`, `tags/${hash(PLAYLIST_TAG)}/assignment`].map(endpoint => readNative(manager, endpoint)));
      stage(role, 'diagnostic_HA_name_readback');
      const opened = await openTag(manager, ALBUM_TAG);
      const naming = opened.detail.getByRole('region', { name: 'HA tag name', exact: true });
      const name = await observedUIRequest(manager, `tags/${hash(ALBUM_TAG)}/name`, 'GET',
        () => naming.getByRole('button', { name: 'Check HA name', exact: true }).click());
      notify(role, { operation: 'response_body', checkpoint: 'body', category: 'tag_name', status: name.status });
      report.checks[role].checks.partial_state = assessKnownPartialState({ page, album, playlist, name }, guards, baseline.publisher_id_sha256);
      stage(role, 'diagnostic_DOM_snapshot');
      await manager.expect(naming.getByRole('status')).toContainText('Current HA name checked:');
      await manager.expect(opened.detail.getByRole('heading', { name: RENAMED_LABEL, exact: true })).toBeVisible();
      await manager.expect(opened.editor.getByLabel('Draft Spotify URI or link', { exact: true })).toHaveValue(ALBUM_URI);
      await manager.expect(opened.editor.getByLabel('Enabled draft', { exact: true })).not.toBeChecked();
      await manager.expect(opened.editor.getByLabel('Shuffle', { exact: true })).not.toBeChecked();
      await manager.expect(opened.editor.getByRole('button', { name: 'Save local draft', exact: true })).toBeEnabled();
      report.checks[role].checks.current_DOM_observed = true;
      notify(role, { operation: 'dom', checkpoint: 'dom' });
    }
    assert.equal(report.checks.A.checks.partial_state.assignment_snapshot_sha256, report.checks.B.checks.partial_state.assignment_snapshot_sha256);
    for (const role of ['A', 'B']) {
      stage(role, 'close_browsers_and_assess');
      assert.equal((await managers[role].cleanup()).cleanup_confirmed, true);
      report.checks[role].checks.network_assessment = assessNetworkBoundaries(managers[role].network, managers[role].networkCategories);
      assert.equal(gates[role].enabled, false); assert.equal(gates[role].settled().length, 0);
      notify(role, { operation: 'write_ledger', checkpoint: 'ledger', count: 0 });
      report.checks[role].checks.write_gate_enabled = false; report.checks[role].checks.writes_forwarded = 0;
    }
    report.result = 'PASS'; stage('coordinator', 'complete');
    notify('coordinator', { operation: 'phase', checkpoint: 'complete' });
  } catch (error) {
    report.code = error?.code === 'native_deadline' ? 'native_deadline' : 'native_diagnostic_failed';
    report.failure_operation = ['native_read', 'native_evaluate', 'response_body', 'browser_context', 'browser_page', 'browser_close'].includes(error?.operation)
      ? error.operation : 'phase';
    notify(activeRole, { operation: 'phase', checkpoint: 'failed' });
  } finally {
    for (const [role, manager] of Object.entries(managers)) {
      const closed = await manager.cleanup();
      if (!closed.cleanup_confirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
      report.checks[role].checks.network = { ...manager.network };
      report.checks[role].checks.write_gate_enabled = gates[role].enabled;
      report.checks[role].checks.writes_forwarded = gates[role].observed.length;
    }
  }
  return report;
}

export async function runManagerEdit(pathA, pathB) {
  const report = { fixture: FIXTURE, phase: 'manager-edit', stage: 'local_inputs', result: 'FAIL', checks: {}, limitations: [
    'This mutation checkpoint is initial/minimum-Core/pristine only. Existing or partially changed state refuses; no blind replay, reset, downgrade or database rewrite.',
    'Only generated synthetic tags, metadata and two actual HA administrators in the named disposable VM.',
    'backup_protected means a task-owned 0700 directory/0600 archive with hash/readback; no encryption, off-host or household recovery-readiness claim.',
    'Restore, publication, dispatch, lifecycle, mobile/proxy and version matrix are separate. Natural app8h expiry remains NOT_RUN.',
    'Service workers stay blocked; each actual HA context must satisfy the strict known-parent-warning or clean assessment.',
  ] };
  const managers = {}, gates = { A: new ManagerWriteGate(), B: new ManagerWriteGate() };
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_manager.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs']
      .map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = { A: readPublicInputs(pathA), B: readPublicInputs(pathB) };
    report.stage = 'root_readiness_receipt';
    const bytes = readBoundedFile(join(CONTROL_ROOT, 'manager-ready.json'), 16384);
    const receipt = parseManagerReceipt(bytes.toString('utf8'));
    // Unlike credentials, this receipt contains only fixed declarations and hashes.
    // Exact field counts plus duplicate-key detection keep extra secrets out.
    report.checks.readiness = { ...validateManagerReadiness(receipt, inputs), file_sha256: hash(bytes) };
    for (const role of ['A', 'B']) {
      report.checks[role] = { checks: {} };
      const opened = await openNativeManager(inputs[role], report.checks[role], {
        requestAllowed: (request, scope) => gates[role].allow(request, scope),
        setStage: stage => { report.stage = `${role}_${stage}`; },
      });
      managers[role] = opened;
      report.checks[role].checks.prewrite_network_assessment = assessNetworkBoundaries(opened.network, opened.networkCategories);
    }
    report.checks.actual_admin_pair = assessTwoAdmins(receipt,
      { ...report.checks.A.checks.native_reads, prefix: managers.A.prefix },
      { ...report.checks.B.checks.native_reads, prefix: managers.B.prefix });
    report.stage = 'independent_native_prewrite_guards'; report.checks.prewrite_guards = {};
    for (const role of ['A', 'B']) report.checks.prewrite_guards[role] = await readGuards(managers[role]);
    validateManagerReadiness(receipt, inputs);
    for (const gate of Object.values(gates)) gate.enable();
    await runEdits(managers.A, managers.B, gates, report);
    report.stage = 'close_browsers_and_assess';
    for (const role of ['A', 'B']) {
      assert.equal((await managers[role].cleanup()).cleanup_confirmed, true);
      report.checks[role].checks.network_assessment = assessNetworkBoundaries(managers[role].network, managers[role].networkCategories);
      report.checks[role].checks.writes = gates[role].settled();
    }
    assert.equal(report.checks.A.checks.writes.length, 8); assert.equal(report.checks.B.checks.writes.length, 1);
    report.result = 'PASS'; report.stage = 'complete';
  } catch { report.code = 'native_manager_phase_failed'; }
  finally {
    for (const [role, manager] of Object.entries(managers)) {
      if (!(await manager.cleanup()).cleanup_confirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
      report.checks[role].checks.network = { ...manager.network };
      report.checks[role].checks.writes = [...gates[role].observed];
      report.checks[role].checks.pending_write_kind = gates[role].pending?.kind ?? null;
    }
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('node scripts/haos_acceptance/browser_manager.mjs manager-edit CONFIG_A CONFIG_B\nnode scripts/haos_acceptance/browser_manager.mjs manager-diagnose CONFIG_A CONFIG_B\n');
  } else if (['manager-edit', 'manager-diagnose'].includes(args[0]) && args.length === 3) {
    const progress = createProgressStream(line => process.stderr.write(line));
    const report = args[0] === 'manager-diagnose'
      ? await runManagerDiagnose(args[1], args[2], { progress }) : await runManagerEdit(args[1], args[2]);
    const unconfirmed = ['A', 'B'].some(role => report.checks[role]?.checks.cleanup?.cleanup_confirmed === false);
    if (unconfirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; report.forced_exit_after_report = true; }
    process.exitCode = report.result === 'PASS' ? 0 : 1;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => { if (unconfirmed) process.stderr.write('', () => process.exit(1)); });
  } else {
    process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'invalid_phase_arguments' }) + '\n'); process.exitCode = 2;
  }
}
