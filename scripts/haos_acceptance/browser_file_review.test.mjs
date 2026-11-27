import assert from 'node:assert/strict';
import test from 'node:test';
import { FileReviewAuthority, FILE_REVIEW_BODY, FILE_REVIEW_JSON, FILE_REVIEW_BODY_SHA256 } from './browser_file_review.mjs';
import { ALBUM_TAG, PLAYLIST_TAG, ALBUM_URI, PLAYLIST_URI } from './browser_manager.mjs';
import { LOCAL_ORIGIN, hash } from './browser_inputs.mjs';

const prefix = '/api/hassio_ingress/SYNTHETIC_FILE/';
const user = 'a'.repeat(32), csrf = 'SYNTHETIC_CSRF_SAME_VALUE';
const session = () => ({ authenticated: true, runtime: 'ingress', mode: 'manage', user_id: user,
  csrf_token: csrf, expires_at: new Date(Date.now() + 3600000).toISOString() });
function fixture() {
  let clock = 0, live = true, windowPhase;
  const browser = {}, context = { browser: () => browser }, page = { context: () => context, isClosed: () => false };
  page.evaluate = async () => windowPhase === 'minimized' ? 'hidden' : 'visible';
  const frame = { page: () => page, isDetached: () => false, url: () => LOCAL_ORIGIN + prefix, evaluate: page.evaluate };
  const assignments = [ALBUM_TAG, PLAYLIST_TAG].map((id, index) => ({ tag_key: hash(id), ha_tag_id: id,
    spotify_uri: index ? PLAYLIST_URI : ALBUM_URI, media_type: index ? 'playlist' : 'album', enabled: true,
    shuffle: index === 1, playback_profile_id: 'default', version: index ? 5 : 9, updated_at: '2026-11-01T00:00:00Z' }));
  const binding = { browser, context, page, frame, prefix, principalHash: hash(user), session: session(),
    tags: assignments.map(value => ({ ha_tag_id: value.ha_tag_id, saved_assignment: value })),
    verify: () => assert.equal(live, true), window: () => ({ phase: windowPhase }) };
  const authority = new FileReviewAuthority(binding, { now: () => clock });
  const request = (endpoint = 'restores/preview', method = 'POST', body = FILE_REVIEW_BODY, token = csrf) => ({
    url: () => LOCAL_ORIGIN + prefix + 'api/v1/' + endpoint, method: () => method, postData: () => body,
    headers: () => ({ 'content-type': 'application/json', 'x-csrf-token': token }), frame: () => frame,
  });
  return { authority, binding, assignments, request, scope: { fromFrame: true, prefix },
    advance: milliseconds => { clock += milliseconds; }, expire: () => { live = false; }, window: value => { windowPhase = value; } };
}

test('the fixed source-owned synthetic body receives only one consumed preview grant', () => {
  const value = fixture(), request = value.request();
  assert.equal(hash(FILE_REVIEW_BODY), FILE_REVIEW_BODY_SHA256);
  assert.equal(JSON.parse(FILE_REVIEW_JSON).assignments.length, 2);
  value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview();
  assert.equal(value.authority.allowExternal(request, value.scope), true);
  assert.equal(value.authority.allowExternal(value.request(), value.scope), false);
});

function response(request, value, status = 200) {
  return { request: () => request, url: request.url, status: () => status,
    headerValue: async () => 'application/json', body: async () => Buffer.from(JSON.stringify(value)) };
}
const preview = value => ({ preview_token: value.repeat(43), local_revision: 13, accepted: 2, rejected: 0, conflicts: 2,
  rows: JSON.parse(FILE_REVIEW_JSON).assignments.map((source, index) => ({ row: index + 1, source, accepted: true, conflict: true, diagnostics: [] })) });
async function firstReviewed(value) {
  value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview(); const request = value.request();
  assert.equal(value.authority.allowExternal(request, value.scope), true);
  await value.authority.acceptPreview(response(request, preview('x'))); value.authority.finished(request);
}
async function checking(value) {
  await firstReviewed(value); value.authority.pause(); value.window('minimized'); await value.authority.observeHidden();
  value.advance(10250); value.window('restored'); await value.authority.observeRestored(); value.advance(10250); value.authority.beginRecheck();
}

test('two exact previews require the real lifecycle, a fresh same-user session and current saved reads', async () => {
  const value = fixture(); await checking(value);
  const sessionRequest = value.request('session', 'GET', null);
  const assignments = value.request('assignments?offset=0&limit=100', 'GET', null), recovery = value.request('recovery', 'GET', null);
  assert.equal(value.authority.allowExternal(sessionRequest, value.scope), true);
  assert.equal(value.authority.allowExternal(assignments, value.scope), true);
  assert.equal(value.authority.allowExternal(recovery, value.scope), true);
  await value.authority.bindFreshSession(response(sessionRequest, session()));
  await value.authority.bindFreshReads(response(assignments, { assignments: value.assignments, total: 2, revision: 13 }),
    response(recovery, { reconciliation_required: false }));
  value.authority.armPreview(); const second = value.request(); assert.equal(value.authority.allowExternal(second, value.scope), true);
  assert.equal((await value.authority.acceptPreview(response(second, preview('y')))).new_token, true);
  assert.equal(value.authority.evidence().preview_posts_forwarded, 2); assert.equal(value.authority.evidence().unapproved_mutations, 0);
  assert.equal(value.authority.evidence().session_check_starts, 1); value.authority.close();
});

test('the normal File input receives one labeled memory buffer and cannot be selected a second time', async () => {
  const { selectSyntheticFile, FILE_REVIEW_NAME } = await import('./browser_file_review.mjs');
  const value = fixture(), selected = [];
  const input = { setInputFiles: async payload => { selected.push(payload); } };
  const recovery = { getByLabel: () => input };
  const manager = { frame: { getByRole: () => recovery }, expect: () => ({ toBeVisible: async () => {}, toContainText: async () => {} }) };
  await selectSyntheticFile(manager, value.authority);
  await assert.rejects(selectSyntheticFile(manager, value.authority));
  assert.equal(selected.length, 1); assert.equal(selected[0].name, FILE_REVIEW_NAME);
  assert.equal(selected[0].mimeType, 'application/json'); assert.equal(selected[0].buffer.toString(), FILE_REVIEW_JSON);
});

test('an aborted wrong-scope mutation is counted even when its body is otherwise approved', () => {
  const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview();
  assert.equal(value.authority.allowExternal(value.request(), { fromFrame: false, prefix }), false);
  assert.equal(value.authority.evidence().unapproved_mutations, 1);
});

test('wrong body/hash/size, CSRF/type, method, endpoint, prefix and frame are denied and counted', () => {
  const damages = [request => ({ ...request, postData: () => FILE_REVIEW_BODY + ' ' }),
    request => ({ ...request, postData: () => 'x'.repeat(8193) }),
    request => ({ ...request, headers: () => ({ 'content-type': 'application/json', 'x-csrf-token': 'SYNTHETIC_WRONG' }) }),
    request => ({ ...request, headers: () => ({ 'content-type': 'text/plain', 'x-csrf-token': csrf }) }),
    request => ({ ...request, method: () => 'PUT' }),
    request => ({ ...request, url: () => LOCAL_ORIGIN + prefix + 'api/v1/restores/confirm' }),
    request => ({ ...request, url: () => LOCAL_ORIGIN + '/api/hassio_ingress/OTHER/api/v1/restores/preview' }),
    request => ({ ...request, frame: () => ({}) })];
  for (const damage of damages) {
    const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview();
    assert.equal(value.authority.allowExternal(damage(value.request()), value.scope), false);
    assert.equal(value.authority.evidence().unapproved_mutations, 1); assert.equal(value.authority.evidence().preview_posts_forwarded, 0);
    assert.throws(() => value.authority.armPreview());
  }
  for (const endpoint of ['publication/review', 'publication/confirm', 'restores/confirm', 'tags/SYNTHETIC/name', 'tags/SYNTHETIC/assignment']) {
    const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview();
    assert.equal(value.authority.allowExternal(value.request(endpoint), value.scope), false);
    assert.equal(value.authority.evidence().unapproved_mutations, 1);
  }
});

test('owner/principal/source, stage, single action deadline and cleanup are mandatory; grants cannot reset', async () => {
  const principal = fixture(); assert.throws(() => new FileReviewAuthority({ ...principal.binding, session: { ...session(), user_id: 'b'.repeat(32) } }));
  const frame = fixture(); frame.binding.frame.page = () => ({}); assert.throws(() => frame.authority.beginUpload());
  const early = fixture(); assert.throws(() => early.authority.armPreview());
  for (const expire of [value => value.expire(), value => value.advance(15000), value => value.authority.close()]) {
    const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview(); expire(value);
    assert.equal(value.authority.allowExternal(value.request(), value.scope), false); assert.equal(value.authority.evidence().preview_posts_forwarded, 0);
    assert.throws(() => value.authority.armPreview());
  }
  const noCycle = fixture(); await firstReviewed(noCycle); assert.throws(() => noCycle.authority.armPreview());
  const short = fixture(); await firstReviewed(short); short.authority.pause(); short.window('minimized'); await short.authority.observeHidden();
  short.advance(9999); short.window('restored'); await assert.rejects(short.authority.observeRestored());
});

test('paused attempts fail even when transport would abort them; old in-flight completions are distinct', async () => {
  const value = fixture(), older = value.request('status', 'GET', null);
  assert.equal(value.authority.allowExternal(older, value.scope), true); await firstReviewed(value);
  value.authority.pause(); value.authority.finished(older);
  assert.equal(value.authority.evidence().prior_inflight_completions, 1); assert.equal(value.authority.evidence().paused_new_starts, 0);
  assert.equal(value.authority.allowExternal(value.request('status', 'GET', null), value.scope), false);
  assert.equal(value.authority.evidence().paused_new_starts, 1); assert.equal(value.authority.evidence().unexpected_reads, 1);
});

async function fresh(value, changeSession = body => body, changePage = body => body, changeRecovery = body => body) {
  await checking(value);
  const sessionRequest = value.request('session', 'GET', null), page = value.request('assignments?offset=0&limit=100', 'GET', null), recovery = value.request('recovery', 'GET', null);
  for (const request of [sessionRequest, page, recovery]) assert.equal(value.authority.allowExternal(request, value.scope), true);
  await value.authority.bindFreshSession(response(sessionRequest, changeSession(session())));
  await value.authority.bindFreshReads(response(page, changePage({ assignments: value.assignments, total: 2, revision: 13 })),
    response(recovery, changeRecovery({ reconciliation_required: false })));
}

test('fresh session must be actual same-principal response; current reads and new token are required', async () => {
  for (const change of [body => ({ ...body, user_id: 'b'.repeat(32) }), body => ({ ...body, mode: 'read_only' }),
    body => ({ ...body, runtime: 'standalone' }), body => ({ ...body, csrf_token: '' }), body => ({ ...body, expires_at: new Date(0).toISOString() })]) {
    const value = fixture(); await assert.rejects(fresh(value, change)); assert.equal(value.authority.evidence().grants, 1);
  }
  const old = fixture(); await checking(old);
  await assert.rejects(old.authority.bindFreshSession(response(old.request('session', 'GET', null), session())));
  for (const change of [body => ({ ...body, revision: 12 }), body => ({ ...body, assignments: body.assignments.slice(1) }),
    body => ({ ...body, assignments: body.assignments.map(row => ({ ...row, version: 1 })) })]) {
    const value = fixture(); await assert.rejects(fresh(value, body => body, change)); assert.equal(value.authority.evidence().fresh_saved_state_verified, false);
  }
  const guard = fixture(); await assert.rejects(fresh(guard, body => body, body => body, () => ({ reconciliation_required: true })));
  const missing = fixture(); await checking(missing); assert.throws(() => missing.authority.armPreview());
  const token = fixture(); await fresh(token); token.authority.armPreview(); const second = token.request();
  assert.equal(token.authority.allowExternal(second, token.scope), true);
  await assert.rejects(token.authority.acceptPreview(response(second, preview('x'))));
});

test('late response cannot advance preview state after cleanup or its original action deadline', async () => {
  for (const expiry of ['closed', 'deadline']) {
    const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview(); const request = value.request();
    assert.equal(value.authority.allowExternal(request, value.scope), true);
    let release, started; const reading = new Promise(done => { started = done; });
    const pending = value.authority.acceptPreview({ ...response(request, preview('x')), body: () => { started(); return new Promise(done => { release = done; }); } });
    pending.catch(() => {}); await reading;
    if (expiry === 'closed') value.authority.close(); else value.advance(15000);
    release(Buffer.from(JSON.stringify(preview('x')))); await assert.rejects(pending);
    assert.equal(value.authority.evidence().preview_reports, 0); assert.equal(value.authority.evidence().first_preview_token_sha256, null);
  }
});

function recoveryUI() {
  const state = { report: false, retained: true, policy: '', reviewed: false, confirmDisabled: true, uploads: 0 };
  const locator = kind => ({ kind,
    getByRole: (role, { name }) => {
      assert.ok(role === 'region' && name === 'Restore preview' || role === 'button' && ['Preview restore', 'Confirm local restore'].includes(name));
      return locator(name === 'Restore preview' ? 'report' : name === 'Preview restore' ? 'preview' : 'confirm');
    },
    getByLabel: name => {
      assert.ok(['Logical export JSON file', 'Restore conflict policy', 'I reviewed the restore rows and conflict policy'].includes(name));
      return locator(name === 'Logical export JSON file' ? 'file' : name === 'Restore conflict policy' ? 'policy' : 'review');
    },
    setInputFiles: async () => { state.uploads += 1; },
  });
  const recovery = locator('recovery');
  const count = kind => ['report', 'policy', 'review', 'confirm'].includes(kind) ? Number(state.report) : 1;
  const text = () => 'Selected export: synthetic-lifecycle-export-v1.json '
    + (state.retained ? 'Retained for this authorized user; preview again before choosing a new restore policy and confirmation. ' : '')
    + (state.report ? '2 supported rows · 0 rejected rows · 2 existing draft conflicts · Local revision 13' : '');
  const expect = current => ({
    toBeVisible: async options => {
      assert.equal(options.timeout, 5000); const deadline = performance.now() + options.timeout;
      while (!count(current.kind) && performance.now() < deadline) await new Promise(done => setTimeout(done, 1));
      assert.equal(count(current.kind), 1);
    },
    toContainText: async value => { assert.ok(text().includes(value)); },
    toHaveValue: async value => { assert.equal(current.kind === 'file' ? '' : state.policy, value); },
    toBeDisabled: async () => { assert.equal(state.confirmDisabled, true); },
    toBeEnabled: async () => { assert.equal(current.kind, 'preview'); },
    toHaveCount: async value => { assert.equal(count(current.kind), value); },
    not: { toBeChecked: async () => { assert.equal(state.reviewed, false); } },
  });
  return { state, manager: { frame: { getByRole: (role, { name }) => { assert.equal(role, 'region'); assert.equal(name, 'Export and recovery'); return recovery; } }, expect } };
}

test('fresh preview helper waits for rendered report and rejects stale policy/review/confirm state', async () => {
  const { freshPreviewUI } = await import('./browser_file_review.mjs');
  const value = fixture(), ui = recoveryUI();
  const pending = freshPreviewUI(ui.manager, value.authority); setImmediate(() => { ui.state.report = true; });
  await pending;
  for (const change of [state => { state.policy = 'replace'; }, state => { state.reviewed = true; }, state => { state.confirmDisabled = false; }]) {
    const rejected = recoveryUI(); rejected.state.report = true; change(rejected.state);
    await assert.rejects(freshPreviewUI(rejected.manager, value.authority));
  }
  value.authority.close();
});

test('retained File helper never reuploads and rejects an old report or missing retained marker', async () => {
  const { retainedFileUI } = await import('./browser_file_review.mjs');
  const value = fixture(); await firstReviewed(value); const ui = recoveryUI();
  assert.equal((await retainedFileUI(ui.manager, value.authority)).old_report_policy_review_confirmation_absent, true);
  assert.equal(ui.state.uploads, 0); assert.equal(value.authority.evidence().uploads, 1);
  ui.state.report = true; await assert.rejects(retainedFileUI(ui.manager, value.authority));
  ui.state.report = false; ui.state.retained = false; await assert.rejects(retainedFileUI(ui.manager, value.authority));
  value.authority.close();
});

test('preview authority rejects wrong response identity/status/type/size and malformed reports', async () => {
  const damages = [
    reply => ({ ...reply, request: () => ({}) }),
    reply => ({ ...reply, url: () => LOCAL_ORIGIN + '/api/hassio_ingress/OTHER/api/v1/restores/preview' }),
    reply => ({ ...reply, status: () => 403 }),
    reply => ({ ...reply, headerValue: async () => 'text/html' }),
    reply => ({ ...reply, body: async () => Buffer.alloc(8193, 32) }),
    reply => ({ ...reply, body: async () => Buffer.from('{') }),
    reply => ({ ...reply, body: async () => Buffer.from(JSON.stringify({ ...preview('x'), local_revision: 12 })) }),
    reply => ({ ...reply, body: async () => Buffer.from(JSON.stringify({ ...preview('x'), rows: [] })) }),
  ];
  for (const damage of damages) {
    const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview();
    const request = value.request(); assert.equal(value.authority.allowExternal(request, value.scope), true);
    await assert.rejects(value.authority.acceptPreview(damage(response(request, preview('x')))));
    assert.equal(value.authority.evidence().preview_reports, 0); assert.equal(value.authority.evidence().closed, true);
    assert.throws(() => value.authority.armPreview());
  }
});

test('a fresh session can retain or change CSRF; only its verified current value authorizes preview two', async () => {
  const changed = fixture(); await fresh(changed, body => ({ ...body, csrf_token: 'SYNTHETIC_NEW_CSRF' }));
  changed.authority.armPreview();
  assert.equal(changed.authority.allowExternal(changed.request('restores/preview', 'POST', FILE_REVIEW_BODY, 'SYNTHETIC_NEW_CSRF'), changed.scope), true);
  changed.authority.close();
  const stale = fixture(); await fresh(stale, body => ({ ...body, csrf_token: 'SYNTHETIC_NEW_CSRF' })); stale.authority.armPreview();
  assert.equal(stale.authority.allowExternal(stale.request(), stale.scope), false); assert.equal(stale.authority.evidence().unapproved_mutations, 1);
  const duplicate = fixture(); await checking(duplicate);
  assert.equal(duplicate.authority.allowExternal(duplicate.request('session', 'GET', null), duplicate.scope), true);
  assert.equal(duplicate.authority.allowExternal(duplicate.request('session', 'GET', null), duplicate.scope), false);
  assert.equal(duplicate.authority.evidence().fresh_session_verified, false);
});

test('actual dual-document visibility, owned window and both complete paused intervals precede recheck', async () => {
  const wrongWindow = fixture(); await firstReviewed(wrongWindow); wrongWindow.authority.pause(); wrongWindow.window('restored');
  await assert.rejects(wrongWindow.authority.observeHidden());
  const wrongDocument = fixture(); await firstReviewed(wrongDocument); wrongDocument.authority.pause(); wrongDocument.window('minimized');
  wrongDocument.binding.frame.evaluate = async () => 'visible'; await assert.rejects(wrongDocument.authority.observeHidden());
  const shortVisible = fixture(); await firstReviewed(shortVisible); shortVisible.authority.pause(); shortVisible.window('minimized');
  await shortVisible.authority.observeHidden(); shortVisible.advance(10000); shortVisible.window('restored');
  await shortVisible.authority.observeRestored(); shortVisible.advance(9999); assert.throws(() => shortVisible.authority.beginRecheck());
});

test('cleanup publishes immutable evidence; late responses or request callbacks cannot reopen or rewrite it', async () => {
  const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview();
  const request = value.request(); assert.equal(value.authority.allowExternal(request, value.scope), true);
  let release, began; const started = new Promise(done => { began = done; });
  const pending = value.authority.acceptPreview({ ...response(request, preview('x')), body: () => { began(); return new Promise(done => { release = done; }); } });
  pending.catch(() => {}); await started; value.authority.close(); const frozen = value.authority.evidence();
  release(Buffer.from(JSON.stringify(preview('x')))); await assert.rejects(pending);
  const late = value.request('restores/confirm'); value.authority.observeRequest(late);
  assert.equal(value.authority.allowExternal(late, value.scope), false); assert.equal(value.authority.allowCase(late, value.scope), false);
  value.authority.finished(request); assert.deepEqual(value.authority.evidence(), frozen);
});

test('the inner native route also fences and counts a mutation lacking the exact consumed outer grant', () => {
  const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview();
  const approved = value.request(); assert.equal(value.authority.allowExternal(approved, value.scope), true);
  assert.equal(value.authority.allowCase(value.request('restores/confirm'), value.scope), false);
  assert.equal(value.authority.evidence().unapproved_mutations, 1); assert.equal(value.authority.evidence().closed, true);
});

test('source loss between a decoded response and its consumer cannot promote a preview result', async () => {
  const value = fixture(); value.authority.beginUpload(); value.authority.uploaded(); value.authority.armPreview();
  const request = value.request(); assert.equal(value.authority.allowExternal(request, value.scope), true);
  const bytes = Buffer.from(JSON.stringify(preview('x'))), decode = bytes.toString.bind(bytes);
  bytes.toString = (...args) => { const text = decode(...args); queueMicrotask(value.expire); return text; };
  await assert.rejects(value.authority.acceptPreview({ ...response(request, preview('x')), body: async () => bytes }));
  assert.equal(value.authority.evidence().preview_reports, 0); assert.equal(value.authority.evidence().first_preview_token_sha256, null);
});
