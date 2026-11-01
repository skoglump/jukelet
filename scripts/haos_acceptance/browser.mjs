/** Explicit phases against the named disposable HA OS; no top-level Playwright import. */
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readExpirySeedForReplay, replayExpiredIngressCookie } from './browser_auth.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, ingressPrefix,
  assetSummary, blockedEndpointEvidence, blockedRequestCategory, pageErrorSource,
  expectedTypeErrorUndefinedAddEventListener, headerPresence, matchesInvestigatedRequest, projectPageErrorFrames,
  readCredentials, readOnlyRequestAllowed, readPublicInputs, serviceWorkerSourceLookup, websocketAllowed } from './browser_inputs.mjs';

export function queryFixture(socketPath = join(CONTROL_ROOT, 'qmp.sock')) {
  return new Promise((done, reject) => {
    let buffer = '', stage = 0, messages = 0, name;
    const commands = [
      { execute: 'qmp_capabilities', id: 'capabilities' },
      { execute: 'query-name', id: 'name' },
      { execute: 'query-status', id: 'status' },
    ];
    const socket = net.createConnection({ path: socketPath });
    const fail = () => { socket.destroy(); reject(new Error('fixture_identity_unverified')); };
    socket.setTimeout(5000, fail);
    socket.on('error', fail);
    socket.on('end', () => { if (stage !== 4) fail(); });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 65536) { fail(); return; }
      while (buffer.includes('\n')) {
        const line = buffer.slice(0, buffer.indexOf('\n')); buffer = buffer.slice(buffer.indexOf('\n') + 1);
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); } catch { fail(); return; }
        if (++messages > 32 || value.error) { fail(); return; }
        if (value.event) continue;
        if (stage === 0) {
          if (!value.QMP) { fail(); return; }
        } else {
          if (value.id !== commands[stage - 1].id || !Object.hasOwn(value, 'return')) { fail(); return; }
          if (stage === 2) name = value.return?.name;
          if (stage === 3) {
            if (name !== FIXTURE || value.return?.status !== 'running' || value.return?.running !== true) { fail(); return; }
            stage = 4; socket.destroy(); done({ name_verified: true, running: true }); return;
          }
        }
        socket.write(JSON.stringify(commands[stage]) + '\n'); stage += 1;
      }
    });
  });
}

export async function verifyTLS(certificate, origin = LOCAL_ORIGIN) {
  assert.equal(origin, LOCAL_ORIGIN);
  await new Promise((done, reject) => {
    const request = https.get(origin + '/', { ca: certificate, rejectUnauthorized: true, agent: false }, response => {
      response.resume();
      if (response.statusCode === 200) done(); else reject(new Error('fixture_tls_unverified'));
    });
    request.on('error', () => reject(new Error('fixture_tls_unverified')));
    request.setTimeout(5000, () => request.destroy(new Error('fixture_tls_unverified')));
  });
  const parsed = new X509Certificate(certificate);
  assert.equal(parsed.checkIP('127.0.0.1'), '127.0.0.1');
  const spki = parsed.publicKey.export({ type: 'spki', format: 'der' });
  return { spki: Buffer.from(hash(spki), 'hex').toString('base64'), certificate_sha256: hash(certificate) };
}

export function assessReadOnly(value, now = Date.now()) {
  const { session, status, inventory, capabilities, inbox } = value;
  assert.equal(session.status, 200); assert.equal(session.body.runtime, 'ingress');
  assert.equal(session.body.mode, 'manage');
  assert.match(session.body.user_id, /^[a-f0-9]{32}$/);
  assert.ok(Number.isFinite(Date.parse(session.body.expires_at)) && Date.parse(session.body.expires_at) > now);
  assert.equal(status.status, 200); assert.equal(status.body.connection, 'connected');
  assert.equal(status.body.subscribed, true);
  assert.match(status.body.version, /^[1-9][0-9]{3}\.(?:[1-9]|1[0-2])\.(?:0|[1-9][0-9]*)(?:b(?:0|[1-9][0-9]*))?$/);
  assert.equal(inventory.status, 200); assert.equal(inventory.body.registry_available, true);
  assert.equal(inventory.body.stale, false); assert.ok(Array.isArray(inventory.body.tags));
  assert.ok(Number.isInteger(inventory.body.total) && inventory.body.total >= inventory.body.tags.length);
  for (const tag of inventory.body.tags) assert.equal(typeof tag.ha_tag_id, 'string');
  assert.equal(inbox.status, 200); assert.equal(inbox.body.registry_available, true);
  assert.equal(inbox.body.assignments_available, true);
  assert.equal(capabilities.status, 200);
  for (const operation of ['album_detail', 'playlist_detail', 'album_library', 'playlist_library', 'album_search', 'playlist_search']) assert.equal(capabilities.body[operation], 'supported');
  return {
    mode: 'manage', user_id_sha256: hash(session.body.user_id), expires_at: session.body.expires_at,
    core_version: status.body.version, tag_count: inventory.body.total,
    tag_ids_sha256: hash(JSON.stringify(inventory.body.tags.map(tag => tag.ha_tag_id))),
    registry_fresh: true, scan_subscription: true, metadata_capabilities: 'all_six_supported',
  };
}

export async function collectNativeReads(baseURI) {
  const read = async endpoint => {
    const response = await fetch(new URL('api/v1/' + endpoint, baseURI), { credentials: 'same-origin', redirect: 'error' });
    return { status: response.status, body: await response.json() };
  };
  const [session, status, capabilities, inbox] = await Promise.all([
    'session', 'status', 'music/capabilities',
    'tags/inbox?view=unassigned&offset=0&limit=100',
  ].map(read));
  // The supported inbox read refreshes HA's registry. Read the cache only after
  // that response, rather than racing a stale pre-refresh inventory snapshot.
  const inventory = await read('tags?offset=0&limit=100');
  return { session, status, inventory, capabilities, inbox };
}

export function assessNetworkBoundaries(network, categories) {
  assert.deepEqual(Object.keys(network).sort(), ['blocked_http', 'blocked_websocket', 'escaped_ingress', 'page_errors']);
  for (const value of Object.values(network)) assert.ok(Number.isInteger(value) && value >= 0);
  assert.equal(network.blocked_websocket, 0); assert.equal(network.escaped_ingress, 0);
  assert.deepEqual(Object.keys(categories).sort(), ['blocked_http', 'blocked_http_endpoint_overflow', 'blocked_http_endpoints',
    'blocked_websocket', 'investigated_request_headers', 'page_error_frames', 'page_error_predicates', 'page_error_sources', 'page_error_types']);
  assert.equal(categories.blocked_http_endpoint_overflow, 0);
  assert.deepEqual(categories.blocked_websocket, {});
  const clean = { jukelet_page_errors: 0, unexpected_page_errors: 0,
    unexpected_blocked_requests: 0, ingress_escapes: 0, outside_requests_permitted: 0 };
  if (network.blocked_http === 0 && network.page_errors === 0) {
    for (const key of ['blocked_http', 'page_error_types', 'page_error_sources']) assert.deepEqual(categories[key], {});
    for (const key of ['blocked_http_endpoints', 'page_error_frames', 'page_error_predicates', 'investigated_request_headers']) assert.deepEqual(categories[key], []);
    return { result: 'PASS', ...clean, expected_fixture_warning: null };
  }
  // Playwright's SW isolation returns undefined from register(). HA's parent
  // then throws at addEventListener and its logger fetches the original source.
  // Accept only that complete observed fixture artifact; never a generic parent
  // error, an allowed external request, an app error or an unknown failure.
  assert.equal(network.blocked_http, 1); assert.equal(network.page_errors, 1);
  assert.deepEqual(categories.blocked_http, { 'outside_origin|ha_parent|GET|xhr': 1 });
  assert.deepEqual(categories.page_error_types, { TypeError: 1 });
  assert.deepEqual(categories.page_error_sources, { ha_parent_frontend: 1 });
  assert.deepEqual(categories.page_error_predicates, [{ source: 'ha_parent_frontend', expectedTypeErrorUndefinedAddEventListener: true }]);
  assert.equal(categories.page_error_frames.length, 1);
  const frames = categories.page_error_frames[0]; assert.ok(Array.isArray(frames) && frames.length > 0);
  for (const frame of frames) {
    assert.equal(frame.source, 'ha_parent_frontend');
    assert.match(frame.script_path, /^\/(?:frontend_latest|frontend_es5|frontend_data)\/[A-Za-z0-9_.-]{1,120}[.-][a-f0-9]{6,64}\.js$/);
    assert.ok(Number.isInteger(frame.line) && frame.line > 0 && Number.isInteger(frame.column) && frame.column > 0);
    assert.equal(frame.location_base, 1);
  }
  assert.ok(frames.some(frame => /^\/frontend_latest\/app\.[a-f0-9]{6,64}\.js$/.test(frame.script_path)));
  assert.equal(categories.investigated_request_headers.length, 1);
  const request = categories.investigated_request_headers[0];
  assert.deepEqual(Object.keys(request).sort(), ['hasQueryString', 'headers_available', 'requestHasAuthorizationHeader', 'requestHasCookieHeader', 'source_lookup']);
  assert.equal(request.headers_available, true); assert.equal(request.requestHasAuthorizationHeader, false);
  assert.equal(request.requestHasCookieHeader, false); assert.equal(request.hasQueryString, false);
  const lookup = request.source_lookup;
  assert.ok(lookup && /^[1-9][0-9]{7}\.(?:0|[1-9][0-9]{0,3})$/.test(lookup.frontend_version));
  const expected = serviceWorkerSourceLookup('https://raw.githubusercontent.com/home-assistant/frontend/' + lookup.frontend_version + '/src/util/register-service-worker.ts');
  assert.deepEqual(lookup, expected);
  assert.deepEqual(categories.blocked_http_endpoints, [{ endpoint: {
    origin_category: 'other_origin_sha256', origin_sha256: expected.origin_sha256,
    path_category: 'path_sha256', path_sha256: expected.path_sha256,
  }, count: 1 }]);
  return { result: 'PASS_WITH_EXPECTED_FIXTURE_WARNING', ...clean,
    expected_fixture_warning: { code: 'playwright_blocked_sw_parent_registration', source: 'ha_parent_frontend',
      parent_type_errors: 1, still_blocked_original_source_lookups: 1,
      frontend_version: expected.frontend_version, lookup_origin_sha256: expected.origin_sha256,
      lookup_path_sha256: expected.path_sha256, normal_service_worker_support: 'NOT_TESTED' } };
}

export function prepareExpirySeed(cookies, observation, timing) {
  assert.ok(Array.isArray(cookies));
  assert.equal(ingressPrefix(LOCAL_ORIGIN + observation.prefix), observation.prefix);
  assert.match(observation.user_id_sha256, /^[a-f0-9]{64}$/);
  assert.match(observation.configuration_sha256, /^[a-f0-9]{64}$/);
  const capturedAt = Date.parse(timing.captured_at), closedAt = Date.parse(timing.closed_at);
  assert.ok(Number.isFinite(capturedAt) && Number.isFinite(closedAt) && closedAt >= capturedAt);
  assert.ok(Date.parse(observation.expires_at) > closedAt);
  function oneCookie(name, path) {
    const matching = cookies.filter(value => value.name === name);
    assert.equal(matching.length, 1);
    const value = matching[0];
    assert.equal(value.domain, '127.0.0.1'); assert.equal(value.path, path);
    assert.equal(value.secure, true); assert.equal(value.sameSite, 'Strict');
    assert.equal(typeof value.httpOnly, 'boolean');
    assert.equal(typeof value.value, 'string');
    assert.ok(value.value.length > 0 && value.value.length <= 4096 && !/[\s;,\u0000-\u001f\u007f]/.test(value.value));
    assert.ok(typeof value.expires === 'number' && Number.isFinite(value.expires));
    return Object.fromEntries(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'].map(key => [key, value[key]]));
  }
  const cookie = oneCookie('jukelet_ingress_session', observation.prefix.slice(0, -1));
  assert.equal(cookie.httpOnly, true); assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(cookie.expires * 1000 > closedAt);
  const ingressCookie = oneCookie('ingress_session', '/api/hassio_ingress/');
  assert.equal(ingressCookie.expires, -1); // Frontend cookie has no client Max-Age; expiry is server-side.
  return { schema_version: 2, fixture: FIXTURE, origin: LOCAL_ORIGIN,
    prefix: observation.prefix, cookie, ingress_cookie: ingressCookie,
    user_id_sha256: observation.user_id_sha256,
    expires_at: observation.expires_at, cookie_captured_at: timing.captured_at,
    browser_closed_at: timing.closed_at, ingress_last_touch_upper_bound: timing.closed_at,
    ingress_replay_not_before: new Date(closedAt + 16 * 60 * 1000).toISOString(),
    seeded_at: timing.closed_at,
    configuration_sha256: observation.configuration_sha256 };
}

export function expirySeedSummary(seed) {
  return { saved_private_exclusive: true, kind: 'natural_supervisor_idle_expiry_replay',
    app_cookie_sha256: hash(seed.cookie.value), ingress_cookie_sha256: hash(seed.ingress_cookie.value),
    ingress_cookie_captured_at: seed.cookie_captured_at,
    ingress_last_touch_upper_bound: seed.ingress_last_touch_upper_bound,
    ingress_replay_not_before: seed.ingress_replay_not_before, app_expires_at: seed.expires_at,
    natural_supervisor_expiry: 'PENDING', natural_app_8h_expiry: 'NOT_RUN' };
}

function saveExpirySeed(value) {
  const directory = lstatSync(CONTROL_ROOT);
  assert.ok(directory.isDirectory()); assert.equal(realpathSync(CONTROL_ROOT), CONTROL_ROOT);
  assert.equal(directory.mode & 0o777, 0o700); assert.equal(directory.uid, process.getuid());
  assert.equal(directory.gid, process.getgid());
  const fd = openSync(join(CONTROL_ROOT, 'expiry-seed.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd); assert.equal(info.nlink, 1); assert.equal(info.mode & 0o777, 0o600);
    writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd);
  } finally { closeSync(fd); }
  const directoryFd = openSync(CONTROL_ROOT, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

export async function runReadOnly(path, { seedExpiry = false, expiryReplay = false } = {}) {
  const report = { fixture: FIXTURE, phase: expiryReplay ? 'expiry-replay' : 'read-only', result: 'FAIL', checks: {}, limitations: [
    'Initial read-only operations against manage mode; editing/security/restarts/dispatch/version matrix remain separate.',
    'Synthetic metadata is provided by the explicitly installed HA fixture; no Spotify or household playback proof.',
    'Declared artifact identities must also be matched by root runtime/archive evidence.',
    'Service workers are blocked for request observability; the exact known HA-parent registration error/source-lookup pair is separately reported. Normal service-worker support is not certified.',
    ...(expiryReplay ? ['This case replays a naturally idle-expired Supervisor credential; natural eight-hour app-backend expiry is NOT_RUN. The before-app location is a source-backed causal inference, not a captured backend denial log.'] : []),
  ] };
  let stage = 'local_inputs', browser, measuredNetwork;
  try {
    assert.ok(!(seedExpiry && expiryReplay));
    report.probe_sources_sha256 = Object.fromEntries(['browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = readPublicInputs(path);
    Object.assign(report, { configuration_sha256: inputs.configuration_sha256, declared_candidate: inputs.document.candidate, declared_bridge: inputs.document.bridge });
    let replaySeed;
    if (expiryReplay) {
      // This local gate must precede QMP, TLS, credential values and browser work.
      stage = 'expiry_preflight';
      const loaded = readExpirySeedForReplay(inputs.configuration_sha256); replaySeed = loaded.seed;
      report.checks.expiry_preflight = { seed_file_sha256: loaded.file_sha256,
        replay_not_before: replaySeed.ingress_replay_not_before,
        supervisor_last_touch_upper_bound: replaySeed.ingress_last_touch_upper_bound,
        configuration_bound: true, conservative_deadline_elapsed: true, native_work_before_deadline_gate: false };
    }
    stage = 'qmp_identity'; report.checks.vm = await queryFixture();
    stage = 'tls'; const tls = await verifyTLS(inputs.certificate);
    report.checks.tls = { ca_and_hostname_verified: true, certificate_sha256: tls.certificate_sha256, chromium_spki_pinned: true };
    stage = 'private_browser_credentials'; const credentials = readCredentials(inputs.document, 'administrator');
    stage = 'browser_dependencies'; const { chromium, expect } = await import(pathToFileURL(join(REPOSITORY, 'frontend/node_modules/@playwright/test/index.mjs')).href);
    browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${tls.spki}`] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const network = { blocked_http: 0, blocked_websocket: 0, escaped_ingress: 0, page_errors: 0 };
    measuredNetwork = network;
    const networkCategories = { blocked_http: {}, blocked_websocket: {}, page_error_types: {},
      page_error_sources: {}, blocked_http_endpoints: [], blocked_http_endpoint_overflow: 0,
      page_error_frames: [], page_error_predicates: [], investigated_request_headers: [] };
    const increment = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
    const observeBlockedEndpoint = url => {
      const endpoint = blockedEndpointEvidence(url);
      const previous = networkCategories.blocked_http_endpoints.find(row => JSON.stringify(row.endpoint) === JSON.stringify(endpoint));
      if (previous) previous.count += 1;
      else if (networkCategories.blocked_http_endpoints.length < 16) networkCategories.blocked_http_endpoints.push({ endpoint, count: 1 });
      else networkCategories.blocked_http_endpoint_overflow += 1;
    };
    let frame, prefix;
    await context.route('**/*', async route => {
      const request = route.request(); let fromFrame = false, requestContext = 'unknown';
      try {
        const requestFrame = request.frame(); fromFrame = frame && requestFrame === frame;
        requestContext = fromFrame ? 'ingress_frame' : requestFrame.parentFrame() === null ? 'ha_parent' : 'child_frame';
      } catch { /* No frame, still fixed-origin checked. */ }
      const url = new URL(request.url());
      if (fromFrame && prefix && (url.origin !== LOCAL_ORIGIN || !url.pathname.startsWith(prefix))) network.escaped_ingress += 1;
      if (!readOnlyRequestAllowed(request.url(), request.method())) {
        network.blocked_http += 1;
        increment(networkCategories.blocked_http, blockedRequestCategory(request.url(), request.method(), request.resourceType(), requestContext));
        observeBlockedEndpoint(request.url());
        const sourceLookup = serviceWorkerSourceLookup(request.url());
        if ((matchesInvestigatedRequest(request.url()) || sourceLookup) && networkCategories.investigated_request_headers.length < 4) {
          let timer;
          const headers = await Promise.race([
            request.allHeaders().catch(() => null),
            new Promise(done => { timer = setTimeout(() => done(null), 1000); }),
          ]);
          clearTimeout(timer);
          networkCategories.investigated_request_headers.push({ ...headerPresence(headers),
            hasQueryString: new URL(request.url()).search !== '', source_lookup: sourceLookup });
        }
        return route.abort();
      }
      return route.continue();
    });
    await context.routeWebSocket('**', socket => {
      if (!websocketAllowed(socket.url())) {
        network.blocked_websocket += 1;
        increment(networkCategories.blocked_websocket, blockedRequestCategory(socket.url(), 'GET', 'websocket', 'unknown'));
        return socket.close();
      }
      // Transparent default forwarding: never intercept, replace or fabricate messages.
      socket.connectToServer();
    });
    const page = await context.newPage(); page.on('pageerror', error => {
      network.page_errors += 1;
      const kind = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(error.name) ? error.name : 'Other';
      increment(networkCategories.page_error_types, kind);
      increment(networkCategories.page_error_sources, pageErrorSource(error.stack));
      if (networkCategories.page_error_frames.length < 4) networkCategories.page_error_frames.push(projectPageErrorFrames(error.stack));
      if (networkCategories.page_error_predicates.length < 4) networkCategories.page_error_predicates.push({
        source: pageErrorSource(error.stack),
        expectedTypeErrorUndefinedAddEventListener: expectedTypeErrorUndefinedAddEventListener(error.name, error.message, error.stack),
      });
    });
    const assets = [];
    page.on('response', response => {
      const url = new URL(response.url());
      if (/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/assets\//.test(url.pathname)) assets.push({ status: response.status(), extension: url.pathname.endsWith('.css') ? 'css' : 'js' });
    });
    stage = 'normal_ha_login'; await page.goto(LOCAL_ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save login', exact: true });
    if (await save.isVisible().catch(() => false)) await save.click();
    stage = 'sidebar'; const sidebar = page.getByRole('link', { name: 'Jukelet', exact: true });
    await expect(sidebar).toBeVisible({ timeout: 30000 }); await sidebar.click();
    await expect.poll(() => page.frames().filter(item => /^https:\/\/127\.0\.0\.1:18223\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/$/.test(item.url())).length, { timeout: 30000 }).toBe(1);
    frame = page.frames().find(item => /^https:\/\/127\.0\.0\.1:18223\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/$/.test(item.url()));
    prefix = ingressPrefix(frame.url()); report.ingress_prefix_sha256 = hash(prefix);
    stage = 'native_manager';
    const checkAccess = frame.getByRole('button', { name: 'Check access again', exact: true });
    if (await checkAccess.isVisible().catch(() => false)) { await checkAccess.click(); report.checks.explicit_access_check = true; }
    await expect(frame.getByRole('heading', { name: 'Your tag and music manager', exact: true })).toBeVisible({ timeout: 30000 });
    await expect(frame.getByText('Local management', { exact: true })).toBeVisible();
    await expect(frame.getByLabel('App secret', { exact: true })).toHaveCount(0);
    await expect(frame.getByRole('region', { name: 'Home Assistant status' })).toContainText('Home Assistant connected.', { timeout: 30000 });
    const observations = await frame.evaluate(collectNativeReads, frame.url());
    report.checks.native_reads = assessReadOnly(observations);
    const inventory = frame.getByRole('region', { name: 'Tag inventory', exact: true });
    await expect(inventory).toContainText(`${observations.inventory.body.total} tags. Registry updated:`, { timeout: 15000 });
    const codes = await inventory.locator('code').allTextContents();
    assert.ok(observations.inventory.body.tags.every(tag => codes.includes(tag.ha_tag_id)));
    await inventory.getByRole('button', { name: 'Add tag / unassigned inbox', exact: true }).click();
    const inbox = frame.getByRole('region', { name: 'Tag onboarding', exact: true });
    await expect(inbox).toBeVisible(); await inbox.getByRole('button', { name: 'Close onboarding', exact: true }).click();
    stage = 'synthetic_metadata_preview'; const music = frame.getByRole('region', { name: 'Music preview', exact: true });
    const previewResponse = page.waitForResponse(response => response.url() === LOCAL_ORIGIN + prefix + 'api/v1/music/resolve' && response.request().method() === 'POST');
    await music.getByLabel('Spotify URI or link', { exact: true }).fill('spotify:album:0123456789ABCDEFGHIJKL');
    await music.getByRole('button', { name: 'Preview URI', exact: true }).click();
    const response = await previewResponse; const preview = await response.json();
    assert.equal(response.status(), 200); assert.equal(preview.state, 'fresh'); assert.equal(preview.item?.title, 'Synthetic Jukelet62 album');
    await expect(music.getByLabel('Selected music preview')).toContainText('Synthetic Jukelet62 album');
    report.checks.metadata_preview = { status: 200, state: 'fresh', fixture_title_displayed: true };
    // Preserve measured evidence even when the unchanged following assertions fail.
    report.checks.assets = assetSummary(assets);
    report.checks.network = { ...network };
    report.checks.network_categories = networkCategories;
    stage = 'native_css_asset_assertion';
    assert.ok(assets.some(asset => asset.extension === 'css' && asset.status === 200));
    stage = 'native_js_asset_assertion';
    assert.ok(assets.some(asset => asset.extension === 'js' && asset.status === 200));
    report.checks.sidebar = true; report.checks.inventory_and_inbox = true;
    if (expiryReplay) {
      stage = 'valid_N_before_expired_O_replay';
      report.checks.pre_replay_network_assessment = assessNetworkBoundaries(network, networkCategories);
      report.checks.expiry_replay = {};
      stage = 'natural_supervisor_expiry_replay';
      await replayExpiredIngressCookie({ browser, context, page, frame, prefix, seed: replaySeed,
        observation: { configuration_sha256: inputs.configuration_sha256,
          user_id_sha256: report.checks.native_reads.user_id_sha256,
          expires_at: observations.session.body.expires_at },
        expect, evidence: report.checks.expiry_replay });
      browser = undefined;
    }
    let cookies, capturedAt;
    if (seedExpiry) {
      cookies = await context.cookies(LOCAL_ORIGIN + prefix);
      capturedAt = new Date().toISOString();
    }
    // Close before the verdict so no later browser request/error can escape the
    // assessed counters, and the optional expiry bound has no live parent renewal.
    stage = 'close_browser_for_boundary_verdict';
    await browser?.close(); browser = undefined;
    const closedAt = new Date().toISOString();
    report.checks.network = { ...network };
    stage = 'native_network_assertion';
    const { expected_fixture_warning, ...networkAssessment } = assessNetworkBoundaries(network, networkCategories);
    report.checks.network_assessment = networkAssessment;
    report.checks.expected_fixture_warning = expected_fixture_warning;
    if (seedExpiry) {
      stage = 'exclusive_private_expiry_seed';
      const seed = prepareExpirySeed(cookies, { prefix,
        user_id_sha256: report.checks.native_reads.user_id_sha256,
        expires_at: observations.session.body.expires_at, configuration_sha256: inputs.configuration_sha256,
      }, { captured_at: capturedAt, closed_at: closedAt });
      saveExpirySeed(seed); report.checks.expiry_seed = expirySeedSummary(seed);
    }
    report.result = 'PASS'; report.stage = 'complete';
  } catch (error) {
    report.stage = stage;
    report.code = stage === 'expiry_preflight' && error?.message === 'expiry_replay_too_early'
      ? 'expiry_replay_too_early' : 'native_phase_failed';
  } finally {
    await browser?.close().catch(() => {});
    if (measuredNetwork) report.checks.network = { ...measuredNetwork };
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('node scripts/haos_acceptance/browser.mjs read-only CONFIGURATION [--seed-expiry]\nnode scripts/haos_acceptance/browser.mjs expiry-replay CONFIGURATION\n');
  } else if (args[0] === 'read-only' && [2, 3].includes(args.length) && (args.length === 2 || args[2] === '--seed-expiry')) {
    const report = await runReadOnly(args[1], { seedExpiry: args[2] === '--seed-expiry' });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.result === 'PASS' ? 0 : 1;
  } else if (args[0] === 'expiry-replay' && args.length === 2) {
    const report = await runReadOnly(args[1], { expiryReplay: true });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.result === 'PASS' ? 0 : 1;
  } else {
    process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'invalid_phase_arguments' }) + '\n'); process.exitCode = 2;
  }
}
