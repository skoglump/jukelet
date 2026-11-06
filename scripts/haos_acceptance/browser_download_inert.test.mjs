import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, writeFileSync, chmodSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { ARTIFACT_ROOT, verifyDownloadArtifact } from './download_artifact.mjs';
const { runInertProbe, readInputsBounded, CASES, INERT_BYTES } = await import(process.env.DLP2_TEST_SOURCE ?? './browser_download_inert.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const timing = { operationMs: 80, eventMs: 40, quietMs: 5, lateMs: 10 };
function fixture(options = {}) {
  const session = new EventEmitter(), calls = [], entries = { positive: [], wrongframe: [] };
  let behavior = 'unset', path, count = 0, cleanup = 0, closed = false, verifies = 0;
  const completed = new Set(), artifactCalls = [];
  session.send = async (method, params) => {
    calls.push([method, params]);
    if (options.hang === method) return new Promise(() => {});
    if (options.refuse === method && (!options.refuseBehavior || options.refuseBehavior === params?.behavior)) throw new Error('PRIVATE token /path');
    if (method === 'Browser.setDownloadBehavior') { behavior = params.behavior; path = params.downloadPath; }
    if (method === 'Target.getBrowserContexts') return { browserContextIds: options.contextMismatch ? ['foreign'] : [] };
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'page1', type: 'page', url: 'about:blank' }] };
    if (method === 'Browser.cancelDownload') { if (options.cancelFailure) throw new Error('PRIVATE cancel');
      if (completed.has(params.guid)) return {};
      queueMicrotask(() => session.emit('Browser.downloadProgress', { guid: params.guid, state: 'canceled', receivedBytes: 0, totalBytes: 0 })); }
    return {};
  };
  const page = { url: () => options.urlMismatch ? 'https://private.invalid/' : 'about:blank', isClosed: () => closed, context: () => context };
  const context = { pages: () => [page] }, browser = { contexts: () => [context] };
  const pageSession = new EventEmitter(); pageSession.send = async method => method === 'Target.getTargetInfo'
    ? { targetInfo: { targetId: 'page1', type: 'page', url: 'about:blank' } }
    : { frameTree: { frame: { id: 'main', url: 'about:blank' }, childFrames: [{ frame: { id: 'child', parentId: 'main', url: 'about:srcdoc' } }] } };
  const adapter = { session, pageSession, page, context, browser,
    verifySource() { verifies += 1; if (options.stale && verifies > options.stale) throw new Error('PRIVATE stale'); },
    filesystem: { verify() { if (options.directoryChanged && count >= 2) throw new Error('PRIVATE directory'); },
      entries: name => [...entries[name]], close() { if (options.closeFailure) throw new Error('PRIVATE close'); } },
    artifact({ guid, directory, expectedBytes }) { artifactCalls.push({ directory, closed });
      assert.equal(directory, guid === 'guid-5' ? CASES.wrongframe : CASES.positive); assert.deepEqual(expectedBytes, INERT_BYTES);
      if (guid === 'guid-5' && options.quarantineRefused) throw new Error('PRIVATE artifact metadata');
      return { verified: true, bytes: INERT_BYTES.length, sha256: options.wrongArtifact || (options.postCloseChange && closed) ? '0'.repeat(64) : hash(INERT_BYTES), guid_sha256: hash(guid), ...(options.receiptInjection ? { private: 'PRIVATE token' } : {}) }; },
    async cleanup() { cleanup += 1; closed = true; return { cleanup_confirmed: !options.cleanupFailure,
      owned_page_close_completed: true, native_disconnect_confirmed: true, sdk_disconnected: true }; },
    prepareDocument: async () => true, makeBlob: async () => `blob:null/00000000-0000-0000-0000-${String(++count).padStart(12, '0')}`,
    revoke: async () => { if (options.revokeFailure) throw new Error('PRIVATE revoke'); },
    async clickBlob(child, url) {
      const guid = `guid-${count}`;
      if (options.frameNavigated && count === 2) pageSession.emit('Page.frameNavigated', { frame: { id: 'main', url: 'about:blank' } });
      const begin = { guid, frameId: child ? 'child' : 'main', url, suggestedFilename: 'inert.bin' };
      if (options.wrongFrame && count === 2) begin.frameId = 'foreign';
      if (options.wrongURL && count === 2) begin.url = 'blob:null/foreign';
      if (options.missingWrongframe && child) return true;
      if (options.silentDeny && behavior === 'deny') return true;
      if (options.malformedGetter && count === 2) {
        const bad = {}; Object.defineProperty(bad, 'guid', { get() { throw new Error('PRIVATE getter'); } });
        session.emit('Browser.downloadWillBegin', bad); return true;
      }
      if (options.unknownProgress && count === 2) { session.emit('Browser.downloadProgress', { guid: 'unknown', state: 'completed', receivedBytes: 1, totalBytes: 1 }); return true; }
      if (options.missing && count === 2) return true;
      if (options.late && count === 2) { setTimeout(() => session.emit('Browser.downloadWillBegin', begin), 60); return true; }
      session.emit('Browser.downloadWillBegin', begin);
      if (options.eventFlood && count === 2) for (let n = 0; n < 100; n++) session.emit('Browser.downloadWillBegin', begin);
      if (options.duplicate && count === 2) session.emit('Browser.downloadWillBegin', begin);
      if (behavior === 'deny' && !child && !options.ineffectiveDeny) {
        session.emit('Browser.downloadProgress', { guid, state: 'canceled', receivedBytes: options.deniedInMemoryBytes ? INERT_BYTES.length : 0, totalBytes: INERT_BYTES.length }); return true;
      }
      if (child) {
        if (options.wrongframeArtifact || options.completeWrongframe) entries.wrongframe.push(guid);
        if (options.completeWrongframe) {
          completed.add(guid); session.emit('Browser.downloadProgress', { guid, state: 'completed', receivedBytes: 45, totalBytes: 45 });
        }
        return true;
      }
      assert.equal(path, CASES.positive); entries.positive.push(guid);
      session.emit('Browser.downloadProgress', { guid, state: options.progressFailure ? 'canceled' : 'completed',
        receivedBytes: INERT_BYTES.length, totalBytes: INERT_BYTES.length,
        ...(options.wrongDestination ? { filePath: '/private/elsewhere' } : {}) });
      if (options.restoreFailure) options.refuse = 'Browser.setDownloadBehavior', options.refuseBehavior = 'deny';
      return true;
    } };
  return { adapter, calls, artifactCalls, get cleanup() { return cleanup; }, get closed() { return closed; } };
}

test('one own-frame completion and intentional wrongframe rejection use exactly two fixed windows', async () => {
  const value = fixture(), result = await runInertProbe(value.adapter, timing);
  assert.equal(result.result, 'PASS'); assert.equal(result.allowance_windows, 2); assert.equal(result.attempts, 5);
  assert.equal(result.controlling_session_events, true); assert.equal(result.deny_restored, true);
  assert.equal(result.wrongframe_rejected, true); assert.equal(result.ha_acceptance, 'NOT_RUN');
  assert.equal(value.cleanup, 1); assert.equal(value.closed, true);
  assert.deepEqual(value.calls.filter(([name, params]) => name === 'Browser.setDownloadBehavior' && params.behavior === 'allowAndName')
    .map(([, params]) => params), [CASES.positive, CASES.wrongframe].map(downloadPath => ({ behavior: 'allowAndName', downloadPath, eventsEnabled: true })));
  assert.equal(value.adapter.session.listenerCount('Browser.downloadWillBegin'), 0);
  assert.equal(value.adapter.session.listenerCount('Browser.downloadProgress'), 0);
  assert.equal(value.calls.some(([, params]) => params && 'browserContextId' in params), false);
});
for (const [label, options] of [
  ['hung initial DENY', { hang: 'Browser.setDownloadBehavior' }],
  ['refused initial DENY', { refuse: 'Browser.setDownloadBehavior', refuseBehavior: 'deny' }],
  ['refused grant', { refuse: 'Browser.setDownloadBehavior', refuseBehavior: 'allowAndName' }],
  ['nondefault context', { contextMismatch: true }], ['source URL mismatch', { urlMismatch: true }],
  ['frame document changed after source proof', { frameNavigated: true }],
  ['DENY ineffective', { ineffectiveDeny: true }], ['missing wrongframe event', { missingWrongframe: true }],
  ['malformed event getter', { malformedGetter: true }], ['unknown progress GUID', { unknownProgress: true }],
  ['event flood', { eventFlood: true }],
  ['missing controlling-session event', { missing: true }], ['late controlling-session event', { late: true }],
  ['duplicate GUID', { duplicate: true }], ['unexpected source frame', { wrongFrame: true }],
  ['unexpected Blob URL', { wrongURL: true }], ['positive progress failure', { progressFailure: true }],
  ['wrong progress destination', { wrongDestination: true }], ['wrong artifact bytes receipt', { wrongArtifact: true }],
  ['source lease lost', { stale: 10 }], ['directory lease lost', { directoryChanged: true }],
  ['DENY restoration refusal', { restoreFailure: true }], ['wrongframe cancellation refusal', { cancelFailure: true }],
  ['post-close byte change', { postCloseChange: true }],
  ['wrongframe leftover', { wrongframeArtifact: true }], ['normal cleanup unconfirmed', { cleanupFailure: true }],
  ['URL cleanup failure', { revokeFailure: true }], ['directory FD close failure', { closeFailure: true }],
]) test(`${label} fails closed with bounded private output and cleanup`, async () => {
  const value = fixture(options), started = performance.now(), result = await runInertProbe(value.adapter, timing);
  assert.equal(result.result, 'FAIL'); assert.ok(performance.now() - started < 1000);
  assert.ok(result.allowance_windows <= 2); assert.equal(value.cleanup, 1);
  assert.ok(value.calls.filter(([method]) => method === 'Browser.cancelDownload').length <= 8);
  assert.ok(value.calls.filter(([method]) => method === 'Browser.setDownloadBehavior').length < 20);
  assert.equal(value.adapter.session.listenerCount('Browser.downloadWillBegin'), 0);
  assert.equal(value.adapter.session.listenerCount('Browser.downloadProgress'), 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|token|private\.invalid|\/private|blob:null|guid-[0-9]|00000000-0000-0000-0000-/);
  assert.equal(value.calls.at(-1)[0], 'Browser.setDownloadBehavior'); assert.equal(value.calls.at(-1)[1].behavior, 'deny');
});

test('receipt projections exclude additional adapter fields', async () => {
 const value = fixture({ receiptInjection: true }), result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'PASS'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|token/);
 assert.equal(result.post_close_artifact_verified, true);
});

test('DENY without cancellation events cannot certify an unknown default destination', async () => {
 const value = fixture({ silentDeny: true }), result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'FAIL'); assert.equal(result.allowance_windows, 0); assert.equal(result.attempts, 1);
});

for (const args of [[], ['--help'], ['/private/arbitrary.json'], ['https://private.invalid/'], ['one', 'two']]) {
 test(`CLI refuses unapproved shape ${JSON.stringify(args)}`, () => {
   const result = spawnSync(process.execPath, [fileURLToPath(new URL('./browser_download_inert.mjs', import.meta.url)), ...args], { encoding: 'utf8', timeout: 2000 });
   assert.equal(result.status, 1); assert.equal(result.stderr, '');
   const report = JSON.parse(result.stdout); assert.equal(report.result, 'FAIL'); assert.equal(report.failure_stage, 'preflight');
   assert.doesNotMatch(result.stdout, /private\.invalid|\/private|arbitrary/);
 });
}

function inputFixture(mode) {
 const path = '/tmp/jukelet-issue62-matrix-control/acceptance.json';
 const document = { origin: 'https://127.0.0.1:18223', candidate: { digest: 'SYNTHETIC' }, bridge: { hash: 'SYNTHETIC' }, certificate_file: 'fixture.crt' };
 const bytes = Buffer.from(JSON.stringify(document)), certificate = Buffer.from('PUBLIC CERTIFICATE FIXTURE');
 let reads = 0, runs = 0;
 const options = {
  read(name, limit, flags) {
    if (name === path) { assert.equal(limit, 16384); reads++; return mode === 'substitution' && reads > 1 ? Buffer.from('{}') : bytes; }
    assert.equal(name, '/tmp/jukelet-issue62-matrix-control/fixture.crt'); assert.equal(limit, 32768); assert.deepEqual(flags, { certificate: true }); return certificate;
  },
  run(command, args, settings) {
    runs++; assert.equal(command, 'python3'); assert.deepEqual(args, ['-B', '-m', 'scripts.haos_acceptance', 'validate', path]);
    assert.deepEqual(settings, { cwd: '/home/sebastian/Projects/jukelet', encoding: 'utf8', maxBuffer: 65536, timeout: 5000 });
    return { status: mode === 'timeout' ? null : mode === 'refusal' ? 1 : 0,
      ...(mode === 'timeout' ? { error: new Error('PRIVATE timeout') } : {}),
      stdout: JSON.stringify({ result: 'PASS_LOCAL_INPUT', fixture: 'jukelet-m5-issue62-matrix-kvm', origin: document.origin,
        declared_candidate: mode === 'mismatch' ? {} : document.candidate, declared_bridge: document.bridge }) };
  },
 };
 return { path, document, bytes, certificate, options, runs: () => runs };
}
test('bounded config loader preserves validator inputs, bytes/hash and public certificate only', () => {
 const value = inputFixture(), result = readInputsBounded(value.path, value.options);
 assert.deepEqual(result.document, value.document); assert.deepEqual(result.certificate, value.certificate);
 assert.equal(result.configuration_sha256, hash(value.bytes)); assert.equal(value.runs(), 1);
});
for (const mode of ['timeout', 'refusal', 'substitution', 'mismatch']) test(`config ${mode} is one-shot and private`, () => {
 const value = inputFixture(mode); assert.throws(() => readInputsBounded(value.path, value.options), /^Error: invalid_fixture_input$/);
 assert.equal(value.runs(), 1);
});

test('canceled DENY byte counts are observations, not proof that memory bytes reached disk', async () => {
 const value = fixture({ deniedInMemoryBytes: true }), result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'PASS'); assert.deepEqual(result.denied_received_bytes, [INERT_BYTES.length, INERT_BYTES.length, INERT_BYTES.length]);
});

// R20 source-backed semantic regressions; trusted synthetic adapter only.
test('R20 legal cancellation may reset received bytes after inProgress45', async () => {
 const value = fixture(), emit = value.adapter.session.emit.bind(value.adapter.session);
 value.adapter.session.emit = (name, event) => {
   const result = emit(name, event);
   if (name === 'Browser.downloadWillBegin' && event.guid === 'guid-5')
     emit('Browser.downloadProgress', { guid: event.guid, state: 'inProgress', receivedBytes: INERT_BYTES.length, totalBytes: INERT_BYTES.length });
   return result;
 };
 const result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'PASS'); assert.equal(result.wrongframe_rejected, true);
 assert.equal(result.attempts, 5); assert.equal(result.allowance_windows, 2);
 assert.equal(result.diagnostics.first_failure, null);
 const events = result.diagnostics.trace.filter(entry => entry.kind === 'progress' && entry.guid_sha256 === hash('guid-5'));
 assert.deepEqual(events.map(entry => [entry.state, entry.received_bytes]), [['inProgress', 45], ['canceled', 0]]);
 assert.equal(events.at(-1).peak_bytes, 45);
 assert.equal(result.diagnostics.pending_before_verdict, 0); assert.equal(result.diagnostics.raw_pending_before_verdict, 0);
 assert.equal(result.diagnostics.commands_started, result.diagnostics.commands_settled);
});
for (const mode of ['begin', 'unknown-progress', 'duplicate-completion', 'cancel-refused', 'cancel-refused-delayed', 'cancel-hung', 'delayed-begin']) {
 test(`R20 cleanup event remains authoritative: ${mode}`, async () => {
  const value = fixture(); let settled = false;
  const send = value.adapter.session.send.bind(value.adapter.session);
  value.adapter.session.send = async (method, params) => {
   if (method === 'Browser.cancelDownload' && params.guid === 'cleanup-unexpected' && mode.startsWith('cancel-')) {
    if (mode === 'cancel-hung') return new Promise(() => {});
    if (mode === 'cancel-refused-delayed') await new Promise(resolve => setTimeout(resolve, 20));
    settled = true; throw new Error('PRIVATE cancellation refused');
   }
   return send(method, params);
  };
  value.adapter.revoke = async () => {
   if (mode === 'delayed-begin') await new Promise(resolve => setTimeout(resolve, 5));
   if (mode === 'unknown-progress') value.adapter.session.emit('Browser.downloadProgress', { guid: 'cleanup-unknown', state: 'completed', receivedBytes: 45, totalBytes: 45 });
   else if (mode === 'duplicate-completion') value.adapter.session.emit('Browser.downloadProgress', { guid: 'guid-2', state: 'completed', receivedBytes: 45, totalBytes: 45 });
   else value.adapter.session.emit('Browser.downloadWillBegin', { guid: 'cleanup-unexpected', frameId: 'foreign', url: 'blob:null/foreign', suggestedFilename: 'inert.bin' });
  };
  const started = performance.now(), result = await runInertProbe(value.adapter, timing);
  assert.equal(result.result, 'FAIL'); assert.ok(performance.now() - started < 1000);
  if (mode === 'cancel-refused-delayed' || mode === 'cancel-refused') assert.equal(settled, true);
  assert.equal(result.handlers_removed, true); assert.equal(value.cleanup, 1);
  assert.ok(result.diagnostics.first_failure); assert.equal(result.diagnostics.pending_before_verdict, 0);
  assert.equal(result.diagnostics.commands_started, result.diagnostics.commands_settled);
  if (mode === 'cancel-hung') { assert.equal(result.diagnostics.raw_pending_before_verdict, 1);
    assert.ok(result.diagnostics.trace.some(entry => entry.kind === 'command' && entry.label === 'cancel' && entry.outcome === 'timeout')); }
  if (mode === 'cancel-refused-delayed') assert.ok(result.diagnostics.trace.some(entry => entry.kind === 'command' && entry.label === 'cancel' && entry.outcome === 'refused'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|blob:null|cleanup-unexpected|cleanup-unknown|guid-2|foreign/);
 });
}

for (const [mode, code] of [
 ['decreasing-inProgress', 'nonmonotonic_progress'], ['negative-canceled', 'invalid_progress_bytes'],
 ['oversized-canceled', 'invalid_progress_bytes'], ['invalid-total', 'invalid_progress_bytes'],
 ['unknown-state', 'invalid_progress_state'], ['duplicate-canceled', 'duplicate_terminal'],
 ['short-positive', 'unexpected_completion'], ['decreasing-positive', 'nonmonotonic_progress'],
]) test(`R20 strict progress neighbor: ${mode}`, async () => {
 const value = fixture(), emit = value.adapter.session.emit.bind(value.adapter.session);
 value.adapter.session.emit = (name, event) => {
  if (name === 'Browser.downloadWillBegin' && event.guid === 'guid-5' && mode === 'decreasing-inProgress') {
   const result = emit(name, event);
   emit('Browser.downloadProgress', { guid: event.guid, state: 'inProgress', receivedBytes: 45, totalBytes: 45 });
   emit('Browser.downloadProgress', { guid: event.guid, state: 'inProgress', receivedBytes: 44, totalBytes: 45 }); return result;
  }
  if (name === 'Browser.downloadProgress' && event.guid === 'guid-5') {
   if (mode === 'negative-canceled') return emit(name, { ...event, receivedBytes: -1 });
   if (mode === 'oversized-canceled') return emit(name, { ...event, receivedBytes: 46 });
   if (mode === 'invalid-total') return emit(name, { ...event, totalBytes: NaN });
   if (mode === 'unknown-state') return emit(name, { ...event, state: 'PRIVATE invalid-state' });
   if (mode === 'duplicate-canceled') { emit(name, event); return emit(name, event); }
  }
  if (name === 'Browser.downloadProgress' && event.guid === 'guid-2' && event.state === 'completed' && ['short-positive', 'decreasing-positive'].includes(mode)) {
   if (mode === 'decreasing-positive') emit(name, { ...event, state: 'inProgress' });
   return emit(name, { ...event, receivedBytes: 44 });
  }
  return emit(name, event);
 };
 const result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'FAIL'); assert.equal(result.diagnostics.first_failure.code, code);
 assert.doesNotMatch(JSON.stringify(result), /PRIVATE|blob:null|guid-[0-9]/);
});
test('R20 source ownership remains authoritative through revocation without events', async () => {
 const value = fixture();
 let revoked = false; value.adapter.verifySource = () => { if (revoked) throw new Error('PRIVATE source'); };
 value.adapter.revoke = async () => { revoked = true; };
 const result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'FAIL'); assert.equal(result.diagnostics.first_failure.code, 'source_unverified');
 assert.equal(value.cleanup, 1); assert.equal(result.handlers_removed, true);
});
test('R20 diagnostic trace is bounded and projects private event getters without invoking them', async () => {
 const value = fixture(); let getterCalls = 0;
 value.adapter.revoke = async () => {
  const event = {};
  for (const name of ['guid', 'state', 'receivedBytes', 'totalBytes', 'url', 'frameId']) Object.defineProperty(event, name, { get() { getterCalls++; throw new Error('PRIVATE getter'); } });
  for (let n = 0; n < 300; n++) value.adapter.session.emit('Browser.downloadProgress', event);
 };
 const result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'FAIL'); assert.equal(getterCalls, 0);
 assert.equal(result.diagnostics.trace.length, result.diagnostics.trace_limit); assert.ok(result.diagnostics.trace_overflow > 0);
 assert.doesNotMatch(JSON.stringify(result), /PRIVATE|getter|blob:null|guid-[0-9]/);
});

// Owner-approved R21: the context-wide allowance can finish an intentionally
// rejected inert child download before cancellation reaches Chromium.
test('R21 completed-before-cancel inert control is rejected and producer-fenced quarantine only', async () => {
 const value = fixture({ completeWrongframe: true }), result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'PASS');
 assert.equal(result.permission_scope, 'DEFAULT_CONTEXT');
 assert.equal(result.wrongframe_rejected, true);
 assert.deepEqual(result.wrongframe, { rejected: true, terminal: 'completed', cancellation_effective: false,
   cancel_command_settled: true, disposition: 'REJECTED_QUARANTINED', accepted_as_export: false,
   bytes: 45, sha256: hash(INERT_BYTES), guid_sha256: hash('guid-5'), post_close_verified: true });
 assert.deepEqual(value.artifactCalls.filter(row => row.directory === CASES.wrongframe).map(row => row.closed), [false, true]);
 assert.equal(result.diagnostics.first_failure, null);
 assert.equal(result.diagnostics.commands_started, result.diagnostics.commands_settled);
 assert.equal(result.diagnostics.raw_pending_before_verdict, 0);
 assert.doesNotMatch(JSON.stringify(result), /PRIVATE|blob:null|guid-5|write_prevented/);
});

test('R21 canceled child is rejected with an empty destination, not quarantined', async () => {
 const value = fixture(), result = await runInertProbe(value.adapter, timing);
 assert.equal(result.result, 'PASS');
 assert.deepEqual(result.wrongframe, { rejected: true, terminal: 'canceled', cancellation_effective: true,
   cancel_command_settled: true, disposition: 'REJECTED_NO_ARTIFACT', accepted_as_export: false, post_close_verified: true });
 assert.equal(value.artifactCalls.some(row => row.directory === CASES.wrongframe), false);
});
for (const mode of ['wrong-receipt', 'wrong-guid', 'wrong-count', 'post-close-change', 'refused', 'cancel-refused', 'cancel-hung', 'cleanup-unconfirmed', 'source-lost', 'deadline', 'wrong-frame', 'wrong-url', 'partial-progress', 'wrong-destination']) {
 test(`R21 completed inert rejection cannot pass ${mode}`, async () => {
  const value = fixture({ completeWrongframe: true, quarantineRefused: mode === 'refused', cancelFailure: mode === 'cancel-refused',
    hang: mode === 'cancel-hung' ? 'Browser.cancelDownload' : undefined, cleanupFailure: mode === 'cleanup-unconfirmed' });
  const artifact = value.adapter.artifact;
  value.adapter.artifact = options => {
    const receipt = artifact(options);
    if (options.directory !== CASES.wrongframe) return receipt;
    if (mode === 'wrong-receipt' || mode === 'post-close-change' && value.closed) return { ...receipt, sha256: '0'.repeat(64) };
    if (mode === 'wrong-guid') return { ...receipt, guid_sha256: '0'.repeat(64) };
    if (mode === 'wrong-count') return { ...receipt, bytes: 44 };
    return receipt;
  };
  if (mode === 'source-lost') { let valid = true;
    value.adapter.revoke = async () => { valid = false; };
    value.adapter.verifySource = () => { if (!valid) throw new Error('PRIVATE source'); };
  }
  const emit = value.adapter.session.emit.bind(value.adapter.session);
  value.adapter.session.emit = (name, event) => {
    if (event.guid === 'guid-5') {
      if (name === 'Browser.downloadWillBegin' && mode === 'wrong-frame') event = { ...event, frameId: 'foreign' };
      if (name === 'Browser.downloadWillBegin' && mode === 'wrong-url') event = { ...event, url: 'blob:null/foreign' };
      if (name === 'Browser.downloadProgress' && mode === 'deadline') return true;
      if (name === 'Browser.downloadProgress' && mode === 'partial-progress') event = { ...event, receivedBytes: 44 };
      if (name === 'Browser.downloadProgress' && mode === 'wrong-destination') event = { ...event, filePath: '/PRIVATE' };
    }
    return emit(name, event);
  };
  const result = await runInertProbe(value.adapter, timing);
  assert.equal(result.result, 'FAIL'); assert.ok(result.diagnostics.first_failure);
  assert.notEqual(result.wrongframe?.accepted_as_export, true);
  assert.notEqual(result.wrongframe?.post_close_verified, true);
  assert.equal(value.cleanup, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|blob:null|guid-5|foreign/);
 });
}
// Exercise the actual unchanged verifier at the inert policy boundary. These
// UUID cases contain synthetic bytes only; no native fixed case is created/read.
for (const mode of ['valid', 'wrong-bytes', 'wrong-name', 'file-mode', 'directory-mode', 'extra-entry', 'partial', 'symlink', 'hardlink', 'post-close-byte-change']) {
 test(`R21 quarantine requires actual secure exact filesystem proof: ${mode}`, async () => {
  for (const directory of [dirname(ARTIFACT_ROOT), ARTIFACT_ROOT]) {
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(directory);
    assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700);
  }
  const directory = `${ARTIFACT_ROOT}/r21-unit-${randomUUID()}`, path = `${directory}/guid-5`;
  mkdirSync(directory, { mode: 0o700 }); writeFileSync(path, INERT_BYTES, { mode: 0o600 });
  if (mode === 'wrong-bytes') writeFileSync(path, Buffer.alloc(45, 0x78));
  if (mode === 'wrong-name') { unlinkSync(path); writeFileSync(`${directory}/other`, INERT_BYTES, { mode: 0o600 }); }
  if (mode === 'file-mode') chmodSync(path, 0o644);
  if (mode === 'directory-mode') chmodSync(directory, 0o755);
  if (mode === 'extra-entry' || mode === 'partial') writeFileSync(`${path}.${mode === 'partial' ? 'crdownload' : 'extra'}`, INERT_BYTES, { mode: 0o600 });
  if (mode === 'symlink') { unlinkSync(path); symlinkSync('absent', path); }
  if (mode === 'hardlink') linkSync(path, `${directory}/other-link`);
  const value = fixture({ completeWrongframe: true }), artifact = value.adapter.artifact;
  value.adapter.artifact = options => {
    if (options.directory !== CASES.wrongframe) return artifact(options);
    if (mode === 'post-close-byte-change' && value.closed) writeFileSync(path, Buffer.alloc(45, 0x78));
    return verifyDownloadArtifact({ directory, guid: options.guid, expectedBytes: options.expectedBytes });
  };
  const result = await runInertProbe(value.adapter, timing);
  assert.equal(result.result, mode === 'valid' ? 'PASS' : 'FAIL');
  if (mode === 'valid') assert.equal(result.wrongframe.disposition, 'REJECTED_QUARANTINED');
  else assert.notEqual(result.wrongframe?.post_close_verified, true);
  assert.notEqual(result.wrongframe?.accepted_as_export, true);
  assert.doesNotMatch(JSON.stringify(result), /r21-unit-|guid-5|crdownload|invalid_download_artifact/);
 });
}
