/** Local synthetic readiness and mutation-boundary tests; no native HA access. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeBrowserBounded, createProgressStream, memoizedBrowserCleanup, nativeEndpointCategory, withinDeadline } from './browser_progress.mjs';
import { FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { ALBUM_TAG, ALBUM_URI, CONTINUED_LABEL, PLAYLIST_TAG, PLAYLIST_URI, RENAMED_LABEL, ManagerWriteGate,
  assessAssignmentState, assessContinuationFinal, assessContinuationStart, assessDiagnosticInventory, assessKnownPartialState, assessManagerGuards, assessTwoAdmins, assignmentInput,
  finishManagerEdit, observedUIRequest, saveAssignment, parseContinuationBaseline, parseDiagnosticBaseline, parseManagerReceipt, parseResumeThreeBaseline, parseCaptureNineBaseline,
  validateContinuationBaseline, validateDiagnosticBaseline, validateManagerReadiness, validateResumeThreeBaseline, validateCaptureNineBaseline } from './browser_manager.mjs';

function conflictCaptureFixture({ version = 3, cloneBody, PWBody, duplicate = false, wrongRequest = false,
  cleanupFails = false, observation, finished = null } = {}) {
  const input = assignmentInput(ALBUM_TAG, version, { enabled: version !== 2, shuffle: true });
  const endpoint = `tags/${hash(ALBUM_TAG)}/assignment`, prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
  const url = LOCAL_ORIGIN + prefix + 'api/v1/' + endpoint;
  const body = { detail: { code: 'assignment_conflict', current_version: version + 1 } };
  const page = new EventEmitter(), nativeResponse = new Response(JSON.stringify(cloneBody ?? body), { status: 409 });
  let fetches = 0, fenced = false, observerRemovals = 0, matched;
  const initialFence = () => { fenced = true; };
  const owner = { fetch: () => { fetches += 1; return Promise.resolve(nativeResponse); } };
  const frame = { evaluate: async (operation, argument) => {
    if (operation.name === 'removeFetchCloneObserver') {
      observerRemovals += 1; assert.equal(fenced, true);
      if (cleanupFails) return { restored: false };
    }
    if (operation.name === 'readFetchCloneObserver' && observation) return observation;
    return operation(argument, owner);
  } };
  const request = { url: () => url, method: () => 'PUT', frame: () => frame,
    postData: () => JSON.stringify(wrongRequest ? { ...input, expected_version: 2 } : input) };
  const response = { url: () => url, status: () => 409, request: () => request,
    finished: () => finished instanceof Promise ? finished : Promise.resolve(finished), json: async () => PWBody ?? body };
  page.waitForResponse = predicate => new Promise(resolve => { matched = value => { if (predicate(value)) resolve(value); }; });
  const click = async () => {
    page.emit('request', request);
    if (duplicate) page.emit('request', request);
    assert.equal(await owner.fetch(url, { method: 'PUT', body: JSON.stringify(input) }), nativeResponse);
    matched(response); page.emit('requestfinished', request);
  };
  return { manager: { page, frame, prefix }, endpoint, input, click, evidence: {},
    fenceWrites: initialFence, inspect: () => ({ fetches, observerRemovals, nativeResponse, owner, page }) };
}

test('every expected409 save uses actual shared capture and fresh single grants, including pristine and partial2', async () => {
  for (const version of [1, 2, 3, 5]) {
    const value = conflictCaptureFixture({ version }); let grants = 0, successfulRemovals = 0;
    const gates = { A: new ManagerWriteGate({ beforeGrant: () => { grants += 1; } }), B: new ManagerWriteGate() };
    const evaluate = value.manager.frame.evaluate;
    value.manager.frame.evaluate = (operation, argument) => {
      if (operation.name === 'removeFetchCloneObserver') {
        assert.equal(gates.A.enabled, false); assert.equal(gates.B.enabled, false);
        successfulRemovals += 1; value.fenceWrites();
      }
      return evaluate(operation, argument);
    };
    const editor = { getByLabel: () => ({ selectOption: async () => {}, fill: async () => {}, setChecked: async () => {} }),
      getByRole: () => ({ click: async () => {
        assert.equal(gates.A.allow(request(value.input), { fromFrame: true, prefix: value.manager.prefix }), true);
        await value.click();
      } }) };
    const result = await saveAssignment(value.manager, gates.A, editor, value.input, value.evidence, 409, gates);
    assert.equal(result.body.detail.current_version, version + 1);
    assert.equal(value.evidence.conflict_capture.one_exact_UI_request, true);
    assert.equal(value.evidence.conflict_capture.actual_PW_finished_null, true);
    assert.equal(value.evidence.conflict_capture.clone_matches_actual_PW_body, true);
    assert.equal(grants, 1); assert.equal(successfulRemovals, 1);
    assert.equal(gates.A.enabled, false); assert.equal(gates.B.enabled, false);
    assert.equal(gates.A.settled().length, 1); assert.equal(value.inspect().fetches, 1);
  }
});

test('an expected409 save without the all-context cleanup fence refuses before UI edits or grants', async () => {
  const gate = new ManagerWriteGate(); let edits = 0;
  const editor = { getByLabel: () => { edits += 1; throw new Error('unexpected_UI_edit'); } };
  await assert.rejects(saveAssignment({}, gate, editor, assignmentInput(ALBUM_TAG, 1, { shuffle: true }), {}, 409));
  assert.equal(edits, 0); assert.equal(gate.pending, null); assert.equal(gate.enabled, false);
});

test('the actual UI conflict capture reads one clone while retaining the full PW 409 body and original unread response', async () => {
  const value = conflictCaptureFixture();
  const response = await observedUIRequest(value.manager, value.endpoint, 'PUT', value.click, value);
  assert.deepEqual(response, { status: 409, body: { detail: { code: 'assignment_conflict', current_version: 4 } } });
  assert.equal(value.evidence.conflict_capture.one_exact_UI_request, true);
  assert.equal(value.evidence.conflict_capture.actual_PW_finished_null, true);
  assert.equal(value.evidence.conflict_capture.original_response_unread, true);
  assert.equal(value.evidence.conflict_capture.clone_matches_actual_PW_body, true);
  assert.equal(value.inspect().fetches, 1); assert.equal(value.inspect().observerRemovals, 1);
  assert.equal(value.inspect().nativeResponse.bodyUsed, false);
  assert.deepEqual(await value.inspect().nativeResponse.json(), response.body);
  assert.equal(value.inspect().page.listenerCount('request'), 0);
  assert.equal(value.inspect().page.listenerCount('requestfinished'), 0);
  assert.equal(value.inspect().page.listenerCount('requestfailed'), 0);
});

test('full conflict capture refuses wrong/missing/duplicate requests, bodies, observer outcomes and unconfirmed restoration', async () => {
  const badBody = { detail: { code: 'assignment_conflict', current_version: 3 } };
  for (const options of [{ duplicate: true }, { wrongRequest: true }, { cloneBody: badBody }, { PWBody: badBody },
    { cloneBody: { detail: { code: 'wrong_error', current_version: 4 } } },
    { PWBody: { detail: { code: 'assignment_conflict', current_version: 4 }, extra: 'SYNTHETIC_PRIVATE_SENTINEL' } },
    { observation: { result: 'MISSING' } }, { observation: { result: 'TIMEOUT' } },
    { observation: { result: 'PASS', matched_count: 2 } }, { finished: 'SYNTHETIC_PRIVATE_SENTINEL' },
    { cleanupFails: true }]) {
    const value = conflictCaptureFixture(options);
    await assert.rejects(observedUIRequest(value.manager, value.endpoint, 'PUT', value.click, value));
    assert.equal(value.inspect().fetches, 1); assert.equal(value.inspect().observerRemovals, 1);
    assert.equal(value.inspect().page.listenerCount('request'), 0);
    assert.equal(JSON.stringify(value.evidence).includes('SYNTHETIC_PRIVATE'), false);
  }
});

test('an actual PW completion timeout fails conflict capture and still fences writes/removes the observer once', async () => {
  const value = conflictCaptureFixture({ finished: new Promise(() => {}) });
  await assert.rejects(observedUIRequest(value.manager, value.endpoint, 'PUT', value.click, value), error => error.code === 'native_deadline');
  assert.equal(value.evidence.conflict_capture.actual_PW_finished_null, undefined);
  assert.equal(value.inspect().observerRemovals, 1); assert.equal(value.inspect().fetches, 1);
  assert.equal(value.evidence.conflict_capture.observer_cleanup_confirmed, true);
});

test('ordinary 200 UI captures keep their existing body path and never install an observer', async () => {
  let reads = 0, clicked = 0;
  const body = assignmentState(assignmentInput(ALBUM_TAG, 3));
  const response = { json: async () => { reads += 1; return body; }, status: () => 200 };
  const manager = { prefix: '/api/hassio_ingress/SYNTHETIC_PREFIX/', page: { waitForResponse: async () => response } };
  assert.deepEqual(await observedUIRequest(manager, `tags/${hash(ALBUM_TAG)}/assignment`, 'PUT', () => { clicked += 1; }), { status: 200, body });
  assert.equal(reads, 1); assert.equal(clicked, 1);
});

test('ordinary200 saves retain typed body/readback checks with one fresh grant and disabled authority afterward', async () => {
  const input = assignmentInput(ALBUM_TAG, 4), body = assignmentState(input);
  let grants = 0, reads = 0, clicks = 0, statusChecks = 0;
  const gate = new ManagerWriteGate({ beforeGrant: () => { grants += 1; } });
  const manager = { prefix: '/api/hassio_ingress/SYNTHETIC_PREFIX/',
    page: { waitForResponse: async () => ({ status: () => 200, json: async () => { reads += 1; return body; } }) },
    expect: () => ({ toContainText: async message => { assert.equal(message, 'Local draft saved.'); statusChecks += 1; } }) };
  const editor = { getByLabel: () => ({ selectOption: async () => {}, fill: async () => {}, setChecked: async () => {} }),
    getByRole: () => ({ click: async () => {
      clicks += 1; assert.equal(gate.allow(request(input), { fromFrame: true, prefix: manager.prefix }), true);
    } }) };
  const evidence = {};
  assert.deepEqual(await saveAssignment(manager, gate, editor, input, evidence), { status: 200, body });
  assert.equal(evidence.version, 5); assert.equal(evidence.conflict_capture, undefined);
  assert.deepEqual([grants, reads, clicks, statusChecks], [1, 1, 1, 1]); assert.equal(gate.enabled, false);
});

test('save re-enabling cannot bypass an expired per-grant receipt or erase pending authority evidence', async () => {
  const input = assignmentInput(ALBUM_TAG, 3), editor = { getByLabel: () => ({ selectOption: async () => {}, fill: async () => {}, setChecked: async () => {} }) };
  const expired = new ManagerWriteGate({ beforeGrant: () => { throw new Error('expired_receipt'); } });
  await assert.rejects(saveAssignment({}, expired, editor, input, {}), error => error.message === 'expired_receipt');
  assert.equal(expired.enabled, false); assert.equal(expired.pending, null);
  const pending = new ManagerWriteGate(); pending.enable(); pending.grant('PUT', `tags/${hash(ALBUM_TAG)}/assignment`, input); pending.disable();
  const original = structuredClone(pending.pending);
  await assert.rejects(saveAssignment({}, pending, editor, input, {}));
  assert.equal(pending.enabled, false); assert.deepEqual(pending.pending, original); assert.equal(pending.observed.length, 0);
});

test('an unresolved native operation produces a finite generic deadline instead of hanging', async () => {
  const outcome = await Promise.race([
    withinDeadline('native_read', () => new Promise(() => {}), { timeoutMs: 10 }).catch(error => error.code),
    new Promise(done => setTimeout(() => done('still_pending_at_outer_bound'), 100)),
  ]);
  assert.equal(outcome, 'native_deadline');
});

test('deadlines preserve successful values, hide raw failures and settle once after late resolution', async () => {
  assert.equal(await withinDeadline('response_body', async () => 200, { timeoutMs: 50 }), 200);
  await assert.rejects(withinDeadline('response_body', async () => { throw new Error('SYNTHETIC_PRIVATE_SENTINEL'); }), error => error.code === 'native_operation_failed' && !error.message.includes('SYNTHETIC'));
  const events = []; let release;
  await assert.rejects(withinDeadline('native_evaluate', () => new Promise(done => { release = done; }), {
    timeoutMs: 10, notify: event => events.push(event),
  }), error => error.code === 'native_deadline');
  release('late'); await Promise.resolve();
  assert.deepEqual(events.map(event => event.checkpoint), ['begin', 'timeout']);
});

test('a stuck public browser close returns unconfirmed failure and is never retried', async () => {
  let calls = 0; const events = [];
  const cleanup = memoizedBrowserCleanup(() => ({ close: () => { calls += 1; return new Promise(() => {}); } }), {
    timeoutMs: 10, notify: event => events.push(event),
  });
  const closed = await cleanup(); assert.deepEqual(closed, { cleanup_confirmed: false, reason: 'close_deadline' });
  assert.equal(await cleanup(), closed); assert.equal(calls, 1);
  assert.deepEqual(events.map(event => event.checkpoint), ['begin', 'timeout']);
});

test('progress is a finite redacted JSONL projection and rejects arbitrary values or fields', () => {
  const lines = [], emit = createProgressStream(line => lines.push(line));
  emit({ role: 'A', stage: 'diagnostic_partial_state', operation: 'response_headers', checkpoint: 'headers', category: 'tag_assignment', status: 200 });
  emit({ role: 'A', stage: 'diagnostic_partial_state', operation: 'write_ledger', checkpoint: 'ledger', count: 0 });
  const parsed = lines.map(line => JSON.parse(line)); assert.equal(parsed[1].sequence, 2);
  assert.ok(parsed.every(row => row.event === 'native_progress' && Number.isInteger(row.elapsed_ms)));
  for (const extra of [{ url: 'SYNTHETIC_PRIVATE_SENTINEL' }, { stage: 'SYNTHETIC_PRIVATE_SENTINEL' },
    { role: 'SYNTHETIC_PRIVATE_SENTINEL' }, { checkpoint: 'SYNTHETIC_PRIVATE_SENTINEL' }, { category: 'SYNTHETIC_PRIVATE_SENTINEL' },
    { status: 600 }, { count: -1 }, { error: 'SYNTHETIC_PRIVATE_SENTINEL' }]) {
    assert.throws(() => emit({ role: 'A', stage: 'diagnostic_partial_state', operation: 'native_read', checkpoint: 'begin', ...extra }));
  }
  assert.equal(lines.length, 2); assert.equal(lines.join('').includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(nativeEndpointCategory(`tags/${hash(ALBUM_TAG)}/assignment`), 'tag_assignment');
  assert.equal(nativeEndpointCategory('SYNTHETIC_PRIVATE_SENTINEL?token=private'), 'other_app_read');
});

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

function diagnosticBaseline() {
  const source = receipt();
  return { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN,
    configuration_A_sha256: source.configuration_A_sha256, configuration_B_sha256: source.configuration_B_sha256,
    publisher_id_sha256: '7'.repeat(64), source_reconciliation_sha256: '8'.repeat(64), observed_at: source.observed_at };
}

function continuationBaseline() {
  const value = diagnosticBaseline();
  const { source_reconciliation_sha256, ...fields } = value;
  return { ...fields, assignment_snapshot_sha256: '9'.repeat(64),
    source_diagnostic_report_sha256: source_reconciliation_sha256,
    current_backup_artifact_sha256: receipt().backup_artifact_sha256 };
}

test('continuation refuses a backup hash that does not match the refreshed current-state readiness receipt', () => {
  const value = continuationBaseline(); value.current_backup_artifact_sha256 = '0'.repeat(64);
  assert.throws(() => validateContinuationBaseline(value, inputs(), receipt(), Date.parse('2026-11-01T13:01:00Z')));
});

test('continuation receipt binds exact publisher/config/snapshot/diagnostic provenance and current protected backup', () => {
  const value = continuationBaseline(), now = Date.parse('2026-11-01T13:01:00Z');
  const evidence = validateContinuationBaseline(value, inputs(), receipt(), now);
  assert.equal(evidence.current_backup_artifact_sha256, receipt().backup_artifact_sha256);
  assert.deepEqual(parseContinuationBaseline(JSON.stringify(value)), value);
  for (const damage of [
    value => { value.assignment_snapshot_sha256 = 'raw-snapshot'; }, value => { value.publisher_id_sha256 = 'raw-publisher'; },
    value => { value.configuration_A_sha256 = '0'.repeat(64); }, value => { value.configuration_B_sha256 = '0'.repeat(64); },
    value => { value.source_diagnostic_report_sha256 = 'not-a-hash'; }, value => { value.observed_at = '2026-11-01T12:00:59Z'; },
    value => { value.observed_at = '2026-11-01T13:01:01Z'; }, value => { value.observed_at = 'invalid'; },
    value => { value.arbitrary_target = 'SYNTHETIC_PRIVATE_SENTINEL'; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => validateContinuationBaseline(changed, inputs(), receipt(), now)); }
  assert.throws(() => parseContinuationBaseline(JSON.stringify(value).replace('"schema_version":1', '"schema_version":1,"\\u0073chema_version":1')));
});

function resumeThreeBaseline() {
  const { source_diagnostic_report_sha256, ...value } = continuationBaseline();
  assert.match(source_diagnostic_report_sha256, /^[a-f0-9]{64}$/);
  return { ...value, domain_revision: 3, album_version: 3,
    source_clone_report_sha256: '8e44c686455af2c42f5551f9fa2d55b083db6a227a4956c7d1168d91711f9cd1' };
}

test('resume3 requires its new strict current3/clone-proof/config/current-backup receipt before native actions', () => {
  const value = resumeThreeBaseline(), now = Date.parse('2026-11-01T13:01:00Z');
  const result = validateResumeThreeBaseline(value, inputs(), receipt(), now);
  assert.equal(result.domain_revision, 3); assert.equal(result.album_version, 3);
  assert.deepEqual(parseResumeThreeBaseline(JSON.stringify(value)), value);
  for (const damage of [
    value => { value.domain_revision = 2; }, value => { value.domain_revision = 4; }, value => { value.album_version = 2; },
    value => { value.source_clone_report_sha256 = '0'.repeat(64); }, value => { value.configuration_A_sha256 = '0'.repeat(64); },
    value => { value.configuration_B_sha256 = '0'.repeat(64); }, value => { value.current_backup_artifact_sha256 = '0'.repeat(64); },
    value => { value.publisher_id_sha256 = 'not-a-hash'; }, value => { value.assignment_snapshot_sha256 = 'raw-snapshot'; },
    value => { value.observed_at = '2026-11-01T12:00:59Z'; }, value => { value.observed_at = '2026-11-01T13:01:01Z'; },
    value => { value.origin = 'https://example.invalid'; }, value => { value.synthetic = false; },
    value => { value.extra = 'SYNTHETIC_PRIVATE_SENTINEL'; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => validateResumeThreeBaseline(changed, inputs(), receipt(), now)); }
  assert.throws(() => validateResumeThreeBaseline(continuationBaseline(), inputs(), receipt(), now));
  assert.throws(() => parseResumeThreeBaseline(JSON.stringify(value).replace('"domain_revision":3', '"domain_revision":3,"\\u0064omain_revision":3')));
});

function captureNineBaseline() {
  const { source_clone_report_sha256, ...value } = resumeThreeBaseline();
  assert.match(source_clone_report_sha256, /^[a-f0-9]{64}$/);
  return { ...value, domain_revision: 9, album_version: 5,
    source_concurrency_report_sha256: '92d8d22a422c3144c971828e9609054d9dadbe82dd877bea72e110b2eec83663' };
}

test('capture9 binds a new current9 backup/config/provenance receipt and refuses previous baselines', () => {
  const value = captureNineBaseline(), now = Date.parse('2026-11-01T13:01:00Z');
  assert.equal(validateCaptureNineBaseline(value, inputs(), receipt(), now).domain_revision, 9);
  assert.deepEqual(parseCaptureNineBaseline(JSON.stringify(value)), value);
  for (const damage of [
    value => { value.domain_revision = 3; }, value => { value.album_version = 3; },
    value => { value.source_concurrency_report_sha256 = '0'.repeat(64); }, value => { value.configuration_A_sha256 = '0'.repeat(64); },
    value => { value.current_backup_artifact_sha256 = '0'.repeat(64); }, value => { value.observed_at = '2026-11-01T12:00:59Z'; },
    value => { value.observed_at = '2026-11-01T13:01:01Z'; }, value => { value.extra = 'SYNTHETIC_PRIVATE_SENTINEL'; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => validateCaptureNineBaseline(changed, inputs(), receipt(), now)); }
  assert.throws(() => validateCaptureNineBaseline(resumeThreeBaseline(), inputs(), receipt(), now));
  assert.throws(() => validateResumeThreeBaseline(value, inputs(), receipt(), now));
  assert.throws(() => parseCaptureNineBaseline(JSON.stringify(value).replace('"domain_revision":9', '"domain_revision":9,"\\u0064omain_revision":9')));
});

test('diagnostic baseline binds exactly the root-reconciled publisher/source/configs without a new backup claim', () => {
  const value = diagnosticBaseline(), now = Date.parse('2026-11-01T13:01:00Z');
  assert.equal(validateDiagnosticBaseline(value, inputs(), now).publisher_id_sha256, '7'.repeat(64));
  assert.deepEqual(parseDiagnosticBaseline(JSON.stringify(value)), value);
  for (const damage of [
    value => { value.publisher_id_sha256 = 'raw-publisher'; }, value => { value.configuration_A_sha256 = '0'.repeat(64); },
    value => { value.configuration_B_sha256 = '0'.repeat(64); }, value => { value.observed_at = '2026-11-01T12:00:59Z'; },
    value => { value.observed_at = '2026-11-01T13:01:01Z'; }, value => { value.backup_partial2_verified = true; },
    value => { value.origin = 'https://example.invalid'; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => validateDiagnosticBaseline(changed, inputs(), now)); }
  assert.throws(() => parseDiagnosticBaseline(JSON.stringify(value).replace('"schema_version":1', '"schema_version":1,"\\u0073chema_version":1')));
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

test('continuation rename permits only its new fixed label with the known previous label', () => {
  const endpoint = `tags/${hash(ALBUM_TAG)}/name`;
  const body = { ha_tag_id: ALBUM_TAG, expected_name: RENAMED_LABEL, name: CONTINUED_LABEL };
  const gate = new ManagerWriteGate(); gate.enable(); gate.grant('PATCH', endpoint, body);
  assert.equal(gate.allow(request(body, { method: 'PATCH', endpoint }), scope), true);
  for (const changed of [{ ...body, expected_name: null }, { ...body, name: 'ARBITRARY_LABEL' }, { ...body, ha_tag_id: PLAYLIST_TAG }]) {
    const gate = new ManagerWriteGate(); gate.enable(); assert.throws(() => gate.grant('PATCH', endpoint, changed));
  }
});

test('expired pre-grant facts and a disabled gate prevent writes without erasing uncertain pending evidence', () => {
  const body = assignmentInput(ALBUM_TAG, 2), endpoint = `tags/${hash(ALBUM_TAG)}/assignment`;
  const expired = new ManagerWriteGate({ beforeGrant: () => { throw new Error('expired_receipt'); } });
  expired.enable(); assert.throws(() => expired.grant('PUT', endpoint, body));
  assert.equal(expired.pending, null); assert.equal(expired.observed.length, 0); assert.equal(expired.allow(request(body), scope), false);
  const gate = new ManagerWriteGate(); gate.enable(); gate.grant('PUT', endpoint, body); gate.disable();
  assert.equal(gate.allow(request(body), scope), false); assert.equal(gate.pending.kind, 'synthetic_assignment_save');
  assert.throws(() => gate.settled()); assert.throws(() => gate.grant('PUT', endpoint, body));
});

test('pristine manager-edit cleanup fences all gates before a late request during unconfirmed close', async () => {
  const gates = { A: new ManagerWriteGate(), B: new ManagerWriteGate() };
  for (const gate of Object.values(gates)) gate.enable();
  const body = assignmentInput(ALBUM_TAG, 0), endpoint = `tags/${hash(ALBUM_TAG)}/assignment`;
  gates.B.grant('PUT', endpoint, body);
  let lateDuringClose, closeCalls = 0;
  const managers = { A: { network: {}, cleanup: async () => {
    lateDuringClose = gates.B.allow(request(body), scope);
    return closeBrowserBounded({ close: () => { closeCalls += 1; return new Promise(() => {}); } }, { timeoutMs: 5 });
  } }, B: { network: {}, cleanup: async () => ({ cleanup_confirmed: false, reason: 'close_deadline' }) } };
  const report = { result: 'FAIL', checks: { A: { checks: {} }, B: { checks: {} } } };
  await finishManagerEdit({ managers, gates, report });
  assert.equal(lateDuringClose, false);
  assert.equal(gates.B.allow(request(body), scope), false);
  assert.equal(gates.A.enabled, false); assert.equal(gates.B.enabled, false);
  assert.equal(gates.B.pending.kind, 'synthetic_assignment_save');
  assert.equal(report.checks.B.checks.pending_write_kind, 'synthetic_assignment_save');
  assert.deepEqual(report.checks.B.checks.writes, []);
  assert.equal(report.code, 'browser_cleanup_unconfirmed'); assert.equal(closeCalls, 1);
});

test('continuation ledgers record a single grant/forward and progress accepts its explicit A409 stage', () => {
  const order = [], body = assignmentInput(ALBUM_TAG, 2, { enabled: false, shuffle: true });
  const endpoint = `tags/${hash(ALBUM_TAG)}/assignment`;
  const gate = new ManagerWriteGate({ beforeGrant: () => order.push('freshness_checked'), onForward: count => order.push(`forwarded_${count}`) });
  gate.enable(); gate.grant('PUT', endpoint, body); assert.deepEqual(order, ['freshness_checked']);
  assert.equal(gate.allow(request(body), scope), true); assert.equal(gate.allow(request(body), scope), false);
  assert.deepEqual(order, ['freshness_checked', 'forwarded_1']);
  const lines = [], emit = createProgressStream(line => lines.push(JSON.parse(line)));
  emit({ role: 'A', stage: 'continuation_A_stale_409', operation: 'response_headers', checkpoint: 'headers', category: 'tag_assignment', status: 409 });
  assert.equal(lines[0].status, 409); assert.equal(lines[0].stage, 'continuation_A_stale_409');
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

function partialState() {
  const album = { status: 200, body: assignmentState(assignmentInput(ALBUM_TAG, 1, { enabled: false, shuffle: false })) };
  const current = guards(); current.publication.body.desired_version = 2; current.publication.body.actual.active_revision = null;
  return { values: { album, page: { status: 200, body: { assignments: [structuredClone(album.body.assignment)], total: 1, revision: 2 } },
    playlist: { status: 200, body: { version: 0, assignment: null } },
    name: { status: 200, body: { tag_key: hash(ALBUM_TAG), state: 'current', name: RENAMED_LABEL } } },
  guards: assessManagerGuards(current.publication, current.playback) };
}

test('read-only diagnosis requires the exact known partial2 state and never infers old A409', () => {
  const value = partialState(), publisher = value.guards.publisher_id_sha256;
  const result = assessKnownPartialState(value.values, value.guards, publisher);
  assert.equal(result.saved_revision, 2); assert.equal(result.old_A_409_or_retained_editor_proven, false);
  for (const damage of [
    value => { value.values.page.body.revision = 3; }, value => { value.values.page.body.total = 2; },
    value => { value.values.album.body.assignment.enabled = true; }, value => { value.values.album.body.version = 3; },
    value => { value.values.playlist.body.version = 1; }, value => { value.values.name.body.name = 'OTHER_LABEL'; },
    value => { value.guards.publisher_id_sha256 = '0'.repeat(64); }, value => { value.guards.active_revision = 0; },
    value => { value.guards.dispatch = 'enabled'; }, value => { value.guards.queued_jobs = 1; },
    value => { value.guards.playback_attempts = 1; }, value => { value.values.page.status = 503; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => assessKnownPartialState(changed.values, changed.guards, publisher)); }
});

test('both actual starting snapshots must equal the explicit known partial2 receipt before continuation', () => {
  const value = partialState(), publisher = value.guards.publisher_id_sha256;
  const A = assessKnownPartialState(value.values, value.guards, publisher), B = structuredClone(A);
  const baseline = { publisher_id_sha256: publisher, assignment_snapshot_sha256: A.assignment_snapshot_sha256 };
  assert.equal(assessContinuationStart(baseline, A, B).root_snapshot_bound_in_both_actual_contexts, true);
  for (const damage of [
    value => { value.saved_revision = 3; }, value => { value.album.enabled = true; }, value => { value.playlist_version = 1; },
    value => { value.assignment_snapshot_sha256 = '0'.repeat(64); }, value => { value.publisher_id_sha256 = '0'.repeat(64); },
    value => { value.exact_current_HA_label_sha256 = hash(CONTINUED_LABEL); },
  ]) { const changed = structuredClone(B); damage(changed); assert.throws(() => assessContinuationStart(baseline, A, changed)); }
});

test('continuation final readback requires six relative increments, both v4 rows and the unchanged empty HA tuple', () => {
  const album = assignmentState(assignmentInput(ALBUM_TAG, 3)).assignment;
  const playlist = assignmentState(assignmentInput(PLAYLIST_TAG, 3)).assignment;
  const page = { status: 200, body: { total: 2, revision: 8, assignments: [album, playlist] } };
  const current = guards(); current.publication.body.desired_version = 8; current.publication.body.actual.active_revision = null;
  const guard = assessManagerGuards(current.publication, current.playback), baseline = { publisher_id_sha256: guard.publisher_id_sha256 };
  assert.equal(assessContinuationFinal(page, guard, baseline).successful_assignment_increments, 6);
  for (const damage of [
    value => { value.page.body.revision = 7; }, value => { value.page.body.assignments[0].version = 3; },
    value => { value.page.body.assignments[1].shuffle = false; }, value => { value.guard.active_revision = 0; },
    value => { value.guard.automatic_publication = 'enabled'; }, value => { value.guard.publisher_id_sha256 = '0'.repeat(64); },
    value => { value.page.body.assignments[0].ha_tag_id = ALBUM_TAG.trim(); },
  ]) { const changed = structuredClone({ page, guard }); damage(changed); assert.throws(() => assessContinuationFinal(changed.page, changed.guard, baseline)); }
});

test('resume3 accepts only the exact populated starting state in both actual contexts, preserving history', () => {
  const value = partialState();
  const album = assignmentState(assignmentInput(ALBUM_TAG, 2));
  value.values.album.body = album; value.values.page.body.assignments = [structuredClone(album.assignment)];
  value.values.page.body.revision = 3; value.values.name.body.name = CONTINUED_LABEL;
  value.guards.saved_revision = 3; value.guards.recovery_guard = false;
  const publisher = value.guards.publisher_id_sha256;
  const A = assessKnownPartialState(value.values, value.guards, publisher, 'current3');
  const baseline = { publisher_id_sha256: publisher, assignment_snapshot_sha256: A.assignment_snapshot_sha256 };
  assert.equal(assessContinuationStart(baseline, A, structuredClone(A), 'current3').saved_revision, 3);
  assert.throws(() => assessKnownPartialState(partialState().values, partialState().guards, publisher, 'current3'));
  for (const damage of [
    value => { value.values.page.body.revision = 4; }, value => { value.values.album.body.assignment.enabled = false; },
    value => { value.values.album.body.assignment.shuffle = true; }, value => { value.values.playlist.body.version = 1; },
    value => { value.values.name.body.name = RENAMED_LABEL; }, value => { value.guards.recovery_guard = true; },
    value => { value.guards.dispatch = 'enabled'; }, value => { value.guards.queued_jobs = 1; },
    value => { value.guards.active_revision = 0; }, value => { value.guards.publisher_id_sha256 = '0'.repeat(64); },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => assessKnownPartialState(changed.values, changed.guards, publisher, 'current3')); }
  for (const damage of [
    value => { value.saved_revision = 2; }, value => { value.album.enabled = false; },
    value => { value.assignment_snapshot_sha256 = '0'.repeat(64); }, value => { value.publisher_id_sha256 = '0'.repeat(64); },
  ]) { const B = structuredClone(A); damage(B); assert.throws(() => assessContinuationStart(baseline, A, B, 'current3')); }
});

test('resume3 final state requires exactly revision9/album5/playlist4 and all unchanged last-good guards', () => {
  const page = { status: 200, body: { revision: 9, total: 2, assignments: [
    assignmentState(assignmentInput(ALBUM_TAG, 4)).assignment,
    assignmentState(assignmentInput(PLAYLIST_TAG, 3)).assignment] } };
  const value = guards(); value.publication.body.desired_version = 9; value.publication.body.actual.active_revision = null;
  const guard = { ...assessManagerGuards(value.publication, value.playback), recovery_guard: false };
  const baseline = { publisher_id_sha256: guard.publisher_id_sha256 };
  assert.equal(assessContinuationFinal(page, guard, baseline, 'current3').successful_assignment_increments, 6);
  for (const damage of [
    value => { value.page.body.revision = 8; }, value => { value.page.body.assignments[0].version = 4; },
    value => { value.page.body.assignments[0].enabled = false; }, value => { value.page.body.assignments[1].version = 3; },
    value => { value.guard.recovery_guard = true; }, value => { value.guard.automatic_publication = 'enabled'; },
    value => { value.guard.active_checksum = '0'.repeat(64); }, value => { value.guard.publisher_id_sha256 = '0'.repeat(64); },
  ]) { const changed = structuredClone({ page, guard }); damage(changed); assert.throws(() => assessContinuationFinal(changed.page, changed.guard, baseline, 'current3')); }
});

test('capture9 requires the exact populated two-row state in both contexts and ends at11/album7 with playlist4 untouched', () => {
  const album = assignmentState(assignmentInput(ALBUM_TAG, 4)), playlist = assignmentState(assignmentInput(PLAYLIST_TAG, 3));
  const page = { status: 200, body: { revision: 9, total: 2, assignments: [album.assignment, playlist.assignment] } };
  const guard = { ...partialState().guards, saved_revision: 9, recovery_guard: false };
  const values = { page, album: { status: 200, body: album }, playlist: { status: 200, body: playlist },
    name: { status: 200, body: { tag_key: hash(ALBUM_TAG), state: 'current', name: CONTINUED_LABEL } } };
  const A = assessKnownPartialState(values, guard, guard.publisher_id_sha256, 'current9');
  const baseline = { publisher_id_sha256: guard.publisher_id_sha256, assignment_snapshot_sha256: A.assignment_snapshot_sha256 };
  assert.equal(assessContinuationStart(baseline, A, structuredClone(A), 'current9').saved_revision, 9);
  assert.equal(A.playlist_absent, false); assert.equal(A.playlist_version, 4);
  assert.equal(A.playlist_snapshot_sha256, hash(JSON.stringify(playlist)));
  for (const damage of [
    value => { value.page.body.revision = 8; }, value => { value.page.body.total = 1; },
    value => { value.album.body.assignment.enabled = false; }, value => { value.album.body.assignment.version = 4; },
    value => { value.playlist.body.version = 3; }, value => { value.playlist.body.assignment.shuffle = false; },
    value => { value.name.body.name = RENAMED_LABEL; },
  ]) { const changed = structuredClone(values); damage(changed); assert.throws(() => assessKnownPartialState(changed, guard, guard.publisher_id_sha256, 'current9')); }
  for (const damage of [
    value => { value.playlist_absent = true; }, value => { value.playlist_snapshot_sha256 = '0'.repeat(64); },
    value => { value.assignment_snapshot_sha256 = '0'.repeat(64); },
  ]) { const B = structuredClone(A); damage(B); assert.throws(() => assessContinuationStart(baseline, A, B, 'current9')); }
  const final = structuredClone(page); final.body.revision = 11;
  final.body.assignments[0] = assignmentState(assignmentInput(ALBUM_TAG, 6)).assignment;
  const finalGuard = { ...guard, saved_revision: 11 };
  assert.equal(assessContinuationFinal(final, finalGuard, baseline, 'current9').successful_assignment_increments, 2);
  for (const damage of [
    value => { value.body.revision = 10; }, value => { value.body.assignments[0].version = 6; },
    value => { value.body.assignments[1].version = 5; }, value => { value.body.assignments[1].shuffle = false; },
  ]) { const changed = structuredClone(final); damage(changed); assert.throws(() => assessContinuationFinal(changed, finalGuard, baseline, 'current9')); }
});

test('this diagnostic binds exactly its known two registered tags without adopting a later third-tag scenario', () => {
  const value = { status: 200, body: { registry_available: true, stale: false, total: 2,
    tags: [ALBUM_TAG, PLAYLIST_TAG].map(ha_tag_id => ({ ha_tag_id, tag_key: hash(ha_tag_id), state: 'registered' })) } };
  assert.equal(assessDiagnosticInventory(value).known_registered_tags, 2);
  for (const damage of [
    value => { value.body.total = 3; }, value => { value.body.tags.push({ ...value.body.tags[0] }); },
    value => { value.body.tags[0].ha_tag_id = ALBUM_TAG.trim(); },
    value => { value.body.tags[1].state = 'pending_discovery'; }, value => { value.body.stale = true; },
  ]) { const changed = structuredClone(value); damage(changed); assert.throws(() => assessDiagnosticInventory(changed)); }
});

test('manager imports/help need no frontend dependency and invalid local paths disclose no private data', () => {
  const root = mkdtempSync(join(tmpdir(), 'jukelet62-manager-import-'));
  try {
    const directory = dirname(fileURLToPath(import.meta.url));
    for (const name of ['browser_manager.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs', 'fetch_clone.mjs']) copyFileSync(join(directory, name), join(root, name));
    mkdirSync(join(root, 'empty'));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(root, 'browser_manager.mjs')).href)});`], { cwd: join(root, 'empty'), encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
    const help = spawnSync(process.execPath, [join(root, 'browser_manager.mjs'), '--help'], { encoding: 'utf8' }); assert.equal(help.status, 0);
    const failed = spawnSync(process.execPath, [join(root, 'browser_manager.mjs'), 'manager-edit', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(failed.stderr, ''); assert.equal(JSON.parse(failed.stdout).stage, 'local_inputs');
    assert.equal(failed.stdout.includes('SYNTHETIC_PRIVATE'), false);
    const diagnostic = spawnSync(process.execPath, [join(root, 'browser_manager.mjs'), 'manager-diagnose', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8' });
    assert.equal(diagnostic.status, 1); assert.equal(JSON.parse(diagnostic.stdout).stage, 'local_inputs');
    const events = diagnostic.stderr.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.every(row => row.event === 'native_progress' && row.stage === 'local_inputs'));
    assert.equal((diagnostic.stdout + diagnostic.stderr).includes('SYNTHETIC_PRIVATE'), false);
    const continuation = spawnSync(process.execPath, [join(root, 'browser_manager.mjs'), 'manager-continue', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8' });
    assert.equal(continuation.status, 1); assert.equal(JSON.parse(continuation.stdout).stage, 'local_inputs');
    assert.ok(continuation.stderr.trim().split('\n').map(line => JSON.parse(line)).every(row => row.event === 'native_progress'));
    assert.equal((continuation.stdout + continuation.stderr).includes('SYNTHETIC_PRIVATE'), false);
    const resume3 = spawnSync(process.execPath, [join(root, 'browser_manager.mjs'), 'manager-resume3', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8' });
    assert.equal(resume3.status, 1); assert.equal(JSON.parse(resume3.stdout).phase, 'manager-resume3');
    assert.equal(JSON.parse(resume3.stdout).stage, 'local_inputs');
    assert.ok(resume3.stderr.trim().split('\n').map(line => JSON.parse(line)).every(row => row.event === 'native_progress'));
    assert.equal((resume3.stdout + resume3.stderr).includes('SYNTHETIC_PRIVATE'), false);
    const capture9 = spawnSync(process.execPath, [join(root, 'browser_manager.mjs'), 'manager-capture9', '/tmp/SYNTHETIC_PRIVATE_A', '/tmp/SYNTHETIC_PRIVATE_B'], { encoding: 'utf8' });
    assert.equal(capture9.status, 1); assert.equal(JSON.parse(capture9.stdout).phase, 'manager-capture9');
    assert.equal(JSON.parse(capture9.stdout).stage, 'local_inputs');
    assert.ok(capture9.stderr.trim().split('\n').map(line => JSON.parse(line)).every(row => row.event === 'native_progress'));
    assert.equal((capture9.stdout + capture9.stderr).includes('SYNTHETIC_PRIVATE'), false);
  } finally { rmSync(root, { recursive: true }); }
});
