import assert from 'node:assert/strict';
import test from 'node:test';
import { VisibilityGate, assessVisibility } from './browser_visibility.mjs';
import { LOCAL_ORIGIN, hash } from './browser_inputs.mjs';

const prefix = '/api/hassio_ingress/SYNTHETIC/';
const user = 'a'.repeat(32);
const request = (path = 'publication', method = 'GET') => ({ url: () => LOCAL_ORIGIN + prefix + 'api/v1/' + path, method: () => method });
const bound = () => {
  const gate = new VisibilityGate(); gate.bind(prefix, hash(user), () => {}); return gate;
};

test('paused native visibility rejects every new private attempt but distinguishes older in-flight completion', () => {
  const gate = bound(), older = request();
  gate.started(older); gate.pause(); gate.finished(older);
  assert.equal(gate.evidence().prior_inflight_completions, 1);
  assert.equal(gate.evidence().unexpected_private_starts, 0);
  gate.started(request('status'));
  assert.equal(gate.evidence().unexpected_private_starts, 1);
  assert.equal(gate.allow(request(), { fromFrame: true, prefix }), false);
  assert.throws(() => gate.check());
});

const sessionBody = () => ({ authenticated: true, runtime: 'ingress', mode: 'manage', user_id: user,
  csrf_token: 'SYNTHETIC_SAME_CSRF', expires_at: new Date(Date.now() + 60000).toISOString() });
const checking = () => { const gate = bound(); gate.pause(); gate.beginCheck(); gate.started(request('session')); return gate; };

test('only an explicit fresh same-principal ingress manage session grants recovery; CSRF need not rotate', () => {
  const gate = checking();
  assert.equal(gate.acceptSession(sessionBody()).same_user, true);
  assert.equal(gate.evidence().fresh_session_verified, true);
  for (const damage of [v => { v.user_id = 'b'.repeat(32); }, v => { v.runtime = 'standalone'; },
    v => { v.mode = 'read_only'; }, v => { v.expires_at = new Date(0).toISOString(); },
    v => { v.authenticated = false; }, v => { v.csrf_token = ''; }]) {
    const rejected = checking(), value = sessionBody(); damage(value);
    assert.throws(() => rejected.acceptSession(value)); assert.equal(rejected.evidence().fresh_session_verified, false);
  }
  const missing = bound(); assert.throws(() => missing.acceptSession(sessionBody()));
  const duplicate = checking(); duplicate.started(request('session')); assert.throws(() => duplicate.acceptSession(sessionBody()));
});

test('mutations, wrong-frame reads and expired or closed source never recover authority', () => {
  const mutation = bound(); mutation.started(request('publication', 'POST'));
  assert.equal(mutation.evidence().mutation_attempts, 1); assert.throws(() => mutation.check());
  const foreign = bound(); assert.equal(foreign.allow(request(), { fromFrame: false, prefix }), false);
  const stale = new VisibilityGate(); let live = true;
  stale.bind(prefix, hash(user), () => { assert.equal(live, true); }); live = false;
  assert.throws(() => stale.pause()); assert.equal(stale.evidence().failure, 'visibility_source_expired');
  const closed = checking(); closed.fail('cleanup'); assert.throws(() => closed.acceptSession(sessionBody()));
});

test('real UA visibility requires both actual documents; mixed, missing and unknown values cannot pass', () => {
  assert.deepEqual(assessVisibility({ parent: 'hidden', iframe: 'hidden' }, 'hidden'), { parent: 'hidden', iframe: 'hidden' });
  for (const value of [{ parent: 'hidden', iframe: 'visible' }, { parent: 'visible' }, { parent: 'faked', iframe: 'faked' }]) {
    assert.throws(() => assessVisibility(value, 'hidden'));
  }
});

test('paused observation covers a full polling interval and rejects early timers or late source loss', async () => {
  const { observePausedInterval } = await import('./browser_visibility.mjs');
  let clock = 0, samples = 0;
  const options = { now: () => clock, wait: async milliseconds => { clock += milliseconds; } };
  const paused = () => { const gate = bound(); gate.pause(); return gate; };
  const result = await observePausedInterval(paused(), async () => { samples += 1; }, options);
  assert.ok(result.elapsed_ms >= 10000); assert.equal(samples, 2);
  await assert.rejects(observePausedInterval(paused(), async () => {}, { now: () => 0, wait: async () => {} }));
  const stale = paused();
  await assert.rejects(observePausedInterval(stale, async () => {}, { now: () => clock,
    wait: async milliseconds => { clock += milliseconds; stale.fail('cleanup'); } }));
});

test('document observations use only read-only visibility evaluations and reject source loss between documents', async () => {
  const { readNativeVisibility } = await import('./browser_visibility.mjs');
  const gate = bound(), calls = [];
  const document = state => ({ evaluate: async callback => {
    calls.push(callback.toString()); return state;
  } });
  assert.deepEqual(await readNativeVisibility({ page: document('hidden'), frame: document('hidden') }, gate),
    { parent: 'hidden', iframe: 'hidden' });
  assert.ok(calls.every(source => /^\(\) => document\.visibilityState$/.test(source)));
  let iframeRead = false;
  await assert.rejects(readNativeVisibility({ page: { evaluate: async () => { gate.close(); return 'hidden'; } },
    frame: { evaluate: async () => { iframeRead = true; return 'hidden'; } } }, gate));
  assert.equal(iframeRead, false);
});

test('a nonsettling native response header expires within the existing budget; late reply cannot read body or grant', async () => {
  const { readVisibilityResponse } = await import('./browser_visibility.mjs');
  const gate = checking(), frame = {}, url = LOCAL_ORIGIN + prefix + 'api/v1/session';
  let release, bodies = 0;
  const response = { url: () => url, request: () => ({ method: () => 'GET', frame: () => frame }), status: () => 200,
    headerValue: () => new Promise(done => { release = done; }), body: async () => { bodies += 1; return Buffer.from(JSON.stringify(sessionBody())); } };
  const started = performance.now();
  await assert.rejects(readVisibilityResponse(response, frame, url, 4096, gate), { code: 'native_deadline', operation: 'response_headers' });
  assert.ok(performance.now() - started >= 14000 && performance.now() - started < 20000);
  gate.close(); release('application/json'); await new Promise(done => setImmediate(done));
  assert.equal(bodies, 0); assert.equal(gate.evidence().fresh_session_verified, false);
  assert.throws(() => gate.acceptSession(sessionBody()));
});

test('saved-state response diagnostics stop at the precise failed boundary without retaining private values', async () => {
  const gate = bound(), evidence = {}, stages = [], frame = {}, url = LOCAL_ORIGIN + prefix + 'api/v1/session';
  const response = { url: () => url, request: () => ({ method: () => 'GET', frame: () => frame }), status: () => 200,
    headerValue: async () => 'text/html', body: async () => assert.fail('wrong type must never read a body') };
  const { readVisibilityResponse } = await import('./browser_visibility.mjs');
  await assert.rejects(readVisibilityResponse(response, frame, url, 4096, gate,
    { checkpoint: stage => stages.push(stage), evidence }));
  assert.equal(stages.at(-1), 'response_headers');
  assert.deepEqual(evidence, { response_url_bound: true, response_get: true, response_frame_bound: true, response_status_200: true });
  assert.equal(JSON.stringify(evidence).includes('SYNTHETIC'), false);
});

test('explicit-check failure classification emits fixed predicates without private error text', async () => {
  const { classifyVisibilityFailure } = await import('./browser_visibility.mjs');
  const error = new Error('PRIVATE_TOKEN_URL_SECRET locator.click: element intercepts pointer events and is outside of the viewport');
  error.name = 'TimeoutError'; const result = classifyVisibilityFailure(error);
  assert.equal(result.category, 'timeout'); assert.equal(result.pointer_intercepted, true); assert.equal(result.outside_viewport, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'), false);
  assert.equal(classifyVisibilityFailure({ message: 'x'.repeat(20000) }).message_predicates_available, false);
});

test('post-failure button inspection returns only read-only geometry predicates and fences late source loss', async () => {
  const { inspectCheckButton } = await import('./browser_visibility.mjs');
  const { runInNewContext } = await import('node:vm');
  const gate = bound();
  const element = { isConnected: true, disabled: false, contains: value => value === element,
    getBoundingClientRect: () => ({ x: 50, y: 50, width: 100, height: 40, right: 150, bottom: 90, left: 50, top: 50 }) };
  const button = { evaluate: async callback => JSON.parse(JSON.stringify(runInNewContext('(' + callback.toString() + ')(element)', {
    element, document: { visibilityState: 'visible', hasFocus: () => true, activeElement: element, elementFromPoint: () => element }, innerWidth: 800, innerHeight: 600,
  }))) };
  const result = await inspectCheckButton(button, gate);
  assert.deepEqual(result, { attached: true, document_visible: true, document_focused: true, button_focused: true, enabled: true, positive_rect: true,
    intersects_viewport: true, centre_in_viewport: true, centre_hits_button: true });
  assert.ok(Object.values(result).every(value => typeof value === 'boolean'));
  await assert.rejects(inspectCheckButton({ evaluate: async () => { gate.close(); return result; } }, gate));
});

// Synthetic public-locator protocol model. It uses real Node scheduling, not
// injected browser lifecycle/DOM or a mocked native acceptance verdict.
function inventoryProtocol({ hydrateAs = 'detail', identity = '  Jukelet62:Å/e\u0301 album  ', capacity = 2 } = {}) {
  let ready = false, selected = false, queries = 0, clicks = 0, firstRead;
  const firstQuery = new Promise(done => { firstRead = done; }), editor = {};
  const detail = { count: async () => { queries += 1; firstRead(); return ready && (hydrateAs === 'detail' || selected) ? 1 : 0; },
    locator: () => ({ textContent: async () => identity }), getByRole: () => editor };
  const rows = { count: async () => { queries += 1; return ready ? capacity : 0; }, nth: index => ({
    locator: () => ({ first: () => ({ textContent: async () => index === 0 ? identity : 'SYNTHETIC_OTHER_TAG' }) }),
    getByRole: () => ({ click: async () => { clicks += 1; selected = true; } }),
  }) };
  const inventory = { getByRole: () => detail, locator: () => rows };
  const expect = locator => ({ toBeVisible: async () => { assert.equal(locator, detail); assert.equal(await detail.count(), 1); } });
  expect.poll = (read, options) => ({ toBe: async wanted => {
    assert.deepEqual(options, { timeout: 5000 });
    const deadline = performance.now() + options.timeout;
    while (performance.now() < deadline) {
      if (await read() === wanted) return;
      await new Promise(done => setTimeout(done, 5));
    }
    throw new Error('synthetic_public_poll_timeout');
  } });
  return { manager: { frame: { getByRole: () => inventory }, expect }, editor, detail, rows, firstQuery,
    hydrate: () => { ready = true; }, counts: () => ({ queries, clicks }) };
}

test('delayed inventory rehydrates the exact cached detail before opening and preserves normal row selection', async () => {
  const { openAlbumEditor } = await import('./browser_visibility.mjs');
  for (const hydrateAs of ['detail', 'rows']) {
    const fixture = inventoryProtocol({ hydrateAs }), evidence = {}, stages = [];
    const pending = openAlbumEditor(fixture.manager, bound(), { checkpoint: value => stages.push(value), evidence });
    pending.catch(() => {}); await fixture.firstQuery; setImmediate(fixture.hydrate);
    assert.equal(await pending, fixture.editor);
    assert.equal(fixture.counts().clicks, hydrateAs === 'detail' ? 0 : 1);
    assert.equal(evidence.inventory_ready, true); assert.equal(evidence.detail_identity_matches, true);
  }
});

test('inventory readiness keeps exact target identity and the existing capacity bound', async () => {
  const { openAlbumEditor } = await import('./browser_visibility.mjs');
  for (const options of [{ hydrateAs: 'detail', identity: 'SYNTHETIC_WRONG_TARGET' },
    { hydrateAs: 'rows', identity: 'SYNTHETIC_WRONG_TARGET' }, { hydrateAs: 'rows', capacity: 101 }]) {
    const fixture = inventoryProtocol(options); fixture.hydrate();
    await assert.rejects(openAlbumEditor(fixture.manager, bound()));
    assert.equal(fixture.counts().clicks, 0);
  }
});

test('inventory readiness fences source loss after a read and late completion after cleanup', async () => {
  const { openAlbumEditor } = await import('./browser_visibility.mjs');
  const stale = inventoryProtocol(), gate = new VisibilityGate(); let live = true, rowReads = 0;
  gate.bind(prefix, hash(user), () => { assert.equal(live, true); });
  stale.detail.count = async () => { live = false; return 0; };
  stale.rows.count = async () => { rowReads += 1; return 2; };
  await assert.rejects(openAlbumEditor(stale.manager, gate));
  assert.equal(rowReads, 0); assert.equal(gate.evidence().failure, 'visibility_source_expired');
  assert.equal(stale.counts().clicks, 0);

  const late = inventoryProtocol(), closed = bound(); let finish, started;
  const reading = new Promise(done => { started = done; });
  late.detail.count = () => { started(); return new Promise(done => { finish = done; }); };
  const pending = openAlbumEditor(late.manager, closed); pending.catch(() => {});
  await reading; closed.close(); finish(1);
  await assert.rejects(pending); assert.equal(late.counts().clicks, 0);
});

test('never-ready inventory exhausts the five-second budget and late hydration cannot open an editor', async () => {
  const { openAlbumEditor } = await import('./browser_visibility.mjs');
  const fixture = inventoryProtocol(), evidence = {}, started = performance.now();
  await assert.rejects(openAlbumEditor(fixture.manager, bound(), { evidence }));
  assert.ok(performance.now() - started >= 4500 && performance.now() - started < 7000);
  assert.notEqual(evidence.inventory_ready, true); assert.equal(fixture.counts().clicks, 0);
  const before = fixture.counts(); fixture.hydrate(); await new Promise(done => setTimeout(done, 20));
  assert.deepEqual(fixture.counts(), before);
});
