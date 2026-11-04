/** Synthetic default controls; no real private leases, processes, HA or services. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createNativeRequestGuard } from './browser.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { EXTERNAL_WORKER_POLICY, EXTERNAL_WORKER_POLICY_SHA256, connectVerifiedExternalBrowser, externalChromeArguments,
  inspectExternalRegistrations, parseExternalLease, parseExternalPreflight, validateExternalChromeCommandLine, validateExternalDocuments } from './browser_external.mjs';

const now = Date.parse('2026-11-02T09:00:00Z'), prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
function documents() {
  const lease = { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN, session_id: '1'.repeat(32),
    configuration_A_sha256: '2'.repeat(64), actual_candidate_image_manifest_digest: 'sha256:' + '3'.repeat(64),
    actual_bridge_archive_sha256: '4'.repeat(64), admin_A_user_id_sha256: hash('a'.repeat(32)), ingress_prefix_sha256: hash(prefix),
    certificate_sha256: '5'.repeat(64), controller_pid: 10, controller_start_ticks: '100', chrome_pid: 20, chrome_start_ticks: '200',
    executable_sha256: '6'.repeat(64), profile_basename: 'external-profile-' + '1'.repeat(32), fresh_profile: true,
    cdp_port: 19367, cdp_endpoint: 'ws://127.0.0.1:19367/devtools/browser/11111111-2222-3333-4444-555555555555',
    proxy_port: 19764, argv_sha256: '7'.repeat(64), worker_policy_sha256: EXTERNAL_WORKER_POLICY_SHA256,
    process_preflight_sha256: '8'.repeat(64), observed_at: new Date(now).toISOString() };
  const preflight = { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN, session_id: lease.session_id,
    controller_pid: 10, proxy_port: lease.proxy_port, connect_authority: '127.0.0.1:18223', raw_connect_only: true,
    outside_forwarded: 0, same_policy_sha256: EXTERNAL_WORKER_POLICY_SHA256, same_policy_report_sha256: '9'.repeat(64),
    same_policy_positive_control_verified: true, same_policy_registrations: 0, same_policy_sdk_workers: 0,
    same_policy_cdp_workers: 0, same_policy_worker_script_requests: 0, same_policy_escape_hits: 0, observed_at: lease.observed_at };
  const expected = { inputs: { configuration_sha256: lease.configuration_A_sha256,
    document: { candidate: { image_manifest_digest: lease.actual_candidate_image_manifest_digest }, bridge: { archive_sha256: lease.actual_bridge_archive_sha256 } } },
    tls: { certificate_sha256: lease.certificate_sha256, spki: 'SYNTHETIC_SPKI' }, executable: '/tmp/SYNTHETIC_PINNED_CHROME', preflight_sha256: lease.process_preflight_sha256 };
  const path = join(CONTROL_ROOT, lease.profile_basename);
  const facts = { actor_pid: 30, actor_parent_pid: 10, actor_uid: 1000, actor_gid: 1000, controller: { pid: 10, start_ticks: '100', uid: 1000 },
    chrome: { pid: 20, parent_pid: 10, start_ticks: '200', uid: 1000, executable: expected.executable,
      cmdline: null, argv_sha256: null },
    executable_sha256: lease.executable_sha256, profile: { path, realpath: path, directory: true, symlink: false, mode: 0o700, uid: 1000, gid: 1000 } };
  const value = { lease, preflight, expected, facts };
  setCommandLine(value, externalChromeArguments(lease, expected.executable, expected.tls.spki));
  return value;
}
const verify = value => validateExternalDocuments(value.lease, value.preflight, value.expected, value.facts, now);
function setCommandLine(value, args, separator = '\0') {
  const bytes = Buffer.from(args.join(separator) + '\0');
  value.facts.chrome.cmdline = bytes;
  value.facts.chrome.argv_sha256 = value.lease.argv_sha256 = hash(bytes);
}

test('owned pinned Chromium process-title bytes preserve exact launch authority', () => {
  const value = documents();
  // Actual blank pinned Chrome rewrites argv separators to single spaces and
  // retains exactly one terminating NUL, with no padding or argument changes.
  setCommandLine(value, externalChromeArguments(value.lease, value.expected.executable, value.expected.tls.spki), ' ');
  assert.equal(verify(value).exact_arguments_verified, true);
  assert.equal(verify(value).arguments_representation, 'chromium_process_title');
});

test('external process bytes accept only the two exact forms and preserve actual-byte hash binding', () => {
  for (const separator of ['\0', ' ']) {
    const value = documents(), args = externalChromeArguments(value.lease, value.expected.executable, value.expected.tls.spki);
    setCommandLine(value, args, separator);
    const format = separator === '\0' ? 'nul_separated' : 'chromium_process_title';
    assert.equal(validateExternalChromeCommandLine(value.facts.chrome.cmdline, args), format);
    assert.equal(verify(value).arguments_representation, format);
    const changes = [
      bytes => bytes.subarray(0, -1), bytes => Buffer.concat([bytes, Buffer.from([0])]),
      bytes => Buffer.concat([Buffer.from([0]), bytes]), bytes => Buffer.from(bytes.toString('utf8').replace('--disable-quic', '--enable-quic')),
      () => Buffer.from([...args, '--ignore-certificate-errors'].join(separator) + '\0'),
      () => Buffer.from(args.filter(arg => arg !== '--disable-component-extensions-with-background-pages').join(separator) + '\0'),
      () => Buffer.from([args[0], args[2], args[1], ...args.slice(3)].join(separator) + '\0'),
      () => Buffer.from(args.map(arg => arg === '--proxy-bypass-list=<-loopback>' ? '--proxy-bypass-list=*' : arg).join(separator) + '\0'),
      () => Buffer.from(args.map(arg => arg.startsWith('--user-data-dir=') ? arg + '-other' : arg).join(separator) + '\0'),
      () => Buffer.from(args.map(arg => arg.startsWith('--remote-debugging-port=') ? '--remote-debugging-port=9999' : arg).join(separator) + '\0'),
      () => Buffer.from(args.map(arg => arg.startsWith('--ignore-certificate-errors-spki-list=') ? '--ignore-certificate-errors-spki-list=OTHER' : arg).join(separator) + '\0'),
      () => Buffer.from(args.join('  ') + '\0'), () => Buffer.from(args.join('\t') + '\0'),
      () => Buffer.from(args.join(' ') + ' \0'), () => Buffer.from(args.join(' ').replace('--host-resolver-rules=', '"--host-resolver-rules=') + '"\0'),
      bytes => { const damaged = Buffer.from(bytes); damaged[0] = 255; return damaged; },
      () => Buffer.from(args.slice(0, 2).join('\0') + ' ' + args.slice(2).join(' ') + '\0'),
    ];
    for (const damage of changes) {
      const damaged = documents(), bytes = damage(value.facts.chrome.cmdline);
      // Matching receipt hashes cannot turn changed flags/serialization into
      // authority: the expected launch bytes are checked independently.
      damaged.facts.chrome.cmdline = bytes;
      damaged.facts.chrome.argv_sha256 = damaged.lease.argv_sha256 = hash(bytes);
      assert.throws(() => verify(damaged));
      assert.throws(() => validateExternalChromeCommandLine(bytes, args));
    }
  }
  const staleHash = documents(), previousHash = staleHash.lease.argv_sha256;
  setCommandLine(staleHash, externalChromeArguments(staleHash.lease, staleHash.expected.executable, staleHash.expected.tls.spki), ' ');
  staleHash.facts.chrome.argv_sha256 = staleHash.lease.argv_sha256 = previousHash;
  assert.throws(() => verify(staleHash));
  const { lease, expected } = documents(), args = externalChromeArguments(lease, expected.executable, expected.tls.spki);
  for (const raw of [null, '', args.join(' ') + '\0', new Uint8Array([0]), Buffer.alloc(0), Buffer.alloc(65537)]) {
    assert.throws(() => validateExternalChromeCommandLine(raw, args));
  }
  for (const invalid of [null, args.slice(1), [...args.slice(0, -1), 'about:blank\0'], [...args.slice(0, -1), 1]]) {
    assert.throws(() => validateExternalChromeCommandLine(Buffer.from(args.join('\0') + '\0'), invalid));
  }
});

test('duplicate external lease authority fields are rejected instead of silently promoted', () => {
  const { lease, preflight } = documents();
  assert.deepEqual(parseExternalLease(JSON.stringify(lease)), lease); assert.deepEqual(parseExternalPreflight(JSON.stringify(preflight)), preflight);
  assert.throws(() => parseExternalLease(JSON.stringify(lease).replace('{', '{"chrome_pid":1,')));
  assert.throws(() => parseExternalPreflight(JSON.stringify(preflight).replace('{', '{"proxy_port":1,')));
});

test('fresh external lease binds actual same-parent PID namespace, pinned executable/arguments/profile and process proxy proof', () => {
  const value = documents(), proof = verify(value);
  assert.equal(proof.own_parent_and_process_verified, true);
  const json = JSON.stringify(proof); assert.equal(json.includes('ws://'), false); assert.equal(json.includes(CONTROL_ROOT), false);
  for (const damage of [v => { v.lease.observed_at = new Date(now + 1).toISOString(); },
    v => { v.lease.observed_at = new Date(now - 300001).toISOString(); }, v => { v.lease.extra = true; },
    v => { v.lease.controller_pid = 11; }, v => { v.facts.chrome.parent_pid = 99; }, v => { v.facts.chrome.start_ticks = '201'; },
    v => { v.facts.controller.start_ticks = '101'; }, v => { v.facts.chrome.uid = 0; }, v => { v.facts.chrome.executable = '/tmp/OTHER'; },
    v => { v.facts.executable_sha256 = '0'.repeat(64); }, v => { v.lease.fresh_profile = false; }, v => { v.facts.profile.symlink = true; },
    v => { v.facts.profile.mode = 0o755; }, v => { v.facts.profile.realpath += '-other'; }, v => { v.facts.profile.uid = 0; },
    v => { v.lease.profile_basename = '../outside'; }, v => { v.lease.configuration_A_sha256 = '0'.repeat(64); },
    v => { v.lease.certificate_sha256 = '0'.repeat(64); }, v => { v.lease.worker_policy_sha256 = '0'.repeat(64); },
    v => { v.preflight.connect_authority = 'localhost:18223'; }, v => { v.preflight.raw_connect_only = false; },
    v => { v.preflight.outside_forwarded = 1; }, v => { v.preflight.same_policy_registrations = 1; },
    v => { v.preflight.same_policy_positive_control_verified = false; }, v => { v.preflight.observed_at = new Date(now - 300001).toISOString(); },
    v => { v.lease.chrome_pid = '20'; }, v => { v.lease.cdp_port = 18223; }, v => { v.lease.cdp_port = v.lease.proxy_port; },
    v => { v.lease.cdp_endpoint += '?token=PRIVATE'; }, v => { v.lease.cdp_endpoint = v.lease.cdp_endpoint.replace('127.0.0.1', 'localhost'); },
    v => { v.lease.cdp_endpoint = v.lease.cdp_endpoint.replace('ws:', 'http:'); },
    v => { setCommandLine(v, [...externalChromeArguments(v.lease, v.expected.executable, v.expected.tls.spki), '--ignore-certificate-errors']); },
    v => { setCommandLine(v, externalChromeArguments(v.lease, v.expected.executable, v.expected.tls.spki).filter(flag => flag !== '--disable-component-extensions-with-background-pages')); },
    v => { setCommandLine(v, externalChromeArguments(v.lease, v.expected.executable, v.expected.tls.spki).map(flag => flag === '--proxy-bypass-list=<-loopback>' ? '--proxy-bypass-list=*' : flag)); }]) {
    const damaged = documents(); damage(damaged); assert.throws(() => verify(damaged));
  }
});

test('exact SDK worker policy resolves undefined and prevents registration without emulating auth or lifecycle', async () => {
  let registered = 0; const warnings = [];
  class Container { async register() { registered += 1; return {}; } }
  const scope = { self: { ServiceWorkerContainer: Container }, ServiceWorkerContainer: Container,
    console: { warn: message => warnings.push(message) } };
  runInNewContext(EXTERNAL_WORKER_POLICY, scope);
  assert.equal(await new Container().register(), undefined); assert.equal(registered, 0);
  assert.deepEqual(warnings, ['Service Worker registration blocked by Playwright']);
  assert.equal(EXTERNAL_WORKER_POLICY_SHA256, hash(EXTERNAL_WORKER_POLICY));
  assert.equal(EXTERNAL_WORKER_POLICY_SHA256, 'ea5047cdd23c30668b9d7467303ac2ddc8ace2b46a69eda3d239fde1a8a5a6f0');
});

function protocol({ cookies = [], workers = [], targets = [], pages = 1, contexts = 1, initialURL = 'about:blank' } = {}) {
  const value = documents(), calls = [], report = { checks: {} };
  const context = new EventEmitter(), diagnostic = new EventEmitter(); let connected = true, pageClosed = false;
  const page = Object.assign(new EventEmitter(), { url: () => initialURL, context: () => context, isClosed: () => pageClosed,
    close: async options => { assert.deepEqual(options, { runBeforeUnload: false }); calls.push('owned-page-close'); pageClosed = true; },
    evaluate: async callback => { assert.equal(callback, inspectExternalRegistrations); calls.push('registrations'); return { outcome: 'PASS', registrations: 0 }; } });
  Object.assign(context, { browser: () => browser, pages: () => Array(pages).fill(page), serviceWorkers: () => workers, cookies: async () => { calls.push('cookies'); return cookies; },
    newPage: async () => assert.fail('external bootstrap must use existing blank page'),
    addInitScript: async policy => { assert.equal(policy, EXTERNAL_WORKER_POLICY); calls.push('policy'); } });
  diagnostic.send = async (method, args) => {
    calls.push(method);
    if (method === 'Target.getTargets') return { targetInfos: targets };
    if (method === 'Target.setDiscoverTargets') assert.deepEqual(args, { discover: true });
    else {
      assert.equal(method, 'Browser.close');
      queueMicrotask(() => { connected = false; browser.emit('disconnected'); });
    }
    return {};
  };
  const browser = Object.assign(new EventEmitter(), { contexts: () => Array(contexts).fill(context), newContext: async () => assert.fail('must never create a new external context'),
    newBrowserCDPSession: async () => diagnostic, close: async () => { calls.push('sdk-disconnect'); connected = false; browser.emit('disconnected'); }, isConnected: () => connected });
  const chromium = { connectOverCDP: async (endpoint, options) => { calls.push('connect'); assert.equal(endpoint, value.lease.cdp_endpoint);
    assert.deepEqual(options, { noDefaults: true, timeout: 10000 }); return browser; } };
  const source = { lease: value.lease, verify: () => verify(value), evidence: verify(value) };
  return { ...value, source, calls, report, chromium, browser, context, page, diagnostic,
    nativeDisconnect: () => { connected = false; browser.emit('disconnected'); } };
}

test('external adapter uses only existing default page/context and installs exact policy before credential barrier', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  assert.equal(session.page, value.page); assert.equal(session.context, value.context);
  assert.ok(value.calls.indexOf('policy') > value.calls.indexOf('Target.getTargets'));
  assert.equal(value.calls.includes('registrations'), false);
  await session.beforeCredentials(); assert.ok(value.calls.indexOf('registrations') > value.calls.indexOf('policy'));
  const cookieProof = value.report.checks.external.worker_inventory;
  assert.deepEqual(cookieProof, [{ sdk_workers: 0, cdp_worker_targets: 0, registrations: null }, { sdk_workers: 0, cdp_worker_targets: 0, registrations: 0 }]);
  const first = session.cleanup(), second = session.cleanup(); assert.equal(first, second); assert.equal(session.evidence().gate_closed, true);
  const result = await first; assert.equal(result.protocol_close_confirmed, true); assert.equal(result.sdk_disconnected, true);
  assert.equal(result.process_exit, 'REQUIRES_ROOT_READBACK'); assert.equal(value.calls.filter(x => x === 'Browser.close').length, 1);
});

test('preexisting cookies, pages, contexts or worker targets fail closed without new context or navigation fallback', async () => {
  for (const options of [{ cookies: [{ name: 'SYNTHETIC' }] }, { workers: [{}] }, { targets: [{ type: 'service_worker' }] },
    { targets: [{ type: 'shared_worker' }] }, { targets: [{}] }, { pages: 2 }, { contexts: 2 }, { initialURL: LOCAL_ORIGIN + '/' }]) {
    const value = protocol(options);
    await assert.rejects(connectVerifiedExternalBrowser(value.chromium, value.source, value.report));
    assert.equal(value.calls.includes('registrations'), false); assert.equal(value.calls.includes('Browser.close'), true);
    assert.equal(value.report.checks.cleanup.protocol_close_confirmed, true);
  }
});

function wire(path, method = 'GET', body = null) {
  return { url: () => LOCAL_ORIGIN + prefix + path, method: () => method, postData: () => body };
}
const preview = JSON.stringify({ input: 'spotify:album:0123456789ABCDEFGHIJKL', media_type: 'album' });
test('actual bootstrap binding needs matching receipt identity/prefix and exactly one fixed preview; other intents fence', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  const scope = { fromFrame: true, prefix };
  assert.equal(session.allowRequest(wire('api/v1/session'), scope), true);
  assert.equal(session.allowRequest(wire('api/v1/music/resolve', 'POST', preview), scope), true);
  await session.verifyBootstrap({ session: { body: { user_id: 'a'.repeat(32) } } }, prefix);
  assert.equal(value.report.checks.external.actual_admin_and_prefix_bound, true);
  assert.equal(session.allowRequest(wire('api/v1/music/resolve', 'POST', preview), scope), false);
  await session.cleanup();
  for (const [path, method, body] of [['api/v1/publication/review', 'POST', '{}'], ['api/v1/tags/X/assignment', 'PUT', '{}'],
    ['api/v1/tags/X/name', 'PATCH', '{}'], ['api/v1/restores/preview', 'POST', '{}'], ['api/v1/music/resolve', 'POST', preview + ' ']]) {
    const denied = protocol(), current = await connectVerifiedExternalBrowser(denied.chromium, denied.source, denied.report);
    assert.equal(current.allowRequest(wire(path, method, body), scope), false); assert.equal(current.evidence().gate_closed, true);
    await current.cleanup();
  }
  for (const [user, actualPrefix] of [['b'.repeat(32), prefix], ['a'.repeat(32), '/api/hassio_ingress/OTHER/']]) {
    const denied = protocol(), current = await connectVerifiedExternalBrowser(denied.chromium, denied.source, denied.report);
    assert.equal(current.allowRequest(wire('api/v1/music/resolve', 'POST', preview), scope), true);
    await assert.rejects(current.verifyBootstrap({ session: { body: { user_id: user } } }, actualPrefix));
    assert.equal(current.evidence().gate_closed, true);
    await assert.rejects(current.verifyBootstrap({ session: { body: { user_id: 'a'.repeat(32) } } }, prefix)); await current.cleanup();
  }
});

test('unexpected worker or changed provenance fences HTTP and sockets before subsequent authority', async () => {
  for (const changed of ['sdk-worker', 'cdp-worker', 'provenance']) {
    const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    let socketsClosed = 0; session.bindSocket({ close: () => { socketsClosed += 1; } });
    if (changed === 'sdk-worker') value.context.emit('serviceworker', {});
    else if (changed === 'cdp-worker') value.diagnostic.emit('Target.targetCreated', { targetInfo: { type: 'worker' } });
    else value.facts.chrome.start_ticks = '201';
    let credentialReads = 0;
    await assert.rejects(session.beforeCredentials().then(() => { credentialReads += 1; }));
    assert.equal(credentialReads, 0); assert.equal(session.evidence().gate_closed, true); assert.equal(socketsClosed, 1);
    assert.equal(session.allowRequest({ url: () => LOCAL_ORIGIN + prefix, method: () => 'GET' }, { fromFrame: true, prefix }), false);
    await session.cleanup(); assert.equal(socketsClosed, 1);
  }
});

test('worker callback fences before URL inspection and records only redacted event provenance', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  let socketsClosed = 0, inspected = 0;
  session.bindSocket({ close: () => { socketsClosed += 1; } });
  const privateURL = LOCAL_ORIGIN + '/frontend_latest/SYNTHETIC_PRIVATE_PATH.js?token=SYNTHETIC_PRIVATE_QUERY';
  value.context.emit('serviceworker', { url() {
    inspected += 1;
    assert.equal(session.evidence().gate_closed, true); assert.equal(socketsClosed, 1);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
    return privateURL;
  } });
  assert.equal(inspected, 1);
  const events = value.report.checks.external.worker_events;
  assert.equal(events.events[0].source, 'sdk_serviceworker');
  assert.equal(events.events[0].type, 'service_worker');
  assert.equal(events.events[0].origin, 'fixture_local');
  assert.equal(events.events[0].url.sha256, hash(privateURL));
  assert.equal(events.events[0].path.sha256, hash('/frontend_latest/SYNTHETIC_PRIVATE_PATH.js'));
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(session.evidence().failure, 'unexpected_worker');
  await assert.rejects(session.beforeCredentials()); await session.cleanup();
});

test('CDP worker diagnostics distinguish type and origin using only bounded hashes after fencing', async () => {
  const urls = [
    [LOCAL_ORIGIN + prefix + 'SYNTHETIC_PRIVATE.js?token=SYNTHETIC_PRIVATE_QUERY', 'https', 'fixture_local', null],
    ['https://127.0.0.1:28223/SYNTHETIC_PRIVATE.js', 'https', 'fixture_proxy', null],
    ['blob:' + LOCAL_ORIGIN + '/SYNTHETIC_PRIVATE_BLOB', 'blob', 'fixture_local', null],
    ['https://SYNTHETIC-PRIVATE.example/SYNTHETIC_PRIVATE_PATH?secret=PRIVATE', 'https', 'other', hash('https://synthetic-private.example')],
    ['data:text/javascript,SYNTHETIC_PRIVATE_SCRIPT', 'data', 'opaque', hash('null')],
    ['SYNTHETIC_PRIVATE_INVALID_URL', 'unknown', 'invalid', null],
  ];
  for (const type of ['worker', 'shared_worker', 'service_worker']) for (const [url, scheme, origin, originHash] of urls) {
    const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    let closed = 0, typeReads = 0;
    session.bindSocket({ close: () => { closed += 1; } });
    const info = { get type() { typeReads += 1; return type; }, get url() {
      assert.equal(session.evidence().gate_closed, true); assert.equal(closed, 1); return url;
    }, get targetId() { assert.equal(session.evidence().gate_closed, true); return 'SYNTHETIC_PRIVATE_TARGET'; } };
    value.diagnostic.emit('Target.targetCreated', { targetInfo: info });
    const event = value.report.checks.external.worker_events.events[0];
    assert.equal(typeReads, 1); assert.equal(event.source, 'cdp_target_created'); assert.equal(event.type, type);
    assert.equal(event.scheme, scheme); assert.equal(event.origin, origin); assert.equal(event.origin_sha256, originHash);
    assert.equal(event.url.sha256, hash(url)); assert.equal(event.url.length, url.length);
    assert.equal(event.target.sha256, hash('SYNTHETIC_PRIVATE_TARGET'));
    assert.equal(event.gate_was_closed, false); assert.equal(event.fenced, true);
    const output = JSON.stringify(value.report);
    assert.equal(output.includes('SYNTHETIC_PRIVATE'), false); assert.equal(output.includes('synthetic-private.example'), false);
    assert.equal(output.includes(prefix), false); assert.equal(output.includes(url), false);
    await session.cleanup();
  }
});

test('worker diagnostic field errors and malformed events stay redacted and fail closed', async () => {
  for (const event of [null, {}, { targetInfo: null }, { targetInfo: { type: 1, url: 'SYNTHETIC_PRIVATE' } },
    { get targetInfo() { throw new Error('SYNTHETIC_PRIVATE_ERROR'); } },
    { targetInfo: { get type() { throw new Error('SYNTHETIC_PRIVATE_ERROR'); } } },
    { targetInfo: { type: 'worker', get url() { throw new Error('SYNTHETIC_PRIVATE_URL_ERROR'); }, targetId: 1 } }]) {
    const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    assert.doesNotThrow(() => value.diagnostic.emit('Target.targetCreated', event));
    const proof = value.report.checks.external.worker_events.events[0];
    assert.equal(proof.source, 'cdp_target_created'); assert.equal(proof.fenced, true);
    assert.equal(session.evidence().gate_closed, true);
    assert.ok(['target_inventory_unknown', 'unexpected_worker'].includes(session.evidence().failure));
    assert.equal(JSON.stringify(value.report).includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
    await assert.rejects(session.beforeCredentials()); await session.cleanup();
  }
  for (const worker of [null, {}, { url: () => 1 }, { url: () => Promise.resolve('SYNTHETIC_PRIVATE') },
    { url() { throw new Error('SYNTHETIC_PRIVATE_ERROR'); } }, { get url() { throw new Error('SYNTHETIC_PRIVATE_GETTER'); } }]) {
    const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    assert.doesNotThrow(() => value.context.emit('serviceworker', worker));
    const proof = value.report.checks.external.worker_events.events[0];
    assert.equal(proof.type, 'service_worker'); assert.ok(['missing', 'invalid', 'unreadable'].includes(proof.url.state));
    assert.equal(proof.origin, 'unknown'); assert.equal(proof.origin_sha256, null);
    assert.equal(JSON.stringify(value.report).includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(session.evidence().failure, 'unexpected_worker'); await session.cleanup();
  }
});

test('worker diagnostics cap inspected strings, first events and overflow without granting late authority', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  let resolve, granted = 0, inspected = 0;
  value.page.evaluate = () => new Promise(done => { resolve = done; });
  const pending = session.beforeCredentials().then(() => { granted += 1; });
  await new Promise(done => setImmediate(done));
  const large = 'https://SYNTHETIC-PRIVATE.example/' + 'SYNTHETIC_PRIVATE_PAYLOAD'.repeat(5000);
  const info = { type: 'worker', get url() { inspected += 1; assert.equal(session.evidence().gate_closed, true); return large; }, targetId: large };
  for (let index = 0; index < 8 + 65535 + 10; index += 1) value.diagnostic.emit('Target.targetCreated', { targetInfo: info });
  const proof = value.report.checks.external.worker_events;
  assert.equal(proof.events.length, 8); assert.equal(inspected, 8);
  assert.equal(proof.overflow, 65535); assert.equal(proof.overflow_saturated, true);
  assert.equal(proof.events[0].gate_was_closed, false); assert.equal(proof.events[1].gate_was_closed, true);
  for (const event of proof.events) {
    assert.equal(event.url.sha256, hash(large.slice(0, 4096))); assert.equal(event.url.length, 65536);
    assert.equal(event.url.length_capped, true); assert.equal(event.url.hash_capped, true);
    assert.equal(event.target.sha256, hash(large.slice(0, 4096))); assert.equal(event.target.length_capped, true);
    assert.equal(event.origin, 'unknown'); assert.equal(event.path.state, 'unavailable');
  }
  assert.ok(JSON.stringify(proof).length < 8192); assert.equal(JSON.stringify(proof).includes('SYNTHETIC_PRIVATE'), false);
  resolve({ outcome: 'PASS', registrations: 0 }); await assert.rejects(pending); assert.equal(granted, 0);
  await session.cleanup(); value.context.emit('serviceworker', { url() { assert.fail('overflow must not inspect another URL'); } });
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  assert.equal(proof.events.length, 8); assert.equal(session.evidence().failure, 'unexpected_worker');
});

test('late worker evidence after provenance fencing or cleanup cannot renew a lease or reopen the gate', async () => {
  for (const reason of ['stale', 'cleanup']) {
    const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    if (reason === 'stale') {
      value.source.verify = () => { throw new Error('SYNTHETIC_PRIVATE_STALE'); };
      assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
    } else await session.cleanup();
    const initialFailure = session.evidence().failure;
    value.context.emit('serviceworker', { url: () => LOCAL_ORIGIN + '/SYNTHETIC_PRIVATE_LATE.js' });
    const event = value.report.checks.external.worker_events.events[0];
    assert.equal(event.gate_was_closed, true); assert.equal(event.fenced, true);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
    if (initialFailure) assert.equal(session.evidence().failure, initialFailure);
    await assert.rejects(session.beforeCredentials()); await session.cleanup();
    assert.equal(value.calls.filter(method => method === 'Browser.close').length, 1);
    assert.equal(JSON.stringify(value.report).includes('SYNTHETIC_PRIVATE'), false);
  }
});

test('fenced CDP worker gets one bounded same-target metadata query and later redacted URL updates', async () => {
  const value = protocol(), send = value.diagnostic.send;
  const id = 'c'.repeat(32), parentFrameId = 'd'.repeat(32), browserContextId = 'e'.repeat(32);
  let resolve, queries = 0, socketsClosed = 0;
  value.diagnostic.send = (method, args) => {
    if (method !== 'Target.getTargetInfo') return send(method, args);
    queries += 1; assert.deepEqual(args, { targetId: id });
    assert.equal(session.evidence().gate_closed, true); assert.equal(socketsClosed, 1);
    return new Promise(done => { resolve = done; });
  };
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  session.bindSocket({ close: () => { socketsClosed += 1; } });
  const info = { type: 'worker', targetId: id, parentFrameId, browserContextId, url: '' };
  value.diagnostic.emit('Target.targetCreated', { targetInfo: info });
  await new Promise(done => setImmediate(done)); assert.equal(queries, 1);
  const url = LOCAL_ORIGIN + '/frontend_latest/SYNTHETIC_PRIVATE_WORKER.js?token=SYNTHETIC_PRIVATE_QUERY';
  value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...info, url } });
  resolve({ targetInfo: { ...info, url } });
  await new Promise(done => setImmediate(done));
  const proof = value.report.checks.external.worker_followup;
  assert.equal(proof.query.status, 'observed'); assert.equal(proof.updates.length, 1);
  assert.equal(proof.query.observation.url.sha256, hash(url));
  assert.equal(proof.updates[0].observation.url.sha256, hash(url));
  assert.equal(proof.target.parent_frame.sha256, hash(parentFrameId));
  assert.equal(proof.outcome, 'NONEMPTY_URL_OBSERVED');
  assert.equal(session.evidence().failure, 'unexpected_worker');
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  assert.equal(JSON.stringify(proof).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(JSON.stringify(proof).includes(id), false);
  await assert.rejects(session.beforeCredentials()); await session.cleanup();
});

test('metadata listeners precede discovery and inspect only two updates for the first fenced target', async () => {
  const value = protocol(), send = value.diagnostic.send, createSession = value.browser.newBrowserCDPSession;
  const info = { type: 'worker', targetId: 'c'.repeat(32), parentFrameId: 'd'.repeat(32), url: '' };
  let queries = 0, sessions = 0;
  value.browser.newBrowserCDPSession = async () => { sessions += 1; return createSession(); };
  value.diagnostic.send = (method, args) => {
    if (method === 'Target.setDiscoverTargets') assert.equal(value.diagnostic.listenerCount('Target.targetInfoChanged'), 1);
    if (method !== 'Target.getTargetInfo') return send(method, args);
    queries += 1; assert.deepEqual(args, { targetId: info.targetId }); return { targetInfo: info };
  };
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...info, get url() { assert.fail('unselected target'); } } });
  value.diagnostic.emit('Target.targetCreated', { targetInfo: info });
  await new Promise(done => setImmediate(done));
  value.diagnostic.emit('Target.targetCreated', { targetInfo: { ...info, targetId: 'a'.repeat(32) } });
  value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...info, targetId: 'a'.repeat(32), get url() { assert.fail('unrelated target'); } } });
  value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: info });
  const url = LOCAL_ORIGIN + '/SYNTHETIC_PRIVATE_LATE.js';
  value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...info, url } });
  value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...info, get url() { assert.fail('update cap'); } } });
  const proof = value.report.checks.external.worker_followup;
  assert.equal(queries, 1); assert.equal(sessions, 1); assert.equal(proof.update_limit, 2); assert.equal(proof.updates.length, 2);
  assert.equal(proof.query.status, 'observed'); assert.equal(proof.query.observation.url.length, 0);
  assert.equal(proof.updates[1].observation.url.sha256, hash(url)); assert.equal(proof.outcome, 'NONEMPTY_URL_OBSERVED');
  assert.equal(proof.target.sha256, hash(info.targetId)); assert.equal(session.evidence().failure, 'unexpected_worker');
  await session.cleanup();
});

test('metadata query rejects changed target, type or creation ownership hashes and never treats blank URL as resolution', async () => {
  const info = { type: 'worker', targetId: 'c'.repeat(32), parentFrameId: 'd'.repeat(32), browserContextId: 'e'.repeat(32), url: '' };
  for (const damage of [response => { response.targetInfo.targetId = 'a'.repeat(32); },
    response => { response.targetInfo.type = 'service_worker'; }, response => { delete response.targetInfo; },
    response => { response.targetInfo.parentFrameId = 'f'.repeat(32); }, response => { delete response.targetInfo.parentFrameId; },
    response => { response.targetInfo.browserContextId = 1; }, response => { response.targetInfo.browserContextId = 'PRIVATE_OTHER_CONTEXT'; }]) {
    const value = protocol(), send = value.diagnostic.send, response = { targetInfo: { ...info } }; damage(response);
    value.diagnostic.send = (method, args) => method === 'Target.getTargetInfo' ? response : send(method, args);
    const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    value.diagnostic.emit('Target.targetCreated', { targetInfo: info }); await new Promise(done => setImmediate(done));
    const proof = value.report.checks.external.worker_followup;
    assert.equal(proof.query.status, 'invalid_metadata'); assert.equal(proof.query.observation, null);
    value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...info, type: 'shared_worker' } });
    assert.equal(proof.updates[0].status, 'invalid_metadata'); assert.equal(proof.outcome, 'INCONCLUSIVE');
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
    assert.equal(JSON.stringify(value.report).includes('PRIVATE_OTHER_CONTEXT'), false); await session.cleanup();
  }
  const value = protocol(), send = value.diagnostic.send;
  value.diagnostic.send = (method, args) => method === 'Target.getTargetInfo' ? { targetInfo: info } : send(method, args);
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.diagnostic.emit('Target.targetCreated', { targetInfo: info }); await new Promise(done => setImmediate(done));
  assert.equal(value.report.checks.external.worker_followup.query.status, 'observed');
  assert.equal(value.report.checks.external.worker_followup.outcome, 'INCONCLUSIVE'); await session.cleanup();
});

test('malformed first worker or stale provenance cannot start a query or switch to another target', async () => {
  const info = { type: 'worker', targetId: 'c'.repeat(32), parentFrameId: 'd'.repeat(32), url: '' };
  for (const damage of [item => { item.targetId = 'SYNTHETIC_PRIVATE_ID'; }, item => { item.targetId = 1; },
    item => { item.browserContextId = 'x'.repeat(257); }, item => { item.parentFrameId = {}; }]) {
    const value = protocol(), send = value.diagnostic.send; let queries = 0;
    value.diagnostic.send = (method, args) => { if (method === 'Target.getTargetInfo') { queries += 1; return {}; } return send(method, args); };
    const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report), first = { ...info }; damage(first);
    value.diagnostic.emit('Target.targetCreated', { targetInfo: first }); value.diagnostic.emit('Target.targetCreated', { targetInfo: info });
    await new Promise(done => setImmediate(done)); assert.equal(queries, 0);
    assert.equal(value.report.checks.external.worker_followup.query.status, 'invalid_target');
    assert.equal(session.evidence().gate_closed, true); await session.cleanup();
  }
  const value = protocol(), send = value.diagnostic.send; let queries = 0;
  value.diagnostic.send = (method, args) => { if (method === 'Target.getTargetInfo') { queries += 1; return {}; } return send(method, args); };
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.source.verify = () => { throw new Error('SYNTHETIC_PRIVATE_STALE'); };
  value.diagnostic.emit('Target.targetCreated', { targetInfo: info }); await new Promise(done => setImmediate(done));
  value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: info });
  const proof = value.report.checks.external.worker_followup;
  assert.equal(queries, 0); assert.equal(proof.query.status, 'stale_provenance');
  assert.equal(proof.updates[0].status, 'stale_provenance'); assert.equal(proof.outcome, 'INCONCLUSIVE');
  assert.equal(JSON.stringify(proof).includes('SYNTHETIC_PRIVATE'), false); await session.cleanup();
});

test('metadata timeout and cleanup discard late results without extending authority or mutating the final projection', async () => {
  for (const finish of ['timeout', 'cleanup_before_send', 'cleanup_after_send', 'stale_after_send']) {
    const value = protocol(), send = value.diagnostic.send;
    const info = { type: 'worker', targetId: 'c'.repeat(32), parentFrameId: 'd'.repeat(32), url: '' };
    let resolve, queries = 0;
    value.diagnostic.send = (method, args) => {
      if (method !== 'Target.getTargetInfo') return send(method, args);
      queries += 1; return new Promise(done => { resolve = done; });
    };
    const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    value.diagnostic.emit('Target.targetCreated', { targetInfo: info });
    if (finish === 'cleanup_before_send') await session.cleanup();
    else await new Promise(done => setImmediate(done));
    const proof = value.report.checks.external.worker_followup;
    assert.equal(proof.query.timeout_ms, 250);
    if (finish === 'timeout') {
      await new Promise(done => setTimeout(done, 275)); assert.equal(proof.query.status, 'timeout');
    } else if (finish === 'stale_after_send') {
      value.source.verify = () => { throw new Error('SYNTHETIC_PRIVATE_STALE'); };
    } else { await session.cleanup(); assert.equal(proof.query.status, 'cancelled_cleanup'); }
    const beforeLate = JSON.stringify(proof);
    if (resolve) resolve({ targetInfo: { ...info, get url() { assert.fail('late result must not be inspected'); } } });
    await new Promise(done => setImmediate(done));
    if (finish === 'stale_after_send') assert.equal(proof.query.status, 'stale_provenance');
    else assert.equal(JSON.stringify(proof), beforeLate);
    if (finish === 'cleanup_before_send') assert.equal(queries, 0); else assert.equal(queries, 1);
    await session.cleanup(); const closed = JSON.stringify(proof);
    value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...info, get url() { assert.fail('after cleanup'); } } });
    assert.equal(JSON.stringify(proof), closed); assert.equal(session.evidence().gate_closed, true);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  }
});

test('follow-up metadata retains existing redaction and string bounds without implying creator-frame authority', async () => {
  const value = protocol(), send = value.diagnostic.send;
  const info = { type: 'worker', targetId: 'c'.repeat(32), url: '' };
  const large = LOCAL_ORIGIN + '/SYNTHETIC_PRIVATE/'.repeat(5000);
  const response = { targetInfo: { ...info, url: large, parentFrameId: 'SYNTHETIC_PRIVATE_PARENT' } };
  value.diagnostic.send = (method, args) => method === 'Target.getTargetInfo' ? response : send(method, args);
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.diagnostic.emit('Target.targetCreated', { targetInfo: info }); await new Promise(done => setImmediate(done));
  const proof = value.report.checks.external.worker_followup, observed = proof.query.observation;
  assert.equal(proof.query.status, 'observed'); assert.equal(proof.target.parent_frame.state, 'missing');
  assert.equal(observed.parent_frame.sha256, hash('SYNTHETIC_PRIVATE_PARENT'));
  assert.equal(observed.url.sha256, hash(large.slice(0, 4096))); assert.equal(observed.url.length, 65536);
  assert.equal(observed.url.hash_capped, true); assert.equal(observed.url.length_capped, true);
  assert.equal(observed.path.state, 'unavailable'); assert.equal(observed.origin, 'unknown');
  assert.equal(proof.outcome, 'INCONCLUSIVE');
  value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...info, get url() { throw new Error('SYNTHETIC_PRIVATE_ERROR'); } } });
  assert.equal(proof.updates[0].observation.url.state, 'unreadable');
  assert.equal(JSON.stringify(proof).includes('SYNTHETIC_PRIVATE'), false); assert.ok(JSON.stringify(proof).length < 8192);
  assert.equal(session.evidence().failure, 'unexpected_worker'); await session.cleanup();
});

test('missing registration API or unverified context is not treated as zero registrations', async () => {
  const run = async scope => JSON.parse(JSON.stringify(await runInNewContext('(' + inspectExternalRegistrations.toString() + ')()', scope)));
  assert.deepEqual(await run({ location: { origin: LOCAL_ORIGIN }, isSecureContext: true, navigator: {} }), { outcome: 'INVALID_CONTEXT', reason: 'service_worker_api_missing' });
  assert.deepEqual(await run({ location: { origin: 'https://example.invalid' }, isSecureContext: true, navigator: {} }), { outcome: 'INVALID_CONTEXT', reason: 'origin_mismatch' });
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.page.evaluate = async () => ({ outcome: 'PASS', registrations: 1 });
  await assert.rejects(session.beforeCredentials()); assert.equal(session.evidence().gate_closed, true); await session.cleanup();
});

test('late registration check cannot grant credentials after fencing', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  let resolve, reads = 0;
  value.page.evaluate = () => new Promise(done => { resolve = done; });
  const pending = session.beforeCredentials().then(() => { reads += 1; });
  await new Promise(done => setImmediate(done)); session.fence('synthetic_terminal'); resolve({ outcome: 'PASS', registrations: 0 });
  await assert.rejects(pending); assert.equal(reads, 0); await session.cleanup();
});

test('protocol-close timeout cannot become cleanup success merely because SDK disconnects or a late command resolves', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 20 });
  const original = value.diagnostic.send; let resolve;
  value.diagnostic.send = (method, args) => method === 'Browser.close' ? new Promise(done => { resolve = done; }) : original(method, args);
  let closed = 0; session.bindSocket({ close: () => { closed += 1; } });
  const pending = session.cleanup(); assert.equal(closed, 1); assert.equal(session.evidence().gate_closed, true);
  const result = await pending; assert.equal(result.cleanup_confirmed, false); assert.equal(result.sdk_disconnected, true);
  const stages = JSON.stringify(result.shutdown_stages);
  resolve({}); await new Promise(done => setImmediate(done)); assert.equal(result.protocol_close_confirmed, false);
  assert.equal(JSON.stringify(result.shutdown_stages), stages); assert.equal(result.shutdown_stages.protocol_acknowledged, false);
  assert.equal(await session.cleanup(), result);
});

test('failed SDK disconnect remains unconfirmed and never causes context or transport fallback', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.browser.close = async () => { throw new Error('SYNTHETIC_DISCONNECT_FAILURE'); };
  const result = await session.cleanup(); assert.equal(result.protocol_close_confirmed, true);
  assert.equal(result.sdk_disconnected, false); assert.equal(result.cleanup_confirmed, false);
  assert.equal(await session.cleanup(), result); assert.equal(value.calls.filter(x => x === 'Browser.close').length, 1);
});

test('invalid provenance prevents any attachment or credential barrier', async () => {
  const value = protocol(); value.source.verify = () => { throw new Error('SYNTHETIC_STALE_LEASE'); };
  await assert.rejects(connectVerifiedExternalBrowser(value.chromium, value.source, value.report));
  assert.equal(value.calls.includes('connect'), false); assert.equal(value.calls.includes('registrations'), false);
  assert.equal(value.report.checks.cleanup.reason, 'not_attached');
});

test('late attachment is closed without inventory, policy or authority, and cannot upgrade the failed attachment verdict', async () => {
  const value = protocol(); let resolve;
  value.chromium.connectOverCDP = () => new Promise(done => { resolve = done; });
  await assert.rejects(connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { attachTimeoutMs: 20, operationTimeoutMs: 20 }));
  assert.equal(value.report.checks.cleanup.cleanup_confirmed, false); resolve(value.browser);
  await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
  assert.equal(value.calls.includes('Browser.close'), true); assert.equal(value.calls.includes('policy'), false);
  assert.equal(value.report.checks.cleanup.cleanup_confirmed, false);
});

test('external module clean import/help and invalid CLI input disclose no path and need no browser dependency', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jukelet-external-local-'));
  try {
    const scripts = join(directory, 'scripts', 'haos_acceptance'); mkdirSync(scripts, { recursive: true });
    for (const name of ['browser.mjs', 'browser_external.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs'])
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), name), join(scripts, name));
    const module = join(scripts, 'browser_external.mjs');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(module).href)})`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(imported.status, 0); assert.equal(imported.stdout + imported.stderr, '');
    assert.equal(spawnSync(process.execPath, [module, '--help'], { timeout: 5000 }).status, 0);
    const invalid = spawnSync(process.execPath, [module, 'external-read-only', '/tmp/SYNTHETIC_PRIVATE_INPUT'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).phase, 'external-read-only');
    assert.equal((invalid.stdout + invalid.stderr).includes('SYNTHETIC_PRIVATE_INPUT'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI entry can reenter the external module through the browser loader without a top-level-await cycle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jukelet-external-loader-'));
  try {
    const scripts = join(directory, 'scripts', 'haos_acceptance'); mkdirSync(scripts, { recursive: true });
    for (const name of ['browser_external.mjs', 'browser_inputs.mjs', 'browser_progress.mjs'])
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), name), join(scripts, name));
    // Module-loader control only. No config, CDP, credentials or app response.
    writeFileSync(join(scripts, 'browser.mjs'), `export async function runReadOnly() {
      const loaded = await import('./browser_external.mjs');
      if (typeof loaded.createExternalBrowserSession !== 'function') throw new Error('module_missing');
      return { result: 'PASS', phase: 'synthetic_loader_control', checks: {}, limitations: [] };
    }`);
    const result = spawnSync(process.execPath, [join(scripts, 'browser_external.mjs'), 'external-read-only', 'SYNTHETIC_MODULE_ONLY'],
      { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).phase, 'synthetic_loader_control');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// Trusted synthetic adapter controls only: these replace neither production
// readiness validation nor actual browser authentication/network responses.
function parentProtocol() {
  const value = protocol(), body = Buffer.from('SYNTHETIC PUBLIC WORKER SOURCE');
  const assetURL = LOCAL_ORIGIN + '/frontend_latest/markdown-worker.668dcd3bda774ac2.js';
  value.source.parentWorkerPolicy = { asset_url: assetURL, asset_sha256: hash(body), asset_bytes: body.length };
  const parent = { targetId: 'a'.repeat(32), browserContextId: 'b'.repeat(32), type: 'page', url: 'about:blank' };
  const worker = { targetId: 'c'.repeat(32), browserContextId: parent.browserContextId,
    parentFrameId: 'd'.repeat(32), type: 'worker', url: '' };
  const sdk = { url: () => assetURL }, sdkWorkers = [], targets = [];
  const frame = { id: worker.parentFrameId, url: 'about:blank' };
  const pageCDP = new EventEmitter();
  pageCDP.send = async method => {
    value.calls.push('page:' + method);
    if (method === 'Target.getTargetInfo') return { targetInfo: { ...parent } };
    assert.equal(method, 'Page.getFrameTree'); return { frameTree: { frame: { ...frame } } };
  };
  value.context.newCDPSession = async actualPage => { assert.equal(actualPage, value.page); return pageCDP; };
  value.page.workers = () => sdkWorkers;
  const send = value.diagnostic.send;
  value.diagnostic.send = async (method, args) => {
    if (method === 'Target.getTargets') return { targetInfos: targets.map(info => ({ ...info })) };
    if (method === 'Target.getTargetInfo') { assert.deepEqual(args, { targetId: worker.targetId }); return { targetInfo: { ...worker } }; }
    return send(method, args);
  };
  value.loginPage = () => { parent.url = frame.url = LOCAL_ORIGIN + '/'; value.page.url = () => parent.url; };
  value.createWorker = () => { targets.push(worker); value.diagnostic.emit('Target.targetCreated', { targetInfo: { ...worker } }); };
  value.knownWorker = () => { worker.url = assetURL; value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...worker } });
    sdkWorkers.push(sdk); value.page.emit('worker', sdk); };
  const request = { url: () => assetURL, method: () => 'GET', frame: () => value.parentFrame };
  value.parentFrame = {}; value.page.mainFrame = () => value.parentFrame;
  value.assetResponse = (changes = {}) => ({ url: () => assetURL, status: () => 200, request: () => request,
    allHeaders: async () => ({ 'content-type': 'text/javascript', 'content-length': String(body.length) }),
    body: async () => body, ...changes });
  value.sourceResponse = changes => value.page.emit('response', value.assetResponse(changes));
  return { ...value, worker, parent, frame, sdk, sdkWorkers, targets, body, assetURL, assetRequest: request };
}
const tick = () => new Promise(done => setImmediate(done));

test('owned HA startup worker stays pending until actual SDK/CDP/source proof and the post-entry barrier grants app authority', async () => {
  const value = parentProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.loginPage(); await session.beforeCredentials(); value.createWorker();
  assert.equal(session.evidence().gate_closed, false, 'owned emptyURL worker must remain bounded pending');
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  assert.equal(session.allowRequest({ url: () => LOCAL_ORIGIN + '/', method: () => 'GET' }, { fromFrame: false }), true);
  assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
  value.knownWorker(); value.sourceResponse(); await tick();
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  await session.beforeIngress(1000);
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  await session.afterIngress(1000);
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), true);
  assert.equal((await session.checkWorkers(true)).cdp_worker_targets, 1);
  assert.equal(session.allowRequest(wire('api/v1/music/resolve', 'POST', preview), { fromFrame: true, prefix }), true);
  await session.verifyBootstrap({ session: { body: { user_id: 'a'.repeat(32) } }, status: { body: { version: '2026.10.3' } } }, prefix);
  await session.cleanup();
});

function parentReady() {
  const { lease } = documents();
  return { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN, session_id: lease.session_id,
    configuration_A_sha256: lease.configuration_A_sha256, actual_core_version: '2026.10.3',
    worker_asset_path: '/frontend_latest/markdown-worker.668dcd3bda774ac2.js',
    worker_asset_sha256: 'e82decd9849c488ffed18e20ec6e4d2bf81eeb01c69bf6088e625baf917801ad', worker_asset_bytes: 95697,
    public_assets_readback_sha256: 'a'.repeat(64),
    egress_control_report_sha256: 'a76a9d2e175ad2c9d2d67f96a14af2c830953bcf931d4a3d34959df3cc961a8e',
    native_proxy_readback_sha256: lease.process_preflight_sha256, worker_policy_sha256: EXTERNAL_WORKER_POLICY_SHA256,
    observed_at: lease.observed_at };
}

test('fixed fifteen-field worker readiness binds Core/source/policy/current lease and actual preflight bytes', async () => {
  const { parseExternalParentWorker, validateExternalParentWorker } = await import('./browser_external.mjs');
  const { lease } = documents(), ready = parentReady();
  assert.equal(Object.keys(ready).length, 15); assert.deepEqual(parseExternalParentWorker(JSON.stringify(ready)), ready);
  assert.equal(validateExternalParentWorker(ready, lease, lease.process_preflight_sha256, now).asset_bytes, 95697);
  for (const damage of [v => { v.actual_core_version = '2026.10.4'; }, v => { v.worker_asset_path += '?query'; },
    v => { v.worker_asset_path = 'https://other.invalid' + v.worker_asset_path; }, v => { v.worker_asset_path += '#fragment'; },
    v => { v.worker_asset_sha256 = '0'.repeat(64); }, v => { v.worker_asset_bytes += 1; }, v => { v.worker_asset_bytes = '95697'; },
    v => { v.origin = 'https://127.0.0.1:28223'; }, v => { v.session_id = '0'.repeat(32); },
    v => { v.configuration_A_sha256 = '0'.repeat(64); }, v => { v.worker_policy_sha256 = '0'.repeat(64); },
    v => { v.egress_control_report_sha256 = '0'.repeat(64); }, v => { v.native_proxy_readback_sha256 = '0'.repeat(64); },
    v => { v.public_assets_readback_sha256 = ''; }, v => { v.observed_at = new Date(now - 300001).toISOString(); },
    v => { v.observed_at = new Date(now + 1).toISOString(); }, v => { v.extra = true; }, v => { delete v.worker_asset_path; }]) {
    const value = parentReady(); damage(value);
    assert.throws(() => validateExternalParentWorker(value, lease, lease.process_preflight_sha256, now));
  }
  assert.throws(() => validateExternalParentWorker(ready, lease, '0'.repeat(64), now));
  assert.throws(() => parseExternalParentWorker(JSON.stringify(ready).replace('{', '{"worker_asset_bytes":95697,')));
});

async function startParent(value = parentProtocol()) {
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.loginPage(); await session.beforeCredentials(); return { value, session };
}
async function proveParent(value, session) {
  value.createWorker(); assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
  value.knownWorker(); value.sourceResponse(); await tick();
}

test('parent creator proof rejects preauth/shared/service/extra/App/unknown frame or context workers synchronously', async () => {
  for (const kind of ['preauth', 'shared', 'service', 'sdk-service', 'extra', 'app', 'missing-frame', 'missing-context', 'context', 'target', 'url', 'page']) {
    const value = parentProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    let closed = 0; session.bindSocket({ close: () => { closed += 1; } });
    if (kind !== 'preauth') { value.loginPage(); await session.beforeCredentials(); }
    if (kind === 'shared') value.worker.type = 'shared_worker';
    if (kind === 'service') value.worker.type = 'service_worker';
    if (kind === 'app') value.worker.parentFrameId = 'e'.repeat(32);
    if (kind === 'missing-frame') delete value.worker.parentFrameId;
    if (kind === 'missing-context') delete value.worker.browserContextId;
    if (kind === 'context') value.worker.browserContextId = 'e'.repeat(32);
    if (kind === 'target') value.worker.targetId = 'not-a-target';
    if (kind === 'url') value.worker.url = LOCAL_ORIGIN + '/unknown-worker.js';
    if (kind === 'sdk-service') value.context.emit('serviceworker', { url: () => value.assetURL });
    else if (kind === 'page') value.context.emit('page', {});
    else { value.createWorker(); if (kind === 'extra') value.diagnostic.emit('Target.targetCreated', { targetInfo: { ...value.worker, targetId: 'e'.repeat(32) } }); }
    assert.equal(session.evidence().gate_closed, true, kind); assert.equal(closed, 1, kind);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
    await session.cleanup();
  }
});

test('owned page CDP provenance is captured before navigation and rechecked before credentials; unknown frames never grant', async () => {
  for (const kind of ['origin', 'page', 'context', 'frame', 'child', 'worker']) {
    const value = parentProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    assert.deepEqual(value.calls.filter(call => call.startsWith('page:')), ['page:Target.getTargetInfo', 'page:Page.getFrameTree']);
    value.loginPage();
    if (kind === 'origin') { value.parent.url = value.frame.url = 'https://outside.invalid/'; }
    if (kind === 'page') value.parent.targetId = 'e'.repeat(32);
    if (kind === 'context') value.parent.browserContextId = 'e'.repeat(32);
    if (kind === 'frame') value.frame.id = 'e'.repeat(32);
    if (kind === 'child') value.frame.parentId = 'e'.repeat(32);
    if (kind === 'worker') value.sdkWorkers.push(value.sdk);
    let credentials = 0;
    await assert.rejects(session.beforeCredentials().then(() => { credentials += 1; }));
    assert.equal(credentials, 0, kind); assert.equal(session.evidence().gate_closed, true); await session.cleanup();
  }
});

test('source verification needs actual one routed 200 response with bounded headers and exact decoded bytes/hash', async () => {
  const cases = [
    { status: () => 304 }, { url: () => LOCAL_ORIGIN + '/frontend_latest/markdown-worker.668dcd3bda774ac2.js?unexpected' },
    { request: () => ({}) }, { allHeaders: async () => ({}) },
    { allHeaders: async () => ({ 'content-type': 'text/html', 'content-length': '29' }) },
    { allHeaders: async () => ({ 'content-type': 'text/javascript', 'content-length': '999999' }) },
    { allHeaders: async () => ({ 'content-type': 'text/javascript', 'content-length': '1e2' }) },
    { allHeaders: async () => ({ 'content-type': 'text/javascript', 'content-length': '29', 'content-encoding': 'unknown' }) },
    { allHeaders: async () => { throw new Error('SYNTHETIC_PRIVATE_HEADERS'); } },
    { body: async () => Buffer.alloc(30) }, { body: async () => Buffer.alloc(29) },
    { body: async () => 'SYNTHETIC PUBLIC WORKER SOURCE' }, { body: async () => { throw new Error('SYNTHETIC_PRIVATE_BODY'); } },
  ];
  for (const changes of cases) {
    const { value, session } = await startParent(); value.createWorker();
    assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
    value.knownWorker(); value.sourceResponse(changes); await tick();
    assert.equal(session.evidence().gate_closed, true);
    await assert.rejects(session.beforeIngress(50));
    assert.equal(JSON.stringify(value.report).includes('SYNTHETIC_PRIVATE'), false); await session.cleanup();
  }
  for (const duplicate of ['request', 'response']) {
    const { value, session } = await startParent(); value.createWorker();
    assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
    value.knownWorker();
    if (duplicate === 'request') assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), false);
    else { value.sourceResponse(); value.sourceResponse(); }
    await tick(); assert.equal(session.evidence().gate_closed, true); await session.cleanup();
  }
});

test('pending SDK/CDP/source omissions, stale provenance and real source deadline cannot grant app requests', async t => {
  let monotonic = 100;
  t.mock.method(performance, 'now', () => monotonic);
  for (const missing of ['sdk', 'cdp-url', 'source', 'creation', 'stale', 'five-seconds']) {
    const { value, session } = await startParent();
    if (missing !== 'creation') value.createWorker();
    if (missing !== 'sdk') { value.sdkWorkers.push(value.sdk); value.page.emit('worker', value.sdk); }
    if (missing !== 'creation') {
      assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
      if (missing !== 'cdp-url') { value.worker.url = value.assetURL; value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...value.worker } }); }
      if (missing === 'stale') value.source.verify = () => { throw new Error('SYNTHETIC_PRIVATE_STALE'); };
      if (missing === 'five-seconds') monotonic += 5001;
      if (missing !== 'source') value.sourceResponse();
    }
    await assert.rejects(session.beforeIngress(15), missing);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
    assert.equal(session.evidence().gate_closed, true); await session.cleanup();
  }
});

test('cleanup or an exhausted sidebar budget discards late metadata and body completions without granting authority', async () => {
  for (const terminate of ['cleanup', 'sidebar']) {
    const { value, session } = await startParent(); value.createWorker();
    assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
    let resolveBody;
    value.knownWorker(); value.sourceResponse({ body: () => new Promise(done => { resolveBody = done; }) }); await tick();
    if (terminate === 'cleanup') await session.cleanup();
    else await assert.rejects(session.beforeIngress(15));
    const frozen = JSON.stringify(value.report.checks.external.parent_worker_startup);
    resolveBody(value.body); await tick();
    value.page.emit('worker', { get url() { assert.fail('late SDK fields must not be inspected'); } });
    value.page.emit('response', { get url() { assert.fail('late body fields must not be inspected'); } });
    assert.equal(JSON.stringify(value.report.checks.external.parent_worker_startup), frozen);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false); await session.cleanup();
  }
});

test('completed known parent worker may persist with the app iframe; any new or changed worker after startup is terminal', async () => {
  for (const change of ['new', 'sdk', 'frame', 'context', 'url', 'inventory', 'sdk-inventory']) {
    const { value, session } = await startParent(); await proveParent(value, session); await session.beforeIngress(1000); await session.afterIngress(1000);
    assert.equal((await session.checkWorkers(true)).sdk_workers, 1);
    if (change === 'new') value.diagnostic.emit('Target.targetCreated', { targetInfo: { ...value.worker, targetId: 'e'.repeat(32) } });
    else if (change === 'sdk') value.page.emit('worker', value.sdk);
    else if (change === 'inventory') { value.targets.push({ ...value.worker, targetId: 'e'.repeat(32) }); await assert.rejects(session.checkWorkers()); }
    else if (change === 'sdk-inventory') { value.sdkWorkers.push({ url: () => value.assetURL }); await assert.rejects(session.checkWorkers()); }
    else {
      if (change === 'frame') value.worker.parentFrameId = 'e'.repeat(32);
      if (change === 'context') value.worker.browserContextId = 'e'.repeat(32);
      if (change === 'url') value.worker.url += '#fragment';
      value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...value.worker } });
    }
    assert.equal(session.evidence().gate_closed, true, change); await session.cleanup();
  }
  const { value, session } = await startParent(); await session.beforeIngress(1000);
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  value.createWorker(); assert.equal(session.evidence().gate_closed, false);
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false); await session.cleanup();
});

test('SDK-before-CDP ordering and an actual same-target metadata read can complete source proof without invented association', async () => {
  for (const sdkFirst of [false, true]) {
    const { value, session } = await startParent();
    if (sdkFirst) { value.sdkWorkers.push(value.sdk); value.page.emit('worker', value.sdk); }
    value.createWorker(); value.worker.url = value.assetURL;
    if (!sdkFirst) { value.sdkWorkers.push(value.sdk); value.page.emit('worker', value.sdk); }
    assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
    value.sourceResponse(); await tick(); await session.beforeIngress(1000); await session.afterIngress(1000);
    const proof = value.report.checks.external.parent_worker_startup;
    assert.equal(proof.cdp_source_verified, true); assert.equal(proof.metadata_query_pending, false);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), true);
    await session.cleanup();
  }
});

test('pending same-target metadata cannot grant early or inspect a late result after timeout/cleanup', async () => {
  for (const close of ['budget', 'cleanup-before-send', 'cleanup-after-send']) {
    const { value, session } = await startParent(); value.createWorker();
    let resolve, queries = 0; const send = value.diagnostic.send;
    value.diagnostic.send = (method, args) => method !== 'Target.getTargetInfo' ? send(method, args)
      : (queries += 1, new Promise(done => { resolve = done; }));
    value.sdkWorkers.push(value.sdk); value.page.emit('worker', value.sdk);
    if (close === 'cleanup-before-send') await session.cleanup();
    else {
      assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
      value.worker.url = value.assetURL; value.diagnostic.emit('Target.targetInfoChanged', { targetInfo: { ...value.worker } });
      value.sourceResponse(); await tick();
      assert.equal(value.report.checks.external.parent_worker_startup.source_verified, true);
      assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
      if (close === 'budget') await assert.rejects(session.beforeIngress(15)); else await session.cleanup();
    }
    const frozen = JSON.stringify(value.report.checks.external.parent_worker_startup);
    if (resolve) resolve({ get targetInfo() { assert.fail('late metadata must not be inspected'); } });
    await tick(); assert.equal(JSON.stringify(value.report.checks.external.parent_worker_startup), frozen);
    assert.equal(queries, close === 'cleanup-before-send' ? 0 : 1); await session.cleanup();
  }
});

test('actual native readback must still be the pinned Core version before bootstrap certification', async () => {
  const { value, session } = await startParent(); await proveParent(value, session); await session.beforeIngress(1000); await session.afterIngress(1000);
  assert.equal(session.allowRequest(wire('api/v1/music/resolve', 'POST', preview), { fromFrame: true, prefix }), true);
  await assert.rejects(session.verifyBootstrap({ session: { body: { user_id: 'a'.repeat(32) } },
    status: { body: { version: '2026.10.4' } } }, prefix));
  assert.equal(session.evidence().gate_closed, true); await session.cleanup();
});

// R11: fixed diagnostic projections add no authority to failed inventory.
test('inventory failure identifies only fixed subcheck enums after fencing', async () => {
  const secret = 'SYNTHETIC_PRIVATE_ERROR_URL_TOKEN';
  for (const [kind, step, outcome] of [
    ['service', 'service_workers', 'check_failed'],
    ['targets', 'cdp_targets', 'check_failed'],
    ['evaluate', 'registrations_evaluate', 'evaluation_failed'],
    ['timeout', 'registrations_evaluate', 'timeout'],
    ['invalid', 'registrations_validate', 'service_worker_api_missing'],
    ['nonzero', 'registrations_validate', 'registrations_present'],
    ['malformed', 'registrations_validate', 'malformed_result'],
  ]) {
    const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    let reads = 0, closed = 0; session.bindSocket({ close() { closed += 1; } });
    if (kind === 'service') value.context.serviceWorkers = () => [{}];
    if (kind === 'targets') value.diagnostic.send = async () => { throw new Error(secret); };
    if (kind === 'evaluate') value.page.evaluate = async () => { throw new Error(secret); };
    if (kind === 'timeout') value.page.evaluate = async () => { const error = new Error(secret); error.code = 'native_deadline'; throw error; };
    if (kind === 'invalid') value.page.evaluate = async () => ({ outcome: 'INVALID_CONTEXT', reason: 'service_worker_api_missing' });
    if (kind === 'nonzero') value.page.evaluate = async () => ({ outcome: 'PASS', registrations: 1 });
    if (kind === 'malformed') value.page.evaluate = async () => ({ outcome: secret, registrations: secret, reason: secret });
    await assert.rejects(session.beforeCredentials().then(() => { reads += 1; }));
    assert.deepEqual(value.report.checks.external.worker_inventory_failure, { step, outcome });
    assert.equal(closed, 1); assert.equal(reads, 0); assert.equal(session.evidence().gate_closed, true);
    assert.equal(JSON.stringify(value.report).includes(secret), false);
    await assert.rejects(session.beforeCredentials());
    assert.deepEqual(value.report.checks.external.worker_inventory_failure, { step, outcome });
    await session.cleanup();
  }
});

test('registration inspector reports fixed invalid-context reason and exact zero-registration success', async () => {
  const run = async scope => JSON.parse(JSON.stringify(await runInNewContext('(' + inspectExternalRegistrations.toString() + ')()', scope)));
  const scope = { location: { origin: LOCAL_ORIGIN }, isSecureContext: true, navigator: { serviceWorker: { getRegistrations: async () => [] } } };
  assert.deepEqual(await run(scope), { outcome: 'PASS', registrations: 0 });
  for (const [change, reason] of [
    [s => { s.location = { origin: 'https://invalid.example' }; }, 'origin_mismatch'],
    [s => { s.isSecureContext = false; }, 'insecure_context'],
    [s => { s.navigator = {}; }, 'service_worker_api_missing'],
    [s => { s.navigator = { serviceWorker: {} }; }, 'get_registrations_missing'],
  ]) { const damaged = { ...scope }; change(damaged); assert.deepEqual(await run(damaged), { outcome: 'INVALID_CONTEXT', reason }); }
});

test('parent inspection reports fixed failing step after fencing without exposing page values', async () => {
  for (const kind of ['target_info', 'frame_tree', 'url_binding', 'identity_continuity']) {
    const value = parentProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    value.loginPage(); let reads = 0, closed = 0;
    session.bindSocket({ close() { closed += 1; } });
    const cdp = await value.context.newCDPSession(value.page), send = cdp.send;
    cdp.send = async method => {
      if (kind === 'target_info' && method === 'Target.getTargetInfo' || kind === 'frame_tree' && method === 'Page.getFrameTree') throw new Error('SYNTHETIC_PRIVATE_TARGET');
      return send(method);
    };
    if (kind === 'url_binding') value.frame.url = LOCAL_ORIGIN + '/SYNTHETIC_PRIVATE_QUERY';
    if (kind === 'identity_continuity') value.frame.id = 'e'.repeat(32);
    await assert.rejects(session.beforeCredentials().then(() => { reads += 1; }));
    assert.deepEqual(value.report.checks.external.parent_inspection_failure, { step: kind,
      outcome: ['target_info', 'frame_tree'].includes(kind) ? 'evaluation_failed' : 'check_failed' });
    assert.equal(session.evidence().gate_closed, true); assert.equal(reads, 0); assert.equal(closed, 1);
    assert.equal(JSON.stringify(value.report).includes('SYNTHETIC_PRIVATE'), false); await session.cleanup();
  }
});

test('registration evaluation context-destroyed diagnostic is bounded and grants no authority', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.page.evaluate = async () => { throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.'); };
  await assert.rejects(session.beforeCredentials());
  assert.deepEqual(value.report.checks.external.worker_inventory_failure, { step: 'registrations_evaluate', outcome: 'context_destroyed' });
  assert.equal(session.evidence().gate_closed, true); await session.cleanup();
});

test('parent worker rejection records its first admission and creator condition without raw values', async () => {
  for (const [kind, step] of [['late', 'admission'], ['frame', 'creator_frame'], ['context', 'creator_context'], ['url', 'worker_url'], ['target', 'target_id']]) {
    const value = parentProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    value.loginPage(); await session.beforeCredentials();
    if (kind === 'late') { await proveParent(value, session); await session.beforeIngress(1000); await session.afterIngress(1000); }
    if (kind === 'frame') value.worker.parentFrameId = 'e'.repeat(32);
    if (kind === 'context') delete value.worker.browserContextId;
    if (kind === 'url') value.worker.url = LOCAL_ORIGIN + '/SYNTHETIC_PRIVATE_WORKER';
    if (kind === 'target') value.worker.targetId = 'SYNTHETIC_PRIVATE_TARGET';
    let socketClosed = 0; session.bindSocket({ close() { socketClosed += 1; } });
    value.createWorker();
    assert.equal(session.evidence().gate_closed, true); assert.equal(socketClosed, 1);
    const failure = value.report.checks.external.parent_worker_failure;
    assert.equal(failure.event, 'created'); assert.equal(failure.step, step);
    assert.equal(failure.startup_open, kind !== 'late');
    assert.equal(failure.startup_window_closed, kind === 'late');
    assert.equal(failure.candidate_present, kind === 'late');
    if (kind === 'frame') assert.equal(failure.matches.parent_frame, false);
    if (kind === 'context') assert.equal(failure.fields.browser_context, 'missing');
    if (kind === 'url') assert.equal(failure.url_category, 'other');
    assert.equal(JSON.stringify(failure).includes('SYNTHETIC_PRIVATE'), false);
    const first = JSON.stringify(failure);
    value.knownWorker(); await session.cleanup();
    assert.equal(JSON.stringify(value.report.checks.external.parent_worker_failure), first);
  }
});

test('external shutdown reports protocol and disconnect stages without claiming normal process exit', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  const result = await session.cleanup();
  assert.deepEqual(result.shutdown_stages, { protocol_requested: true, protocol_acknowledged: true,
    disconnect_requested: true, disconnect_acknowledged: true, connected_before_protocol: true,
    connected_after_protocol: false, connected_after_disconnect: false, native_disconnect_observed: true,
    owned_page_verified: true, owned_page_close_requested: true, owned_page_close_completed: true, owned_page_closed: true });
  assert.equal(result.process_exit, 'REQUIRES_ROOT_READBACK');
  assert.equal(value.calls.filter(method => method === 'Browser.close').length, 1);
});

test('parent metadata query rejection projects its branch after fencing and admits no app authority', async () => {
  const value = parentProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.loginPage(); await session.beforeCredentials();
  const send = value.diagnostic.send;
  value.diagnostic.send = async (method, args) => {
    if (method === 'Target.getTargetInfo') throw new Error('SYNTHETIC_PRIVATE_QUERY_ERROR');
    return send(method, args);
  };
  value.sdkWorkers.push(value.sdk); value.page.emit('worker', value.sdk); value.createWorker(); await tick();
  const failure = value.report.checks.external.parent_worker_failure;
  assert.equal(failure.event, 'query'); assert.equal(failure.step, 'metadata_query');
  assert.equal(failure.candidate_present, true); assert.equal(failure.sdk_associated, true);
  assert.equal(session.evidence().gate_closed, true); assert.equal(JSON.stringify(failure).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  await session.cleanup();
});

test('panel entry holds private app reads until one post-click parent worker is fully proven', async () => {
  const { value, session } = await startParent(); await session.beforeIngress(1000);
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false);
  value.parentFrame.parentFrame = () => null;
  const child = { parentFrame: () => value.parentFrame };
  const guard = createNativeRequestGuard({ requestAllowed: (request, scope) => session.allowRequest(request, scope),
    beforeAllowed: (request, scope) => session.holdRequest(request, scope) });
  guard.bindParent(value.parentFrame); guard.armIngress();
  const routed = (endpoint, document = false) => {
    const actions = [], request = { ...wire(endpoint), frame: () => child, resourceType: () => document ? 'document' : 'fetch', isNavigationRequest: () => document };
    return { request: () => request, actions, continue: async () => actions.push('continue'), abort: async () => actions.push('abort') };
  };
  const document = routed('', true); await guard.handle(document); assert.deepEqual(document.actions, ['continue']);
  const asset = routed('assets/app.js'); await guard.handle(asset); assert.deepEqual(asset.actions, ['continue']);
  const read = routed('api/v1/session'), pending = guard.handle(read); await tick(); assert.deepEqual(read.actions, []);
  value.createWorker(); assert.equal(session.evidence().gate_closed, false);
  assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
  value.knownWorker(); value.sourceResponse(); await tick(); assert.deepEqual(read.actions, []);
  await session.afterIngress(900); await pending; assert.deepEqual(read.actions, ['continue']);
  assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), true);
  value.diagnostic.emit('Target.targetCreated', { targetInfo: { ...value.worker, targetId: 'f'.repeat(32) } });
  assert.equal(session.evidence().gate_closed, true); await session.cleanup();
});

test('held private reads reject on missing worker, cleanup or bounded queue overflow without forwarding', async () => {
  for (const terminate of ['deadline', 'cleanup', 'overflow']) {
    const { session } = await startParent(); await session.beforeIngress(terminate === 'deadline' ? 15 : 1000);
    let forwarded = 0;
    const pending = session.holdRequest(wire('api/v1/session'), { fromFrame: true, prefix })
      .then(() => { forwarded += 1; return 'forwarded'; }, () => 'rejected');
    await tick(); assert.equal(forwarded, 0);
    const extra = [];
    if (terminate === 'cleanup') await session.cleanup();
    else if (terminate === 'overflow') for (let index = 0; index < 16; index += 1)
      extra.push(session.holdRequest(wire('api/v1/status'), { fromFrame: true, prefix }).then(() => 'forwarded', () => 'rejected'));
    assert.equal(await pending, 'rejected'); assert.equal(forwarded, 0);
    if (extra.length) assert.ok((await Promise.all(extra)).every(result => result === 'rejected'));
    assert.equal(session.evidence().gate_closed, true); await session.cleanup();
  }
});

test('held private reads never release on wrong creator, source or lease prefix and early writes are not queued', async () => {
  for (const failure of ['creator', 'source', 'write', 'prefix']) {
    const { value, session } = await startParent(); await session.beforeIngress(1000);
    const read = session.holdRequest(wire('api/v1/session'), { fromFrame: true, prefix }).then(() => 'forwarded', () => 'rejected');
    await tick();
    if (failure === 'write') await assert.rejects(session.holdRequest(wire('api/v1/assignments', 'POST', '{}'), { fromFrame: true, prefix }));
    else if (failure === 'prefix') await assert.rejects(session.holdRequest(wire('api/v1/session'), { fromFrame: true, prefix: '/api/hassio_ingress/OTHER/' }));
    else {
      if (failure === 'creator') value.worker.parentFrameId = 'e'.repeat(32);
      value.createWorker();
      if (failure === 'source') {
        assert.equal(session.allowRequest(value.assetRequest, { fromFrame: false }), true);
        value.knownWorker(); value.sourceResponse({ body: async () => Buffer.alloc(value.body.length) }); await tick();
      }
    }
    assert.equal(await read, 'rejected'); assert.equal(session.evidence().gate_closed, true);
    assert.equal(session.allowRequest(wire('api/v1/session'), { fromFrame: true, prefix }), false); await session.cleanup();
  }
});

test('native Browser.close acknowledgment alone cannot start SDK disconnect before the native event', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 100 });
  const send = value.diagnostic.send;
  value.diagnostic.send = async (method, args) => method === 'Browser.close' ? {} : send(method, args);
  const pending = session.cleanup(); await tick();
  assert.equal(value.calls.includes('sdk-disconnect'), false, 'transport must stay connected after ACK while native shutdown is pending');
  value.nativeDisconnect();
  const result = await pending;
  assert.equal(result.native_disconnect_confirmed, true); assert.equal(result.cleanup_confirmed, true);
  assert.equal(value.calls.filter(call => call === 'sdk-disconnect').length, 1);
  assert.equal(value.browser.listenerCount('disconnected'), 0);
});

test('missing native disconnect stays unconfirmed even if SDK disconnects and a late event arrives', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 20 });
  const send = value.diagnostic.send;
  value.diagnostic.send = async (method, args) => method === 'Browser.close' ? {} : send(method, args);
  const result = await session.cleanup();
  assert.equal(result.protocol_close_confirmed, true); assert.equal(result.sdk_disconnected, true);
  assert.equal(result.native_disconnect_confirmed, false); assert.equal(result.cleanup_confirmed, false);
  assert.equal(value.browser.listenerCount('disconnected'), 0);
  const frozen = JSON.stringify(result); value.browser.emit('disconnected'); await tick();
  assert.equal(JSON.stringify(result), frozen); assert.equal(await session.cleanup(), result);
});

test('cleanup closes only the verified owned page before requesting whole-browser shutdown', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  const result = await session.cleanup();
  assert.equal(value.page.isClosed(), true);
  assert.ok(value.calls.indexOf('owned-page-close') >= 0);
  assert.ok(value.calls.indexOf('owned-page-close') < value.calls.indexOf('Browser.close'));
  assert.equal(result.owned_page_close_completed, true);
  assert.equal(result.cleanup_confirmed, true);
  assert.equal(result.process_exit, 'REQUIRES_ROOT_READBACK');
});

test('verified last-page closure can confirm native disconnection without fabricating Browser.close acknowledgment', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 40 });
  const close = value.page.close;
  value.page.close = async options => { await close(options); value.nativeDisconnect(); };
  const result = await session.cleanup();
  assert.equal(result.owned_page_close_completed, true);
  assert.equal(result.native_disconnect_confirmed, true);
  assert.equal(result.protocol_close_confirmed, false);
  assert.equal(value.calls.includes('Browser.close'), false);
  assert.equal(result.cleanup_confirmed, true);
  assert.equal(result.reason, 'external_owned_page_close_native_disconnect_and_sdk_disconnect');
});

test('cleanup never enumerates or closes unfamiliar pages and does not promote already-closed page state', async () => {
  for (const kind of ['wrong-context', 'wrong-browser', 'already-closed']) {
    const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    value.context.pages = () => assert.fail('cleanup must use the verified reference, not enumerate pages');
    if (kind === 'wrong-context') value.page.context = () => ({});
    if (kind === 'wrong-browser') value.context.browser = () => ({});
    if (kind === 'already-closed') value.page.isClosed = () => true;
    const result = await session.cleanup();
    assert.equal(value.calls.includes('owned-page-close'), false);
    assert.equal(value.calls.filter(call => call === 'Browser.close').length, 1);
    assert.equal(result.owned_page_close_completed, false);
    assert.equal(result.protocol_close_confirmed, true); assert.equal(result.cleanup_confirmed, true);
  }
});

test('failed or late owned-page close cannot supply last-page proof or extend the shared close budget', async () => {
  for (const kind of ['failed', 'late', 'not-closed']) {
    const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 20 });
    const close = value.page.close; let finish;
    value.page.close = async options => {
      if (kind === 'failed') { value.nativeDisconnect(); throw new Error('SYNTHETIC_CLOSE_FAILED'); }
      if (kind === 'late') await new Promise(done => { finish = done; });
      if (kind !== 'not-closed') await close(options);
    };
    const result = await session.cleanup();
    assert.equal(result.cleanup_confirmed, false); assert.equal(result.owned_page_close_completed, false);
    assert.equal(result.protocol_close_confirmed, false); assert.equal(value.calls.includes('Browser.close'), false);
    assert.equal(result.process_exit, 'REQUIRES_ROOT_READBACK');
    const frozen = JSON.stringify(result); finish?.(); value.nativeDisconnect(); await tick();
    assert.equal(JSON.stringify(result), frozen); assert.equal(value.calls.includes('Browser.close'), false);
    assert.equal(value.browser.listenerCount('disconnected'), 0);
  }
});

test('last-page native exit after a lost Browser.close response retains real page proof and never invents ACK', async () => {
  const value = protocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 100 });
  const send = value.diagnostic.send;
  value.diagnostic.send = async (method, args) => {
    if (method !== 'Browser.close') return send(method, args);
    value.nativeDisconnect(); throw new Error('SYNTHETIC_TRANSPORT_CLOSED');
  };
  const result = await session.cleanup();
  assert.equal(result.owned_page_close_completed, true); assert.equal(result.native_disconnect_confirmed, true);
  assert.equal(result.protocol_close_confirmed, false); assert.equal(result.cleanup_confirmed, true);
  assert.equal(result.reason, 'external_owned_page_close_native_disconnect_and_sdk_disconnect');
});

function nativeWindowProtocol({ initialState = 'normal', transitionReads = 0, neverComplete = false } = {}) {
  const value = parentProtocol(), send = value.diagnostic.send;
  let bounds = { left: 10, top: 20, width: 1000, height: 700, windowState: initialState }, pending, remaining;
  const operations = [];
  value.diagnostic.send = async (method, args) => {
    if (method === 'Browser.getWindowForTarget') {
      assert.deepEqual(args, { targetId: value.parent.targetId }); operations.push(method);
      return { windowId: 9, bounds: { ...bounds } };
    }
    if (method === 'Browser.getWindowBounds') {
      assert.deepEqual(args, { windowId: 9 }); operations.push(method);
      if (pending && !neverComplete && remaining-- <= 0) { bounds.windowState = pending; pending = undefined; }
      return { bounds: { ...bounds } };
    }
    if (method === 'Browser.setWindowBounds') {
      assert.equal(args.windowId, 9); operations.push({ ...args.bounds });
      const state = args.bounds.windowState ?? 'normal';
      // Chromium156 BrowserHandler::SetWindowBounds rejects these transitions.
      if (state === 'maximized') assert.ok(!['minimized', 'fullscreen'].includes(bounds.windowState));
      if (state === 'fullscreen') assert.notEqual(bounds.windowState, 'minimized');
      if (state === 'minimized') assert.notEqual(bounds.windowState, 'fullscreen');
      if (state !== bounds.windowState) {
        pending = state; remaining = transitionReads;
        if (!transitionReads && !neverComplete) { bounds.windowState = pending; pending = undefined; }
      } else bounds = { ...bounds, ...args.bounds };
      return {};
    }
    return send(method, args);
  };
  return { ...value, operations };
}

test('native visibility control touches only the proven parent window and restores original bounds', async () => {
  const value = nativeWindowProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.loginPage();
  assert.equal(session.assertSource(), undefined);
  assert.deepEqual(await session.ownedWindowControl('minimize'), { action: 'minimize', owned_identity_verified: true, state: 'minimized' });
  assert.deepEqual(await session.ownedWindowControl('restore'), { action: 'restore', owned_identity_verified: true, state: 'normal' });
  assert.deepEqual(value.operations.filter(row => typeof row === 'object'), [
    { windowState: 'minimized' }, { windowState: 'normal' }, { left: 10, top: 20, width: 1000, height: 700 },
  ]);
  await session.cleanup();
});

test('native window control rejects wrong identity, unknown actions, missing ownership and stale source before commands', async () => {
  for (const damage of [v => { v.parent.targetId = 'e'.repeat(32); }, v => { v.parent.browserContextId = 'e'.repeat(32); },
    v => { v.frame.id = 'e'.repeat(32); }, v => { v.source.verify = () => { throw new Error('stale'); }; }]) {
    const value = nativeWindowProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    value.loginPage(); damage(value); await assert.rejects(session.ownedWindowControl('minimize'));
    assert.deepEqual(value.operations, []); await session.cleanup();
  }
  const value = nativeWindowProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  await assert.rejects(session.ownedWindowControl('arbitrary')); assert.deepEqual(value.operations, []); await session.cleanup();
  const plain = protocol(), missing = await connectVerifiedExternalBrowser(plain.chromium, plain.source, plain.report);
  await assert.rejects(missing.ownedWindowControl('minimize')); await missing.cleanup();
});

test('native window deadline and cleanup fence late replies without a later minimize or restore', async () => {
  const value = nativeWindowProtocol(), send = value.diagnostic.send;
  let release;
  value.diagnostic.send = (method, args) => method === 'Browser.getWindowForTarget'
    ? new Promise(done => { release = () => done({ windowId: 9, bounds: { left: 0, top: 0, width: 1000, height: 700, windowState: 'normal' } }); })
    : send(method, args);
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 20 });
  value.loginPage(); await assert.rejects(session.ownedWindowControl('minimize'));
  await session.cleanup(); release(); await tick();
  assert.deepEqual(value.operations, []); assert.throws(() => session.assertSource());
  await assert.rejects(session.ownedWindowControl('restore'));
});

// Real protocol restrictions and asynchronous observations are synthetic controls;
// Root's separate same-pinned-Chromium run remains mandatory.
for (const initialState of ['normal', 'maximized', 'fullscreen']) {
  test(`owned native ${initialState} window normalizes restricted transitions and awaits observed states`, async () => {
    const value = nativeWindowProtocol({ initialState, transitionReads: 1 });
    const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
    value.loginPage();
    try {
      assert.equal((await session.ownedWindowControl('minimize')).state, 'minimized');
      assert.equal((await session.ownedWindowControl('restore')).state, initialState);
      const states = value.operations.filter(row => typeof row === 'object' && row.windowState).map(row => row.windowState);
      assert.deepEqual(states, initialState === 'normal' ? ['minimized', 'normal']
        : initialState === 'maximized' ? ['minimized', 'normal', 'maximized'] : ['normal', 'minimized', 'normal', 'fullscreen']);
    } finally { await session.cleanup(); }
  });
}

test('a maximized window must leave minimized before requesting its original state', async () => {
  const value = nativeWindowProtocol({ initialState: 'maximized' });
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.loginPage();
  try {
    await session.ownedWindowControl('minimize');
    assert.equal((await session.ownedWindowControl('restore')).state, 'maximized');
  } finally { await session.cleanup(); }
});

test('a state ACK that never becomes normal cannot retry commands or extend the shared restore deadline', async () => {
  const value = nativeWindowProtocol({ initialState: 'maximized' });
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 60 });
  value.loginPage(); await session.ownedWindowControl('minimize');
  const send = value.diagnostic.send; let restoring = false, late = false;
  value.diagnostic.send = async (method, args) => {
    if (method === 'Browser.setWindowBounds' && args.bounds.windowState === 'normal') restoring = true;
    const result = await send(method, args);
    if (restoring && method === 'Browser.getWindowBounds' && !late) return { bounds: { ...result.bounds, windowState: 'minimized' } };
    return result;
  };
  const started = performance.now(); await assert.rejects(session.ownedWindowControl('restore'));
  assert.ok(performance.now() - started < 500);
  assert.deepEqual(value.operations.filter(row => typeof row === 'object'), [{ windowState: 'minimized' }, { windowState: 'normal' }]);
  await session.cleanup(); const frozen = JSON.stringify(value.operations); late = true;
  await new Promise(done => setTimeout(done, 60));
  assert.equal(JSON.stringify(value.operations), frozen); assert.throws(() => session.assertSource());
});

test('source loss after a state read prevents the next native command', async () => {
  const value = nativeWindowProtocol({ initialState: 'maximized' });
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.loginPage(); await session.ownedWindowControl('minimize');
  const send = value.diagnostic.send; let restoring = false;
  value.diagnostic.send = async (method, args) => {
    if (method === 'Browser.setWindowBounds' && args.bounds.windowState === 'normal') restoring = true;
    const result = await send(method, args);
    if (restoring && method === 'Browser.getWindowBounds') value.source.verify = () => { throw new Error('SYNTHETIC_STALE'); };
    return result;
  };
  await assert.rejects(session.ownedWindowControl('restore'));
  assert.deepEqual(value.operations.filter(row => typeof row === 'object'), [{ windowState: 'minimized' }, { windowState: 'normal' }]);
  await session.cleanup();
});

test('a page moved to another native window is rejected before any state command or unknown-window read', async () => {
  const value = nativeWindowProtocol(), session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report);
  value.loginPage(); await session.ownedWindowControl('minimize');
  const send = value.diagnostic.send;
  value.diagnostic.send = async (method, args) => {
    const result = await send(method, args);
    return method === 'Browser.getWindowForTarget' ? { ...result, windowId: 10 } : result;
  };
  const before = value.operations.length; await assert.rejects(session.ownedWindowControl('restore'));
  assert.deepEqual(value.operations.slice(before), ['Browser.getWindowForTarget']);
  await session.cleanup();
});

test('window evidence distinguishes rejected normalization from ACK with a different observed state and stays immutable', async () => {
  for (const kind of ['rejected', 'wrong_state']) {
    const value = nativeWindowProtocol({ initialState: 'maximized' });
    const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 80 });
    value.loginPage(); await session.ownedWindowControl('minimize');
    const send = value.diagnostic.send; let normal = false;
    value.diagnostic.send = async (method, args) => {
      if (method === 'Browser.setWindowBounds' && args.bounds.windowState === 'normal') {
        if (kind === 'rejected') throw new Error('PRIVATE_PROTOCOL_DETAILS_MUST_NOT_ESCAPE');
        normal = true;
      }
      const result = await send(method, args);
      return normal && method === 'Browser.getWindowBounds' ? { bounds: { ...result.bounds, windowState: 'fullscreen' } } : result;
    };
    await assert.rejects(session.ownedWindowControl('restore'));
    const evidence = value.report.checks.external.window_controls;
    assert.equal(evidence.length, 2); const restore = evidence[1];
    assert.equal(restore.action, 'restore'); assert.equal(restore.phase, 'restore_normalization');
    assert.equal(restore.original_state, 'maximized'); assert.equal(restore.lookup_state, 'minimized');
    assert.equal(restore.transitions.length, 1); const transition = restore.transitions[0];
    assert.equal(transition.requested, 'normal'); assert.equal(transition.acknowledged, kind !== 'rejected');
    assert.equal(transition.first_observed, kind === 'rejected' ? 'not_read' : 'fullscreen');
    assert.equal(transition.last_observed, kind === 'rejected' ? 'not_read' : 'fullscreen');
    assert.ok(transition.reads <= 100); assert.equal(JSON.stringify(evidence).includes('PRIVATE_PROTOCOL_DETAILS'), false);
    await session.cleanup(); const frozen = JSON.stringify(evidence);
    await new Promise(done => setTimeout(done, 60)); assert.equal(JSON.stringify(evidence), frozen);
  }
});

test('late state ACK cannot rewrite published window evidence or trigger a later command', async () => {
  const value = nativeWindowProtocol({ initialState: 'maximized' });
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 60 });
  value.loginPage(); await session.ownedWindowControl('minimize');
  const send = value.diagnostic.send; let finish, normalRequests = 0;
  value.diagnostic.send = (method, args) => {
    if (method === 'Browser.setWindowBounds' && args.bounds.windowState === 'normal') {
      normalRequests += 1; return new Promise(done => { finish = () => done({}); });
    }
    return send(method, args);
  };
  await assert.rejects(session.ownedWindowControl('restore'));
  const evidence = value.report.checks.external.window_controls, frozen = JSON.stringify(evidence);
  assert.equal(evidence[1].transitions[0].acknowledged, false); assert.equal(evidence[1].outcome, 'timeout');
  await session.cleanup(); const commands = JSON.stringify(value.operations);
  finish(); await tick(); assert.equal(JSON.stringify(evidence), frozen);
  assert.equal(JSON.stringify(value.operations), commands); assert.equal(normalRequests, 1);
});

test('captured native restore ACK that already restores saved maximized state completes without another command', async () => {
  const value = nativeWindowProtocol({ initialState: 'maximized' });
  const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 100 });
  value.loginPage(); await session.ownedWindowControl('minimize');
  const send = value.diagnostic.send; let normal = false;
  value.diagnostic.send = async (method, args) => {
    if (method === 'Browser.setWindowBounds' && args.bounds.windowState === 'normal') normal = true;
    const result = await send(method, args);
    return normal && method === 'Browser.getWindowBounds' ? { bounds: { ...result.bounds, windowState: 'maximized' } } : result;
  };
  try {
    assert.deepEqual(await session.ownedWindowControl('restore'), { action: 'restore', owned_identity_verified: true, state: 'maximized' });
    assert.deepEqual(value.operations.filter(row => typeof row === 'object'), [{ windowState: 'minimized' }, { windowState: 'normal' }]);
    const restore = value.report.checks.external.window_controls[1];
    assert.equal(restore.outcome, 'complete'); assert.equal(restore.transitions.length, 1);
    assert.deepEqual(restore.transitions[0], { requested: 'normal', acknowledged: true, first_observed: 'maximized', last_observed: 'maximized', reads: 1 });
  } finally { await session.cleanup(); }
});

test('saved-maximized restoration does not admit maximized as an intermediate for other saved states', async () => {
  for (const initialState of ['normal', 'fullscreen']) {
    const value = nativeWindowProtocol({ initialState });
    const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 80 });
    value.loginPage(); await session.ownedWindowControl('minimize');
    const send = value.diagnostic.send; let restoring = false;
    value.diagnostic.send = async (method, args) => {
      if (method === 'Browser.setWindowBounds' && args.bounds.windowState === 'normal') restoring = true;
      const result = await send(method, args);
      return restoring && method === 'Browser.getWindowBounds' ? { bounds: { ...result.bounds, windowState: 'maximized' } } : result;
    };
    await assert.rejects(session.ownedWindowControl('restore'));
    const restore = value.report.checks.external.window_controls[1];
    assert.equal(restore.outcome, 'timeout'); assert.equal(restore.transitions.length, 1);
    assert.equal(restore.transitions[0].requested, 'normal'); assert.equal(restore.transitions[0].last_observed, 'maximized');
    await session.cleanup();
  }
});

test('a saved-maximized read cannot grant completion after source loss or a late reply', async () => {
  for (const kind of ['source_lost', 'late']) {
    const value = nativeWindowProtocol({ initialState: 'maximized' });
    const session = await connectVerifiedExternalBrowser(value.chromium, value.source, value.report, { operationTimeoutMs: 80 });
    value.loginPage(); await session.ownedWindowControl('minimize');
    const send = value.diagnostic.send; let restoring = false, finish;
    value.diagnostic.send = async (method, args) => {
      if (method === 'Browser.setWindowBounds' && args.bounds.windowState === 'normal') restoring = true;
      const result = await send(method, args);
      if (restoring && method === 'Browser.getWindowBounds') {
        if (kind === 'source_lost') value.source.verify = () => { throw new Error('SYNTHETIC_STALE'); };
        const readback = { bounds: { ...result.bounds, windowState: 'maximized' } };
        return kind === 'late' ? new Promise(done => { finish = () => done(readback); }) : readback;
      }
      return result;
    };
    await assert.rejects(session.ownedWindowControl('restore'));
    const evidence = value.report.checks.external.window_controls, frozen = JSON.stringify(evidence);
    assert.notEqual(evidence[1].outcome, 'complete');
    assert.deepEqual(value.operations.filter(row => typeof row === 'object'), [{ windowState: 'minimized' }, { windowState: 'normal' }]);
    await session.cleanup(); finish?.(); await tick(); assert.equal(JSON.stringify(evidence), frozen);
    assert.throws(() => session.assertSource());
  }
});
