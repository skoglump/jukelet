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
import { assessNetworkBoundaries, assessReadOnly, collectNativeReads, createManagerBrowserSession, createNativeRequestGuard, enterNativeSidebar, verifyExternalLoginReady, expirySeedSummary, prepareExpirySeed, queryFixture } from './browser.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const credentials = () => ({ schema_version: 1, fixture: FIXTURE, synthetic: true,
  origin: LOCAL_ORIGIN, role: 'administrator', username: 'synthetic_jukelet62_admin',
  password: 'SYNTHETIC_PRIVATE_PASSWORD_0123456789' });

test('default manager session retains headless launch, isolated blocked-worker context and memoized public cleanup', async () => {
  const calls = [], context = {}, report = { checks: {} };
  const browser = { newContext: async options => { calls.push(['context', options]); return context; }, close: async () => calls.push(['close']) };
  const chromium = { launch: async options => { calls.push(['launch', options]); return browser; },
    connectOverCDP: async () => assert.fail('default path must not attach externally') };
  const opened = await createManagerBrowserSession(chromium, {}, { spki: 'SYNTHETIC' }, report);
  assert.equal(opened.browser, browser); assert.equal(opened.context, context);
  assert.deepEqual(calls, [['launch', { headless: true, timeout: 20000, args: ['--ignore-certificate-errors-spki-list=SYNTHETIC'] }],
    ['context', { viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }]]);
  const first = opened.cleanup(), second = opened.cleanup(); assert.equal(first, second);
  assert.deepEqual(await first, { cleanup_confirmed: true, reason: 'public_close_resolved' }); assert.equal(calls.at(-1)[0], 'close');
  for (const invalid of [{ browser }, 'external', 1]) await assert.rejects(createManagerBrowserSession(chromium, {}, {}, report, { externalBrowser: invalid }));
});

test('default context-creation failure still closes the launched browser once', async () => {
  let closes = 0; const report = { checks: {} };
  const browser = { newContext: async () => { throw new Error('synthetic_context_failure'); }, close: async () => { closes += 1; } };
  await assert.rejects(createManagerBrowserSession({ launch: async () => browser }, {}, { spki: 'SYNTHETIC' }, report));
  assert.equal(closes, 1); assert.equal(report.checks.cleanup.cleanup_confirmed, true);
});

if (process.env.JUKELET_EXTERNAL_BROWSER_TESTS === '1') {
  test('installed Chromium default managed session still opens an isolated blank page and closes normally', async () => {
    const { chromium } = await import('../../frontend/node_modules/@playwright/test/index.mjs');
    const report = { checks: {} }, tls = { spki: Buffer.alloc(32).toString('base64') };
    const session = await createManagerBrowserSession(chromium, {}, tls, report); let http = 0, websocket = 0;
    try {
      assert.equal(session.context.pages().length, 0); assert.deepEqual(await session.context.cookies(), []);
      await session.context.route('**/*', route => { http += 1; return route.abort(); });
      await session.context.routeWebSocket('**', socket => { websocket += 1; return socket.close(); });
      const page = await session.context.newPage(); assert.equal(page.url(), 'about:blank');
      assert.equal(await page.evaluate(() => document.title), '');
    } finally { assert.equal((await session.cleanup()).cleanup_confirmed, true); }
    assert.equal(http, 0); assert.equal(websocket, 0); assert.equal(session.browser.isConnected(), false);
  });
}

test('installed route guard refuses and counts a startup child root API escape before late frame discovery', async () => {
  const parent = { parentFrame: () => null }, child = { parentFrame: () => parent };
  let escapes = 0, blocked = 0; const actions = [];
  const guard = createNativeRequestGuard({ requestAllowed: request => readOnlyRequestAllowed(request.url(), request.method()),
    onEscape: () => { escapes += 1; }, onBlocked: async () => { blocked += 1; } });
  guard.bindParent(parent); guard.armIngress();
  await guard.handle({ request: () => ({ frame: () => child, url: () => LOCAL_ORIGIN + '/api/v1/session',
    method: () => 'GET', resourceType: () => 'fetch', isNavigationRequest: () => false }),
  abort: async () => actions.push('abort'), continue: async () => actions.push('continue') });
  assert.deepEqual(actions, ['abort']); assert.equal(escapes, 1); assert.equal(blocked, 1);
});

function syntheticRoute(frame, url, { method = 'GET', navigation = false, resource = 'fetch' } = {}) {
  const actions = [], request = { frame: () => { if (frame === null) throw new Error('unattributed'); return frame; },
    url: () => url, method: () => method, isNavigationRequest: () => navigation, resourceType: () => resource };
  return { request: () => request, actions, abort: async () => actions.push('abort'), continue: async () => actions.push('continue') };
}

function syntheticGuard({ permissive = false } = {}) {
  const parent = { parentFrame: () => null }, child = { parentFrame: () => parent };
  const evidence = { escaped: 0, blocked: [], scopes: [] };
  const guard = createNativeRequestGuard({ requestAllowed: (request, scope) => {
    evidence.scopes.push(scope); return permissive || readOnlyRequestAllowed(request.url(), request.method());
  }, onEscape: () => { evidence.escaped += 1; }, onBlocked: async (_, context) => evidence.blocked.push(context) });
  guard.bindParent(parent);
  return { guard, parent, child, evidence };
}

test('installed route guard binds the selected canonical child before startup assets and API requests', async () => {
  const { guard, parent, child, evidence } = syntheticGuard(), prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
  for (const [url, method] of [[LOCAL_ORIGIN + '/', 'GET'], [LOCAL_ORIGIN + '/auth/login_flow', 'POST'], [LOCAL_ORIGIN + '/auth/token', 'POST']]) {
    const route = syntheticRoute(parent, url, { method }); await guard.handle(route); assert.deepEqual(route.actions, ['continue']);
  }
  guard.armIngress();
  const document = syntheticRoute(child, LOCAL_ORIGIN + prefix, { navigation: true, resource: 'document' });
  await guard.handle(document); assert.deepEqual(document.actions, ['continue']);
  for (const endpoint of ['assets/app.js', 'assets/app.css', 'api/v1/session']) {
    const route = syntheticRoute(child, LOCAL_ORIGIN + prefix + endpoint); await guard.handle(route);
    assert.deepEqual(route.actions, ['continue']);
    assert.deepEqual(evidence.scopes.at(-1), { fromFrame: true, prefix });
  }
  guard.observeIngress(child, LOCAL_ORIGIN + prefix);
  assert.throws(() => guard.observeIngress({ parentFrame: () => parent }, LOCAL_ORIGIN + prefix));
  assert.throws(() => guard.observeIngress(child, LOCAL_ORIGIN + '/api/hassio_ingress/OTHER/'));
  assert.throws(() => guard.armIngress());
  assert.equal(evidence.escaped, 0); assert.deepEqual(evidence.blocked, []);
});

test('installed route guard rejects every unexpected child or unattributed startup request before policy', async () => {
  const prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
  for (const scenario of ['unarmed', 'root_api', 'asset_first', 'outside', 'unknown', 'other_top_level', 'not_navigation']) {
    const { guard, child, evidence } = syntheticGuard({ permissive: true });
    if (scenario !== 'unarmed') guard.armIngress();
    const source = scenario === 'unknown' ? null : scenario === 'other_top_level' ? { parentFrame: () => null } : child;
    const url = scenario === 'root_api' ? LOCAL_ORIGIN + '/api/v1/session'
      : scenario === 'asset_first' ? LOCAL_ORIGIN + prefix + 'assets/app.js'
        : scenario === 'outside' ? 'https://example.invalid' + prefix : LOCAL_ORIGIN + prefix;
    const route = syntheticRoute(source, url, { navigation: scenario !== 'not_navigation', resource: 'document' });
    await guard.handle(route); assert.deepEqual(route.actions, ['abort'], scenario);
    assert.equal(evidence.escaped, 1, scenario); assert.equal(evidence.scopes.length, 0, scenario);
  }
});

test('installed route guard refuses root/prefix/origin/nested-frame escapes after early binding, while parent reads remain normal', async () => {
  for (const scenario of ['root_api', 'other_prefix', 'outside', 'other_child', 'nested_child']) {
    const { guard, parent, child, evidence } = syntheticGuard({ permissive: true });
    const prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/'; guard.armIngress();
    await guard.handle(syntheticRoute(child, LOCAL_ORIGIN + prefix, { navigation: true, resource: 'document' }));
    const source = scenario === 'other_child' ? { parentFrame: () => parent } : scenario === 'nested_child' ? { parentFrame: () => child } : child;
    const url = scenario === 'root_api' ? LOCAL_ORIGIN + '/api/v1/session'
      : scenario === 'other_prefix' ? LOCAL_ORIGIN + '/api/hassio_ingress/OTHER/api/v1/session'
        : scenario === 'outside' ? 'https://example.invalid/api/v1/session' : LOCAL_ORIGIN + prefix + 'api/v1/session';
    const route = syntheticRoute(source, url); await guard.handle(route);
    assert.deepEqual(route.actions, ['abort'], scenario); assert.equal(evidence.escaped, 1, scenario);
  }
  const { guard, parent, evidence } = syntheticGuard();
  const parentExternal = syntheticRoute(parent, 'https://raw.githubusercontent.com/not-contacted');
  await guard.handle(parentExternal); assert.deepEqual(parentExternal.actions, ['abort']);
  assert.equal(evidence.escaped, 0); assert.deepEqual(evidence.blocked, ['ha_parent']);
});

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
    for (const name of ['browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs', 'browser_progress.mjs']) copyFileSync(join(directory, name), join(root, name));
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

test('external sidebar arms the public shell then awaits worker proof after click within its original budget', async t => {
  const calls = [], sidebar = { click: async () => calls.push('click') };
  let time = 100;
  t.mock.method(performance, 'now', () => time);
  const expect = actual => { assert.equal(actual, sidebar); return { toBeVisible: async options => {
    assert.deepEqual(options, { timeout: 30000 }); calls.push('visible'); time += 29000;
  } }; };
  const session = { beforeIngress: async remaining => { assert.equal(remaining, 1000); calls.push('shell-ready'); },
    afterIngress: async remaining => { assert.equal(remaining, 1000); calls.push('worker-ready'); }, fence: () => calls.push('fence') };
  await enterNativeSidebar(sidebar, expect, { armIngress: () => calls.push('arm') }, session, true);
  assert.deepEqual(calls, ['visible', 'shell-ready', 'arm', 'click', 'worker-ready']);
});

test('managed sidebar keeps its original visibility timeout and never calls the external hook', async () => {
  const calls = [], sidebar = { click: async () => calls.push('click') };
  const expect = () => ({ toBeVisible: async options => { assert.deepEqual(options, { timeout: 30000 }); calls.push('visible'); } });
  const session = { beforeIngress: () => assert.fail('managed path must not invoke external worker startup') };
  await enterNativeSidebar(sidebar, expect, { armIngress: () => calls.push('arm') }, session, false);
  assert.deepEqual(calls, ['visible', 'arm', 'click']);
});

test('an asynchronous request barrier rechecks frame ownership and never treats a promise as permission', async () => {
  for (const failure of ['escape', 'reject']) {
    const parent = { parentFrame: () => null }; let currentParent = parent, resolve, reject, allowed = 0;
    const child = { parentFrame: () => currentParent }, prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
    const guard = createNativeRequestGuard({ requestAllowed: () => { allowed += 1; return true; },
      beforeAllowed: request => request.url().endsWith('api/v1/session') ? new Promise((done, fail) => { resolve = done; reject = fail; }) : undefined });
    guard.bindParent(parent); guard.armIngress();
    const document = syntheticRoute(child, LOCAL_ORIGIN + prefix, { resource: 'document', navigation: true });
    await guard.handle(document); assert.deepEqual(document.actions, ['continue']); assert.equal(allowed, 1);
    const read = syntheticRoute(child, LOCAL_ORIGIN + prefix + 'api/v1/session'), pending = guard.handle(read);
    await new Promise(done => setImmediate(done)); assert.deepEqual(read.actions, []); assert.equal(allowed, 1);
    if (failure === 'escape') { currentParent = {}; resolve(); } else reject(new Error('SYNTHETIC_BARRIER_DENIAL'));
    await pending; assert.deepEqual(read.actions, ['abort']); assert.equal(allowed, 1);
  }
});

test('external sidebar includes the panel click in its original proof deadline', async t => {
  let time = 100; t.mock.method(performance, 'now', () => time);
  const calls = [], sidebar = { click: async options => { assert.equal(options.timeout, 1000); calls.push('click'); time += 1001; } };
  const expect = () => ({ toBeVisible: async () => { time += 29000; } });
  const session = { beforeIngress: async () => calls.push('shell'), afterIngress: () => assert.fail('expired click cannot start proof'), fence: () => calls.push('fence') };
  await assert.rejects(enterNativeSidebar(sidebar, expect, { armIngress: () => calls.push('arm') }, session, true));
  assert.deepEqual(calls, ['shell', 'arm', 'click', 'fence']);
});

test('external hook rejection, exhausted original wait and late completion never arm or click Ingress', async t => {
  let time = 100;
  t.mock.method(performance, 'now', () => time);
  for (const mode of ['failed', 'exhausted', 'late']) {
    const calls = [], sidebar = { click: async () => calls.push('click') }; let complete;
    const expect = () => ({ toBeVisible: async () => { time += mode === 'exhausted' ? 30000 : 29985; } });
    const session = { beforeIngress: async remaining => {
      calls.push('hook'); assert.equal(remaining, 15);
      if (mode === 'failed') throw new Error('SYNTHETIC_FAILED');
      return new Promise(done => { complete = done; });
    }, fence: () => calls.push('fence') };
    await assert.rejects(enterNativeSidebar(sidebar, expect, { armIngress: () => calls.push('arm') }, session, true));
    assert.deepEqual(calls, mode === 'exhausted' ? ['fence'] : ['hook', 'fence']);
    if (complete) complete(); await new Promise(done => setImmediate(done));
    assert.equal(calls.includes('arm'), false); assert.equal(calls.includes('click'), false);
  }
});


if (process.env.JUKELET_EXTERNAL_BROWSER_TESTS === '1') {
  test('external login readiness waits through a real client navigation before inspecting registrations', async () => {
    const { chromium } = await import('../../frontend/node_modules/@playwright/test/index.mjs');
    const { inspectExternalRegistrations } = await import('./browser_external.mjs');
    const browser = await chromium.launch({ headless: true, timeout: 20000 });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let releaseTransition; const transition = new Promise(done => { releaseTransition = done; });
    let transitionRequested; const requested = new Promise(done => { transitionRequested = done; });
    let guardStarted = false, guardSawForm = false, reads = 0, fenced = false;
    const page = await context.newPage();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== LOCAL_ORIGIN) return route.abort();
      if (url.pathname === '/transition') { transitionRequested(); await transition; return route.fulfill({ status: 200, body: '' }); }
      const body = url.pathname === '/login'
        ? '<label>Username<input></label><label>Password<input type="password"></label><button>Log in</button>'
        : '<script>fetch("/transition").then(() => location.replace("/login"))</script><p>Inert routing document</p>';
      return route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    try {
      await page.goto(LOCAL_ORIGIN + '/', { waitUntil: 'domcontentloaded' }); await requested;
      const session = { beforeCredentials: async () => {
        guardStarted = true; guardSawForm = await page.getByLabel('Username', { exact: true }).isVisible();
        assert.deepEqual(await page.evaluate(inspectExternalRegistrations), { outcome: 'PASS', registrations: 0 });
      }, fence: () => { fenced = true; } };
      const pending = verifyExternalLoginReady(page, session, performance.now() + 30000).then(() => { reads += 1; });
      // A real routing document cannot provide the login form until this response.
      // The original path entered the credential guard immediately in this document.
      assert.equal(guardStarted, false); assert.equal(reads, 0);
      releaseTransition(); await pending;
      assert.equal(guardStarted, true); assert.equal(guardSawForm, true); assert.equal(reads, 1); assert.equal(fenced, false);
      assert.equal(page.url(), LOCAL_ORIGIN + '/login');
    } finally { releaseTransition(); await browser.close(); }
  });
}

test('external login readiness fences missing form, exhausted budget and failed inventory before credential reads', async () => {
  for (const kind of ['form', 'budget', 'inventory']) {
    let reads = 0, checked = 0, fenced = 0;
    const page = { getByLabel: () => ({ waitFor: async () => { if (kind === 'form') throw new Error('synthetic_missing_form'); } }),
      getByRole: () => ({ waitFor: async () => {} }) };
    const session = { beforeCredentials: async () => { checked += 1; throw new Error('synthetic_inventory_failure'); }, fence: () => { fenced += 1; } };
    await assert.rejects(verifyExternalLoginReady(page, session, performance.now() + (kind === 'budget' ? -1 : 1000)).then(() => { reads += 1; }));
    assert.equal(reads, 0); assert.equal(fenced, 1); assert.equal(checked, kind === 'inventory' ? 1 : 0);
  }
});

test('external login readiness deadline fences an unresolved guard and late completion cannot grant credentials', async () => {
  let resolve, fenced = 0, reads = 0;
  const locator = { waitFor: async () => {} };
  const page = { getByLabel: () => locator, getByRole: () => locator };
  const session = { beforeCredentials: () => new Promise(done => { resolve = done; }), fence: () => { fenced += 1; } };
  const pending = verifyExternalLoginReady(page, session, performance.now() + 30).then(() => { reads += 1; });
  await assert.rejects(pending); assert.equal(fenced, 1); assert.equal(reads, 0);
  resolve(); await new Promise(done => setImmediate(done)); assert.equal(reads, 0);
});
