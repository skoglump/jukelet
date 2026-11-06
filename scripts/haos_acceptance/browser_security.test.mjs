/** Pure local controls only; no HA/browser processes or real credentials. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { SecurityGuard, assessDeniedResponse, forgedIdentityHeaders, inspectDeniedPrincipal, parseSecurityReceipt, supervisorCookieEvidence,
  validateSecurityReceipt, waitForDeniedPrincipal } from './browser_security.mjs';

const prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
function route(headers) {
  const parent = { parentFrame: () => null }, actions = [];
  const request = { frame: () => parent, url: () => 'https://127.0.0.1:18223' + prefix, method: () => 'GET',
    resourceType: () => 'document', isNavigationRequest: () => true, allHeaders: async () => headers };
  return { parent, actions, request: () => request, abort: async () => actions.push('abort'), continue: async () => actions.push('continue') };
}

const user = '1'.repeat(32), userHash = hash(user);
const principal = { outcome: 'PASS', user_id_sha256: userHash, is_admin: false, connected: true };
const sidebar = { rendered: true, visible_navigation_links: true, dedicated_jukelet_link_absent: true };
const headers = { host: '127.0.0.1:18223', cookie: 'ingress_session=SYNTHETIC_OWN_COOKIE', 'user-agent': 'synthetic' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function childRoute(kind = 'security-denied', { timeoutMs = 20000, headerRead = async () => headers, url = LOCAL_ORIGIN + prefix, unknown = false } = {}) {
  const parent = { parentFrame: () => null }, child = { parentFrame: () => parent }, actions = [], scopes = { escaped: 0, blocked: 0 };
  const guard = new SecurityGuard(kind, { ingress_prefix: prefix, denied_user_id_sha256: userHash }, () => {},
    { timeoutMs, onEscape: () => { scopes.escaped += 1; }, onBlocked: async () => { scopes.blocked += 1; } });
  guard.native.bindParent(parent); guard.native.armIngress();
  const request = { frame: () => unknown ? { parentFrame: () => null } : child, url: () => url, method: () => 'GET',
    resourceType: () => 'document', isNavigationRequest: () => true, allHeaders: headerRead };
  return { guard, actions, scopes, route: { request: () => request, abort: async () => actions.push({ kind: 'abort' }),
    continue: async value => actions.push({ kind: 'continue', value }) } };
}

function receipt() {
  return { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN, configuration_denied_sha256: 'a'.repeat(64),
    actual_candidate_image_manifest_digest: 'sha256:' + 'b'.repeat(64), actual_bridge_archive_sha256: 'c'.repeat(64),
    denied_user_id_sha256: userHash, denied_group_ids: ['system-users'], denied_is_admin: false, ingress_prefix: prefix,
    publisher_id_sha256: 'd'.repeat(64), assignment_snapshot_sha256: 'e'.repeat(64), domain_revision: 13, published_revision: 1,
    published_checksum: 'f'.repeat(64), automatic_publication_disabled: true, dispatch_disabled: true,
    backup_artifact_sha256: '1'.repeat(64), source_prerequisite_report_sha256: '2'.repeat(64), observed_at: '2026-11-01T22:24:55Z' };
}

test('the actual installed anonymous route refuses an authenticated request instead of calling it anonymous', async () => {
  const value = route({ cookie: 'ingress_session=SYNTHETIC_NOT_ANONYMOUS' });
  const guard = new SecurityGuard('security-anonymous', { ingress_prefix: prefix }, () => {});
  guard.native.bindParent(value.parent); await guard.handle(value);
  assert.deepEqual(value.actions, ['abort']); assert.equal(guard.forwarded, 0);
});

test('actual installed first-child handler binds and holds before forwarding exactly once after observed principal and sidebar', async () => {
  const value = childRoute(); const pending = value.guard.handle(value.route); await tick();
  assert.equal(value.guard.pending.size, 1); assert.deepEqual(value.actions, []);
  value.guard.release(principal, sidebar); await pending;
  assert.deepEqual(value.actions, [{ kind: 'continue', value: undefined }]); assert.equal(value.guard.forwarded, 1);
  assert.equal(value.guard.cookie.own_supervisor_cookie_sha256, hash('SYNTHETIC_OWN_COOKIE'));
  await value.guard.handle(value.route); assert.equal(value.actions.at(-1).kind, 'abort'); assert.equal(value.guard.forwarded, 1);
  await value.guard.drain(); assert.equal(value.guard.pending.size, 0);
});

test('wrong identity/sidebar/timeout and cleanup fencing never forward a held or late exact request', async () => {
  for (const [observed, nav] of [[{ ...principal, is_admin: true }, sidebar], [principal, { ...sidebar, rendered: false }],
    [{ ...principal, user_id_sha256: '0'.repeat(64) }, sidebar], [principal, { ...sidebar, dedicated_jukelet_link_absent: false }]]) {
    const value = childRoute(); const pending = value.guard.handle(value.route); await tick();
    assert.throws(() => value.guard.release(observed, nav)); value.guard.fence(); await value.guard.drain(); await pending;
    assert.equal(value.guard.forwarded, 0); assert.equal(value.actions[0].kind, 'abort');
    assert.throws(() => value.guard.release(principal, sidebar));
  }
  const timeout = childRoute('security-denied', { timeoutMs: 5 }); await timeout.guard.handle(timeout.route);
  assert.equal(timeout.guard.failed, 'security_hold_deadline'); assert.equal(timeout.guard.forwarded, 0); await timeout.guard.drain();
  let resolveHeaders; const late = childRoute('security-denied', { headerRead: () => new Promise(done => { resolveHeaders = done; }) });
  const pending = late.guard.handle(late.route); await tick(); late.guard.release(principal, sidebar); await tick();
  late.guard.fence(); resolveHeaders(headers); await pending; await late.guard.drain();
  assert.equal(late.guard.forwarded, 0); assert.deepEqual(late.actions, [{ kind: 'abort' }]);
});

test('fencing invokes the held route abort synchronously before any cleanup await', async () => {
  const value = childRoute(); const pending = value.guard.handle(value.route); await tick();
  value.guard.fence(); assert.deepEqual(value.actions, [{ kind: 'abort' }]);
  await value.guard.drain(); await pending; assert.equal(value.guard.forwarded, 0);
});

test('installed route guard refuses unknown child and wrong canonical prefix before any hold or network continuation', async () => {
  for (const options of [{ unknown: true }, { url: LOCAL_ORIGIN + '/api/hassio_ingress/OTHER/' }, { url: LOCAL_ORIGIN + '/api/v1/session' }]) {
    const value = childRoute('security-denied', options); await value.guard.handle(value.route);
    assert.equal(value.actions[0].kind, 'abort'); assert.equal(value.guard.pending.size, 0); assert.equal(value.guard.forwarded, 0);
    assert.equal(value.scopes.blocked, 1); await value.guard.drain();
  }
});

test('forged branch changes only three synthetic identity headers and retains actual native cookie without forwarding spoof headers', async () => {
  const value = childRoute('security-forged'); const pending = value.guard.handle(value.route); await tick();
  value.guard.release(principal, sidebar); await pending; await value.guard.drain();
  const sent = value.actions[0].value.headers;
  assert.equal(sent.cookie, headers.cookie); assert.equal(sent['user-agent'], headers['user-agent']);
  assert.equal(sent['x-remote-user-id'], 'f'.repeat(32)); assert.equal(sent['x-remote-user-groups'], 'system-admin');
  assert.equal(sent['x-ingress-path'], prefix.slice(0, -1)); assert.equal(sent['x-forwarded-for'], undefined); assert.equal(sent.forwarded, undefined);
  assert.equal(value.guard.forgery_applied, true); assert.equal(value.guard.forwarded, 1);
  assert.deepEqual(supervisorCookieEvidence(sent), supervisorCookieEvidence(headers));
  const original = { ...headers }; forgedIdentityHeaders(original, prefix); assert.deepEqual(original, headers);
});

test('cookie projection rejects missing/ambiguous/owner app cookies and authorization without leaking values', () => {
  assert.equal(supervisorCookieEvidence(headers).app_cookie_present, false);
  assert.ok(!JSON.stringify(supervisorCookieEvidence(headers)).includes('SYNTHETIC_OWN_COOKIE'));
  for (const bad of [{}, { cookie: '' }, { cookie: 'ingress_session=A; ingress_session=B' },
    { cookie: headers.cookie + '; jukelet_ingress_session=SECRET' }, { ...headers, authorization: 'Bearer SECRET' }]) assert.throws(() => supervisorCookieEvidence(bad));
});

test('the actual public parent observation accepts only the receipt-bound nonadmin and never touches auth storage', async () => {
  const hass = { connected: true, connection: { connected: true }, user: { id: user, is_admin: false } };
  Object.defineProperty(hass, 'auth', { get() { throw new Error('must not read auth'); } });
  const scope = { location: { origin: LOCAL_ORIGIN }, crypto: globalThis.crypto,
    document: { querySelector: () => ({ tagName: 'HOME-ASSISTANT', hass }) } };
  assert.deepEqual(await inspectDeniedPrincipal({ expected_user_id_sha256: userHash }, scope), principal);
  hass.user.is_admin = true; assert.equal((await inspectDeniedPrincipal({ expected_user_id_sha256: userHash }, scope)).outcome, 'AUTH_DENIED');
  hass.user.is_admin = false; assert.equal((await inspectDeniedPrincipal({ expected_user_id_sha256: '0'.repeat(64) }, scope)).outcome, 'AUTH_DENIED');
  hass.connected = false; assert.equal(await inspectDeniedPrincipal({ expected_user_id_sha256: userHash }, scope), false);
  scope.location.origin = 'https://example.invalid'; assert.equal((await inspectDeniedPrincipal({ expected_user_id_sha256: userHash }, scope)).outcome, 'INVALID_CONTEXT');
});

test('principal polling refuses invalid or longer than twenty-second deadlines before touching the page', async () => {
  const page = { evaluate: () => { assert.fail('invalid deadline must not observe the page'); } };
  for (const timeoutMs of [0, -1, 20001, 1.5, NaN]) await assert.rejects(waitForDeniedPrincipal(page, { expected_user_id_sha256: userHash }, { timeoutMs }));
});

test('strict receipt binds current artifact/config/principal/history and rejects duplicate, stale, future and promoted-role inputs', () => {
  const value = receipt(), now = Date.parse(value.observed_at), inputs = { configuration_sha256: value.configuration_denied_sha256,
    document: { candidate: { image_manifest_digest: value.actual_candidate_image_manifest_digest }, bridge: { archive_sha256: value.actual_bridge_archive_sha256 } } };
  assert.deepEqual(parseSecurityReceipt(JSON.stringify(value)), value); assert.equal(validateSecurityReceipt(value, inputs, now).saved_revision, 13);
  for (const mutate of [v => { v.denied_is_admin = true; }, v => { v.denied_group_ids = ['system-admin']; }, v => { v.published_revision = 0; },
    v => { v.domain_revision = 11; }, v => { v.configuration_denied_sha256 = '0'.repeat(64); }, v => { v.ingress_prefix = prefix + '?bad'; },
    v => { v.automatic_publication_disabled = false; }, v => { v.extra = true; }]) {
    const bad = structuredClone(value); mutate(bad); assert.throws(() => validateSecurityReceipt(bad, inputs, now));
  }
  assert.throws(() => validateSecurityReceipt(value, inputs, now + 3600001)); assert.throws(() => validateSecurityReceipt(value, inputs, now - 1));
  assert.throws(() => parseSecurityReceipt(JSON.stringify(value).replace('{', '{"schema_version":1,')));
});

test('real denial assessment needs actual gateway status/body and no cookie or app bootstrap', async () => {
  const value = childRoute(); const pending = value.guard.handle(value.route); await tick(); value.guard.release(principal, sidebar); await pending; value.guard.fence();
  const assess = (status = 403, body = '403: Forbidden', names = [], cookieCount = 0, mediaType = 'text/plain') => assessDeniedResponse('security-denied', status, Buffer.from(body), names, cookieCount, value.guard, mediaType);
  assert.equal(assess().privileged_app_access, false);
  for (const args of [[200], [403, '<html>PRIVATE</html>'], [403, '403: Forbidden', ['Set-Cookie']], [403, '403: Forbidden', [], 1],
    [403, '403: Forbidden', [], 0, 'text/html']]) assert.throws(() => assess(...args));
  value.guard.bootstrap += 1; assert.throws(() => assess()); await value.guard.drain();
});

test('clean import/help/invalid path need no browser dependency and never disclose input paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'jukelet-security-pure-'));
  try {
    const scripts = join(root, 'scripts', 'haos_acceptance'); mkdirSync(scripts, { recursive: true });
    for (const name of ['browser_security.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs'])
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), name), join(scripts, name));
    const module = join(scripts, 'browser_security.mjs');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(module).href)})`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(imported.status, 0); assert.equal(imported.stdout + imported.stderr, '');
    assert.equal(spawnSync(process.execPath, [module, '--help'], { timeout: 5000 }).status, 0);
    const failed = spawnSync(process.execPath, [module, 'security-denied', '/tmp/SECRET_INVALID_INPUT'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).stage, 'local_inputs'); assert.equal((failed.stdout + failed.stderr).includes('SECRET'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
