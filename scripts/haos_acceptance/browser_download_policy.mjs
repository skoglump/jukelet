/** Download policy core and inert protocol controls; import performs no I/O. */
import { createHash } from 'node:crypto';
import { MINIMUM_CORE_VERSION, reviewedCoreProfile } from './browser_core_profiles.mjs';
const minimumCases = reviewedCoreProfile(MINIMUM_CORE_VERSION).cases;
export const CASES = Object.freeze({ positive: minimumCases.positive, wrongframe: minimumCases.wrongframe });
export const INERT_BYTES = Buffer.from('Jukelet DLP2 inert download prerequisite\n\u2603\n', 'utf8');
const HASH = data => createHash('sha256').update(data).digest('hex');
const GUID = /^[A-Za-z0-9_-]{1,128}$/;
const safeGuid = event => {
  try { const value = Object.getOwnPropertyDescriptor(event ?? {}, 'guid')?.value;
    return typeof value === 'string' && GUID.test(value) ? value : undefined;
  } catch { return undefined; }
};
const FIXTURE = 'jukelet-m5-issue62-matrix-kvm';
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const requireValue = (value, code = 'invalid_observation') => { if (!value) fail(code); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(action, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('deadline'), { code: 'deadline' })), ms);
  })]); } finally { clearTimeout(timer); }
}

// Exactly one fixed inert document and child frame, in the existing owned page.
async function prepareDocument(page) {
  return page.evaluate(() => new Promise(resolve => {
    const child = document.createElement('iframe'); child.id = 'dlp2-inert-child';
    child.srcdoc = '<!doctype html><title>DLP2 inert child</title>';
    child.onload = () => resolve(true); document.body.replaceChildren(child);
  }));
}
async function makeBlob(page, child, bytes) {
  return page.evaluate(({ child, bytes }) => {
    const target = child ? document.getElementById('dlp2-inert-child').contentWindow : window;
    return target.URL.createObjectURL(new target.Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
  }, { child, bytes: [...bytes] });
}
async function clickBlob(page, child, url) {
  return page.evaluate(({ child, url }) => {
    const target = child ? document.getElementById('dlp2-inert-child').contentWindow : window;
    const anchor = target.document.createElement('a'); anchor.href = url;
    anchor.download = 'inert.bin'; target.document.body.append(anchor); anchor.click(); anchor.remove(); return true;
  }, { child, url });
}

/** Trusted adapter seam for deterministic protocol controls, not a CLI-provided driver. */
export async function runInertProbe(adapter, timing = {}) {
  const CASES = reviewedCoreProfile(adapter.coreVersion ?? MINIMUM_CORE_VERSION).cases;
  const operationMs = timing.operationMs ?? 3000, eventMs = timing.eventMs ?? 4000;
  const quietMs = timing.quietMs ?? 750, lateMs = timing.lateMs ?? 1250;
  const diagnostics = { trace_limit: 192, trace: [], trace_overflow: 0, first_failure: null,
    commands_started: 0, commands_settled: 0, pending_before_verdict: null, raw_pending_before_verdict: null };
  const report = { fixture: FIXTURE, phase: 'external-download-policy-inert', result: 'FAIL',
    scope: 'inert_prerequisite_only', permission_scope: 'DEFAULT_CONTEXT', ha_acceptance: 'NOT_RUN', process_exit: 'REQUIRES_ROOT_READBACK', default_context: false,
    controlling_session_events: false, allowance_windows: 0, attempts: 0, begins: 0, progress: 0,
    denied_received_bytes: [], deny_commands: 0, deny_restored: false, handlers_removed: false,
    cleanup_confirmed: false, diagnostics };
  const { session, pageSession, page, context, browser, verifySource, filesystem, artifact, cleanup } = adapter;
  let stage = 'setup', issue = null, intent = null, listening = false, closed = false, frameId, childId, allowanceTimer;
  let positiveGuid, wrongGuid, fencing = false, frameListening = false, scenarioComplete = false;
  const records = new Map(), pending = new Set(), rawPending = new Set(), urls = [], canceled = new Set();
  const failures = new Set(['invalid_observation', 'closed', 'source_unverified', 'directory_unverified', 'source_changed',
    'event_overflow', 'unexpected_begin', 'wrong_frame', 'duplicate_begin', 'malformed_event', 'frame_changed',
    'unknown_guid', 'duplicate_terminal', 'invalid_progress_state', 'invalid_progress_bytes', 'nonmonotonic_progress',
    'unexpected_completion', 'wrong_destination', 'positive_canceled', 'teardown_begin', 'teardown_progress',
    'window_limit', 'allowance_expired', 'unfinished_intent', 'invalid_blob', 'intent_failed', 'deny_not_effective',
    'unexpected_artifact', 'context_mismatch', 'frame_unverified', 'positive_incomplete', 'artifact_mismatch',
    'artifact_unverified', 'wrongframe_not_rejected', 'wrongframe_artifact', 'cleanup_unconfirmed', 'artifact_changed',
    'deadline', 'command_refused', 'command_timeout', 'command_limit', 'unsettled_command', 'trace_overflow',
    'revoke_failed', 'detach_failed', 'cleanup_failed', 'directory_close_failed', 'observation_unverified']);
  const field = (value, name) => {
    try { return Object.getOwnPropertyDescriptor(value ?? {}, name)?.value; } catch { return undefined; }
  };
  const trace = (kind, details = {}) => {
    if (diagnostics.trace.length < diagnostics.trace_limit) diagnostics.trace.push({ kind, phase: stage, intent: report.attempts, ...details });
    else {
      diagnostics.trace_overflow = Math.min(255, diagnostics.trace_overflow + 1); issue ??= 'trace_overflow';
      diagnostics.first_failure ??= { code: 'trace_overflow', phase: stage, intent: report.attempts }; report.failure_stage ??= stage;
    }
  };
  const recordFailure = (error, fallback = 'observation_unverified') => {
    const candidate = typeof error === 'string' ? error : field(error, 'code');
    const code = failures.has(candidate) ? candidate : fallback;
    issue ??= code; report.failure_stage ??= stage;
    diagnostics.first_failure ??= { code, phase: stage, intent: report.attempts };
    trace('failure', { code });
  };
  const operation = action => bounded(action, operationMs);
  // Every explicit CDP command is tracked from request through bounded settlement.
  // Raw protocol settlement is separate: a timed-out promise cannot certify PASS.
  const command = (label, action, details = {}) => {
    requireValue(diagnostics.commands_started < 64, 'command_limit');
    const ordinal = ++diagnostics.commands_started; rawPending.add(ordinal);
    trace('command', { label, ordinal, ...details, outcome: 'requested' });
    const raw = Promise.resolve().then(action).then(value => { rawPending.delete(ordinal); return value; }, error => {
      rawPending.delete(ordinal); throw error;
    });
    const settled = operation(() => raw).then(value => {
      trace('command', { label, ordinal, ...details, outcome: 'fulfilled' }); return value;
    }, error => {
      const timeout = field(error, 'code') === 'deadline';
      trace('command', { label, ordinal, ...details, outcome: timeout ? 'timeout' : 'refused' });
      recordFailure(timeout ? 'command_timeout' : 'command_refused'); throw error;
    }).finally(() => { diagnostics.commands_settled += 1; pending.delete(settled); });
    pending.add(settled); return settled;
  };
  const deny = async () => {
    await command('deny', () => session.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }));
    report.deny_commands += 1; report.deny_restored = true; clearTimeout(allowanceTimer);
  };
  const track = promise => {
    const settled = promise.catch(error => recordFailure(error)).finally(() => pending.delete(settled));
    pending.add(settled);
  };
  const fence = guid => {
    if (!fencing) { fencing = true; report.deny_restored = false; track(deny()); }
    if (typeof guid === 'string' && GUID.test(guid) && !canceled.has(guid) && canceled.size < 8) {
      canceled.add(guid); track(command('cancel', () => session.send('Browser.cancelDownload', { guid }), { guid_sha256: HASH(guid) }));
    }
  };
  const verifyOwner = () => {
    try { verifySource(); } catch { fail('source_unverified'); }
    try { filesystem.verify(); } catch { fail('directory_unverified'); }
    requireValue(browser.contexts().length === 1 && browser.contexts()[0] === context
      && context.pages().length === 1 && context.pages()[0] === page && page.context() === context
      && page.url() === 'about:blank' && !page.isClosed(), 'source_changed');
  };
  const active = () => { requireValue(!closed, 'closed'); verifyOwner(); if (issue) fail(issue); };
  const onBegin = event => {
    const guid = safeGuid(event);
    trace('begin', { guid_sha256: guid ? HASH(guid) : null, known_guid: records.has(guid),
      frame_match: field(event, 'frameId') === (intent?.kind === 'wrongframe' ? childId : frameId),
      url_match: !!intent && field(event, 'url') === intent.url });
    try {
      requireValue(!closed, 'teardown_begin'); active(); requireValue(++report.begins <= 8, 'event_overflow');
      requireValue(event && typeof event.guid === 'string' && GUID.test(event.guid)
        && !records.has(event.guid) && intent && event.url === intent.url
        && event.suggestedFilename === 'inert.bin', 'unexpected_begin');
      requireValue(event.frameId === (intent.kind === 'wrongframe' ? childId : frameId), 'wrong_frame');
      const record = { kind: intent.kind, guid: event.guid, terminal: null, received: 0, peak: 0 };
      records.set(event.guid, record); requireValue(!intent.record, 'duplicate_begin'); intent.record = record;
      report.controlling_session_events = true;
      if (intent.kind === 'wrongframe') { intent.rejected = true; fence(event.guid); }
    } catch (error) { recordFailure(error, 'malformed_event'); fence(guid); }
  };
  const onFrameChange = () => { recordFailure('frame_changed'); fence(); };
  const onProgress = event => {
    const guid = safeGuid(event), record = records.get(guid), state = field(event, 'state');
    const bytes = name => { const value = field(event, name); return Number.isFinite(value) && value >= 0 && value <= INERT_BYTES.length ? value : null; };
    trace('progress', { guid_sha256: guid ? HASH(guid) : null, known_guid: !!record,
      state: ['inProgress', 'completed', 'canceled'].includes(state) ? state : 'unknown',
      received_bytes: bytes('receivedBytes'), total_bytes: bytes('totalBytes'), peak_bytes: record?.peak ?? null });
    try {
      requireValue(!!record, 'unknown_guid'); requireValue(!record.terminal, 'duplicate_terminal');
      requireValue(!closed, 'teardown_progress'); active(); requireValue(++report.progress <= 64, 'event_overflow');
      requireValue(['inProgress', 'completed', 'canceled'].includes(event.state), 'invalid_progress_state');
      requireValue(Number.isFinite(event.receivedBytes) && Number.isFinite(event.totalBytes)
        && event.receivedBytes >= 0 && event.receivedBytes <= INERT_BYTES.length
        && event.totalBytes >= 0 && event.totalBytes <= INERT_BYTES.length, 'invalid_progress_bytes');
      // Chromium156 cancellation discards partial state and may reset to0.
      // In-progress/completed observations remain monotonic against the retained peak.
      requireValue(event.state === 'canceled' || event.receivedBytes >= record.peak, 'nonmonotonic_progress');
      record.received = event.receivedBytes; record.peak = Math.max(record.peak, event.receivedBytes);
      if (event.state === 'completed') {
        // Permission is context-wide. Only this declared inert child control may
        // complete before its cancel command; it remains rejected, never export.
        const inertNegative = record.kind === 'wrongframe' && intent?.record === record
          && intent.rejected && canceled.has(event.guid);
        requireValue((record.kind === 'positive' || inertNegative) && event.receivedBytes === INERT_BYTES.length
          && event.totalBytes === INERT_BYTES.length, 'unexpected_completion');
        if (event.filePath !== undefined) requireValue(event.filePath === `${CASES[record.kind]}/${event.guid}`, 'wrong_destination');
        record.terminal = 'completed'; fence();
      } else if (event.state === 'canceled') {
        requireValue(record.kind !== 'positive', 'positive_canceled'); record.terminal = 'canceled';
      }
    } catch (error) { recordFailure(error, 'malformed_event'); fence(guid); }
  };
  const drainCommands = () => bounded(async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  }, operationMs + 50);
  const drain = async () => { await drainCommands(); active(); };
  const grant = async which => {
    active(); requireValue(report.allowance_windows < 2 && ['positive', 'wrongframe'].includes(which), 'window_limit');
    report.allowance_windows += 1; report.deny_restored = false;
    allowanceTimer = setTimeout(() => { recordFailure('allowance_expired'); fence(intent?.record?.guid); }, Math.min(5000, operationMs + eventMs));
    await command(which === 'positive' ? 'grant_positive' : 'grant_wrongframe', () => session.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', downloadPath: CASES[which], eventsEnabled: true }));
    active();
  };
  const waitTerminal = async () => {
    await bounded(async () => { while (!intent?.record?.terminal) { active(); await pause(5); } }, eventMs);
    await drain();
  };
  const quiet = async ms => { await operation(() => pause(ms)); await drain(); };
  const newIntent = async (kind, child = false) => {
    active(); requireValue(!intent || !intent.record || intent.record.terminal, 'unfinished_intent');
    const url = await operation(() => adapter.makeBlob ? adapter.makeBlob(child) : makeBlob(page, child, INERT_BYTES));
    requireValue(typeof url === 'string' && /^blob:null\/[a-f0-9-]{36}$/.test(url), 'invalid_blob');
    urls.push({ child, url }); fencing = false; intent = { kind, url, record: null, rejected: false }; return url;
  };
  const click = async child => {
    active(); report.attempts += 1; trace('intent', { control: intent.kind });
    requireValue(await operation(() => adapter.clickBlob ? adapter.clickBlob(child, intent.url) : clickBlob(page, child, intent.url)) === true, 'intent_failed');
    active();
  };
  const denyControl = async (kind, delay = quietMs) => {
    stage = kind; await deny(); await newIntent(kind); await click(false); await waitTerminal(); await quiet(delay);
    requireValue(intent.record?.terminal === 'canceled', 'deny_not_effective');
    report.denied_received_bytes.push(intent.record.received);
    requireValue(filesystem.entries('wrongframe').length === 0, 'unexpected_artifact');
    const entries = filesystem.entries('positive');
    requireValue(entries.length === (report.artifact ? 1 : 0)
      && (!report.artifact || HASH(entries[0]) === report.artifact.guid_sha256), 'deny_not_effective');
  };
  const observeArtifact = (guid, which = 'positive') => {
    try { return artifact({ directory: CASES[which], guid, expectedBytes: Buffer.from(INERT_BYTES) }); }
    catch { fail('artifact_unverified'); }
  };
  try {
    for (const ms of [operationMs, eventMs, quietMs, lateMs]) requireValue(Number.isSafeInteger(ms) && ms > 0 && ms <= 5000);
    active(); session.on('Browser.downloadWillBegin', onBegin); session.on('Browser.downloadProgress', onProgress); listening = true;
    stage = 'initial_deny'; await deny(); active();
    stage = 'default_context';
    requireValue((await command('contexts', () => session.send('Target.getBrowserContexts'))).browserContextIds.length === 0, 'context_mismatch');
    const target = (await command('target', () => pageSession.send('Target.getTargetInfo'))).targetInfo;
    const targets = (await command('targets', () => session.send('Target.getTargets'))).targetInfos;
    requireValue(target && target.type === 'page' && target.url === 'about:blank' && !target.openerId
      && targets.filter(value => value.type === 'page').length === 1
      && targets.some(value => value.targetId === target.targetId && value.browserContextId === target.browserContextId), 'context_mismatch');
    report.default_context = true; report.target_sha256 = HASH(target.targetId);
    stage = 'document'; await command('enable', () => pageSession.send('Page.enable'));
    requireValue(await operation(() => adapter.prepareDocument ? adapter.prepareDocument() : prepareDocument(page)) === true);
    const tree = (await command('frames', () => pageSession.send('Page.getFrameTree'))).frameTree;
    requireValue(tree?.frame?.url === 'about:blank' && !tree.frame.parentId && tree.childFrames?.length === 1
      && tree.childFrames[0].frame.url === 'about:srcdoc'
      && tree.childFrames[0].frame.parentId === tree.frame.id, 'frame_unverified');
    frameId = tree.frame.id; childId = tree.childFrames[0].frame.id;
    requireValue(typeof frameId === 'string' && frameId.length > 0 && typeof childId === 'string' && childId !== frameId, 'frame_unverified');
    for (const event of ['Page.frameNavigated', 'Page.frameAttached', 'Page.frameDetached']) pageSession.on(event, onFrameChange);
    frameListening = true; report.frame_sha256 = HASH(frameId); report.child_frame_sha256 = HASH(childId);
    await denyControl('deny_before');
    stage = 'positive'; await newIntent('positive'); await grant('positive');
    active(); await click(false); await waitTerminal(); requireValue(intent.record.terminal === 'completed', 'positive_incomplete');
    await deny(); await quiet(quietMs); positiveGuid = intent.record.guid;
    const receipt = observeArtifact(positiveGuid);
    requireValue(receipt?.verified === true && receipt.bytes === INERT_BYTES.length
      && receipt.sha256 === HASH(INERT_BYTES) && receipt.guid_sha256 === HASH(positiveGuid), 'artifact_mismatch');
    report.artifact = { verified: true, bytes: INERT_BYTES.length, sha256: HASH(INERT_BYTES), guid_sha256: HASH(positiveGuid) };
    await denyControl('second_deny'); await denyControl('late_deny', lateMs);
    stage = 'wrongframe'; await newIntent('wrongframe', true); await grant('wrongframe');
    active(); await click(true); await waitTerminal();
    requireValue(intent.rejected && ['canceled', 'completed'].includes(intent.record.terminal), 'wrongframe_not_rejected');
    await deny(); await quiet(quietMs); wrongGuid = intent.record.guid;
    const cancelSettled = diagnostics.trace.some(row => row.kind === 'command' && row.label === 'cancel'
      && row.guid_sha256 === HASH(wrongGuid) && row.outcome === 'fulfilled');
    requireValue(cancelSettled && canceled.has(wrongGuid), 'wrongframe_not_rejected');
    report.wrongframe = { rejected: true, terminal: intent.record.terminal,
      cancellation_effective: intent.record.terminal === 'canceled', cancel_command_settled: true,
      disposition: 'PENDING_PRODUCER_CLOSE', accepted_as_export: false };
    if (intent.record.terminal === 'canceled') requireValue(filesystem.entries('wrongframe').length === 0, 'wrongframe_artifact');
    else {
      const rejected = observeArtifact(wrongGuid, 'wrongframe');
      requireValue(rejected?.verified === true && rejected.bytes === INERT_BYTES.length
        && rejected.sha256 === HASH(INERT_BYTES) && rejected.guid_sha256 === HASH(wrongGuid), 'artifact_mismatch');
      Object.assign(report.wrongframe, { bytes: rejected.bytes, sha256: rejected.sha256, guid_sha256: rejected.guid_sha256 });
    }
    report.wrongframe_rejected = true; active(); scenarioComplete = true;
  } catch (error) { recordFailure(error); }
  finally {
    closed = true; clearTimeout(allowanceTimer);
    stage = 'teardown_deny'; try { await deny(); } catch (error) { report.deny_restored = false; recordFailure(error); }
    stage = 'teardown_revoke';
    try { if (urls.length && !page.isClosed()) await operation(() => adapter.revoke ? adapter.revoke() : page.evaluate(values => {
      for (const { child, url } of values) {
        const target = child ? document.getElementById('dlp2-inert-child')?.contentWindow : window;
        if (target) target.URL.revokeObjectURL(url);
      }
    }, urls)); } catch (error) { recordFailure(error, 'revoke_failed'); }
    try { verifyOwner(); } catch (error) { recordFailure(error); }
    stage = 'teardown_detach';
    try { if (listening) { session.off('Browser.downloadWillBegin', onBegin); session.off('Browser.downloadProgress', onProgress); }
      if (frameListening) for (const event of ['Page.frameNavigated', 'Page.frameAttached', 'Page.frameDetached']) pageSession.off(event, onFrameChange);
      report.handlers_removed = true;
    } catch (error) { recordFailure(error, 'detach_failed'); }
    // No handler can create a new command after successful detachment. Join ALL
    // tracked commands now, including those started during asynchronous revoke.
    stage = 'teardown_drain'; trace('pending', { count: pending.size, raw_count: rawPending.size });
    try { await drainCommands(); } catch (error) { recordFailure(error); }
    if (pending.size || rawPending.size) recordFailure('unsettled_command');
    try { verifyOwner(); } catch (error) { recordFailure(error); }
    stage = 'normal_cleanup';
    try {
      const result = await bounded(() => cleanup(), 11000);
      report.cleanup_confirmed = result?.cleanup_confirmed === true && result.owned_page_close_completed === true
        && result.native_disconnect_confirmed === true && result.sdk_disconnected === true;
      requireValue(report.cleanup_confirmed, 'cleanup_unconfirmed');
    } catch (error) { recordFailure(error, 'cleanup_failed'); }
    stage = 'post_close';
    try {
      if (scenarioComplete && !issue) {
        requireValue(report.cleanup_confirmed && report.deny_restored && report.handlers_removed, 'cleanup_unconfirmed');
        filesystem.verify();
        if (report.wrongframe.terminal === 'canceled') {
          requireValue(filesystem.entries('wrongframe').length === 0, 'wrongframe_artifact');
          report.wrongframe.disposition = 'REJECTED_NO_ARTIFACT';
        } else {
          const rejected = observeArtifact(wrongGuid, 'wrongframe');
          requireValue(rejected?.verified === true && rejected.bytes === report.wrongframe.bytes
            && rejected.sha256 === report.wrongframe.sha256 && rejected.guid_sha256 === report.wrongframe.guid_sha256, 'artifact_changed');
          report.wrongframe.disposition = 'REJECTED_QUARANTINED';
        }
        report.wrongframe.post_close_verified = true;
        const receipt = observeArtifact(positiveGuid);
        requireValue(receipt?.verified === true && receipt.bytes === report.artifact.bytes
          && receipt.sha256 === report.artifact.sha256 && receipt.guid_sha256 === report.artifact.guid_sha256, 'artifact_changed');
        report.post_close_artifact_verified = true;
      }
    } catch (error) { recordFailure(error); }
    stage = 'directory_close'; try { filesystem.close(); } catch (error) { recordFailure(error, 'directory_close_failed'); }
    stage = 'verdict'; diagnostics.pending_before_verdict = pending.size; diagnostics.raw_pending_before_verdict = rawPending.size;
    trace('pending', { count: pending.size, raw_count: rawPending.size });
    if (pending.size || rawPending.size || diagnostics.commands_started !== diagnostics.commands_settled) recordFailure('unsettled_command');
    if (scenarioComplete && !issue && report.post_close_artifact_verified && report.cleanup_confirmed
      && report.handlers_removed && report.deny_restored) report.result = 'PASS';
  }
  return Object.freeze(report);
}

// The real case shares R20's bounded command/raw-settlement ledger, finite safe
// trace, cancellation reset/retained peak and terminal-after-drain rules. It has
// one permission window; the inert runner above retains its five control intents.
export const EXPORT_CASE = minimumCases.export;
const data = (value, key) => { try { return Object.getOwnPropertyDescriptor(value ?? {}, key)?.value; } catch { return undefined; } };
export async function createExportDownloadPolicy({ session, verify, isTransportConnected, onFailure = () => {}, operationMs = 3000,
  producerCloseMs = 10000, coreVersion = MINIMUM_CORE_VERSION }) {
  const EXPORT_CASE = reviewedCoreProfile(coreVersion).cases.export;
  requireValue(Number.isSafeInteger(operationMs) && operationMs > 0 && operationMs <= 5000);
  requireValue(typeof isTransportConnected === 'function');
  requireValue(Number.isSafeInteger(producerCloseMs) && producerCloseMs > 0 && producerCloseMs <= 10000);
  let failure = null, phase = 'bootstrap', closed = false, closing, revoking, denyRestored = false, windowTimer, record, bound;
  let producerClosing = false, producerClosed = false, closeRequested = false, producerSettled = false, deliveryBarrier = false;
  let started = 0, settled = 0, overflow = 0, frameListening = false, firstFailure = null;
  const pending = new Set(), rawPending = new Set(), canceled = new Set(), trace = [];
  const note = (kind, details = {}) => {
    if (trace.length < 192) trace.push({ kind, phase, ...details });
    else { overflow = Math.min(255, overflow + 1); failure ??= 'trace_overflow';
      firstFailure ??= { code: 'trace_overflow', phase, intent: 1 }; onFailure(); }
  };
  const failPolicy = code => { failure ??= code; firstFailure ??= { code, phase, intent: 1 }; note('failure', { code }); onFailure(); };
  const transportLive = () => { try { return isTransportConnected() === true; } catch { return false; } };
  const command = (label, method, args) => {
    if (!transportLive()) { failPolicy('transport_closed'); return Promise.reject(new Error('download_transport_closed')); }
    if (started >= 64) { failPolicy('command_limit'); return Promise.reject(new Error('download_policy_failed')); }
    const ordinal = ++started; rawPending.add(ordinal); note('command', { label, ordinal, outcome: 'requested' });
    const raw = Promise.resolve().then(() => {
      if (!transportLive()) throw new Error('download_transport_closed');
      return session.send(method, args);
    }).finally(() => rawPending.delete(ordinal));
    const task = bounded(() => raw, operationMs).then(value => {
      note('command', { label, ordinal, outcome: 'fulfilled' }); return value;
    }, error => {
      const outcome = data(error, 'code') === 'deadline' ? 'timeout' : 'refused';
      note('command', { label, ordinal, outcome }); failPolicy(outcome === 'timeout' ? 'command_timeout' : 'command_refused');
      throw new Error('download_command_failed');
    }).finally(() => { settled++; pending.delete(task); });
    pending.add(task); return task;
  };
  const track = promise => { const task = promise.catch(() => {}).finally(() => pending.delete(task)); pending.add(task); };
  const deny = async () => {
    denyRestored = false;
    await command('deny', 'Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    denyRestored = true; clearTimeout(windowTimer);
  };
  const fence = guid => {
    // DENY is settled before normal producer shutdown. Keep detecting attempts,
    // but do not send commands into a transport that may already be closing.
    if (producerClosing || closed || !transportLive()) return;
    track(deny());
    if (typeof guid === 'string' && GUID.test(guid) && !canceled.has(guid) && canceled.size < 8) {
      canceled.add(guid); track(command('cancel', 'Browser.cancelDownload', { guid }));
    }
  };
  const check = () => {
    requireValue(!closed && !failure, 'download_policy_failed');
    try { verify(); bound?.verify(); } catch { failPolicy('source_changed'); fence(record?.guid); throw new Error('download_source_failed'); }
  };
  const onBegin = event => {
    const guid = safeGuid(event);
    note('begin', { guid_sha256: guid ? HASH(guid) : null, frame_match: data(event, 'frameId') === bound?.frameId });
    try {
      requireValue(!producerClosing, 'teardown_begin');
      check(); requireValue(phase === 'armed' && !record && guid, 'unexpected_begin');
      requireValue(data(event, 'frameId') === bound.frameId, 'wrong_frame');
      requireValue(data(event, 'suggestedFilename') === 'jukelet-export-v1.json', 'wrong_filename');
      const url = data(event, 'url');
      requireValue(typeof url === 'string' && /^blob:https:\/\/127\.0\.0\.1:18223\/[a-f0-9-]{36}$/.test(url), 'invalid_blob');
      record = { guid, received: 0, peak: 0, terminal: null };
    } catch (error) { failPolicy(data(error, 'code') ?? 'malformed_event'); fence(guid); }
  };
  const onProgress = event => {
    const guid = safeGuid(event), state = data(event, 'state'), received = data(event, 'receivedBytes'), total = data(event, 'totalBytes');
    const count = value => Number.isFinite(value) && value >= 0 && value <= 8192 ? value : null;
    note('progress', { guid_sha256: guid ? HASH(guid) : null,
      state: ['inProgress', 'completed', 'canceled'].includes(state) ? state : 'unknown', received_bytes: count(received),
      total_bytes: count(total), peak_bytes: record?.peak ?? null });
    try {
      requireValue(!producerClosing, 'teardown_progress');
      check(); requireValue(record && record.guid === guid && !record.terminal, 'unknown_or_terminal_guid');
      requireValue(['inProgress', 'completed', 'canceled'].includes(state) && count(received) !== null && count(total) !== null, 'invalid_progress');
      requireValue(state === 'canceled' || received >= record.peak, 'nonmonotonic_progress');
      record.received = received; record.peak = Math.max(record.peak, received);
      if (state === 'canceled') { record.terminal = state; fail('positive_canceled'); }
      if (state === 'completed') {
        requireValue(received > 0 && total === received, 'incomplete_download');
        const path = data(event, 'filePath'); requireValue(path === undefined || path === `${EXPORT_CASE}/${guid}`, 'wrong_destination');
        record.terminal = state; fence();
      }
    } catch (error) { failPolicy(data(error, 'code') ?? 'malformed_event'); fence(guid); }
  };
  const frameNames = ['Page.frameNavigated', 'Page.frameAttached', 'Page.frameDetached', 'Page.navigatedWithinDocument'];
  const frameObservers = new Map(frameNames.map(name => [name, () => {
    // Closing the requested owned page normally detaches its frames. Navigation
    // and attachment remain failures; no new export authority exists here.
    if (producerClosing && name === 'Page.frameDetached') return;
    failPolicy('frame_changed'); fence(record?.guid);
  }]));
  const evidence = () => ({ failure, phase, core_version: coreVersion, deny_restored: denyRestored, handlers_removed: closed,
    producer_close_requested: closeRequested, producer_close_settled: producerSettled, producer_closed: producerClosed, delivery_barrier_passed: deliveryBarrier,
    allowance_windows: bound ? 1 : 0, completed: record?.terminal === 'completed', trace_limit: 192,
    trace: trace.map(row => ({ ...row })), trace_overflow: overflow, first_failure: firstFailure ? { ...firstFailure } : null, commands_started: started, commands_settled: settled,
    pending_before_verdict: pending.size, raw_pending_before_verdict: rawPending.size });
  const drain = () => bounded(async () => { while (pending.size) await Promise.allSettled([...pending]); }, operationMs + 50);
  const api = {
    check, evidence, invalidate() { failPolicy('external_authority_lost'); fence(record?.guid); },
    async arm(binding) {
      check(); requireValue(phase === 'bootstrap' && !bound && binding.pageSession && binding.frameId, 'window_limit');
      bound = binding; bound.verify();
      for (const [name, observer] of frameObservers) binding.pageSession.on(name, observer);
      frameListening = true; phase = 'armed';
      windowTimer = setTimeout(() => { failPolicy('allowance_expired'); fence(record?.guid); }, 5000);
      denyRestored = false;
      await command('grant', 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: EXPORT_CASE, eventsEnabled: true }); check();
    },
    async completed(bytes) {
      await bounded(async () => { while (!record?.terminal) { check(); await pause(5); } }, 5000);
      await drain(); check();
      requireValue(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 8192 && record.received === bytes.length, 'byte_count_mismatch');
      phase = 'settled'; return record.guid;
    },
    revoke() {
      return revoking ??= (async () => {
        phase = 'revoking'; clearTimeout(windowTimer);
        try { verify(); bound?.verify(); } catch { failPolicy('source_changed'); }
        try { await deny(); } catch { /* Failure retained in ledger. */ }
        try { await drain(); } catch { failPolicy('deadline'); }
        if (pending.size || rawPending.size || started !== settled) failPolicy('unsettled_command');
        // This is the last live-source check, while observers are still active.
        try { verify(); bound?.verify(); } catch { failPolicy('source_changed'); }
        phase = 'revoked'; return evidence();
      })();
    },
    close(options = {}) {
      return closing ??= (async () => {
        await api.revoke();
        try {
          requireValue(typeof options.closeProducer === 'function' && typeof options.isProducerOpen === 'function'
            && typeof options.isProducerClosed === 'function', 'producer_close_unconfirmed');
          try { verify(); bound?.verify(); } catch { failPolicy('source_changed'); }
          requireValue(transportLive() && options.isProducerOpen() === true && options.isProducerClosed() === false, 'producer_closed_early');
          // Authority is revoked before this callback. Download observation stays
          // live through requested page close, native disconnect and SDK drain.
          producerClosing = true; closeRequested = true; phase = 'producer_close';
          const deadline = performance.now() + producerCloseMs;
          const remainingClose = () => {
            const remaining = Math.floor(deadline - performance.now()); requireValue(remaining > 0, 'deadline'); return remaining;
          };
          let closeOutcome;
          try { closeOutcome = options.closeProducer(); } catch (error) { producerSettled = true; throw error; }
          const producerTask = Promise.resolve(closeOutcome).then(value => { producerSettled = true; return value; }, error => {
            producerSettled = true; throw error;
          });
          producerTask.catch(() => {}); // A deadline may precede raw callback rejection.
          const result = await bounded(() => producerTask, remainingClose());
          remainingClose();
          requireValue(result?.cleanup_confirmed === true && result.native_disconnect_confirmed === true
            && result.sdk_disconnected === true
            && (result.owned_page_close_completed === true || result.protocol_close_confirmed === true), 'producer_close_unconfirmed');
          requireValue(options.isProducerClosed() === true, 'producer_close_unconfirmed');
          // A native transport close orders its preceding messages. Leave the
          // observers installed through one local delivery turn as well.
          await bounded(() => new Promise(resolve => setImmediate(resolve)), remainingClose());
          remainingClose();
          requireValue(options.isProducerClosed() === true, 'producer_close_unconfirmed');
          deliveryBarrier = true; producerClosed = true;
        } catch { failPolicy('producer_close_unconfirmed'); }
        try { await drain(); } catch { failPolicy('deadline'); }
        if (pending.size || rawPending.size || started !== settled) failPolicy('unsettled_command');
        // No await or live-source callback follows disposal: either the normal
        // producer close is proven, or this verdict is already terminal FAIL.
        try {
          session.off('Browser.downloadWillBegin', onBegin); session.off('Browser.downloadProgress', onProgress);
          if (frameListening) for (const [name, observer] of frameObservers) bound.pageSession.off(name, observer);
          closed = true;
        } catch { failPolicy('detach_failed'); }
        phase = 'closed'; return evidence();
      })();
    },
  };
  session.on('Browser.downloadWillBegin', onBegin); session.on('Browser.downloadProgress', onProgress);
  try {
    check(); await deny(); check();
    const contexts = await command('contexts', 'Target.getBrowserContexts'); check();
    requireValue(Array.isArray(contexts.browserContextIds) && contexts.browserContextIds.length === 0, 'context_mismatch');
    return api;
  }
  catch { await api.close(); throw new Error('download_default_deny_unverified'); }
}
