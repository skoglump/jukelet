/** Readonly local artifact observations; importing performs no filesystem I/O. */
import { createHash } from 'node:crypto';
import {
  constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export const ARTIFACT_ROOT = '/tmp/jukelet-issue62-download-preparation/artifacts';
export const MAX_ARTIFACT_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = bytes => createHash('sha256').update(bytes).digest('hex');
const STAT = { bigint: true };

function requireValue(value) { if (!value) throw new Error(); }
function invalid() {
  const error = new Error('invalid_download_artifact');
  error.stack = 'Error: invalid_download_artifact';
  return error;
}
function ownedDirectory(value, uid) {
  requireValue(value.isDirectory() && value.uid === uid && (value.mode & 0o7777n) === 0o700n);
}
function ownedFile(value, uid, length) {
  requireValue(value.isFile() && value.uid === uid && (value.mode & 0o7777n) === 0o600n
    && value.nlink === 1n && value.size === BigInt(length));
}
function sameIdentity(left, right) {
  requireValue(['dev', 'ino', 'uid', 'gid', 'mode'].every(field => left[field] === right[field]));
}
function sameMetadata(left, right) {
  sameIdentity(left, right);
  requireValue(['size', 'nlink', 'mtimeNs', 'ctimeNs'].every(field => left[field] === right[field]));
}
function onlyExpectedEntry(directory, guid) {
  const entries = readdirSync(directory);
  requireValue(entries.length === 1 && entries[0] === guid);
}

/**
 * Verify a completed artifact against trusted Root-observed bytes and GUID.
 * This does not establish browser policy, download event provenance or HA access.
 * Metadata is checked at the observation points, not an atomic filesystem snapshot.
 */
export function verifyDownloadArtifact(options) {
  const descriptors = [];
  let receipt, failure;
  try {
    requireValue(process.platform === 'linux' && typeof process.getuid === 'function');
    requireValue(options && Object.getPrototypeOf(options) === Object.prototype
      && Object.keys(options).length === 3
      && ['directory', 'guid', 'expectedBytes'].every(key => Object.hasOwn(options, key)));
    const { directory, guid, expectedBytes } = options;
    requireValue(typeof directory === 'string' && resolve(directory) === directory
      && dirname(directory) === ARTIFACT_ROOT && SAFE_NAME.test(basename(directory)));
    requireValue(typeof guid === 'string' && SAFE_NAME.test(guid));
    requireValue(Buffer.isBuffer(expectedBytes) && expectedBytes.length > 0
      && expectedBytes.length <= MAX_ARTIFACT_BYTES);
    const expected = Buffer.from(expectedBytes);
    const uid = BigInt(process.getuid());
    requireValue(constants.O_DIRECTORY > 0 && constants.O_NOFOLLOW > 0 && constants.O_NONBLOCK > 0);
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const scratch = dirname(ARTIFACT_ROOT);
    requireValue(realpathSync(scratch) === scratch && realpathSync(ARTIFACT_ROOT) === ARTIFACT_ROOT);
    const scratchBefore = lstatSync(scratch, STAT), rootBefore = lstatSync(ARTIFACT_ROOT, STAT);
    ownedDirectory(scratchBefore, uid); ownedDirectory(rootBefore, uid);
    const root = openSync(ARTIFACT_ROOT, flags | constants.O_DIRECTORY); descriptors.push(root);
    const rootOpened = fstatSync(root, STAT); ownedDirectory(rootOpened, uid); sameIdentity(rootBefore, rootOpened);
    // Linux /proc FD paths anchor subsequent opens to the verified directory inode.
    const casePath = `/proc/self/fd/${root}/${basename(directory)}`;
    const caseBefore = lstatSync(casePath, STAT); ownedDirectory(caseBefore, uid);
    const folder = openSync(casePath, flags | constants.O_DIRECTORY); descriptors.push(folder);
    const caseOpened = fstatSync(folder, STAT); ownedDirectory(caseOpened, uid); sameMetadata(caseBefore, caseOpened);
    const folderPath = `/proc/self/fd/${folder}`;
    onlyExpectedEntry(folderPath, guid);
    const artifactPath = `${folderPath}/${guid}`;
    const artifact = openSync(artifactPath, flags); descriptors.push(artifact);
    const before = fstatSync(artifact, STAT); ownedFile(before, uid, expected.length);
    const bytes = Buffer.alloc(expected.length);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(artifact, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    requireValue(offset === expected.length && bytes.equals(expected));
    const after = fstatSync(artifact, STAT); ownedFile(after, uid, expected.length); sameMetadata(before, after);
    const namedAfter = lstatSync(artifactPath, STAT); ownedFile(namedAfter, uid, expected.length); sameMetadata(after, namedAfter);
    onlyExpectedEntry(folderPath, guid);
    const caseAfter = fstatSync(folder, STAT); ownedDirectory(caseAfter, uid); sameMetadata(caseOpened, caseAfter);
    sameMetadata(caseAfter, lstatSync(casePath, STAT));
    requireValue(realpathSync(directory) === directory && realpathSync(scratch) === scratch
      && realpathSync(ARTIFACT_ROOT) === ARTIFACT_ROOT);
    sameMetadata(caseAfter, lstatSync(directory, STAT));
    const rootAfter = lstatSync(ARTIFACT_ROOT, STAT); ownedDirectory(rootAfter, uid); sameIdentity(rootOpened, rootAfter);
    const scratchAfter = lstatSync(scratch, STAT); ownedDirectory(scratchAfter, uid); sameIdentity(scratchBefore, scratchAfter);
    receipt = Object.freeze({ verified: true, bytes: bytes.length, sha256: HASH(bytes), guid_sha256: HASH(guid) });
  } catch { failure = invalid(); }
  finally {
    for (const descriptor of descriptors.reverse()) {
      try { closeSync(descriptor); } catch { failure = invalid(); }
    }
  }
  if (failure) throw failure;
  return receipt;
}
