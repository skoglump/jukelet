/** Synthetic SDK/CDP/clone joins. These do not certify actual HA or Chrome. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ALBUM_TAG, PLAYLIST_TAG, ALBUM_URI, PLAYLIST_URI } from './browser_manager.mjs';
import { LOCAL_ORIGIN } from './browser_inputs.mjs';
import { createExportDownloadPolicy } from './browser_download_policy.mjs';
import { assessCurrentExport, identifyExportFrame, ExportResponseJoin, captureExport } from './browser_export_download.mjs';
import { installFetchCloneObserver, readFetchCloneObserver, removeFetchCloneObserver } from './fetch_clone.mjs';
const prefix = '/api/hassio_ingress/SYNTHETIC_EXPORT/';
const inventory = { tags: [{ ha_tag_id: ALBUM_TAG, name: 'Album snö ☃' }, { ha_tag_id: PLAYLIST_TAG, name: 'Lista å' }] };
function document() {
  return { schema_version: 1, provenance: { application: 'jukelet', exported_at: '2026-11-05T00:00:00Z', local_revision: 13,
    names_updated_at: '2026-11-05T00:00:00Z', names_stale: false }, assignments:
    [[ALBUM_TAG, ALBUM_URI, 'album', false], [PLAYLIST_TAG, PLAYLIST_URI, 'playlist', true]].map(([id, uri, media, shuffle], i) => ({
      ha_tag_id: id, spotify_uri: uri, media_type: media, enabled: true, shuffle, playback_profile_id: 'default', name: inventory.tags[i].name })) };
}
const bytes = () => Buffer.from(JSON.stringify(document()));
function fixture(options = {}) {
  let changed = false, removal = 0, installed = 0;
  const parent = { url: () => LOCAL_ORIGIN + '/hassio/ingress/jukelet', parentFrame: () => null };
  const session = new EventEmitter(), pageSession = new EventEmitter(), calls = [];
  session.send = async (name, args) => { calls.push([name, args]);
    if (options.refuse && name === 'Browser.setDownloadBehavior' && args.behavior === options.refuse) throw new Error('PRIVATE token');
    return name === 'Target.getBrowserContexts' ? { browserContextIds: [] } : {}; };
  const frame = { url: () => LOCAL_ORIGIN + prefix, page: () => page, isDetached: () => false, parentFrame: () => parent,
    evaluate: async (fn, spec) => {
      assert.equal(spec.slot, '__jukeletIssue62FetchClone'); assert.match(spec.token, /^[a-f0-9-]{36}$/);
      if (fn === installFetchCloneObserver) { installed++; assert.equal(spec.url, LOCAL_ORIGIN + prefix + 'api/v1/export'); return { armed: true }; }
      if (fn === removeFetchCloneObserver) { removal++; return { restored: !options.removeFailure, matched_count: 1, clone_count: 1 }; }
      assert.equal(fn, readFetchCloneObserver);
      const body = options.body ?? bytes();
      return { result: options.cloneResult ?? 'PASS', status: 200, matched_count: options.cloneDuplicate ? 2 : 1,
        native_fetch_count: 1, clone_count: 1, original_fetch_restored: true, clone_body_used: !options.unreadClone,
        original_body_used_at_clone: false, original_body_used_after_clone: true, original_body_used_current: true, bytes_read: body.length, export_bytes: [...body] };
    } };
  const context = { browser: () => browser, pages: () => [page] }, browser = { contexts: () => [context] };
  const page = { context: () => context, url: parent.url, mainFrame: () => parent, isClosed: () => false };
  const target = { type: 'page', targetId: 'owned', url: parent.url() };
  const tree = { frame: { id: 'core', loaderId: 'core-doc', url: parent.url() }, childFrames: [
    { frame: { id: 'app', parentId: 'core', loaderId: 'app-doc', url: frame.url() } }] };
  pageSession.send = async name => {
    if (name === 'Target.getTargetInfo') return { targetInfo: target };
    return { frameTree: tree };
  };
  const binding = { browser, context, page, frame, prefix, expiresAt: new Date(Date.now() + 300000).toISOString(), principalHash: '1'.repeat(64),
    verify: () => { if (changed) throw new Error('PRIVATE principal lost'); } };
  const request = { url: () => LOCAL_ORIGIN + prefix + 'api/v1/export' + (options.query ? '?q=1' : ''), method: () => options.method ?? 'GET',
    postData: () => options.postBody ?? null, frame: () => options.parentFrame ? parent : frame,
    redirectedFrom: () => options.redirect ? {} : null, redirectedTo: () => null };
  const response = { request: () => request, url: request.url, status: () => options.status ?? 200,
    headerValue: async () => options.contentType ?? 'application/json; charset=utf-8', body: () => assert.fail('SDK body must remain NOT_READ') };
  return { binding, session, pageSession, calls, tree, target, frame, parent, request, response, changed: () => { changed = true; },
    get removal() { return removal; }, get installed() { return installed; } };
}
async function run(options = {}) {
  const f = fixture(options), policy = await createExportDownloadPolicy({ session: f.session, isTransportConnected: () => true, verify: f.binding.verify, operationMs: 30 });
  const joiner = new ExportResponseJoin(() => policy.invalidate()); joiner.bind(f.binding);
  let result, error;
  try {
    result = await captureExport({ binding: f.binding, policy, pageSession: f.pageSession, joiner, inventory,
      click: async () => {
        joiner.started(f.request);
        if (options.duplicate) joiner.started({ ...f.request });
        const begin = () => {
          f.session.emit('Browser.downloadWillBegin', { guid: 'fresh-guid', frameId: options.downloadParent ? 'core' : 'app',
            url: 'blob:' + LOCAL_ORIGIN + '/11111111-2222-3333-4444-555555555555', suggestedFilename: 'jukelet-export-v1.json' });
          f.session.emit('Browser.downloadProgress', { guid: 'fresh-guid', state: 'completed', receivedBytes: options.count ?? bytes().length,
            totalBytes: options.count ?? bytes().length });
        };
        if (options.responseFirst) { if (!options.missingResponse) joiner.responded(f.response); if (!options.missingDownload) begin(); }
        else { if (!options.missingDownload) begin(); if (!options.missingResponse) joiner.responded(f.response); }
        if (options.sourceLoss) f.changed();
        if (options.loaderChange) f.tree.childFrames[0].frame.loaderId = 'replacement';
        if (options.frameEvent) f.pageSession.emit('Page.frameNavigated', {});
      } });
  } catch (value) { error = value; }
  let producerClosed = false;
  const evidence = await policy.close({ closeProducer: async () => { producerClosed = true;
    return { cleanup_confirmed: true, owned_page_close_completed: true, native_disconnect_confirmed: true, sdk_disconnected: true };
  }, isProducerOpen: () => !producerClosed, isProducerClosed: () => producerClosed });
  return { f, result, error, evidence };
}
for (const responseFirst of [true, false]) test(`exact actual-response and download join supports responseFirst=${responseFirst}`, async () => {
  const value = await run({ responseFirst }); assert.equal(value.error, undefined);
  assert.deepEqual(value.result.bytes, bytes()); assert.equal(value.result.evidence.sdk_body, 'NOT_READ');
  assert.equal(value.result.evidence.local_revision, 13); assert.equal(value.evidence.failure, null);
  assert.equal(value.f.removal, 1); assert.equal(value.evidence.raw_pending_before_verdict, 0);
});
for (const [label, options] of Object.entries({ query: { query: true }, method: { method: 'POST' }, requestBody: { postBody: '{}' },
  sameOriginCoreParentRequest: { parentFrame: true }, sameOriginCoreParentDownload: { downloadParent: true }, duplicate: { duplicate: true },
  redirect: { redirect: true }, status: { status: 302 }, contentType: { contentType: 'text/plain' }, empty: { body: Buffer.alloc(0) },
  invalidUTF8: { body: Buffer.from([0xff]) }, duplicateJSON: { body: Buffer.from('{"schema_version":1,"schema_version":1}') },
  oversized: { body: Buffer.alloc(8193) }, cloneTimeout: { cloneResult: 'TIMEOUT' }, duplicateClone: { cloneDuplicate: true }, unreadClone: { unreadClone: true },
  countMismatch: { count: 1 }, principalLost: { sourceLoss: true }, loaderChange: { loaderChange: true },
  frameEvent: { frameEvent: true }, removalFailed: { removeFailure: true } })) {
  test(`real actor rejects ${label} without SDK body fallback`, async () => {
    const value = await run(options); assert.ok(value.error); assert.equal(value.result, undefined);
    assert.doesNotMatch(JSON.stringify(value.evidence), /PRIVATE|SYNTHETIC_EXPORT|fresh-guid|blob:/);
    assert.equal(value.evidence.raw_pending_before_verdict, 0);
  });
}
test('AppFrame identity rejects same-origin parent, ambiguous match and absent/changed loader', () => {
  const f = fixture(), original = identifyExportFrame(f.tree, f.binding, f.target); assert.equal(original.frameId, 'app');
  f.tree.childFrames.push(structuredClone(f.tree.childFrames[0])); assert.throws(() => identifyExportFrame(f.tree, f.binding, f.target));
  f.tree.childFrames.pop(); delete f.tree.childFrames[0].frame.loaderId; assert.throws(() => identifyExportFrame(f.tree, f.binding, f.target));
});
for (const mutate of [d => { d.assignments[0].version = 9; }, d => { d.provenance.local_revision = 11; },
  d => { d.assignments[0].ha_tag_id += ' '; }, d => { d.assignments[0].name = 'stale'; },
  d => { d.assignments[0].shuffle = true; }, d => { d.assignments[0].media_type = 'track'; }]) {
  test('current export schema rejects noncanonical fields/content', () => {
    const d = document(); mutate(d); assert.throws(() => assessCurrentExport(Buffer.from(JSON.stringify(d)), inventory));
  });
}
test('unarmed and late request observers fail even when route aborts and wrapper has restored', async () => {
  for (const armed of [false, true]) {
    const f = fixture(), joiner = new ExportResponseJoin(); joiner.bind(f.binding);
    if (armed) { joiner.arm(); assert.equal(joiner.started(f.request), true); }
    assert.equal(joiner.started({ ...f.request }), false); assert.equal(joiner.evidence().failure, 'export_request_unverified');
  }
});

for (const missing of ['missingResponse', 'missingDownload']) test(`bounded real actor ${missing} is terminal without another request`, async () => {
  const value = await run({ [missing]: true }); assert.ok(value.error); assert.equal(value.result, undefined);
  assert.equal(value.f.installed, 1); assert.equal(value.f.removal, 0);
  assert.ok(value.evidence.failure);
});

test('a response after the original finite deadline stays rejected and cannot revive polling', async () => {
  const f = fixture(), joiner = new ExportResponseJoin(); joiner.bind(f.binding); joiner.arm();
  assert.equal(joiner.started(f.request), true); await assert.rejects(joiner.joined(), /^Error: export_response_unverified$/);
  joiner.responded(f.response);
  assert.deepEqual(joiner.evidence(), { attempts: 1, responses: 0, failure: 'export_request_unverified' });
});
