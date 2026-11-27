/** Default controls are dependency-free; optional Chromium tests use synthetic DOM only. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';
import { createNativeRequestGuard } from './browser.mjs';
import { NavigationGate, assessNavigationSession, exerciseNavigationView, navigationAction, observeNavigationViewport,
  parseNavigationReceipt, readNavigationInBrowser, validateNavigationReceipt } from './browser_navigation.mjs';

const prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/', now = Date.parse('2026-11-02T07:30:00Z');
function receipt() {
  return { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN,
    configuration_A_sha256: '1'.repeat(64), actual_candidate_image_manifest_digest: 'sha256:' + '2'.repeat(64),
    actual_bridge_archive_sha256: '3'.repeat(64), admin_A_user_id_sha256: hash('1'.repeat(32)), ingress_prefix_sha256: hash(prefix),
    publisher_id_sha256: '4'.repeat(64), assignment_snapshot_sha256: '5'.repeat(64), domain_revision: 13, published_revision: 1,
    published_checksum: '6'.repeat(64), automatic_publication_disabled: true, dispatch_disabled: true,
    backup_artifact_sha256: '94ab3bb6010cbad35bf55f7861fc113899472ce9101a7f43d27751ee1f48b481',
    source_preflight_sha256: '7'.repeat(64), observed_at: new Date(now).toISOString() };
}
function inputs(value = receipt()) {
  return { configuration_sha256: value.configuration_A_sha256, document: {
    candidate: { image_manifest_digest: value.actual_candidate_image_manifest_digest }, bridge: { archive_sha256: value.actual_bridge_archive_sha256 } } };
}
function request(path = 'api/v1/session', method = 'GET', body = null) {
  return { url: () => LOCAL_ORIGIN + prefix + path, method: () => method, postData: () => body };
}
const scope = { fromFrame: true, prefix };

test('duplicate receipt fields cannot silently select a different current-state assertion', () => {
  const raw = JSON.stringify(receipt());
  assert.throws(() => parseNavigationReceipt(raw.replace('{', '{"domain_revision":12,')));
});

test('receipt binds exact current state, config/artifacts/preflight/backup and rejects stale or malformed declarations', () => {
  const value = receipt(); assert.deepEqual(parseNavigationReceipt(JSON.stringify(value)), value);
  assert.equal(validateNavigationReceipt(value, inputs(), value.source_preflight_sha256, now).saved_revision, 13);
  for (const mutate of [v => { v.domain_revision = 12; }, v => { v.published_revision = 2; }, v => { v.synthetic = false; },
    v => { v.configuration_A_sha256 = 'a'.repeat(64); }, v => { v.actual_bridge_archive_sha256 = 'b'.repeat(64); },
    v => { v.actual_candidate_image_manifest_digest = 'sha256:' + 'c'.repeat(64); }, v => { v.backup_artifact_sha256 = 'd'.repeat(64); },
    v => { v.source_preflight_sha256 = 'e'.repeat(64); }, v => { v.origin = 'https://example.invalid'; },
    v => { v.automatic_publication_disabled = false; }, v => { v.dispatch_disabled = false; }, v => { v.admin_A_user_id_sha256 = 'invalid'; },
    v => { v.ingress_prefix_sha256 = true; }, v => { v.extra = true; }]) {
    const bad = structuredClone(value); mutate(bad);
    assert.throws(() => validateNavigationReceipt(bad, inputs(), value.source_preflight_sha256, now));
  }
  assert.throws(() => validateNavigationReceipt(value, inputs(), value.source_preflight_sha256, now + 3600001));
  assert.throws(() => validateNavigationReceipt(value, inputs(), value.source_preflight_sha256, now - 1));
});

test('installed native request guard can authorize bootstrap reads and exactly its fixed metadata preview, never write intents', () => {
  const value = receipt(), gate = new NavigationGate(value, () => validateNavigationReceipt(value, inputs(), value.source_preflight_sha256, now));
  assert.equal(gate.allow(request(), scope), true);
  const preview = JSON.stringify({ input: 'spotify:album:0123456789ABCDEFGHIJKL', media_type: 'album' });
  assert.equal(gate.allow(request('api/v1/music/resolve', 'POST', preview), scope), true);
  gate.ready(value.admin_A_user_id_sha256, prefix); gate.beforeAction();
  assert.equal(gate.allow(request('api/v1/assignments?offset=0&limit=100'), scope), true);
  for (const [path, method, body] of [['api/v1/publication/review', 'POST', '{}'], ['api/v1/restores/preview', 'POST', '{}'],
    ['api/v1/tags/X/assignment', 'PUT', '{}'], ['api/v1/tags/X/name', 'PATCH', '{}'], ['api/v1/music/resolve', 'POST', preview]]) {
    const denied = new NavigationGate(value, () => {}); denied.ready(value.admin_A_user_id_sha256, prefix);
    assert.equal(denied.allow(request(path, method, body), scope), false); assert.equal(denied.evidence().unexpected_intents, 1);
    assert.equal(denied.allow(request(), scope), false); assert.throws(() => denied.beforeAction());
  }
});

test('wrong frame/prefix, stale receipt, unknown authority and pre-cleanup fencing cannot grant later app work', () => {
  const value = receipt();
  for (const place of [{ ...scope, fromFrame: false }, { ...scope, prefix: '/api/hassio_ingress/OTHER/' }]) {
    const gate = new NavigationGate(value, () => {});
    assert.equal(gate.allow(request(), place), false); assert.equal(gate.closed, true);
  }
  let fresh = true;
  const unbound = new NavigationGate(value, () => {}); assert.throws(() => unbound.beforeAction()); assert.equal(unbound.closed, true);
  const wrong = new NavigationGate(value, () => {}); assert.throws(() => wrong.ready('0'.repeat(64), prefix));
  assert.throws(() => wrong.ready(value.admin_A_user_id_sha256, prefix));
  const gate = new NavigationGate(value, () => assert.equal(fresh, true));
  gate.ready(value.admin_A_user_id_sha256, prefix); fresh = false;
  assert.equal(gate.allow(request(), scope), false); assert.throws(() => gate.beforeAction());
  const closing = new NavigationGate(value, () => {}); closing.ready(value.admin_A_user_id_sha256, prefix);
  closing.progress({ operation: 'browser_close', checkpoint: 'begin' });
  assert.equal(closing.closed, true); assert.equal(closing.allow(request(), scope), false); assert.throws(() => closing.beforeAction());
});

test('actual installed route delegates only the bound native child and aborts unsupported intent without continuation', async () => {
  const value = receipt(), gate = new NavigationGate(value, () => {}), actions = [];
  const parent = { parentFrame: () => null }, child = { parentFrame: () => parent };
  const native = createNativeRequestGuard({ requestAllowed: (wire, place) => gate.allow(wire, place) });
  native.bindParent(parent); native.armIngress();
  const send = async wire => native.handle({ request: () => wire, abort: async () => actions.push('abort'), continue: async () => actions.push('continue') });
  await send({ ...request(''), frame: () => child, resourceType: () => 'document', isNavigationRequest: () => true });
  gate.ready(value.admin_A_user_id_sha256, prefix);
  await send({ ...request('api/v1/publication/review', 'POST', '{}'), frame: () => child });
  await send({ ...request(), frame: () => child });
  assert.deepEqual(actions, ['continue', 'abort', 'abort']); assert.equal(gate.unexpected_intents, 1);
});

function session() {
  return { authenticated: true, runtime: 'ingress', mode: 'manage', user_id: '1'.repeat(32), csrf_token: 'SYNTHETIC', expires_at: new Date(now + 10000).toISOString() };
}
test('same actual server contract must be fresh ingress/manage and receipt-bound; projected evidence omits raw authority', () => {
  const value = session(), ready = receipt(); assert.equal(assessNavigationSession(value, ready, now).user_id_sha256, ready.admin_A_user_id_sha256);
  assert.ok(!JSON.stringify(assessNavigationSession(value, ready, now)).includes('SYNTHETIC'));
  for (const [field, bad] of [['authenticated', false], ['runtime', 'standalone'], ['mode', 'read_only'], ['user_id', '2'.repeat(32)],
    ['csrf_token', ''], ['expires_at', new Date(now).toISOString()]]) assert.throws(() => assessNavigationSession({ ...value, [field]: bad }, ready, now));
});

test('bounded actual-body reader permits only fixed native reads and rejects malformed, oversized or non-JSON data without retry', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls += 1; assert.equal(url.href, LOCAL_ORIGIN + prefix + 'api/v1/session'); assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'same-origin'); return Response.json(session());
    };
    const value = { base: LOCAL_ORIGIN + prefix, endpoint: 'session' };
    assert.equal((await readNavigationInBrowser(value)).body.runtime, 'ingress'); assert.equal(calls, 1);
    for (const bad of [{ ...value, endpoint: 'publication/confirm' }, { ...value, base: 'https://example.invalid' + prefix },
      { ...value, base: value.base + '?query' }, { ...value, base: value.base + '#fragment' }]) await assert.rejects(readNavigationInBrowser(bad));
    assert.equal(calls, 1);
    for (const response of [new Response('PRIVATE', { headers: { 'content-type': 'text/html' } }),
      new Response('{bad', { headers: { 'content-type': 'application/json' } }),
      new Response('X'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
      new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } })]) {
      globalThis.fetch = async () => { calls += 1; return response; };
      const before = calls; await assert.rejects(readNavigationInBrowser(value)); assert.equal(calls, before + 1);
    }
    globalThis.fetch = async () => new Response('PRIVATE', { status: 403, headers: { 'content-type': 'text/plain' } });
    assert.deepEqual(await readNavigationInBrowser(value), { status: 403, content_type: 'text/plain', body: null });
  } finally { globalThis.fetch = original; }
});

test('denied or late authority and timed-out actions fence the gate and never grant subsequent work', async () => {
  const value = receipt(); let actions = 0;
  const bound = () => { const gate = new NavigationGate(value, () => {}); gate.ready(value.admin_A_user_id_sha256, prefix); return gate; };
  const denied = bound(); await assert.rejects(navigationAction(denied, async () => { throw new Error('synthetic_denial'); }, () => { actions += 1; }));
  assert.equal(actions, 0); assert.equal(denied.closed, true);
  const late = bound(); let finish;
  const pending = navigationAction(late, () => new Promise(done => { finish = done; }), () => { actions += 1; });
  await new Promise(done => setImmediate(done)); late.fence(); finish(); await assert.rejects(pending); assert.equal(actions, 0);
  const timed = bound(); let finishAction;
  await assert.rejects(navigationAction(timed, async () => {}, () => new Promise(done => { finishAction = done; }), { timeoutMs: 20 }));
  assert.equal(timed.closed, true); finishAction(); await new Promise(done => setImmediate(done));
  await assert.rejects(navigationAction(timed, async () => {}, () => { actions += 1; })); assert.equal(actions, 0);
});

test('clean import/help and invalid local input require no frontend dependencies or native access and redact input paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jukelet-navigation-local-'));
  try {
    const scripts = join(directory, 'scripts', 'haos_acceptance'); mkdirSync(scripts, { recursive: true });
    for (const name of ['browser_navigation.mjs', 'browser_publication.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs',
      'browser_manager.mjs', 'browser_metadata.mjs', 'fetch_clone.mjs', 'browser_progress.mjs'])
      copyFileSync(join(dirname(fileURLToPath(import.meta.url)), name), join(scripts, name));
    const module = join(scripts, 'browser_navigation.mjs');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(module).href)})`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(imported.status, 0); assert.equal(imported.stdout + imported.stderr, '');
    assert.equal(spawnSync(process.execPath, [module, '--help'], { timeout: 5000 }).status, 0);
    const invalid = spawnSync(process.execPath, [module, 'save'], { encoding: 'utf8', timeout: 5000 }); assert.equal(invalid.status, 2);
    const bad = spawnSync(process.execPath, [module, 'navigation', '/tmp/SYNTHETIC_PRIVATE_INPUT'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(bad.status, 1); const report = JSON.parse(bad.stdout);
    assert.equal(report.stage, 'local_inputs'); assert.equal(report.checks.cleanup.reason, 'not_started'); assert.equal(report.guard.gate_closed, true);
    assert.equal((bad.stdout + bad.stderr).includes('SYNTHETIC_PRIVATE_INPUT'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

if (process.env.JUKELET_NAVIGATION_BROWSER_TESTS === '1') {
  const { chromium, expect } = await import('../../frontend/node_modules/@playwright/test/index.mjs');
  const { ALBUM_TAG } = await import('./browser_manager.mjs');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../frontend/src/style.css', import.meta.url), 'utf8');
  async function fixture(t, { brokenBack = false } = {}) {
    const browser = await chromium.launch({ headless: true, timeout: 15000 });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    let http = 0, ws = 0;
    await context.route('**/*', route => { http += 1; return route.abort(); });
    await context.routeWebSocket('**', socket => { ws += 1; return socket.close(); });
    t.after(async () => { try { await context.close(); } finally { await browser.close(); } assert.equal(http, 0); assert.equal(ws, 0); });
    const page = await context.newPage(); page.setDefaultTimeout(600);
    // Synthetic navigation DOM only: no app/API/auth/session responses exist.
    await page.setContent(`<style>${css}</style><main><nav aria-label="Manager sections">${[['Tags','tags'],['Local drafts','drafts'],['Discover music','music'],['Publication','publication'],['Playback readiness','playback'],['Connections','connections'],['Export and recovery','recovery']].map(([name,id]) => `<a href="#${id}">${name}</a>`).join(' ')}</nav>
      <section id="tags" aria-label="Tag inventory"><h2>Tag inventory</h2><ul class="tag-list"><li><code></code><button aria-label="View tag Synthetic">View tag</button></li></ul></section>
      <section id="drafts" aria-label="Saved local drafts"><h2>Saved local drafts</h2><ul class="tag-list"><li><code></code><button>Edit draft Synthetic</button></li></ul></section>
      ${['music','publication','playback','connections','recovery'].map(id => `<section id="${id}" style="min-height:300px"><h2>${id}</h2></section>`).join('')}</main>`);
    await page.evaluate(({ tag, brokenBack }) => {
      for (const code of document.querySelectorAll('.tag-list code')) code.textContent = tag;
      for (const [id, region, heading, back] of [['tags','Tag detail','Synthetic','Back to tag list'],['drafts','Saved draft detail','Edit saved draft','Back to saved drafts']]) {
        const parent = document.getElementById(id), open = parent.querySelector('button');
        open.onclick = () => {
          const detail = document.createElement('section'); detail.setAttribute('aria-label', region);
          detail.innerHTML = `<button>${back}</button><h3 tabindex="-1">${heading}</h3><code></code><label>Draft Spotify URI or link<input value="spotify:album:0123456789ABCDEFGHIJKL"></label>`;
          detail.querySelector('code').textContent = tag; parent.append(detail); detail.querySelector('h3').focus();
          detail.querySelector('button').onclick = () => { detail.remove(); if (!brokenBack) open.focus(); };
        };
      }
    }, { tag: ALBUM_TAG, brokenBack });
    return { page, frame: page, expect };
  }
  test('real Chromium mobile DOM navigation follows keyboard anchors, exact IDs and detail/back focus', async t => {
    const manager = await fixture(t), observed = await exerciseNavigationView(manager, operation => operation());
    assert.deepEqual(observed.keyboard_anchors, ['tags','drafts','music','publication','playback','connections','recovery']);
    const viewport = await observeNavigationViewport(manager.frame); assert.equal(viewport.width, 390); assert.ok(viewport.scroll_height > viewport.height);
  });
  test('real Chromium navigation refuses a visible back button that loses keyboard focus', async t => {
    const manager = await fixture(t, { brokenBack: true });
    await assert.rejects(exerciseNavigationView(manager, operation => operation()));
  });
}
