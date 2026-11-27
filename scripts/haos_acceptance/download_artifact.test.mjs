/** Actual task-owned synthetic filesystem fixtures; no browser or network. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs, {
  appendFileSync, chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, renameSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ARTIFACT_ROOT, MAX_ARTIFACT_BYTES, verifyDownloadArtifact } from './download_artifact.mjs';

// Default tests may start on a clean worker. Only absent synthetic parents are
// created; existing ownership/modes and all prior cases are preserved.
for (const directory of [dirname(ARTIFACT_ROOT), ARTIFACT_ROOT]) {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const value = lstatSync(directory);
  assert.ok(value.isDirectory() && value.uid === process.getuid() && (value.mode & 0o7777) === 0o700);
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const input = (value, expectedBytes = value.bytes) => ({ directory: value.directory, guid: value.guid, expectedBytes });
function fixture(bytes = Buffer.from('SYNTHETIC Jukelet download\n')) {
  const directory = join(ARTIFACT_ROOT, 'case-' + randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  const guid = randomUUID();
  const path = join(directory, guid);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { directory, guid, path, bytes };
}

test('a complete synthetic artifact returns hashes without content or paths', () => {
  const value = fixture();
  assert.deepEqual(verifyDownloadArtifact(input(value)), {
    verified: true, bytes: value.bytes.length, sha256: hash(value.bytes), guid_sha256: hash(value.guid),
  });
});

test('different bytes cannot be certified as the expected download', () => {
  const value = fixture();
  assert.throws(() => verifyDownloadArtifact(input(value, Buffer.from('SYNTHETIC different bytes'))),
    { message: 'invalid_download_artifact' });
});

test('a symlinked artifact is rejected even when its target has the expected bytes', () => {
  const value = fixture(), target = fixture(value.bytes);
  unlinkSync(value.path);
  symlinkSync(target.path, value.path);
  assert.deepEqual(readdirSync(value.directory), [value.guid]);
  assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' });
});

test('a hardlinked artifact is rejected even when its bytes and permissions match', () => {
  const value = fixture(), sibling = fixture();
  linkSync(value.path, join(sibling.directory, 'SYNTHETIC_HARDLINK'));
  assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' });
});

test('a symlinked case directory is not a valid root for an artifact', () => {
  const value = fixture(), alias = join(ARTIFACT_ROOT, 'alias-' + randomUUID());
  symlinkSync(value.directory, alias);
  assert.throws(() => verifyDownloadArtifact({ ...input(value), directory: alias }), { message: 'invalid_download_artifact' });
});

test('parent traversal in an observed GUID cannot select a different owned file', () => {
  const value = fixture(), other = fixture();
  const guid = '../' + other.directory.split('/').at(-1) + '/' + other.guid;
  assert.throws(() => verifyDownloadArtifact({ ...input(value), guid }), { message: 'invalid_download_artifact' });
});

test('an extra partial download prevents certification of the expected artifact', () => {
  const value = fixture();
  writeFileSync(value.path + '.crdownload', 'SYNTHETIC incomplete', { mode: 0o600 });
  assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' });
});

test('opaque Unicode, whitespace, backslashes and binary bytes remain exact', () => {
  for (const bytes of [Buffer.from('SYNTHETIC\n  Å-tag\\opaque\t雪\n'), Buffer.from(Array.from({ length: 256 }, (_, index) => index))]) {
    const value = fixture(bytes);
    assert.equal(verifyDownloadArtifact(input(value)).sha256, hash(bytes));
    assert.deepEqual(readFileSync(value.path), bytes);
  }
});

test('same-length wrong bytes and empty, truncated or oversized artifacts fail', () => {
  const value = fixture();
  const wrong = Buffer.alloc(value.bytes.length, 0x78);
  assert.throws(() => verifyDownloadArtifact(input(value, wrong)), { message: 'invalid_download_artifact' });
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(value.bytes.length - 1), Buffer.alloc(MAX_ARTIFACT_BYTES + 1)]) {
    const altered = fixture(bytes);
    assert.throws(() => verifyDownloadArtifact(input(altered, value.bytes)), { message: 'invalid_download_artifact' });
  }
});

test('public or special file permissions and public case permissions fail', () => {
  for (const mode of [0o644, 0o400, 0o4600]) {
    const value = fixture(); chmodSync(value.path, mode);
    assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' });
  }
  const value = fixture(); chmodSync(value.directory, 0o755);
  try { assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' }); }
  finally { chmodSync(value.directory, 0o700); }
});

test('missing files, directories masquerading as files and hidden extra entries fail', () => {
  const missing = fixture(); renameSync(missing.path, missing.path + '-renamed');
  assert.throws(() => verifyDownloadArtifact(input(missing)), { message: 'invalid_download_artifact' });
  const nonregular = fixture(); unlinkSync(nonregular.path);
  mkdirSync(nonregular.path, { mode: 0o700 });
  assert.deepEqual(readdirSync(nonregular.directory), [nonregular.guid]);
  assert.throws(() => verifyDownloadArtifact(input(nonregular)), { message: 'invalid_download_artifact' });
  const extra = fixture(); writeFileSync(join(extra.directory, '.SYNTHETIC_hidden'), 'synthetic', { mode: 0o600 });
  assert.throws(() => verifyDownloadArtifact(input(extra)), { message: 'invalid_download_artifact' });
});

test('a FIFO is rejected without blocking even when it is the only named entry', () => {
  const value = fixture(); unlinkSync(value.path);
  const setup = spawnSync('/usr/bin/mkfifo', ['-m', '600', value.path], { encoding: 'utf8' });
  assert.equal(setup.status, 0);
  const program = `import {verifyDownloadArtifact} from './download_artifact.mjs';
    try { verifyDownloadArtifact(JSON.parse(process.argv[1], (key, value) => key === 'expectedBytes' ? Buffer.from(value) : value)); process.exitCode=1; }
    catch (error) { if (error.message !== 'invalid_download_artifact') process.exitCode=2; }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program,
    JSON.stringify({ directory: value.directory, guid: value.guid, expectedBytes: [...value.bytes] })],
    { cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 2000 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0);
});

test('unsafe GUIDs, noncanonical or outside directories, and extra options fail', () => {
  const value = fixture();
  for (const guid of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', ' with-space', 'x'.repeat(129), 7]) {
    assert.throws(() => verifyDownloadArtifact({ ...input(value), guid }), { message: 'invalid_download_artifact' });
  }
  for (const directory of [ARTIFACT_ROOT, value.directory + '/', value.directory + '/.',
    value.directory + '/../' + value.directory.split('/').at(-1), './relative', dirnameForTest(value.directory)]) {
    assert.throws(() => verifyDownloadArtifact({ ...input(value), directory }), { message: 'invalid_download_artifact' });
  }
  assert.throws(() => verifyDownloadArtifact({ ...input(value), suggestedFilename: value.guid }), { message: 'invalid_download_artifact' });
});

function dirnameForTest(directory) { return directory.replace('/artifacts/', '/notes/'); }

test('missing or oversized expected bytes and non-object inputs fail with a fixed error', () => {
  const value = fixture();
  for (const expectedBytes of [undefined, null, '', new Uint8Array([1]), Buffer.alloc(0), Buffer.alloc(MAX_ARTIFACT_BYTES + 1)]) {
    assert.throws(() => verifyDownloadArtifact({ directory: value.directory, guid: value.guid, expectedBytes }),
      { message: 'invalid_download_artifact' });
  }
  for (const candidate of [undefined, null, [], 0, Object.create(input(value))]) {
    assert.throws(() => verifyDownloadArtifact(candidate), { message: 'invalid_download_artifact' });
  }
});

function intercept(testContext, method, replacement) {
  testContext.mock.method(fs, method, replacement);
  syncBuiltinESMExports();
  return () => { testContext.mock.restoreAll(); syncBuiltinESMExports(); };
}

test('a maximum-size file is bounded, exact and unchanged after readonly verification', t => {
  const value = fixture(Buffer.alloc(MAX_ARTIFACT_BYTES, 0x53)), before = lstatSync(value.path, { bigint: true });
  let total = 0;
  const original = fs.readSync;
  const restore = intercept(t, 'readSync', (...args) => {
    assert.ok(args[3] <= MAX_ARTIFACT_BYTES);
    const count = original(...args); total += count; return count;
  });
  try {
    const result = verifyDownloadArtifact(input(value));
    assert.equal(result.bytes, MAX_ARTIFACT_BYTES); assert.equal(total, MAX_ARTIFACT_BYTES);
    const after = lstatSync(value.path, { bigint: true });
    for (const field of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field]);
    assert.equal(Object.isFrozen(result), true);
  } finally { restore(); }
});

test('an observed foreign file owner is rejected without changing any filesystem ownership', t => {
  const value = fixture(), original = fs.fstatSync;
  const restore = intercept(t, 'fstatSync', (...args) => {
    const observation = original(...args);
    if (observation.isFile()) observation.uid += 1n;
    return observation;
  });
  try { assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' }); }
  finally { restore(); }
  assert.equal(lstatSync(value.path).uid, process.getuid());
});

test('expected bytes are snapshotted rather than borrowed during a read', t => {
  const value = fixture(), expected = Buffer.from(value.bytes), original = fs.readSync;
  const restore = intercept(t, 'readSync', (...args) => {
    expected.fill(0x58);
    return original(...args);
  });
  try { assert.equal(verifyDownloadArtifact(input(value, expected)).sha256, hash(value.bytes)); }
  finally { restore(); }
});

test('an observable file growth during the real read is rejected', t => {
  const value = fixture(), original = fs.readSync;
  let changed = false;
  const restore = intercept(t, 'readSync', (...args) => {
    const count = original(...args);
    if (!changed) { changed = true; appendFileSync(value.path, 'SYNTHETIC concurrent append'); }
    return count;
  });
  try { assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' }); }
  finally { restore(); }
});

test('same-size mutation with changed file metadata during the read is rejected', t => {
  const value = fixture(), original = fs.readSync;
  let changed = false;
  const restore = intercept(t, 'readSync', (...args) => {
    const count = original(...args);
    if (!changed) {
      changed = true; writeFileSync(value.path, Buffer.alloc(value.bytes.length, 0x58));
      // Only this synthetic fixture's timestamps change; no clock or expiry file is touched.
      utimesSync(value.path, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
    }
    return count;
  });
  try { assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' }); }
  finally { restore(); }
});

test('a directory rename and same-byte replacement during the read is rejected', t => {
  const value = fixture(), original = fs.readSync;
  let changed = false;
  const restore = intercept(t, 'readSync', (...args) => {
    const count = original(...args);
    if (!changed) {
      changed = true; renameSync(value.directory, value.directory + '-moved');
      mkdirSync(value.directory, { mode: 0o700 }); writeFileSync(value.path, value.bytes, { mode: 0o600 });
    }
    return count;
  });
  try { assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' }); }
  finally { restore(); }
});

test('a real truncation causing premature EOF fails closed', t => {
  const value = fixture(), original = fs.readSync;
  let changed = false;
  const restore = intercept(t, 'readSync', (...args) => {
    if (!changed) { changed = true; truncateSync(value.path, 0); }
    return original(...args);
  });
  try { assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' }); }
  finally { restore(); }
});

function artifactDescriptors() {
  return readdirSync('/proc/self/fd').flatMap(name => {
    try { const path = readlinkSync('/proc/self/fd/' + name); return path.startsWith(ARTIFACT_ROOT) ? [name] : []; }
    catch { return []; }
  });
}

test('success and repeated validation failures release every owned descriptor', () => {
  const value = fixture(), before = artifactDescriptors();
  for (let index = 0; index < 40; index += 1) {
    verifyDownloadArtifact(input(value));
    assert.throws(() => verifyDownloadArtifact(input(value, Buffer.alloc(value.bytes.length))), { message: 'invalid_download_artifact' });
  }
  assert.deepEqual(artifactDescriptors(), before);
});

test('I/O failures release descriptors and expose neither paths nor raw private-looking content', t => {
  const value = fixture(), before = artifactDescriptors();
  const restore = intercept(t, 'readSync', () => { throw new Error('SYNTHETIC_PRIVATE_DATA ' + value.path); });
  try {
    assert.throws(() => verifyDownloadArtifact(input(value)), error => {
      assert.equal(error.message, 'invalid_download_artifact');
      assert.equal(error.stack, 'Error: invalid_download_artifact');
      assert.equal(JSON.stringify(error).includes(value.path), false); return true;
    });
    assert.deepEqual(artifactDescriptors(), before);
  } finally { restore(); }
});

test('a reported close error fails certification while every remaining descriptor is closed', t => {
  const value = fixture(), before = artifactDescriptors(), original = fs.closeSync;
  let first = true;
  const restore = intercept(t, 'closeSync', (...args) => {
    const result = original(...args);
    if (first) { first = false; throw new Error('SYNTHETIC close error after real close'); }
    return result;
  });
  try {
    assert.throws(() => verifyDownloadArtifact(input(value)), { message: 'invalid_download_artifact' });
    assert.deepEqual(artifactDescriptors(), before);
  } finally { restore(); }
});

test('verification issues no explicit filesystem write or mutation operation', t => {
  const value = fixture();
  for (const method of ['writeFileSync', 'appendFileSync', 'chmodSync', 'unlinkSync', 'renameSync', 'truncateSync', 'mkdirSync']) {
    t.mock.method(fs, method, () => { throw new Error('SYNTHETIC forbidden verifier mutation'); });
  }
  syncBuiltinESMExports();
  try { assert.equal(verifyDownloadArtifact(input(value)).verified, true); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('evaluating the exact module source performs none of its filesystem operations', async t => {
  // A file URL necessarily invokes the Node loader's realpath I/O. A data URL
  // isolates evaluation of these exact bytes from that required loader work.
  const source = readFileSync(new URL('./download_artifact.mjs', import.meta.url));
  let calls = 0;
  for (const method of ['openSync', 'closeSync', 'fstatSync', 'lstatSync', 'readSync', 'readdirSync', 'realpathSync']) {
    t.mock.method(fs, method, () => { calls += 1; throw new Error('SYNTHETIC forbidden import I/O'); });
  }
  syncBuiltinESMExports();
  try {
    await import('data:text/javascript;base64,' + source.toString('base64'));
    assert.equal(calls, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
