/** Explicit owned-fixture export/restore and stale-review checkpoint. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ALBUM_TAG, CONTINUED_LABEL, PLAYLIST_TAG, assessAssignmentState, assessDiagnosticInventory, assessManagerGuards,
  assessTwoAdmins, assignmentInput, parseManagerReceipt, validateManagerReadiness } from './browser_manager.mjs';
import { assessFixtureStatus, callFixtureControl } from './browser_metadata.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, readBoundedFile, readOnlyRequestAllowed, readPublicInputs } from './browser_inputs.mjs';
import { createProgressStream, nativeEndpointCategory, withinDeadline } from './browser_progress.mjs';
import { installFetchCloneObserver, readFetchCloneObserver, removeFetchCloneObserver } from './fetch_clone.mjs';

const MAX_EXPORT = 4 * 1024 * 1024;
const TAGS = [ALBUM_TAG, PLAYLIST_TAG];
const exportName = 'jukelet-export-v1.json';
const token = value => assert.ok(typeof value === 'string' && value.length >= 32 && value.length <= 128);
function keys(value, expected) { assert.ok(value && Object.getPrototypeOf(value) === Object.prototype); assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); }

export function parseRestoreBaseline(raw) {
  const value = JSON.parse(raw), tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const fields = tokens.flatMap((value, index) => tokens[index + 1] === ':' ? [JSON.parse(value)] : []);
  assert.equal(fields.length, 13); assert.equal(new Set(fields).size, fields.length); return value;
}

export function validateRestoreBaseline(value, inputs, ready, now = Date.now()) {
  keys(value, ['schema_version', 'fixture', 'synthetic', 'origin', 'configuration_A_sha256', 'configuration_B_sha256',
    'publisher_id_sha256', 'assignment_snapshot_sha256', 'domain_revision', 'album_version', 'source_metadata_report_sha256', 'current_backup_artifact_sha256', 'observed_at']);
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, FIXTURE); assert.equal(value.synthetic, true); assert.equal(value.origin, LOCAL_ORIGIN);
  assert.equal(value.domain_revision, 11); assert.equal(value.album_version, 7);
  for (const key of ['configuration_A_sha256', 'configuration_B_sha256', 'publisher_id_sha256', 'assignment_snapshot_sha256',
    'source_metadata_report_sha256', 'current_backup_artifact_sha256']) assert.match(value[key], /^[a-f0-9]{64}$/);
  assert.equal(value.configuration_A_sha256, inputs.A.configuration_sha256); assert.equal(value.configuration_B_sha256, inputs.B.configuration_sha256);
  assert.equal(value.current_backup_artifact_sha256, ready.backup_artifact_sha256);
  assert.equal(value.source_metadata_report_sha256, '91f53938ce7a2b0b0dc529d2de591c99797a1c4c941eebf2ad9922a56e4aa135');
  const observed = Date.parse(value.observed_at); assert.ok(Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= 3600000);
  return { publisher_id_sha256: value.publisher_id_sha256, assignment_snapshot_sha256: value.assignment_snapshot_sha256,
    current_backup_artifact_sha256: value.current_backup_artifact_sha256, baseline_observed_at: value.observed_at };
}

export function assessExportBytes(bytes, names) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_EXPORT);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes), document = JSON.parse(content);
  keys(document, ['schema_version', 'provenance', 'assignments']); assert.equal(document.schema_version, 1);
  keys(document.provenance, ['application', 'exported_at', 'local_revision', 'names_updated_at', 'names_stale']);
  assert.equal(document.provenance.application, 'jukelet'); assert.equal(document.provenance.local_revision, 11); assert.equal(document.provenance.names_stale, false);
  for (const value of [document.provenance.exported_at, document.provenance.names_updated_at]) assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)));
  assert.equal(document.assignments.length, 2);
  for (const tag of TAGS) {
    const found = document.assignments.filter(row => row.ha_tag_id === tag); assert.equal(found.length, 1);
    keys(found[0], ['ha_tag_id', 'spotify_uri', 'media_type', 'enabled', 'shuffle', 'playback_profile_id', 'name']);
    const expected = assignmentInput(tag, 0);
    assert.deepEqual(found[0], { ha_tag_id: tag, spotify_uri: expected.input, media_type: expected.media_type,
      enabled: true, shuffle: expected.shuffle, playback_profile_id: 'default', name: names[tag] });
  }
  return { document, content, evidence: { filename: exportName, bytes: bytes.length, sha256: hash(bytes),
    supported_rows: 2, source_revision: 11, exact_opaque_ids_and_preferences: true, names_match_actual_HA_readback: true } };
}

const fieldType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function keyProjection(value, known) {
  const object = Boolean(value && fieldType(value) === 'object'), fields = object ? Object.keys(value) : [];
  return { type: fieldType(value), known_keys: fields.filter(key => known.includes(key)).sort(),
    unknown_key_count: fields.filter(key => !known.includes(key)).length,
    unknown_key_sha256: fields.filter(key => !known.includes(key)).slice(0, 16).map(hash).sort(),
    exact: object && fields.length === known.length && known.every(key => fields.includes(key)),
    field_types: Object.fromEntries(known.map(key => [key, fieldType(object ? value[key] : undefined)])) };
}

function exportProjection(bytes, names) {
  const result = { bytes: bytes.length, sha256: hash(bytes), utf8_valid: false, json_valid: false };
  let text, value;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); result.utf8_valid = true; } catch { return result; }
  try { value = JSON.parse(text); result.json_valid = true; } catch { return result; }
  result.document = keyProjection(value, ['schema_version', 'provenance', 'assignments']);
  result.schema_version = safeInteger(value?.schema_version); result.schema_expected = value?.schema_version === 1;
  const provenance = value?.provenance;
  result.provenance = { ...keyProjection(provenance, ['application', 'exported_at', 'local_revision', 'names_updated_at', 'names_stale']),
    application_expected: provenance?.application === 'jukelet', local_revision: safeInteger(provenance?.local_revision),
    local_revision_expected: provenance?.local_revision === 11,
    names_stale: typeof provenance?.names_stale === 'boolean' ? provenance.names_stale : null,
    names_updated_at_null: provenance?.names_updated_at === null,
    names_updated_at_sha256: typeof provenance?.names_updated_at === 'string' ? hash(provenance.names_updated_at) : null,
    exported_at_sha256: typeof provenance?.exported_at === 'string' ? hash(provenance.exported_at) : null,
    names_updated_at_valid_date: typeof provenance?.names_updated_at === 'string' && Number.isFinite(Date.parse(provenance.names_updated_at)),
    exported_at_valid_date: typeof provenance?.exported_at === 'string' && Number.isFinite(Date.parse(provenance.exported_at)) };
  const rows = value?.assignments; result.rows_type = fieldType(rows); result.row_count = Array.isArray(rows) ? rows.length : null;
  result.row_projection_truncated = Array.isArray(rows) && rows.length > 8;
  result.tag_distribution_expected = Array.isArray(rows) && rows.length === 2 && TAGS.every(tag => rows.filter(row => row?.ha_tag_id === tag).length === 1);
  result.rows = Array.isArray(rows) ? rows.slice(0, 8).map((row, index) => {
    const knownTag = TAGS.includes(row?.ha_tag_id), expected = knownTag ? assignmentInput(row.ha_tag_id, 0) : null;
    return { row: index + 1, ...keyProjection(row, ['ha_tag_id', 'spotify_uri', 'media_type', 'enabled', 'shuffle', 'playback_profile_id', 'name']),
      tag_id_sha256: typeof row?.ha_tag_id === 'string' ? hash(row.ha_tag_id) : null, tag_id_expected: knownTag,
      uri_sha256: typeof row?.spotify_uri === 'string' ? hash(row.spotify_uri) : null, uri_expected: expected !== null && row?.spotify_uri === expected.input,
      name_sha256: row?.name === null || typeof row?.name === 'string' ? hash(JSON.stringify(row.name)) : null,
      name_expected: knownTag && row?.name === names[row.ha_tag_id], media_type_expected: expected !== null && row?.media_type === expected.media_type,
      enabled: typeof row?.enabled === 'boolean' ? row.enabled : null, shuffle: typeof row?.shuffle === 'boolean' ? row.shuffle : null,
      preferences_expected: expected !== null && row?.enabled === true && row?.shuffle === expected.shuffle && row?.playback_profile_id === 'default' };
  }) : [];
  return result;
}

export function projectExportDiagnosis(responseClone, downloaded, names) {
  const equal = responseClone.equals(downloaded); let first = null;
  if (!equal) { first = Math.min(responseClone.length, downloaded.length); for (let index = 0; index < first; index += 1) if (responseClone[index] !== downloaded[index]) { first = index; break; } }
  return { response_clone: exportProjection(responseClone, names), downloaded: exportProjection(downloaded, names),
    clone_download_equal: equal, first_difference_offset: first };
}

export function exportDiagnosisFailure(value, source) {
  if (source.requests !== 1 || source.responses !== 1 || source.downloads !== 1 || source.unexpected_source !== 0
    || source.response_matches_request !== true || source.page_matches !== true || source.blob_class !== 'owned_origin_blob'
    || source.actual_status !== 200 || source.filename_expected !== true) return 'export_source_mismatch';
  if (!value.clone_download_equal) return 'browser_clone_download_mismatch';
  const document = value.downloaded;
  if (!document.utf8_valid) return 'export_utf8_invalid'; if (!document.json_valid) return 'export_json_invalid';
  if (!document.document.exact || !document.schema_expected || !document.provenance.exact) return 'export_schema_mismatch';
  const provenance = document.provenance;
  if (!provenance.application_expected || !provenance.local_revision_expected || provenance.names_stale !== false
    || !provenance.names_updated_at_valid_date || !provenance.exported_at_valid_date) return 'export_provenance_mismatch';
  if (document.rows_type !== 'array' || document.row_count !== 2 || document.rows.some(row => !row.exact)) return 'export_row_shape_mismatch';
  if (!document.tag_distribution_expected || document.rows.some(row => !row.tag_id_expected || !row.uri_expected || !row.name_expected
    || !row.media_type_expected || !row.preferences_expected)) return 'export_row_content_mismatch';
  return null;
}

export async function diagnoseExportDownload(manager, names, evidence, fence = () => {}) {
  const target = LOCAL_ORIGIN + manager.prefix + 'api/v1/export', binding = { slot: '__jukeletIssue62FetchClone', token: randomUUID() };
  let request, installed = false;
  Object.assign(evidence, { checkpoint: 'waiting_for_export', source: { requests: 0, responses: 0, downloads: 0, unexpected_source: 0 } });
  const source = evidence.source;
  const onRequest = value => {
    if (value.url() !== target || value.method() !== 'GET') return; source.requests += 1; if (!request) request = value;
    try { if (value.frame() !== manager.frame) source.unexpected_source += 1; } catch { source.unexpected_source += 1; }
  };
  const onResponse = value => {
    try { if (value.url() === target && value.request().method() === 'GET') { source.responses += 1; if ([401, 403].includes(value.status())) manager.authorityDenied = true; } }
    catch { source.unexpected_source += 1; }
  };
  const onDownload = () => { source.downloads += 1; };
  manager.page.on('request', onRequest); manager.page.on('response', onResponse); manager.page.on('download', onDownload);
  try {
    const armed = await withinDeadline('native_evaluate', () => manager.frame.evaluate(installFetchCloneObserver,
      { ...binding, url: target, method: 'GET', body: null, timeoutMs: 5000, maxBytes: 8192 }), { timeoutMs: 2000, notify: manager.notify });
    assert.equal(armed.armed, true); installed = true;
    const waiting = manager.page.waitForResponse(value => value.url() === target && value.request().method() === 'GET'
      && value.request().frame() === manager.frame, { timeout: 15000 }); waiting.catch(() => {});
    const downloading = manager.page.waitForEvent('download', { timeout: 15000 }); downloading.catch(() => {});
    const recovery = manager.frame.getByRole('region', { name: 'Export and recovery', exact: true });
    const [response, download] = await withinDeadline('export_download', () => Promise.all([waiting, downloading,
      recovery.getByRole('button', { name: 'Download mapping export', exact: true }).click()]), { timeoutMs: 20000, notify: manager.notify });
    source.actual_status = response.status(); source.response_matches_request = response.request() === request;
    source.filename_expected = download.suggestedFilename() === exportName; source.page_matches = download.page() === manager.page;
    try { const url = new URL(download.url()); source.blob_class = url.protocol === 'blob:' ? url.origin === LOCAL_ORIGIN ? 'owned_origin_blob' : 'other_origin_blob' : 'non_blob'; }
    catch { source.blob_class = 'invalid'; }
    evidence.checkpoint = 'download_stream';
    const stream = await withinDeadline('export_download', () => download.createReadStream(), { timeoutMs: 5000, notify: manager.notify }); assert.ok(stream);
    const bytes = await withinDeadline('export_download', async () => {
      const chunks = []; let count = 0;
      for await (const chunk of stream) { count += chunk.length; evidence.downloaded_length_so_far = count; assert.ok(count <= MAX_EXPORT); chunks.push(chunk); }
      return Buffer.concat(chunks);
    }, { timeoutMs: 10000, notify: manager.notify });
    evidence.downloaded_bytes = bytes.length; evidence.downloaded_sha256 = hash(bytes); evidence.checkpoint = 'browser_response_clone';
    const observed = await withinDeadline('native_evaluate', () => manager.frame.evaluate(readFetchCloneObserver, binding), { timeoutMs: 7000, notify: manager.notify });
    evidence.clone_observer = { outcome: ['PASS', 'TIMEOUT', 'MISSING', 'FETCH_FAILED', 'CLONE_FAILED', 'BODY_TOO_LARGE', 'INVALID_JSON', 'DISPOSED'].includes(observed?.result) ? observed.result : 'INVALID_OBSERVATION' };
    assert.equal(observed.result, 'PASS'); assert.equal(observed.status, 200);
    for (const key of ['matched_count', 'native_fetch_count', 'clone_count']) { assert.equal(observed[key], 1); evidence.clone_observer[key] = 1; }
    assert.equal(observed.original_fetch_restored, true); assert.equal(observed.clone_body_used, true);
    for (const key of ['original_body_used_at_clone', 'original_body_used_after_clone', 'original_body_used_current']) {
      assert.equal(typeof observed[key], 'boolean'); evidence.clone_observer[key] = observed[key];
    }
    assert.ok(Array.isArray(observed.export_bytes) && observed.export_bytes.length > 0 && observed.export_bytes.length <= 8192);
    assert.ok(observed.export_bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
    assert.equal(observed.bytes_read, observed.export_bytes.length); const responseClone = Buffer.from(observed.export_bytes);
    evidence.clone_observer.bytes = responseClone.length; evidence.clone_observer.original_fetch_restored = true;
    evidence.checkpoint = 'playwright_body_diagnostic';
    const automation = await withinDeadline('response_body', () => response.body(), { timeoutMs: 5000, notify: manager.notify });
    assert.ok(Buffer.isBuffer(automation) && automation.length <= MAX_EXPORT);
    evidence.playwright_body = { bytes: automation.length, sha256: hash(automation), empty: automation.length === 0,
      same_as_browser_response_clone: automation.equals(responseClone), independent_wire_capture: false,
      limitation: automation.length === 0 ? 'automation_body_empty' : automation.equals(responseClone) ? 'none' : 'automation_body_differs' };
    evidence.projection = projectExportDiagnosis(responseClone, bytes, names); evidence.checkpoint = 'all_safe_projections_recorded';
    evidence.failure_code = exportDiagnosisFailure(evidence.projection, source);
    // Byte identity is the actual same Response clone versus the UI's original
    // Blob consumer. Playwright's empty automation body is a separate limitation.
    try { assert.equal(evidence.failure_code, null); assert.equal(hash(responseClone), hash(bytes)); assessExportBytes(bytes, names); evidence.criteria_pass = true; }
    catch { evidence.criteria_pass = false; evidence.failure_code ??= 'export_assessment_failed_unknown'; }
    return { passed: evidence.criteria_pass, bytes, recovery };
  } finally {
    fence();
    try {
      if (installed) {
        const removed = await withinDeadline('native_evaluate', () => manager.frame.evaluate(removeFetchCloneObserver, binding), { timeoutMs: 2000, notify: manager.notify });
        evidence.observer_cleanup_confirmed = removed.restored === true;
        assert.equal(removed.restored, true); assert.equal(removed.matched_count, 1); assert.equal(removed.clone_count, 1);
      }
    } finally { manager.page.off('request', onRequest); manager.page.off('response', onResponse); manager.page.off('download', onDownload); }
  }
}

export function assessRestorePreview(body, document, revision) {
  keys(body, ['preview_token', 'local_revision', 'accepted', 'rejected', 'conflicts', 'rows']); token(body.preview_token);
  assert.ok([11, 12].includes(revision)); assert.equal(body.local_revision, revision);
  assert.equal(body.accepted, 2); assert.equal(body.rejected, 0); assert.equal(body.conflicts, 2); assert.equal(body.rows.length, 2);
  for (let index = 0; index < 2; index += 1) {
    const row = body.rows[index]; keys(row, ['row', 'source', 'accepted', 'conflict', 'diagnostics']);
    assert.equal(row.row, index + 1); assert.deepEqual(row.source, document.assignments[index]);
    assert.equal(row.accepted, true); assert.equal(row.conflict, true); assert.deepEqual(row.diagnostics, []);
  }
  return { accepted: 2, rejected: 0, conflicts: 2, local_revision: revision, preview_token_sha256: hash(body.preview_token), same_export_rows: true };
}

export function assessRestoreState(values, baseline, revision) {
  assert.ok([11, 12, 13].includes(revision)); const { page, publication, playback, recovery, albumName, playlistName } = values;
  for (const value of Object.values(values)) assert.equal(value.status, 200);
  keys(page.body, ['assignments', 'total', 'revision']); assert.equal(page.body.revision, revision); assert.equal(page.body.total, 2); assert.equal(page.body.assignments.length, 2);
  for (const tag of TAGS) {
    const rows = page.body.assignments.filter(row => row.ha_tag_id === tag); assert.equal(rows.length, 1);
    const prior = tag === ALBUM_TAG ? revision === 11 ? 6 : revision === 12 ? 7 : 8 : revision === 13 ? 4 : 3;
    assessAssignmentState({ version: rows[0].version, assignment: rows[0] }, assignmentInput(tag, prior, { enabled: !(revision === 12 && tag === ALBUM_TAG) }));
  }
  const snapshot = hash(JSON.stringify(page.body)); if (revision === 11) assert.equal(snapshot, baseline.assignment_snapshot_sha256);
  for (const [value, tag] of [[albumName, ALBUM_TAG], [playlistName, PLAYLIST_TAG]]) {
    keys(value.body, ['tag_key', 'state', 'name']); assert.equal(value.body.tag_key, hash(tag)); assert.equal(value.body.state, 'current');
    assert.ok(value.body.name === null || (typeof value.body.name === 'string' && value.body.name.length <= 512));
  }
  assert.equal(albumName.body.name, CONTINUED_LABEL);
  const guards = assessManagerGuards(publication, playback); assert.equal(guards.publisher_id_sha256, baseline.publisher_id_sha256);
  assert.equal(guards.saved_revision, revision); assert.equal(guards.persistence, 'empty'); assert.equal(guards.active_revision, null); assert.equal(guards.active_checksum, null);
  assert.equal(publication.body.high_water, 0); assert.equal(publication.body.reconciliation_required, revision === 13);
  assert.equal(publication.body.healthy, revision !== 13);
  keys(recovery.body, ['reconciliation_required']); assert.equal(recovery.body.reconciliation_required, revision === 13);
  return { assignment_snapshot_sha256: snapshot, saved_revision: revision, album_version: revision === 11 ? 7 : revision === 12 ? 8 : 9,
    playlist_version: revision === 13 ? 5 : 4, guards, healthy: revision !== 13, high_water: 0, reconciliation_required: revision === 13,
    name_sha256: TAGS.map(tag => hash(JSON.stringify(values[tag === ALBUM_TAG ? 'albumName' : 'playlistName'].body.name))) };
}

// Each intent is permanent, one-shot evidence. A UI-fenced publication intent
// stays disabled/unforwarded while separately declared restore intents proceed.
export class RestoreIntentGate {
  constructor(verify) { this.verify = verify; this.intents = new Map(); this.armed = new Set(); this.BChanged = false; this.previews = new Map(); }
  bindExport(body) { assert.equal(this.previewBody, undefined); assert.equal(this.intents.size, 0); this.previewBody = body; }
  bindPreview(revision, value) { assert.ok([11, 12].includes(revision)); assert.equal(this.previews.has(revision), false); token(value); this.previews.set(revision, value); }
  bindPublication(value) { assert.equal(this.publicationToken, undefined); token(value); this.publicationToken = value; }
  grant(key, role, endpoint, method, body) {
    assert.equal(this.intents.has(key), false); assert.equal(this.armed.size, 0); this.verify();
    assert.ok(['A', 'B'].includes(role));
    if (key === 'B_save12') { assert.equal(role, 'B'); assert.equal(endpoint, `tags/${hash(ALBUM_TAG)}/assignment`); assert.equal(method, 'PUT'); assert.equal(body, JSON.stringify(assignmentInput(ALBUM_TAG, 7, { enabled: false }))); }
    else {
      assert.equal(role, 'A'); assert.equal(method, 'POST');
      if (['preview11', 'preview12'].includes(key)) { assert.equal(endpoint, 'restores/preview'); assert.equal(typeof this.previewBody, 'string'); assert.equal(body, this.previewBody); }
      else {
        const value = JSON.parse(body); assert.equal(body, JSON.stringify(value));
        if (key === 'publication_review11') { assert.equal(endpoint, 'publication/review'); assert.deepEqual(value, { action: 'publish' }); }
        else if (key === 'publication_stale11') {
          assert.equal(this.BChanged, true); assert.equal(endpoint, 'publication/confirm'); keys(value, ['review_token', 'confirmed', 'confirm_empty', 'automatic_publication_attested']); token(value.review_token);
          assert.equal(value.review_token, this.publicationToken);
          assert.equal(value.confirmed, true); assert.equal(value.confirm_empty, false); assert.equal(value.automatic_publication_attested, false);
        } else {
          assert.ok(['restore_stale11', 'restore_commit12'].includes(key)); assert.equal(this.BChanged, true); assert.equal(endpoint, 'restores/confirm');
          keys(value, ['preview_token', 'conflict_policy', 'confirmed']); token(value.preview_token); assert.equal(value.conflict_policy, 'replace'); assert.equal(value.confirmed, true);
          assert.equal(value.preview_token, this.previews.get(key === 'restore_stale11' ? 11 : 12));
        }
      }
    }
    assert.ok(typeof body === 'string' && Buffer.byteLength(body) <= MAX_EXPORT + 4096);
    this.intents.set(key, { role, endpoint, method, body, forwarded: false }); this.armed.add(key);
  }
  allow(role, request, { fromFrame, prefix }) {
    if (readOnlyRequestAllowed(request.url(), request.method())) return true;
    if (!fromFrame || !prefix) return false;
    for (const key of this.armed) {
      const expected = this.intents.get(key);
      if (role === expected.role && request.url() === LOCAL_ORIGIN + prefix + 'api/v1/' + expected.endpoint
        && request.method() === expected.method && request.postData() === expected.body) {
        expected.forwarded = true; this.armed.delete(key); return true;
      }
    }
    return false;
  }
  fence() { this.armed.clear(); }
  evidence() { return [...this.intents].map(([intent, value]) => ({ intent, role: value.role, forwarded: value.forwarded,
    enabled: this.armed.has(intent), body_sha256: hash(value.body) })); }
}

export function assessPublicationReview(body, baseline) {
  keys(body, ['review_token', 'action', 'mappings', 'desired_version', 'checksum', 'mapping_count', 'empty', 'pending_removals', 'shuffle_conflict', 'actual']);
  token(body.review_token); assert.equal(body.action, 'publish'); assert.equal(body.desired_version, 11);
  assert.match(body.checksum, /^[a-f0-9]{64}$/); assert.equal(body.mapping_count, 2); assert.equal(body.empty, false);
  assert.deepEqual(body.pending_removals, []); assert.equal(body.shuffle_conflict, false); assert.equal(body.mappings.length, 2);
  for (const tag of TAGS) {
    const rows = body.mappings.filter(row => row.tag_id === tag); assert.equal(rows.length, 1);
    const value = assignmentInput(tag, 0);
    assert.deepEqual(rows[0], { tag_id: tag, media_type: value.media_type, spotify_uri: value.input, enabled: true, shuffle: value.shuffle, playback_profile_id: 'default' });
  }
  assert.equal(hash(body.actual.publisher_id), baseline.publisher_id_sha256); assert.equal(body.actual.persistence, 'empty');
  assert.equal(body.actual.active_revision, null); assert.equal(body.actual.active_checksum, null); assert.equal(body.actual.dispatch_enabled, false);
  return { action: 'publish', desired_version: 11, mappings: 2, review_token_sha256: hash(body.review_token), review_only: true };
}

function assessConflict(body) {
  keys(body, ['detail']); keys(body.detail, ['code', 'current_version']);
  assert.equal(body.detail.code, 'assignment_conflict'); assert.equal(body.detail.current_version, 12);
  return hash(JSON.stringify(body));
}

export async function staleRestoreRequest(manager, gate, body, click, evidence) {
  assert.equal(manager.authorityDenied, false);
  const target = LOCAL_ORIGIN + manager.prefix + 'api/v1/restores/confirm';
  const binding = { slot: '__jukeletIssue62FetchClone', token: randomUUID() };
  let installed = false, request, done;
  const ended = new Promise(resolve => { done = resolve; });
  Object.assign(evidence, { requests: 0, finished: 0, failed: 0, unexpected: 0 });
  const started = value => {
    if (value.url() !== target || value.method() !== 'POST') return;
    evidence.requests += 1; if (!request) request = value;
    try { assert.equal(value.frame(), manager.frame); assert.equal(value.postData(), body); } catch { evidence.unexpected += 1; }
  };
  const finished = value => { if (value === request) { evidence.finished += 1; done(); } };
  const failed = value => { if (value === request) { evidence.failed += 1; done(); } };
  manager.page.on('request', started); manager.page.on('requestfinished', finished); manager.page.on('requestfailed', failed);
  try {
    assert.equal((await withinDeadline('native_evaluate', () => manager.frame.evaluate(installFetchCloneObserver,
      { ...binding, url: target, method: 'POST', body, timeoutMs: 5000, maxBytes: 8192 }), { timeoutMs: 2000, notify: manager.notify })).armed, true);
    installed = true; gate.grant('restore_stale11', 'A', 'restores/confirm', 'POST', body);
    const waiting = manager.page.waitForResponse(value => value.url() === target && value.request().method() === 'POST'
      && value.request().frame() === manager.frame, { timeout: 15000 }); waiting.catch(() => {});
    const [response] = await withinDeadline('response_headers', () => Promise.all([waiting, click()]), { timeoutMs: 20000, notify: manager.notify });
    if ([401, 403].includes(response.status())) { manager.authorityDenied = true; throw new Error('authority_denied_terminal'); }
    evidence.actual_status = response.status(); assert.equal(response.status(), 409); assert.equal(response.request(), request);
    assert.equal(gate.intents.get('restore_stale11').forwarded, true);
    const observed = await withinDeadline('native_evaluate', () => manager.frame.evaluate(readFetchCloneObserver, binding), { timeoutMs: 7000, notify: manager.notify });
    evidence.clone_outcome = ['PASS', 'TIMEOUT', 'MISSING', 'FETCH_FAILED', 'CLONE_FAILED', 'BODY_TOO_LARGE', 'INVALID_JSON', 'DISPOSED'].includes(observed?.result) ? observed.result : 'INVALID_OBSERVATION';
    assert.equal(observed.result, 'PASS'); assert.equal(observed.status, 409);
    for (const key of ['matched_count', 'native_fetch_count', 'clone_count']) assert.equal(observed[key], 1);
    for (const key of ['original_body_used_at_clone', 'original_body_used_after_clone', 'original_body_used_current']) assert.equal(observed[key], false);
    assert.equal(observed.original_fetch_restored, true); assert.equal(observed.clone_body_used, true);
    assert.ok(Number.isInteger(observed.bytes_read) && observed.bytes_read > 0 && observed.bytes_read <= 8192);
    const cloneHash = assessConflict(observed.body);
    assert.equal(await withinDeadline('response_finished', () => response.finished(), { timeoutMs: 5000, notify: manager.notify }), null);
    const actual = await withinDeadline('response_body', () => response.json(), { timeoutMs: 5000, notify: manager.notify });
    assert.equal(assessConflict(actual), cloneHash);
    await withinDeadline('request_finished', () => ended, { timeoutMs: 2000, notify: manager.notify });
    assert.deepEqual([evidence.requests, evidence.finished, evidence.failed, evidence.unexpected], [1, 1, 0, 0]);
    Object.assign(evidence, { current_version: 12, code: 'assignment_conflict', actual_PW_finished_null: true,
      actual_PW_body_sha256: cloneHash, actual_clone_bytes: observed.bytes_read, one_clone_matches_full_PW_body: true,
      original_unread: true, original_fetch_restored: true });
  } finally {
    gate.fence();
    try {
      if (installed) {
        const removed = await withinDeadline('native_evaluate', () => manager.frame.evaluate(removeFetchCloneObserver, binding), { timeoutMs: 2000, notify: manager.notify });
        evidence.observer_cleanup_confirmed = removed.restored === true; assert.equal(removed.restored, true);
      }
    } finally { manager.page.off('request', started); manager.page.off('requestfinished', finished); manager.page.off('requestfailed', failed); }
  }
}

export async function publicationStaleRace(manager, gate, body, button) {
  assert.equal(manager.authorityDenied, false);
  if (await button.isDisabled()) { gate.fence(); return { outcome: 'UI_FENCED', actual_POST409: 'NOT_RUN', native_confirm_disabled: true }; }
  const target = LOCAL_ORIGIN + manager.prefix + 'api/v1/publication/confirm'; let resolve;
  const waiting = new Promise(done => { resolve = done; });
  const observe = response => {
    try { if (response.url() === target && response.request().method() === 'POST' && response.request().frame() === manager.frame) resolve(response); }
    catch { /* Detached/background responses never establish review evidence. */ }
  };
  manager.page.on('response', observe);
  try {
    gate.grant('publication_stale11', 'A', 'publication/confirm', 'POST', body);
    try { await button.click({ timeout: 1000 }); }
    catch (error) { if (!gate.intents.get('publication_stale11').forwarded && await button.isDisabled()) return { outcome: 'UI_FENCED', actual_POST409: 'NOT_RUN', native_confirm_disabled: true }; throw error; }
    if (!gate.intents.get('publication_stale11').forwarded && await button.isDisabled()) return { outcome: 'UI_FENCED', actual_POST409: 'NOT_RUN', native_confirm_disabled: true };
    const response = await withinDeadline('response_headers', () => waiting, { timeoutMs: 5000, notify: manager.notify });
    assert.equal(gate.intents.get('publication_stale11').forwarded, true);
    if ([401, 403].includes(response.status())) { manager.authorityDenied = true; throw new Error('authority_denied_terminal'); }
    assert.equal(response.status(), 409);
    assert.equal(await withinDeadline('response_finished', () => response.finished(), { timeoutMs: 5000, notify: manager.notify }), null);
    const result = await withinDeadline('response_body', () => response.json(), { timeoutMs: 5000, notify: manager.notify });
    keys(result, ['detail']); keys(result.detail, ['code']); assert.equal(result.detail.code, 'review_stale');
    return { outcome: 'SERVER_REJECTED', actual_POST409: 'PASS', actual_status: 409, code: 'review_stale',
      actual_PW_finished_null: true, full_body_sha256: hash(JSON.stringify(result)), one_shot_request: true };
  } finally { gate.fence(); manager.page.off('response', observe); }
}

async function nativeState(manager, baseline, revision) {
  const endpoints = { page: 'assignments?offset=0&limit=100', publication: 'publication', playback: 'playback-status', recovery: 'recovery',
    albumName: `tags/${hash(ALBUM_TAG)}/name`, playlistName: `tags/${hash(PLAYLIST_TAG)}/name` }, values = {};
  for (const [name, endpoint] of Object.entries(endpoints)) {
    values[name] = await withinDeadline('native_read', () => manager.frame.evaluate(async ({ base, endpoint }) => {
      const response = await fetch(new URL('api/v1/' + endpoint, base), { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(10000) });
      return { status: response.status, body: await response.json() };
    }, { base: manager.frame.url(), endpoint }), { notify: value => manager.notify?.({ ...value, category: nativeEndpointCategory(endpoint) }) });
  }
  return { values, evidence: assessRestoreState(values, baseline, revision) };
}

async function UIRequest(manager, endpoint, method, click, gate, intent = null, body = null) {
  assert.equal(manager.authorityDenied, false);
  const target = LOCAL_ORIGIN + manager.prefix + 'api/v1/' + endpoint;
  if (intent) gate.grant(intent, manager.role, endpoint, method, body);
  const waiting = manager.page.waitForResponse(value => value.url() === target && value.request().method() === method
    && value.request().frame() === manager.frame, { timeout: 15000 }); waiting.catch(() => {});
  try {
    const [response] = await withinDeadline('response_headers', () => Promise.all([waiting, click()]), { timeoutMs: 20000, notify: manager.notify });
    if ([401, 403].includes(response.status())) { manager.authorityDenied = true; throw new Error('authority_denied_terminal'); }
    assert.equal(await withinDeadline('response_finished', () => response.finished(), { timeoutMs: 5000, notify: manager.notify }), null);
    return { status: response.status(), body: await withinDeadline('response_body', () => response.json(), { timeoutMs: 5000, notify: manager.notify }) };
  } finally { gate.fence(); }
}

async function downloadExport(manager, gate, names, evidence) {
  const capture = await diagnoseExportDownload(manager, names, evidence, () => gate.fence());
  assert.equal(capture.passed, true);
  return { bytes: capture.bytes, recovery: capture.recovery, same_actual_browser_response_clone_and_download: true };
}

async function prepareB(manager) {
  const drafts = manager.frame.getByRole('region', { name: 'Saved local drafts', exact: true });
  const rows = drafts.locator(':scope > ul.tag-list > li'); let selected;
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    if (await row.locator('code.exact-id').first().textContent() === ALBUM_TAG) { assert.equal(selected, undefined); selected = row; }
  }
  assert.ok(selected); await selected.getByRole('button', { name: /^Edit draft / }).click();
  const editor = drafts.getByRole('region', { name: 'Saved draft detail', exact: true }).getByRole('region', { name: 'Local draft editor', exact: true });
  await manager.expect(editor.getByRole('button', { name: 'Save local draft', exact: true })).toBeEnabled();
  const input = assignmentInput(ALBUM_TAG, 7, { enabled: false });
  await editor.getByLabel('Draft media type', { exact: true }).selectOption(input.media_type);
  await editor.getByLabel('Draft Spotify URI or link', { exact: true }).fill(input.input);
  await editor.getByLabel('Enabled draft', { exact: true }).setChecked(false);
  await editor.getByLabel('Shuffle', { exact: true }).setChecked(false);
  return { editor, input };
}

async function prepareRestore(manager, gate, recovery, packet, revision) {
  const response = await UIRequest(manager, 'restores/preview', 'POST', () => recovery.getByRole('button', { name: 'Preview restore', exact: true }).click(),
    gate, revision === 11 ? 'preview11' : 'preview12', '{"document":' + packet.content + '}');
  assert.equal(response.status, 200); const evidence = assessRestorePreview(response.body, packet.document, revision);
  gate.bindPreview(revision, response.body.preview_token);
  const region = recovery.getByRole('region', { name: 'Restore preview', exact: true });
  await manager.expect(region).toContainText(`2 supported rows · 0 rejected rows · 2 existing draft conflicts · Local revision ${revision}`);
  await manager.expect(region.getByLabel('Restore conflict policy', { exact: true })).toHaveValue('');
  await manager.expect(region.getByLabel('I reviewed the restore rows and conflict policy', { exact: true })).not.toBeChecked();
  await manager.expect(region.getByRole('button', { name: 'Confirm local restore', exact: true })).toBeDisabled();
  await region.getByLabel('Restore conflict policy', { exact: true }).selectOption('replace');
  await region.getByLabel('I reviewed the restore rows and conflict policy', { exact: true }).check();
  await manager.expect(region.getByRole('button', { name: 'Confirm local restore', exact: true })).toBeEnabled();
  return { region, evidence, body: JSON.stringify({ preview_token: response.body.preview_token, conflict_policy: 'replace', confirmed: true }) };
}

export async function runRestore(pathA, pathB, { progress = () => {} } = {}) {
  const report = { fixture: FIXTURE, phase: 'restore-stale-review', stage: 'local_inputs', result: 'FAIL', checks: {}, limitations: [
    'One-shot current11 export/restore and stale review only. No publication, dispatch, scans, rename, restart or automatic policy activation is intended.',
    'Publication409 is complete only if the ordinary UI sends the stale review and the server returns review_stale. If the natural poll disables Confirm first, actual409 remains NOT_RUN/PARTIAL; no force, polling suppression or retry.',
    'Export bytes and session-bound preview/review tokens stay in private browser artifacts/RAM; reports contain hashes and fixed counts only.',
    'Logical restore increments row/global history and sets durable recovery guards; it does not restore runtime identity or clear publication guards. No pending jobs exist, so native pending-job fencing is not claimed.',
    'Protected backup, durable audit/guard-generation/history and installed scripts remain separate coordinator evidence. No physical playback or whole-issue acceptance claim.',
  ] };
  const managers = {}, stageByRole = {}; let inputs, ready, baseline, gate, activeRole = 'coordinator';
  const notify = (role, value) => progress({ role, stage: stageByRole[role] ?? report.stage, ...value });
  const stage = (role, value) => { activeRole = role; report.stage = value; stageByRole[role] = value; notify(role, { operation: 'phase', checkpoint: 'begin' }); };
  const verify = () => {
    validateManagerReadiness(ready, inputs); validateRestoreBaseline(baseline, inputs, ready);
    for (const manager of Object.values(managers)) assert.equal(manager.authorityDenied, false);
  };
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_restore.mjs', 'fetch_clone.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs',
      'browser_manager.mjs', 'browser_metadata.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    inputs = { A: readPublicInputs(pathA), B: readPublicInputs(pathB) }; stage('coordinator', 'root_readiness_receipt');
    const readyBytes = readBoundedFile(join(CONTROL_ROOT, 'restore-ready.json'), 16384); ready = parseManagerReceipt(readyBytes.toString('utf8'));
    const baselineBytes = readBoundedFile(join(CONTROL_ROOT, 'restore-baseline.json'), 16384); baseline = parseRestoreBaseline(baselineBytes.toString('utf8')); verify();
    report.checks.readiness = { ...validateManagerReadiness(ready, inputs), file_sha256: hash(readyBytes) };
    report.checks.baseline = { ...validateRestoreBaseline(baseline, inputs, ready), file_sha256: hash(baselineBytes) };
    gate = new RestoreIntentGate(verify);
    for (const role of ['A', 'B']) {
      report.checks[role] = { checks: {} };
      managers[role] = await openNativeManager(inputs[role], report.checks[role], { requestAllowed: (request, scope) => gate.allow(role, request, scope),
        setStage: value => stage(role, value), progress: value => notify(role, value) });
      const manager = managers[role]; manager.role = role; manager.authorityDenied = false;
      manager.page.on('response', response => {
        try { if (response.request().frame() === manager.frame && response.url().startsWith(LOCAL_ORIGIN + manager.prefix + 'api/v1/')
          && [401, 403].includes(response.status())) manager.authorityDenied = true; } catch { /* Detached frames confer no authority. */ }
      });
      report.checks[role].checks.inventory = assessDiagnosticInventory(manager.observations.inventory);
      report.checks[role].checks.bootstrap_network = assessNetworkBoundaries(manager.network, manager.networkCategories);
    }
    const A = managers.A, B = managers.B;
    report.checks.admin_pair = assessTwoAdmins(ready, { ...report.checks.A.checks.native_reads, prefix: A.prefix }, { ...report.checks.B.checks.native_reads, prefix: B.prefix });
    stage('A', 'restore_state_before'); const initialA = await nativeState(A, baseline, 11), initialB = await nativeState(B, baseline, 11);
    assert.deepEqual(initialA.evidence, initialB.evidence); report.checks.initial = initialA.evidence;
    const fixtureBefore = await withinDeadline('fixture_control', () => A.page.mainFrame().evaluate(callFixtureControl,
      { action: 'status', mode: null, user_id_sha256: ready.admin_A_user_id_sha256 }), { timeoutMs: 10000, notify: A.notify });
    if (fixtureBefore.outcome === 'AUTH_DENIED') A.authorityDenied = true;
    assert.equal(fixtureBefore.outcome, 'PASS'); report.checks.fixture_before = assessFixtureStatus(fixtureBefore.status, 'fresh');
    const names = { [ALBUM_TAG]: initialA.values.albumName.body.name, [PLAYLIST_TAG]: initialA.values.playlistName.body.name };
    stage('A', 'restore_export'); report.checks.export_capture = {};
    const downloaded = await downloadExport(A, gate, names, report.checks.export_capture);
    const packet = assessExportBytes(downloaded.bytes, names); report.checks.export = { ...packet.evidence, actual_download_matches_browser_response_clone: true };
    gate.bindExport('{"document":' + packet.content + '}');
    await downloaded.recovery.getByLabel('Logical export JSON file', { exact: true }).setInputFiles({ name: exportName, mimeType: 'application/json', buffer: downloaded.bytes });
    report.checks.upload = { same_downloaded_bytes: true, sha256: hash(downloaded.bytes) };
    stage('A', 'restore_preview11'); const old = await prepareRestore(A, gate, downloaded.recovery, packet, 11); report.checks.preview11 = old.evidence;
    stage('B', 'restore_prepare_B'); const preparedB = await prepareB(B);
    stage('A', 'restore_publication_review'); const publication = A.frame.getByRole('region', { name: 'Publication status', exact: true });
    const reviewed = await UIRequest(A, 'publication/review', 'POST', () => publication.getByRole('button', { name: 'Review snapshot publication', exact: true }).click(),
      gate, 'publication_review11', JSON.stringify({ action: 'publish' }));
    assert.equal(reviewed.status, 200); report.checks.publication_review = assessPublicationReview(reviewed.body, baseline); gate.bindPublication(reviewed.body.review_token);
    const reviewRegion = publication.getByRole('region', { name: 'Review immutable snapshot', exact: true });
    await A.expect(reviewRegion).toContainText('Saved revision 11 · 2 mappings');
    await reviewRegion.getByLabel('I reviewed this exact snapshot and its preferences', { exact: true }).check();
    const publicationButton = reviewRegion.getByRole('button', { name: 'Confirm snapshot publication', exact: true }); await A.expect(publicationButton).toBeEnabled();
    stage('A', 'restore_align_publication_poll');
    const polled = await withinDeadline('response_headers', () => A.page.waitForResponse(value => value.url() === LOCAL_ORIGIN + A.prefix + 'api/v1/publication'
      && value.request().method() === 'GET' && value.request().frame() === A.frame, { timeout: 10000 }), { timeoutMs: 12000, notify: A.notify });
    assert.equal(polled.status(), 200); const pollBody = await withinDeadline('response_body', () => polled.json(), { timeoutMs: 5000, notify: A.notify });
    assert.equal(pollBody.desired_version, 11); assert.equal(pollBody.healthy, true); assert.deepEqual(pollBody.jobs, []);
    stage('B', 'restore_B_save12');
    const savedB = await UIRequest(B, `tags/${hash(ALBUM_TAG)}/assignment`, 'PUT', () => preparedB.editor.getByRole('button', { name: 'Save local draft', exact: true }).click(),
      gate, 'B_save12', JSON.stringify(preparedB.input));
    assert.equal(savedB.status, 200); assessAssignmentState(savedB.body, preparedB.input); gate.BChanged = true;
    // Deliberately no intervening DOM/readback/status work: the normal A Confirm
    // competes with the unchanged three-second poll, and may be fenced by it.
    stage('A', 'restore_publication_stale');
    report.checks.publication_stale = await publicationStaleRace(A, gate, JSON.stringify({ review_token: reviewed.body.review_token,
      confirmed: true, confirm_empty: false, automatic_publication_attested: false }), publicationButton);
    if (report.checks.publication_stale.actual_POST409 === 'PASS') await A.expect(publication.getByRole('alert')).toContainText('Content or HA state changed. Review the current snapshot again.');
    else await A.expect(publicationButton).toBeDisabled();
    report.checks.after_B = (await nativeState(A, baseline, 12)).evidence;
    stage('A', 'restore_stale_confirm'); report.checks.restore_stale = {};
    await staleRestoreRequest(A, gate, old.body, () => old.region.getByRole('button', { name: 'Confirm local restore', exact: true }).click(), report.checks.restore_stale);
    await A.expect(downloaded.recovery.getByRole('alert')).toContainText('Preview expired, another edit changed local drafts');
    await A.expect(old.region).toContainText('This preview is stale or already used. Preview again before confirming.');
    await A.expect(old.region.getByRole('button', { name: 'Confirm local restore', exact: true })).toBeDisabled();
    report.checks.after_failed_restore = (await nativeState(A, baseline, 12)).evidence;
    assert.deepEqual(report.checks.after_failed_restore, report.checks.after_B);
    stage('A', 'restore_preview12'); const current = await prepareRestore(A, gate, downloaded.recovery, packet, 12); report.checks.preview12 = current.evidence;
    assert.notEqual(current.evidence.preview_token_sha256, old.evidence.preview_token_sha256);
    stage('A', 'restore_commit13');
    const restored = await UIRequest(A, 'restores/confirm', 'POST', () => current.region.getByRole('button', { name: 'Confirm local restore', exact: true }).click(),
      gate, 'restore_commit12', current.body);
    assert.equal(restored.status, 200); keys(restored.body, ['restored', 'skipped', 'report', 'reconciliation_required']);
    assert.equal(restored.body.restored, 2); assert.equal(restored.body.skipped, 0); assert.equal(restored.body.reconciliation_required, true);
    const restoredReport = assessRestorePreview(restored.body.report, packet.document, 12);
    assert.equal(restoredReport.preview_token_sha256, current.evidence.preview_token_sha256);
    report.checks.restore_commit = { restored: 2, skipped: 0, source_revision: 11, reviewed_revision: 12, expected_saved_revision: 13, reconciliation_required: true };
    await A.expect(downloaded.recovery.getByRole('status').filter({ hasText: '2 local drafts restored;' })).toContainText('Recovery reconciliation required');
    await A.expect(current.region.getByRole('button', { name: 'Confirm local restore', exact: true })).toBeDisabled();
    stage('A', 'restore_state_after');
    for (const [role, manager] of Object.entries(managers)) {
      const final = await nativeState(manager, baseline, 13); report.checks[role].checks.final = final.evidence;
      assert.deepEqual(final.evidence.name_sha256, initialA.evidence.name_sha256);
      const region = manager.frame.getByRole('region', { name: 'Publication status', exact: true });
      await manager.expect(region.getByRole('button', { name: 'Review snapshot publication', exact: true })).toBeDisabled();
      await manager.expect(region.getByRole('button', { name: 'Review publication recovery', exact: true })).toBeVisible();
      await manager.expect(region).toContainText('Recovery reconciliation required. Automatic publication is suspended.');
    }
    assert.deepEqual(report.checks.A.checks.final, report.checks.B.checks.final);
    const fixtureAfter = await withinDeadline('fixture_control', () => A.page.mainFrame().evaluate(callFixtureControl,
      { action: 'status', mode: null, user_id_sha256: ready.admin_A_user_id_sha256 }), { timeoutMs: 10000, notify: A.notify });
    if (fixtureAfter.outcome === 'AUTH_DENIED') A.authorityDenied = true;
    assert.equal(fixtureAfter.outcome, 'PASS'); report.checks.fixture_after = assessFixtureStatus(fixtureAfter.status, 'fresh', report.checks.fixture_before.instance_sha256);
    assert.equal(report.checks.fixture_after.metadata_calls, report.checks.fixture_before.metadata_calls);
    gate.fence(); stage('A', 'close_browsers_and_assess');
    for (const manager of Object.values(managers)) {
      assert.equal(manager.authorityDenied, false); assert.equal((await manager.cleanup()).cleanup_confirmed, true);
      report.checks[manager.role].checks.network_assessment = assessNetworkBoundaries(manager.network, manager.networkCategories);
    }
    report.restore_completed = true; report.result = report.checks.publication_stale.actual_POST409 === 'PASS' ? 'PASS' : 'PARTIAL';
    if (report.result === 'PARTIAL') report.code = 'publication_stale_409_not_run';
    stage('coordinator', 'complete'); notify('coordinator', { operation: 'phase', checkpoint: 'complete' });
  } catch (error) {
    report.code = Object.values(managers).some(value => value.authorityDenied) ? 'authority_denied_terminal' : error?.code === 'native_deadline' ? 'native_deadline' : 'native_restore_failed';
    notify(activeRole, { operation: 'phase', checkpoint: 'failed' });
  } finally {
    gate?.fence();
    for (const [role, manager] of Object.entries(managers)) {
      if (!(await manager.cleanup()).cleanup_confirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
      report.checks[role].checks.network = { ...manager.network };
    }
    report.intent_ledger = gate?.evidence() ?? []; report.any_gate_enabled = Boolean(gate?.armed.size);
  }
  return report;
}

export async function runExportDiagnose(pathA, pathB, { progress = () => {} } = {}) {
  const report = { fixture: FIXTURE, phase: 'export-diagnose', stage: 'local_inputs', result: 'FAIL', checks: {}, limitations: [
    'Read-only correction5 export capture verification. The native diagnostic proved Playwright returned an empty automation body for a valid UI Blob; lower-level mechanism remains UNPROVEN.',
    'One actual Response clone must match the original UI Blob bytes. Playwright body remains diagnostic only, with no independent-wire claim; logical schema/ID/name/preference criteria remain unchanged.',
    'Only A opens a normal actual HA/sidebar browser. B public config binds the existing strict two-admin readiness receipt; B credential values are not read.',
    'One explicit UI exportGET/blobdownload; only safe lengths/hashes/type/key classes/expected-match booleans are reported. No raw file/body/header/ID/token/error or private content file is written.',
    'No intent is granted, preview/confirm called, fixture mode changed or domain state reset. Exact current11 before/after and normal cleanup remain required.',
  ] };
  let manager, gate, inputs, ready, baseline;
  const notify = value => progress({ role: 'A', stage: report.stage, ...value });
  const stage = value => { report.stage = value; notify({ operation: 'phase', checkpoint: 'begin' }); };
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_restore.mjs', 'fetch_clone.mjs', 'browser.mjs', 'browser_inputs.mjs',
      'browser_auth.mjs', 'browser_manager.mjs', 'browser_metadata.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    inputs = { A: readPublicInputs(pathA), B: readPublicInputs(pathB) }; stage('root_readiness_receipt');
    const readyBytes = readBoundedFile(join(CONTROL_ROOT, 'restore-ready.json'), 16384); ready = parseManagerReceipt(readyBytes.toString('utf8'));
    const baselineBytes = readBoundedFile(join(CONTROL_ROOT, 'restore-baseline.json'), 16384); baseline = parseRestoreBaseline(baselineBytes.toString('utf8'));
    const verify = () => { validateManagerReadiness(ready, inputs); validateRestoreBaseline(baseline, inputs, ready); };
    verify(); report.checks.readiness = { ...validateManagerReadiness(ready, inputs), file_sha256: hash(readyBytes) };
    report.checks.baseline = { ...validateRestoreBaseline(baseline, inputs, ready), file_sha256: hash(baselineBytes) };
    gate = new RestoreIntentGate(verify); report.checks.A = { checks: {} };
    manager = await openNativeManager(inputs.A, report.checks.A, { requestAllowed: (request, scope) => gate.allow('A', request, scope), setStage: stage, progress: notify });
    manager.authorityDenied = false;
    assert.equal(report.checks.A.checks.native_reads.user_id_sha256, ready.admin_A_user_id_sha256);
    report.checks.inventory = assessDiagnosticInventory(manager.observations.inventory);
    report.checks.bootstrap_network = assessNetworkBoundaries(manager.network, manager.networkCategories);
    stage('export_diag_before'); const before = await nativeState(manager, baseline, 11); report.checks.state_before = before.evidence;
    const names = { [ALBUM_TAG]: before.values.albumName.body.name, [PLAYLIST_TAG]: before.values.playlistName.body.name };
    verify(); assert.equal(gate.intents.size, 0); assert.equal(gate.armed.size, 0);
    stage('export_diag_download'); report.checks.export_diagnostic = {};
    let passed = false;
    try { passed = (await diagnoseExportDownload(manager, names, report.checks.export_diagnostic, () => gate.fence())).passed; }
    catch (error) { report.code = error?.code === 'native_deadline' ? 'native_deadline' : 'export_capture_failed'; }
    if (manager.authorityDenied) throw new Error('authority_denied_terminal');
    stage('export_diag_after'); const after = await nativeState(manager, baseline, 11); report.checks.state_after = after.evidence;
    assert.deepEqual(before.evidence, after.evidence); assert.equal(gate.intents.size, 0); assert.equal(gate.armed.size, 0);
    gate.fence(); stage('close_browsers_and_assess'); assert.equal((await manager.cleanup()).cleanup_confirmed, true);
    report.checks.network_assessment = assessNetworkBoundaries(manager.network, manager.networkCategories);
    report.diagnostic_completed = report.checks.export_diagnostic.checkpoint === 'all_safe_projections_recorded';
    report.result = passed ? 'PASS' : 'FAIL';
    if (!passed) report.code ??= report.checks.export_diagnostic.failure_code ?? 'export_capture_failed';
    stage('complete'); notify({ operation: 'phase', checkpoint: passed ? 'complete' : 'failed' });
  } catch (error) {
    report.code = manager?.authorityDenied ? 'authority_denied_terminal' : error?.code === 'native_deadline' ? 'native_deadline' : 'native_export_diagnostic_failed'; notify({ operation: 'phase', checkpoint: 'failed' });
  } finally {
    gate?.fence();
    if (manager) {
      if (!(await manager.cleanup()).cleanup_confirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
      report.checks.A.checks.network = { ...manager.network };
    }
    report.intent_ledger = gate?.evidence() ?? []; report.any_gate_enabled = Boolean(gate?.armed.size);
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write('node scripts/haos_acceptance/browser_restore.mjs restore-stale-review CONFIG_A CONFIG_B\nnode scripts/haos_acceptance/browser_restore.mjs export-diagnose CONFIG_A CONFIG_B\n');
  else if (args.length === 3 && ['restore-stale-review', 'export-diagnose'].includes(args[0])) {
    const run = args[0] === 'export-diagnose' ? runExportDiagnose : runRestore;
    const report = await run(args[1], args[2], { progress: createProgressStream(line => process.stderr.write(line)) });
    const unconfirmed = ['A', 'B'].some(role => report.checks[role]?.checks.cleanup?.cleanup_confirmed === false);
    if (unconfirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; report.forced_exit_after_report = true; }
    process.exitCode = report.result === 'PASS' ? 0 : 1;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => { if (unconfirmed) process.stderr.write('', () => process.exit(1)); });
  } else { process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'invalid_phase_arguments' }) + '\n'); process.exitCode = 2; }
}
