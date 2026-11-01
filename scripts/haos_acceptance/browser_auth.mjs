/** Explicit native authentication negatives; imports perform no I/O. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, hash, ingressPrefix, readBoundedFile } from './browser_inputs.mjs';

function exactKeys(value, keys) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function cookie(value, name, path) {
  exactKeys(value, ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']);
  assert.equal(value.name, name); assert.equal(value.domain, '127.0.0.1'); assert.equal(value.path, path);
  assert.equal(value.secure, true); assert.equal(value.sameSite, 'Strict');
  assert.equal(typeof value.httpOnly, 'boolean'); assert.equal(typeof value.value, 'string');
  assert.ok(value.value.length > 0 && value.value.length <= 4096 && !/[\s;,\u0000-\u001f\u007f]/.test(value.value));
  assert.ok(typeof value.expires === 'number' && Number.isFinite(value.expires));
  if (name === 'ingress_session') assert.equal(value.expires, -1);
  else { assert.equal(value.httpOnly, true); assert.match(value.value, /^[A-Za-z0-9_-]{43}$/); }
  return { ...value };
}

export function validateExpirySeedForReplay(seed, configurationSha256, now = Date.now()) {
  exactKeys(seed, ['schema_version', 'fixture', 'origin', 'prefix', 'cookie', 'ingress_cookie',
    'user_id_sha256', 'expires_at', 'cookie_captured_at', 'browser_closed_at',
    'ingress_last_touch_upper_bound', 'ingress_replay_not_before', 'seeded_at', 'configuration_sha256']);
  assert.equal(seed.schema_version, 2); assert.equal(seed.fixture, FIXTURE); assert.equal(seed.origin, LOCAL_ORIGIN);
  assert.equal(ingressPrefix(LOCAL_ORIGIN + seed.prefix), seed.prefix);
  assert.match(seed.user_id_sha256, /^[a-f0-9]{64}$/); assert.match(seed.configuration_sha256, /^[a-f0-9]{64}$/);
  assert.equal(seed.configuration_sha256, configurationSha256);
  cookie(seed.cookie, 'jukelet_ingress_session', seed.prefix.slice(0, -1));
  cookie(seed.ingress_cookie, 'ingress_session', '/api/hassio_ingress/');
  const captured = Date.parse(seed.cookie_captured_at), closed = Date.parse(seed.browser_closed_at);
  assert.ok(Number.isFinite(captured) && Number.isFinite(closed) && closed >= captured);
  assert.equal(seed.ingress_last_touch_upper_bound, seed.browser_closed_at); assert.equal(seed.seeded_at, seed.browser_closed_at);
  assert.equal(seed.ingress_replay_not_before, new Date(closed + 16 * 60 * 1000).toISOString());
  assert.ok(Date.parse(seed.expires_at) > closed && seed.cookie.expires * 1000 > closed);
  assert.ok(Number.isFinite(now));
  if (now < Date.parse(seed.ingress_replay_not_before)) throw new Error('expiry_replay_too_early');
  return seed;
}

export function parseExpirySeedForReplay(raw, configurationSha256, now = Date.now()) {
  const seed = JSON.parse(raw);
  // The exclusive writer emits exactly this canonical representation. Reject
  // duplicate properties, altered serialization and unrecognized secret fields.
  assert.equal(raw, JSON.stringify(seed) + '\n');
  return validateExpirySeedForReplay(seed, configurationSha256, now);
}

export function readExpirySeedForReplay(configurationSha256, now = Date.now()) {
  const raw = readBoundedFile(join(CONTROL_ROOT, 'expiry-seed.json'), 16384).toString('utf8');
  return { seed: parseExpirySeedForReplay(raw, configurationSha256, now), file_sha256: hash(raw) };
}

function selectedCookies(cookies, prefix) {
  const pick = (name, path) => {
    const matches = cookies.filter(value => value.name === name); assert.equal(matches.length, 1);
    return cookie(Object.fromEntries(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']
      .map(key => [key, matches[0][key]])), name, path);
  };
  return { app: pick('jukelet_ingress_session', prefix.slice(0, -1)), ingress: pick('ingress_session', '/api/hassio_ingress/') };
}

export function bindExpiryReplay(seed, current, now = Date.now()) {
  validateExpirySeedForReplay(seed, current.configuration_sha256, now);
  assert.equal(current.prefix, seed.prefix); assert.equal(current.user_id_sha256, seed.user_id_sha256);
  assert.ok(Date.parse(current.expires_at) > now);
  const selected = selectedCookies(current.cookies, current.prefix);
  assert.ok(selected.app.expires * 1000 > now);
  assert.notEqual(selected.ingress.value, seed.ingress_cookie.value);
  assert.notEqual(selected.app.value, seed.cookie.value);
  return { replacement_cookie: { ...seed.ingress_cookie },
    evidence: { same_user: true, same_prefix: true, same_configuration: true,
      user_id_sha256: current.user_id_sha256, prefix_sha256: hash(current.prefix),
      supervisor_O_sha256: hash(seed.ingress_cookie.value), supervisor_N_sha256: hash(selected.ingress.value),
      app_N_sha256: hash(selected.app.value), replay_not_before: seed.ingress_replay_not_before } };
}

export function protectedPollCategory(url, prefix) {
  const target = new URL(url);
  if (target.origin !== LOCAL_ORIGIN || !target.pathname.startsWith(prefix + 'api/v1/')) return null;
  const endpoint = target.pathname.slice((prefix + 'api/v1/').length);
  const names = { status: 'connection_status', tags: 'tag_inventory', publication: 'publication_status',
    'playback-status': 'playback_status', 'music/capabilities': 'metadata_capabilities', session: 'session_bootstrap' };
  if (!Object.hasOwn(names, endpoint)) return 'unexpected_app_read';
  if (endpoint !== 'tags' && target.search) return 'unexpected_app_read';
  if (endpoint === 'tags' && target.search !== '?offset=0&limit=100') return 'unexpected_app_read';
  return names[endpoint];
}

export function wireCookieEvidence(headers) {
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'cookie');
  assert.equal(values.length, 1); assert.equal(typeof values[0][1], 'string');
  const pairs = values[0][1].split(';').map(value => value.trim());
  const pick = name => {
    const found = pairs.filter(value => value.slice(0, value.indexOf('=')) === name); assert.equal(found.length, 1);
    return hash(found[0].slice(found[0].indexOf('=') + 1));
  };
  return { supervisor_cookie_sha256: pick('ingress_session'), app_cookie_sha256: pick('jukelet_ingress_session'),
    requestHasAuthorizationHeader: Object.keys(headers).some(key => key.toLowerCase() === 'authorization') };
}

export function assessExpiryResponse(binding, wire, status) {
  assert.equal(wire.supervisor_cookie_sha256, binding.evidence.supervisor_O_sha256);
  assert.equal(wire.app_cookie_sha256, binding.evidence.app_N_sha256);
  assert.equal(wire.requestHasAuthorizationHeader, false); assert.equal(status, 401);
  return { actual_status: 401, wire_supervisor_O: true, app_N_unchanged: true,
    denial_location_basis: 'only_supervisor_cookie_changed_and_pinned_preproxy_validation',
    app_backend_denial_log_observed: false };
}

export async function replayExpiredIngressCookie({ browser, context, page, frame, prefix, seed, observation, expect, evidence }) {
  evidence.stage = 'same_principal_N_binding';
  const binding = bindExpiryReplay(seed, { ...observation, prefix, cookies: await context.cookies(LOCAL_ORIGIN + prefix) });
  Object.assign(evidence, { kind: 'natural_supervisor_idle_expiry_replay', binding: binding.evidence,
    ordinary_requests: 0, precommit_N_responses: 0, session_bootstrap_attempts: 0,
    natural_app_8h_expiry: 'NOT_RUN', events: [] });
  let injectionStarted = false, committed = false, finished = false, failure = null, ordinal = 0;
  const records = new Map(), pending = new Set();
  let resolveDenial, rejectDenial;
  const denial = new Promise((done, reject) => { resolveDenial = done; rejectDenial = reject; });
  // A request can fail while addCookies is still resolving. Handle rejection
  // immediately without converting the subsequently awaited failure to success.
  denial.catch(() => {});
  const fail = code => { failure ??= code; evidence.failure_code = failure; rejectDenial(new Error(code)); };
  const event = (kind, extra = {}) => {
    if (evidence.events.length >= 32) { fail('expiry_event_overflow'); return; }
    evidence.events.push({ order: ++ordinal, kind, ...extra });
  };
  const track = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); };
  const onRequest = request => {
    if (!injectionStarted || finished) return;
    try { if (request.frame() !== frame) return; } catch { return; }
    let category;
    try { category = protectedPollCategory(request.url(), prefix); } catch { fail('invalid_poll_url'); return; }
    if (!category) return;
    if (category === 'session_bootstrap') { evidence.session_bootstrap_attempts += 1; fail('session_bootstrap_after_replay'); return; }
    if (category === 'unexpected_app_read' || request.method() !== 'GET') { fail('unexpected_request_after_replay'); return; }
    if (records.size >= 32) { fail('expiry_request_overflow'); return; }
    const wire = (async () => {
      let timer;
      try {
        const headers = await Promise.race([request.allHeaders(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('poll_cookie_headers_unavailable')), 1000);
        })]);
        return wireCookieEvidence(headers);
      } finally { clearTimeout(timer); }
    })();
    const record = { category, committed_when_started: committed, order: ++ordinal, wire };
    record.wire.catch(() => { if (!finished) fail('poll_cookie_headers_unavailable'); });
    records.set(request, record); evidence.ordinary_requests += 1;
  };
  const onResponse = response => {
    const record = records.get(response.request()); if (!record || finished) return;
    const task = (async () => {
      let wire;
      try { wire = await record.wire; } catch { return; }
      if (finished) return;
      if (wire.supervisor_cookie_sha256 === binding.evidence.supervisor_N_sha256 && !record.committed_when_started) {
        evidence.precommit_N_responses += 1; return;
      }
      if (wire.supervisor_cookie_sha256 !== binding.evidence.supervisor_O_sha256) { fail('supervisor_cookie_replaced_or_renewed'); return; }
      try {
        const verdict = assessExpiryResponse(binding, wire, response.status());
        if (!evidence.first_O_response) {
          const type = (response.headers()['content-type'] ?? '').split(';')[0];
          evidence.first_O_response = { request_order: record.order, endpoint_category: record.category,
            request_started_after_injection_began: true, cookie_commit_completed_when_request_started: record.committed_when_started,
            ...verdict, media_type: ['application/json', 'text/plain', 'text/html'].includes(type) ? type : 'other' };
          event('ordinary_O_poll_401', { endpoint_category: record.category }); resolveDenial();
        }
      } catch { fail('unexpected_O_poll_response'); }
    })();
    track(task);
  };
  page.on('request', onRequest); page.on('response', onResponse);
  const timer = setTimeout(() => fail('ordinary_O_poll_denial_not_observed'), 15000);
  try {
    event('N_bootstrap_and_binding_verified'); injectionStarted = true;
    evidence.stage = 'only_supervisor_O_injection';
    event('only_supervisor_O_injection_started');
    await context.addCookies([binding.replacement_cookie]); committed = true;
    const after = selectedCookies(await context.cookies(LOCAL_ORIGIN + prefix), prefix);
    assert.equal(hash(after.ingress.value), binding.evidence.supervisor_O_sha256);
    assert.equal(hash(after.app.value), binding.evidence.app_N_sha256);
    evidence.only_supervisor_cookie_replaced = true; event('only_supervisor_O_injection_completed');
    evidence.stage = 'ordinary_O_poll_denial';
    await denial;
    clearTimeout(timer);
    evidence.stage = 'DOM_authority_fence';
    await expect(frame.getByRole('heading', { name: 'Your tag and music manager', exact: true })).toHaveCount(0, { timeout: 5000 });
    await expect(frame.getByRole('region', { name: 'Session access', exact: true })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Check access again', exact: true })).toBeVisible();
    await expect(frame.getByLabel('App secret', { exact: true })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
    await expect(frame.getByRole('navigation', { name: 'Manager sections', exact: true })).toHaveCount(0);
    for (const name of ['Home Assistant status', 'Tag inventory', 'Music preview', 'Saved local drafts',
      'Publication status', 'Tag playback readiness', 'Export and recovery']) {
      await expect(frame.getByRole('region', { name, exact: true })).toHaveCount(0);
    }
    assert.equal(ingressPrefix(frame.url()), prefix);
    const finalCookies = await context.cookies(LOCAL_ORIGIN + prefix);
    const finalApp = finalCookies.find(value => value.name === 'jukelet_ingress_session');
    const finalIngress = finalCookies.find(value => value.name === 'ingress_session');
    assert.equal(hash(finalApp?.value ?? ''), binding.evidence.app_N_sha256);
    assert.ok(!finalIngress || hash(finalIngress.value) === binding.evidence.supervisor_O_sha256);
    evidence.supervisor_cookie_after_denial = finalIngress ? 'retained_O' : 'absent';
    evidence.dom_private_authority_fenced = true; evidence.standalone_form_absent = true;
    event('DOM_fence_observed_no_access_retry');
    evidence.stage = 'close_negative_case';
    await browser.close(); await Promise.allSettled([...pending]);
    if (failure) throw new Error(failure);
    evidence.result = 'PASS'; evidence.stage = 'complete'; event('negative_case_closed');
  } finally {
    finished = true; clearTimeout(timer); page.off('request', onRequest); page.off('response', onResponse);
    await browser.close().catch(() => {});
  }
}
