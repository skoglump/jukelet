/** Local responsive navigation acceptance only; importing performs no I/O. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ALBUM_TAG } from './browser_manager.mjs';
import { assessAssignments, assessBridge, assessExecutionFence, assessPublicationCompletion, readBridgeInBrowser } from './browser_publication.mjs';
import { createProgressStream, withinDeadline } from './browser_progress.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, ingressPrefix, readBoundedFile, readOnlyRequestAllowed, readPublicInputs } from './browser_inputs.mjs';

const FIELDS = ['schema_version', 'fixture', 'synthetic', 'origin', 'configuration_A_sha256',
  'actual_candidate_image_manifest_digest', 'actual_bridge_archive_sha256', 'admin_A_user_id_sha256',
  'ingress_prefix_sha256', 'publisher_id_sha256', 'assignment_snapshot_sha256', 'domain_revision',
  'published_revision', 'published_checksum', 'automatic_publication_disabled', 'dispatch_disabled',
  'backup_artifact_sha256', 'source_preflight_sha256', 'observed_at'];
const BACKUP = '94ab3bb6010cbad35bf55f7861fc113899472ce9101a7f43d27751ee1f48b481';
const ALBUM = 'spotify:album:0123456789ABCDEFGHIJKL';

export function parseNavigationReceipt(raw) {
  const value = JSON.parse(raw), tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const keys = tokens.flatMap((token, index) => tokens[index + 1] === ':' ? [JSON.parse(token)] : []);
  assert.equal(keys.length, FIELDS.length); assert.equal(new Set(keys).size, keys.length); return value;
}

export function validateNavigationReceipt(value, inputs, preflightHash, now = Date.now()) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...FIELDS].sort());
  assert.equal(value.schema_version, 1); assert.equal(value.fixture, FIXTURE); assert.equal(value.synthetic, true); assert.equal(value.origin, LOCAL_ORIGIN);
  for (const field of FIELDS.filter(name => name.endsWith('_sha256'))) assert.match(value[field], /^[a-f0-9]{64}$/);
  assert.equal(value.configuration_A_sha256, inputs.configuration_sha256);
  assert.equal(value.actual_candidate_image_manifest_digest, inputs.document.candidate.image_manifest_digest);
  assert.match(value.actual_candidate_image_manifest_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(value.actual_bridge_archive_sha256, inputs.document.bridge.archive_sha256);
  assert.equal(value.source_preflight_sha256, preflightHash); assert.equal(value.backup_artifact_sha256, BACKUP);
  assert.equal(value.domain_revision, 13); assert.equal(value.published_revision, 1); assert.match(value.published_checksum, /^[a-f0-9]{64}$/);
  assert.equal(value.automatic_publication_disabled, true); assert.equal(value.dispatch_disabled, true);
  assert.equal(typeof value.observed_at, 'string'); const observed = Date.parse(value.observed_at);
  assert.ok(Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= 3600000);
  return { root_receipt_verified: true, configuration_A_sha256: value.configuration_A_sha256,
    admin_A_user_id_sha256: value.admin_A_user_id_sha256, ingress_prefix_sha256: value.ingress_prefix_sha256,
    saved_revision: 13, published_revision: 1, source_preflight_sha256: value.source_preflight_sha256,
    backup_artifact_sha256: value.backup_artifact_sha256, receipt_observed_at: value.observed_at };
}

export class NavigationGate {
  constructor(receipt, verify) {
    Object.assign(this, { receipt, verify, closed: false, bootstrap: true, failed: null, metadata_previews: 0,
      forwarded_app_requests: 0, unexpected_intents: 0, unexpected_app_requests: 0, actions: 0 });
  }
  fence(reason = null) { this.closed = true; this.failed ??= reason; }
  check() { assert.equal(this.closed, false); try { this.verify(); } catch { this.fence('readiness_expired'); throw new Error('navigation_readiness_invalid'); } }
  ready(userHash, prefix) {
    try {
      this.check(); assert.equal(userHash, this.receipt.admin_A_user_id_sha256);
      assert.equal(hash(ingressPrefix(LOCAL_ORIGIN + prefix)), this.receipt.ingress_prefix_sha256);
      this.bootstrap = false; this.principal_bound = true;
    } catch { this.fence('principal_binding_failed'); throw new Error('navigation_principal_invalid'); }
  }
  beforeAction() {
    try { this.check(); assert.equal(this.principal_bound, true); this.actions += 1; }
    catch { this.fence('action_not_authorized'); throw new Error('navigation_action_not_authorized'); }
  }
  allow(request, { fromFrame, prefix }) {
    let target;
    try { target = new URL(request.url()); } catch { return false; }
    const app = target.pathname.startsWith('/api/hassio_ingress/') || target.pathname.startsWith('/api/v1/');
    if (!app) return readOnlyRequestAllowed(request.url(), request.method());
    if (this.closed) return false;
    try {
      this.check(); assert.equal(fromFrame, true);
      assert.equal(target.origin, LOCAL_ORIGIN); assert.equal(target.username + target.password, '');
      assert.equal(hash(ingressPrefix(LOCAL_ORIGIN + prefix)), this.receipt.ingress_prefix_sha256);
      assert.ok(target.pathname.startsWith(prefix));
      const read = ['GET', 'HEAD'].includes(request.method());
      if (!read) {
        const preview = this.bootstrap && this.metadata_previews === 0 && request.method() === 'POST'
          && target.href === LOCAL_ORIGIN + prefix + 'api/v1/music/resolve'
          && request.postData() === JSON.stringify({ input: ALBUM, media_type: 'album' });
        if (!preview) { this.unexpected_intents += 1; throw new Error('unexpected_navigation_intent'); }
        this.metadata_previews += 1;
      }
      this.forwarded_app_requests += 1; return true;
    } catch {
      this.unexpected_app_requests += 1; this.fence('unexpected_app_request'); return false;
    }
  }
  progress(event) { if (event.operation === 'browser_close' && event.checkpoint === 'begin') this.fence(); }
  evidence() { return { gate_closed: this.closed, failure: this.failed, principal_bound: this.principal_bound === true,
    forwarded_app_requests: this.forwarded_app_requests, bootstrap_metadata_previews: this.metadata_previews,
    unexpected_intents: this.unexpected_intents, unexpected_app_requests: this.unexpected_app_requests, checked_actions: this.actions }; }
}

export function assessNavigationSession(value, receipt, now = Date.now()) {
  assert.equal(value.authenticated, true); assert.equal(value.runtime, 'ingress'); assert.equal(value.mode, 'manage');
  assert.match(value.user_id, /^[a-f0-9]{32}$/); assert.equal(hash(value.user_id), receipt.admin_A_user_id_sha256);
  assert.match(value.csrf_token, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(typeof value.expires_at, 'string'); const expiry = Date.parse(value.expires_at); assert.ok(Number.isFinite(expiry) && expiry > now);
  return { user_id_sha256: hash(value.user_id), runtime: 'ingress', mode: 'manage', expires_at: value.expires_at };
}

// This consumes actual bounded bodies. It neither substitutes responses nor
// accesses HA auth/storage. Only these fixed read endpoints can be selected.
export async function readNavigationInBrowser({ base, endpoint }) {
  const target = new URL(base);
  if (target.origin !== 'https://127.0.0.1:18223' || target.username || target.password || target.search || target.hash
    || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/$/.test(target.pathname)
    || !['session', 'assignments?offset=0&limit=100', 'publication', 'playback-status'].includes(endpoint)) throw new Error('invalid_navigation_read');
  const response = await fetch(new URL('api/v1/' + endpoint, base), { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(5000) });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (response.status !== 200) return { status: response.status, content_type: contentType, body: null };
  if (contentType !== 'application/json' || !response.body) throw new Error('invalid_navigation_response');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let length = 0, text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 65536) throw new Error('navigation_body_limit');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); return { status: 200, content_type: contentType, body: JSON.parse(text) };
  } finally { await reader.cancel().catch(() => {}); }
}

async function readNative(manager, gate, endpoint) {
  try {
    gate.check();
    const result = await withinDeadline('native_read', () => manager.frame.evaluate(readNavigationInBrowser,
      { base: LOCAL_ORIGIN + manager.prefix, endpoint }), { timeoutMs: 7000, notify: manager.notify });
    gate.check(); assert.equal(result.status, 200); assert.equal(result.content_type, 'application/json'); return result;
  } catch { gate.fence('native_read_failed'); throw new Error('navigation_read_failed'); }
}

export async function navigationAction(gate, authorize, action, { timeoutMs = 10000, notify = () => {} } = {}) {
  try {
    gate.check(); await withinDeadline('native_read', authorize, { timeoutMs, notify });
    gate.beforeAction();
    const result = await withinDeadline('dom', action, { timeoutMs, notify });
    gate.check(); return result;
  } catch { gate.fence('navigation_action_failed'); throw new Error('navigation_action_failed'); }
}

export async function observeNavigationViewport(frame) {
  return frame.evaluate(() => ({ width: innerWidth, height: innerHeight,
    scroll_width: document.documentElement.scrollWidth, scroll_height: document.documentElement.scrollHeight,
    scroll_y: scrollY, fragment: location.hash }));
}

async function exactTagRow(region, tag) {
  const rows = region.locator('.tag-list > li'), selected = [];
  const count = await rows.count(); assert.ok(count > 0 && count <= 100);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index); if (await row.locator('code').first().textContent() === tag) selected.push(row);
  }
  assert.equal(selected.length, 1); return selected[0];
}

// act is the same per-action receipt/session/principal gate in native execution;
// synthetic DOM controls can exercise navigation independently of HA authority.
export async function exerciseNavigationView(manager, act) {
  const { frame, expect } = manager, nav = frame.getByRole('navigation', { name: 'Manager sections', exact: true });
  const sections = [['Tags', 'tags'], ['Local drafts', 'drafts'], ['Discover music', 'music'], ['Publication', 'publication'],
    ['Playback readiness', 'playback'], ['Connections', 'connections'], ['Export and recovery', 'recovery']];
  const tags = nav.getByRole('link', { name: 'Tags', exact: true }), drafts = nav.getByRole('link', { name: 'Local drafts', exact: true });
  manager.navigationStep?.('keyboard_tab_round_trip');
  await act(async () => {
    await tags.focus(); await tags.press('Tab'); await expect(drafts).toBeFocused();
    await drafts.press('Shift+Tab'); await expect(tags).toBeFocused();
  });
  const anchors = [];
  for (const [name, id] of sections) {
    manager.navigationStep?.('anchor_' + id);
    await act(async () => {
      const link = nav.getByRole('link', { name, exact: true });
      await expect(link).toHaveAttribute('href', '#' + id);
      await link.focus(); await link.press('Enter');
      await expect.poll(() => frame.evaluate(() => location.hash), { timeout: 3000 }).toBe('#' + id);
      await expect(frame.locator('#' + id)).toBeInViewport();
    });
    anchors.push(id);
  }
  const inventory = frame.getByRole('region', { name: 'Tag inventory', exact: true });
  const tagRow = await exactTagRow(inventory, ALBUM_TAG), openTag = tagRow.getByRole('button', { name: /^View tag / });
  manager.navigationStep?.('tag_open');
  await act(async () => { await openTag.focus(); await openTag.press('Enter'); });
  const detail = frame.getByRole('region', { name: 'Tag detail', exact: true });
  await expect(detail.getByRole('heading').first()).toBeFocused();
  assert.equal(await detail.locator('code').first().textContent(), ALBUM_TAG);
  await expect(detail.getByLabel('Draft Spotify URI or link', { exact: true })).toHaveValue(ALBUM);
  manager.navigationStep?.('tag_back');
  await act(async () => { await detail.getByRole('button', { name: 'Back to tag list', exact: true }).press('Enter'); });
  await expect(detail).toHaveCount(0); await expect(openTag).toBeFocused();
  const saved = frame.getByRole('region', { name: 'Saved local drafts', exact: true });
  const draftRow = await exactTagRow(saved, ALBUM_TAG), openDraft = draftRow.getByRole('button', { name: /^Edit draft / });
  manager.navigationStep?.('draft_open');
  await act(async () => { await openDraft.focus(); await openDraft.press('Enter'); });
  const draftDetail = frame.getByRole('region', { name: 'Saved draft detail', exact: true });
  await expect(draftDetail.getByRole('heading', { name: 'Edit saved draft', exact: true })).toBeFocused();
  assert.equal(await draftDetail.locator('code').first().textContent(), ALBUM_TAG);
  await expect(draftDetail.getByLabel('Draft Spotify URI or link', { exact: true })).toHaveValue(ALBUM);
  manager.navigationStep?.('draft_back');
  await act(async () => { await draftDetail.getByRole('button', { name: 'Back to saved drafts', exact: true }).press('Enter'); });
  await expect(draftDetail).toHaveCount(0); await expect(openDraft).toBeFocused();
  return { keyboard_tab_round_trip: true, keyboard_anchors: anchors, exact_tag_id_sha256: hash(ALBUM_TAG),
    tag_detail_and_back: true, saved_draft_detail_and_back: true, focus_returned_to_each_origin: true };
}

async function authority(manager, gate, receipt) {
  const observed = new URL(manager.frame.url());
  assert.equal(observed.origin, LOCAL_ORIGIN); assert.equal(observed.pathname, manager.prefix); assert.equal(observed.search, '');
  const session = assessNavigationSession((await readNative(manager, gate, 'session')).body, receipt);
  const direct = await withinDeadline('native_read', () => manager.page.mainFrame().evaluate(readBridgeInBrowser,
    { user_id_sha256: receipt.admin_A_user_id_sha256 }), { timeoutMs: 10000, notify: manager.notify });
  gate.check(); assert.equal(direct.outcome, 'PASS');
  const bridge = assessBridge(direct.status, receipt.publisher_id_sha256);
  assert.equal(bridge.active_revision, 1); assert.equal(bridge.active_checksum, receipt.published_checksum);
  return { session, direct: direct.status };
}

async function state(manager, gate, receipt) {
  const actual = await authority(manager, gate, receipt);
  const assignments = assessAssignments(await readNative(manager, gate, 'assignments?offset=0&limit=100'), receipt);
  const publication = (await readNative(manager, gate, 'publication')).body;
  const verified = assessPublicationCompletion(publication, actual.direct, { publisher_id_sha256: receipt.publisher_id_sha256, checksum: receipt.published_checksum });
  assert.equal(verified.complete, true);
  return { assignments, publication: verified, publication_history_sha256: hash(JSON.stringify(publication.jobs)),
    execution: assessExecutionFence(await readNative(manager, gate, 'playback-status')) };
}

export async function runNavigation(path, { progress = () => {} } = {}) {
  const report = { fixture: FIXTURE, phase: 'navigation', stage: 'local_inputs', result: 'FAIL', checks: {}, limitations: [
    'Local desktop Chromium with responsive viewport resizing; no physical mobile device, touch/OS behavior, genuine hidden/reopen, remote proxy or natural eight-hour app expiry certification.',
    'Normal HA login/sidebar and actual API bodies only. No auth/cookie injection, API substitution, lifecycle/property emulation or assignment/publication/tag/script writes.',
    'Service workers remain blocked by the existing opener. Exact artifact/durable state and no leftover browser descendants require independent coordinator readbacks.',
  ] };
  let manager, gate, openerInvoked = false;
  const notify = event => { gate?.progress(event); progress({ role: 'A', stage: report.stage, ...event }); };
  const stage = value => { report.stage = value; notify({ operation: 'phase', checkpoint: 'begin' }); };
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_navigation.mjs', 'browser.mjs', 'browser_inputs.mjs', 'browser_auth.mjs',
      'browser_manager.mjs', 'browser_publication.mjs', 'browser_metadata.mjs', 'fetch_clone.mjs', 'browser_progress.mjs']
      .map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = readPublicInputs(path); stage('root_readiness_receipt');
    const readyBytes = readBoundedFile(join(CONTROL_ROOT, 'nav-ready.json'), 16384), receipt = parseNavigationReceipt(readyBytes.toString('utf8'));
    const preflightHash = hash(readBoundedFile(join(CONTROL_ROOT, 'navigation-preflight.json'), 32768));
    const verify = () => validateNavigationReceipt(receipt, inputs, preflightHash);
    report.checks.readiness = { ...verify(), file_sha256: hash(readyBytes) }; gate = new NavigationGate(receipt, verify);
    openerInvoked = true;
    manager = await openNativeManager(inputs, report, { requestAllowed: (request, scope) => gate.allow(request, scope), setStage: stage, progress: notify });
    gate.ready(report.checks.native_reads.user_id_sha256, manager.prefix);
    manager.navigationStep = value => { report.navigation_step = value; };
    manager.page.on('response', response => {
      try {
        if (response.url().startsWith(LOCAL_ORIGIN + manager.prefix + 'api/v1/')) {
          if (response.request().frame() !== manager.frame) gate.fence('response_scope_unknown');
          if (response.status() >= 400) gate.fence('app_response_rejected');
        }
      } catch { gate.fence('response_scope_unknown'); }
    });
    stage('native_bootstrap_reads'); report.checks.before = await state(manager, gate, receipt);
    const act = operation => navigationAction(gate, () => authority(manager, gate, receipt), operation, { notify });
    report.checks.views = [];
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile_viewport', { width: 390, height: 844 }]]) {
      report.current_view = name; stage('native_inventory_dom');
      await act(() => manager.page.setViewportSize(viewport)); assert.deepEqual(manager.page.viewportSize(), viewport);
      const navigation = await exerciseNavigationView(manager, act);
      const observed = await withinDeadline('native_evaluate', () => observeNavigationViewport(manager.frame), { timeoutMs: 5000, notify }); gate.check();
      assert.ok(observed.width > 0 && observed.height > 0 && observed.width <= viewport.width);
      assert.ok(observed.scroll_width <= observed.width + 1);
      report.checks.views.push({ name, viewport, document: observed, ...navigation });
    }
    stage('native_bootstrap_reads'); report.checks.after = await state(manager, gate, receipt);
    assert.deepEqual(report.checks.after, report.checks.before); assert.equal(gate.failed, null);
    assert.equal(gate.metadata_previews, 1); assert.equal(gate.unexpected_intents, 0); assert.equal(gate.unexpected_app_requests, 0);
    gate.fence(); stage('close_browsers_and_assess'); assert.equal((await manager.cleanup()).cleanup_confirmed, true);
    report.checks.network_assessment = assessNetworkBoundaries(manager.network, manager.networkCategories);
    assert.equal(gate.failed, null); report.result = 'PASS'; stage('complete');
  } catch {
    gate?.fence('navigation_failed'); report.code = 'native_navigation_failed'; notify({ operation: 'phase', checkpoint: 'failed' });
  } finally {
    gate?.fence();
    if (manager) await manager.cleanup();
    if (!openerInvoked) report.checks.cleanup = { cleanup_confirmed: true, reason: 'not_started' };
    report.checks.cleanup ??= { cleanup_confirmed: false, reason: 'missing_cleanup_evidence' };
    if (report.checks.cleanup?.cleanup_confirmed !== true) { report.result = 'FAIL'; report.code = 'browser_cleanup_unconfirmed'; }
    report.guard = gate?.evidence() ?? { gate_closed: true, checked_actions: 0 };
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write('node scripts/haos_acceptance/browser_navigation.mjs navigation CONFIG_A\n');
  else if (args.length === 2 && args[0] === 'navigation') {
    const report = await runNavigation(args[1], { progress: createProgressStream(line => process.stderr.write(line)) });
    process.exitCode = report.result === 'PASS' ? 0 : 1;
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => {
      if (report.checks.cleanup?.cleanup_confirmed === false) process.stderr.write('', () => process.exit(1));
    });
  } else { process.stdout.write(JSON.stringify({ result: 'FAIL', code: 'invalid_phase_arguments' }) + '\n'); process.exitCode = 2; }
}
