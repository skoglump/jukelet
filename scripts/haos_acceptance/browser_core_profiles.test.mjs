/** Exact disposable provenance controls; no native services or private files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedCoreProfile } from './browser_core_profiles.mjs';
import { readExternalCoreSelection, EXTERNAL_WORKER_POLICY_SHA256, WORKER_EGRESS_REPORT_SHA256 } from './browser_external.mjs';
import { CONTROL_ROOT, FIXTURE, LOCAL_ORIGIN, hash } from './browser_inputs.mjs';

const now = Date.parse('2026-11-06T00:00:00Z');
function fixture(version) {
  const selected = reviewedCoreProfile(version), observed_at = new Date(now).toISOString();
  const preflight = { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN,
    session_id: '1'.repeat(32), controller_pid: 10, proxy_port: 19764, connect_authority: '127.0.0.1:18223', raw_connect_only: true,
    outside_forwarded: 0, same_policy_sha256: EXTERNAL_WORKER_POLICY_SHA256, same_policy_report_sha256: '9'.repeat(64),
    same_policy_positive_control_verified: true, same_policy_registrations: 0, same_policy_sdk_workers: 0,
    same_policy_cdp_workers: 0, same_policy_worker_script_requests: 0, same_policy_escape_hits: 0, observed_at };
  const preflightBytes = Buffer.from(JSON.stringify(preflight));
  const lease = { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN, session_id: preflight.session_id,
    configuration_A_sha256: '2'.repeat(64), actual_candidate_image_manifest_digest: 'sha256:' + '3'.repeat(64),
    actual_bridge_archive_sha256: '4'.repeat(64), admin_A_user_id_sha256: hash('SYNTHETIC ADMIN'), ingress_prefix_sha256: '5'.repeat(64),
    certificate_sha256: '6'.repeat(64), controller_pid: 10, controller_start_ticks: '100', chrome_pid: 20, chrome_start_ticks: '200',
    executable_sha256: '7'.repeat(64), profile_basename: 'external-profile-' + '1'.repeat(32), fresh_profile: true,
    cdp_port: 19367, cdp_endpoint: 'ws://127.0.0.1:19367/devtools/browser/11111111-2222-3333-4444-555555555555',
    proxy_port: preflight.proxy_port, argv_sha256: '8'.repeat(64), worker_policy_sha256: EXTERNAL_WORKER_POLICY_SHA256,
    process_preflight_sha256: hash(preflightBytes), observed_at };
  const parent = { schema_version: 1, fixture: FIXTURE, synthetic: true, origin: LOCAL_ORIGIN, session_id: lease.session_id,
    configuration_A_sha256: lease.configuration_A_sha256, actual_core_version: selected.core_version,
    worker_asset_path: selected.worker_asset_path, worker_asset_sha256: selected.worker_asset_sha256,
    worker_asset_bytes: selected.worker_asset_bytes, public_assets_readback_sha256: 'a'.repeat(64),
    egress_control_report_sha256: WORKER_EGRESS_REPORT_SHA256, native_proxy_readback_sha256: hash(preflightBytes),
    worker_policy_sha256: EXTERNAL_WORKER_POLICY_SHA256, observed_at };
  const docs = { 'external-browser-ready.json': lease, 'external-browser-preflight.json': preflight, 'external-parent-worker-ready.json': parent };
  const inputs = { configuration_sha256: lease.configuration_A_sha256 };
  const read = (name, limit) => { assert.equal(limit, 16384); assert.ok(name.startsWith(CONTROL_ROOT + '/'));
    return Buffer.from(JSON.stringify(docs[name.slice(CONTROL_ROOT.length + 1)])); };
  return { parent, lease, preflight, docs, inputs, read, clock: () => now };
}

for (const version of ['2026.10.3', '2026.11.0']) {
  test(`${version} directory selection is exact, immutable and grants no browser authority`, () => {
    const f = fixture(version), selection = readExternalCoreSelection(f.inputs, f);
    assert.equal(selection.coreVersion, version); selection.verify(); assert.equal(Object.isFrozen(selection), true);
    assert.deepEqual(Object.keys(selection).sort(), ['coreVersion', 'verify']);
    const profile = reviewedCoreProfile(version); assert.equal(Object.isFrozen(profile), true); assert.equal(Object.isFrozen(profile.cases), true);
    const label = version === '2026.10.3' ? 'min' : 'stable';
    assert.match(profile.cases.positive, new RegExp(`/dlp2-cm2-${label}-positive$`));
    assert.match(profile.cases.wrongframe, new RegExp(`/dlp2-cm2-${label}-wrongframe$`));
    assert.match(profile.cases.export, new RegExp(`/ingress-cm2-${label}-export$`));
    assert.throws(() => { profile.cases.export = '/PRIVATE'; });
  });
  for (const [label, damage] of Object.entries({
    crossProfile: f => { f.parent.actual_core_version = version === '2026.10.3' ? '2026.11.0' : '2026.10.3'; },
    path: f => { f.parent.worker_asset_path += '?PRIVATE'; },
    absoluteURL: f => { f.parent.worker_asset_path = LOCAL_ORIGIN + f.parent.worker_asset_path; },
    hash: f => { f.parent.worker_asset_sha256 = '0'.repeat(64); },
    size: f => { f.parent.worker_asset_bytes++; },
    unknownVersion: f => { f.parent.actual_core_version = '2026.11.1'; },
    stale: f => { f.parent.observed_at = new Date(now - 300001).toISOString(); },
    future: f => { f.parent.observed_at = new Date(now + 1).toISOString(); },
    wrongSession: f => { f.parent.session_id = '3'.repeat(32); },
    wrongConfig: f => { f.parent.configuration_A_sha256 = '0'.repeat(64); },
    wrongProxy: f => { f.parent.native_proxy_readback_sha256 = '0'.repeat(64); },
    synthetic: f => { f.parent.synthetic = false; },
  })) test(`${version} selection rejects ${label} before directory/browser use`, () => {
    const f = fixture(version); damage(f); assert.throws(() => readExternalCoreSelection(f.inputs, f));
  });
  test(`${version} later known-profile substitution cannot change the selected case`, () => {
    const f = fixture(version), selected = readExternalCoreSelection(f.inputs, f);
    const other = fixture(version === '2026.10.3' ? '2026.11.0' : '2026.10.3');
    f.docs['external-parent-worker-ready.json'] = other.parent; assert.throws(() => selected.verify());
  });
}
test('unreviewed, coerced and inherited versions never select any profile or path', () => {
  for (const version of [null, undefined, {}, ['2026.11.0'], 2026, '__proto__', 'constructor', '2026.11.0 ', '2026.11.0b1', '../PRIVATE']) {
    assert.throws(() => reviewedCoreProfile(version), /unreviewed_core_profile/);
  }
});
