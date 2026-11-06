/** Reviewed disposable-test profiles only; importing performs no I/O. */
import assert from 'node:assert/strict';
import { ARTIFACT_ROOT } from './download_artifact.mjs';

export const MINIMUM_CORE_VERSION = '2026.10.3';
const profile = (core_version, worker_asset_path, worker_asset_sha256, worker_asset_bytes, label) => Object.freeze({
  core_version, worker_asset_path, worker_asset_sha256, worker_asset_bytes,
  cases: Object.freeze({ positive: `${ARTIFACT_ROOT}/dlp2-cm2-${label}-positive`,
    wrongframe: `${ARTIFACT_ROOT}/dlp2-cm2-${label}-wrongframe`, export: `${ARTIFACT_ROOT}/ingress-cm2-${label}-export` }),
});
// Root independently matched installed public bytes to CA/hostname-verified GETs.
// These are harness provenance allowlists, not a product support-version policy.
const PROFILES = Object.freeze({
  '2026.10.3': profile('2026.10.3', '/frontend_latest/markdown-worker.668dcd3bda774ac2.js',
    'e82decd9849c488ffed18e20ec6e4d2bf81eeb01c69bf6088e625baf917801ad', 95697, 'min'),
  '2026.11.0': profile('2026.11.0', '/frontend_latest/markdown-worker.7fcdb971f47a98ea.js',
    '090f8b0e7fbda16691184f7e47a16813a58f6b3f2233095a7f07c77a5b8e47d9', 99463, 'stable'),
});

export function reviewedCoreProfile(version) {
  assert.ok(typeof version === 'string' && Object.hasOwn(PROFILES, version), 'unreviewed_core_profile');
  return PROFILES[version];
}
