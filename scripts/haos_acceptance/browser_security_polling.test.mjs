/** Opt-in installed Chromium regressions; synthetic about:blank scope, no HA or network. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from '../../frontend/node_modules/@playwright/test/index.mjs';
import { hash } from './browser_inputs.mjs';
import { SecurityGuard, waitForDeniedPrincipal } from './browser_security.mjs';

const user = '1'.repeat(32), userHash = hash(user);
const expected = { outcome: 'PASS', user_id_sha256: userHash, is_admin: false, connected: true };
const argument = { expected_user_id_sha256: userHash };
const sidebar = { rendered: true, visible_navigation_links: true, dedicated_jukelet_link_absent: true };
const delay = ms => new Promise(done => setTimeout(done, ms));
let browser;
before(async () => { browser = await chromium.launch({ headless: true, timeout: 15000 }); });
after(async () => { if (browser) await browser.close(); });

// Exercise the production polling function through actual Playwright methods.
// Only the public HA observation scope is synthetic; the blank page stays blank.
const inspectScope = ({ source, value }) => {
  globalThis.principalObservations += 1;
  return (0, eval)('(' + source + ')')(value, globalThis.principalScope);
};
function scopedPage(page) {
  return {
    waitForFunction: (callback, value, options) => page.waitForFunction(inspectScope, { source: callback.toString(), value }, options),
    evaluate: (callback, value) => page.evaluate(inspectScope, { source: callback.toString(), value }),
  };
}

async function blankPage(t) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let http = 0, websocket = 0;
  await context.route('**/*', route => { http += 1; return route.abort(); });
  await context.routeWebSocket('**', socket => { websocket += 1; return socket.close(); });
  const page = await context.newPage();
  t.after(async () => {
    try {
      assert.equal(page.url(), 'about:blank');
      assert.deepEqual(await context.cookies(), []);
    } finally { await context.close(); }
    assert.equal(http, 0); assert.equal(websocket, 0);
  });
  await page.evaluate(({ digest }) => {
    globalThis.principalObservations = 0;
    globalThis.principalElement = null;
    globalThis.principalScope = {
      location: { origin: 'https://127.0.0.1:18223' },
      document: { querySelector: () => globalThis.principalElement },
      crypto: { subtle: { digest: async () => new Uint8Array(digest).buffer } },
    };
  }, { digest: [...Buffer.from(userHash, 'hex')] });
  return page;
}

async function ready(page, changes = {}) {
  await page.evaluate(({ user, changes }) => {
    globalThis.principalElement = { tagName: 'HOME-ASSISTANT', hass: {
      connected: true, connection: { connected: true }, user: { id: user, is_admin: false, ...changes },
    } };
  }, { user, changes });
}

function heldRequest(verify = () => {}) {
  const prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
  const parent = { parentFrame: () => null }, child = { parentFrame: () => parent }, actions = [];
  const guard = new SecurityGuard('security-denied', { ingress_prefix: prefix, denied_user_id_sha256: userHash }, verify);
  guard.native.bindParent(parent); guard.native.armIngress();
  const request = { frame: () => child, url: () => 'https://127.0.0.1:18223' + prefix, method: () => 'GET',
    resourceType: () => 'document', isNavigationRequest: () => true,
    allHeaders: async () => ({ cookie: 'ingress_session=SYNTHETIC_OWN_COOKIE' }) };
  const pending = guard.handle({ request: () => request, abort: () => { actions.push('abort'); }, continue: () => { actions.push('continue'); } });
  return { guard, actions, pending };
}

test('actual Playwright polling awaits unready then ready public HA observation', async t => {
  const page = await blankPage(t);
  const result = waitForDeniedPrincipal(scopedPage(page), argument, { timeoutMs: 1500 });
  await page.waitForFunction(() => globalThis.principalObservations >= 1, undefined, { timeout: 1000 });
  await ready(page);
  assert.deepEqual(await result, expected);
  assert.ok(await page.evaluate(() => globalThis.principalObservations >= 2));
});

test('actual Playwright observation awaits its identity digest without overlapping polls', async t => {
  const page = await blankPage(t); await ready(page);
  await page.evaluate(() => {
    const digest = globalThis.principalScope.crypto.subtle.digest;
    globalThis.principalScope.crypto.subtle.digest = () => new Promise(done => { globalThis.finishDigest = () => done(digest()); });
  });
  let settled = false;
  const result = waitForDeniedPrincipal(scopedPage(page), argument, { timeoutMs: 1500 }).finally(() => { settled = true; });
  await page.waitForFunction(() => typeof globalThis.finishDigest === 'function', undefined, { timeout: 1000 });
  await delay(150);
  assert.equal(settled, false); assert.equal(await page.evaluate(() => globalThis.principalObservations), 1);
  await page.evaluate(() => globalThis.finishDigest());
  assert.deepEqual(await result, expected);
});

for (const [name, changes, value, origin, outcome] of [
  ['administrator role', { is_admin: true }, argument, null, 'AUTH_DENIED'],
  ['malformed identity', { id: 'SYNTHETIC_INVALID_USER' }, argument, null, 'AUTH_DENIED'],
  ['different receipt identity', {}, { expected_user_id_sha256: '0'.repeat(64) }, null, 'AUTH_DENIED'],
  ['wrong context origin', {}, argument, 'https://example.invalid', 'INVALID_CONTEXT'],
  ['invalid observation input', {}, { ...argument, extra: true }, null, 'INVALID_CONTEXT'],
]) {
  test(`actual Playwright polling terminates on ${name} without retry`, async t => {
    const page = await blankPage(t); await ready(page, changes);
    if (origin) await page.evaluate(origin => { globalThis.principalScope.location.origin = origin; }, origin);
    assert.deepEqual(await waitForDeniedPrincipal(scopedPage(page), value, { timeoutMs: 1500 }), { outcome });
    assert.equal(await page.evaluate(() => globalThis.principalObservations), 1);
  });
}

test('actual Playwright observation errors terminate without retry', async t => {
  const page = await blankPage(t); await ready(page);
  await page.evaluate(() => { globalThis.principalScope.crypto.subtle.digest = async () => { throw new Error('synthetic_digest_failure'); }; });
  await assert.rejects(waitForDeniedPrincipal(scopedPage(page), argument, { timeoutMs: 1500 }), { code: 'native_operation_failed' });
  assert.equal(await page.evaluate(() => globalThis.principalObservations), 1);
});

test('persistent initialization false reaches the bounded deadline and fences before cleanup', async t => {
  const page = await blankPage(t), held = heldRequest(), events = [];
  try {
    await assert.rejects(waitForDeniedPrincipal(scopedPage(page), argument, { timeoutMs: 250, notify: event => events.push(event) }), { code: 'native_deadline' });
    assert.equal(held.guard.pending.size, 1); assert.equal(held.guard.forwarded, 0); assert.deepEqual(held.actions, []);
    assert.deepEqual(events.map(value => value.checkpoint), ['begin', 'timeout']);
    const observations = await page.evaluate(() => globalThis.principalObservations);
    assert.ok(observations >= 2);
    await delay(150); assert.equal(await page.evaluate(() => globalThis.principalObservations), observations);
  } finally {
    held.guard.fence(); assert.deepEqual(held.actions, ['abort']);
    await held.guard.drain(); await held.pending;
  }
  assert.equal(held.guard.pending.size, 0); assert.equal(held.guard.forwarded, 0);
});

test('late successful observation after timeout cannot resume polling or release a fenced request', async t => {
  const page = await blankPage(t); await ready(page);
  await page.evaluate(() => {
    const digest = globalThis.principalScope.crypto.subtle.digest;
    globalThis.principalScope.crypto.subtle.digest = () => new Promise(done => { globalThis.finishDigest = () => done(digest()); });
  });
  const held = heldRequest();
  try {
    const rejected = assert.rejects(waitForDeniedPrincipal(scopedPage(page), argument, { timeoutMs: 250 }), { code: 'native_deadline' });
    await page.waitForFunction(() => typeof globalThis.finishDigest === 'function', undefined, { timeout: 1000 });
    await rejected;
  } finally {
    held.guard.fence(); assert.deepEqual(held.actions, ['abort']);
    await held.guard.drain(); await held.pending;
  }
  await page.evaluate(() => globalThis.finishDigest()); await delay(150);
  assert.equal(await page.evaluate(() => globalThis.principalObservations), 1);
  assert.throws(() => held.guard.release(expected, sidebar));
  assert.equal(held.guard.pending.size, 0); assert.equal(held.guard.forwarded, 0);
});

test('readiness observation cannot bypass expired receipt verification before releasing the request', async t => {
  const page = await blankPage(t); await ready(page);
  let current = true;
  const held = heldRequest(() => assert.equal(current, true));
  try {
    const principal = await waitForDeniedPrincipal(scopedPage(page), argument, { timeoutMs: 1500 });
    current = false;
    assert.throws(() => held.guard.release(principal, sidebar));
    assert.equal(held.guard.forwarded, 0); assert.deepEqual(held.actions, []);
  } finally {
    held.guard.fence(); assert.deepEqual(held.actions, ['abort']);
    await held.guard.drain(); await held.pending;
  }
});
