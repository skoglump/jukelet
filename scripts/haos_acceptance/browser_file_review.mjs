/** Fixed synthetic File/preview-only acceptance. Importing performs no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ALBUM_TAG, PLAYLIST_TAG, ALBUM_URI, PLAYLIST_URI } from './browser_manager.mjs';
import { FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, ingressPrefix, readOnlyRequestAllowed, readPublicInputs } from './browser_inputs.mjs';
import { withinDeadline } from './browser_progress.mjs';
import { assessVisibility, readNativeVisibility, observePausedInterval } from './browser_visibility.mjs';

export const FILE_REVIEW_NAME = 'synthetic-lifecycle-export-v1.json';
const rows = [
  { ha_tag_id: ALBUM_TAG, spotify_uri: ALBUM_URI, media_type: 'album', enabled: true, shuffle: false, playback_profile_id: 'default', name: null },
  { ha_tag_id: PLAYLIST_TAG, spotify_uri: PLAYLIST_URI, media_type: 'playlist', enabled: true, shuffle: true, playback_profile_id: 'default', name: null },
];
export const FILE_REVIEW_JSON = JSON.stringify({ schema_version: 1,
  provenance: { application: 'jukelet', exported_at: '2026-11-01T00:00:00Z', local_revision: 13, names_updated_at: null, names_stale: true }, assignments: rows });
export const FILE_REVIEW_BODY = '{"document":' + FILE_REVIEW_JSON + '}';
export const FILE_REVIEW_BODY_SHA256 = hash(FILE_REVIEW_BODY);
export const FILE_REVIEW_BYTES_SHA256 = hash(FILE_REVIEW_JSON);

const exactKeys = (value, keys) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const packetRows = JSON.parse(FILE_REVIEW_JSON).assignments;
const sortedRows = values => [...values].sort((a, b) => a.tag_key.localeCompare(b.tag_key));
export function isFileReviewAppRequest(request) {
  try { return /^(?:\/api\/v1\/|\/api\/hassio_ingress\/[^/]+\/api\/v1\/)/.test(new URL(request.url()).pathname); }
  catch { return true; }
}

export class FileReviewAuthority {
  #b; #now; #stage = 'initial'; #privacy = 'active'; #closed = false; #failure = null; #notified = false;
  #csrfHash; #session; #baseline; #action; #timer; #seen = new WeakSet(); #inflight = new Map(); #fresh = new Map();
  #hiddenAt; #restoredAt; #firstToken; #secondToken;
  #stats = { uploads: 0, grants: 0, preview_post_attempts: 0, preview_posts_forwarded: 0, preview_reports: 0,
    unapproved_mutations: 0, unexpected_reads: 0, private_starts: 0, paused_new_starts: 0,
    prior_inflight_completions: 0, session_check_starts: 0, fresh_session_verified: false, fresh_saved_state_verified: false };
  constructor(binding, { now = () => performance.now() } = {}) {
    const { session: _session, tags: _tags, ...owner } = binding; void _session; void _tags;
    this.#b = owner; this.#now = now;
    assert.equal(ingressPrefix(LOCAL_ORIGIN + binding.prefix), binding.prefix); assert.match(binding.principalHash, /^[a-f0-9]{64}$/);
    this.#acceptSession(binding.session);
    assert.equal(binding.tags.length, 2);
    this.#baseline = sortedRows(binding.tags.map(tag => {
      const row = tag.saved_assignment, expected = packetRows.find(value => value.ha_tag_id === tag.ha_tag_id);
      assert.ok(expected && row); assert.equal(row.ha_tag_id, expected.ha_tag_id); assert.equal(row.tag_key, hash(expected.ha_tag_id));
      assert.equal(row.version, expected.media_type === 'album' ? 9 : 5);
      for (const key of ['spotify_uri', 'media_type', 'enabled', 'shuffle', 'playback_profile_id']) assert.equal(row[key], expected[key]);
      return structuredClone(row);
    }));
    assert.equal(new Set(this.#baseline.map(row => row.tag_key)).size, 2); this.check();
  }
  get phase() { return this.#privacy; }
  get stage() { return this.#stage; }
  #acceptSession(value) {
    exactKeys(value, ['authenticated', 'runtime', 'mode', 'user_id', 'csrf_token', 'expires_at']);
    assert.equal(value.authenticated, true); assert.equal(value.runtime, 'ingress'); assert.equal(value.mode, 'manage');
    assert.match(value.user_id, /^[a-f0-9]{32}$/); assert.equal(hash(value.user_id), this.#b.principalHash);
    assert.match(value.csrf_token, /^[A-Za-z0-9_-]{1,128}$/); assert.ok(Date.parse(value.expires_at) > Date.now());
    this.#csrfHash = hash(value.csrf_token); this.#session = { expires_at: value.expires_at };
  }
  close() { this.#closed = true; clearTimeout(this.#timer); this.#action = undefined; }
  #fail(reason) {
    if (this.#closed) return;
    this.#failure ??= reason; this.close();
    if (!this.#notified) { this.#notified = true; try { this.#b.onFailure?.(); } catch { /* Already fenced. */ } }
  }
  check() {
    assert.equal(this.#closed, false); assert.equal(this.#failure, null);
    try {
      this.#b.verify(); assert.equal(this.#b.page.context(), this.#b.context); assert.equal(this.#b.context.browser(), this.#b.browser);
      assert.equal(this.#b.page.isClosed(), false); assert.equal(this.#b.frame.isDetached(), false);
      assert.equal(this.#b.frame.page(), this.#b.page); assert.equal(this.#b.frame.url(), LOCAL_ORIGIN + this.#b.prefix);
      assert.ok(Date.parse(this.#session.expires_at) > Date.now());
      if (this.#action) assert.ok(this.#now() < this.#action.deadline);
    } catch { this.#fail('file_source_or_owner_expired'); throw new Error('file_source_or_owner_expired'); }
  }
  #sync(action, reason) { try { this.check(); return action(); } catch { this.#fail(reason); throw new Error(reason); } }
  async #async(action, reason) { try { this.check(); return await action(); } catch { this.#fail(reason); throw new Error(reason); } }
  #startAction() {
    assert.equal(this.#action, undefined); this.#action = { deadline: this.#now() + 15000, consumed: false };
    this.#timer = setTimeout(() => this.#fail('file_action_timeout'), 15000); this.#timer.unref?.();
  }
  #endAction() { clearTimeout(this.#timer); this.#action = undefined; }
  remainingMs() { this.check(); assert.ok(this.#action); return Math.max(1, Math.ceil(this.#action.deadline - this.#now())); }
  beginUpload() { return this.#sync(() => { assert.equal(this.#stage, 'initial'); this.#stage = 'upload_pending'; }, 'file_upload_stage'); }
  uploaded() { return this.#sync(() => { assert.equal(this.#stage, 'upload_pending'); this.#stats.uploads += 1; this.#stage = 'uploaded'; }, 'file_upload_stage'); }
  armPreview() {
    return this.#sync(() => {
      assert.ok(['uploaded', 'fresh_ready'].includes(this.#stage)); assert.ok(this.#stats.grants < 2);
      assert.equal(this.#stats.uploads, 1); this.#startAction();
      this.#stage = this.#stage === 'uploaded' ? 'first_armed' : 'second_armed'; this.#stats.grants += 1;
    }, 'file_preview_grant_stage');
  }
  #boundRequest(request, scope) {
    const target = new URL(request.url());
    assert.equal(target.origin, LOCAL_ORIGIN); assert.equal(target.username + target.password + target.hash, '');
    assert.ok(target.pathname.startsWith(this.#b.prefix + 'api/v1/'));
    assert.equal(request.frame(), this.#b.frame);
    if (scope) { assert.equal(scope.fromFrame, true); assert.equal(scope.prefix, this.#b.prefix); }
  }
  #matchesPreview(request, scope) {
    try {
      this.#boundRequest(request, scope); assert.equal(request.method(), 'POST');
      assert.equal(request.url(), LOCAL_ORIGIN + this.#b.prefix + 'api/v1/restores/preview');
      const body = request.postData(); assert.equal(typeof body, 'string'); assert.ok(Buffer.byteLength(body) <= 8192);
      assert.equal(hash(body), FILE_REVIEW_BODY_SHA256); assert.equal(body, FILE_REVIEW_BODY);
      const headers = request.headers(); assert.equal(headers['content-type'], 'application/json');
      assert.equal(hash(headers['x-csrf-token'] ?? ''), this.#csrfHash);
      assert.ok(['first_armed', 'second_armed'].includes(this.#stage)); assert.equal(this.#action?.consumed, false);
      return true;
    } catch { return false; }
  }
  observeRequest(request) {
    if (this.#closed || !isFileReviewAppRequest(request) || this.#seen.has(request)) return;
    this.#seen.add(request); this.#stats.private_starts += 1;
    const read = ['GET', 'HEAD'].includes(request.method());
    try {
      this.check(); this.#boundRequest(request); assert.ok(this.#inflight.size < 128); this.#inflight.set(request, this.#privacy);
      if (this.#privacy === 'paused') { this.#stats.paused_new_starts += 1; throw new Error('paused'); }
      if (!read) {
        if (request.method() === 'POST' && request.url() === LOCAL_ORIGIN + this.#b.prefix + 'api/v1/restores/preview') this.#stats.preview_post_attempts += 1;
        assert.equal(this.#matchesPreview(request), true);
      } else if (request.method() === 'GET') {
        const endpoint = request.url().slice((LOCAL_ORIGIN + this.#b.prefix + 'api/v1/').length);
        if (endpoint === 'session') { assert.equal(this.#stage, 'checking'); this.#stats.session_check_starts += 1; assert.equal(this.#stats.session_check_starts, 1); }
        if (['checking', 'fresh_session'].includes(this.#stage) && ['session', 'recovery', 'assignments?offset=0&limit=100'].includes(endpoint)) {
          assert.equal(this.#fresh.has(endpoint), false); this.#fresh.set(endpoint, request);
        }
      }
    } catch {
      if (read) this.#stats.unexpected_reads += 1; else this.#stats.unapproved_mutations += 1;
      this.#fail('file_request_attempt_denied');
    }
  }
  finished(request) {
    const before = this.#inflight.get(request); this.#inflight.delete(request);
    if (!this.#closed) { try { this.check(); if (before === 'active' && this.#privacy === 'paused') this.#stats.prior_inflight_completions += 1; } catch { /* Fenced. */ } }
  }
  allowExternal(request, scope) {
    if (this.#closed) return false;
    this.observeRequest(request);
    try {
      this.check(); this.#boundRequest(request, scope);
      if (['GET', 'HEAD'].includes(request.method())) return this.#privacy !== 'paused';
      assert.equal(this.#matchesPreview(request, scope), true);
      this.#action.consumed = true; this.#action.request = request;
      this.#stage = this.#stage === 'first_armed' ? 'first_sent' : 'second_sent'; this.#stats.preview_posts_forwarded += 1;
      return true;
    } catch {
      if (this.#failure === null) {
        if (['GET', 'HEAD'].includes(request.method())) this.#stats.unexpected_reads += 1;
        else this.#stats.unapproved_mutations += 1;
      }
      this.#fail('file_request_denied'); return false;
    }
  }
  allowCase(request, scope) {
    if (this.#closed) return false;
    if (!isFileReviewAppRequest(request)) return readOnlyRequestAllowed(request.url(), request.method());
    try {
      this.check(); this.#boundRequest(request, scope);
      if (['GET', 'HEAD'].includes(request.method())) assert.notEqual(this.#privacy, 'paused');
      else { assert.equal(this.#action?.consumed, true); assert.equal(request, this.#action.request); }
      return true;
    } catch {
      if (this.#failure === null) {
        if (['GET', 'HEAD'].includes(request.method())) this.#stats.unexpected_reads += 1;
        else this.#stats.unapproved_mutations += 1;
      }
      this.#fail('file_case_request_denied'); return false;
    }
  }
  async #response(response, endpoint, method, request, limit) {
    this.check(); assert.equal(response.url(), LOCAL_ORIGIN + this.#b.prefix + 'api/v1/' + endpoint);
    assert.equal(response.request(), request); this.#boundRequest(request); assert.equal(request.method(), method); assert.equal(response.status(), 200);
    const contentType = await withinDeadline('response_headers', () => response.headerValue('content-type'), { timeoutMs: this.remainingMs() });
    this.check(); assert.equal(contentType?.split(';')[0].trim().toLowerCase(), 'application/json');
    const bytes = await withinDeadline('response_body', () => response.body(), { timeoutMs: this.remainingMs() }); this.check();
    assert.ok(bytes.length > 0 && bytes.length <= limit); return JSON.parse(bytes.toString('utf8'));
  }
  async acceptPreview(response) {
    return this.#async(async () => {
      assert.ok(['first_sent', 'second_sent'].includes(this.#stage)); const second = this.#stage === 'second_sent';
      const value = await this.#response(response, 'restores/preview', 'POST', this.#action.request, 8192); this.check();
      exactKeys(value, ['preview_token', 'local_revision', 'accepted', 'rejected', 'conflicts', 'rows']);
      assert.match(value.preview_token, /^[A-Za-z0-9_-]{32,128}$/); assert.equal(value.local_revision, 13);
      assert.equal(value.accepted, 2); assert.equal(value.rejected, 0); assert.equal(value.conflicts, 2);
      assert.deepEqual(value.rows, packetRows.map((source, index) => ({ row: index + 1, source, accepted: true, conflict: true, diagnostics: [] })));
      const tokenHash = hash(value.preview_token);
      if (second) { assert.notEqual(tokenHash, this.#firstToken); this.#secondToken = tokenHash; } else this.#firstToken = tokenHash;
      this.#stats.preview_reports += 1; this.#endAction(); this.#stage = second ? 'complete' : 'first_reviewed';
      return { status: 200, local_revision: 13, accepted: 2, rejected: 0, conflicts: 2, rows_sha256: hash(JSON.stringify(value.rows)),
        preview_token_sha256: tokenHash, ...(second ? { new_token: true } : {}) };
    }, 'file_preview_response_unverified');
  }
  pause() { return this.#sync(() => { assert.equal(this.#stage, 'first_reviewed'); assert.equal(this.#action, undefined); this.#stage = 'paused'; this.#privacy = 'paused'; }, 'file_pause_stage'); }
  async observeHidden() {
    return this.#async(async () => {
      assert.equal(this.#stage, 'paused'); assert.equal(this.#b.window().phase, 'minimized');
      const observed = assessVisibility(await readNativeVisibility(this.#b, this), 'hidden'); this.check();
      this.#hiddenAt = this.#now(); this.#stage = 'hidden'; return observed;
    }, 'file_hidden_unverified');
  }
  async observeRestored() {
    return this.#async(async () => {
      assert.equal(this.#stage, 'hidden'); assert.ok(this.#now() - this.#hiddenAt >= 10000);
      assert.equal(this.#b.window().phase, 'restored');
      const observed = assessVisibility(await readNativeVisibility(this.#b, this), 'visible'); this.check();
      this.#restoredAt = this.#now(); this.#stage = 'restored_paused'; return observed;
    }, 'file_restore_unverified');
  }
  beginRecheck() {
    return this.#sync(() => {
      assert.equal(this.#stage, 'restored_paused'); assert.ok(this.#now() - this.#restoredAt >= 10000);
      this.#fresh.clear(); this.#startAction(); this.#stage = 'checking'; this.#privacy = 'checking';
    }, 'file_recheck_stage');
  }
  async bindFreshSession(response) {
    return this.#async(async () => {
      assert.equal(this.#stage, 'checking'); assert.equal(this.#stats.session_check_starts, 1);
      const value = await this.#response(response, 'session', 'GET', this.#fresh.get('session'), 4096); this.check();
      this.#acceptSession(value); this.#stats.fresh_session_verified = true; this.#privacy = 'active'; this.#stage = 'fresh_session';
      return { status: 200, same_principal: true, runtime: 'ingress', mode: 'manage' };
    }, 'file_fresh_session_unverified');
  }
  async bindFreshReads(assignmentsResponse, recoveryResponse) {
    return this.#async(async () => {
      assert.equal(this.#stage, 'fresh_session');
      const page = await this.#response(assignmentsResponse, 'assignments?offset=0&limit=100', 'GET', this.#fresh.get('assignments?offset=0&limit=100'), 8192); this.check();
      exactKeys(page, ['assignments', 'total', 'revision']); assert.equal(page.revision, 13); assert.equal(page.total, 2);
      assert.deepEqual(sortedRows(page.assignments), this.#baseline);
      const recovery = await this.#response(recoveryResponse, 'recovery', 'GET', this.#fresh.get('recovery'), 4096); this.check();
      exactKeys(recovery, ['reconciliation_required']); assert.equal(recovery.reconciliation_required, false);
      this.#stats.fresh_saved_state_verified = true; this.#endAction(); this.#stage = 'fresh_ready';
      return { assignments_status: 200, recovery_status: 200, revision: 13, album_version: 9, playlist_version: 5,
        saved_rows_unchanged: true, reconciliation_required: false, guard_generation: 'REQUIRES_ROOT_READBACK' };
    }, 'file_fresh_saved_state_unverified');
  }
  evidence() {
    return { stage: this.#stage, phase: this.#privacy, closed: this.#closed, failure: this.#failure, ...this.#stats,
      body_sha256: FILE_REVIEW_BODY_SHA256, file_sha256: FILE_REVIEW_BYTES_SHA256,
      first_preview_token_sha256: this.#firstToken ?? null, second_preview_token_sha256: this.#secondToken ?? null };
  }
}

const recoveryRegion = manager => manager.frame.getByRole('region', { name: 'Export and recovery', exact: true });
export async function selectSyntheticFile(manager, authority) {
  authority.beginUpload(); const recovery = recoveryRegion(manager);
  await manager.expect(recovery).toBeVisible({ timeout: 5000 }); authority.check();
  await withinDeadline('dom', () => recovery.getByLabel('Logical export JSON file', { exact: true }).setInputFiles({
    name: FILE_REVIEW_NAME, mimeType: 'application/json', buffer: Buffer.from(FILE_REVIEW_JSON),
  }), { timeoutMs: 5000 }); authority.check();
  await manager.expect(recovery).toContainText('Selected export: ' + FILE_REVIEW_NAME, { timeout: 5000 }); authority.check();
  authority.uploaded(); return recovery;
}

export async function freshPreviewUI(manager, authority) {
  authority.check(); const recovery = recoveryRegion(manager), region = recovery.getByRole('region', { name: 'Restore preview', exact: true });
  await manager.expect(region).toBeVisible({ timeout: 5000 }); authority.check();
  await manager.expect(region).toContainText('2 supported rows · 0 rejected rows · 2 existing draft conflicts · Local revision 13', { timeout: 5000 }); authority.check();
  const policy = region.getByLabel('Restore conflict policy', { exact: true });
  const review = region.getByLabel('I reviewed the restore rows and conflict policy', { exact: true });
  const confirm = region.getByRole('button', { name: 'Confirm local restore', exact: true });
  await manager.expect(policy).toHaveValue('', { timeout: 5000 }); authority.check();
  await manager.expect(review).not.toBeChecked({ timeout: 5000 }); authority.check();
  await manager.expect(confirm).toBeDisabled({ timeout: 5000 }); authority.check();
  return { region, policy, review, confirm };
}

export async function retainedFileUI(manager, authority) {
  authority.check(); const recovery = recoveryRegion(manager);
  await manager.expect(recovery).toBeVisible({ timeout: 5000 }); authority.check();
  await manager.expect(recovery).toContainText('Selected export: ' + FILE_REVIEW_NAME, { timeout: 5000 }); authority.check();
  await manager.expect(recovery).toContainText('Retained for this authorized user; preview again before choosing a new restore policy and confirmation.', { timeout: 5000 }); authority.check();
  await manager.expect(recovery.getByLabel('Logical export JSON file', { exact: true })).toHaveValue('', { timeout: 5000 }); authority.check();
  await manager.expect(recovery.getByRole('button', { name: 'Preview restore', exact: true })).toBeEnabled({ timeout: 5000 }); authority.check();
  await manager.expect(recovery.getByRole('region', { name: 'Restore preview', exact: true, includeHidden: true })).toHaveCount(0, { timeout: 5000 }); authority.check();
  await manager.expect(recovery.getByLabel('Restore conflict policy', { exact: true })).toHaveCount(0, { timeout: 5000 }); authority.check();
  await manager.expect(recovery.getByLabel('I reviewed the restore rows and conflict policy', { exact: true })).toHaveCount(0, { timeout: 5000 }); authority.check();
  await manager.expect(recovery.getByRole('button', { name: 'Confirm local restore', exact: true, includeHidden: true })).toHaveCount(0, { timeout: 5000 }); authority.check();
  assert.equal(authority.evidence().preview_post_attempts, 1);
  return { selected_file_retained: true, new_native_input_empty: true, old_report_policy_review_confirmation_absent: true, no_automatic_preview: true };
}

async function requestPreview(manager, authority) {
  authority.check(); const target = LOCAL_ORIGIN + manager.prefix + 'api/v1/restores/preview';
  const waiting = manager.page.waitForResponse(response => response.url() === target && response.request().method() === 'POST', { timeout: 15000 });
  waiting.catch(() => {}); authority.armPreview();
  const response = await withinDeadline('response_headers', async () => {
    await recoveryRegion(manager).getByRole('button', { name: 'Preview restore', exact: true }).click({ timeout: authority.remainingMs() });
    authority.check(); return waiting;
  }, { timeoutMs: authority.remainingMs() });
  return authority.acceptPreview(response);
}

export async function exerciseFileReview(manager, authority, evidence, setStage = () => {}) {
  const stage = value => { authority.check(); setStage(value); };
  const documents = () => readNativeVisibility(manager, authority);
  const paused = async expected => {
    assessVisibility(await documents(), expected); authority.check();
    for (const name of ['Tag inventory', 'Tag detail', 'Music preview', 'Saved local drafts', 'Local draft editor', 'Export and recovery', 'Restore preview']) {
      await manager.expect(manager.frame.getByRole('region', { name, exact: true, includeHidden: true })).toHaveCount(0, { timeout: 5000 }); authority.check();
    }
    await manager.expect(manager.frame.getByRole('heading', { name: 'Your tag and music manager', exact: true, includeHidden: true })).toHaveCount(0, { timeout: 5000 }); authority.check();
    await manager.expect(manager.frame.getByRole('region', { name: 'Session access', exact: true, includeHidden: true })).toHaveCount(1, { timeout: 5000 }); authority.check();
    await manager.expect(manager.frame.locator('#secret')).toHaveCount(0, { timeout: 5000 }); authority.check();
    for (const label of ['Restore conflict policy', 'I reviewed the restore rows and conflict policy']) {
      await manager.expect(manager.frame.getByLabel(label, { exact: true })).toHaveCount(0, { timeout: 5000 }); authority.check();
    }
    await manager.expect(manager.frame.getByRole('button', { name: 'Confirm local restore', exact: true, includeHidden: true })).toHaveCount(0, { timeout: 5000 }); authority.check();
  };
  stage('file_upload'); await selectSyntheticFile(manager, authority);
  evidence.upload = { count: 1, synthetic: true, file_sha256: FILE_REVIEW_BYTES_SHA256, body_sha256: FILE_REVIEW_BODY_SHA256 };
  stage('file_first_preview'); evidence.first_preview = await requestPreview(manager, authority);
  stage('file_first_local_review'); const first = await freshPreviewUI(manager, authority);
  await first.policy.selectOption('replace'); authority.check(); await first.review.check(); authority.check();
  await manager.expect(first.confirm).toBeEnabled({ timeout: 5000 }); authority.check(); evidence.first_local_review_ready_without_submission = true;
  stage('file_minimize'); authority.pause(); evidence.minimize = await manager.externalSession.ownedWindowControl('minimize');
  await manager.expect.poll(documents, { timeout: 5000 }).toEqual({ parent: 'hidden', iframe: 'hidden' });
  evidence.hidden = await authority.observeHidden();
  stage('file_hidden_pause'); evidence.hidden_pause = await observePausedInterval(authority, () => paused('hidden'));
  stage('file_restore'); evidence.restore = await manager.externalSession.ownedWindowControl('restore');
  await manager.expect.poll(documents, { timeout: 5000 }).toEqual({ parent: 'visible', iframe: 'visible' });
  evidence.visible = await authority.observeRestored();
  stage('file_visible_pause'); evidence.visible_pause = await observePausedInterval(authority, () => paused('visible'));
  stage('file_explicit_check');
  const waits = Object.fromEntries(['session', 'assignments?offset=0&limit=100', 'recovery'].map(endpoint => {
    const target = LOCAL_ORIGIN + manager.prefix + 'api/v1/' + endpoint;
    const waiting = manager.page.waitForResponse(response => response.url() === target && response.request().method() === 'GET', { timeout: 15000 });
    waiting.catch(() => {}); return [endpoint, waiting];
  }));
  authority.beginRecheck();
  await manager.frame.getByRole('button', { name: 'Check access again', exact: true }).click({ timeout: authority.remainingMs() }); authority.check();
  stage('file_fresh_session'); evidence.fresh_session = await authority.bindFreshSession(await waits.session);
  stage('file_fresh_saved_reads'); evidence.fresh_saved = await authority.bindFreshReads(await waits['assignments?offset=0&limit=100'], await waits.recovery);
  stage('file_retained_input');
  await manager.expect(manager.frame.getByRole('heading', { name: 'Your tag and music manager', exact: true })).toBeVisible({ timeout: 5000 }); authority.check();
  evidence.retained_file = await retainedFileUI(manager, authority);
  stage('file_second_preview'); evidence.second_preview = await requestPreview(manager, authority);
  stage('file_fresh_review_reset'); await freshPreviewUI(manager, authority);
  evidence.second_policy_empty_review_unchecked_confirm_disabled = true;
  assert.equal(authority.evidence().uploads, 1); assert.equal(authority.evidence().preview_posts_forwarded, 2);
  assert.equal(authority.evidence().preview_reports, 2); assert.equal(authority.evidence().unapproved_mutations, 0);
}

export async function runFileReview(path) {
  const report = { fixture: FIXTURE, phase: 'external-file-review', result: 'FAIL', checks: {}, limitations: [
    'Synthetic source-owned File upload and two preview-only requests; no download, restore confirmation, durable mutation or backend old-token revocation is certified.',
    'Root must bind actual private X11/WM/environment/client identity, normal process cleanup, guard_generation1 and unchanged complete domain/artifact state.',
    'Remaining original issue62 scenarios, independent principals, natural expiry and compatibility/device matrix remain separate.',
  ] };
  let stage = 'local_inputs', manager, authority;
  const started = request => authority.observeRequest(request), finished = request => authority.finished(request);
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_file_review.mjs', 'browser_external.mjs', 'browser_visibility.mjs', 'browser.mjs',
      'browser_inputs.mjs', 'browser_manager.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = readPublicInputs(path);
    Object.assign(report, { configuration_sha256: inputs.configuration_sha256, declared_candidate: inputs.document.candidate, declared_bridge: inputs.document.bridge });
    manager = await openNativeManager(inputs, report, { externalBrowser: true,
      requestAllowed: (request, scope) => authority ? authority.allowCase(request, scope) : readOnlyRequestAllowed(request.url(), request.method()),
      setStage: value => { stage = value; } });
    stage = 'file_capability'; authority = manager.externalSession.startFileReview();
    manager.page.on('request', started); manager.page.on('requestfinished', finished); manager.page.on('requestfailed', finished);
    report.checks.file_review = {};
    await exerciseFileReview(manager, authority, report.checks.file_review, value => { stage = value; });
    authority.check(); await manager.externalSession.checkWorkers(true); authority.check();
    stage = 'file_cleanup'; authority.close(); assert.equal((await manager.cleanup()).cleanup_confirmed, true);
    report.checks.external.guard = manager.externalSession.evidence(); assert.equal(report.checks.external.guard.failure, null);
    const { expected_fixture_warning, ...network } = assessNetworkBoundaries(manager.network, manager.networkCategories);
    report.checks.network_assessment = network; report.checks.expected_fixture_warning = expected_fixture_warning;
    assert.equal(authority.evidence().failure, null); report.result = 'PASS'; stage = 'complete';
  } catch { report.code = 'native_file_review_failed'; }
  finally {
    authority?.close();
    if (manager) {
      await manager.cleanup();
      if (authority) { manager.page.off('request', started); manager.page.off('requestfinished', finished); manager.page.off('requestfailed', finished); }
      report.checks.network = { ...manager.network };
    }
    report.checks.file_authority = authority?.evidence() ?? { initialized: false }; report.stage = stage;
  }
  return report;
}
