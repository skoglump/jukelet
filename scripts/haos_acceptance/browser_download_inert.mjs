/** Inert prerequisite only. Imports do not attach, read controls, or start Chrome. */
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyDownloadArtifact, ARTIFACT_ROOT } from './download_artifact.mjs';
import { createExternalBrowserSession, parseExternalLease, readExternalCoreSelection } from './browser_external.mjs';
import { sameIdentity, readBoundedFile, CONTROL_ROOT } from './browser_inputs.mjs';
import { MINIMUM_CORE_VERSION, reviewedCoreProfile } from './browser_core_profiles.mjs';

import { CASES, INERT_BYTES, runInertProbe } from './browser_download_policy.mjs';
export { CASES, INERT_BYTES, runInertProbe };
const REPOSITORY = '/home/sebastian/Projects/jukelet';
const HASH = data => createHash('sha256').update(data).digest('hex');
const FIXTURE = 'jukelet-m5-issue62-matrix-kvm';
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const requireValue = (value, code = 'invalid_observation') => { if (!value) fail(code); };
async function bounded(action, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), ms);
  })]); } finally { clearTimeout(timer); }
}

/** Same existing local validator/shape, with a bounded Python child and source readback. */
export function readInputsBounded(path, { read = readBoundedFile, run = spawnSync } = {}) {
  try {
    requireValue(typeof path === 'string' && /^\/tmp\/jukelet-issue62-matrix-control\/[a-z][a-z0-9_-]{0,63}\.json$/.test(path));
    const bytes = read(path, 16384);
    const validation = run('python3', ['-B', '-m', 'scripts.haos_acceptance', 'validate', path], {
      cwd: REPOSITORY, encoding: 'utf8', maxBuffer: 65536, timeout: 5000,
    });
    requireValue(validation.status === 0 && !validation.error);
    const result = JSON.parse(validation.stdout), document = JSON.parse(bytes);
    requireValue(result.result === 'PASS_LOCAL_INPUT' && result.fixture === FIXTURE
      && result.origin === 'https://127.0.0.1:18223' && document.origin === result.origin
      && sameIdentity(result.declared_candidate, document.candidate) && sameIdentity(result.declared_bridge, document.bridge));
    requireValue(typeof document.certificate_file === 'string' && /^[a-z][a-z0-9_-]{0,63}\.crt$/.test(document.certificate_file));
    const certificate = read(`${CONTROL_ROOT}/${document.certificate_file}`, 32768, { certificate: true });
    requireValue(read(path, 16384).equals(bytes));
    return { document, certificate, configuration_sha256: HASH(bytes), local_validation: result };
  } catch { fail('invalid_fixture_input'); }
}

/** Readonly directory-FD lease. Root creates directories; this never repairs permissions. */
export function openCaseLease(mode = 'inert', coreVersion = MINIMUM_CORE_VERSION) {
  requireValue(['inert', 'export'].includes(mode), 'invalid_case');
  const selected = reviewedCoreProfile(coreVersion).cases;
  const cases = mode === 'inert' ? [selected.positive, selected.wrongframe] : [selected.export];
  const descriptors = [], identities = [];
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  const uid = process.getuid();
  try {
    for (const path of ['/tmp/jukelet-issue62-download-preparation', ARTIFACT_ROOT, ...cases]) {
      requireValue(realpathSync(path) === path, 'directory_unverified');
      const before = lstatSync(path), fd = openSync(path, flags); descriptors.push(fd);
      const after = fstatSync(fd);
      requireValue(before.isDirectory() && after.isDirectory() && before.ino === after.ino && before.dev === after.dev
        && after.uid === uid && (after.mode & 0o7777) === 0o700, 'directory_unverified');
      identities.push({ path, fd, ino: after.ino, dev: after.dev });
    }
    const verify = () => {
      for (const entry of identities) {
        const named = lstatSync(entry.path), opened = fstatSync(entry.fd);
        for (const value of [named, opened]) requireValue(value.isDirectory() && value.uid === uid
          && (value.mode & 0o7777) === 0o700 && value.ino === entry.ino && value.dev === entry.dev, 'directory_changed');
        requireValue(realpathSync(entry.path) === entry.path, 'directory_changed');
      }
    };
    const entries = which => {
      verify(); const index = mode === 'export' && which === 'export' ? 2 : mode === 'inert' && which === 'positive' ? 2
        : mode === 'inert' && which === 'wrongframe' ? 3 : fail('invalid_case');
      return readdirSync(`/proc/self/fd/${identities[index].fd}`);
    };
    requireValue(mode === 'inert' ? entries('positive').length === 0 && entries('wrongframe').length === 0
      : entries('export').length === 0, 'directory_not_empty');
    return { coreVersion, cases: selected, verify, entries, close() { let bad = false; for (const fd of descriptors.reverse()) {
      try { closeSync(fd); } catch { bad = true; }
    } if (bad) fail('directory_close_failed'); } };
  } catch { for (const fd of descriptors.reverse()) { try { closeSync(fd); } catch { /* no certificate on error */ } }
    fail('directory_unverified'); }
}

// Recheck the exact immutable controller documents and real own-parent process identities.
// The reused attachment helper performs the full initial22args/private-profile proof.
function sourceLease() {
  const names = ['external-browser-ready.json', 'external-browser-preflight.json', 'external-parent-worker-ready.json'];
  const bytes = names.map(name => readBoundedFile(`${CONTROL_ROOT}/${name}`, 16384));
  const lease = parseExternalLease(bytes[0].toString('utf8'));
  requireValue(Number.isSafeInteger(lease.chrome_pid) && lease.chrome_pid > 0 && lease.chrome_pid !== process.pid
    && lease.chrome_pid !== process.ppid && lease.controller_pid === process.ppid
    && /^[1-9][0-9]*$/.test(lease.chrome_start_ticks) && /^[1-9][0-9]*$/.test(lease.controller_start_ticks), 'source_unverified');
  const processIdentity = pid => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { parent: Number(fields[1]), ticks: fields[19], uid: lstatSync(`/proc/${pid}`).uid };
  };
  const executable = realpathSync(`/proc/${lease.chrome_pid}/exe`), executableHash = HASH(readFileSync(executable));
  const verify = () => {
    names.forEach((name, index) => requireValue(readBoundedFile(`${CONTROL_ROOT}/${name}`, 16384).equals(bytes[index]), 'source_changed'));
    const age = Date.now() - Date.parse(lease.observed_at);
    requireValue(age >= 0 && age <= 300000 && lease.controller_pid === process.ppid, 'source_expired');
    const parent = processIdentity(process.ppid), chrome = processIdentity(lease.chrome_pid);
    requireValue(parent.ticks === lease.controller_start_ticks && chrome.ticks === lease.chrome_start_ticks
      && chrome.parent === process.ppid && parent.uid === process.getuid() && chrome.uid === process.getuid()
      && realpathSync(`/proc/${lease.chrome_pid}/exe`) === executable && executableHash === lease.executable_sha256
      && HASH(readFileSync(`/proc/${lease.chrome_pid}/cmdline`)) === lease.argv_sha256, 'source_changed');
  };
  verify(); return { verify, receipt: { lease_sha256: HASH(bytes[0]), preflight_sha256: HASH(bytes[1]),
    parent_worker_sha256: HASH(bytes[2]), executable_sha256: executableHash, argv_sha256: lease.argv_sha256 } };
}

// Fixed scalar projection only: never serialize arbitrary factory diagnostics,
// errors, URLs, protocol IDs, configuration, headers or event payloads.
export function inertAttachmentChecks(report) {
  const read = (value, name) => { try { return Object.getOwnPropertyDescriptor(value ?? {}, name)?.value; } catch { return undefined; } };
  const object = value => value !== null && typeof value === 'object';
  const states = ['not_started', 'pending', 'fulfilled', 'rejected'];
  const project = (value, booleans = [], enums = {}, numbers = []) => {
    const out = { availability: object(value) ? 'reported' : 'not_reported' };
    for (const name of booleans) { const entry = read(value, name); if (typeof entry === 'boolean' || entry === null) out[name] = entry; }
    for (const [name, allowed] of Object.entries(enums)) { const entry = read(value, name); if (allowed.includes(entry)) out[name] = entry; }
    for (const name of numbers) { const entry = read(value, name); if (Number.isSafeInteger(entry) && entry >= 0 && entry <= 1000000) out[name] = entry; }
    return out;
  };
  const checks = read(report, 'checks'), external = read(checks, 'external'), cleanup = read(checks, 'cleanup');
  const startup = read(external, 'parent_worker_startup'), settlement = read(cleanup, 'shutdown_settlement');
  const result = {
    download_default_deny: project(read(checks, 'download_default_deny'), ['explicit_deny', 'all_settled', 'failure', 'finished', 'verified'],
      { scope: ['default_context'], context_reply: ['unverified', 'required_only', 'required_and_optional_id'],
        acquisition: states, default_context: states, deny: states }, ['permission_grants', 'raw_pending']),
    external: project(external, ['attachment_started', 'existing_default_context_only', 'no_defaults', 'exact_worker_policy_installed'],
      { expected_core_version: ['2026.10.3', '2026.11.0'] }),
    startup: project(startup, ['startup_window_closed', 'sdk_associated', 'cdp_source_verified', 'source_verified', 'metadata_query_pending'],
      { status: ['precredentials', 'closed', 'proven', 'pending_source', 'listening'] }, ['source_requests', 'source_responses', 'deadline_ms']),
    cleanup: project(cleanup, ['cleanup_confirmed', 'protocol_close_confirmed', 'owned_page_close_completed', 'native_disconnect_confirmed', 'sdk_disconnected'],
      { reason: ['external_close_unconfirmed', 'external_protocol_close_native_disconnect_and_sdk_disconnect',
        'external_owned_page_close_native_disconnect_and_sdk_disconnect', 'external_default_deny_unverified', 'external_attachment_unconfirmed', 'not_attached'],
        process_exit: ['REQUIRES_ROOT_READBACK'] }),
    shutdown_stages: project(read(cleanup, 'shutdown_stages'), ['protocol_requested', 'protocol_acknowledged', 'disconnect_requested', 'disconnect_acknowledged',
      'connected_before_protocol', 'connected_after_protocol', 'connected_after_disconnect', 'native_disconnect_observed',
      'owned_page_verified', 'owned_page_close_requested', 'owned_page_close_completed', 'owned_page_closed']),
    shutdown_settlement: project(settlement, ['native_timely_requested', 'all_settled', 'raw_failure'],
      { page_close: states, acquisition: states, protocol: states, sdk_disconnect: states }, ['raw_pending']),
    native_observation: project(read(settlement, 'native_observation'), ['deadline_open'],
      { page_close: states, acquisition: states, protocol: states, sdk_disconnect: states }),
  };
  const before = read(checks, 'download_default_deny_before_navigation');
  if (typeof before === 'boolean') result.download_default_deny_before_navigation = before;
  return result;
}

export function withInertPreflightDiagnostics(report, step, attachReport, { failed = false, attachmentReturned = false } = {}) {
  const steps = ['arguments', 'local_inputs', 'core_selection', 'browser_dependency', 'tls', 'case_lease', 'source_lease',
    'attachment', 'selected_core', 'http_fence', 'websocket_fence', 'browser_cdp', 'page_cdp', 'inert_probe', 'provenance'];
  requireValue(steps.includes(step) && typeof failed === 'boolean' && typeof attachmentReturned === 'boolean', 'invalid_preflight_step');
  const category = steps.indexOf(step) < steps.indexOf('attachment') ? 'before_attachment'
    : step === 'attachment' ? 'attachment' : ['inert_probe', 'provenance'].includes(step) ? 'probe' : 'after_attachment';
  return { ...report, ...(failed ? { result: 'FAIL' } : {}), preflight: { step, category, outcome: failed ? 'failed' : 'completed',
    attachment_returned: attachmentReturned }, attachment_checks: inertAttachmentChecks(attachReport) };
}

async function main(args) {
  const attachReport = { checks: {} }; let step = 'arguments', failed = false;
  let session, filesystem, report = { fixture: FIXTURE, phase: 'external-download-policy-inert', result: 'FAIL',
    scope: 'inert_prerequisite_only', ha_acceptance: 'NOT_RUN', failure_stage: 'preflight' };
  try {
    requireValue(args.length === 1, 'invalid_cli');
    step = 'local_inputs'; const inputs = readInputsBounded(args[0]);
    step = 'core_selection'; const selection = readExternalCoreSelection(inputs);
    step = 'browser_dependency';
    const { chromium } = await import('/home/sebastian/Projects/jukelet/frontend/node_modules/@playwright/test/index.mjs');
    requireValue(JSON.parse(readFileSync('/home/sebastian/Projects/jukelet/frontend/node_modules/playwright-core/package.json', 'utf8')).version === '1.64.1');
    step = 'tls'; const certificate = new X509Certificate(inputs.certificate);
    const tls = { certificate_sha256: HASH(inputs.certificate),
      spki: createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64') };
    step = 'case_lease'; selection.verify(); filesystem = openCaseLease('inert', selection.coreVersion);
    step = 'source_lease'; const provenance = sourceLease();
    step = 'attachment'; session = await createExternalBrowserSession(chromium, inputs, tls, attachReport);
    step = 'selected_core'; selection.verify(); requireValue(session.coreVersion === selection.coreVersion, 'core_profile_changed');
    // Hard deny all HTTP and sockets: only own about:blank/srcdoc/Blob infrastructure is used.
    step = 'http_fence'; await bounded(() => session.context.route('**/*', route => route.abort('blockedbyclient')), 3000);
    step = 'websocket_fence'; await bounded(() => session.context.routeWebSocket('**/*', socket => socket.close()), 3000);
    step = 'browser_cdp'; const cdp = await bounded(() => session.browser.newBrowserCDPSession(), 3000);
    step = 'page_cdp'; const pageSession = await bounded(() => session.context.newCDPSession(session.page), 3000);
    step = 'inert_probe'; report = await runInertProbe({ ...session, coreVersion: selection.coreVersion, session: cdp, pageSession, filesystem,
      verifySource: () => { selection.verify(); provenance.verify(); }, artifact: verifyDownloadArtifact });
    step = 'provenance'; report = { ...report, core_version: selection.coreVersion, provenance: { ...provenance.receipt,
      core_profiles_source_sha256: HASH(readFileSync(`${REPOSITORY}/scripts/haos_acceptance/browser_core_profiles.mjs`)) } };
  } catch {
    failed = true;
    if (session) { try { await bounded(() => session.cleanup(), 11000); } catch { /* FAIL retained */ } }
    if (filesystem) { try { filesystem.close(); } catch { /* FAIL retained */ } }
  }
  report = withInertPreflightDiagnostics(report, step, attachReport, { failed, attachmentReturned: !!session });
  process.stdout.write(`${JSON.stringify(report)}\n`); process.exitCode = report.result === 'PASS' ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
