/** Local synthetic controls, never native HA OS acceptance evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerReadGate, assessManagerRows, assessManagerConnection, assessManagerPublication,
  assessManagerPlayback, assessManagerInbox, parseManagerBody, assertManagerList, managerConnectionVersionText } from './browser_manager_readonly.mjs';
import { ALBUM_TAG, PLAYLIST_TAG, ALBUM_URI, PLAYLIST_URI } from './browser_manager.mjs';
import { hash, LOCAL_ORIGIN } from './browser_inputs.mjs';

export function savedRows() {
  return [ALBUM_TAG, PLAYLIST_TAG].map((id, i) => ({ tag_key: hash(id), ha_tag_id: id,
    spotify_uri: i ? PLAYLIST_URI : ALBUM_URI, media_type: i ? 'playlist' : 'album',
    enabled: true, shuffle: !!i, playback_profile_id: 'default', version: i ? 5 : 9,
    updated_at: '2026-11-01T00:00:00Z' }));
}
function snapshot() {
  const assignments = { revision: 13, total: 2, assignments: savedRows() };
  const inventory = { total: 2, registry_available: true, stale: false, discovery_gap: false,
    updated_at: '2026-11-01T00:00:00Z', tags: assignments.assignments.map(row => ({
      tag_key: row.tag_key, ha_tag_id: row.ha_tag_id, name: 'Synthetic label',
      saved_assignment: structuredClone(row), state: 'registered', last_scanned: null, last_reader: null })) };
  return { assignments, inventory };
}
test('joined snapshot distinguishes global revision13 from album row9 and preserves exact opaque IDs', () => {
  const value = snapshot();
  assert.doesNotThrow(() => assessManagerRows(value));
  for (const change of [v => { v.assignments.revision = 9; },
    v => { v.assignments.assignments[0].ha_tag_id = ALBUM_TAG.trim(); },
    v => { v.inventory.tags[0].saved_assignment.version = 13; },
    v => { v.assignments.assignments[1].shuffle = false; }]) {
    const invalid = snapshot(); change(invalid); assert.throws(() => assessManagerRows(invalid));
  }
});

test('bounded JSON rejects malformed, HTML, wrong UTF8, oversized and duplicate decoded keys at each object depth', () => {
  assert.deepEqual(parseManagerBody(Buffer.from('{"tags":[{"id":"Å{}[]"}],"revision":13}')), { tags: [{ id: 'Å{}[]' }], revision: 13 });
  for (const raw of ['null', '[]', '{', '<html>denied</html>', '{"revision":9,"revision":13}',
    '{"nested":{"revision":9,"revis\\u0069on":13}}', '['.repeat(33) + '0' + ']'.repeat(33)]) {
    assert.throws(() => parseManagerBody(Buffer.from(raw)));
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(65537), Buffer.from([0xff]), 'not a buffer']) assert.throws(() => parseManagerBody(bytes));
  assert.deepEqual(parseManagerBody(Buffer.from('{"a":{"x":1},"b":{"x":2}}')), { a: { x: 1 }, b: { x: 2 } });
});

const prefix = '/api/hassio_ingress/SYNTHETIC_PREFIX/';
function admit(f, request, scope) { f.gate.started(request); return f.gate.allow(request, scope); }
function fixtureGate() {
  let valid = true;
  const browser = {}, context = { browser: () => browser }, page = { context: () => context, isClosed: () => false };
  const frame = { page: () => page, isDetached: () => false, url: () => LOCAL_ORIGIN + prefix };
  const binding = { browser, context, page, frame, prefix, principalHash: hash('synthetic user'),
    expiresAt: new Date(Date.now() + 60000).toISOString(), verify: () => assert.equal(valid, true) };
  const scope = { fromFrame: true, prefix }, gate = new ManagerReadGate();
  const request = (endpoint, method = 'GET', data = null) => ({ url: () => LOCAL_ORIGIN + prefix + 'api/v1/' + endpoint,
    method: () => method, postData: () => data, failure: () => null, frame: () => frame });
  assert.equal(gate.allow(request('music/resolve', 'POST', JSON.stringify({ input: ALBUM_URI, media_type: 'album' })), scope), true);
  gate.bind(binding);
  const respond = (req, value, options = {}) => {
    const response = { request: () => req, url: () => req.url(), status: () => 200,
      headerValue: async () => 'application/json; charset=utf-8', body: async () => Buffer.from(JSON.stringify(value)), ...options };
    req.response = async () => response; return response;
  };
  return { gate, binding, scope, request, respond, invalidate: () => { valid = false; } };
}

test('fresh GET receipt needs actual matching request, query, frame, source and read phase; prior-view response is excluded', async () => {
  const f = fixtureGate(), stale = f.request('tags/inbox?view=observed&offset=0&limit=100');
  f.respond(stale, { total: 99 }); assert.equal(admit(f, stale, f.scope), true);
  const mark = f.gate.mark(), current = f.request('tags/inbox?view=unassigned&offset=0&limit=100');
  f.respond(current, { total: 0 }); assert.equal(admit(f, current, f.scope), true);
  const result = await f.gate.read('tags/inbox?view=unassigned&offset=0&limit=100', mark);
  assert.deepEqual(result.body, { total: 0 }); assert.equal(result.receipt.phase, mark); assert.equal(result.receipt.principal_source_bound, true);
  assert.equal(result.receipt.bounded_body, true); assert.equal(f.gate.evidence().reads, 1);
  const otherMark = f.gate.mark(); assert.notEqual(mark, otherMark);
  await assert.rejects(f.gate.read('tags/inbox?view=observed&offset=0&limit=100', mark));
  f.gate.close();
});

test('matching request is necessary: wrong query cannot satisfy fresh unassigned read even if its body is identical', async () => {
  const f = fixtureGate(), mark = f.gate.mark();
  const observed = f.request('tags/inbox?view=observed&offset=0&limit=100'); f.respond(observed, { total: 0 });
  assert.equal(admit(f, observed, f.scope), true);
  const waiting = f.gate.read('tags/inbox?view=unassigned&offset=0&limit=100', mark);
  let finished = false; waiting.then(() => { finished = true; }, () => { finished = true; });
  await new Promise(done => setTimeout(done, 35)); assert.equal(finished, false);
  const right = f.request('tags/inbox?view=unassigned&offset=0&limit=100'); f.respond(right, { total: 0 });
  assert.equal(admit(f, right, f.scope), true); assert.deepEqual((await waiting).body, { total: 0 }); f.gate.close();
});

test('a request held across a read mark cannot become fresh merely by later route admission', async () => {
  const f = fixtureGate(), old = f.request('status'); f.respond(old, { current: false }); f.gate.started(old);
  const mark = f.gate.mark(); assert.equal(f.gate.allow(old, f.scope), true);
  const waiting = f.gate.read('status', mark); let finished = false;
  waiting.then(() => { finished = true; }, () => { finished = true; });
  await new Promise(done => setTimeout(done, 35)); assert.equal(finished, false);
  const fresh = f.request('status'); f.respond(fresh, { current: true }); assert.equal(admit(f, fresh, f.scope), true);
  assert.deepEqual((await waiting).body, { current: true }); f.gate.close();
});

test('either SDK event delivery order needs both actual request-start and route admission', async () => {
  const f = fixtureGate(), mark = f.gate.mark(), request = f.request('status'); f.respond(request, { current: true });
  assert.equal(f.gate.allow(request, f.scope), true);
  const waiting = f.gate.read('status', mark); let finished = false;
  waiting.then(() => { finished = true; }, () => { finished = true; });
  await new Promise(done => setTimeout(done, 35)); assert.equal(finished, false);
  f.gate.started(request); assert.deepEqual((await waiting).body, { current: true }); f.gate.close();
});

test('a denied outer-route mutation is counted from its actual request event without inner admission', () => {
  const f = fixtureGate(), request = f.request('restores/confirm', 'POST', '{}');
  f.gate.started(request); f.gate.started(request);
  assert.equal(f.gate.evidence().unexpected_mutations, 1); assert.equal(f.gate.evidence().mutation_attempts, 2);
  assert.equal(f.gate.evidence().closed, true); assert.equal(f.gate.evidence().reads, 0);
});

test('a late body cannot produce a receipt after the real response-body deadline', async () => {
  const f = fixtureGate(), mark = f.gate.mark(), req = f.request('status'); let finish;
  f.respond(req, {}, { body: () => new Promise(done => { finish = done; }) }); assert.equal(admit(f, req, f.scope), true);
  await assert.rejects(f.gate.read('status', mark)); assert.equal(f.gate.evidence().closed, true); assert.equal(f.gate.evidence().reads, 0);
  finish(Buffer.from('{}')); await new Promise(done => setImmediate(done)); assert.equal(f.gate.evidence().reads, 0);
});

test('DOM list readiness awaits current rows and raw opaque-ID text rejects normalized or mismatched snapshots', async () => {
  const f = fixtureGate(), expected = snapshot().inventory.tags.map(tag => ({ ...tag.saved_assignment, name: tag.name }));
  let rows = [], calls = 0, readiness = false;
  const region = { locator: () => ({ evaluateAll: async callback => { calls += 1; return callback(rows); } }) };
  const elements = values => values.map(row => ({ querySelectorAll: () => [row.ha_tag_id, row.spotify_uri].map(textContent => ({ textContent })),
    querySelector: selector => ({ textContent: selector.includes('strong') ? row.name : 'Registered · Last scan: Not observed' }) }));
  const manager = { expect: { poll: read => ({ toEqual: async target => {
    if (!readiness) { assert.notDeepEqual(await read(), target); rows = elements(expected); readiness = true; }
    assert.deepEqual(await read(), target);
  } }) } };
  await assertManagerList(manager, f.gate, region, expected); assert.ok(calls >= 2);
  rows = elements(expected.map(row => ({ ...row, ha_tag_id: row.ha_tag_id.trim() })));
  await assert.rejects(assertManagerList(manager, f.gate, region, expected));
  rows = elements(expected.map(row => ({ ...row, spotify_uri: PLAYLIST_URI })));
  await assert.rejects(assertManagerList(manager, f.gate, region, expected)); f.gate.close();
});

test('wrong response method/url/request/frame/status/type/body and source expiry cannot create read evidence', async () => {
  for (const damage of [
    (f, req, res) => { res.request = () => f.request('status'); },
    (f, req, res) => { res.url = () => req.url() + '?other=1'; },
    (f, req) => { req.method = () => 'HEAD'; },
    (f, req) => { req.frame = () => ({}); },
    (f, req, res) => { res.status = () => 401; },
    (f, req, res) => { res.headerValue = async () => 'text/html'; },
    (f, req, res) => { res.body = async () => Buffer.from('<html>denied</html>'); },
    (f, req, res) => { res.body = async () => Buffer.alloc(65537); },
    (f, req, res) => { res.headerValue = async () => { f.invalidate(); return 'application/json'; }; },
    (f, req, res) => { res.body = async () => { f.invalidate(); return Buffer.from('{}'); }; },
    (f, req, res) => { res.body = async () => { f.gate.mark(); return Buffer.from('{}'); }; },
  ]) {
    const f = fixtureGate(), mark = f.gate.mark(), req = f.request('status'), res = f.respond(req, { connected: true });
    assert.equal(admit(f, req, f.scope), true); damage(f, req, res);
    await assert.rejects(f.gate.read('status', mark)); assert.equal(f.gate.evidence().reads, 0);
    assert.equal(f.gate.evidence().closed, true);
  }
});

test('source owner changes and all post-bootstrap mutation attempts fail closed even when not forwarded', () => {
  for (const change of [f => { f.binding.frame.url = () => LOCAL_ORIGIN + '/api/hassio_ingress/OTHER/'; },
    f => { f.binding.frame.page = () => ({}); }, f => { f.binding.page.context = () => ({}); },
    f => { f.binding.context.browser = () => ({}); }, f => { f.binding.frame.isDetached = () => true; },
    f => { f.binding.expiresAt = '2000-01-01T00:00:00Z'; }, f => f.invalidate()]) {
    const f = fixtureGate(); change(f); assert.throws(() => f.gate.mark()); assert.equal(f.gate.evidence().closed, true);
  }
  for (const [path, method] of [['tags/invalid/name', 'PATCH'], ['tags/invalid/assignment', 'PUT'], ['tags/invalid/assignment', 'DELETE'],
    ['restores/preview', 'POST'], ['restores/confirm', 'POST'], ['publication/review', 'POST'], ['publication/confirm', 'POST'], ['music/resolve', 'POST']]) {
    const f = fixtureGate(); assert.equal(admit(f, f.request(path, method, '{}'), f.scope), false);
    assert.equal(f.gate.evidence().unexpected_mutations, 1); assert.equal(f.gate.evidence().mutation_attempts, 2); assert.equal(f.gate.evidence().closed, true);
  }
  for (const scope of [{ fromFrame: false, prefix }, { fromFrame: true, prefix: '/api/hassio_ingress/OTHER/' }]) {
    const f = fixtureGate(); assert.equal(admit(f, f.request('status'), scope), false); assert.equal(f.gate.evidence().closed, true);
  }
});

function connection() { return { connection: 'connected', version: '2026.10.3', tag_list: 'supported', scan_subscription: 'supported', subscribed: true,
  services: Object.fromEntries(['get_album', 'get_playlist', 'get_album_favorites', 'get_playlist_favorites', 'search_albums', 'search_playlists'].map(name => [name, { state: 'supported' }])),
  inventory_stale: false, discovery_gap: false, inventory_updated_at: '2020-01-01T00:00:00Z', services_updated_at: '2020-01-01T00:00:00Z', error: null }; }
test('current Core connection is compared against the independently selected exact Root profile', () => {
  const value = connection(); value.version = '2026.11.0';
  assert.equal(assessManagerConnection(value, '2026.11.0').core_version, '2026.11.0');
  assert.throws(() => assessManagerConnection(value));
  assert.throws(() => assessManagerConnection(connection(), '2026.11.0'));
  assert.throws(() => assessManagerConnection(value, '2026.11.1'));
  assert.equal(managerConnectionVersionText('2026.11.0'), 'Home Assistant connected. Version 2026.11.0');
  assert.throws(() => managerConnectionVersionText('2026.11.1'));
});
test('connection snapshot uses source cache timestamps without inventing short age bounds; declarations are not executions', () => {
  assert.equal(assessManagerConnection(connection()).capabilities_executed, false);
  for (const damage of [v => { v.inventory_stale = true; }, v => { v.error = 'transport_error'; }, v => { v.version = '2026.10.4'; },
    v => { v.subscribed = false; }, v => { v.services.get_album.state = 'unsupported'; }, v => { v.inventory_updated_at = null; }]) {
    const v = connection(); damage(v); assert.throws(() => assessManagerConnection(v));
  }
});
function playback(now) { return { connection: 'connected', stale: false, error: null, checked_at: new Date(now).toISOString(), diagnostics: {
  diagnostics_version: 1, started_at: '2026-11-01T00:00:00Z', observed_at: new Date(now).toISOString(), dispatch_enabled: false,
  ready: false, busy: false, execution_uncertain: true, readiness_error: 'execution_uncertain', pause_reason: 'startup', last_scan_at: null,
  last_attempt: null, playback_verification: 'unavailable', diagnostics: [] } }; }
test('playback enforces actual production freshness for both observation clocks and preserves not-ready distinctions', () => {
  const now = Date.parse('2026-11-05T20:00:00Z'); assert.equal(assessManagerPlayback(playback(now), now).ready, false);
  for (const damage of [v => { v.checked_at = new Date(now - 30001).toISOString(); }, v => { v.diagnostics.observed_at = new Date(now + 5001).toISOString(); },
    v => { v.diagnostics.ready = true; }, v => { v.diagnostics.execution_uncertain = false; }, v => { v.diagnostics.last_attempt = {}; },
    v => { v.diagnostics.dispatch_enabled = true; }, v => { v.stale = true; }]) {
    const v = playback(now); damage(v); assert.throws(() => assessManagerPlayback(v, now));
  }
});
test('current empty inbox cannot certify populated observations or unknown membership', () => {
  const v = { registry_available: true, assignments_available: true, stale: false, discovery_gap: false, updated_at: '2026-11-01T00:00:00Z', tags: [], total: 0 };
  assert.equal(assessManagerInbox(v, 'observed').populated_observation_demonstrated, false);
  for (const damage of [x => { x.assignments_available = false; }, x => { x.tags = [{ ha_tag_id: ALBUM_TAG }]; x.total = 1; }, x => { x.stale = true; }]) {
    const x = structuredClone(v); damage(x); assert.throws(() => assessManagerInbox(x, 'unassigned'));
  }
});
test('publication requires current verified state rather than queue acknowledgement', () => {
  for (const value of [{}, { desired_version: 13, verified: false, jobs: [{ state: 'queued' }] }]) assert.throws(() => assessManagerPublication(value));
});

for (const stage of ['before-headers', 'after-headers']) test(`R24 confirmed UI cancellation selects only a current same-query successor: ${stage}`, async () => {
  const f = fixtureGate(), mark = f.gate.mark(), first = f.request('publication'), next = f.request('publication');
  const before = f.respond(first, {}); f.respond(next, { current: true });
  first.failure = () => ({ errorText: 'net::ERR_ABORTED' });
  if (stage === 'before-headers') first.response = async () => null;
  else before.body = async () => { throw new Error('SYNTHETIC_PRIVATE_ABORT'); };
  assert.equal(admit(f, first, f.scope), true); assert.equal(admit(f, next, f.scope), true);
  const found = await f.gate.read('publication', mark); assert.deepEqual(found.body, { current: true });
  assert.equal(found.receipt.candidates, 2); assert.equal(found.receipt.verified_cancellations, 1); assert.equal(found.receipt.raw_pending, 0);
  assert.ok(f.gate.evidence().read_diagnostics.some(row => row.stage.startsWith('cancel_'))); f.gate.close();
});
for (const kind of ['unknown-null', 'network-reset', '503', 'HTML', 'malformed', 'oversized', 'wrong-frame', 'source-loss', 'phase-loss',
  'headers-refused', 'body-refused', 'no-successor', 'hung-successor', 'eight-cancellations']) test(`R24 cancellation never masks ${kind}`, async () => {
  const f = fixtureGate(), mark = f.gate.mark(), first = f.request('publication'), response = f.respond(first, {});
  first.failure = () => ({ errorText: 'net::ERR_ABORTED' }); first.response = async () => null;
  let laterReads = 0;
  if (kind === 'unknown-null') first.failure = () => null;
  if (kind === 'network-reset') first.failure = () => ({ errorText: 'net::ERR_CONNECTION_RESET' });
  if (['503', 'HTML', 'malformed', 'oversized', 'headers-refused', 'body-refused'].includes(kind)) {
    first.response = async () => response;
    if (kind === '503') response.status = () => 503;
    if (kind === 'HTML') response.headerValue = async () => 'text/html';
    if (kind === 'malformed') response.body = async () => Buffer.from('{');
    if (kind === 'oversized') response.body = async () => Buffer.alloc(65537);
    if (kind === 'headers-refused') response.headerValue = async () => { throw new Error('SYNTHETIC_PRIVATE_HEADER'); };
    if (kind === 'body-refused') { first.failure = () => null; response.body = async () => { throw new Error('SYNTHETIC_PRIVATE_BODY'); }; }
  }
  assert.equal(admit(f, first, f.scope), true);
  if (kind === 'wrong-frame') first.frame = () => ({});
  if (kind === 'source-loss') first.response = async () => { f.invalidate(); return null; };
  if (kind === 'phase-loss') first.response = async () => { f.gate.mark(); return null; };
  if (kind === 'eight-cancellations') for (let i = 0; i < 7; i++) {
    const req = f.request('publication'); req.failure = () => ({ errorText: 'net::ERR_ABORTED' }); req.response = async () => null;
    assert.equal(admit(f, req, f.scope), true);
  }
  if (kind !== 'no-successor') {
    const req = f.request('publication'); f.respond(req, { current: true });
    const normal = req.response; req.response = () => { laterReads++; return kind === 'hung-successor' ? new Promise(() => {}) : normal(); };
    assert.equal(admit(f, req, f.scope), true);
  }
  await assert.rejects(f.gate.read('publication', mark, { timeoutMs: 35 })); assert.equal(f.gate.evidence().reads, 0);
  assert.equal(laterReads, kind === 'hung-successor' ? 1 : 0);
  const frozen = JSON.stringify(f.gate.evidence()); await new Promise(done => setTimeout(done, 30));
  assert.equal(JSON.stringify(f.gate.evidence()), frozen); assert.equal(frozen.includes('SYNTHETIC_PRIVATE'), false); f.gate.close();
});
test('R24 deadline prevents late body/cancellation from changing final evidence or selecting another response', async () => {
  const f = fixtureGate(), mark = f.gate.mark(), req = f.request('publication'), res = f.respond(req, {}); let release;
  res.body = () => new Promise(done => { release = done; }); assert.equal(admit(f, req, f.scope), true);
  await assert.rejects(f.gate.read('publication', mark, { timeoutMs: 20 })); const frozen = JSON.stringify(f.gate.evidence());
  req.failure = () => ({ errorText: 'net::ERR_ABORTED' }); release(Buffer.from('{}')); await new Promise(done => setTimeout(done, 30));
  assert.equal(JSON.stringify(f.gate.evidence()), frozen); assert.equal(f.gate.evidence().reads, 0);
});
