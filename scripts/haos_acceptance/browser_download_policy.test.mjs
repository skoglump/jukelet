/** Synthetic protocol controls; no native browser or private inputs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as policy from './browser_download_policy.mjs';

test('export policy installs observers and effective DENY before any navigation', async () => {
  assert.equal(typeof policy.createExportDownloadPolicy, 'function');
  const { session, calls, closeOptions } = protocol();
  const value = await policy.createExportDownloadPolicy({ session, isTransportConnected: () => true, verify: () => {}, operationMs: 30 });
  assert.equal(session.listenerCount('Browser.downloadWillBegin'), 1);
  assert.deepEqual(calls[0], ['Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }]);
  await value.close(closeOptions); assert.equal(value.evidence().failure, null);
  assert.equal(value.evidence().raw_pending_before_verdict, 0);
});

const closeProof = () => ({ cleanup_confirmed: true, owned_page_close_completed: true, native_disconnect_confirmed: true, sdk_disconnected: true });
function protocol() {
  const session = new EventEmitter(), pageSession = new EventEmitter(), calls = [];
  session.send = async (name, args) => { calls.push([name, args]); return name === 'Target.getBrowserContexts' ? { browserContextIds: [] } : {}; };
  let producerClosed = false;
  const closeOptions = { closeProducer: async () => { producerClosed = true; return closeProof(); }, isProducerOpen: () => !producerClosed, isProducerClosed: () => producerClosed };
  return { session, pageSession, calls, closeOptions };
}
const begin = (value, frameId = 'app') => value.session.emit('Browser.downloadWillBegin', { guid: 'guid', frameId,
  url: 'blob:https://127.0.0.1:18223/11111111-2222-3333-4444-555555555555', suggestedFilename: 'jukelet-export-v1.json' });
for (const kind of ['refused', 'hung']) test(`initial DENY ${kind} cannot yield an armed authority`, async () => {
  const f = protocol(); f.session.send = () => kind === 'hung' ? new Promise(() => {}) : Promise.reject(new Error('PRIVATE secret'));
  await assert.rejects(policy.createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: () => {}, operationMs: 15 }), /^Error: download_default_deny_unverified$/);
  assert.equal(f.session.listenerCount('Browser.downloadWillBegin'), 0);
});
test('unexpected bootstrap download is denied/canceled before arm and remains a failure', async () => {
  const f = protocol(), value = await policy.createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: () => {}, operationMs: 20 });
  begin(f); const report = await value.close(f.closeOptions); assert.ok(report.failure);
  assert.ok(f.calls.some(([name]) => name === 'Browser.cancelDownload'));
  assert.equal(report.raw_pending_before_verdict, 0); assert.doesNotMatch(JSON.stringify(report), /blob:|guid"/);
});
for (const kind of ['begin', 'progress', 'cancel-refused', 'cancel-hung']) test(`late teardown ${kind} cannot supply PASS`, async () => {
  const f = protocol(), value = await policy.createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: () => {}, operationMs: 20 });
  let injected = false;
  f.session.send = async (name, args) => {
    f.calls.push([name, args]);
    if (!injected && name === 'Browser.setDownloadBehavior' && args.behavior === 'deny') {
      injected = true;
      if (kind === 'progress') f.session.emit('Browser.downloadProgress', { guid: 'unknown', state: 'canceled', receivedBytes: 0, totalBytes: 0 });
      else begin(f);
    }
    if (name === 'Browser.cancelDownload') {
      if (kind === 'cancel-refused') throw new Error('PRIVATE cancel');
      if (kind === 'cancel-hung') return new Promise(() => {});
    }
    return {};
  };
  const report = await value.close(f.closeOptions); assert.ok(report.failure);
  assert.equal(report.handlers_removed, true);
  if (kind === 'cancel-hung') assert.ok(report.raw_pending_before_verdict > 0);
  else assert.equal(report.raw_pending_before_verdict, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|unknown"|blob:/);
});
test('wrong-frame and source loss fail without sharing authority with the Core parent', async () => {
  const f = protocol(); let valid = true;
  const value = await policy.createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: () => assert.equal(valid, true), operationMs: 20 });
  await value.arm({ pageSession: f.pageSession, frameId: 'app', verify: () => {} }); begin(f, 'core'); valid = false;
  const report = await value.close(f.closeOptions); assert.ok(report.failure); assert.equal(report.raw_pending_before_verdict, 0);
});
test('malformed event accessors are never evaluated in diagnostic projection', async () => {
  const f = protocol(), value = await policy.createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: () => {}, operationMs: 20 });
  const event = {}; let gets = 0;
  for (const key of ['guid', 'url', 'frameId', 'suggestedFilename']) Object.defineProperty(event, key, { get() { gets++; throw new Error('PRIVATE'); } });
  f.session.emit('Browser.downloadWillBegin', event); const report = await value.close(f.closeOptions);
  assert.equal(gets, 0); assert.ok(report.failure); assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

for (const terminal of ['completed', 'canceled']) test(`R21 REAL parent attempt remains terminal FAIL even ${terminal}`, async () => {
 const f = protocol(), value = await policy.createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: () => {}, operationMs: 20 });
 await value.arm({ pageSession: f.pageSession, frameId: 'app', verify: () => {} });
 begin(f, 'core');
 f.session.emit('Browser.downloadProgress', { guid: 'guid', state: terminal, receivedBytes: terminal === 'completed' ? 45 : 0, totalBytes: 45 });
 await assert.rejects(value.completed(Buffer.alloc(45)));
 const result = await value.close(f.closeOptions);
 assert.equal(result.failure, 'wrong_frame'); assert.equal(result.completed, false);
 assert.ok(f.calls.some(([method]) => method === 'Browser.cancelDownload'));
 assert.equal(result.raw_pending_before_verdict, 0);
});
test('R21 REAL extra parent after accepted own completion still invalidates whole case', async () => {
 const f = protocol(), value = await policy.createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: () => {}, operationMs: 20 });
 await value.arm({ pageSession: f.pageSession, frameId: 'app', verify: () => {} }); begin(f);
 f.session.emit('Browser.downloadProgress', { guid: 'guid', state: 'completed', receivedBytes: 45, totalBytes: 45 });
 assert.equal(await value.completed(Buffer.alloc(45)), 'guid');
 f.session.emit('Browser.downloadWillBegin', { guid: 'extra', frameId: 'core', url: 'blob:PRIVATE', suggestedFilename: 'jukelet-export-v1.json' });
 const result = await value.close(f.closeOptions); assert.equal(result.failure, 'unexpected_begin');
 assert.equal(result.raw_pending_before_verdict, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|extra"|blob:/);
});


test('R22 producer-live late parent attempt cannot escape final shutdown observation', async () => {
  const f = protocol(); let producerClosed = false, closing = false, injected = false;
  const late = () => {
    injected = true;
    f.session.emit('Browser.downloadWillBegin', { guid: 'late-parent', frameId: 'core',
      url: 'blob:https://127.0.0.1:18223/22222222-2222-3333-4444-555555555555', suggestedFilename: 'jukelet-export-v1.json' });
    f.session.emit('Browser.downloadProgress', { guid: 'late-parent', state: 'canceled', receivedBytes: 0, totalBytes: 0 });
  };
  const value = await policy.createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: () => {
    assert.equal(producerClosed, false);
    // Exact reviewer schedule: the producer remains alive during final live verification.
    if (closing && !injected && f.session.listenerCount('Browser.downloadWillBegin') === 0) late();
  }, operationMs: 30 });
  await value.arm({ pageSession: f.pageSession, frameId: 'app', verify: () => assert.equal(producerClosed, false) });
  begin(f); f.session.emit('Browser.downloadProgress', { guid: 'guid', state: 'completed', receivedBytes: 45, totalBytes: 45 });
  assert.equal(await value.completed(Buffer.alloc(45)), 'guid'); closing = true;
  const result = await value.close({ closeProducer: async () => {
    if (!injected) late(); producerClosed = true;
    return { cleanup_confirmed: true, owned_page_close_completed: true, native_disconnect_confirmed: true, sdk_disconnected: true };
  }, isProducerOpen: () => !producerClosed, isProducerClosed: () => producerClosed });
  assert.equal(injected, true);
  assert.notEqual(result.failure, null);
  assert.equal(result.raw_pending_before_verdict, 0);
  assert.equal(result.commands_started, result.commands_settled);
});

async function completedPolicy(hooks = {}) {
  const f = protocol(); let connected = true, producerClosed = false, valid = true;
  const value = await policy.createExportDownloadPolicy({ session: f.session,
    isTransportConnected: () => connected, verify: () => { assert.equal(valid, true); assert.equal(connected, true); hooks.verify?.(); },
    operationMs: 25, producerCloseMs: hooks.producerCloseMs ?? 250 });
  await value.arm({ pageSession: f.pageSession, frameId: 'app', verify: () => assert.equal(valid, true) }); begin(f);
  f.session.emit('Browser.downloadProgress', { guid: 'guid', state: 'completed', receivedBytes: 45, totalBytes: 45 });
  assert.equal(await value.completed(Buffer.alloc(45)), 'guid');
  const finish = () => { connected = false; producerClosed = true; };
  const closeOptions = { closeProducer: async () => { finish(); return closeProof(); },
    isProducerOpen: () => connected && !producerClosed, isProducerClosed: () => !connected && producerClosed };
  return { ...f, value, closeOptions, finish, sourceLost: () => { valid = false; }, disconnect: () => { connected = false; } };
}
const lateParent = f => {
  f.session.emit('Browser.downloadWillBegin', { guid: 'late-parent', frameId: 'core',
    url: 'blob:https://127.0.0.1:18223/22222222-2222-3333-4444-555555555555', suggestedFilename: 'jukelet-export-v1.json' });
  f.session.emit('Browser.downloadProgress', { guid: 'late-parent', state: 'canceled', receivedBytes: 0, totalBytes: 0 });
};

test('R22 revocation leaves detection active until independently proven normal producer close', async () => {
  const f = await completedPolicy(), revoked = await f.value.revoke();
  assert.equal(revoked.failure, null); assert.equal(revoked.deny_restored, true); assert.equal(revoked.handlers_removed, false);
  assert.equal(revoked.producer_close_requested, false); assert.equal(revoked.producer_closed, false);
  assert.equal(f.session.listenerCount('Browser.downloadWillBegin'), 1);
  const result = await f.value.close(f.closeOptions);
  assert.equal(result.failure, null); assert.equal(result.producer_closed, true); assert.equal(result.delivery_barrier_passed, true);
  assert.equal(result.handlers_removed, true); assert.equal(result.raw_pending_before_verdict, 0);
  assert.equal(f.session.listenerCount('Browser.downloadWillBegin'), 0); assert.equal(f.pageSession.listenerCount('Page.frameDetached'), 0);
  assert.deepEqual(await f.value.close(f.closeOptions), result);
});
test('R22 canceled no-file parent after revocation remains observed and terminal', async () => {
  const f = await completedPolicy(); await f.value.revoke(); lateParent(f);
  const result = await f.value.close(f.closeOptions); assert.notEqual(result.failure, null);
  assert.ok(f.calls.some(([name, args]) => name === 'Browser.cancelDownload' && args.guid === 'late-parent'));
  assert.equal(result.raw_pending_before_verdict, 0); assert.equal(result.producer_closed, true);
});
for (const schedule of ['last-live-verification', 'page-close-pending', 'native-disconnect', 'delivery-turn', 'last-closed-predicate']) {
  test(`R22 late canceled parent at ${schedule} cannot supply final acceptance`, async () => {
    let f, closing = false, injected = false;
    const inject = () => { if (!injected) { injected = true; lateParent(f); } };
    f = await completedPolicy({ verify: () => { if (closing && schedule === 'last-live-verification') inject(); } });
    await f.value.revoke(); const before = f.calls.length; let closedQueries = 0; closing = true;
    const result = await f.value.close({ ...f.closeOptions, closeProducer: async () => {
      if (schedule === 'page-close-pending') { inject(); await Promise.resolve(); }
      f.finish();
      if (schedule === 'native-disconnect') queueMicrotask(inject);
      if (schedule === 'delivery-turn') setImmediate(inject);
      return closeProof();
    }, isProducerClosed: () => {
      const state = f.closeOptions.isProducerClosed();
      if (++closedQueries === 3 && schedule === 'last-closed-predicate') inject();
      return state;
    } });
    assert.equal(injected, true); assert.notEqual(result.failure, null); assert.equal(result.producer_closed, true);
    assert.equal(result.commands_started, result.commands_settled); assert.equal(result.raw_pending_before_verdict, 0);
    if (schedule !== 'last-live-verification') assert.equal(f.calls.length, before);
    assert.doesNotMatch(JSON.stringify(result), /late-parent|blob:|22222222/);
  });
}
for (const name of ['Page.frameNavigated', 'Page.frameAttached', 'Page.navigatedWithinDocument']) {
  test(`R22 ${name} during requested close remains a failure`, async () => {
    const f = await completedPolicy();
    const result = await f.value.close({ ...f.closeOptions, closeProducer: async () => {
      f.pageSession.emit(name, {}); f.finish(); return closeProof();
    } });
    assert.equal(result.failure, 'frame_changed'); assert.equal(result.raw_pending_before_verdict, 0);
  });
}
test('R22 only requested close may detach the existing page frames', async () => {
  const f = await completedPolicy();
  const result = await f.value.close({ ...f.closeOptions, closeProducer: async () => {
    f.pageSession.emit('Page.frameDetached', { frameId: 'app' }); f.finish(); return closeProof();
  } });
  assert.equal(result.failure, null); assert.equal(result.producer_closed, true);
  const early = await completedPolicy(); early.pageSession.emit('Page.frameDetached', { frameId: 'app' });
  assert.equal((await early.value.close(early.closeOptions)).failure, 'frame_changed');
});
for (const kind of ['missing-proof', 'refused', 'hung', 'false-cleanup', 'no-native-disconnect', 'no-sdk-disconnect', 'no-page-or-protocol', 'not-closed']) {
  test(`R22 ${kind} producer shutdown cannot supply acceptance`, async () => {
    const f = await completedPolicy({ producerCloseMs: kind === 'hung' ? 25 : 250 }); let options = f.closeOptions;
    if (kind === 'missing-proof') options = {};
    else options = { ...options, closeProducer: async () => {
      if (kind === 'refused') throw new Error('PRIVATE shutdown');
      if (kind === 'hung') return new Promise(() => {});
      if (kind !== 'not-closed') f.finish();
      return { ...closeProof(), ...(kind === 'false-cleanup' ? { cleanup_confirmed: false } : {}),
        ...(kind === 'no-native-disconnect' ? { native_disconnect_confirmed: false } : {}),
        ...(kind === 'no-sdk-disconnect' ? { sdk_disconnected: false } : {}),
        ...(kind === 'no-page-or-protocol' ? { owned_page_close_completed: false } : {}) };
    } };
    const result = await f.value.close(options); assert.notEqual(result.failure, null);
    assert.equal(result.producer_closed, false); assert.equal(result.handlers_removed, true);
    assert.equal(result.producer_close_settled, kind !== 'hung' && kind !== 'missing-proof');
    assert.equal(result.raw_pending_before_verdict, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  });
}
for (const kind of ['source', 'transport', 'page']) test(`R22 early ${kind} loss cannot masquerade as requested close`, async () => {
  const f = await completedPolicy(); await f.value.revoke(); let closeCalls = 0;
  if (kind === 'source') f.sourceLost();
  if (kind === 'transport') f.disconnect();
  const before = f.calls.length;
  const result = await f.value.close({ ...f.closeOptions,
    ...(kind === 'page' ? { isProducerOpen: () => false } : {}),
    closeProducer: async () => { closeCalls++; f.finish(); return closeProof(); } });
  assert.notEqual(result.failure, null); assert.equal(result.raw_pending_before_verdict, 0);
  assert.equal(f.calls.length, before);
  if (kind !== 'source') { assert.equal(closeCalls, 0); assert.equal(result.producer_closed, false); }
});
for (const kind of ['refused', 'hung']) test(`R22 ${kind} final DENY remains failure with observation retained through cleanup`, async () => {
  const f = await completedPolicy(), send = f.session.send;
  f.session.send = (name, args) => name === 'Browser.setDownloadBehavior' && args.behavior === 'deny'
    ? kind === 'hung' ? new Promise(() => {}) : Promise.reject(new Error('PRIVATE refusal')) : send(name, args);
  let observed = false;
  const result = await f.value.close({ ...f.closeOptions, closeProducer: async () => {
    observed = f.session.listenerCount('Browser.downloadWillBegin') === 1; f.finish(); return closeProof();
  } });
  assert.equal(observed, true); assert.notEqual(result.failure, null);
  if (kind === 'hung') assert.ok(result.raw_pending_before_verdict > 0);
  else assert.equal(result.raw_pending_before_verdict, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test('R22 unexpected disconnect before protocol dispatch never sends a command into the lost transport', async () => {
  const f = await completedPolicy(), before = f.calls.length;
  queueMicrotask(f.disconnect); const closing = f.value.close(f.closeOptions);
  const result = await closing; assert.notEqual(result.failure, null);
  assert.equal(f.calls.length, before); assert.equal(result.commands_started, result.commands_settled);
  assert.equal(result.raw_pending_before_verdict, 0);
});
test('R22 retained late-event trace stays finite and private during producer shutdown', async () => {
  const f = await completedPolicy();
  const result = await f.value.close({ ...f.closeOptions, closeProducer: async () => {
    for (let i = 0; i < 500; i++) lateParent(f);
    f.finish(); return closeProof();
  } });
  assert.notEqual(result.failure, null); assert.equal(result.trace.length, 192); assert.equal(result.trace_overflow, 255);
  assert.equal(result.raw_pending_before_verdict, 0); assert.doesNotMatch(JSON.stringify(result), /late-parent|blob:|22222222/);
});


test('R22 producer-live post-close-return counterexample remains a failure through staged close', async () => {
  const f = await completedPolicy(); let injected = false;
  const options = { ...f.closeOptions, closeProducer: async () => {
    injected = true; lateParent(f); f.finish(); return closeProof();
  } };
  let result = await f.value.close(options);
  // Exact tester schedule on the old API: close returned while the producer
  // remained live. The new API runs the same attempt inside its close operation.
  if (!injected) { injected = true; lateParent(f); result = await f.value.close(options); }
  assert.equal(injected, true); assert.notEqual(result.failure, null);
  assert.equal(result.raw_pending_before_verdict, 0);
});
