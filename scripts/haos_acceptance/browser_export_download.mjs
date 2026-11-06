/** One normal UI export through the owned native Ingress session; import is inert. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessNetworkBoundaries, openNativeManager } from './browser.mjs';
import { ALBUM_TAG, PLAYLIST_TAG, ALBUM_URI, PLAYLIST_URI } from './browser_manager.mjs';
import { ManagerReadGate, assessManagerRows, assessManagerConnection, parseManagerBody } from './browser_manager_readonly.mjs';
import { EXPORT_CASE } from './browser_download_policy.mjs';
import { openCaseLease } from './browser_download_inert.mjs';
import { verifyDownloadArtifact } from './download_artifact.mjs';
import { FIXTURE, LOCAL_ORIGIN, REPOSITORY, hash, readPublicInputs } from './browser_inputs.mjs';
import { withinDeadline } from './browser_progress.mjs';
import { installFetchCloneObserver, readFetchCloneObserver, removeFetchCloneObserver } from './fetch_clone.mjs';

const MAX_BYTES = 8192;
const keys = (value, expected) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
};
const validTime = value => assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)));
export function assessCurrentExport(bytes, inventory) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES);
  const value = parseManagerBody(bytes);
  keys(value, ['schema_version', 'provenance', 'assignments']); assert.equal(value.schema_version, 1);
  keys(value.provenance, ['application', 'exported_at', 'local_revision', 'names_updated_at', 'names_stale']);
  assert.equal(value.provenance.application, 'jukelet'); assert.equal(value.provenance.local_revision, 13);
  assert.equal(value.provenance.names_stale, false); validTime(value.provenance.exported_at); validTime(value.provenance.names_updated_at);
  assert.ok(Array.isArray(value.assignments)); assert.equal(value.assignments.length, 2);
  assert.equal(inventory.tags.length, 2);
  for (const [id, uri, media, shuffle] of [[ALBUM_TAG, ALBUM_URI, 'album', false], [PLAYLIST_TAG, PLAYLIST_URI, 'playlist', true]]) {
    const rows = value.assignments.filter(row => row.ha_tag_id === id), tags = inventory.tags.filter(row => row.ha_tag_id === id);
    assert.equal(rows.length, 1); assert.equal(tags.length, 1);
    const name = tags[0].name; assert.ok(name === null || typeof name === 'string' && name.length <= 1024);
    keys(rows[0], ['ha_tag_id', 'spotify_uri', 'media_type', 'enabled', 'shuffle', 'playback_profile_id', 'name']);
    assert.deepEqual(rows[0], { ha_tag_id: id, spotify_uri: uri, media_type: media, enabled: true, shuffle,
      playback_profile_id: 'default', name });
  }
  return { bytes: bytes.length, sha256: hash(bytes), schema_version: 1, local_revision: 13, mappings: 2,
    opaque_ids_names_media_preferences_exact: true, row_versions_in_export: false };
}

/** Exact CDP/SDK ancestry and document identity, never same-origin parent authority. */
export function identifyExportFrame(tree, binding, target) {
  binding.verify();
  assert.equal(binding.page.context(), binding.context); assert.equal(binding.context.browser(), binding.browser);
  assert.deepEqual(binding.browser.contexts(), [binding.context]); assert.deepEqual(binding.context.pages(), [binding.page]);
  assert.equal(binding.frame.page(), binding.page); assert.equal(binding.frame.isDetached(), false); assert.equal(binding.page.isClosed(), false);
  const url = LOCAL_ORIGIN + binding.prefix; assert.equal(binding.frame.url(), url);
  assert.equal(target.type, 'page'); assert.equal(target.url, binding.page.url()); assert.ok(!target.openerId);
  assert.equal(tree.frame.url, binding.page.url()); assert.ok(!tree.frame.parentId);
  const nodes = [];
  const walk = (node, parents = []) => {
    assert.ok(node && node.frame && parents.length <= 16 && nodes.length < 64);
    const frame = node.frame; assert.equal(typeof frame.id, 'string'); assert.ok(frame.id.length > 0);
    if (parents.length) assert.equal(frame.parentId, parents.at(-1).id);
    nodes.push({ frame, parents });
    for (const child of node.childFrames ?? []) walk(child, [...parents, frame]);
  };
  walk(tree); assert.equal(new Set(nodes.map(node => node.frame.id)).size, nodes.length);
  const matches = nodes.filter(node => node.frame.url === url); assert.equal(matches.length, 1);
  const match = matches[0]; assert.ok(match.parents.length > 0);
  for (const row of [match.frame, ...match.parents]) assert.ok(typeof row.loaderId === 'string' && row.loaderId.length > 0);
  const sdk = []; let frame = binding.frame;
  while (frame) { assert.ok(sdk.length < 17); sdk.unshift(frame.url()); frame = frame.parentFrame(); }
  const path = [...match.parents, match.frame]; assert.deepEqual(path.map(row => row.url), sdk);
  assert.equal(binding.page.mainFrame().url(), path[0].url);
  return Object.freeze({ frameId: match.frame.id, loaderId: match.frame.loaderId, targetId: target.targetId,
    contextId: target.browserContextId, ancestry: path.map(row => ({ id: row.id, loader: row.loaderId, url: row.url })) });
}

/** Independent external detector remains live after fetch restores itself. */
export class ExportResponseJoin {
  #binding; #request; #response; #armed = false; #failure = null; #seen = new WeakSet(); #attempts = 0;
  constructor(onFailure = () => {}) { this.onFailure = onFailure; }
  fail() { this.#failure = 'export_request_unverified'; this.onFailure(); }
  bind(binding) { assert.equal(this.#binding, undefined); this.#binding = binding; this.check(); }
  check() {
    assert.equal(this.#failure, null);
    if (this.#binding) { this.#binding.verify(); assert.equal(this.#binding.frame.url(), LOCAL_ORIGIN + this.#binding.prefix);
      assert.ok(Date.parse(this.#binding.expiresAt) > Date.now()); assert.match(this.#binding.principalHash, /^[a-f0-9]{64}$/); }
  }
  arm() { this.check(); assert.ok(this.#binding); assert.equal(this.#armed, false); this.#armed = true; }
  started(request) {
    try {
      const url = new URL(request.url());
      if (!/(?:^|\/)api\/v1\/export(?:\/|$)/.test(url.pathname)) return true;
      if (this.#seen.has(request)) return this.#failure === null;
      this.#seen.add(request); this.#attempts++; this.check(); assert.equal(this.#armed, true);
      assert.equal(this.#attempts, 1); assert.equal(url.href, LOCAL_ORIGIN + this.#binding.prefix + 'api/v1/export');
      assert.equal(request.method(), 'GET'); assert.ok(request.postData() === null || request.postData() === undefined);
      assert.equal(request.frame(), this.#binding.frame); assert.equal(request.redirectedFrom(), null);
      this.#request = request; return true;
    } catch { this.fail(); return false; }
  }
  responded(response) {
    try {
      const request = response.request(), url = new URL(response.url());
      if (!/(?:^|\/)api\/v1\/export(?:\/|$)/.test(url.pathname) && request !== this.#request) return;
      this.check(); assert.equal(this.#armed, true); assert.ok(this.#request); assert.equal(request, this.#request);
      assert.equal(this.#response, undefined); assert.equal(response.url(), LOCAL_ORIGIN + this.#binding.prefix + 'api/v1/export');
      assert.equal(response.status(), 200); assert.equal(request.redirectedTo(), null); this.#response = response;
    } catch { this.fail(); }
  }
  async joined() {
    try {
      await withinDeadline('response_headers', async () => {
        while (!this.#response) { this.check(); await new Promise(done => setTimeout(done, 5)); }
      }, { timeoutMs: 5000 });
      this.check();
      const type = await withinDeadline('response_headers', () => this.#response.headerValue('content-type'), { timeoutMs: 5000 });
      this.check(); assert.equal(type?.split(';')[0].trim().toLowerCase(), 'application/json');
      assert.equal(this.#request.redirectedTo(), null); return { attempts: this.#attempts, status: 200, sdk_body: 'NOT_READ', exact_request_response_frame: true };
    } catch { this.fail(); throw new Error('export_response_unverified'); }
  }
  evidence() { return { attempts: this.#attempts, responses: this.#response ? 1 : 0, failure: this.#failure }; }
}

/** Trusted adapter seam exercises both arrival orders with actual actor logic. */
export async function captureExport({ binding, policy, pageSession, joiner, click, inventory }) {
  const spec = { slot: '__jukeletIssue62FetchClone', token: randomUUID(), url: LOCAL_ORIGIN + binding.prefix + 'api/v1/export',
    method: 'GET', body: null, timeoutMs: 5000, maxBytes: MAX_BYTES };
  let installed = false, removed = false, identity;
  const check = () => { joiner.check(); policy.check(); binding.verify(); };
  const source = async () => {
    check();
    const target = (await withinDeadline('native_evaluate', () => pageSession.send('Target.getTargetInfo'), { timeoutMs: 3000 })).targetInfo; check();
    const tree = (await withinDeadline('native_evaluate', () => pageSession.send('Page.getFrameTree'), { timeoutMs: 3000 })).frameTree; check();
    const current = identifyExportFrame(tree, binding, target);
    if (identity) assert.deepEqual(current, identity); else identity = current;
  };
  const evaluate = async (callback, input) => {
    await source(); const result = await withinDeadline('native_evaluate', () => binding.frame.evaluate(callback, input), { timeoutMs: 5000 });
    await source(); return result;
  };
  try {
    check(); await withinDeadline('native_evaluate', () => pageSession.send('Page.enable'), { timeoutMs: 3000 }); check();
    await source(); joiner.arm();
    const armed = await evaluate(installFetchCloneObserver, spec); assert.deepEqual(armed, { armed: true }); installed = true;
    await policy.arm({ pageSession, frameId: identity.frameId, verify: checkBinding });
    await source(); await withinDeadline('dom', click, { timeoutMs: 5000 }); await source();
    const [capture, response] = await Promise.all([evaluate(readFetchCloneObserver, spec), joiner.joined()]);
    check(); assert.equal(capture.result, 'PASS');
    for (const key of ['matched_count', 'native_fetch_count', 'clone_count']) assert.equal(capture[key], 1);
    assert.equal(capture.status, 200); assert.equal(capture.original_fetch_restored, true); assert.equal(capture.clone_body_used, true);
    for (const name of ['original_body_used_at_clone', 'original_body_used_after_clone', 'original_body_used_current']) assert.equal(typeof capture[name], 'boolean');
    assert.ok(Array.isArray(capture.export_bytes) && capture.export_bytes.length > 0 && capture.export_bytes.length <= MAX_BYTES
      && capture.export_bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    const bytes = Buffer.from(capture.export_bytes); assert.equal(capture.bytes_read, bytes.length);
    const schema = assessCurrentExport(bytes, inventory), guid = await policy.completed(bytes); await source();
    const removal = await evaluate(removeFetchCloneObserver, spec); removed = true;
    assert.deepEqual(removal, { restored: true, matched_count: 1, clone_count: 1 });
    return { bytes, guid, evidence: { ...schema, ...response, capture_path: 'transparent_response_clone',
      matched_count: 1, native_fetch_count: 1, clone_count: 1, original_fetch_restored: true, token_removed: true,
      stream_tee_observation: true, clone_body_used: true, original_body_used_at_clone: capture.original_body_used_at_clone,
      original_body_used_after_clone: capture.original_body_used_after_clone, original_body_used_current: capture.original_body_used_current,
      sdk_body: 'NOT_READ', frame_loader_ancestry_bound: true } };
  } finally {
    if (installed && !removed) {
      try { await evaluate(removeFetchCloneObserver, spec); } catch { /* Failure cannot certify capture/removal or settlement. */ }
    }
  }
  function checkBinding() {
    binding.verify(); assert.equal(binding.frame.url(), LOCAL_ORIGIN + binding.prefix); assert.equal(binding.frame.isDetached(), false);
    assert.equal(binding.frame.page(), binding.page); assert.equal(binding.page.context(), binding.context);
    assert.equal(binding.context.browser(), binding.browser); assert.deepEqual(binding.browser.contexts(), [binding.context]);
    assert.deepEqual(binding.context.pages(), [binding.page]); assert.equal(binding.page.isClosed(), false);
    assert.ok(Date.parse(binding.expiresAt) > Date.now());
  }
}

export async function runExportDownload(path) {
  const report = { fixture: FIXTURE, phase: 'external-export-download', result: 'FAIL', checks: {}, limitations: [
    'One actual synthetic two-tag UI export only; original issue62 remains PARTIAL.',
    'Transparent Response.clone adds stream-tee timing and memory observation; SDK response body is NOT_READ.',
    'Root must independently read back process exits, filesystem and unchanged logical/audit/publication/guard/script/role/image state.',
    'Identity/device/HTTPS/inbox/restart/app-stopped dispatch/full native compatibility gates are not established by this case.',
  ] };
  const gate = new ManagerReadGate(); let manager, filesystem, policy, captured, stage = 'local_inputs';
  const joiner = new ExportResponseJoin(() => policy?.invalidate());
  const started = request => { gate.started(request); joiner.started(request); };
  const responded = response => joiner.responded(response);
  try {
    report.probe_sources_sha256 = Object.fromEntries(['browser_export_download.mjs', 'browser_download_policy.mjs', 'browser_download_inert.mjs',
      'download_artifact.mjs', 'fetch_clone.mjs', 'browser_manager_readonly.mjs', 'browser_manager.mjs', 'browser_external.mjs',
      'browser.mjs', 'browser_inputs.mjs', 'browser_progress.mjs'].map(name => [name, hash(readFileSync(join(REPOSITORY, 'scripts/haos_acceptance', name)))]));
    const inputs = readPublicInputs(path); filesystem = openCaseLease('export');
    Object.assign(report, { configuration_sha256: inputs.configuration_sha256, declared_candidate: inputs.document.candidate, declared_bridge: inputs.document.bridge });
    manager = await openNativeManager(inputs, report, { externalBrowser: true, exportDownload: true,
      requestAllowed: (request, scope) => joiner.started(request) && gate.allow(request, scope), setStage: value => { stage = value; } });
    const binding = manager.externalSession.managerReadonlyBinding(); gate.bind(binding); joiner.bind(binding);
    const control = manager.externalSession.exportDownloadControl(); policy = control.policy;
    manager.page.on('request', started); manager.page.on('response', responded);
    stage = 'fresh_assignments_inventory';
    const mark = gate.mark();
    gate.check(); await withinDeadline('dom', () => manager.frame.getByRole('region', { name: 'Saved local drafts', exact: true })
      .getByRole('button', { name: 'Refresh saved drafts', exact: true }).click({ timeout: 5000 }), { timeoutMs: 5000 }); gate.check();
    const assignments = await gate.read('assignments?offset=0&limit=100', mark);
    const overview = gate.mark(), inventory = await gate.read('tags?offset=0&limit=100', overview), status = await gate.read('status', overview);
    report.checks.saved_rows = { ...assessManagerRows({ assignments: assignments.body, inventory: inventory.body }), receipt: assignments.receipt };
    report.checks.inventory = { fresh_normal_ui_get: true, receipt: inventory.receipt };
    report.checks.connection = { ...assessManagerConnection(status.body), receipt: status.receipt };
    stage = 'normal_ui_export'; filesystem.verify();
    captured = await captureExport({ binding, policy, pageSession: control.pageSession, joiner, inventory: inventory.body,
      click: () => manager.frame.getByRole('region', { name: 'Export and recovery', exact: true })
        .getByRole('button', { name: 'Download mapping export', exact: true }).click({ timeout: 5000 }) });
    report.checks.export = captured.evidence; gate.check(); await manager.externalSession.checkWorkers(true); gate.check();
    const verifyArtifact = () => {
      filesystem.verify(); const receipt = verifyDownloadArtifact({ directory: EXPORT_CASE, guid: captured.guid, expectedBytes: captured.bytes });
      assert.equal(receipt.sha256, captured.evidence.sha256); assert.equal(receipt.bytes, captured.bytes.length); return receipt;
    };
    report.checks.artifact = verifyArtifact();
    stage = 'export_policy_revocation'; report.checks.download_policy = await policy.revoke();
    assert.equal(report.checks.download_policy.failure, null); assert.equal(report.checks.download_policy.raw_pending_before_verdict, 0);
    joiner.check(); gate.check(); filesystem.verify();
    stage = 'normal_producer_close'; assert.equal((await manager.cleanup()).cleanup_confirmed, true);
    report.checks.download_policy = policy.evidence();
    assert.equal(report.checks.download_policy.failure, null); assert.equal(report.checks.download_policy.producer_closed, true);
    assert.equal(report.checks.download_policy.producer_close_settled, true);
    assert.equal(report.checks.download_policy.handlers_removed, true); assert.equal(report.checks.download_policy.delivery_barrier_passed, true);
    report.checks.post_close_artifact = verifyArtifact(); assert.deepEqual(report.checks.post_close_artifact, report.checks.artifact);
    report.checks.external.guard = manager.externalSession.evidence(); assert.equal(report.checks.external.guard.failure, null);
    const { expected_fixture_warning, ...network } = assessNetworkBoundaries(manager.network, manager.networkCategories);
    report.checks.network_assessment = network; report.checks.expected_fixture_warning = expected_fixture_warning;
    assert.equal(joiner.evidence().failure, null); assert.equal(gate.evidence().failure, null); filesystem.close(); filesystem = undefined;
    report.result = 'PASS'; stage = 'complete';
  } catch { report.code = 'native_export_download_failed'; }
  finally {
    if (manager) { await manager.cleanup(); manager.page.off('request', started); manager.page.off('response', responded); report.checks.network = { ...manager.network }; }
    if (policy) report.checks.download_policy = policy.evidence();
    if (filesystem) { try { filesystem.close(); } catch { report.result = 'FAIL'; report.code = 'download_directory_close_failed'; } }
    gate.close(); report.checks.manager_readonly_gate = gate.evidence(); report.checks.export_join = joiner.evidence(); report.stage = stage;
    if (report.checks.download_policy?.failure || report.checks.cleanup?.cleanup_confirmed === false) report.result = 'FAIL';
    captured = undefined;
  }
  return report;
}
