/** Synthetic observable controls; not actual HA OS/browser evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPopulatedInbox } from './browser_inbox.mjs';
import { ALBUM_TAG, PLAYLIST_TAG, ALBUM_URI, PLAYLIST_URI } from './browser_manager.mjs';
import { hash } from './browser_inputs.mjs';
const now = Date.parse('2026-11-06T16:00:00Z'), INBOX = 'Jukelet62:observed-only', READER = 'Jukelet62 synthetic reader';
function state() {
  const assignments = { revision: 13, total: 2, assignments: [ALBUM_TAG, PLAYLIST_TAG].map((id, i) => ({
    tag_key: hash(id), ha_tag_id: id, spotify_uri: i ? PLAYLIST_URI : ALBUM_URI, media_type: i ? 'playlist' : 'album',
    enabled: true, shuffle: !!i, playback_profile_id: 'default', version: i ? 5 : 9, updated_at: new Date(now - 100000).toISOString() })) };
  const inventory = { total: 3, registry_available: true, stale: false, discovery_gap: false, updated_at: new Date(now).toISOString(),
    tags: assignments.assignments.map(row => ({ tag_key: row.tag_key, ha_tag_id: row.ha_tag_id, name: 'Synthetic Å label',
      saved_assignment: structuredClone(row), state: 'registered', last_scanned: null, last_reader: null, observed_at: null, observed_reader: null })) };
  inventory.tags.push({ tag_key: hash(INBOX), ha_tag_id: INBOX, name: null, saved_assignment: null, state: 'registered',
    last_scanned: new Date(now - 1000).toISOString(), last_reader: READER, observed_at: new Date(now - 1000).toISOString(), observed_reader: READER });
  const { saved_assignment: omitted, ...tag } = inventory.tags[2]; assert.equal(omitted, null);
  const body = { tags: [{ ...tag, local_assignment: 'unassigned' }], total: 1, registry_available: true, stale: false,
    updated_at: new Date(now).toISOString(), discovery_gap: false, assignments_available: true };
  return { inventory, assignments, body };
}
test('populated observed inbox joins exact new ID, reader and independent complete membership without changing old empty contract', () => {
  const v = state(), result = assessPopulatedInbox(v.body, 'observed', v, now);
  assert.equal(result.populated_observation_demonstrated, true); assert.equal(result.total, 1);
  assert.equal(result.inbox_tag_key, hash(INBOX)); assert.equal(result.state, 'registered');
});

import { assessInboxMembership, assertInboxList, assertInboxDetail, exercisePopulatedInbox } from './browser_inbox.mjs';
import { ManagerReadGate, assessManagerInbox, parseManagerBody } from './browser_manager_readonly.mjs';
import { LOCAL_ORIGIN } from './browser_inputs.mjs';
for (const view of ['unassigned', 'observed']) test(`actual registry state is independent of opaque label and membership: ${view}`, () => {
  const v = state(); v.inventory.tags[2].state = v.body.tags[0].state = 'pending_discovery';
  v.inventory.tags[2].last_scanned = v.body.tags[0].last_scanned = new Date(now - 500).toISOString();
  v.inventory.tags[2].last_reader = v.body.tags[0].last_reader = null;
  const result = assessPopulatedInbox(v.body, view, v, now);
  assert.equal(result.state, 'pending_discovery'); assert.notEqual(result.inventory_last_scanned, result.observed_at);
  assert.throws(() => assessManagerInbox(v.body, view));
});
for (const [label, damage] of Object.entries({
  missing_registry: v => { v.body.registry_available = false; }, stale: v => { v.body.stale = true; },
  gap: v => { v.body.discovery_gap = true; }, unknown_membership: v => { v.body.assignments_available = false; },
  unknown_row_membership: v => { v.body.tags[0].local_assignment = 'unknown'; }, duplicate: v => { v.body.tags.push(v.body.tags[0]); v.body.total++; },
  row_mismatch: v => { v.body.tags[0].name = 'stale name'; }, ID_repaired: v => { v.inventory.tags[0].ha_tag_id = ALBUM_TAG.trim(); },
  wrong_reader: v => { v.inventory.tags[2].observed_reader = v.body.tags[0].observed_reader = READER + ' '; },
  stale_observation: v => { v.inventory.tags[2].observed_at = v.body.tags[0].observed_at = new Date(now - 300001).toISOString(); },
  future_observation: v => { v.inventory.tags[2].observed_at = v.body.tags[0].observed_at = new Date(now + 5001).toISOString(); },
  no_observation: v => { v.inventory.tags[2].observed_at = v.body.tags[0].observed_at = null; },
  third_saved: v => { v.inventory.tags[2].saved_assignment = v.assignments.assignments[0]; },
  missing_inventory: v => { v.inventory.tags.pop(); v.inventory.total--; },
  extra_inventory: v => { v.inventory.tags.push({ ...v.inventory.tags[2], ha_tag_id: 'extra', tag_key: hash('extra') }); v.inventory.total++; },
  duplicate_inventory: v => { v.inventory.tags[1] = v.inventory.tags[0]; },
  row_version: v => { v.assignments.assignments[0].version = 13; }, global_revision: v => { v.assignments.revision = 9; },
  shuffled: v => { v.assignments.assignments[0].shuffle = true; }, malformed_state: v => { v.inventory.tags[2].state = 'observed-only'; },
  fabricated_field: v => { v.body.tags[0].registry_scan_time = v.body.tags[0].observed_at; },
})) test(`populated adjudication fails closed: ${label}`, () => {
  const v = state(); damage(v); assert.throws(() => assessPopulatedInbox(v.body, 'unassigned', v, now));
});
test('disabled nondeleted saved draft remains assigned across complete membership', () => {
  const v = state(); v.assignments.assignments[0].enabled = false; v.inventory.tags[0].saved_assignment.enabled = false;
  const proof = assessInboxMembership(v.body, 'unassigned', v);
  assert.equal(proof.disabled_saved_rows, 1); assert.equal(proof.disabled_saved_exclusion_demonstrated, true);
  const { saved_assignment: omitted, ...tag } = v.inventory.tags[0]; assert.equal(omitted.enabled, false);
  v.body.tags.push({ ...tag, local_assignment: 'unassigned' }); v.body.total++;
  assert.throws(() => assessInboxMembership(v.body, 'unassigned', v));
});
test('native current fixture does not claim an actual disabled saved row when none exists', () => {
  const v = state(), proof = assessPopulatedInbox(v.body, 'unassigned', v, now);
  assert.equal(proof.disabled_saved_rows, 0); assert.equal(proof.disabled_saved_exclusion_demonstrated, false);
});
test('bounded production parser rejects malformed, duplicate decoded row keys and invalid UTF8 before adjudication', () => {
  for (const bytes of [Buffer.from('{'), Buffer.from('<html>denied</html>'), Buffer.from([255]), Buffer.alloc(65537),
    Buffer.from('{"tags":[{"observed_at":null,"observed_\\u0061t":"2026-11-06T16:00:00Z"}]}')]) assert.throws(() => parseManagerBody(bytes));
  const v = state(); assert.doesNotThrow(() => assessPopulatedInbox(parseManagerBody(Buffer.from(JSON.stringify(v.body))), 'observed', v, now));
});

const prefix = '/api/hassio_ingress/SYNTHETIC_INBOX/';
function gateFixture() {
  let valid = true;
  const browser = {}, context = { browser: () => browser }, page = { context: () => context, isClosed: () => false };
  const frame = { page: () => page, isDetached: () => false, url: () => LOCAL_ORIGIN + prefix };
  const binding = { browser, context, page, frame, prefix, principalHash: hash('synthetic admin'),
    expiresAt: new Date(Date.now() + 60000).toISOString(), verify: () => assert.equal(valid, true) };
  const gate = new ManagerReadGate(), scope = { fromFrame: true, prefix };
  const request = (endpoint, method = 'GET', postData = null) => ({ url: () => LOCAL_ORIGIN + prefix + 'api/v1/' + endpoint,
    method: () => method, frame: () => frame, postData: () => postData, failure: () => null });
  assert.equal(gate.allow(request('music/resolve', 'POST', JSON.stringify({ input: ALBUM_URI, media_type: 'album' })), scope), true);
  gate.bind(binding);
  function emit(endpoint, body, options = {}) {
    const req = request(endpoint), res = { request: () => req, url: () => req.url(), status: () => 200,
      headerValue: async () => 'application/json', body: async () => Buffer.from(JSON.stringify(body)), ...options };
    req.response = async () => res; gate.started(req); assert.equal(gate.allow(req, scope), true); return { req, res };
  }
  return { gate, binding, scope, request, emit, invalidate: () => { valid = false; } };
}
test('prior view, wrong query and old phase cannot satisfy current inbox read even with identical body', async () => {
  const f = gateFixture(), v = state();
  f.emit('tags/inbox?view=unassigned&offset=0&limit=100', { ...v.body, total: 99 });
  const mark = f.gate.mark();
  f.emit('tags/inbox?view=observed&offset=0&limit=100', v.body);
  f.emit('tags/inbox?view=unassigned&limit=100&offset=0', v.body);
  let finished = false;
  const pending = f.gate.read('tags/inbox?view=unassigned&offset=0&limit=100', mark).then(value => { finished = true; return value; });
  await new Promise(done => setTimeout(done, 30)); assert.equal(finished, false);
  f.emit('tags/inbox?view=unassigned&offset=0&limit=100', v.body);
  const found = await pending; assert.equal(found.receipt.exact_query, true); assessPopulatedInbox(found.body, 'unassigned', v, now);
  f.gate.close();
});
for (const kind of ['frame', 'principal', 'body-after-close', 'phase-change', 'status', 'HTML']) test(`inbox response gate rejects ${kind}`, async () => {
  const f = gateFixture(), mark = f.gate.mark(), { req, res } = f.emit('tags/inbox?view=observed&offset=0&limit=100', state().body);
  if (kind === 'frame') req.frame = () => ({});
  if (kind === 'principal') f.invalidate();
  if (kind === 'body-after-close') res.body = async () => { f.gate.close(); return Buffer.from(JSON.stringify(state().body)); };
  if (kind === 'phase-change') res.body = async () => { f.gate.mark(); return Buffer.from(JSON.stringify(state().body)); };
  if (kind === 'status') res.status = () => 401;
  if (kind === 'HTML') res.headerValue = async () => 'text/html';
  await assert.rejects(f.gate.read('tags/inbox?view=observed&offset=0&limit=100', mark)); assert.equal(f.gate.evidence().reads, 0);
});
for (const [endpoint, method] of [['tags/anything/name', 'PATCH'], ['tags/anything/assignment', 'PUT'], ['restores/preview', 'POST'],
  ['publication/review', 'POST'], ['music/resolve', 'POST'], ['jukelet_acceptance/control', 'POST']]) test(`inbox has no post-bootstrap write grant: ${method} ${endpoint}`, () => {
  const f = gateFixture(), req = f.request(endpoint, method, '{}'); f.gate.started(req);
  assert.equal(f.gate.allow(req, f.scope), false); assert.equal(f.gate.evidence().unexpected_mutations, 1);
});

function element({ name, id, paragraphs, codes }) {
  return { querySelector: selector => ({ textContent: selector.endsWith('strong') || selector.endsWith('h4') ? name : id }),
    querySelectorAll: selector => (selector === ':scope > p' ? paragraphs : codes).map(textContent => ({ textContent })) };
}
function uiFixture(v = state()) {
  const f = gateFixture(), history = []; let view = 'unassigned', open = false, detail = false, renderedBody = v.body, warning = '', tamper = null;
  const check = target => ({
    async toBeEnabled() { assert.ok(target); },
    async toHaveCount(count) { assert.equal(target.kind === 'detail' ? Number(detail) : target.kind === 'inbox' ? Number(open) : 0, count); },
    async toHaveValue(value) { assert.equal(view, value); },
    async toContainText(text) { assert.ok(`Registry updated: ${new Date(renderedBody.updated_at).toLocaleString()}.`.includes(text)); },
    not: { async toContainText(text) { assert.equal(warning.includes(text), false); } },
  });
  check.poll = operation => ({ async toEqual(expected) { assert.deepEqual(await operation(), expected); } });
  const getBody = () => structuredClone(renderedBody);
  const refresh = () => f.emit(`tags/inbox?view=${view}&offset=0&limit=100`, getBody());
  const control = name => ({ kind: name,
    async click() {
      history.push(name);
      if (name === 'Refresh saved drafts') { f.emit('assignments?offset=0&limit=100', v.assignments); f.emit('recovery', { reconciliation_required: false }); }
      else if (name === 'Add tag / unassigned inbox') { open = true; view = 'unassigned'; refresh(); }
      else if (name === 'Refresh discovery') refresh();
      else if (name.startsWith('Choose discovered tag ')) detail = true;
      else if (name === 'Back to discoveries') detail = false;
      else if (name === 'Close onboarding') open = false;
      else assert.fail('unapproved UI action ' + name);
    },
    async selectOption(value) { view = value; history.push('select:' + value); refresh(); },
  });
  function section(kind) {
    return { kind,
      getByRole: (role, options = {}) => role === 'alert' ? { kind: 'alert' } : control(options.name),
      getByLabel: () => control('Discovery view'),
      locator: () => ({ evaluateAll: async callback => {
        const row = getBody().tags[0], label = row.state === 'registered' ? 'Registered tag' : 'Pending registry discovery';
        const rendered = { name: row.name ?? 'Unnamed tag', id: row.ha_tag_id,
          paragraphs: [label, 'No local assignment', `Observed by this app: ${new Date(row.observed_at).toLocaleString()} · Reader: ${row.observed_reader}`], codes: [row.ha_tag_id, row.observed_reader] };
        if (tamper) tamper(rendered);
        return callback([element(rendered)]);
      } }),
      evaluateAll: async callback => {
        const row = getBody().tags[0], rendered = { name: row.name ?? 'Unnamed tag', id: row.ha_tag_id,
          paragraphs: [row.state === 'registered' ? 'Registered tag' : 'Pending registry discovery', 'No local assignment',
            'Assignment editing is separate in tag detail. This onboarding flow does not save assignments or publish playback.'], codes: [row.ha_tag_id] };
        if (tamper) tamper(rendered); return callback(detail ? [element(rendered)] : []);
      },
    };
  }
  const frame = f.binding.frame;
  frame.evaluate = async (callback, values) => callback(values);
  frame.getByRole = (role, options) => section(options.name === 'Discovered tag' ? 'detail' : options.name === 'Tag onboarding' ? 'inbox' : options.name);
  const mark = f.gate.mark.bind(f.gate);
  f.gate.mark = () => { const result = mark(); queueMicrotask(() => {
    f.emit('tags?offset=0&limit=100', v.inventory);
    f.emit('status', { connection: 'connected', version: '2026.10.3', tag_list: 'supported', scan_subscription: 'supported', subscribed: true,
      inventory_stale: false, discovery_gap: false, error: null, inventory_updated_at: new Date(now).toISOString(), services_updated_at: new Date(now).toISOString(),
      services: Object.fromEntries(['get_album', 'get_playlist', 'get_album_favorites', 'get_playlist_favorites', 'search_albums', 'search_playlists'].map(name => [name, { state: 'supported' }])) });
  }); return result; };
  return { ...f, manager: { frame, expect: check }, region: section('inbox'), detail: section('detail'), history,
    choose: () => { detail = true; }, tamper: value => { tamper = value; }, warning: value => { warning = value; },
    updateBody: body => { renderedBody = body; } };
}
test('ordinary inbox UI traverses both fresh views/refresh/detail/back/close without saving or scanning', async () => {
  const f = uiFixture(), evidence = {};
  await exercisePopulatedInbox(f.manager, f.gate, evidence, () => {}, '2026.10.3', now);
  assert.deepEqual(f.history, ['Refresh saved drafts', 'Add tag / unassigned inbox', 'Refresh discovery', 'select:observed', 'Refresh discovery',
    'select:unassigned', 'Choose discovered tag Unnamed tag', 'Refresh discovery', 'Back to discoveries', 'Refresh discovery', 'Close onboarding', 'Refresh saved drafts']);
  assert.equal(Object.keys(evidence.views).length, 7); assert.equal(evidence.local_navigation.close, true);
  assert.equal(evidence.inbox_after.saved.global_revision, 13); assert.equal(f.gate.evidence().unexpected_mutations, 0); f.gate.close();
});
for (const [kind, tamper] of [['ID', row => { row.id += ' '; }], ['name', row => { row.name = 'previous name'; }],
  ['reader', row => { row.codes[1] = 'other reader'; }], ['time', row => { row.paragraphs[2] = 'previous scan'; }],
  ['membership', row => { row.paragraphs[1] = 'Disabled local draft (still assigned)'; }]]) test(`raw inbox DOM refuses stale or altered ${kind}`, async () => {
  const f = uiFixture(); f.tamper(tamper); await assert.rejects(assertInboxList(f.manager, f.gate, f.region, state().body)); f.gate.close();
});
test('detail identity and membership must match the current list, never a retained selection', async () => {
  const f = uiFixture(), row = state().body.tags[0]; f.choose();
  await assertInboxDetail(f.manager, f.gate, f.detail, row);
  f.tamper(value => { value.id = ALBUM_TAG; }); await assert.rejects(assertInboxDetail(f.manager, f.gate, f.detail, row));
  f.tamper(null); f.warning('Showing previous observed snapshot'); await assert.rejects(assertInboxList(f.manager, f.gate, f.region, state().body)); f.gate.close();
});
test('closure/source loss before a local action forbids subsequent UI work and late reads', async () => {
  const f = uiFixture(), evidence = {}; f.invalidate();
  await assert.rejects(exercisePopulatedInbox(f.manager, f.gate, evidence, () => {}, '2026.10.3', now)); assert.deepEqual(f.history, []);
  f.gate.close(); await assert.rejects(assertInboxList(f.manager, f.gate, f.region, state().body));
});

test('independent expected Core mismatch cannot be accepted from the actual status body', async () => {
  const f = uiFixture(); await assert.rejects(exercisePopulatedInbox(f.manager, f.gate, {}, () => {}, '2026.11.0', now));
  assert.equal(f.history.some(action => action === 'Add tag / unassigned inbox'), false); f.gate.close();
});

test('R26 actor never infers Core registry optional-field availability from its app DTO', () => {
  for (const lastScan of [null, new Date(now - 1000).toISOString()]) {
    const v = state(); v.inventory.tags[2].last_scanned = v.body.tags[0].last_scanned = lastScan;
    const proof = assessPopulatedInbox(v.body, 'observed', v, now);
    assert.equal(proof.core_registry_scan_time, 'NOT_QUERIED_BY_ACTOR');
  }
  const stale = state(); stale.inventory.tags[2].observed_at = stale.body.tags[0].observed_at = new Date(now - 300001).toISOString();
  assert.throws(() => assessPopulatedInbox(stale.body, 'observed', stale, now));
});
