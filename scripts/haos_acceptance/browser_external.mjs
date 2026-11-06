/** Owned external Chromium bootstrap only. Importing performs no I/O. */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, PROXY_ORIGIN, hash, ingressPrefix, readBoundedFile, readOnlyRequestAllowed } from './browser_inputs.mjs';
import { withinDeadline } from './browser_progress.mjs';
import { FileReviewAuthority, isFileReviewAppRequest } from './browser_file_review.mjs';
import { MINIMUM_CORE_VERSION, reviewedCoreProfile } from './browser_core_profiles.mjs';

// Exact installed Playwright1.64.1 serviceWorkers:'block' policy, including its
// undefined resolution. This is the sole permitted prototype policy here.
export const EXTERNAL_WORKER_POLICY = "\nif (self.ServiceWorkerContainer) ServiceWorkerContainer.prototype.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };\n";
export const EXTERNAL_WORKER_POLICY_SHA256 = hash(EXTERNAL_WORKER_POLICY);
const LEASE_FIELDS = ['schema_version', 'fixture', 'synthetic', 'origin', 'session_id', 'configuration_A_sha256',
  'actual_candidate_image_manifest_digest', 'actual_bridge_archive_sha256', 'admin_A_user_id_sha256', 'ingress_prefix_sha256',
  'certificate_sha256', 'controller_pid', 'controller_start_ticks', 'chrome_pid', 'chrome_start_ticks', 'executable_sha256',
  'profile_basename', 'fresh_profile', 'cdp_port', 'cdp_endpoint', 'proxy_port', 'argv_sha256', 'worker_policy_sha256',
  'process_preflight_sha256', 'observed_at'];
const PREFLIGHT_FIELDS = ['schema_version', 'fixture', 'synthetic', 'origin', 'session_id', 'controller_pid', 'proxy_port',
  'connect_authority', 'raw_connect_only', 'outside_forwarded', 'same_policy_sha256', 'same_policy_report_sha256',
  'same_policy_positive_control_verified', 'same_policy_registrations', 'same_policy_sdk_workers', 'same_policy_cdp_workers',
  'same_policy_worker_script_requests', 'same_policy_escape_hits', 'observed_at'];
export const PARENT_WORKER_ASSET_PATH = reviewedCoreProfile(MINIMUM_CORE_VERSION).worker_asset_path;
export const PARENT_WORKER_ASSET_SHA256 = reviewedCoreProfile(MINIMUM_CORE_VERSION).worker_asset_sha256;
export const PARENT_WORKER_ASSET_BYTES = reviewedCoreProfile(MINIMUM_CORE_VERSION).worker_asset_bytes;
export const WORKER_EGRESS_REPORT_SHA256 = 'a76a9d2e175ad2c9d2d67f96a14af2c830953bcf931d4a3d34959df3cc961a8e';
const PARENT_WORKER_FIELDS = ['schema_version', 'fixture', 'synthetic', 'origin', 'session_id', 'configuration_A_sha256',
  'actual_core_version', 'worker_asset_path', 'worker_asset_sha256', 'worker_asset_bytes', 'public_assets_readback_sha256',
  'egress_control_report_sha256', 'native_proxy_readback_sha256', 'worker_policy_sha256', 'observed_at'];
// Used only after authority has been fenced. Never retain exception text.
function evaluationFailure(error, fallback = 'evaluation_failed') {
  try {
    if (error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'native_deadline') return 'timeout';
    const message = error && Object.getOwnPropertyDescriptor(error, 'message')?.value;
    if (typeof message === 'string' && message.length <= 256
      && /^(?:page\.evaluate: )?Execution context was destroyed, most likely because of a navigation\.?$/.test(message)) return 'context_destroyed';
  } catch { /* Diagnostics remain bounded and cannot reopen authority. */ }
  return fallback;
}
const workerTarget = value => ['service_worker', 'shared_worker', 'worker'].includes(value.type);
const exact = (value, fields) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
};
function parseFlat(raw, fields) {
  const value = JSON.parse(raw), tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const keys = tokens.flatMap((token, index) => tokens[index + 1] === ':' ? [JSON.parse(token)] : []);
  assert.equal(keys.length, fields.length); assert.equal(new Set(keys).size, keys.length); exact(value, fields); return value;
}
export const parseExternalLease = raw => parseFlat(raw, LEASE_FIELDS);
export const parseExternalPreflight = raw => parseFlat(raw, PREFLIGHT_FIELDS);
export const parseExternalParentWorker = raw => parseFlat(raw, PARENT_WORKER_FIELDS);
export function validateExternalParentWorker(value, lease, preflightSHA256, now = Date.now()) {
  exact(value, PARENT_WORKER_FIELDS); base(value, now);
  for (const field of PARENT_WORKER_FIELDS.filter(name => name.endsWith('_sha256'))) assert.match(value[field], /^[a-f0-9]{64}$/);
  for (const field of ['origin', 'session_id', 'configuration_A_sha256', 'worker_policy_sha256']) assert.equal(value[field], lease[field]);
  const profile = reviewedCoreProfile(value.actual_core_version);
  assert.equal(value.worker_asset_path, profile.worker_asset_path);
  assert.equal(value.worker_asset_sha256, profile.worker_asset_sha256); assert.equal(value.worker_asset_bytes, profile.worker_asset_bytes);
  assert.equal(value.worker_policy_sha256, EXTERNAL_WORKER_POLICY_SHA256);
  assert.equal(value.egress_control_report_sha256, WORKER_EGRESS_REPORT_SHA256);
  assert.equal(value.native_proxy_readback_sha256, lease.process_preflight_sha256);
  assert.equal(value.native_proxy_readback_sha256, preflightSHA256);
  return Object.freeze({ core_version: profile.core_version, asset_url: LOCAL_ORIGIN + profile.worker_asset_path,
    asset_sha256: value.worker_asset_sha256, asset_bytes: value.worker_asset_bytes });
}

// Directory preselection only, never browser or management authority. The full
// factory below still proves PID/argv/TLS/context ownership. Callers also compare
// its resulting binding and retain these immutable documents throughout the case.
export function readExternalCoreSelection(inputs, { read = readBoundedFile, clock = Date.now } = {}) {
  const names = ['external-browser-ready.json', 'external-browser-preflight.json', 'external-parent-worker-ready.json'];
  const bytes = names.map(name => read(join(CONTROL_ROOT, name), 16384));
  const lease = parseExternalLease(bytes[0].toString('utf8'));
  const preflight = parseExternalPreflight(bytes[1].toString('utf8')), parent = parseExternalParentWorker(bytes[2].toString('utf8'));
  const configurationHash = inputs.configuration_sha256;
  const validate = () => {
    base(lease, clock()); base(preflight, clock());
    assert.equal(lease.configuration_A_sha256, configurationHash);
    assert.equal(lease.process_preflight_sha256, hash(bytes[1]));
    for (const name of ['session_id', 'controller_pid', 'proxy_port', 'origin']) assert.equal(preflight[name], lease[name]);
    return validateExternalParentWorker(parent, lease, hash(bytes[1]), clock()).core_version;
  };
  const coreVersion = validate();
  return Object.freeze({ coreVersion, verify() {
    names.forEach((name, index) => assert.ok(read(join(CONTROL_ROOT, name), 16384).equals(bytes[index])));
    assert.equal(validate(), coreVersion);
  } });
}
function fresh(value, now) {
  assert.equal(typeof value, 'string'); const observed = Date.parse(value);
  assert.ok(Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= 300000);
}
function base(value, now) {
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, FIXTURE); assert.equal(value.synthetic, true);
  assert.equal(value.origin, LOCAL_ORIGIN); assert.match(value.session_id, /^[a-f0-9]{32}$/); fresh(value.observed_at, now);
}

export function externalChromeArguments(lease, executable, spki) {
  return [executable, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-component-extensions-with-background-pages', '--disable-extensions', '--disable-sync', '--disable-quic',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--proxy-server=http://127.0.0.1:${lease.proxy_port}`,
    '--proxy-bypass-list=<-loopback>', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${lease.cdp_port}`,
    `--user-data-dir=${join(CONTROL_ROOT, lease.profile_basename)}`, `--ignore-certificate-errors-spki-list=${spki}`,
    '--window-size=1440,1000', 'about:blank'];
}

// Pinned Chromium rewrites its process title to the exact space-joined argv.
// Compare raw bytes only: never split that title, normalize whitespace or allow
// padding. Production also binds the binary, launch arguments and actual hash.
export function validateExternalChromeCommandLine(bytes, expectedArguments) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 65536, 'external_command_line_bytes_invalid');
  assert.ok(Array.isArray(expectedArguments) && expectedArguments.length === 22
    && expectedArguments.every(value => typeof value === 'string' && value.length > 0 && !value.includes('\0')),
  'external_expected_arguments_invalid');
  if (bytes.equals(Buffer.from(expectedArguments.join('\0') + '\0'))) return 'nul_separated';
  assert.ok(bytes.equals(Buffer.from(expectedArguments.join(' ') + '\0')), 'external_command_line_mismatch');
  return 'chromium_process_title';
}

// Pure validation seam; production facts below come from the actor's own PID
// namespace and fixed private files, never a caller-supplied browser/context.
export function validateExternalDocuments(lease, preflight, expected, facts, now = Date.now()) {
  exact(lease, LEASE_FIELDS); exact(preflight, PREFLIGHT_FIELDS); base(lease, now); base(preflight, now);
  for (const field of LEASE_FIELDS.filter(name => name.endsWith('_sha256'))) assert.match(lease[field], /^[a-f0-9]{64}$/);
  for (const field of ['same_policy_sha256', 'same_policy_report_sha256']) assert.match(preflight[field], /^[a-f0-9]{64}$/);
  assert.equal(lease.configuration_A_sha256, expected.inputs.configuration_sha256);
  assert.equal(lease.actual_candidate_image_manifest_digest, expected.inputs.document.candidate.image_manifest_digest);
  assert.match(lease.actual_candidate_image_manifest_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(lease.actual_bridge_archive_sha256, expected.inputs.document.bridge.archive_sha256);
  assert.equal(lease.certificate_sha256, expected.tls.certificate_sha256);
  assert.equal(lease.process_preflight_sha256, expected.preflight_sha256);
  assert.equal(lease.worker_policy_sha256, EXTERNAL_WORKER_POLICY_SHA256);
  assert.equal(preflight.same_policy_sha256, EXTERNAL_WORKER_POLICY_SHA256);
  for (const field of ['session_id', 'controller_pid', 'proxy_port', 'origin']) assert.equal(preflight[field], lease[field]);
  assert.equal(preflight.connect_authority, '127.0.0.1:18223'); assert.equal(preflight.raw_connect_only, true);
  assert.equal(preflight.same_policy_positive_control_verified, true);
  for (const field of ['outside_forwarded', 'same_policy_registrations', 'same_policy_sdk_workers', 'same_policy_cdp_workers',
    'same_policy_worker_script_requests', 'same_policy_escape_hits']) assert.equal(preflight[field], 0);
  for (const field of ['controller_pid', 'chrome_pid', 'cdp_port', 'proxy_port']) assert.ok(Number.isSafeInteger(lease[field]) && lease[field] > 0);
  assert.notEqual(lease.chrome_pid, lease.controller_pid); assert.notEqual(lease.chrome_pid, facts.actor_pid);
  for (const port of [lease.cdp_port, lease.proxy_port]) assert.ok(port >= 1024 && port <= 65535 && ![18223, 28223].includes(port));
  assert.notEqual(lease.cdp_port, lease.proxy_port);
  assert.match(lease.controller_start_ticks, /^[1-9][0-9]*$/); assert.match(lease.chrome_start_ticks, /^[1-9][0-9]*$/);
  assert.equal(lease.controller_pid, facts.actor_parent_pid); assert.equal(facts.controller.pid, lease.controller_pid);
  assert.equal(facts.controller.start_ticks, lease.controller_start_ticks); assert.equal(facts.controller.uid, facts.actor_uid);
  assert.equal(facts.chrome.pid, lease.chrome_pid); assert.equal(facts.chrome.parent_pid, facts.actor_parent_pid);
  assert.equal(facts.chrome.start_ticks, lease.chrome_start_ticks); assert.equal(facts.chrome.uid, facts.actor_uid);
  assert.equal(facts.chrome.executable, expected.executable); assert.equal(facts.executable_sha256, lease.executable_sha256);
  assert.equal(lease.profile_basename, 'external-profile-' + lease.session_id); assert.equal(lease.fresh_profile, true);
  assert.equal(facts.profile.path, join(CONTROL_ROOT, lease.profile_basename)); assert.equal(facts.profile.realpath, facts.profile.path);
  assert.equal(facts.profile.directory, true); assert.equal(facts.profile.symlink, false); assert.equal(facts.profile.mode, 0o700);
  assert.equal(facts.profile.uid, facts.actor_uid); assert.equal(facts.profile.gid, facts.actor_gid);
  assert.equal(facts.chrome.argv_sha256, lease.argv_sha256);
  const argumentsRepresentation = validateExternalChromeCommandLine(facts.chrome.cmdline,
    externalChromeArguments(lease, expected.executable, expected.tls.spki));
  assert.equal(hash(facts.chrome.cmdline), lease.argv_sha256);
  const endpoint = new URL(lease.cdp_endpoint);
  assert.equal(endpoint.href, lease.cdp_endpoint); assert.equal(endpoint.origin, `ws://127.0.0.1:${lease.cdp_port}`);
  assert.equal(endpoint.username + endpoint.password + endpoint.search + endpoint.hash, '');
  assert.match(endpoint.pathname, /^\/devtools\/browser\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  return { own_parent_and_process_verified: true, fresh_profile_verified: true, exact_arguments_verified: true,
    arguments_representation: argumentsRepresentation,
    session_id_sha256: hash(lease.session_id), endpoint_sha256: hash(lease.cdp_endpoint), worker_policy_sha256: EXTERNAL_WORKER_POLICY_SHA256,
    preflight_sha256: lease.process_preflight_sha256, same_policy_report_sha256: preflight.same_policy_report_sha256 };
}

function processFacts(pid, command = false, executable, startTicks) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const value = { pid: Number(text.slice(0, text.indexOf(' '))), parent_pid: Number(fields[1]), start_ticks: fields[19], uid: lstatSync(`/proc/${pid}`).uid };
  if (!command) return value;
  assert.equal(value.uid, process.getuid()); assert.equal(value.parent_pid, process.ppid);
  assert.equal(value.start_ticks, startTicks); assert.equal(realpathSync(`/proc/${pid}/exe`), executable);
  const bytes = readFileSync(`/proc/${pid}/cmdline`); assert.ok(bytes.length > 0 && bytes.length <= 65536 && bytes.at(-1) === 0);
  return { ...value, executable: realpathSync(`/proc/${pid}/exe`), cmdline: bytes, argv_sha256: hash(bytes) };
}

function loadExternalDocuments(chromium, inputs, tls) {
  const bytes = readBoundedFile(join(CONTROL_ROOT, 'external-browser-ready.json'), 16384), lease = parseExternalLease(bytes.toString('utf8'));
  const preflightBytes = readBoundedFile(join(CONTROL_ROOT, 'external-browser-preflight.json'), 16384);
  const preflight = parseExternalPreflight(preflightBytes.toString('utf8')), executable = realpathSync(chromium.executablePath());
  // Refuse unsafe paths/process identifiers before looking up host facts.
  assert.match(lease.session_id, /^[a-f0-9]{32}$/); assert.equal(lease.profile_basename, 'external-profile-' + lease.session_id);
  assert.equal(lease.controller_pid, process.ppid);
  assert.ok(Number.isSafeInteger(lease.chrome_pid) && lease.chrome_pid > 0 && lease.chrome_pid !== process.pid && lease.chrome_pid !== process.ppid);
  assert.match(lease.chrome_start_ticks, /^[1-9][0-9]*$/);
  const path = join(CONTROL_ROOT, lease.profile_basename);
  const expected = { inputs, tls, executable, preflight_sha256: hash(preflightBytes) };
  const executableHash = hash(readFileSync(executable));
  const readFacts = () => {
    const info = lstatSync(path);
    return { actor_pid: process.pid, actor_parent_pid: process.ppid, actor_uid: process.getuid(), actor_gid: process.getgid(),
      controller: processFacts(lease.controller_pid), chrome: processFacts(lease.chrome_pid, true, executable, lease.chrome_start_ticks), executable_sha256: executableHash,
      profile: { path, realpath: realpathSync(path), directory: info.isDirectory(), symlink: info.isSymbolicLink(), mode: info.mode & 0o777, uid: info.uid, gid: info.gid } };
  };
  const parentBytes = readBoundedFile(join(CONTROL_ROOT, 'external-parent-worker-ready.json'), 16384);
  const parent = parseExternalParentWorker(parentBytes.toString('utf8'));
  const parentWorkerPolicy = validateExternalParentWorker(parent, lease, hash(preflightBytes));
  const verify = () => {
    assert.equal(hash(readBoundedFile(join(CONTROL_ROOT, 'external-parent-worker-ready.json'), 16384)), hash(parentBytes));
    validateExternalParentWorker(parent, lease, hash(readBoundedFile(join(CONTROL_ROOT, 'external-browser-preflight.json'), 16384)));
    return validateExternalDocuments(lease, preflight, expected, readFacts());
  };
  const verifyTerminal = () => {
    assert.ok(readBoundedFile(join(CONTROL_ROOT, 'external-browser-ready.json'), 16384).equals(bytes));
    assert.ok(readBoundedFile(join(CONTROL_ROOT, 'external-browser-preflight.json'), 16384).equals(preflightBytes));
    assert.ok(readBoundedFile(join(CONTROL_ROOT, 'external-parent-worker-ready.json'), 16384).equals(parentBytes));
    validateExternalParentWorker(parent, lease, hash(preflightBytes)); fresh(lease.observed_at, Date.now());
    const controller = processFacts(process.ppid); assert.equal(controller.pid, lease.controller_pid);
    assert.equal(controller.start_ticks, lease.controller_start_ticks); assert.equal(controller.uid, process.getuid());
    return Date.parse(lease.observed_at) + 300000;
  };
  return { lease, verify, verifyTerminal, parentWorkerPolicy, evidence: { ...verify(), lease_sha256: hash(bytes),
    parent_worker_ready_sha256: hash(parentBytes), public_assets_readback_sha256: parent.public_assets_readback_sha256,
    egress_control_report_sha256: parent.egress_control_report_sha256 } };
}

export async function inspectExternalRegistrations() {
  if (location.origin !== 'https://127.0.0.1:18223') return { outcome: 'INVALID_CONTEXT', reason: 'origin_mismatch' };
  if (!isSecureContext) return { outcome: 'INVALID_CONTEXT', reason: 'insecure_context' };
  if (!navigator.serviceWorker) return { outcome: 'INVALID_CONTEXT', reason: 'service_worker_api_missing' };
  if (typeof navigator.serviceWorker.getRegistrations !== 'function') return { outcome: 'INVALID_CONTEXT', reason: 'get_registrations_missing' };
  const registrations = await navigator.serviceWorker.getRegistrations();
  return { outcome: 'PASS', registrations: registrations.length };
}

const WORKER_EVENT_LIMIT = 8, WORKER_STRING_LIMIT = 4096, WORKER_LENGTH_LIMIT = 65536, WORKER_OVERFLOW_LIMIT = 65535;
function workerField(read) {
  try {
    const value = read();
    if (value === undefined || value === null) return { projection: { state: 'missing' } };
    if (typeof value !== 'string') return { projection: { state: 'invalid' } };
    return { value, projection: { state: 'present', sha256: hash(value.slice(0, WORKER_STRING_LIMIT)),
      length: Math.min(value.length, WORKER_LENGTH_LIMIT), length_capped: value.length > WORKER_LENGTH_LIMIT,
      hash_capped: value.length > WORKER_STRING_LIMIT } };
  } catch { return { projection: { state: 'unreadable' } }; }
}
function projectWorkerEvent(source, type, gateWasClosed, readURL, readTarget) {
  const url = workerField(readURL), target = workerField(readTarget);
  let origin = 'unknown', originHash = null, scheme = 'unknown', path = { state: 'unavailable' };
  if (url.projection.state === 'present' && !url.projection.hash_capped) {
    try {
      const parsed = new URL(url.value), protocol = parsed.protocol.slice(0, -1);
      scheme = ['https', 'http', 'blob', 'data', 'file', 'about'].includes(protocol) ? protocol : 'other';
      origin = parsed.origin === LOCAL_ORIGIN ? 'fixture_local' : parsed.origin === PROXY_ORIGIN ? 'fixture_proxy'
        : parsed.origin === 'null' ? 'opaque' : 'other';
      if (origin === 'other' || origin === 'opaque') originHash = hash(parsed.origin);
      path = workerField(() => parsed.pathname).projection;
    } catch { origin = 'invalid'; }
  }
  return { source, type, gate_was_closed: gateWasClosed, fenced: true, url: url.projection,
    scheme, origin, origin_sha256: originHash, path, target: target.projection };
}

// The production entry below supplies only verified fixed-file provenance. This
// adapter seam permits network-free CDP protocol controls with synthetic objects.
/** Abort-only shutdown proof. No read, forwarding or permission capability. */
export function createExpectedTerminalAbortController({ verifyLive, verifyLease, getFailure, isConnected, onFailure = () => {}, clock = Date.now }) {
  let snapshot, requested = false, pageCloseRequested = false, normalClosed = false, failure = null;
  const reject = code => { failure ??= code; onFailure(code); return 'REJECTED_TERMINAL_REQUEST'; };
  const lease = () => { const expires = verifyLease(); assert.ok(Number.isFinite(expires) && expires > clock() && expires <= clock() + 300000); return expires; };
  const owner = () => { assert.ok(snapshot); const b = snapshot;
    assert.equal(b.page.context(), b.context); assert.equal(b.context.browser(), b.browser); assert.equal(b.frame.page(), b.page);
    assert.equal(b.page.mainFrame(), b.parent); assert.ok(clock() < b.leaseExpires && clock() < b.sessionExpires); assert.equal(lease(), b.leaseExpires);
    assert.equal(getFailure(), null); assert.equal(failure, null);
  };
  return Object.freeze({ arm(binding) {
    assert.equal(snapshot, undefined); verifyLive(); binding.verify(); assert.equal(isConnected(), true);
    assert.equal(binding.page.isClosed(), false); assert.equal(binding.frame.isDetached(), false);
    const parent = binding.page.mainFrame(); assert.equal(binding.frame.parentFrame(), parent); assert.equal(parent.parentFrame(), null);
    assert.equal(binding.frame.url(), LOCAL_ORIGIN + binding.prefix); assert.equal(ingressPrefix(LOCAL_ORIGIN + binding.prefix), binding.prefix);
    assert.match(binding.principalHash, /^[a-f0-9]{64}$/); const sessionExpires = Date.parse(binding.expiresAt); assert.ok(sessionExpires > clock());
    snapshot = Object.freeze({ browser: binding.browser, context: binding.context, page: binding.page, frame: binding.frame,
      parent, prefix: binding.prefix, principalHash: binding.principalHash, sessionExpires, leaseExpires: lease() }); owner();
  }, requestCleanup() {
    if (!snapshot || requested) return;
    try { verifyLive(); owner(); assert.equal(isConnected(), true); requested = true; }
    catch { reject('terminal_abort_source_unverified'); }
  }, noteOwnedPageCloseRequested() { if (snapshot && requested) pageCloseRequested = true; },
  classify(request, scope) {
    if (!snapshot || !requested) return 'NOT_TERMINAL';
    try {
      owner(); const b = snapshot, target = new URL(request.url()), method = request.method(), frame = request.frame();
      assert.ok(['GET', 'HEAD'].includes(method)); assert.ok(readOnlyRequestAllowed(target.href, method)); assert.equal(target.hash, '');
      const currentParent = b.frame.parentFrame(), detached = b.frame.isDetached();
      if (b.page.isClosed()) {
        assert.equal(pageCloseRequested, true); assert.ok(currentParent === b.parent || currentParent === null && detached);
      } else if (detached || currentParent === null) {
        assert.equal(pageCloseRequested, true); assert.equal(detached, true); assert.ok(currentParent === null || currentParent === b.parent);
      } else assert.equal(currentParent, b.parent);
      if (frame === b.frame) { assert.equal(scope.fromFrame, true); assert.equal(scope.prefix, b.prefix); assert.ok(target.pathname.startsWith(b.prefix)); }
      else { assert.equal(frame, b.parent); assert.equal(scope.fromFrame, false); assert.equal(target.pathname.startsWith('/api/hassio_ingress/'), false); }
      return 'EXPECTED_TERMINAL_ABORT';
    } catch { return reject('terminal_abort_request_unverified'); }
  }, complete(result) {
    if (!snapshot) return;
    try { owner(); assert.equal(requested && pageCloseRequested, true); assert.equal(result?.cleanup_confirmed, true); normalClosed = true; }
    catch { reject('terminal_abort_cleanup_unconfirmed'); }
  }, fail() { return reject('terminal_abort_route_unverified'); }, evidence() {
    return Object.freeze({ armed: !!snapshot, cleanup_requested: requested, owned_page_close_requested: pageCloseRequested,
      normal_close_confirmed: normalClosed, failure });
  } });
}

/** Explicit default-context DENY only; no permission-grant API. */
export function createDefaultDownloadDeny({ acquire, verify, isConnected, timeoutMs = 10000, notify }) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000);
  let finished = false, installed = false, failure = false, deadline, session, finalEvidence, contextReply = 'unverified';
  const raw = { acquisition: 'not_started', default_context: 'not_started', deny: 'not_started' }, pending = new Set();
  const remaining = () => { assert.equal(finished, false); assert.equal(failure, false); verify(); assert.equal(isConnected(), true);
    const value = Math.floor(deadline - performance.now()); assert.ok(value > 0); return value; };
  const evidence = () => finalEvidence ?? Object.freeze({ scope: 'default_context', context_reply: contextReply, explicit_deny: installed, permission_grants: 0,
    ...raw, raw_pending: pending.size, all_settled: pending.size === 0, failure,
    finished, verified: installed && !failure && pending.size === 0 });
  const operation = async (kind, callback) => {
    remaining(); raw[kind] = 'pending';
    let actual; try { actual = callback(); } catch { actual = Promise.reject(new Error('default_deny_command_failed')); }
    const promise = Promise.resolve(actual).then(value => {
      if (!finished) { raw[kind] = 'fulfilled'; if (performance.now() >= deadline) failure = true; }
      return value;
    }, () => { if (!finished) { raw[kind] = 'rejected'; failure = true; } throw new Error('default_deny_command_failed'); });
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    const value = await withinDeadline('native_evaluate', () => promise, { timeoutMs: remaining(), notify }); remaining(); return value;
  };
  return Object.freeze({ evidence, finish() { if (!finalEvidence) { finished = true; finalEvidence = evidence(); } return finalEvidence; }, async install() {
    assert.equal(deadline, undefined); deadline = performance.now() + timeoutMs;
    try {
      session = await operation('acquisition', acquire);
      const contexts = await operation('default_context', () => session.send('Target.getBrowserContexts'));
      assert.ok(contexts && Object.getPrototypeOf(contexts) === Object.prototype);
      const names = Reflect.ownKeys(contexts);
      assert.ok(names.includes('browserContextIds') && names.every(name => ['browserContextIds', 'defaultBrowserContextId'].includes(name)));
      const ownData = name => { const descriptor = Object.getOwnPropertyDescriptor(contexts, name);
        assert.ok(descriptor && Object.hasOwn(descriptor, 'value')); return descriptor.value; };
      const created = ownData('browserContextIds'); assert.ok(Array.isArray(created)); assert.equal(Object.getPrototypeOf(created), Array.prototype);
      assert.deepEqual(Reflect.ownKeys(created), ['length']); assert.equal(Object.getOwnPropertyDescriptor(created, 'length')?.value, 0);
      if (names.includes('defaultBrowserContextId')) assert.equal(typeof ownData('defaultBrowserContextId'), 'string');
      // CDP documents an optional opaque string. Its value never selects the
      // permission target, is not normalized and is never included in reports.
      contextReply = names.includes('defaultBrowserContextId') ? 'required_and_optional_id' : 'required_only';
      const acknowledgement = await operation('deny', () => session.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }));
      assert.deepEqual(acknowledgement, {});
      remaining(); installed = true; return session;
    } catch { failure = true; throw new Error('default_download_deny_unverified'); }
  } });
}

export async function connectVerifiedExternalBrowser(chromium, source, report, {
  notify = () => {}, attachTimeoutMs = 10000, operationTimeoutMs = 5000, exportDownload = false,
} = {}) {
  let downloadPolicy, exportControlBound = false;
  assert.equal(typeof exportDownload, 'boolean');
  let browser, context, page, diagnostic, provenPageOwner, closed = false, failure = null, cleanupPromise, attachmentStarted = false, previews = 0;
  const sockets = new Set(), inventory = [];
  // Only the production factory loads this policy from the fixed private file.
  // Direct adapter callers are trusted synthetic protocol controls, never CLI input.
  const parentPolicy = source.parentWorkerPolicy;
  let pageDiagnostic, parentIdentity, startupOpen = false, ingressReady = !parentPolicy, credentialsChecked = false;
  let ownedWindow;
  let fileReview, fileBootstrap, fileFrame, managerReadonlyBound = false, readonlyBinding;
  let parentCandidate, associatedWorker, sourceRequest, sourceRequests = 0, sourceResponses = 0, startupTimer;
  let completeStartup, metadataQueried = false;
  const startupCompletion = new Promise(done => { completeStartup = done; });
  let panelOpen = false, panelDeadline, panelTimer, heldRequests = 0, completeIngress;
  const ingressCompletion = new Promise(done => { completeIngress = done; });
  const startup = { status: 'precredentials', startup_window_closed: false, source_requests: 0, source_responses: 0,
    sdk_associated: false, cdp_source_verified: false, source_verified: false, metadata_query_pending: false, deadline_ms: 5000 };
  const workerEvents = { schema_version: 1, event_limit: WORKER_EVENT_LIMIT, string_limit: WORKER_STRING_LIMIT,
    length_limit: WORKER_LENGTH_LIMIT, overflow_limit: WORKER_OVERFLOW_LIMIT, events: [], overflow: 0, overflow_saturated: false };
  const workerFollowup = { schema_version: 1, target: null, query: { status: 'not_started', timeout_ms: 250, observation: null },
    update_limit: 2, updates: [], outcome: 'INCONCLUSIVE', stopped: false };
  let trackedWorker, followupSelected = false;
  const fence = (reason = null) => {
    closed = true; failure ??= reason;
    fileReview?.close();
    if (reason) downloadPolicy?.invalidate();
    clearTimeout(startupTimer); clearTimeout(panelTimer); completeStartup(); completeIngress();
    if (parentPolicy && startup.status !== 'closed') startup.status = 'closed';
    for (const socket of sockets) { try { socket.close(); } catch { failure ??= 'socket_close_failed'; } }
    sockets.clear();
  };
  const recordWorker = (reason, eventSource, type, readURL, readTarget = () => undefined) => {
    const gateWasClosed = closed;
    // Close authority and sockets before inspecting event URLs or projecting
    // anything. Diagnostic getters/errors never get an opportunity to reopen it.
    fence(reason);
    if (workerEvents.events.length >= WORKER_EVENT_LIMIT) {
      if (workerEvents.overflow < WORKER_OVERFLOW_LIMIT) workerEvents.overflow += 1;
      else workerEvents.overflow_saturated = true;
      return;
    }
    const observation = projectWorkerEvent(eventSource, type, gateWasClosed, readURL, readTarget);
    workerEvents.events.push(observation); return observation;
  };
  const ownership = info => ({ parent_frame: workerField(() => info.parentFrameId).projection,
    browser_context: workerField(() => info.browserContextId).projection });
  const metadataObservation = (info, eventSource) => {
    const id = info?.targetId; assert.equal(id, trackedWorker.id); assert.equal(info?.type, trackedWorker.type);
    const observedOwnership = ownership(info);
    for (const [field, initial] of Object.entries(trackedWorker.ownership)) {
      const current = observedOwnership[field];
      assert.ok(['missing', 'present'].includes(current.state));
      if (current.state === 'present') assert.ok(current.length > 0 && current.length <= 256 && !current.hash_capped);
      if (initial.state === 'present') assert.equal(current.sha256, initial.sha256);
    }
    return { ...projectWorkerEvent(eventSource, trackedWorker.type, true, () => info.url, () => id),
      ...observedOwnership };
  };
  const noteResolvedURL = observation => {
    if (observation.url.state === 'present' && observation.url.length > 0 && !observation.url.hash_capped
      && !['unknown', 'invalid'].includes(observation.origin)) workerFollowup.outcome = 'NONEMPTY_URL_OBSERVED';
  };
  const startWorkerFollowup = (info, type, created) => {
    if (followupSelected || workerFollowup.stopped) return;
    followupSelected = true;
    try {
      assert.equal(closed, true); const id = info.targetId; assert.match(id, /^[A-Fa-f0-9]{32}$/);
      assert.equal(created?.target.sha256, hash(id));
      const initialOwnership = ownership(info);
      for (const field of Object.values(initialOwnership)) {
        assert.ok(field.state === 'missing' || field.state === 'present' && field.length > 0 && field.length <= 256 && !field.hash_capped);
      }
      trackedWorker = { id, type, ownership: initialOwnership };
      workerFollowup.target = { sha256: hash(id), type, ...initialOwnership };
    } catch { workerFollowup.query.status = 'invalid_target'; return; }
    workerFollowup.query.status = 'pending'; let stale = false;
    const verifyMetadata = () => { try { source.verify(); } catch { stale = true; throw new Error('worker_metadata_provenance_lost'); } };
    void withinDeadline('native_evaluate', () => {
      assert.equal(workerFollowup.stopped, false); verifyMetadata(); assert.equal(workerFollowup.stopped, false);
      return diagnostic.send('Target.getTargetInfo', { targetId: trackedWorker.id });
    }, { timeoutMs: 250, notify }).then(result => {
      if (workerFollowup.stopped || workerFollowup.query.status !== 'pending') return;
      try {
        verifyMetadata(); if (workerFollowup.stopped) return;
        const observation = metadataObservation(result?.targetInfo, 'cdp_get_target_info');
        if (workerFollowup.stopped) return;
        workerFollowup.query.observation = observation; workerFollowup.query.status = 'observed'; noteResolvedURL(observation);
      } catch { if (!workerFollowup.stopped) workerFollowup.query.status = stale ? 'stale_provenance' : 'invalid_metadata'; }
    }, error => {
      if (!workerFollowup.stopped && workerFollowup.query.status === 'pending')
        workerFollowup.query.status = stale ? 'stale_provenance' : error.code === 'native_deadline' ? 'timeout' : 'query_failed';
    });
  };
  const active = () => {
    assert.equal(closed, false);
    try { source.verify(); } catch { fence('external_provenance_lost'); throw new Error('external_provenance_lost'); }
  };
  const panelRemaining = () => {
    active(); const remaining = Math.floor(panelDeadline - performance.now());
    assert.ok(panelOpen && Number.isFinite(panelDeadline) && remaining > 0 && remaining <= 30000); return remaining;
  };
  const remainingStartup = () => {
    active(); assert.ok(parentCandidate);
    const remaining = Math.ceil(parentCandidate.deadline - performance.now());
    assert.ok(remaining > 0, 'parent_worker_deadline'); return remaining;
  };
  const parentWorkerState = () => ({ gate_was_closed: closed, startup_open: startupOpen, startup_window_closed: startup.startup_window_closed,
      ingress_ready: ingressReady, candidate_present: !!parentCandidate, candidate_proven: parentCandidate?.proven === true,
      sdk_associated: startup.sdk_associated, metadata_query_pending: startup.metadata_query_pending,
      candidate_deadline: !parentCandidate ? 'unstarted' : performance.now() < parentCandidate.deadline ? 'positive' : 'expired' });
  const parentWorkerFailure = (reason, event, step, info, snapshot = parentWorkerState()) => {
    // Snapshot only our primitive state at handler entry; project incoming values
    // after fencing. A later beforeIngress call cannot rewrite admission state.
    const candidatePresentAtFailure = !!parentCandidate;
    fence(reason);
    if (report.checks.external.parent_worker_failure) return;
    const field = name => {
      try {
        const descriptor = info && Object.getOwnPropertyDescriptor(info, name);
        if (!descriptor) return { state: 'missing' };
        if (!Object.hasOwn(descriptor, 'value')) return { state: 'unreadable' };
        if (typeof descriptor.value !== 'string') return { state: 'invalid' };
        if (descriptor.value.length > WORKER_STRING_LIMIT) return { state: 'oversized' };
        return { state: 'present', value: descriptor.value };
      } catch { return { state: 'unreadable' }; }
    };
    const id = field('targetId'), frame = field('parentFrameId'), context = field('browserContextId'), url = field('url');
    report.checks.external.parent_worker_failure = { event, step, ...snapshot, candidate_present_at_failure: candidatePresentAtFailure,
      fields: { target_id: id.state, parent_frame: frame.state, browser_context: context.state, url: url.state },
      target_id_valid: id.state === 'present' && /^[A-Fa-f0-9]{32}$/.test(id.value),
      matches: { parent_frame: parentIdentity ? frame.state === 'present' && frame.value === parentIdentity.frame : null,
        browser_context: parentIdentity ? context.state === 'present' && context.value === parentIdentity.context : null,
        candidate_target: parentCandidate ? id.state === 'present' && id.value === parentCandidate.id : null },
      url_category: url.state !== 'present' ? url.state : url.value === '' ? 'empty' : url.value === parentPolicy.asset_url ? 'pinned' : 'other' };
  };
  const validWorkerInfo = (info, allowEmpty = false, mark = () => {}) => {
    mark('parent_identity'); assert.ok(parentIdentity); mark('worker_type'); assert.equal(info.type, 'worker');
    mark('target_id'); assert.match(info.targetId, /^[A-Fa-f0-9]{32}$/);
    mark('creator_frame'); assert.equal(info.parentFrameId, parentIdentity.frame);
    mark('creator_context'); assert.equal(info.browserContextId, parentIdentity.context);
    mark('worker_url'); assert.ok(info.url === parentPolicy.asset_url || allowEmpty && info.url === '');
    mark('candidate_target'); if (parentCandidate) assert.equal(info.targetId, parentCandidate.id);
  };
  const maybeComplete = () => {
    if (!parentCandidate || closed || parentCandidate.proven) return;
    remainingStartup();
    if (startup.sdk_associated && startup.cdp_source_verified && startup.source_verified && !startup.metadata_query_pending) {
      parentCandidate.proven = true; startup.status = 'proven'; clearTimeout(startupTimer); completeStartup();
    }
  };
  const queryParentMetadata = () => {
    if (metadataQueried || startup.cdp_source_verified) return;
    metadataQueried = true; startup.metadata_query_pending = true;
    void withinDeadline('native_evaluate', () => {
      remainingStartup(); return diagnostic.send('Target.getTargetInfo', { targetId: parentCandidate.id });
    }, { timeoutMs: remainingStartup(), notify }).then(result => {
      if (closed) return;
      startup.metadata_query_pending = false; observeParentWorker(result?.targetInfo, false);
    }, () => { if (!closed) parentWorkerFailure('parent_worker_metadata_failed', 'query', 'metadata_query'); });
  };
  const associateWorker = worker => {
    if (closed) return;
    const entry = parentWorkerState();
    let step = 'provenance';
    try {
      active(); step = 'admission'; assert.ok(startupOpen || parentCandidate && !parentCandidate.proven);
      step = 'duplicate_sdk'; assert.equal(associatedWorker, undefined); step = 'worker_url'; assert.equal(worker.url(), parentPolicy.asset_url);
      associatedWorker = worker; startup.sdk_associated = true;
      // The public owned-page event proves SDK page association. A CDP creation
      // event must still supply the exact creator frame/context and real deadline.
      if (!parentCandidate) startupTimer = setTimeout(() => fence('parent_worker_metadata_timeout'), 5000);
      else { queryParentMetadata(); maybeComplete(); }
    } catch { parentWorkerFailure('parent_worker_sdk_failed', 'sdk', step, undefined, entry); }
  };
  const observeParentWorker = (info, created) => {
    if (closed) return;
    const createdAt = performance.now();
    const entry = parentWorkerState();
    let step = 'provenance';
    try {
      active();
      if (created) {
        step = 'admission'; assert.equal(startupOpen, true); step = 'duplicate_candidate'; assert.equal(parentCandidate, undefined);
        validWorkerInfo(info, true, value => { step = value; });
        parentCandidate = { id: info.targetId, deadline: createdAt + 5000, proven: false };
        startup.status = 'pending_source'; clearTimeout(startupTimer);
        startupTimer = setTimeout(() => fence('parent_worker_source_timeout'), 5000);
      } else {
        step = 'candidate_present'; assert.ok(parentCandidate); validWorkerInfo(info, !parentCandidate.proven, value => { step = value; });
      }
      step = 'deadline'; if (!parentCandidate.proven) remainingStartup();
      if (info.url === parentPolicy.asset_url) startup.cdp_source_verified = true;
      step = 'completion';
      if (created && associatedWorker) queryParentMetadata();
      maybeComplete();
    } catch { parentWorkerFailure('parent_worker_metadata_failed', created ? 'created' : 'changed', step, info, entry); }
  };
  const inspectParent = async blank => {
    let step = 'page_inventory';
    try {
      active(); assert.equal(context.pages().length, 1); assert.equal(context.pages()[0], page);
      step = 'target_info';
      const info = (await withinDeadline('native_evaluate', () => pageDiagnostic.send('Target.getTargetInfo'),
        { timeoutMs: operationTimeoutMs, notify })).targetInfo;
      active();
      step = 'frame_tree';
      const tree = (await withinDeadline('native_evaluate', () => pageDiagnostic.send('Page.getFrameTree'),
        { timeoutMs: operationTimeoutMs, notify })).frameTree;
      active(); step = 'target_type'; assert.equal(info.type, 'page');
      step = 'identity_shape';
      for (const id of [info.targetId, info.browserContextId, tree.frame.id]) assert.match(id, /^[A-Fa-f0-9]{32}$/);
      step = 'children';
      assert.ok(!tree.childFrames || Array.isArray(tree.childFrames) && tree.childFrames.length === 0);
      assert.ok(!tree.frame.parentId); step = 'url_binding'; assert.equal(info.url, page.url()); assert.equal(tree.frame.url, page.url());
      step = 'origin';
      if (blank) assert.equal(page.url(), 'about:blank');
      else { const url = new URL(page.url()); assert.equal(url.origin, LOCAL_ORIGIN); assert.equal(url.username + url.password, ''); }
      const identity = { page: info.targetId, context: info.browserContextId, frame: tree.frame.id };
      step = 'identity_continuity';
      if (parentIdentity) assert.deepEqual(identity, parentIdentity); else parentIdentity = identity;
      report.checks.external.owned_parent = { page_sha256: hash(identity.page), context_sha256: hash(identity.context),
        frame_sha256: hash(identity.frame), precredentials_verified: !blank };
    } catch (error) {
      fence('parent_inspection_failed');
      const outcome = evaluationFailure(error, ['target_info', 'frame_tree'].includes(step) ? 'evaluation_failed' : 'check_failed');
      report.checks.external.parent_inspection_failure ??= { step, outcome };
      throw new Error('external_parent_inspection_failed');
    }
  };
  const observeSource = response => {
    if (closed) return;
    // Only the one fixed public Core asset is consumed, never arbitrary responses.
    let url;
    try { url = new URL(response.url()); } catch { fence('parent_worker_source_failed'); return; }
    if (url.pathname !== new URL(parentPolicy.asset_url).pathname) return;
    try {
      active(); remainingStartup(); assert.equal(++sourceResponses, 1); startup.source_responses = sourceResponses;
      assert.equal(url.href, parentPolicy.asset_url); assert.equal(response.status(), 200);
      assert.equal(response.request(), sourceRequest); assert.equal(sourceRequests, 1);
    } catch { fence('parent_worker_source_failed'); return; }
    void (async () => {
      try {
        const headers = await withinDeadline('response_body', () => { remainingStartup(); return response.allHeaders(); }, { timeoutMs: remainingStartup(), notify });
        remainingStartup();
        assert.match(headers['content-type'], /^(?:text|application)\/javascript(?:;\s*charset=utf-8)?$/i);
        assert.match(headers['content-length'], /^[1-9][0-9]{0,5}$/);
        assert.ok(Number(headers['content-length']) <= parentPolicy.asset_bytes);
        assert.ok(headers['content-encoding'] === undefined || ['identity', 'gzip', 'br', 'deflate', 'zstd'].includes(headers['content-encoding']));
        // Response.body buffers decoded bytes. This is a completion/header/count
        // bound for one independently pinned trusted asset, NOT a hard prebuffer
        // decoded-size cap or an arbitrary untrusted response loader.
        const body = await withinDeadline('response_body', () => { remainingStartup(); return response.body(); }, { timeoutMs: remainingStartup(), notify });
        remainingStartup(); assert.ok(Buffer.isBuffer(body)); assert.equal(body.length, parentPolicy.asset_bytes);
        assert.equal(hash(body), parentPolicy.asset_sha256); startup.source_verified = true; maybeComplete();
      } catch { if (!closed) fence('parent_worker_source_failed'); }
    })();
  };
  let defaultDeny;
  const terminalAbort = createExpectedTerminalAbortController({ verifyLive: () => active(),
    verifyLease: () => { assert.equal(typeof source.verifyTerminal, 'function'); return source.verifyTerminal(); },
    getFailure: () => failure, isConnected: () => browser?.isConnected() === true, onFailure: code => fence(code) });
  const shutdown = async (target, requireOpenOwnedPage = false) => {
    fence(); let protocol = false, ownedPageClosed = false, nativeDisconnected = false, disconnected = false, listenerRemoved = true;
    const closeDeadline = performance.now() + operationTimeoutMs;
    let closePhaseActive = true, ledgerActive = true;
    const remainingClose = () => {
      assert.equal(closePhaseActive, true);
      const remaining = Math.floor(closeDeadline - performance.now()); assert.ok(remaining > 0); return remaining;
    };
    const connected = () => { try { return target.isConnected(); } catch { return null; } };
    const stages = { protocol_requested: false, protocol_acknowledged: false, disconnect_requested: false,
      disconnect_acknowledged: false, connected_before_protocol: connected(), connected_after_protocol: null,
      connected_after_disconnect: null, native_disconnect_observed: false,
      owned_page_verified: false, owned_page_close_requested: false, owned_page_close_completed: false, owned_page_closed: null };
    const pending = new Set(), raw = { page_close: 'not_started', acquisition: 'not_started', protocol: 'not_started', sdk_disconnect: 'not_started' };
    let rawFailure = false, nativeTimely = false, nativeObservation = null;
    // Observe the actual promises separately from the bounded wait. A timeout or
    // SDK disconnect is never invented command settlement or a protocol ACK.
    const track = (kind, operation) => {
      raw[kind] = 'pending';
      let actual; try { actual = operation(); } catch { actual = Promise.reject(new Error('shutdown_operation_failed')); }
      const promise = Promise.resolve(actual).then(value => {
        if (ledgerActive) {
          raw[kind] = 'fulfilled';
          if (kind !== 'sdk_disconnect' && performance.now() >= closeDeadline) rawFailure = true;
          if (kind === 'protocol') { stages.protocol_acknowledged = true; if (!rawFailure) protocol = true; }
        }
        return { ok: true, value };
      }, () => {
        if (ledgerActive) {
          raw[kind] = 'rejected';
          // A raw close request may reject only when its transport really died.
          if (!['acquisition', 'protocol'].includes(kind) || connected() !== false) rawFailure = true;
        }
        return { ok: false };
      });
      pending.add(promise); void promise.then(() => pending.delete(promise)); return promise;
    };
    let finishNative, listening = true;
    const nativeCompletion = new Promise(done => { finishNative = done; });
    const onNativeDisconnect = () => {
      if (!listening) return;
      stages.native_disconnect_observed = true;
      nativeObservation = { page_close: raw.page_close, acquisition: raw.acquisition, protocol: raw.protocol,
        sdk_disconnect: raw.sdk_disconnect, deadline_open: closePhaseActive && performance.now() < closeDeadline };
      nativeTimely = nativeObservation.deadline_open && (stages.owned_page_close_requested || stages.protocol_requested);
      finishNative(nativeTimely);
    };
    let workflow;
    try {
      target.once('disconnected', onNativeDisconnect);
      workflow = (async () => {
        remainingClose();
        // Early/unrequested transport loss cannot acquire shutdown authority.
        assert.equal(connected(), true);
        try {
          stages.owned_page_verified = !!provenPageOwner && provenPageOwner.browser === target
            && provenPageOwner.context === context && provenPageOwner.page === page
            && page.context() === context && context.browser() === target;
        } catch { /* An unfamiliar page is never closed; use strict browser proof. */ }
        if (stages.owned_page_verified) {
          stages.owned_page_closed = page.isClosed();
          if (requireOpenOwnedPage) assert.equal(stages.owned_page_closed, false);
          if (!stages.owned_page_closed) {
            const result = await track('page_close', () => { remainingClose(); assert.equal(connected(), true);
              stages.owned_page_close_requested = true; terminalAbort.noteOwnedPageCloseRequested(); return page.close({ runBeforeUnload: false }); }); remainingClose();
            assert.equal(result.ok, true); assert.equal(page.isClosed(), true);
            ownedPageClosed = true; stages.owned_page_close_completed = true; stages.owned_page_closed = true;
          }
        }
        remainingClose();
        if (connected() === false) return;
        assert.equal(connected(), true);
        const acquired = await track('acquisition', () => target.newBrowserCDPSession()); remainingClose();
        // The last owned window can exit while session acquisition is pending.
        // Never dispatch a command to that disconnected producer.
        if (connected() === false) return;
        assert.equal(connected(), true); assert.equal(acquired.ok, true);
        remainingClose();
        await track('protocol', () => { remainingClose(); assert.equal(connected(), true);
          stages.protocol_requested = true; return acquired.value.send('Browser.close'); });
      })().then(() => true, () => false);
      await withinDeadline('browser_close', async () => {
        assert.equal(await nativeCompletion, true); remainingClose(); assert.equal(connected(), false);
        // Timely normal page closure is sufficient native proof. Do not await an
        // optional Browser.close ACK before draining its SDK transport.
        if (!ownedPageClosed) { assert.equal(await workflow, true); remainingClose(); }
        assert.ok(protocol || ownedPageClosed); nativeDisconnected = true;
      }, { timeoutMs: remainingClose(), notify });
    } catch { /* Unknown/late shutdown cannot be promoted by SDK disconnection. */ }
    finally {
      closePhaseActive = false; listening = false;
      try { target.off('disconnected', onNativeDisconnect); } catch { listenerRemoved = false; }
      finishNative(false);
    }
    stages.connected_after_protocol = connected();
    const drainDeadline = performance.now() + operationTimeoutMs;
    const remainingDrain = () => { const remaining = Math.floor(drainDeadline - performance.now()); assert.ok(remaining > 0); return remaining; };
    let allSettled = false;
    try {
      stages.disconnect_requested = true;
      const result = await withinDeadline('browser_close', () => track('sdk_disconnect', () => target.close()), { timeoutMs: remainingDrain(), notify });
      assert.equal(result.ok, true); disconnected = connected() === false; stages.disconnect_acknowledged = true;
      await withinDeadline('browser_close', () => Promise.all([...pending, workflow]), { timeoutMs: remainingDrain(), notify });
      allSettled = pending.size === 0;
    } catch { /* Root independently reaps its process; pending raw work is FAIL. */ }
    ledgerActive = false;
    stages.connected_after_disconnect = connected();
    const confirmed = (protocol || ownedPageClosed) && nativeDisconnected && disconnected && listenerRemoved && allSettled && !rawFailure;
    const reason = !confirmed ? 'external_close_unconfirmed' : protocol ? 'external_protocol_close_native_disconnect_and_sdk_disconnect'
      : 'external_owned_page_close_native_disconnect_and_sdk_disconnect';
    return { cleanup_confirmed: confirmed, reason,
      protocol_close_confirmed: protocol, owned_page_close_completed: ownedPageClosed, native_disconnect_confirmed: nativeDisconnected, sdk_disconnected: disconnected,
      process_exit: 'REQUIRES_ROOT_READBACK', shutdown_stages: { ...stages },
      shutdown_settlement: { ...raw, native_observation: nativeObservation, native_timely_requested: nativeTimely, all_settled: allSettled, raw_pending: pending.size, raw_failure: rawFailure } };
  };
  const cleanup = () => {
    if (!cleanupPromise) terminalAbort.requestCleanup();
    if (!downloadPolicy) fence();
    workerFollowup.stopped = true;
    if (workerFollowup.query.status === 'pending') workerFollowup.query.status = 'cancelled_cleanup';
    return cleanupPromise ??= (async () => {
      let shutdownPromise;
      const closeProducer = () => {
        fence();
        return shutdownPromise ??= browser ? shutdown(browser, !!downloadPolicy) : Promise.resolve({ cleanup_confirmed: !attachmentStarted,
          reason: attachmentStarted ? 'external_attachment_unconfirmed' : 'not_attached', protocol_close_confirmed: false,
          sdk_disconnected: false, process_exit: 'REQUIRES_ROOT_READBACK' });
      };
      if (downloadPolicy) report.checks.download_policy = await downloadPolicy.close({ closeProducer,
        isProducerOpen: () => browser.isConnected() === true && page.isClosed() === false,
        isProducerClosed: () => browser.isConnected() === false && page.isClosed() === true });
      let result = await closeProducer();
      if (defaultDeny) {
        report.checks.download_default_deny = defaultDeny.finish();
        if (!report.checks.download_default_deny.verified) result = { ...result, cleanup_confirmed: false, reason: 'external_default_deny_unverified' };
      }
      terminalAbort.complete(result);
      if (terminalAbort.evidence().armed) report.checks.expected_terminal_abort_source = terminalAbort.evidence();
      report.checks.cleanup = result;
      if (report.checks.external) report.checks.external.guard = { gate_closed: closed, failure, metadata_previews: previews };
      return result;
    })();
  };
  const checkWorkers = async (registrations = false) => {
    let step = 'provenance', observed, registrationEvaluationOutcome;
    try {
      active(); step = 'service_workers';
      assert.equal(context.serviceWorkers().length, 0);
      step = 'cdp_targets';
      const targets = await withinDeadline('native_evaluate', () => diagnostic.send('Target.getTargets'), { timeoutMs: operationTimeoutMs, notify });
      active(); assert.ok(Array.isArray(targets.targetInfos));
      assert.ok(targets.targetInfos.every(value => value && typeof value.type === 'string'));
      const workers = targets.targetInfos.filter(workerTarget);
      step = 'parent_worker';
      if (!parentPolicy || !parentCandidate) assert.equal(workers.length, 0);
      else {
        assert.equal(parentCandidate.proven, true); assert.ok(workers.length <= 1);
        for (const info of workers) validWorkerInfo(info);
      }
      step = 'sdk_workers';
      let sdkCount = 0;
      if (parentPolicy) {
        const sdk = page.workers(); assert.ok(Array.isArray(sdk)); sdkCount = sdk.length; assert.ok(sdk.length <= 1);
        for (const worker of sdk) { assert.ok(parentCandidate?.proven); assert.equal(worker, associatedWorker); assert.equal(worker.url(), parentPolicy.asset_url); }
      }
      let count = null;
      if (registrations) {
        step = 'registrations_evaluate';
        observed = await withinDeadline('native_evaluate', async () => {
          try { return await page.evaluate(inspectExternalRegistrations); }
          catch (error) {
            fence('worker_inventory_failed'); registrationEvaluationOutcome ??= evaluationFailure(error);
            throw new Error('external_registration_evaluation_failed');
          }
        }, { timeoutMs: operationTimeoutMs, notify });
        active(); step = 'registrations_validate'; assert.deepEqual(observed, { outcome: 'PASS', registrations: 0 }); count = observed.registrations;
      }
      const result = { sdk_workers: sdkCount, cdp_worker_targets: workers.length, registrations: count };
      inventory.push(result); report.checks.external.worker_inventory = [...inventory]; return result;
    } catch (error) {
      // Fence before inspecting diagnostic values. Only fixed enums are retained;
      // raw exceptions, URLs, IDs and arbitrary page values never enter reports.
      fence('worker_inventory_failed');
      let outcome = 'check_failed';
      if (step === 'registrations_evaluate') outcome = registrationEvaluationOutcome ?? evaluationFailure(error);
      try {
        if (error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'native_deadline') outcome = 'timeout';
        else if (step === 'registrations_validate') {
          outcome = 'malformed_result';
          const data = name => observed && Object.getOwnPropertyDescriptor(observed, name)?.value;
          if (data('outcome') === 'INVALID_CONTEXT') {
            const reason = data('reason');
            outcome = ['origin_mismatch', 'insecure_context', 'service_worker_api_missing', 'get_registrations_missing'].includes(reason)
              ? reason : 'invalid_context';
          } else if (data('outcome') === 'PASS' && Number.isSafeInteger(data('registrations')) && data('registrations') > 0) outcome = 'registrations_present';
        }
      } catch { /* Diagnostic failures cannot renew authority or expose values. */ }
      report.checks.external.worker_inventory_failure ??= { step, outcome };
      throw new Error('external_worker_policy_failed');
    }
  };
  try {
    source.verify(); report.checks.external = { ...source.evidence, attachment_started: false,
      existing_default_context_only: true, no_defaults: true, worker_policy_sha256: EXTERNAL_WORKER_POLICY_SHA256,
      process_exit: 'REQUIRES_ROOT_READBACK', worker_events: workerEvents, worker_followup: workerFollowup,
      ...(parentPolicy ? { parent_worker_startup: startup, expected_core_version: reviewedCoreProfile(parentPolicy.core_version).core_version } : {}) };
    attachmentStarted = true; report.checks.external.attachment_started = true;
    const connecting = chromium.connectOverCDP(source.lease.cdp_endpoint, { noDefaults: true, timeout: attachTimeoutMs });
    const bounded = Promise.resolve(connecting).then(async value => {
      browser = value;
      if (closed) { report.checks.external_late_cleanup = await shutdown(value); throw new Error('external_attachment_late'); }
      return value;
    });
    browser = await withinDeadline('browser_context', () => bounded, { timeoutMs: attachTimeoutMs, notify }); active();
    const contexts = browser.contexts(); assert.equal(contexts.length, 1); context = contexts[0];
    const pages = context.pages(); assert.equal(pages.length, 1); page = pages[0]; assert.equal(page.url(), 'about:blank');
    if (exportDownload) {
      const { createExportDownloadPolicy } = await import('./browser_download_policy.mjs');
      diagnostic = await withinDeadline('native_evaluate', () => browser.newBrowserCDPSession(), { timeoutMs: operationTimeoutMs, notify }); active();
      downloadPolicy = await createExportDownloadPolicy({ session: diagnostic, coreVersion: parentPolicy.core_version,
        isTransportConnected: () => browser.isConnected(), verify: () => {
        active(); assert.equal(browser.isConnected(), true); assert.deepEqual(browser.contexts(), [context]); assert.deepEqual(context.pages(), [page]);
        assert.equal(page.context(), context); assert.equal(context.browser(), browser); assert.equal(page.isClosed(), false);
      }, onFailure: () => fence() });
      report.checks.download_default_deny_before_navigation = true;
    } else {
      defaultDeny = createDefaultDownloadDeny({ acquire: () => browser.newBrowserCDPSession(),
        verify: () => { active(); assert.deepEqual(browser.contexts(), [context]); assert.deepEqual(context.pages(), [page]);
          assert.equal(page.context(), context); assert.equal(context.browser(), browser); assert.equal(page.isClosed(), false); },
        isConnected: () => browser.isConnected(), timeoutMs: operationTimeoutMs, notify });
      diagnostic = await defaultDeny.install(); active();
      report.checks.download_default_deny = defaultDeny.evidence();
      report.checks.download_default_deny_before_navigation = true;
    }
    assert.deepEqual(await withinDeadline('native_evaluate', () => context.cookies(), { timeoutMs: operationTimeoutMs, notify }), []); active();
    context.on('serviceworker', worker => recordWorker('unexpected_worker', 'sdk_serviceworker', 'service_worker', () => {
      const method = worker?.url;
      return typeof method === 'function' ? method.call(worker) : undefined;
    }));
    context.on('page', value => { if (value !== page) fence('unexpected_page'); });
    diagnostic ??= await withinDeadline('native_evaluate', () => browser.newBrowserCDPSession(), { timeoutMs: operationTimeoutMs, notify }); active();
    diagnostic.on('Target.targetCreated', event => {
      let info, type;
      try { info = event?.targetInfo; type = info?.type; } catch {
        const unreadable = () => { throw new Error('worker_field_unreadable'); };
        recordWorker('target_inventory_unknown', 'cdp_target_created', 'unknown', unreadable, unreadable); return;
      }
      if (!info || typeof type !== 'string') recordWorker('target_inventory_unknown', 'cdp_target_created', 'unknown', () => info?.url, () => info?.targetId);
      else if (parentPolicy && type === 'worker') observeParentWorker(info, true);
      else if (['service_worker', 'shared_worker', 'worker'].includes(type)) {
        const created = recordWorker('unexpected_worker', 'cdp_target_created', type, () => info.url, () => info.targetId);
        startWorkerFollowup(info, type, created);
      }
    });
    diagnostic.on('Target.targetInfoChanged', event => {
      if (parentPolicy && !closed) {
        try {
          const info = event?.targetInfo;
          if (info?.targetId === parentCandidate?.id && parentCandidate) observeParentWorker(info, false);
          else if (workerTarget(info ?? {})) parentWorkerFailure('parent_worker_unknown_update', 'changed', 'unknown_target', info);
        } catch { parentWorkerFailure('parent_worker_metadata_failed', 'changed', 'dispatch'); }
        return;
      }
      if (!trackedWorker || workerFollowup.stopped || workerFollowup.updates.length >= 2) return;
      let info;
      try { info = event?.targetInfo; if (info?.targetId !== trackedWorker.id) return; } catch { return; }
      try { source.verify(); } catch {
        if (!workerFollowup.stopped) workerFollowup.updates.push({ status: 'stale_provenance', observation: null }); return;
      }
      if (workerFollowup.stopped) return;
      try {
        const observation = metadataObservation(info, 'cdp_target_info_changed');
        if (workerFollowup.stopped) return;
        workerFollowup.updates.push({ status: 'observed', observation }); noteResolvedURL(observation);
      } catch { if (!workerFollowup.stopped) workerFollowup.updates.push({ status: 'invalid_metadata', observation: null }); }
    });
    await withinDeadline('native_evaluate', () => diagnostic.send('Target.setDiscoverTargets', { discover: true }), { timeoutMs: operationTimeoutMs, notify });
    if (parentPolicy) {
      page.on('worker', associateWorker); page.on('response', observeSource);
      diagnostic.on('Target.targetDestroyed', event => {
        if (!closed && parentCandidate && !parentCandidate.proven && event?.targetId === parentCandidate.id) fence('parent_worker_destroyed_pending');
      });
      pageDiagnostic = await withinDeadline('native_evaluate', () => context.newCDPSession(page), { timeoutMs: operationTimeoutMs, notify });
      await inspectParent(true);
    }
    await checkWorkers();
    // Capture only after the exact existing context/page and initial inventory
    // passed verification; cleanup never discovers or closes unfamiliar pages.
    provenPageOwner = { browser, context, page };
    await withinDeadline('native_evaluate', () => context.addInitScript(EXTERNAL_WORKER_POLICY), { timeoutMs: operationTimeoutMs, notify }); active();
    report.checks.external.exact_worker_policy_installed = true;
    return { browser, context, page, cleanup, fence, checkWorkers, coreVersion: parentPolicy?.core_version,
      startFileReview: () => {
        try {
          active(); assert.equal(fileReview, undefined); assert.equal(managerReadonlyBound, false); assert.ok(fileBootstrap && fileFrame && parentPolicy);
          assert.equal(ownedWindow, undefined); assert.equal(ingressReady, true);
          assert.equal(startup.source_verified, true); assert.equal(startup.sdk_associated, true);
          assert.equal(previews, 1); assert.equal(fileFrame.page(), page);
          fileReview = new FileReviewAuthority({ browser, context, page, frame: fileFrame, ...fileBootstrap,
            principalHash: source.lease.admin_A_user_id_sha256, verify: () => active(),
            window: () => ({ phase: ownedWindow?.phase }), onFailure: () => fence('external_file_review_failed') });
          fileBootstrap = undefined; return fileReview;
        } catch { fence('external_file_review_setup_failed'); throw new Error('external_file_review_unverified'); }
      },
      managerReadonlyBinding: () => {
        try {
          active(); assert.equal(managerReadonlyBound, false); assert.equal(fileReview, undefined);
          assert.ok(fileBootstrap && fileFrame && parentPolicy); assert.equal(ownedWindow, undefined);
          assert.equal(ingressReady, true); assert.equal(startup.source_verified, true); assert.equal(startup.sdk_associated, true);
          assert.equal(previews, 1); assert.equal(fileFrame.page(), page); assert.equal(fileFrame.isDetached(), false);
          const { prefix, session } = fileBootstrap;
          assert.equal(fileFrame.url(), LOCAL_ORIGIN + prefix);
          assert.equal(session.authenticated, true); assert.equal(session.runtime, 'ingress'); assert.equal(session.mode, 'manage');
          assert.equal(hash(session.user_id), source.lease.admin_A_user_id_sha256); assert.ok(Date.parse(session.expires_at) > Date.now());
          managerReadonlyBound = true; fileBootstrap = undefined;
          readonlyBinding = Object.freeze({ browser, context, page, frame: fileFrame, prefix, coreVersion: parentPolicy.core_version,
            principalHash: source.lease.admin_A_user_id_sha256, expiresAt: session.expires_at, verify: () => active() });
          return readonlyBinding;
        } catch { fence('external_manager_readonly_binding_failed'); throw new Error('external_manager_readonly_unverified'); }
      },
      armExpectedTerminalAbort: () => {
        active(); assert.equal(exportDownload, false); assert.equal(fileReview, undefined); assert.equal(managerReadonlyBound, true);
        assert.ok(readonlyBinding && parentPolicy && startup.source_verified && startup.sdk_associated);
        terminalAbort.arm(readonlyBinding);
      },
      expectedTerminalAbortDisposition: (request, scope) => terminalAbort.classify(request, scope),
      expectedTerminalAbortEvidence: () => terminalAbort.evidence(),
      failExpectedTerminalAbort: () => terminalAbort.fail(),
      exportDownloadControl: () => {
        active(); assert.equal(exportDownload, true); assert.equal(managerReadonlyBound, true);
        assert.ok(downloadPolicy && pageDiagnostic); downloadPolicy.check(); assert.equal(exportControlBound, false);
        exportControlBound = true;
        return Object.freeze({ policy: downloadPolicy, pageSession: pageDiagnostic, session: diagnostic });
      },
      assertSource: () => active(),
      ownedWindowControl: async action => {
        const started = performance.now(), deadline = started + operationTimeoutMs;
        const projectState = value => ['normal', 'minimized', 'maximized', 'fullscreen'].includes(value) ? value : 'unknown';
        const observation = { action: ['minimize', 'restore'].includes(action) ? action : 'invalid', phase: 'admission', step: 'admission',
          original_state: ownedWindow ? projectState(ownedWindow.original.windowState) : 'not_read', lookup_state: 'not_read',
          authority_failed: false, deadline_elapsed: false, geometry_acknowledged: false, transitions: [] };
        let transition;
        const publish = outcome => {
          const snapshots = report.checks.external.window_controls ??= [];
          if (snapshots.length < 2) snapshots.push({ ...observation, outcome,
            elapsed_ms: Math.min(60000, Math.max(0, Math.floor(performance.now() - started))),
            transitions: observation.transitions.map(value => ({ ...value })) });
          else report.checks.external.window_control_overflow = true;
        };
        const currentAuthority = () => {
          try { active(); } catch (error) { observation.authority_failed = true; throw error; }
          observation.deadline_elapsed ||= performance.now() >= deadline;
          assert.equal(observation.deadline_elapsed, false);
        };
        const send = async (method, args) => {
          currentAuthority(); const value = await diagnostic.send(method, args);
          if (method === 'Browser.setWindowBounds') {
            if (args.bounds.windowState && transition) transition.acknowledged = true;
            else observation.geometry_acknowledged = true;
          }
          currentAuthority(); return value;
        };
        try {
          return await withinDeadline('native_evaluate', async () => {
            currentAuthority(); assert.ok(['minimize', 'restore'].includes(action));
            observation.phase = 'ownership'; observation.step = 'owner_check';
            assert.ok(pageDiagnostic && parentIdentity && provenPageOwner);
            assert.equal(provenPageOwner.browser, browser); assert.equal(provenPageOwner.context, context);
            assert.equal(provenPageOwner.page, page); assert.equal(page.context(), context);
            assert.equal(context.browser(), browser); assert.equal(page.isClosed(), false);
            observation.step = 'target_info'; const info = (await pageDiagnostic.send('Target.getTargetInfo')).targetInfo; currentAuthority();
            observation.step = 'frame_tree'; const tree = (await pageDiagnostic.send('Page.getFrameTree')).frameTree; currentAuthority();
            observation.step = 'identity_assertion';
            assert.equal(info.type, 'page');
            assert.deepEqual({ page: info.targetId, context: info.browserContextId, frame: tree.frame.id }, parentIdentity);
            assert.equal(info.url, page.url()); assert.equal(tree.frame.url, page.url());
            assert.equal(new URL(page.url()).origin, LOCAL_ORIGIN);
            if (action === 'minimize') assert.equal(ownedWindow, undefined);
            else assert.equal(ownedWindow?.phase, 'minimized');
            observation.phase = 'lookup'; observation.step = 'window_lookup';
            const current = await send('Browser.getWindowForTarget', { targetId: parentIdentity.page });
            observation.lookup_state = projectState(current.bounds?.windowState); observation.step = 'window_assertion';
            assert.ok(Number.isSafeInteger(current.windowId) && current.windowId >= 0);
            const waitState = async expected => {
              // ACK is not effective state. Observe only this window; every wait,
              // command and read shares the original single operation deadline.
              for (let reads = 0; reads < 100; reads += 1) {
                observation.step = 'state_read';
                const bounds = (await send('Browser.getWindowBounds', { windowId: ownedWindow.id })).bounds;
                if (transition) {
                  const state = projectState(bounds?.windowState);
                  if (transition.first_observed === 'not_read') transition.first_observed = state;
                  transition.last_observed = state; transition.reads = Math.min(100, transition.reads + 1);
                }
                assert.ok(['normal', 'minimized', 'maximized', 'fullscreen'].includes(bounds?.windowState));
                // Native Restore can return the saved maximized state directly.
                // Only that exact saved final state can replace the intermediate
                // normal observation; every other transition stays strict.
                if (bounds.windowState === expected || action === 'restore' && expected === 'normal'
                  && ownedWindow.original.windowState === 'maximized' && bounds.windowState === 'maximized') return bounds;
                currentAuthority();
                observation.step = 'state_wait';
                await new Promise(done => setTimeout(done, Math.min(50, Math.max(1, Math.ceil(deadline - performance.now())))));
                currentAuthority();
              }
              throw new Error('owned_window_state_unobserved');
            };
            const setState = async expected => {
              transition = { requested: expected, acknowledged: false, first_observed: 'not_read', last_observed: 'not_read', reads: 0 };
              if (observation.transitions.length < 2) observation.transitions.push(transition);
              observation.step = 'state_command';
              await send('Browser.setWindowBounds', { windowId: ownedWindow.id, bounds: { windowState: expected } });
              return waitState(expected);
            };
            let final;
            if (action === 'minimize') {
              assert.ok(['normal', 'maximized', 'fullscreen'].includes(current.bounds.windowState));
              for (const key of ['left', 'top', 'width', 'height']) assert.ok(Number.isSafeInteger(current.bounds[key]));
              for (const key of ['width', 'height']) assert.ok(current.bounds[key] > 0 && current.bounds[key] <= 8192);
              ownedWindow = { id: current.windowId, original: { ...current.bounds }, phase: 'pending' };
              observation.original_state = projectState(current.bounds.windowState);
              // Chromium156 rejects fullscreen->minimized and minimized->special
              // state. Restore normal first, then verify before the next command.
              if (current.bounds.windowState === 'fullscreen') { observation.phase = 'minimize_normalization'; await setState('normal'); }
              observation.phase = 'minimize';
              final = await setState('minimized');
            } else {
              assert.equal(current.windowId, ownedWindow.id); assert.equal(current.bounds.windowState, 'minimized');
              const original = ownedWindow.original;
              observation.phase = 'restore_normalization';
              final = await setState('normal');
              if (original.windowState === 'normal') {
                observation.phase = 'restore_geometry'; observation.step = 'geometry_command';
                const geometry = Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, original[key]]));
                await send('Browser.setWindowBounds', { windowId: ownedWindow.id, bounds: geometry });
                final = await waitState('normal');
                observation.step = 'geometry_assertion';
                for (const key of Object.keys(geometry)) assert.equal(final[key], geometry[key]);
              } else if (original.windowState !== 'maximized' || final.windowState !== 'maximized') {
                observation.phase = 'restore_original_state'; final = await setState(original.windowState);
              }
            }
            currentAuthority(); const state = action === 'minimize' ? 'minimized' : ownedWindow.original.windowState;
            observation.step = 'final_assertion';
            assert.equal(final.windowState, state); ownedWindow.phase = action === 'minimize' ? 'minimized' : 'restored';
            observation.phase = 'complete'; observation.step = 'complete'; publish('complete');
            return { action, owned_identity_verified: true, state };
          }, { timeoutMs: operationTimeoutMs, notify });
        } catch (error) {
          publish(error?.code === 'native_deadline' || observation.deadline_elapsed ? 'timeout' : 'failed');
          fence('owned_window_control_failed'); throw new Error('owned_window_control_failed');
        }
      },
      beforeCredentials: async () => {
        try {
          if (parentPolicy) { assert.equal(credentialsChecked, false); await inspectParent(false); }
          await checkWorkers(true); active();
          if (parentPolicy) { credentialsChecked = true; startupOpen = true; startup.status = 'listening'; }
        } catch { fence('precredentials_failed'); throw new Error('external_precredentials_unverified'); }
      },
      beforeIngress: async remainingMs => {
        if (!parentPolicy) return;
        try {
          active(); assert.equal(credentialsChecked, true); assert.equal(ingressReady, false); assert.equal(panelOpen, false);
          assert.ok(Number.isInteger(remainingMs) && remainingMs > 0 && remainingMs <= 30000);
          panelDeadline = performance.now() + remainingMs; panelOpen = true;
          panelTimer = setTimeout(() => fence('parent_worker_bootstrap_timeout'), remainingMs);
          if (parentCandidate || associatedWorker) {
            await withinDeadline('native_evaluate', () => startupCompletion, { timeoutMs: panelRemaining(), notify });
            active(); assert.equal(parentCandidate?.proven, true);
          }
          await checkWorkers(true); panelRemaining();
        } catch { fence('parent_worker_ingress_failed'); throw new Error('external_parent_worker_unverified'); }
      },
      afterIngress: async remainingMs => {
        if (!parentPolicy) return;
        try {
          assert.ok(Number.isInteger(remainingMs) && remainingMs > 0 && remainingMs <= 30000);
          await withinDeadline('native_evaluate', () => startupCompletion, { timeoutMs: Math.min(remainingMs, panelRemaining()), notify });
          active(); assert.equal(parentCandidate?.proven, true);
          startupOpen = false; startup.startup_window_closed = true;
          await checkWorkers(true); panelRemaining();
          ingressReady = true; clearTimeout(panelTimer); completeIngress();
        } catch { fence('parent_worker_ingress_failed'); throw new Error('external_parent_worker_unverified'); }
      },
      holdRequest: async (request, scope) => {
        if (!parentPolicy) return;
        let held = false;
        try {
          active(); const target = new URL(request.url());
          if (target.origin !== LOCAL_ORIGIN || !target.pathname.startsWith('/api/hassio_ingress/')) return;
          assert.equal(scope.fromFrame, true); assert.equal(hash(scope.prefix), source.lease.ingress_prefix_sha256);
          assert.ok(target.pathname.startsWith(scope.prefix));
          if (!target.pathname.startsWith(scope.prefix + 'api/v1/') || ingressReady) return;
          assert.ok(['GET', 'HEAD'].includes(request.method())); assert.ok(readOnlyRequestAllowed(request.url(), request.method()));
          assert.ok(heldRequests < 16); heldRequests += 1; held = true;
          await withinDeadline('native_evaluate', () => ingressCompletion, { timeoutMs: panelRemaining(), notify });
          active(); assert.equal(ingressReady, true);
        } catch { fence('external_bootstrap_read_unverified'); throw new Error('external_bootstrap_read_unverified'); }
        finally { if (held) heldRequests -= 1; }
      },
      verifyBootstrap: async (observations, prefix) => {
        try {
          active(); assert.equal(ingressReady, true); await checkWorkers(true); active();
          if (parentPolicy) assert.equal(observations.status.body.version, parentPolicy.core_version);
          assert.equal(hash(observations.session.body.user_id), source.lease.admin_A_user_id_sha256);
          assert.equal(hash(prefix), source.lease.ingress_prefix_sha256); assert.equal(previews, 1);
          fileBootstrap = { prefix, session: structuredClone(observations.session.body), tags: structuredClone(observations.inventory?.body?.tags) };
          report.checks.external.actual_admin_and_prefix_bound = true;
        } catch { fence('bootstrap_binding_failed'); throw new Error('external_bootstrap_unverified'); }
      },
      allowRequest: (request, scope) => {
        if (closed) return false;
        try {
          active();
          if (fileReview && isFileReviewAppRequest(request)) return fileReview.allowExternal(request, scope);
          if (!readOnlyRequestAllowed(request.url(), request.method())) throw new Error('external_write_denied');
          const target = new URL(request.url());
          assert.equal(target.pathname.startsWith('/api/v1/'), false);
          if (parentPolicy && target.pathname === new URL(parentPolicy.asset_url).pathname) {
            assert.equal(startupOpen || parentCandidate && !parentCandidate.proven, true);
            assert.equal(target.href, parentPolicy.asset_url); assert.equal(request.method(), 'GET');
            assert.equal(request.frame(), page.mainFrame()); assert.equal(++sourceRequests, 1);
            sourceRequest = request; startup.source_requests = sourceRequests;
          }
          if (target.pathname.startsWith('/api/hassio_ingress/')) {
            assert.equal(scope.fromFrame, true); assert.equal(hash(scope.prefix), source.lease.ingress_prefix_sha256);
            if (!ingressReady) {
              const relative = target.pathname.slice(scope.prefix.length);
              return panelOpen && request.method() === 'GET' && target.pathname.startsWith(scope.prefix)
                && (relative === '' || /^assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(relative));
            }
            if (request.method() === 'POST') {
              assert.equal(previews, 0); assert.equal(target.href, LOCAL_ORIGIN + scope.prefix + 'api/v1/music/resolve');
              assert.equal(request.postData(), JSON.stringify({ input: 'spotify:album:0123456789ABCDEFGHIJKL', media_type: 'album' })); previews += 1;
              try { fileFrame = request.frame(); } catch { fileFrame = undefined; }
            }
          }
          return true;
        } catch { fence('external_request_denied'); return false; }
      },
      bindSocket: socket => { active(); sockets.add(socket); },
      evidence: () => ({ gate_closed: closed, failure, metadata_previews: previews,
        ...(fileReview ? { file_review: fileReview.evidence() } : {}) }) };
  } catch {
    fence('external_setup_failed'); await cleanup(); throw new Error('external_browser_unverified');
  }
}

export async function createExternalBrowserSession(chromium, inputs, tls, report, options = {}) {
  try {
    const source = loadExternalDocuments(chromium, inputs, tls);
    return await connectVerifiedExternalBrowser(chromium, source, report, options);
  } catch {
    report.checks.cleanup ??= { cleanup_confirmed: true, reason: 'not_attached', protocol_close_confirmed: false,
      sdk_disconnected: false, process_exit: 'REQUIRES_ROOT_READBACK' };
    throw new Error('external_browser_unverified');
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') process.stdout.write('node scripts/haos_acceptance/browser_external.mjs {external-read-only|external-visibility|external-file-review|external-manager-readonly|external-export-download} CONFIG_A\n');
  else if (args.length === 2 && ['external-read-only', 'external-visibility', 'external-file-review', 'external-manager-readonly', 'external-export-download'].includes(args[0])) {
    let report;
    if (args[0] === 'external-read-only') {
      const { runReadOnly } = await import('./browser.mjs'); report = await runReadOnly(args[1], { externalBrowser: true });
      report.limitations.push('External desktop bootstrap only: no native visibility, normal service-worker support, mobile/proxy/expiry or process-exit certification. Root must require normal Chrome exit and proxy/display/descendant cleanup.');
    } else if (args[0] === 'external-visibility') { const { runVisibility } = await import('./browser_visibility.mjs'); report = await runVisibility(args[1]); }
    else if (args[0] === 'external-export-download') { const { runExportDownload } = await import('./browser_export_download.mjs'); report = await runExportDownload(args[1]); }
    else if (args[0] === 'external-manager-readonly') { const { runManagerReadonly } = await import('./browser_manager_readonly.mjs'); report = await runManagerReadonly(args[1]); }
    else { const { runFileReview } = await import('./browser_file_review.mjs'); report = await runFileReview(args[1]); }
    const unconfirmed = report.checks.cleanup?.cleanup_confirmed === false;
    if (unconfirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
    process.exitCode = report.result === 'PASS' ? 0 : 1;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => { if (unconfirmed) process.stderr.write('', () => process.exit(1)); });
  } else { process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'invalid_phase_arguments' }) + '\n'); process.exitCode = 2; }
}

// Finish module evaluation before the browser opener dynamically imports this
// adapter again; a top-level await here would wait on its own pending module.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'external_cli_failed' }) + '\n'); process.exitCode = 1;
  });
}
