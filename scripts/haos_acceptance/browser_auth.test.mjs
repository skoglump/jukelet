/** Synthetic local auth-boundary cases; never read the actual private seed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareExpirySeed } from './browser.mjs';
import { LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { assessExpiryResponse, bindExpiryReplay, parseExpirySeedForReplay,
  protectedPollCategory, validateExpirySeedForReplay, wireCookieEvidence } from './browser_auth.mjs';

function seed() {
  const prefix = '/api/hassio_ingress/synthetic_A-123/';
  return prepareExpirySeed([
    { name: 'jukelet_ingress_session', value: 'A'.repeat(43), domain: '127.0.0.1', path: prefix.slice(0, -1),
      expires: Date.parse('2026-11-01T20:00:00Z') / 1000, httpOnly: true, secure: true, sameSite: 'Strict' },
    { name: 'ingress_session', value: 'SYNTHETIC_SUPERVISOR_O_COOKIE_0123456789', domain: '127.0.0.1',
      path: '/api/hassio_ingress/', expires: -1, httpOnly: false, secure: true, sameSite: 'Strict' },
  ], { prefix, user_id_sha256: 'b'.repeat(64), expires_at: '2026-11-01T20:00:00Z', configuration_sha256: 'c'.repeat(64) },
  { captured_at: '2026-11-01T12:00:00.000Z', closed_at: '2026-11-01T12:00:01.000Z' });
}

test('expiry replay refuses before the natural deadline without native or credential work', () => {
  const value = seed();
  assert.throws(() => validateExpirySeedForReplay(value, value.configuration_sha256,
    Date.parse(value.ingress_replay_not_before) - 1), /expiry_replay_too_early/);
});

test('expiry preflight binds the exact private schema, config and conservative closed-browser deadline', () => {
  const value = seed(), ready = Date.parse(value.ingress_replay_not_before);
  assert.equal(validateExpirySeedForReplay(value, value.configuration_sha256, ready), value);
  // The retained app A cookie is not used by this case. Its later expiry does
  // not establish natural app-backend expiry and must not prevent testing O.
  assert.equal(validateExpirySeedForReplay(value, value.configuration_sha256,
    Date.parse('2026-11-02T00:00:00Z')), value);
  for (const damage of [
    value => { value.schema_version = 1; },
    value => { value.fixture = 'another-fixture'; },
    value => { value.origin = 'https://example.invalid'; },
    value => { value.configuration_sha256 = 'a'.repeat(64); },
    value => { value.user_id_sha256 = 'raw-user'; },
    value => { value.prefix = '/api/hassio_ingress/unsafe//'; },
    value => { value.ingress_cookie.path = '/'; },
    value => { value.ingress_cookie.domain = 'example.invalid'; },
    value => { value.ingress_cookie.secure = false; },
    value => { value.ingress_cookie.sameSite = 'Lax'; },
    value => { value.ingress_cookie.expires = ready / 1000; },
    value => { value.ingress_cookie.value = 'bad; cookie'; },
    value => { value.cookie.path += '/'; },
    value => { value.cookie.httpOnly = false; },
    value => { value.cookie.value = 'wrong-length'; },
    value => { value.cookie.expires = 0; },
    value => { value.cookie_captured_at = '2026-11-01T12:00:02Z'; },
    value => { value.ingress_last_touch_upper_bound = value.cookie_captured_at; },
    value => { value.seeded_at = value.cookie_captured_at; },
    value => { value.ingress_replay_not_before = '2026-11-01T12:15:01.000Z'; },
    value => { value.expires_at = value.browser_closed_at; },
    value => { value.access_token = 'SYNTHETIC_PRIVATE_SENTINEL'; },
  ]) {
    const changed = structuredClone(value); damage(changed);
    assert.throws(() => validateExpirySeedForReplay(changed, value.configuration_sha256, ready));
  }
});

test('seed parser rejects duplicate or extra properties and changed serialization', () => {
  const value = seed(), ready = Date.parse(value.ingress_replay_not_before), raw = JSON.stringify(value) + '\n';
  assert.deepEqual(parseExpirySeedForReplay(raw, value.configuration_sha256, ready), value);
  for (const changed of [JSON.stringify(value), JSON.stringify(value, null, 2) + '\n',
    raw.replace('"schema_version":2', '"schema_version":2,"schema_version":2'),
    JSON.stringify({ ...value, storage_state: { access_token: 'SYNTHETIC_PRIVATE_SENTINEL' } }) + '\n']) {
    assert.throws(() => parseExpirySeedForReplay(changed, value.configuration_sha256, ready));
  }
});

function current(value = seed()) {
  return { configuration_sha256: value.configuration_sha256, prefix: value.prefix,
    user_id_sha256: value.user_id_sha256, expires_at: '2026-11-01T20:30:00Z',
    cookies: [{ ...value.cookie, value: 'N'.repeat(43), expires: Date.parse('2026-11-01T20:30:00Z') / 1000 },
      { ...value.ingress_cookie, value: 'SYNTHETIC_SUPERVISOR_N_COOKIE_0123456789' }] };
}

test('same-principal N binding replaces only O and reports hashes without cookie or prefix values', () => {
  const value = seed(), fresh = current(value), ready = Date.parse(value.ingress_replay_not_before);
  const binding = bindExpiryReplay(value, fresh, ready);
  assert.deepEqual(binding.replacement_cookie, value.ingress_cookie);
  assert.deepEqual(Object.keys(binding).sort(), ['evidence', 'replacement_cookie']);
  assert.equal(binding.evidence.supervisor_O_sha256, hash(value.ingress_cookie.value));
  assert.equal(binding.evidence.supervisor_N_sha256, hash(fresh.cookies[1].value));
  assert.equal(binding.evidence.app_N_sha256, hash(fresh.cookies[0].value));
  const output = JSON.stringify(binding.evidence);
  for (const secret of [value.prefix, value.cookie.value, value.ingress_cookie.value,
    fresh.cookies[0].value, fresh.cookies[1].value]) assert.equal(output.includes(secret), false);
  for (const damage of [
    value => { value.configuration_sha256 = 'a'.repeat(64); },
    value => { value.user_id_sha256 = 'a'.repeat(64); },
    value => { value.prefix = '/api/hassio_ingress/different/'; },
    value => { value.expires_at = '2026-11-01T12:00:00Z'; },
    value => { value.cookies[0].expires = ready / 1000; },
    value => { value.cookies[0].value = 'A'.repeat(43); },
    value => { value.cookies[1].value = seed().ingress_cookie.value; },
    value => { value.cookies.push({ ...value.cookies[1] }); },
    value => { value.cookies[0].path += '/'; },
  ]) {
    const changed = structuredClone(fresh); damage(changed);
    assert.throws(() => bindExpiryReplay(value, changed, ready));
  }
});

test('ordinary poll classification is bounded and detects bootstrap, writes and query changes', () => {
  const prefix = seed().prefix, url = endpoint => LOCAL_ORIGIN + prefix + 'api/v1/' + endpoint;
  const known = { status: 'connection_status', 'tags?offset=0&limit=100': 'tag_inventory',
    publication: 'publication_status', 'playback-status': 'playback_status',
    'music/capabilities': 'metadata_capabilities', session: 'session_bootstrap' };
  for (const [endpoint, expected] of Object.entries(known)) assert.equal(protectedPollCategory(url(endpoint), prefix), expected);
  for (const endpoint of ['session?retry=1', 'status?x=1', 'tags', 'tags?offset=0&limit=100&limit=100',
    'tags/inbox?view=unassigned', 'music/resolve', 'assignments']) {
    assert.equal(protectedPollCategory(url(endpoint), prefix), 'unexpected_app_read');
  }
  assert.equal(protectedPollCategory('https://example.invalid' + prefix + 'api/v1/status', prefix), null);
  assert.equal(protectedPollCategory(LOCAL_ORIGIN + '/api/hassio_ingress/another/api/v1/status', prefix), null);
});

test('wire evidence handles opaque equals but never retains header or cookie values', () => {
  const headers = { Cookie: 'ingress_session=SYNTHETIC_O==; jukelet_ingress_session=SYNTHETIC_N',
    'X-Synthetic-Private': 'SYNTHETIC_PRIVATE_SENTINEL' };
  assert.deepEqual(wireCookieEvidence(headers), { supervisor_cookie_sha256: hash('SYNTHETIC_O=='),
    app_cookie_sha256: hash('SYNTHETIC_N'), requestHasAuthorizationHeader: false });
  assert.equal(wireCookieEvidence({ ...headers, Authorization: 'SYNTHETIC_PRIVATE_SENTINEL' }).requestHasAuthorizationHeader, true);
  assert.equal(JSON.stringify(wireCookieEvidence(headers)).includes('SYNTHETIC'), false);
  for (const malformed of [{}, { cookie: 'ingress_session=O' }, { cookie: 'jukelet_ingress_session=N' },
    { cookie: 'ingress_session=O; ingress_session=O; jukelet_ingress_session=N' },
    { Cookie: headers.Cookie, cookie: headers.Cookie }]) assert.throws(() => wireCookieEvidence(malformed));
});

test('only actual O-bearing 401 with unchanged N app cookie satisfies the expiry response', () => {
  const value = seed(), fresh = current(value);
  const binding = bindExpiryReplay(value, fresh, Date.parse(value.ingress_replay_not_before));
  const wire = { supervisor_cookie_sha256: hash(value.ingress_cookie.value),
    app_cookie_sha256: hash(fresh.cookies[0].value), requestHasAuthorizationHeader: false };
  const accepted = assessExpiryResponse(binding, wire, 401);
  assert.equal(accepted.actual_status, 401); assert.equal(accepted.app_backend_denial_log_observed, false);
  assert.equal(accepted.denial_location_basis, 'only_supervisor_cookie_changed_and_pinned_preproxy_validation');
  for (const [changed, status] of [
    [{ ...wire, supervisor_cookie_sha256: hash(fresh.cookies[1].value) }, 401],
    [{ ...wire, app_cookie_sha256: hash(value.cookie.value) }, 401],
    [{ ...wire, requestHasAuthorizationHeader: true }, 401],
    [wire, 200], [wire, 403], [wire, 500],
  ]) assert.throws(() => assessExpiryResponse(binding, changed, status));
});
