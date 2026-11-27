/** Real native-window/iframe lifecycle acceptance; importing performs no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, ingressPrefix, readOnlyRequestAllowed, readPublicInputs } from './browser_inputs.mjs';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ALBUM_TAG, PLAYLIST_URI } from './browser_manager.mjs';
import { withinDeadline } from './browser_progress.mjs';

export class VisibilityGate {
  constructor() {
    Object.assign(this, { phase: 'bootstrap', failure: null, closed: false, inflight: new Map(),
      private_starts: 0, unexpected_private_starts: 0, prior_inflight_completions: 0, mutation_attempts: 0,
      check_session_starts: 0, fresh_session_verified: false });
  }
  fail(reason) { this.closed = true; this.failure ??= reason; }
  close() { this.closed = true; }
  check() {
    assert.equal(this.closed, false); assert.equal(this.failure, null);
    try { this.verify?.(); } catch { this.fail('visibility_source_expired'); throw new Error('visibility_source_expired'); }
  }
  bind(prefix, userHash, verify) {
    assert.equal(this.phase, 'bootstrap'); assert.equal(ingressPrefix(LOCAL_ORIGIN + prefix), prefix);
    assert.match(userHash, /^[a-f0-9]{64}$/); assert.equal(typeof verify, 'function');
    Object.assign(this, { prefix, userHash, verify, phase: 'active' }); this.check();
  }
  privateRequest(request) {
    const target = new URL(request.url());
    return target.origin === LOCAL_ORIGIN && target.pathname.startsWith(this.prefix + 'api/v1/');
  }
  pause() { this.check(); assert.equal(this.phase, 'active'); this.phase = 'paused'; }
  beginCheck() { this.check(); assert.equal(this.phase, 'paused'); this.phase = 'checking'; }
  started(request) {
    if (this.phase === 'bootstrap') return;
    try {
      if (!this.privateRequest(request)) return;
      this.check(); assert.ok(this.inflight.size < 128); this.private_starts += 1;
      this.inflight.set(request, this.phase);
      if (!['GET', 'HEAD'].includes(request.method())) { this.mutation_attempts += 1; this.fail('visibility_mutation_attempt'); }
      if (this.phase === 'paused') { this.unexpected_private_starts += 1; this.fail('private_request_while_paused'); }
      if (this.phase === 'checking' && request.url() === LOCAL_ORIGIN + this.prefix + 'api/v1/session') {
        this.check_session_starts += 1; if (this.check_session_starts !== 1) this.fail('duplicate_access_check');
      }
    } catch { this.fail('visibility_request_observation_failed'); }
  }
  finished(request) {
    const before = this.inflight.get(request); this.inflight.delete(request);
    if (!this.closed) {
      try { this.check(); } catch { return; }
      if (before === 'active' && this.phase === 'paused') this.prior_inflight_completions += 1;
    }
  }
  allow(request, scope) {
    if (this.phase === 'bootstrap') return readOnlyRequestAllowed(request.url(), request.method());
    try {
      this.check();
      if (!this.privateRequest(request)) return readOnlyRequestAllowed(request.url(), request.method());
      assert.equal(scope.fromFrame, true); assert.equal(scope.prefix, this.prefix);
      assert.notEqual(this.phase, 'paused'); assert.ok(['GET', 'HEAD'].includes(request.method()));
      return readOnlyRequestAllowed(request.url(), request.method());
    } catch { this.fail('visibility_request_denied'); return false; }
  }
  acceptSession(value, now = Date.now()) {
    try {
      this.check(); assert.equal(this.phase, 'checking'); assert.equal(this.check_session_starts, 1);
      assert.equal(value.authenticated, true); assert.equal(value.runtime, 'ingress'); assert.equal(value.mode, 'manage');
      assert.match(value.user_id, /^[a-f0-9]{32}$/); assert.equal(hash(value.user_id), this.userHash);
      assert.match(value.csrf_token, /^[A-Za-z0-9_-]{1,128}$/);
      assert.ok(Number.isFinite(Date.parse(value.expires_at)) && Date.parse(value.expires_at) > now);
      this.fresh_session_verified = true; this.phase = 'active';
      return { status: 200, same_user: true, runtime: 'ingress', mode: 'manage', expires_at: value.expires_at };
    } catch { this.fail('visibility_access_check_unverified'); throw new Error('visibility_access_check_unverified'); }
  }
  evidence() {
    return Object.fromEntries(['phase', 'closed', 'failure', 'private_starts', 'unexpected_private_starts',
      'prior_inflight_completions', 'mutation_attempts', 'check_session_starts', 'fresh_session_verified'].map(key => [key, this[key]]));
  }
}

export function assessVisibility(value, expected) {
  assert.ok(['visible', 'hidden'].includes(expected));
  assert.deepEqual(value, { parent: expected, iframe: expected }); return value;
}

// Production always uses the real monotonic clock and timer. The optional pair
// lets local protocol controls demonstrate early-timer and late-fence rejection;
// no CLI/configuration input can replace either one.
export async function observePausedInterval(gate, assertPaused, {
  now = () => performance.now(), wait = milliseconds => new Promise(done => setTimeout(done, milliseconds)),
} = {}) {
  gate.check(); assert.equal(gate.phase, 'paused'); await assertPaused(); gate.check();
  const started = now(); await wait(10250); gate.check();
  const elapsed = now() - started; assert.ok(elapsed >= 10000 && elapsed < 30000);
  await assertPaused(); gate.check(); return { elapsed_ms: Math.floor(elapsed), polling_interval_ms: 10000 };
}

export async function readNativeVisibility({ page, frame }, gate) {
  gate.check();
  const parent = await withinDeadline('native_evaluate', () => page.evaluate(() => document.visibilityState));
  gate.check();
  const iframe = await withinDeadline('native_evaluate', () => frame.evaluate(() => document.visibilityState));
  gate.check(); return { parent, iframe };
}

export function classifyVisibilityFailure(error) {
  let name, code, message;
  try {
    name = error?.name; code = error?.code;
    message = error && Object.getOwnPropertyDescriptor(error, 'message')?.value;
  } catch { /* Unknown objects cannot expose arbitrary properties. */ }
  const available = typeof message === 'string' && message.length <= 16384;
  const contains = value => available && message.includes(value);
  return { category: code === 'native_deadline' ? 'native_deadline' : name === 'TimeoutError' ? 'timeout'
    : code === 'ERR_ASSERTION' ? 'assertion' : 'other', message_predicates_available: available,
    pointer_intercepted: contains('intercepts pointer events'), outside_viewport: contains('outside of the viewport'),
    not_visible: contains('not visible'), not_enabled: contains('not enabled'), not_stable: contains('not stable'),
    detached: contains('not attached'), closed: contains('Target page, context or browser has been closed') };
}

export async function inspectCheckButton(button, gate) {
  gate.check();
  const value = await withinDeadline('native_evaluate', () => button.evaluate(element => {
    const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const positive = [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
    const centre = positive && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    const hit = centre ? document.elementFromPoint(x, y) : null;
    return { attached: element.isConnected, document_visible: document.visibilityState === 'visible', document_focused: document.hasFocus(),
      button_focused: document.activeElement === element, enabled: !element.disabled,
      positive_rect: positive, intersects_viewport: positive && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
      centre_in_viewport: centre, centre_hits_button: !!hit && (hit === element || element.contains(hit)) };
  }), { timeoutMs: 1000 });
  gate.check();
  const keys = ['attached', 'document_visible', 'document_focused', 'button_focused', 'enabled', 'positive_rect',
    'intersects_viewport', 'centre_in_viewport', 'centre_hits_button'];
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
  assert.ok(keys.every(key => typeof value[key] === 'boolean')); return value;
}

export async function readVisibilityResponse(response, frame, url, limit, gate, { checkpoint = () => {}, evidence = {} } = {}) {
  gate.check();
  checkpoint('response_url'); assert.equal(response.url(), url); evidence.response_url_bound = true;
  checkpoint('response_method'); assert.equal(response.request().method(), 'GET'); evidence.response_get = true;
  checkpoint('response_frame'); assert.equal(response.request().frame(), frame); evidence.response_frame_bound = true;
  checkpoint('response_status'); assert.equal(response.status(), 200); evidence.response_status_200 = true;
  checkpoint('response_headers');
  const contentType = await withinDeadline('response_headers', () => response.headerValue('content-type'));
  assert.equal(contentType?.split(';')[0].trim().toLowerCase(), 'application/json');
  evidence.response_json_type = true;
  gate.check();
  checkpoint('response_body');
  const bytes = await withinDeadline('response_body', () => response.body());
  gate.check();
  checkpoint('response_body_size'); assert.ok(bytes.length > 0 && bytes.length <= limit); evidence.response_body_bounded = true;
  checkpoint('response_json'); const value = JSON.parse(bytes.toString('utf8')); evidence.response_json_parsed = true; return value;
}

export async function openAlbumEditor(manager, gate, { checkpoint = () => {}, evidence = {} } = {}) {
  gate.check();
  const inventory = manager.frame.getByRole('region', { name: 'Tag inventory', exact: true });
  const detail = inventory.getByRole('region', { name: 'Tag detail', exact: true });
  const rows = inventory.locator(':scope > ul.tag-list > li'), readinessDeadline = performance.now() + 5000;
  const checkReadiness = () => { gate.check(); assert.ok(performance.now() < readinessDeadline); };
  checkpoint('inventory_readiness');
  await withinDeadline('dom', () => manager.expect.poll(async () => {
    checkReadiness(); const details = await detail.count(); checkReadiness();
    if (details > 0) return true;
    const count = await rows.count(); checkReadiness(); return count > 0;
  }, { timeout: 5000 }).toBe(true), { timeoutMs: 5000 });
  checkReadiness(); evidence.inventory_ready = true;
  // Cached selection can rehydrate while inventory loads. Inspect it again
  // instead of retaining the pre-load absence and unnecessarily clicking a row.
  checkpoint('tag_detail_count'); const detailCount = await detail.count(); evidence.detail_present = detailCount > 0;
  if (detailCount === 0) {
    let selected;
    checkpoint('inventory_rows_count'); const count = await rows.count(); evidence.inventory_rows_present = count > 0;
    evidence.inventory_rows_bounded = count <= 100; checkpoint('inventory_rows_assertion'); assert.ok(count > 0 && count <= 100);
    for (let i = 0; i < count; i += 1) {
      checkpoint('inventory_exact_target');
      gate.check(); const row = rows.nth(i);
      if (await row.locator('code.exact-id').first().textContent() === ALBUM_TAG) {
        assert.equal(selected, undefined); selected = row;
      }
    }
    checkpoint('inventory_target_assertion'); assert.ok(selected); evidence.exact_target_found = true;
    gate.check(); checkpoint('inventory_open_target'); await selected.getByRole('button', { name: /^View tag / }).click();
  }
  checkpoint('tag_detail_visible');
  await manager.expect(detail).toBeVisible(); gate.check();
  evidence.detail_visible = true; checkpoint('tag_detail_identity');
  assert.equal(await detail.locator(':scope > code.exact-id').textContent(), ALBUM_TAG);
  evidence.detail_identity_matches = true;
  return detail.getByRole('region', { name: 'Local draft editor', exact: true });
}

export async function exerciseVisibility(manager, gate, evidence, setStage = () => {}) {
  const { page, frame, expect, prefix, externalSession: external } = manager;
  const step = value => { gate.check(); setStage(value); };
  const documents = () => readNativeVisibility(manager, gate);
  const paused = async () => {
    gate.check();
    // Count DOM nodes, including nodes hidden by CSS/the native window. A merely
    // invisible private subtree is insufficient: the access boundary removes it.
    await expect(frame.getByRole('heading', { name: 'Your tag and music manager', exact: true, includeHidden: true })).toHaveCount(0);
    for (const name of ['Tag inventory', 'Tag detail', 'Music preview', 'Saved local drafts', 'Local draft editor']) {
      gate.check(); await expect(frame.getByRole('region', { name, exact: true, includeHidden: true })).toHaveCount(0);
    }
    await expect(frame.getByRole('region', { name: 'Session access', exact: true, includeHidden: true })).toHaveCount(1);
    await expect(frame.locator('#secret')).toHaveCount(0); gate.check();
  };
  step('visibility_initial'); evidence.initial = assessVisibility(await documents(), 'visible');
  const saved = manager.observations.inventory.body.tags.find(tag => tag.ha_tag_id === ALBUM_TAG)?.saved_assignment;
  assert.ok(saved && saved.tag_key === hash(ALBUM_TAG) && Number.isSafeInteger(saved.version) && saved.version > 0);
  assert.notEqual(saved.spotify_uri, PLAYLIST_URI); assert.equal(saved.media_type, 'album');
  const editor = await openAlbumEditor(manager, gate);
  step('visibility_unsaved_inputs');
  await expect(editor.getByRole('button', { name: 'Remove local draft', exact: true })).toBeEnabled();
  await editor.getByLabel('Draft Spotify URI or link', { exact: true }).fill(PLAYLIST_URI); gate.check();
  await editor.getByLabel('Draft media type', { exact: true }).selectOption('playlist'); gate.check();
  await editor.getByRole('button', { name: 'Remove local draft', exact: true }).click(); gate.check();
  await expect(editor.getByRole('group', { name: 'Confirm local removal', exact: true })).toBeVisible();
  evidence.unsaved_inputs = { synthetic_uri: true, media_type: 'playlist', local_confirmation_open: true, confirmation_submitted: false };

  step('visibility_minimize'); gate.pause(); evidence.minimize = await external.ownedWindowControl('minimize');
  await expect.poll(documents, { timeout: 5000 }).toEqual({ parent: 'hidden', iframe: 'hidden' });
  evidence.hidden = assessVisibility(await documents(), 'hidden');
  step('visibility_hidden_observation'); evidence.hidden_pause = await observePausedInterval(gate, async () => {
    assessVisibility(await documents(), 'hidden'); await paused();
  });
  step('visibility_restore'); evidence.restore = await external.ownedWindowControl('restore');
  await expect.poll(documents, { timeout: 5000 }).toEqual({ parent: 'visible', iframe: 'visible' });
  evidence.visible = assessVisibility(await documents(), 'visible');
  step('visibility_visible_paused_observation'); evidence.visible_pause = await observePausedInterval(gate, async () => {
    assessVisibility(await documents(), 'visible'); await paused();
  });

  step('visibility_explicit_check');
  const sessionURL = LOCAL_ORIGIN + prefix + 'api/v1/session';
  const assignmentURL = LOCAL_ORIGIN + prefix + `api/v1/tags/${saved.tag_key}/assignment`;
  const match = url => response => response.url() === url && response.request().method() === 'GET';
  const sessionResponse = page.waitForResponse(match(sessionURL), { timeout: 15000 }); sessionResponse.catch(() => {});
  const assignmentResponse = page.waitForResponse(match(assignmentURL), { timeout: 15000 }); assignmentResponse.catch(() => {});
  const checkButton = frame.getByRole('button', { name: 'Check access again', exact: true });
  const explicit = evidence.explicit_check = { gate_started: false, click_completed: false, session_response_received: false, session_verified: false };
  try {
    step('visibility_explicit_begin'); gate.beginCheck(); explicit.gate_started = true;
    step('visibility_explicit_click'); await checkButton.click(); explicit.click_completed = true;
    gate.check(); step('visibility_explicit_session_wait'); const response = await sessionResponse; explicit.session_response_received = true;
    evidence.access_check = gate.acceptSession(await readVisibilityResponse(response, frame, sessionURL, 4096, gate,
      { checkpoint: value => setStage('visibility_explicit_session_' + value), evidence: explicit }));
    explicit.session_verified = true;
  } catch (error) {
    explicit.failure = classifyVisibilityFailure(error);
    // Post-failure read-only diagnostics cannot delay/change the click or request
    // decision. They neither retry nor grant authority, and expose no geometry.
    try {
      gate.check(); explicit.frame_attached = !frame.isDetached();
      explicit.button_readback = await inspectCheckButton(checkButton, gate); explicit.button_readback_available = true;
    } catch { explicit.button_readback_available = false; }
    throw error;
  }
  step('visibility_recovered_inputs');
  const recoveredChecks = evidence.recovered_checks = {};
  const recoveredStage = value => setStage('visibility_recovered_' + value);
  recoveredStage('manager_heading');
  await expect(frame.getByRole('heading', { name: 'Your tag and music manager', exact: true })).toBeVisible();
  recoveredChecks.manager_visible = true;
  const recovered = await openAlbumEditor(manager, gate, { checkpoint: recoveredStage, evidence: recoveredChecks });
  recoveredChecks.editor_opened = true; recoveredStage('assignment_response');
  const fresh = await readVisibilityResponse(await assignmentResponse, frame, assignmentURL, 8192, gate,
    { checkpoint: recoveredStage, evidence: recoveredChecks }); gate.check();
  recoveredStage('saved_state_equality'); assert.deepEqual(fresh, { version: saved.version, assignment: saved });
  recoveredChecks.saved_state_matches = true; recoveredStage('uri_value');
  await expect(recovered.getByLabel('Draft Spotify URI or link', { exact: true })).toHaveValue(PLAYLIST_URI); gate.check();
  recoveredChecks.uri_preserved = true; recoveredStage('media_type');
  await expect(recovered.getByLabel('Draft media type', { exact: true })).toHaveValue('playlist'); gate.check();
  recoveredChecks.media_type_preserved = true; recoveredStage('review_unchecked');
  const review = recovered.getByRole('checkbox', { name: 'I reviewed recovered input against the current draft', exact: true });
  await expect(review).not.toBeChecked(); recoveredChecks.review_unchecked = true; recoveredStage('review_enabled');
  await expect(review).toBeEnabled(); gate.check(); recoveredChecks.review_enabled = true; recoveredStage('current_revision_text');
  await expect(recovered).toContainText(`current draft revision ${saved.version}`);
  recoveredChecks.current_revision_shown = true; recoveredStage('current_saved_uri_text');
  await expect(recovered).toContainText(`Current saved URI: ${saved.spotify_uri}`); gate.check();
  recoveredChecks.current_saved_uri_shown = true; recoveredStage('save_disabled');
  await expect(recovered.getByRole('button', { name: 'Save local draft', exact: true })).toBeDisabled();
  recoveredChecks.save_disabled = true; recoveredStage('remove_disabled');
  await expect(recovered.getByRole('button', { name: 'Remove local draft', exact: true })).toBeDisabled(); gate.check();
  recoveredChecks.remove_disabled = true; recoveredStage('stale_confirmation_absent');
  await expect(frame.getByRole('group', { name: 'Confirm local removal', exact: true, includeHidden: true })).toHaveCount(0);
  recoveredChecks.stale_confirmation_absent = true; recoveredStage('stale_preview_absent');
  await expect(frame.getByLabel('Selected music preview', { exact: true })).toHaveCount(0); gate.check();
  recoveredChecks.stale_preview_absent = true;
  evidence.recovery = { unsaved_uri_and_media_type_preserved: true, fresh_saved_read_status: 200,
    saved_revision: fresh.version, saved_assignment_unchanged: true, recovered_review_required: true,
    stale_confirmation_absent: true, stale_selected_preview_absent: true, writes_attempted: gate.evidence().mutation_attempts };
}

export async function runVisibility(path) {
  const report = { fixture: FIXTURE, phase: 'external-visibility', result: 'FAIL', checks: {}, limitations: [
    'Synthetic isolated native HA iframe case only; normal service-worker support, mobile/proxy matrix, File/server-review lifecycle and natural eight-hour expiry remain separate.',
    'Root must verify normal Chrome exit, display/proxy cleanup and unchanged synthetic runtime/publisher/bridge state.',
  ] };
  const gate = new VisibilityGate(); let stage = 'local_inputs', manager;
  const started = request => gate.started(request), finished = request => gate.finished(request);
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_visibility.mjs', 'browser_external.mjs', 'browser.mjs', 'browser_inputs.mjs',
      'browser_manager.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = readPublicInputs(path);
    Object.assign(report, { configuration_sha256: inputs.configuration_sha256, declared_candidate: inputs.document.candidate, declared_bridge: inputs.document.bridge });
    manager = await openNativeManager(inputs, report, { externalBrowser: true, requestAllowed: (request, scope) => gate.allow(request, scope),
      setStage: value => { stage = value; } });
    gate.bind(manager.prefix, hash(manager.observations.session.body.user_id), () => manager.externalSession.assertSource());
    manager.page.on('request', started); manager.page.on('requestfinished', finished); manager.page.on('requestfailed', finished);
    report.checks.visibility = {};
    await exerciseVisibility(manager, gate, report.checks.visibility, value => { stage = value; });
    gate.check(); await manager.externalSession.checkWorkers(true); gate.check();
    stage = 'visibility_cleanup'; gate.close(); assert.equal((await manager.cleanup()).cleanup_confirmed, true);
    report.checks.external.guard = manager.externalSession.evidence(); assert.equal(report.checks.external.guard.failure, null);
    const { expected_fixture_warning, ...network } = assessNetworkBoundaries(manager.network, manager.networkCategories);
    report.checks.network_assessment = network; report.checks.expected_fixture_warning = expected_fixture_warning;
    assert.equal(gate.evidence().failure, null); report.result = 'PASS'; stage = 'complete';
  } catch { report.code = 'native_visibility_failed'; }
  finally {
    if (manager) {
      gate.close();
      await manager.cleanup(); manager.page.off('request', started); manager.page.off('requestfinished', finished); manager.page.off('requestfailed', finished);
      report.checks.network = { ...manager.network };
    }
    report.checks.visibility_gate = gate.evidence(); report.stage = stage;
  }
  return report;
}
