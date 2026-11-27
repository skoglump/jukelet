/** Synthetic local controls only; no HA, credentials or real browser. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALBUM_TAG, CONTINUED_LABEL, PLAYLIST_TAG, assignmentInput } from './browser_manager.mjs';
import { FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { RestoreIntentGate, assessExportBytes, assessPublicationReview, assessRestorePreview, assessRestoreState,
  diagnoseExportDownload, exportDiagnosisFailure, projectExportDiagnosis, parseRestoreBaseline, publicationStaleRace, staleRestoreRequest, validateRestoreBaseline } from './browser_restore.mjs';

const oldToken = 'R'.repeat(43), newToken = 'S'.repeat(43), pubToken = 'P'.repeat(43);
const restoreBody = value => JSON.stringify({ preview_token: value, conflict_policy: 'replace', confirmed: true });
const publicationBody = () => JSON.stringify({ review_token: pubToken, confirmed: true, confirm_empty: false, automatic_publication_attested: false });
const prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
function request(endpoint, method, body, extra = {}) { return { url: () => LOCAL_ORIGIN + prefix + 'api/v1/' + endpoint,
  method: () => method, postData: () => body, ...extra }; }
function boundGate(verify = () => {}) {
  const gate = new RestoreIntentGate(verify); gate.bindExport('{"document":{"synthetic":true}}');
  gate.bindPreview(11, oldToken); gate.bindPreview(12, newToken); gate.bindPublication(pubToken); gate.BChanged = true; return gate;
}

function exported() {
  const names = { [ALBUM_TAG]: CONTINUED_LABEL, [PLAYLIST_TAG]: 'Synthetic playlist name' };
  const document = { schema_version: 1, provenance: { application: 'jukelet', exported_at: '2026-11-01T19:00:00Z', local_revision: 11,
    names_updated_at: '2026-11-01T19:00:00Z', names_stale: false }, assignments: [ALBUM_TAG, PLAYLIST_TAG].map(tag => {
    const input = assignmentInput(tag, 0); return { ha_tag_id: tag, spotify_uri: input.input, media_type: input.media_type,
      enabled: true, shuffle: input.shuffle, playback_profile_id: 'default', name: names[tag] };
  }) };
  return { document, names, bytes: Buffer.from(JSON.stringify(document)) };
}
function preview(document, revision = 11, value = oldToken) {
  return { preview_token: value, local_revision: revision, accepted: 2, rejected: 0, conflicts: 2,
    rows: document.assignments.map((source, index) => ({ row: index + 1, source: structuredClone(source), accepted: true, conflict: true, diagnostics: [] })) };
}

const expectedSource = () => ({ requests: 1, responses: 1, downloads: 1, unexpected_source: 0,
  response_matches_request: true, page_matches: true, blob_class: 'owned_origin_blob', actual_status: 200, filename_expected: true });

function exportCapture({ malformed = false, mismatchedDownload = false, nullDate = false } = {}) {
  const value = exported(); if (nullDate) value.document.provenance.names_updated_at = null;
  const bytes = malformed ? Buffer.from('not JSON') : Buffer.from(JSON.stringify(value.document));
  const page = new EventEmitter(), frame = {}, target = LOCAL_ORIGIN + prefix + 'api/v1/export'; let resolveResponse, resolveDownload, clicks = 0;
  const original = new Response(bytes), owner = { fetch: () => Promise.resolve(original) };
  const wire = request('export', 'GET', null, { frame: () => frame });
  const response = { url: () => target, request: () => wire, status: () => 200, body: async () => Buffer.alloc(0) };
  page.waitForResponse = () => new Promise(resolve => { resolveResponse = resolve; });
  page.waitForEvent = () => new Promise(resolve => { resolveDownload = resolve; });
  frame.evaluate = (operation, argument) => operation(argument, owner);
  frame.getByRole = () => ({ getByRole: () => ({ click: async () => {
    clicks += 1; page.emit('request', wire);
    const actual = await owner.fetch(target, { credentials: 'same-origin', redirect: 'error' });
    assert.equal(actual, original); page.emit('response', response); resolveResponse(response);
    const blob = Buffer.from(await (await actual.blob()).arrayBuffer());
    const saved = mismatchedDownload ? Buffer.concat([blob, Buffer.from(' ')]) : blob;
    const download = { suggestedFilename: () => 'jukelet-export-v1.json', page: () => page,
      url: () => 'blob:' + LOCAL_ORIGIN + '/SYNTHETIC_PRIVATE_UUID', createReadStream: async () => Readable.from([saved]) };
    page.emit('download', download); resolveDownload(download);
  } }) });
  return { manager: { page, frame, prefix, authorityDenied: false }, names: value.names, original, clicks: () => clicks };
}

test('export capture accepts exact original-Response clone/download bytes while retaining empty PWbody as a separate limitation', async () => {
  const value = exportCapture(), evidence = {};
  const result = await diagnoseExportDownload(value.manager, value.names, evidence);
  assert.equal(typeof result === 'boolean' ? result : result.passed, true); assert.equal(evidence.playwright_body.bytes, 0); assert.equal(evidence.playwright_body.empty, true);
  assert.equal(evidence.projection.clone_download_equal, true); assert.equal(evidence.clone_observer.clone_count, 1);
  assert.equal(evidence.source.requests, 1); assert.equal(value.clicks(), 1); assert.equal(value.original.bodyUsed, true);
});

test('export diagnostic preserves byte mismatch offsets and nullable provenance observations without weakening the original criterion', () => {
  const value = exported(), document = structuredClone(value.document); document.provenance.names_updated_at = null;
  const bytes = Buffer.from(JSON.stringify(document)), projection = projectExportDiagnosis(bytes, bytes, value.names);
  assert.equal(projection.clone_download_equal, true); assert.equal(projection.downloaded.provenance.names_updated_at_null, true);
  assert.equal(projection.downloaded.provenance.field_types.names_updated_at, 'null'); assert.equal(projection.downloaded.provenance.names_updated_at_valid_date, false);
  assert.equal(exportDiagnosisFailure(projection, expectedSource()), 'export_provenance_mismatch'); assert.throws(() => assessExportBytes(bytes, value.names));
  const different = projectExportDiagnosis(Buffer.from('abc'), Buffer.from('abZ'), value.names);
  assert.equal(different.first_difference_offset, 2); assert.equal(different.response_clone.bytes, 3);
  assert.equal(exportDiagnosisFailure(different, expectedSource()), 'browser_clone_download_mismatch');
  assert.equal(exportDiagnosisFailure(projectExportDiagnosis(value.bytes, value.bytes, value.names), expectedSource()), null);
});

test('export diagnostics show only known keys/type classes/hashes and refuse wrong source/row identity', () => {
  const value = exported(), document = structuredClone(value.document);
  document.SYNTHETIC_PRIVATE_KEY = 'SYNTHETIC_PRIVATE_VALUE'; document.assignments[0].name = 'SYNTHETIC_PRIVATE_NAME';
  const bytes = Buffer.from(JSON.stringify(document)), projection = projectExportDiagnosis(bytes, bytes, value.names);
  const text = JSON.stringify(projection); assert.equal(text.includes('SYNTHETIC_PRIVATE'), false); assert.equal(text.includes(ALBUM_TAG), false);
  assert.equal(projection.downloaded.document.unknown_key_count, 1); assert.equal(projection.downloaded.rows[0].name_expected, false);
  assert.equal(exportDiagnosisFailure(projection, expectedSource()), 'export_schema_mismatch');
  const clean = projectExportDiagnosis(value.bytes, value.bytes, value.names);
  for (const damage of [value => { value.requests = 2; }, value => { value.downloads = 2; }, value => { value.response_matches_request = false; },
    value => { value.blob_class = 'other_origin_blob'; }, value => { value.unexpected_source = 1; }]) {
    const source = expectedSource(); damage(source); assert.equal(exportDiagnosisFailure(clean, source), 'export_source_mismatch');
  }
});

test('shared export capture preserves strict schema refusal and records projections before failure', async () => {
  const value = exportCapture({ nullDate: true }), evidence = {};
  assert.equal((await diagnoseExportDownload(value.manager, value.names, evidence)).passed, false);
  assert.equal(evidence.checkpoint, 'all_safe_projections_recorded'); assert.equal(evidence.failure_code, 'export_provenance_mismatch');
  assert.equal(evidence.projection.clone_download_equal, true); assert.equal(evidence.source.requests, 1); assert.equal(value.clicks(), 1);
  assert.equal(JSON.stringify(evidence).includes('SYNTHETIC_PRIVATE'), false); assert.equal(value.manager.page.listenerCount('download'), 0);
});

test('empty PW automation body never permits malformed or mismatched actual clone/download bytes', async () => {
  for (const [options, code] of [[{ malformed: true }, 'export_json_invalid'], [{ mismatchedDownload: true }, 'browser_clone_download_mismatch']]) {
    const value = exportCapture(options), evidence = {};
    const result = await diagnoseExportDownload(value.manager, value.names, evidence);
    assert.equal(result.passed, false); assert.equal(evidence.failure_code, code);
    assert.equal(evidence.playwright_body.empty, true); assert.equal(evidence.source.requests, 1); assert.equal(value.clicks(), 1);
    assert.equal(evidence.observer_cleanup_confirmed, true);
  }
});

test('actual download byte assessment binds exact two synthetic rows/names and keeps content out of evidence', () => {
  const value = exported(), result = assessExportBytes(value.bytes, value.names);
  assert.equal(result.evidence.sha256, hash(value.bytes)); assert.equal(result.evidence.filename, 'jukelet-export-v1.json');
  assert.equal(Buffer.from(result.content).equals(value.bytes), true); assert.equal(JSON.stringify(result.evidence).includes(ALBUM_TAG), false);
  for (const damage of [
    value => { value.schema_version = 2; }, value => { value.provenance.local_revision = 12; }, value => { value.provenance.names_stale = true; },
    value => { value.publisher_id = 'PRIVATE_ID'; }, value => { value.assignments[0].ha_tag_id = ALBUM_TAG.trim(); },
    value => { value.assignments[1].enabled = false; }, value => { value.assignments[0].name = 'OTHER'; },
    value => { value.assignments[0].csrf_token = 'PRIVATE_TOKEN'; }, value => { value.assignments.push(value.assignments[0]); },
  ]) { const changed = structuredClone(value.document); damage(changed); assert.throws(() => assessExportBytes(Buffer.from(JSON.stringify(changed)), value.names)); }
  assert.throws(() => assessExportBytes(Buffer.from([255]), value.names)); assert.throws(() => assessExportBytes(Buffer.alloc(4 * 1024 * 1024 + 1), value.names));
});

test('preview assessment retains actual source rows and distinguishes old11 from explicit new12 without exposing tokens', () => {
  const value = exported(), first = preview(value.document), second = preview(value.document, 12, newToken);
  const a = assessRestorePreview(first, value.document, 11), b = assessRestorePreview(second, value.document, 12);
  assert.notEqual(a.preview_token_sha256, b.preview_token_sha256); assert.equal(JSON.stringify([a, b]).includes(oldToken), false);
  for (const damage of [
    value => { value.local_revision = 12; }, value => { value.accepted = 1; }, value => { value.rejected = 1; }, value => { value.conflicts = 1; },
    value => { value.rows[0].source.ha_tag_id = ALBUM_TAG.trim(); }, value => { value.rows[0].diagnostics = ['invalid']; }, value => { value.rows[1].accepted = false; },
    value => { value.preview_token = 'short'; }, value => { value.extra = 'PRIVATE_TOKEN'; },
  ]) { const changed = structuredClone(first); damage(changed); assert.throws(() => assessRestorePreview(changed, value.document, 11)); }
});

test('publication review is exactly the current11 synthetic snapshot and never an activation/recovery or altered mapping', () => {
  const publisher = 'SYNTHETIC_PUBLISHER', baseline = { publisher_id_sha256: hash(publisher) };
  const value = { review_token: pubToken, action: 'publish', desired_version: 11, checksum: 'a'.repeat(64), mapping_count: 2, empty: false,
    pending_removals: [], shuffle_conflict: false, mappings: [ALBUM_TAG, PLAYLIST_TAG].map(tag => {
      const input = assignmentInput(tag, 0); return { tag_id: tag, media_type: input.media_type, spotify_uri: input.input, enabled: true,
        shuffle: input.shuffle, playback_profile_id: 'default' };
    }), actual: { publisher_id: publisher, active_revision: null, active_checksum: null, persistence: 'empty', dispatch_enabled: false } };
  assert.equal(assessPublicationReview(value, baseline).desired_version, 11);
  assert.equal(JSON.stringify(assessPublicationReview(value, baseline)).includes(pubToken), false);
  for (const damage of [value => { value.action = 'activate'; }, value => { value.desired_version = 12; },
    value => { value.mapping_count = 1; }, value => { value.mappings[0].enabled = false; }, value => { value.actual.dispatch_enabled = true; },
    value => { value.actual.publisher_id = 'OTHER'; }, value => { value.review_token = 'short'; }]) {
    const changed = structuredClone(value); damage(changed); assert.throws(() => assessPublicationReview(changed, baseline));
  }
});

test('intent gates bind exact one-shot private preview/review bodies and preserve disabled unused evidence', () => {
  let checks = 0; const gate = boundGate(() => { checks += 1; });
  gate.grant('publication_stale11', 'A', 'publication/confirm', 'POST', publicationBody()); gate.fence();
  assert.equal(gate.evidence()[0].forwarded, false); assert.equal(gate.evidence()[0].enabled, false);
  gate.grant('restore_stale11', 'A', 'restores/confirm', 'POST', restoreBody(oldToken));
  const scope = { prefix, fromFrame: true };
  assert.equal(gate.allow('A', request('restores/confirm', 'POST', restoreBody(newToken)), scope), false);
  assert.equal(gate.allow('B', request('restores/confirm', 'POST', restoreBody(oldToken)), scope), false);
  assert.equal(gate.allow('A', request('restores/confirm', 'POST', restoreBody(oldToken)), { ...scope, fromFrame: false }), false);
  assert.equal(gate.allow('A', request('restores/confirm', 'POST', restoreBody(oldToken)), scope), true);
  assert.equal(gate.allow('A', request('restores/confirm', 'POST', restoreBody(oldToken)), scope), false);
  assert.equal(checks, 2); assert.equal(gate.armed.size, 0);
  assert.throws(() => gate.grant('restore_stale11', 'A', 'restores/confirm', 'POST', restoreBody(oldToken)));
  assert.equal(JSON.stringify(gate.evidence()).includes(oldToken), false); assert.equal(JSON.stringify(gate.evidence()).includes(pubToken), false);
});

test('intent grants refuse stale receipts, unconfirmed B changes, unknown endpoints and changed preview bytes', () => {
  const expired = boundGate(() => { throw new Error('expired_receipt'); });
  assert.throws(() => expired.grant('B_save12', 'B', `tags/${hash(ALBUM_TAG)}/assignment`, 'PUT', JSON.stringify(assignmentInput(ALBUM_TAG, 7, { enabled: false }))));
  assert.equal(expired.armed.size, 0); assert.equal(expired.intents.size, 0);
  const gate = boundGate(); gate.BChanged = false;
  assert.throws(() => gate.grant('publication_stale11', 'A', 'publication/confirm', 'POST', publicationBody()));
  gate.BChanged = true;
  for (const [key, endpoint, body] of [['preview11', 'restores/preview', '{"document":{"other":true}}'],
    ['restore_commit12', 'restores/confirm', restoreBody(oldToken)], ['publication_stale11', 'publication/confirm', publicationBody().replace(pubToken, oldToken)],
    ['unknown', 'publication/recover', '{}']]) assert.throws(() => gate.grant(key, 'A', endpoint, 'POST', body));
  assert.equal(gate.armed.size, 0); assert.equal(gate.intents.size, 0);
});

function state(revision = 11) {
  const rows = [ALBUM_TAG, PLAYLIST_TAG].map(tag => {
    const prior = tag === ALBUM_TAG ? revision === 11 ? 6 : revision === 12 ? 7 : 8 : revision === 13 ? 4 : 3;
    const input = assignmentInput(tag, prior, { enabled: !(revision === 12 && tag === ALBUM_TAG) });
    return { tag_key: hash(tag), ha_tag_id: tag, spotify_uri: input.input, media_type: input.media_type, enabled: input.enabled,
      shuffle: input.shuffle, playback_profile_id: 'default', version: prior + 1, updated_at: '2026-11-01T19:00:00Z' };
  });
  const publisher = 'SYNTHETIC_PUBLISHER', names = exported().names;
  const values = { page: { status: 200, body: { total: 2, revision, assignments: rows } },
    albumName: { status: 200, body: { tag_key: hash(ALBUM_TAG), state: 'current', name: names[ALBUM_TAG] } },
    playlistName: { status: 200, body: { tag_key: hash(PLAYLIST_TAG), state: 'current', name: names[PLAYLIST_TAG] } },
    publication: { status: 200, body: { publisher_id: publisher, desired_version: revision, high_water: 0, healthy: revision !== 13,
      reconciliation_required: revision === 13, automatic_enabled: false, actual_stale: false, jobs: [], playback_verified: null,
      actual: { publisher_id: publisher, persistence: 'empty', active_revision: null, active_checksum: null, dispatch_enabled: false } } },
    playback: { status: 200, body: { connection: 'connected', stale: false, diagnostics: { diagnostics_version: 1, dispatch_enabled: false,
      busy: false, last_attempt: null, playback_verification: 'unavailable' } } }, recovery: { status: 200, body: { reconciliation_required: revision === 13 } } };
  return { values, baseline: { publisher_id_sha256: hash(publisher), assignment_snapshot_sha256: hash(JSON.stringify(state11Page(rows))) } };
}
function state11Page(rows) { return { total: 2, revision: 11, assignments: rows }; }

test('readbacks require monotonic11→12→13 with9/5 rows, guards set once and unchanged publisher/empty tuple/floor', () => {
  const initial = state(11); const baseline = initial.baseline;
  assert.equal(assessRestoreState(initial.values, baseline, 11).album_version, 7);
  assert.equal(assessRestoreState(state(12).values, baseline, 12).album_version, 8);
  const final = state(13).values, result = assessRestoreState(final, baseline, 13);
  assert.equal(result.album_version, 9); assert.equal(result.playlist_version, 5); assert.equal(result.reconciliation_required, true);
  for (const damage of [
    value => { value.page.body.revision = 11; }, value => { value.page.body.assignments[0].version = 7; },
    value => { value.page.body.assignments[1].version = 4; }, value => { value.page.body.assignments[0].enabled = false; },
    value => { value.publication.body.high_water = 1; }, value => { value.publication.body.jobs = [{}]; },
    value => { value.publication.body.healthy = true; }, value => { value.recovery.body.reconciliation_required = false; },
    value => { value.publication.body.actual.active_revision = 1; }, value => { value.playback.body.diagnostics.dispatch_enabled = true; },
  ]) { const changed = structuredClone(final); damage(changed); assert.throws(() => assessRestoreState(changed, baseline, 13)); }
});

function capture({ wrongPW = false, duplicate = false, cleanupFails = false } = {}) {
  const gate = boundGate(), page = new EventEmitter(), body = restoreBody(oldToken), target = LOCAL_ORIGIN + prefix + 'api/v1/restores/confirm';
  const error = { detail: { code: 'assignment_conflict', current_version: 12 } }, original = new Response(JSON.stringify(error), { status: 409 });
  const owner = { fetch: () => Promise.resolve(original) }; let resolve, removals = 0;
  const frame = { evaluate: async (operation, value) => {
    if (operation.name === 'removeFetchCloneObserver') { assert.equal(gate.armed.size, 0); removals += 1; if (cleanupFails) return { restored: false }; }
    return operation(value, owner);
  } };
  const wire = request('restores/confirm', 'POST', body, { frame: () => frame });
  const response = { url: () => target, request: () => wire, status: () => 409, finished: async () => null,
    json: async () => wrongPW ? { detail: { code: 'assignment_conflict', current_version: 11 } } : error };
  page.waitForResponse = predicate => new Promise(done => { resolve = () => { assert.equal(predicate(response), true); done(response); }; });
  const click = async () => {
    page.emit('request', wire); if (duplicate) page.emit('request', wire);
    assert.equal(gate.allow('A', wire, { prefix, fromFrame: true }), true);
    assert.equal(await owner.fetch(target, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'SYNTHETIC_CSRF' } }), original);
    resolve(); page.emit('requestfinished', wire);
  };
  return { manager: { page, frame, prefix, authorityDenied: false }, gate, body, click, evidence: {}, original, removals: () => removals };
}

test('actual stale-restore capture requires full real PW409/current12 agreeing with one clone and unread original', async () => {
  const value = capture(); await staleRestoreRequest(value.manager, value.gate, value.body, value.click, value.evidence);
  assert.equal(value.evidence.actual_status, 409); assert.equal(value.evidence.current_version, 12);
  assert.equal(value.evidence.actual_PW_finished_null, true); assert.equal(value.evidence.one_clone_matches_full_PW_body, true);
  assert.equal(value.evidence.original_unread, true); assert.equal(value.evidence.observer_cleanup_confirmed, true);
  assert.equal(value.original.bodyUsed, false); assert.equal(value.removals(), 1); assert.equal(value.manager.page.listenerCount('request'), 0);
  assert.deepEqual(await value.original.json(), { detail: { code: 'assignment_conflict', current_version: 12 } });
});

test('stale-restore capture rejects wrong body, duplicates and unconfirmed observer cleanup without replay', async () => {
  for (const options of [{ wrongPW: true }, { duplicate: true }, { cleanupFails: true }]) {
    const value = capture(options); await assert.rejects(staleRestoreRequest(value.manager, value.gate, value.body, value.click, value.evidence));
    assert.equal(value.removals(), 1); assert.equal(value.gate.armed.size, 0); assert.equal(value.gate.evidence().length, 1);
    assert.equal(value.manager.page.listenerCount('request'), 0); assert.equal(JSON.stringify(value.evidence).includes(oldToken), false);
  }
});

test('publication poll fencing is explicitly NOT_RUN; unused grants stay disabled and separate restore intent remains available', async () => {
  const gate = boundGate(), manager = { authorityDenied: false, prefix, page: new EventEmitter(), frame: {} }; let clicks = 0, disabled = false;
  const button = { isDisabled: async () => disabled, click: async options => { assert.deepEqual(options, { timeout: 1000 }); clicks += 1; disabled = true; throw new Error('normal_actionability_timeout'); } };
  const result = await publicationStaleRace(manager, gate, publicationBody(), button);
  assert.equal(result.actual_POST409, 'NOT_RUN'); assert.equal(result.outcome, 'UI_FENCED'); assert.equal(clicks, 1);
  assert.deepEqual(gate.evidence().map(value => [value.forwarded, value.enabled]), [[false, false]]);
  gate.grant('restore_stale11', 'A', 'restores/confirm', 'POST', restoreBody(oldToken)); assert.equal(gate.armed.size, 1); gate.fence();
  assert.throws(() => gate.grant('publication_stale11', 'A', 'publication/confirm', 'POST', publicationBody()));
});

test('publication completion requires one actual409 review_stale and never forces or retries the normal button', async () => {
  const gate = boundGate(), page = new EventEmitter(), frame = {}, body = publicationBody(); let clicks = 0;
  const wire = request('publication/confirm', 'POST', body, { frame: () => frame });
  const response = { url: wire.url, request: () => wire, status: () => 409, finished: async () => null, json: async () => ({ detail: { code: 'review_stale' } }) };
  const result = await publicationStaleRace({ page, frame, prefix, authorityDenied: false }, gate, body, { isDisabled: async () => false,
    click: async options => { clicks += 1; assert.deepEqual(options, { timeout: 1000 }); assert.equal(gate.allow('A', wire, { prefix, fromFrame: true }), true); page.emit('response', response); } });
  assert.equal(result.actual_POST409, 'PASS'); assert.equal(clicks, 1); assert.equal(gate.armed.size, 0); assert.equal(page.listenerCount('response'), 0);
});

test('restore baseline binds new current11 metadata witness/config/backup and refuses older/future/duplicate evidence', () => {
  const inputs = { A: { configuration_sha256: 'a'.repeat(64) }, B: { configuration_sha256: 'b'.repeat(64) } }, ready = { backup_artifact_sha256: 'c'.repeat(64) };
  const value = { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN, configuration_A_sha256: 'a'.repeat(64), configuration_B_sha256: 'b'.repeat(64),
    publisher_id_sha256: 'd'.repeat(64), assignment_snapshot_sha256: 'e'.repeat(64), domain_revision: 11, album_version: 7,
    source_metadata_report_sha256: '91f53938ce7a2b0b0dc529d2de591c99797a1c4c941eebf2ad9922a56e4aa135', current_backup_artifact_sha256: 'c'.repeat(64), observed_at: '2026-11-01T19:00:00Z' };
  const now = Date.parse('2026-11-01T19:01:00Z'); assert.equal(validateRestoreBaseline(value, inputs, ready, now).publisher_id_sha256, 'd'.repeat(64));
  assert.deepEqual(parseRestoreBaseline(JSON.stringify(value)), value);
  for (const damage of [value => { value.domain_revision = 9; }, value => { value.album_version = 5; }, value => { value.configuration_A_sha256 = '0'.repeat(64); },
    value => { value.current_backup_artifact_sha256 = '0'.repeat(64); }, value => { value.source_metadata_report_sha256 = '0'.repeat(64); },
    value => { value.observed_at = '2026-11-01T18:00:59Z'; }, value => { value.observed_at = '2026-11-01T19:01:01Z'; }, value => { value.extra = oldToken; }]) {
    const changed = structuredClone(value); damage(changed); assert.throws(() => validateRestoreBaseline(changed, inputs, ready, now));
  }
  assert.throws(() => parseRestoreBaseline(JSON.stringify(value).replace('"domain_revision":11', '"domain_revision":11,"\\u0064omain_revision":11')));
});

test('restore imports/help need no frontend dependencies and invalid paths disclose no private values', () => {
  const root = mkdtempSync(join(tmpdir(), 'jukelet62-restore-import-'));
  try {
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const name of ['browser_restore.mjs', 'browser_metadata.mjs', 'browser_manager.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs', 'fetch_clone.mjs']) copyFileSync(join(directory, name), join(root, name));
    mkdirSync(join(root, 'empty'));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(root, 'browser_restore.mjs')).href)});`], { cwd: join(root, 'empty'), encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
    assert.equal(spawnSync(process.execPath, [join(root, 'browser_restore.mjs'), '--help']).status, 0);
    const failed = spawnSync(process.execPath, [join(root, 'browser_restore.mjs'), 'restore-stale-review', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).stage, 'local_inputs'); assert.equal((failed.stdout + failed.stderr).includes('SYNTHETIC_PRIVATE'), false);
    const diagnostic = spawnSync(process.execPath, [join(root, 'browser_restore.mjs'), 'export-diagnose', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8' });
    assert.equal(diagnostic.status, 1); assert.equal(JSON.parse(diagnostic.stdout).phase, 'export-diagnose');
    assert.equal(JSON.parse(diagnostic.stdout).stage, 'local_inputs'); assert.equal((diagnostic.stdout + diagnostic.stderr).includes('SYNTHETIC_PRIVATE'), false);
  } finally { rmSync(root, { recursive: true }); }
});
