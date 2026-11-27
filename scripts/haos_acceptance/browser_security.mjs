/** Owned native negative cases only. Imports perform no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assessNetworkBoundaries, createNativeRequestGuard, queryFixture, verifyTLS } from './browser.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, ingressPrefix, readBoundedFile, readCredentials, readOnlyRequestAllowed,
  blockedEndpointEvidence, blockedRequestCategory, expectedTypeErrorUndefinedAddEventListener, headerPresence, matchesInvestigatedRequest,
  pageErrorSource, projectPageErrorFrames, readPublicInputs, serviceWorkerSourceLookup, websocketAllowed } from './browser_inputs.mjs';
import { createProgressStream, memoizedBrowserCleanup, withinDeadline } from './browser_progress.mjs';

const CASES = ['security-anonymous', 'security-denied', 'security-forged'];
const FIELDS = ['schema_version', 'fixture', 'synthetic', 'origin', 'configuration_denied_sha256', 'actual_candidate_image_manifest_digest',
  'actual_bridge_archive_sha256', 'denied_user_id_sha256', 'denied_group_ids', 'denied_is_admin', 'ingress_prefix', 'publisher_id_sha256',
  'assignment_snapshot_sha256', 'domain_revision', 'published_revision', 'published_checksum', 'automatic_publication_disabled',
  'dispatch_disabled', 'backup_artifact_sha256', 'source_prerequisite_report_sha256', 'observed_at'];

export function parseSecurityReceipt(raw) {
  const value = JSON.parse(raw), tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const keys = tokens.flatMap((token, index) => tokens[index + 1] === ':' ? [JSON.parse(token)] : []);
  assert.equal(keys.length, FIELDS.length); assert.equal(new Set(keys).size, keys.length); return value;
}

export function validateSecurityReceipt(value, inputs, now = Date.now()) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype); assert.deepEqual(Object.keys(value).sort(), [...FIELDS].sort());
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, FIXTURE); assert.equal(value.synthetic, true); assert.equal(value.origin, LOCAL_ORIGIN);
  assert.equal(value.configuration_denied_sha256, inputs.configuration_sha256);
  assert.equal(value.actual_candidate_image_manifest_digest, inputs.document.candidate.image_manifest_digest);
  assert.match(value.actual_candidate_image_manifest_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(value.actual_bridge_archive_sha256, inputs.document.bridge.archive_sha256);
  for (const key of ['configuration_denied_sha256', 'actual_bridge_archive_sha256', 'denied_user_id_sha256', 'publisher_id_sha256',
    'assignment_snapshot_sha256', 'published_checksum', 'backup_artifact_sha256', 'source_prerequisite_report_sha256']) assert.match(value[key], /^[a-f0-9]{64}$/);
  assert.deepEqual(value.denied_group_ids, ['system-users']); assert.equal(value.denied_is_admin, false);
  assert.equal(ingressPrefix(LOCAL_ORIGIN + value.ingress_prefix), value.ingress_prefix);
  assert.equal(value.domain_revision, 13); assert.equal(value.published_revision, 1);
  assert.equal(value.automatic_publication_disabled, true); assert.equal(value.dispatch_disabled, true);
  const observed = Date.parse(value.observed_at); assert.ok(Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= 3600000);
  return { configuration_sha256: inputs.configuration_sha256, denied_user_id_sha256: value.denied_user_id_sha256,
    ingress_prefix_sha256: hash(value.ingress_prefix), saved_revision: 13, published_revision: 1,
    prerequisite_report_sha256: value.source_prerequisite_report_sha256, receipt_observed_at: value.observed_at };
}

export function supervisorCookieEvidence(headers) {
  const cookies = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'cookie');
  assert.equal(cookies.length, 1); const pairs = cookies[0][1].split(';').map(value => value.trim());
  const selected = pairs.filter(value => value.slice(0, value.indexOf('=')) === 'ingress_session'); assert.equal(selected.length, 1);
  const value = selected[0].slice(selected[0].indexOf('=') + 1); assert.ok(value.length > 0 && value.length <= 4096);
  assert.equal(pairs.some(value => value.startsWith('jukelet_ingress_session=')), false);
  assert.equal(Object.keys(headers).some(name => name.toLowerCase() === 'authorization'), false);
  return { own_supervisor_cookie_sha256: hash(value), app_cookie_present: false, authorization_header_present: false };
}

export function forgedIdentityHeaders(headers, prefix) {
  ingressPrefix(LOCAL_ORIGIN + prefix);
  const result = Object.fromEntries(Object.entries(headers).filter(([name]) => !['x-ingress-path', 'x-remote-user-id', 'x-remote-user-groups'].includes(name.toLowerCase())));
  return { ...result, 'x-ingress-path': prefix.slice(0, -1), 'x-remote-user-id': 'f'.repeat(32), 'x-remote-user-groups': 'system-admin' };
}

// Actual route continuation is held only until the already authenticated parent
// and rendered sidebar have been observed. Fence synchronously revokes every
// pending continuation before any browser cleanup is awaited.
export class SecurityGuard {
  constructor(kind, receipt, verify, { timeoutMs = 20000, onEscape = () => {}, onBlocked = async () => {} } = {}) {
    assert.ok(CASES.includes(kind)); assert.ok(timeoutMs > 0 && timeoutMs <= 20000);
    Object.assign(this, { kind, receipt, verify, timeoutMs, closed: false, released: false, claimed: false, attempts: 0, forwarded: 0, bootstrap: 0, failed: null });
    this.pending = new Set(); this.work = new Set(); this.proof = new Promise(done => { this.prove = done; });
    this.native = createNativeRequestGuard({ onEscape, onBlocked, requestAllowed: (request, scope) => this.allow(request, scope) });
  }
  allow(request, { fromFrame, prefix }) {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/')) { this.bootstrap += 1; return false; }
    if (url.pathname.startsWith('/api/hassio_ingress/')) {
      this.attempts += 1;
      if (this.closed || this.claimed || url.href !== LOCAL_ORIGIN + this.receipt.ingress_prefix || request.method() !== 'GET'
        || request.resourceType() !== 'document' || !request.isNavigationRequest()
        || (this.kind !== 'security-anonymous' && (!fromFrame || prefix !== this.receipt.ingress_prefix))) { this.bootstrap += 1; return false; }
      this.claimed = true; return true;
    }
    // Terminal fencing revokes Ingress, while the owned HA parent's ordinary
    // auth/read traffic is left unchanged until the context is closed.
    return readOnlyRequestAllowed(request.url(), request.method());
  }
  release(principal, sidebar) {
    assert.equal(this.closed, false); assert.equal(this.failed, null); this.verify();
    assert.deepEqual(principal, { outcome: 'PASS', user_id_sha256: this.receipt.denied_user_id_sha256, is_admin: false, connected: true });
    assert.deepEqual(sidebar, { rendered: true, visible_navigation_links: true, dedicated_jukelet_link_absent: true });
    this.released = true; this.prove(true);
  }
  finish(entry, forward, headers) {
    if (entry.done) return entry.result;
    entry.done = true; this.pending.delete(entry);
    try {
      if (forward && !this.closed && (this.released || this.kind === 'security-anonymous')) {
        this.forwarded += 1; entry.result = Promise.resolve(entry.route.continue(headers ? { headers } : undefined));
      } else entry.result = Promise.resolve(entry.route.abort());
    } catch { entry.result = Promise.reject(new Error('security_route_completion_failed')); }
    this.work.add(entry.result); entry.result.catch(() => { this.failed ??= 'route_completion_failed'; }); return entry.result;
  }
  async handle(route) {
    const request = route.request();
    await this.native.handle({ request: () => request, abort: () => route.abort(), continue: async () => {
      if (request.url() !== LOCAL_ORIGIN + this.receipt.ingress_prefix) return route.continue();
      const entry = { route, done: false }; this.pending.add(entry); let timer;
      try {
        if (this.kind !== 'security-anonymous') {
          const ready = await Promise.race([this.proof, new Promise(done => { timer = setTimeout(() => { this.failed ??= 'security_hold_deadline'; done(false); }, this.timeoutMs); })]);
          if (!ready || this.closed) return await this.finish(entry, false);
          const headers = await withinDeadline('native_evaluate', () => request.allHeaders(), { timeoutMs: 2000 });
          this.cookie = supervisorCookieEvidence(headers);
          if (this.kind === 'security-forged') {
            const forged = forgedIdentityHeaders(headers, this.receipt.ingress_prefix);
            assert.deepEqual(supervisorCookieEvidence(forged), this.cookie); this.forgery_applied = true;
            return await this.finish(entry, true, forged);
          }
        } else {
          const headers = await withinDeadline('native_evaluate', () => request.allHeaders(), { timeoutMs: 2000 });
          assert.equal(Object.keys(headers).some(name => ['cookie', 'authorization'].includes(name.toLowerCase())), false);
          this.anonymous_headers_absent = true;
        }
        return await this.finish(entry, true);
      } catch { this.failed ??= 'security_route_failed'; return await this.finish(entry, false); }
      finally { clearTimeout(timer); }
    } });
  }
  fence() { this.closed = true; this.prove(false); for (const entry of this.pending) this.finish(entry, false); }
  async drain() { this.fence(); await withinDeadline('native_evaluate', () => Promise.all([...this.work]), { timeoutMs: 2000 }); assert.equal(this.pending.size, 0); }
  evidence() { return { attempted_ingress_requests: this.attempts, forwarded_ingress_requests: this.forwarded,
    unexpected_bootstrap_attempts: this.bootstrap, pending_continuations: this.pending.size, gate_closed: this.closed,
    failure: this.failed, ...(this.cookie ? this.cookie : {}), anonymous_auth_headers_absent: this.anonymous_headers_absent === true,
    synthetic_identity_headers_applied: this.forgery_applied === true }; }
}

// Return false only while HA's normal initialization is incomplete. Wrong
// origin/principal/role is a terminal observation, never a request for a retry.
export async function inspectDeniedPrincipal(value, scope = globalThis) {
  if (!value || Object.keys(value).join(',') !== 'expected_user_id_sha256' || !/^[a-f0-9]{64}$/.test(value.expected_user_id_sha256)
    || scope.location?.origin !== 'https://127.0.0.1:18223') return { outcome: 'INVALID_CONTEXT' };
  const { expected_user_id_sha256 } = value;
  if (typeof scope.document?.querySelector !== 'function') return false;
  const element = scope.document?.querySelector('home-assistant'), hass = element?.hass;
  if (element?.tagName !== 'HOME-ASSISTANT' || !hass || hass.connected !== true || hass.connection?.connected !== true || !hass.user) return false;
  if (hass.user.is_admin !== false || typeof hass.user.id !== 'string' || !/^[a-f0-9]{32}$/.test(hass.user.id)) return { outcome: 'AUTH_DENIED' };
  const digest = await scope.crypto.subtle.digest('SHA-256', new TextEncoder().encode(hass.user.id));
  const user_id_sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  return user_id_sha256 === expected_user_id_sha256 ? { outcome: 'PASS', user_id_sha256, is_admin: false, connected: true } : { outcome: 'AUTH_DENIED' };
}

export async function waitForDeniedPrincipal(page, value, { timeoutMs = 20000, notify = () => {} } = {}) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 20000);
  const deadline = performance.now() + timeoutMs; let active = true;
  const checkDeadline = () => {
    if (!active || performance.now() >= deadline) throw Object.assign(new Error('native_deadline'), { code: 'native_deadline' });
  };
  try {
    return await withinDeadline('native_evaluate', async () => {
      while (true) {
        checkDeadline();
        // Playwright waitForFunction treats an async predicate's Promise as
        // truthy. evaluate awaits its result; only initialization false retries.
        const principal = await page.evaluate(inspectDeniedPrincipal, value);
        checkDeadline();
        if (principal !== false) return principal;
        await new Promise(done => setTimeout(done, Math.min(100, Math.max(1, deadline - performance.now()))));
      }
    }, { timeoutMs, notify });
  } finally { active = false; }
}

export function assessDeniedResponse(kind, status, bytes, headerNames, appCookieCount, guard, mediaType) {
  assert.ok(CASES.includes(kind)); assert.equal(status, kind === 'security-anonymous' ? 401 : 403);
  assert.equal(mediaType, 'text/plain');
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4096);
  assert.equal(bytes.toString('utf8').trim(), kind === 'security-anonymous' ? '401: Unauthorized' : '403: Forbidden');
  assert.equal(headerNames.some(name => name.toLowerCase() === 'set-cookie'), false); assert.equal(appCookieCount, 0);
  assert.equal(guard.failed, null); assert.equal(guard.attempts, 1); assert.equal(guard.forwarded, 1); assert.equal(guard.bootstrap, 0);
  if (kind !== 'security-anonymous') assert.ok(guard.cookie);
  else assert.equal(guard.anonymous_headers_absent, true);
  if (kind === 'security-forged') assert.equal(guard.forgery_applied, true);
  return { actual_status: status, gateway_body_sha256: hash(bytes), gateway_body_bytes: bytes.length,
    body_source: 'rendered_gateway_document_text', gateway_media_type: 'text/plain', html_app_document: false,
    no_app_cookie: true, no_set_cookie: true, app_bootstrap_requests: 0, privileged_app_access: false };
}

function networkObservers() {
  const network = { blocked_http: 0, blocked_websocket: 0, escaped_ingress: 0, page_errors: 0 };
  const categories = { blocked_http: {}, blocked_websocket: {}, page_error_types: {}, page_error_sources: {},
    blocked_http_endpoints: [], blocked_http_endpoint_overflow: 0, page_error_frames: [], page_error_predicates: [], investigated_request_headers: [] };
  const increment = (group, key) => { group[key] = (group[key] ?? 0) + 1; };
  return { network, categories,
    onEscape: () => { network.escaped_ingress += 1; },
    onBlocked: async (request, context) => {
      network.blocked_http += 1; increment(categories.blocked_http, blockedRequestCategory(request.url(), request.method(), request.resourceType(), context));
      const endpoint = blockedEndpointEvidence(request.url());
      const previous = categories.blocked_http_endpoints.find(row => JSON.stringify(row.endpoint) === JSON.stringify(endpoint));
      if (previous) previous.count += 1;
      else if (categories.blocked_http_endpoints.length < 16) categories.blocked_http_endpoints.push({ endpoint, count: 1 });
      else categories.blocked_http_endpoint_overflow += 1;
      const source = serviceWorkerSourceLookup(request.url());
      if ((matchesInvestigatedRequest(request.url()) || source) && categories.investigated_request_headers.length < 4) {
        let headers = null;
        try { headers = await withinDeadline('native_evaluate', () => request.allHeaders(), { timeoutMs: 1000 }); } catch { /* Unavailable headers cannot qualify for the known warning. */ }
        categories.investigated_request_headers.push({ ...headerPresence(headers), hasQueryString: new URL(request.url()).search !== '', source_lookup: source });
      }
    },
    pageError: error => {
      network.page_errors += 1;
      increment(categories.page_error_types, ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(error.name) ? error.name : 'Other');
      increment(categories.page_error_sources, pageErrorSource(error.stack));
      if (categories.page_error_frames.length < 4) categories.page_error_frames.push(projectPageErrorFrames(error.stack));
      if (categories.page_error_predicates.length < 4) categories.page_error_predicates.push({ source: pageErrorSource(error.stack),
        expectedTypeErrorUndefinedAddEventListener: expectedTypeErrorUndefinedAddEventListener(error.name, error.message, error.stack) });
    },
    websocket: socket => {
      if (!websocketAllowed(socket.url())) {
        network.blocked_websocket += 1; increment(categories.blocked_websocket, blockedRequestCategory(socket.url(), 'GET', 'websocket', 'unknown')); return socket.close();
      }
      socket.connectToServer();
    } };
}

export async function runSecurity(kind, path, { progress = () => {} } = {}) {
  const report = { fixture: FIXTURE, phase: kind, stage: 'local_inputs', result: 'FAIL', checks: {}, limitations: [
    'One preplanned negative case per fresh browser. Expected401/403 terminates that case; no authority/transport change or credential retry.',
    'Denied cases use the official generic app route and the native frontend own-session/cookie flow. No cookie injection, raw WebSocket capture, auth-storage access or API response substitution.',
    'Forged browser headers are synthetic identity/Ingress only. Forwarded/XFF spoofing, trusted-source malformed headers and direct-listener/topology proof are separate coordinator-executed packet cases.',
    'Supervisor403 is observed before app loading; this does not claim direct observation of Supervisor internal header sanitization. Durable state/script/image readback remains coordinator evidence.',
  ] };
  let browser, context, page, guard, measured;
  const notify = value => progress({ role: 'coordinator', stage: report.stage, ...value });
  const stage = value => { report.stage = value; notify({ operation: 'phase', checkpoint: 'begin' }); };
  const cleanup = memoizedBrowserCleanup(() => browser, { notify }, value => { report.checks.cleanup = value; });
  try {
    assert.ok(CASES.includes(kind));
    report.probe_sources_sha256 = Object.fromEntries(['browser_security.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs']
      .map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = readPublicInputs(path); stage('root_readiness_receipt');
    const bytes = readBoundedFile(join(CONTROL_ROOT, 'security-ready.json'), 16384), receipt = parseSecurityReceipt(bytes.toString('utf8'));
    const verify = () => validateSecurityReceipt(receipt, inputs); report.checks.readiness = { ...verify(), file_sha256: hash(bytes) };
    stage('qmp_identity'); report.checks.vm = await queryFixture(); stage('tls'); const tls = await verifyTLS(inputs.certificate);
    report.checks.tls = { ca_and_hostname_verified: true, certificate_sha256: tls.certificate_sha256, chromium_spki_pinned: true };
    let credentials;
    if (kind !== 'security-anonymous') { stage('private_browser_credentials'); credentials = readCredentials(inputs.document, 'denied'); }
    stage('browser_dependencies'); const { chromium, expect } = await import(pathToFileURL(join(REPOSITORY, 'frontend/node_modules/@playwright/test/index.mjs')).href);
    browser = await chromium.launch({ headless: true, timeout: 20000, args: [`--ignore-certificate-errors-spki-list=${tls.spki}`] });
    context = await withinDeadline('browser_context', () => browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }), { notify });
    context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000); assert.equal((await context.cookies()).length, 0);
    measured = networkObservers(); report.checks.network = measured.network; report.checks.network_categories = measured.categories;
    guard = new SecurityGuard(kind, receipt, verify, measured);
    await context.route('**/*', route => guard.handle(route)); await context.routeWebSocket('**', measured.websocket);
    page = await context.newPage(); guard.native.bindParent(page.mainFrame());
    if (kind !== 'security-anonymous') guard.native.armIngress();
    page.on('pageerror', measured.pageError);
    const target = LOCAL_ORIGIN + receipt.ingress_prefix;
    const waiting = page.waitForResponse(response => response.url() === target && response.request().method() === 'GET', { timeout: 60000 }); waiting.catch(() => {});
    if (kind === 'security-anonymous') {
      stage('security_expected_denial'); await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      stage('normal_ha_login'); await page.goto(LOCAL_ORIGIN + '/app/local_jukelet', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.getByLabel('Username', { exact: true }).fill(credentials.username);
      await page.getByLabel('Password', { exact: true }).fill(credentials.password);
      await page.getByRole('button', { name: 'Log in', exact: true }).click({ noWaitAfter: true });
      const save = page.getByRole('button', { name: 'Save login', exact: true }); if (await save.isVisible().catch(() => false)) await save.click({ noWaitAfter: true });
      stage('security_principal');
      const principal = await waitForDeniedPrincipal(page, { expected_user_id_sha256: receipt.denied_user_id_sha256 }, { notify });
      assert.deepEqual(principal, { outcome: 'PASS', user_id_sha256: receipt.denied_user_id_sha256, is_admin: false, connected: true }); report.checks.principal = principal;
      assert.equal(new URL(page.url()).pathname, '/app/local_jukelet'); report.checks.official_generic_route = true;
      stage('security_sidebar'); const sidebar = page.locator('ha-sidebar'); await expect(sidebar).toBeVisible();
      await expect(sidebar.getByRole('link').first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Jukelet', exact: true })).toHaveCount(0);
      report.checks.sidebar = { rendered: true, visible_navigation_links: true, dedicated_jukelet_link_absent: true };
      verify(); guard.release(principal, report.checks.sidebar); stage('security_expected_denial');
    }
    const response = await withinDeadline('response_headers', () => waiting, { timeoutMs: 30000, notify });
    // Revoke first, before any awaited post-denial observation or cleanup.
    guard.fence();
    const frame = response.request().frame(); assert.equal(response.url(), target);
    if (kind !== 'security-anonymous') guard.native.observeIngress(frame, response.url()); else assert.equal(frame, page.mainFrame());
    const headers = await withinDeadline('response_headers', () => response.allHeaders(), { timeoutMs: 2000, notify });
    const body = await withinDeadline('dom', () => frame.locator('body').innerText({ timeout: 5000 }), { timeoutMs: 7000, notify });
    const cookies = await context.cookies(target); const appCookies = cookies.filter(value => value.name === 'jukelet_ingress_session');
    report.checks.denial = assessDeniedResponse(kind, response.status(), Buffer.from(body), Object.keys(headers), appCookies.length, guard,
      (headers['content-type'] ?? '').split(';')[0].trim());
    if (kind !== 'security-anonymous') {
      const own = cookies.filter(value => value.name === 'ingress_session'); assert.equal(own.length, 1);
      assert.equal(hash(own[0].value), guard.cookie.own_supervisor_cookie_sha256); assert.equal(own[0].secure, true);
      assert.equal(own[0].sameSite, 'Strict'); assert.equal(own[0].path, '/api/hassio_ingress/'); assert.equal(own[0].httpOnly, false);
      assert.equal(own[0].domain, '127.0.0.1'); assert.equal(own[0].expires, -1);
      report.checks.native_own_cookie = { unchanged_sha256: hash(own[0].value), secure: true, sameSite: 'Strict', path_expected: true, native_frontend_cookie: true };
    } else assert.equal(cookies.some(value => ['ingress_session', 'jukelet_ingress_session'].includes(value.name)), false);
    await expect(frame.getByRole('heading', { name: 'Your tag and music manager', exact: true })).toHaveCount(0);
    await expect(frame.getByLabel('App secret', { exact: true })).toHaveCount(0);
    await guard.drain(); stage('close_browsers_and_assess'); assert.equal((await cleanup()).cleanup_confirmed, true);
    report.checks.network_assessment = assessNetworkBoundaries(measured.network, measured.categories);
    assert.equal(guard.failed, null); report.result = 'PASS'; stage('complete'); notify({ operation: 'phase', checkpoint: 'complete' });
  } catch (error) {
    report.code = error?.code === 'native_deadline' ? 'native_deadline' : 'native_security_failed'; notify({ operation: 'phase', checkpoint: 'failed' });
  } finally {
    guard?.fence();
    try { if (guard) await guard.drain(); } catch { report.result = 'FAIL'; report.code = 'security_pending_abort_unconfirmed'; }
    if (!(await cleanup()).cleanup_confirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
    report.guard = guard?.evidence() ?? { gate_closed: true, pending_continuations: 0 }; report.any_gate_enabled = guard ? !guard.closed : false;
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write('node scripts/haos_acceptance/browser_security.mjs security-anonymous|security-denied|security-forged CONFIG_DENIED\n');
  else if (args.length === 2 && CASES.includes(args[0])) {
    const report = await runSecurity(args[0], args[1], { progress: createProgressStream(line => process.stderr.write(line)) });
    const unconfirmed = report.checks.cleanup?.cleanup_confirmed === false;
    if (unconfirmed) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; report.forced_exit_after_report = true; }
    process.exitCode = report.result === 'PASS' ? 0 : 1;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => { if (unconfirmed) process.stderr.write('', () => process.exit(1)); });
  } else { process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'invalid_phase_arguments' }) + '\n'); process.exitCode = 2; }
}
