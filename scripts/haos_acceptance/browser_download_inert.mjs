/** Inert prerequisite only. Imports do not attach, read controls, or start Chrome. */
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyDownloadArtifact, ARTIFACT_ROOT } from './download_artifact.mjs';
import { createExternalBrowserSession, parseExternalLease } from './browser_external.mjs';
import { sameIdentity, readBoundedFile, CONTROL_ROOT } from './browser_inputs.mjs';

import { CASES, INERT_BYTES, EXPORT_CASE, runInertProbe } from './browser_download_policy.mjs';
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
export function openCaseLease(mode = 'inert') {
  requireValue(['inert', 'export'].includes(mode), 'invalid_case');
  const cases = mode === 'inert' ? [CASES.positive, CASES.wrongframe] : [EXPORT_CASE];
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
    return { verify, entries, close() { let bad = false; for (const fd of descriptors.reverse()) {
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

async function main(args) {
  let session, filesystem, report = { fixture: FIXTURE, phase: 'external-download-policy-inert', result: 'FAIL',
    scope: 'inert_prerequisite_only', ha_acceptance: 'NOT_RUN', failure_stage: 'preflight' };
  try {
    requireValue(args.length === 1, 'invalid_cli');
    const inputs = readInputsBounded(args[0]);
    const { chromium } = await import('/home/sebastian/Projects/jukelet/frontend/node_modules/@playwright/test/index.mjs');
    requireValue(JSON.parse(readFileSync('/home/sebastian/Projects/jukelet/frontend/node_modules/playwright-core/package.json', 'utf8')).version === '1.64.1');
    const certificate = new X509Certificate(inputs.certificate);
    const tls = { certificate_sha256: HASH(inputs.certificate),
      spki: createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64') };
    filesystem = openCaseLease(); const provenance = sourceLease(), attachReport = { checks: {} };
    session = await createExternalBrowserSession(chromium, inputs, tls, attachReport);
    // Hard deny all HTTP and sockets: only own about:blank/srcdoc/Blob infrastructure is used.
    await bounded(() => session.context.route('**/*', route => route.abort('blockedbyclient')), 3000);
    await bounded(() => session.context.routeWebSocket('**/*', socket => socket.close()), 3000);
    const cdp = await bounded(() => session.browser.newBrowserCDPSession(), 3000);
    const pageSession = await bounded(() => session.context.newCDPSession(session.page), 3000);
    report = await runInertProbe({ ...session, session: cdp, pageSession, filesystem,
      verifySource: provenance.verify, artifact: verifyDownloadArtifact });
    report = { ...report, provenance: provenance.receipt };
  } catch {
    if (session) { try { await bounded(() => session.cleanup(), 11000); } catch { /* FAIL retained */ } }
    if (filesystem) { try { filesystem.close(); } catch { /* FAIL retained */ } }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`); process.exitCode = report.result === 'PASS' ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
