/** Local input/protocol tests only: no HA, browser package, credentials or VM. */
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { FIXTURE, LOCAL_ORIGIN, PROXY_ORIGIN, ingressPrefix, parseCredentials,
  assetSummary, blockedEndpointEvidence, blockedRequestCategory, pageErrorSource,
  expectedTypeErrorUndefinedAddEventListener, headerPresence, matchesInvestigatedRequest, projectPageErrorFrames, projectScriptFrame,
  readBoundedFile, readOnlyRequestAllowed, sameIdentity, serviceWorkerSourceLookup, websocketAllowed } from './browser_inputs.mjs';
import { assessNetworkBoundaries, assessReadOnly, collectNativeReads, expirySeedSummary, prepareExpirySeed, queryFixture } from './browser.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const credentials = () => ({ schema_version: 1, fixture: FIXTURE, synthetic: true,
  origin: LOCAL_ORIGIN, role: 'administrator', username: 'synthetic_jukelet62_admin',
  password: 'SYNTHETIC_PRIVATE_PASSWORD_0123456789' });

test('dedicated browser credentials require exact synthetic fields and role', () => {
  const value = credentials();
  assert.deepEqual(parseCredentials(JSON.stringify(value), 'administrator'), { username: value.username, password: value.password });
  for (const [key, damage] of [['synthetic', 1], ['fixture', 'household'], ['role', 'denied'], ['origin', 'https://household.example'], ['access_token', 'SYNTHETIC_PRIVATE_SENTINEL']]) {
    assert.throws(() => parseCredentials(JSON.stringify({ ...value, [key]: damage }), 'administrator'));
  }
  assert.throws(() => parseCredentials(JSON.stringify(value), 'denied'));
  assert.throws(() => parseCredentials(JSON.stringify(value).replace('"schema_version":1', '"schema_version":1,"schema_version":1'), 'administrator'));
  assert.throws(() => parseCredentials(JSON.stringify(value).replace('"schema_version":1', '"schema_version":1,"schema_\\u0076ersion":1'), 'administrator'));
});

test('bounded private file reads reject links, wrong modes, escape and growth bounds', () => {
  const root = mkdtempSync(join(tmpdir(), 'jukelet62-private-')); chmodSync(root, 0o700);
  try {
    const file = join(root, 'private.json'); writeFileSync(file, 'SYNTHETIC_PRIVATE_SENTINEL', { mode: 0o600 });
    assert.equal(readBoundedFile(file, 64, { root }).toString(), 'SYNTHETIC_PRIVATE_SENTINEL');
    assert.throws(() => readBoundedFile(file, 4, { root }));
    const linked = join(root, 'linked.json'); symlinkSync(file, linked);
    assert.throws(() => readBoundedFile(linked, 64, { root }));
    const hard = join(root, 'hard.json'); linkSync(file, hard);
    assert.throws(() => readBoundedFile(file, 64, { root })); rmSync(hard);
    chmodSync(file, 0o644); assert.throws(() => readBoundedFile(file, 64, { root }));
    chmodSync(file, 0o600); chmodSync(root, 0o755);
    assert.throws(() => readBoundedFile(file, 64, { root }));
    assert.equal(readFileSync(file, 'utf8'), 'SYNTHETIC_PRIVATE_SENTINEL');
  } finally { rmSync(root, { recursive: true }); }
});

test('artifact bindings ignore JSON property order but reject changed or extra identity', () => {
  assert.ok(sameIdentity({ source_commit: 'a', context_sha256: 'b' }, { context_sha256: 'b', source_commit: 'a' }));
  assert.equal(sameIdentity({ source_commit: 'a' }, { source_commit: 'b' }), false);
  assert.equal(sameIdentity({ source_commit: 'a' }, { source_commit: 'a', token: 'private' }), false);
});

test('failing asset/network diagnostics preserve bounded observations without URL/private text', () => {
  assert.deepEqual(assetSummary([{ extension: 'css', status: 304 }, { extension: 'js', status: 200 },
    { extension: 'SYNTHETIC_PRIVATE_SENTINEL', status: 'SYNTHETIC_PRIVATE_SENTINEL', url: 'private' }]),
  { total: 3, css_200: 0, js_200: 1, extension_status: { css_304: 1, js_200: 1, other_invalid: 1 } });
  const category = blockedRequestCategory('https://SYNTHETIC_PRIVATE_SENTINEL.example/path?token=private',
    'SYNTHETIC_PRIVATE_SENTINEL', 'SYNTHETIC_PRIVATE_SENTINEL', 'SYNTHETIC_PRIVATE_SENTINEL');
  assert.equal(category, 'outside_origin|unknown|OTHER|other');
  assert.equal(category.includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
});

test('endpoint evidence names only upfront-whitelisted public HA origins and fixed paths', () => {
  assert.deepEqual(blockedEndpointEvidence('https://brands.home-assistant.io/brands.json?private=ignored'),
    { origin_category: 'known_public_ha', public_origin: 'https://brands.home-assistant.io', path_category: 'public_brand_index' });
  assert.equal(blockedEndpointEvidence(PROXY_ORIGIN + '/private').port_bucket, 'proxy_https_28223');
  assert.equal(blockedEndpointEvidence('https://127.0.0.1:9999/private').port_bucket, 'other_loopback_port');
  for (const url of ['https://SYNTHETIC_PRIVATE_SENTINEL.example/SYNTHETIC_PRIVATE_PATH?secret=SYNTHETIC_PRIVATE_QUERY',
    'https://unlisted.home-assistant.io/SYNTHETIC_PRIVATE_PATH?secret=SYNTHETIC_PRIVATE_QUERY']) {
    const evidence = blockedEndpointEvidence(url);
    assert.equal(evidence.origin_category, 'other_origin_sha256');
    assert.match(evidence.origin_sha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.path_sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(evidence).includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(JSON.stringify(evidence).includes(new URL(url).origin), false);
  }
});

test('error source attribution inspects frames in memory and conservatively retains Jukelet errors', () => {
  const parent = `TypeError: SYNTHETIC_PRIVATE_MESSAGE\n at load (${LOCAL_ORIGIN}/frontend_latest/chunk.js:1:20)`;
  assert.equal(pageErrorSource(parent), 'ha_parent_frontend');
  assert.equal(pageErrorSource(parent + `\n at child (${LOCAL_ORIGIN}/api/hassio_ingress/SYNTHETIC_PRIVATE_PREFIX/assets/app.js:2:4)`), 'jukelet_ingress_asset');
  assert.equal(pageErrorSource(`TypeError: ${LOCAL_ORIGIN}/frontend_latest/private.js\n at unknown (https://private.example/file.js:1:2)`), 'unknown');
  assert.equal(pageErrorSource('SYNTHETIC_PRIVATE_STACK'), 'unknown');
});

test('targeted initiator and error locations expose only public HA script paths and bounded positions', () => {
  const publicFrame = { url: LOCAL_ORIGIN + '/frontend_latest/chunk.012abc.js?SYNTHETIC_PRIVATE_QUERY',
    functionName: 'SYNTHETIC_PRIVATE_FUNCTION', lineNumber: 0, columnNumber: 245 };
  const projected = projectScriptFrame(publicFrame);
  assert.equal(projected.script_path, '/frontend_latest/chunk.012abc.js');
  assert.equal(projected.line, 1); assert.equal(projected.column, 246);
  assert.equal(JSON.stringify(projected).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(JSON.stringify(projected).includes(LOCAL_ORIGIN), false);
  const app = projectScriptFrame({ ...publicFrame, url: LOCAL_ORIGIN + '/api/hassio_ingress/SYNTHETIC_PRIVATE_PREFIX/assets/app.js' });
  assert.equal(app.source, 'jukelet_ingress_asset'); assert.equal(Object.hasOwn(app, 'script_path'), false);
  const unknown = projectScriptFrame({ ...publicFrame, url: 'https://SYNTHETIC_PRIVATE_HOST.example/SYNTHETIC_PRIVATE_PATH' });
  assert.equal(unknown.source, 'unknown'); assert.equal(JSON.stringify(unknown).includes('SYNTHETIC_PRIVATE'), false);
  const unrecognizedName = projectScriptFrame({ ...publicFrame, url: LOCAL_ORIGIN + '/frontend_latest/SYNTHETIC_PRIVATE_FILENAME.js' });
  assert.equal(Object.hasOwn(unrecognizedName, 'script_path'), false);
  assert.equal(JSON.stringify(unrecognizedName).includes('SYNTHETIC_PRIVATE'), false);
  const frames = projectPageErrorFrames(`TypeError: SYNTHETIC_PRIVATE_MESSAGE\n at send (${LOCAL_ORIGIN}/frontend_latest/chunk.012abc.js:1:246)`);
  assert.equal(frames[0].script_path, projected.script_path); assert.equal(frames[0].line, 1); assert.equal(frames[0].column, 246);
  assert.equal(frames[0].function_name, 'send');
});

test('service-worker fixture diagnosis requires exact message and HA parent source; app/mixed errors remain distinct', () => {
  const parent = `TypeError: private\n at send (${LOCAL_ORIGIN}/frontend_latest/app.d6c28fc2e48aeea4.js:1:246)`;
  const app = `TypeError: private\n at child (${LOCAL_ORIGIN}/api/hassio_ingress/PRIVATE/assets/app.js:1:20)`;
  const message = "Cannot read properties of undefined (reading 'addEventListener')";
  assert.equal(expectedTypeErrorUndefinedAddEventListener('TypeError', message, parent), true);
  assert.equal(expectedTypeErrorUndefinedAddEventListener('TypeError', 'SYNTHETIC_PRIVATE_OTHER_MESSAGE', parent), false);
  assert.equal(expectedTypeErrorUndefinedAddEventListener('ReferenceError', message, parent), false);
  assert.equal(expectedTypeErrorUndefinedAddEventListener('TypeError', message, app), false);
  assert.equal(expectedTypeErrorUndefinedAddEventListener('TypeError', message, parent + '\n' + app), false);
  assert.equal(expectedTypeErrorUndefinedAddEventListener('TypeError', message, parent + '\n at unknown (https://private.example/unknown.js:2:4)'), false);
  assert.equal(expectedTypeErrorUndefinedAddEventListener('TypeError', message, parent + '\n at unknown (blob:private)'), false);
  assert.equal(expectedTypeErrorUndefinedAddEventListener('TypeError', message,
    parent + Array(8).fill(`\n at send (${LOCAL_ORIGIN}/frontend_latest/app.d6c28fc2e48aeea4.js:1:2)`).join('') + '\n at unknown (https://private.example/unknown.js:2:4)'), false);
  assert.equal(expectedTypeErrorUndefinedAddEventListener('TypeError', message, 'unknown'), false);
});

test('header diagnostics contain presence booleans only and never supplied values', () => {
  const evidence = headerPresence({ Authorization: 'SYNTHETIC_PRIVATE_AUTH', Cookie: 'SYNTHETIC_PRIVATE_COOKIE', Other: 'secret' });
  assert.deepEqual(evidence, { headers_available: true, requestHasAuthorizationHeader: true, requestHasCookieHeader: true });
  assert.equal(JSON.stringify(evidence).includes('SYNTHETIC_PRIVATE'), false);
  assert.deepEqual(headerPresence({}), { headers_available: true, requestHasAuthorizationHeader: false, requestHasCookieHeader: false });
  assert.equal(headerPresence(null).headers_available, false);
  assert.equal(matchesInvestigatedRequest('https://private.example/unknown'), false);
});

function emptyNetworkCategories() {
  return { blocked_http: {}, blocked_websocket: {}, page_error_types: {}, page_error_sources: {},
    blocked_http_endpoints: [], blocked_http_endpoint_overflow: 0,
    page_error_frames: [], page_error_predicates: [], investigated_request_headers: [] };
}

function observedServiceWorkerWarning() {
  return {
    network: { blocked_http: 1, blocked_websocket: 0, escaped_ingress: 0, page_errors: 1 },
    categories: { ...emptyNetworkCategories(),
      blocked_http: { 'outside_origin|ha_parent|GET|xhr': 1 },
      page_error_types: { TypeError: 1 }, page_error_sources: { ha_parent_frontend: 1 },
      blocked_http_endpoints: [{ endpoint: { origin_category: 'other_origin_sha256',
        origin_sha256: '6f7d956a4d23259282d0cf5bb34a1d541547da5ed25c1e623a04024f126303ad',
        path_category: 'path_sha256', path_sha256: '6fcdeabf6fe777b39e3f499f451d20133b7fc6b80fcd015acb5c0f47a659a927' }, count: 1 }],
      page_error_frames: [[{ source: 'ha_parent_frontend', script_path: '/frontend_latest/app.d6c28fc2e48aeea4.js',
        line: 135, column: 67400, location_base: 1, function_sha256: '72dfcfb0c470ac255cde83fb8fe38de8a128188e03ea5ba5b2a93adbea1062fa' }]],
      page_error_predicates: [{ source: 'ha_parent_frontend', expectedTypeErrorUndefinedAddEventListener: true }],
      investigated_request_headers: [{ headers_available: true, requestHasAuthorizationHeader: false,
        requestHasCookieHeader: false, hasQueryString: false,
        source_lookup: { kind: 'ha_frontend_register_service_worker_original_source', frontend_version: '20260930.5',
          origin_sha256: '6f7d956a4d23259282d0cf5bb34a1d541547da5ed25c1e623a04024f126303ad',
          path_sha256: '6fcdeabf6fe777b39e3f499f451d20133b7fc6b80fcd015acb5c0f47a659a927' } }],
    },
  };
}

test('exact observed blocked service-worker fixture pair is reported separately from app errors', () => {
  const value = observedServiceWorkerWarning();
  const result = assessNetworkBoundaries(value.network, value.categories);
  assert.equal(result.result, 'PASS_WITH_EXPECTED_FIXTURE_WARNING');
  assert.equal(result.jukelet_page_errors, 0); assert.equal(result.unexpected_page_errors, 0);
  assert.equal(result.expected_fixture_warning.frontend_version, '20260930.5');
  assert.deepEqual(value.network, { blocked_http: 1, blocked_websocket: 0, escaped_ingress: 0, page_errors: 1 });
});

test('all-zero boundaries pass while every unclassified or unsafe warning variation fails', () => {
  const clear = { blocked_http: 0, blocked_websocket: 0, escaped_ingress: 0, page_errors: 0 };
  assert.deepEqual(assessNetworkBoundaries(clear, emptyNetworkCategories()), {
    result: 'PASS', jukelet_page_errors: 0, unexpected_page_errors: 0,
    unexpected_blocked_requests: 0, ingress_escapes: 0, outside_requests_permitted: 0,
    expected_fixture_warning: null,
  });
  const changes = [
    value => { value.categories.page_error_sources = { jukelet_ingress_asset: 1 }; },
    value => { value.categories.page_error_sources = { unknown: 1 }; },
    value => { value.categories.page_error_frames[0].push({ source: 'jukelet_ingress_asset' }); },
    value => { value.categories.page_error_frames[0].push({ source: 'unknown' }); },
    value => { value.categories.page_error_frames = [[]]; },
    value => { value.categories.page_error_predicates[0].expectedTypeErrorUndefinedAddEventListener = false; },
    value => { value.network.page_errors = 2; value.categories.page_error_types.TypeError = 2; },
    value => { value.categories.investigated_request_headers[0].source_lookup.path_sha256 = 'a'.repeat(64); },
    value => { value.categories.investigated_request_headers[0].source_lookup = null; },
    value => { value.categories.investigated_request_headers[0].hasQueryString = true; },
    value => { value.categories.investigated_request_headers[0].requestHasAuthorizationHeader = true; },
    value => { value.categories.investigated_request_headers[0].requestHasCookieHeader = true; },
    value => { value.categories.investigated_request_headers[0].headers_available = false; },
    value => { value.categories.investigated_request_headers = []; },
    value => { value.network.blocked_http = 2; value.categories.blocked_http['outside_origin|ha_parent|GET|xhr'] = 2; },
    value => { value.categories.blocked_http = { 'outside_origin|ingress_frame|GET|xhr': 1 }; },
    value => { value.categories.blocked_http_endpoint_overflow = 1; },
    value => { value.network.blocked_websocket = 1; },
    value => { value.network.escaped_ingress = 1; },
  ];
  for (const change of changes) {
    const value = observedServiceWorkerWarning(); change(value);
    assert.throws(() => assessNetworkBoundaries(value.network, value.categories));
  }
});

test('known source lookup classification requires the exact canonical original-source path without query', () => {
  const source = 'https://raw.githubusercontent.com/home-assistant/frontend/20260930.5/src/util/register-service-worker.ts';
  assert.deepEqual(serviceWorkerSourceLookup(source), observedServiceWorkerWarning().categories.investigated_request_headers[0].source_lookup);
  for (const url of [source + '?secret=private', source + '#private', source + '/extra',
    source.replace('20260930.5', 'main'), source.replace('20260930.5', '20260930.05'),
    source.replace('20260930.5', '00000000.5'), source.replace('/src/util/', '/src/other/'),
    source.replace('https://', 'http://'), source.replace('/src/util/', '/src/./util/'),
    source.replace('raw.githubusercontent.com', 'private.example'), source.replace('https://', 'https://user@')]) {
    assert.equal(serviceWorkerSourceLookup(url), null);
  }
});

test('native snapshot awaits supported inbox refresh before reading the inventory cache', async t => {
  let count = 0; const order = [];
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.pathname.endsWith('/tags/inbox')) {
      await Promise.resolve(); count = 2; order.push('inbox_refresh_complete');
      return new Response(JSON.stringify({ total: count }));
    }
    if (url.pathname.endsWith('/tags')) { order.push('tags_read'); return new Response(JSON.stringify({ total: count })); }
    return new Response('{}');
  });
  const result = await collectNativeReads('https://synthetic.invalid/api/hassio_ingress/synthetic/');
  assert.equal(result.inventory.body.total, 2);
  assert.ok(order.indexOf('inbox_refresh_complete') < order.indexOf('tags_read'));
});

test('read-only phase permits normal HA auth and metadata preview, denies writes and external targets', () => {
  const ingress = LOCAL_ORIGIN + '/api/hassio_ingress/synthetic_A-123/';
  assert.ok(readOnlyRequestAllowed(LOCAL_ORIGIN + '/', 'GET'));
  assert.ok(readOnlyRequestAllowed(LOCAL_ORIGIN + '/auth/login_flow', 'POST'));
  assert.ok(readOnlyRequestAllowed(LOCAL_ORIGIN + '/auth/login_flow/synthetic-id', 'POST'));
  assert.ok(readOnlyRequestAllowed(LOCAL_ORIGIN + '/auth/token', 'POST'));
  assert.ok(readOnlyRequestAllowed(ingress + 'api/v1/music/resolve', 'POST'));
  for (const [url, method] of [[ingress + 'api/v1/session', 'POST'], [ingress + 'api/v1/publication/confirm', 'POST'], [ingress + 'api/v1/tags/key/name', 'PATCH'], [ingress + 'api/v1/tags/key/assignment', 'PUT'], [LOCAL_ORIGIN + '/api/services/script/turn_on', 'POST'], [PROXY_ORIGIN + '/', 'GET'], ['https://household.example/', 'GET'], [ingress + 'api/v1/music/resolve?redirect=outside', 'POST']]) {
    assert.equal(readOnlyRequestAllowed(url, method), false);
  }
  assert.ok(websocketAllowed(LOCAL_ORIGIN.replace('https:', 'wss:') + '/api/websocket'));
  assert.equal(websocketAllowed('wss://household.example/api/websocket'), false);
  assert.equal(websocketAllowed(LOCAL_ORIGIN.replace('https:', 'wss:') + '/api/websocket?token=unsafe'), false);
});

test('native frame URL must be the actual canonical same-origin Ingress path', () => {
  assert.equal(ingressPrefix(LOCAL_ORIGIN + '/api/hassio_ingress/synthetic_A-123/'), '/api/hassio_ingress/synthetic_A-123/');
  for (const url of [LOCAL_ORIGIN + '/api/hassio_ingress/synthetic', 'https://household.example/api/hassio_ingress/synthetic/', 'https://user@127.0.0.1:18223/api/hassio_ingress/synthetic/']) assert.throws(() => ingressPrefix(url));
});

function observations() {
  return {
    session: { status: 200, body: { runtime: 'ingress', mode: 'manage', user_id: 'a'.repeat(32), expires_at: '2026-11-02T00:00:00Z' } },
    status: { status: 200, body: { connection: 'connected', subscribed: true, version: '2026.10.3' } },
    inventory: { status: 200, body: { registry_available: true, stale: false, total: 1, tags: [{ ha_tag_id: '  Synthetic é / 🦊  ' }] } },
    inbox: { status: 200, body: { registry_available: true, assignments_available: true } },
    capabilities: { status: 200, body: Object.fromEntries(['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search'].map(name => [name, 'supported'])) },
  };
}

function seedInputs() {
  const prefix = '/api/hassio_ingress/synthetic_A-123/';
  return {
    cookies: [
      { name: 'jukelet_ingress_session', value: 'A'.repeat(43), domain: '127.0.0.1',
        path: prefix.slice(0, -1), expires: Date.parse('2026-11-01T20:00:00Z') / 1000,
        httpOnly: true, secure: true, sameSite: 'Strict' },
      { name: 'ingress_session', value: 'SYNTHETIC_SUPERVISOR_O_COOKIE_0123456789', domain: '127.0.0.1',
        path: '/api/hassio_ingress/', expires: -1, httpOnly: false, secure: true, sameSite: 'Strict' },
      { name: 'unrelated_cookie', value: 'SYNTHETIC_PRIVATE_IGNORED', domain: '127.0.0.1',
        path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Strict' },
    ],
    observation: { prefix, user_id_sha256: 'b'.repeat(64), expires_at: '2026-11-01T20:00:00Z', configuration_sha256: 'c'.repeat(64) },
    timing: { captured_at: '2026-11-01T12:00:00.000Z', closed_at: '2026-11-01T12:00:01.000Z' },
  };
}

test('expiry seed captures exact Supervisor O and app cookie only after a conservative close bound', () => {
  const value = seedInputs();
  const seed = prepareExpirySeed(value.cookies, value.observation, value.timing);
  assert.equal(seed.schema_version, 2);
  assert.deepEqual(seed.ingress_cookie, value.cookies[1]);
  assert.deepEqual(seed.cookie, value.cookies[0]);
  assert.equal(seed.ingress_last_touch_upper_bound, value.timing.closed_at);
  assert.equal(seed.ingress_replay_not_before, '2026-11-01T12:16:01.000Z');
  assert.equal(JSON.stringify(seed).includes('SYNTHETIC_PRIVATE_IGNORED'), false);
  const summary = expirySeedSummary(seed);
  assert.equal(summary.kind, 'natural_supervisor_idle_expiry_replay');
  assert.equal(summary.natural_supervisor_expiry, 'PENDING');
  assert.equal(summary.natural_app_8h_expiry, 'NOT_RUN');
  assert.equal(JSON.stringify(summary).includes(value.cookies[0].value), false);
  assert.equal(JSON.stringify(summary).includes(value.cookies[1].value), false);
  assert.equal(JSON.stringify(summary).includes(value.observation.prefix), false);
  value.cookies[1].value = 'changed after capture';
  assert.equal(seed.ingress_cookie.value, 'SYNTHETIC_SUPERVISOR_O_COOKIE_0123456789');
});

test('expiry seed rejects missing, ambiguous or wrongly scoped ingress cookies and timing', () => {
  for (const damage of [
    value => { value.cookies.splice(1, 1); },
    value => { value.cookies.push({ ...value.cookies[1] }); },
    value => { value.cookies[1].domain = 'household.example'; },
    value => { value.cookies[1].path = '/'; },
    value => { value.cookies[1].secure = false; },
    value => { value.cookies[1].sameSite = 'None'; },
    value => { value.cookies[1].expires = Date.parse('2026-11-02T00:00:00Z') / 1000; },
    value => { value.cookies[0].path = '/'; },
    value => { value.timing.closed_at = '2026-11-01T11:59:00Z'; },
    value => { value.observation.expires_at = '2026-11-01T11:59:00Z'; },
  ]) {
    const value = seedInputs(); damage(value);
    assert.throws(() => prepareExpirySeed(value.cookies, value.observation, value.timing));
  }
});

test('native read assessment requires real authority, fresh registry and provider capabilities', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const report = assessReadOnly(observations(), now);
  assert.equal(report.core_version, '2026.10.3'); assert.equal(report.mode, 'manage');
  assert.match(report.user_id_sha256, /^[a-f0-9]{64}$/); assert.equal(report.tag_count, 1);
  assert.equal(JSON.stringify(report).includes('a'.repeat(32)), false);
  for (const change of [value => { value.session.status = 403; }, value => { value.session.body.mode = 'read_only'; }, value => { value.session.body.expires_at = '2026-11-01T00:00:00Z'; }, value => { value.inventory.body.stale = true; }, value => { value.status.body.subscribed = false; }, value => { value.capabilities.body.album_detail = 'unsupported'; }]) {
    const value = observations(); change(value); assert.throws(() => assessReadOnly(value, now));
  }
});

test('QMP proof uses only capability negotiation and read-only name/status, rejects another VM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jukelet62-qmp-')); const path = join(root, 'qmp.sock');
  let name = FIXTURE; const commands = [];
  const server = net.createServer(socket => {
    socket.write(JSON.stringify({ QMP: { version: {} } }) + '\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const line = buffer.slice(0, buffer.indexOf('\n')); buffer = buffer.slice(buffer.indexOf('\n') + 1);
        const request = JSON.parse(line); commands.push(request.execute);
        const result = request.execute === 'query-name' ? { name } : request.execute === 'query-status' ? { status: 'running', running: true } : {};
        socket.write(JSON.stringify({ return: result, id: request.id }) + '\n');
      }
    });
  });
  await new Promise(done => server.listen(path, done));
  try {
    assert.deepEqual(await queryFixture(path), { name_verified: true, running: true });
    name = 'another-vm'; await assert.rejects(queryFixture(path));
    assert.deepEqual(commands, ['qmp_capabilities', 'query-name', 'query-status', 'qmp_capabilities', 'query-name', 'query-status']);
  } finally { await new Promise(done => server.close(done)); rmSync(root, { recursive: true }); }
});

test('clean import and help need neither frontend nor Playwright; failure output omits private values', () => {
  const root = mkdtempSync(join(tmpdir(), 'jukelet62-import-'));
  try {
    for (const name of ['browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs']) copyFileSync(join(directory, name), join(root, name));
    mkdirSync(join(root, 'empty'));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(root, 'browser.mjs')).href)});`], { encoding: 'utf8', cwd: join(root, 'empty') });
    assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
    const help = spawnSync(process.execPath, [join(root, 'browser.mjs'), '--help'], { encoding: 'utf8' }); assert.equal(help.status, 0);
    const failed = spawnSync(process.execPath, [join(root, 'browser.mjs'), 'read-only', '/tmp/SYNTHETIC_PRIVATE_SENTINEL.json'], { encoding: 'utf8' });
    assert.equal(failed.status, 1); assert.equal(failed.stderr, '');
    assert.equal(failed.stdout.includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
    assert.equal(JSON.parse(failed.stdout).stage, 'local_inputs');
    const expiry = spawnSync(process.execPath, [join(root, 'browser.mjs'), 'expiry-replay', '/tmp/SYNTHETIC_PRIVATE_SENTINEL.json'], { encoding: 'utf8' });
    assert.equal(expiry.status, 1); assert.equal(expiry.stderr, '');
    assert.equal(expiry.stdout.includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
    assert.equal(JSON.parse(expiry.stdout).stage, 'local_inputs');
    assert.equal(JSON.parse(expiry.stdout).checks.expiry_preflight, undefined);
  } finally { rmSync(root, { recursive: true }); }
});
