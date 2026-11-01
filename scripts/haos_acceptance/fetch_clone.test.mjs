/** Synthetic native-fetch observer controls; no network or HA. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installFetchCloneObserver, readFetchCloneObserver, removeFetchCloneObserver } from './fetch_clone.mjs';

const url = 'https://127.0.0.1:18223/api/hassio_ingress/SYNTHETIC_PREFIX/api/v1/tags/invalid/assignment?jukelet_capture=12345678-1234-1234-1234-123456789abc';
const spec = (extra = {}) => ({ slot: '__jukeletIssue62FetchClone', token: '12345678-1234-1234-1234-123456789abc', url,
  method: 'GET', body: null, timeoutMs: 100, maxBytes: 8192, ...extra });
const payload = '{"detail":"Invalid tag key"}';

test('canonical export GET observes exact clone bytes while preserving native promise/response and the original blob consumer', async () => {
  const exportURL = 'https://127.0.0.1:18223/api/hassio_ingress/SYNTHETIC_PREFIX/api/v1/export';
  const bytes = Buffer.from('{"synthetic":"Å/é 🦊"}'), response = new Response(bytes), promise = Promise.resolve(response), calls = [];
  const owner = { fetch: function (...args) { calls.push({ receiver: this, args }); return promise; } }, receiver = {};
  const expected = spec({ url: exportURL }), init = { credentials: 'same-origin', redirect: 'error' };
  installFetchCloneObserver(expected, owner); const actual = owner.fetch.call(receiver, exportURL, init);
  assert.equal(actual, promise); assert.equal(await actual, response);
  const blob = response.blob(); const observed = await readFetchCloneObserver(expected, owner);
  assert.equal(observed.result, 'PASS'); assert.equal(observed.clone_count, 1); assert.equal(observed.native_fetch_count, 1);
  assert.equal(Buffer.from(observed.export_bytes).equals(bytes), true); assert.equal(observed.body, undefined);
  assert.equal(Buffer.from(await (await blob).arrayBuffer()).equals(bytes), true);
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, receiver); assert.equal(calls[0].args[1], init);
  assert.equal(removeFetchCloneObserver(expected, owner).restored, true);
  for (const changed of [{ url: exportURL + '?jukelet_capture=12345678-1234-1234-1234-123456789abc' },
    { url: exportURL + '/' }, { method: 'PUT', body: '{}' }, { method: 'POST', body: '{}' }]) {
    assert.throws(() => installFetchCloneObserver({ ...expected, ...changed }, { fetch: () => promise }), /invalid_fetch_observer/);
  }
});

test('restore-confirm POST preserves the exact native promise/response/receiver/args and clones only its canonical reviewed body', async () => {
  const restoreURL = 'https://127.0.0.1:18223/api/hassio_ingress/SYNTHETIC_PREFIX/api/v1/restores/confirm';
  const body = JSON.stringify({ preview_token: 'R'.repeat(43), conflict_policy: 'replace', confirmed: true });
  const response = new Response('{"detail":{"code":"assignment_conflict","current_version":12}}', { status: 409 });
  const promise = Promise.resolve(response), calls = [], receiver = {};
  const native = function (...args) { calls.push({ receiver: this, args }); return promise; }, owner = { fetch: native };
  const expected = spec({ url: restoreURL, method: 'POST', body });
  installFetchCloneObserver(expected, owner);
  const init = { method: 'POST', body, credentials: 'same-origin', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'SYNTHETIC_CSRF' } };
  const actual = owner.fetch.call(receiver, restoreURL, init);
  assert.equal(actual, promise); assert.equal(await actual, response); assert.equal(owner.fetch, native);
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, receiver); assert.equal(calls[0].args[1], init);
  const observed = await readFetchCloneObserver(expected, owner);
  assert.equal(observed.result, 'PASS'); assert.equal(observed.clone_count, 1); assert.equal(observed.original_body_used_current, false);
  assert.deepEqual(observed.body, { detail: { code: 'assignment_conflict', current_version: 12 } });
  assert.equal(removeFetchCloneObserver(expected, owner).restored, true);
  assert.deepEqual(await response.json(), observed.body);
});

test('POST eligibility is restricted to the exact restore confirmation schema and bounded token/body', () => {
  const restoreURL = 'https://127.0.0.1:18223/api/hassio_ingress/SYNTHETIC_PREFIX/api/v1/restores/confirm';
  const body = { preview_token: 'R'.repeat(43), conflict_policy: 'replace', confirmed: true };
  const variants = [
    { url: restoreURL.replace('/confirm', '/preview') }, { url: restoreURL + '?x=1' }, { url: restoreURL.replace('18223', '28223') },
    { method: 'GET', body: null }, { method: 'PUT' }, { body: JSON.stringify({ ...body, conflict_policy: 'skip' }) },
    { body: JSON.stringify({ ...body, confirmed: false }) }, { body: JSON.stringify({ ...body, preview_token: 'R'.repeat(31) }) },
    { body: JSON.stringify({ ...body, preview_token: 'R'.repeat(129) }) }, { body: JSON.stringify({ ...body, extra: true }) },
    { body: JSON.stringify(body).replace('"confirmed":true', '"confirmed":true,"confirmed":true') },
    { body: ' '.repeat(8193) }, { body: 'null' },
  ];
  for (const changed of variants) {
    const native = () => { throw new Error('must_not_fetch'); }, owner = { fetch: native };
    assert.throws(() => installFetchCloneObserver(spec({ url: restoreURL, method: 'POST', body: JSON.stringify(body), ...changed }), owner), /invalid_fetch_observer/);
    assert.equal(owner.fetch, native); assert.equal(owner.__jukeletIssue62FetchClone, undefined);
  }
});

test('POST mismatched URL/method/body/header descriptors delegate unchanged without reading private header values or cloning', async () => {
  const restoreURL = 'https://127.0.0.1:18223/api/hassio_ingress/SYNTHETIC_PREFIX/api/v1/restores/confirm';
  const body = JSON.stringify({ preview_token: 'R'.repeat(43), conflict_policy: 'replace', confirmed: true });
  const promises = [], originals = [], counts = [], calls = [];
  const native = function (...args) {
    calls.push({ receiver: this, args }); const response = new Response('{"detail":{"code":"assignment_conflict","current_version":12}}', { status: 409 });
    const index = counts.length, clone = response.clone.bind(response); counts.push(0); response.clone = () => { counts[index] += 1; return clone(); };
    originals.push(response); const promise = Promise.resolve(response); promises.push(promise); return promise;
  };
  const owner = { fetch: native }, expected = spec({ url: restoreURL, method: 'POST', body }); installFetchCloneObserver(expected, owner);
  const good = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'SYNTHETIC_PRIVATE_CSRF' }, accessor = { 'Content-Type': 'application/json' };
  let privateReads = 0; Object.defineProperty(accessor, 'X-CSRF-Token', { enumerable: true, get() { privateReads += 1; throw new Error('must_not_read'); } });
  const extra = { ...good }; Object.defineProperty(extra, 'Authorization', { enumerable: true, get() { privateReads += 1; throw new Error('must_not_read'); } });
  const variants = [[restoreURL.replace('/confirm', '/preview'), { method: 'POST', body, headers: good }],
    [restoreURL, { method: 'PUT', body, headers: good }], [restoreURL, { method: 'POST', body: body + ' ', headers: good }],
    ...[undefined, { ...good, 'Content-Type': 'text/plain' }, accessor, extra, new Headers(good)].map(headers => [restoreURL, { method: 'POST', body, headers }])];
  const receiver = {};
  for (const args of variants) { const actual = owner.fetch.apply(receiver, args); assert.equal(actual, promises.at(-1)); assert.equal(await actual, originals.at(-1)); }
  assert.equal(privateReads, 0); assert.ok(counts.every(value => value === 0));
  const init = { method: 'POST', body, headers: good }; assert.equal(await owner.fetch.call(receiver, restoreURL, init), originals.at(-1));
  assert.equal((await readFetchCloneObserver(expected, owner)).clone_count, 1); assert.equal(owner.fetch, native);
  assert.equal(calls.at(-1).args[1], init); assert.ok(calls.every(value => value.receiver === receiver));
  assert.deepEqual(counts, [...variants.map(() => 0), 1]); assert.equal(removeFetchCloneObserver(expected, owner).restored, true);
});

test('observer returns the identical native promise with unchanged receiver and arguments', async () => {
  const nativePromise = Promise.resolve(new Response('{"detail":"Invalid tag key"}', { status: 422 }));
  const calls = [], receiver = {}, init = { method: 'GET', credentials: 'same-origin' };
  const owner = { fetch: function (...args) { calls.push({ receiver: this, args }); return nativePromise; } };
  installFetchCloneObserver(spec(), owner);
  const returned = owner.fetch.call(receiver, url, init);
  assert.equal(returned, nativePromise);
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, receiver);
  assert.equal(calls[0].args[0], url); assert.equal(calls[0].args[1], init);
  const response = await returned;
  assert.equal(response, await nativePromise);
  const observed = await readFetchCloneObserver(spec(), owner);
  assert.equal(observed.result, 'PASS'); assert.equal(observed.original_body_used_current, false);
  assert.equal(await response.text(), payload);
  assert.equal(removeFetchCloneObserver(spec(), owner).restored, true);
});

test('one exact match restores fetch immediately and preserves its descriptor and original body bytes', async () => {
  const response = new Response(payload, { status: 422 }), native = () => Promise.resolve(response), owner = { fetch: native };
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'fetch'); installFetchCloneObserver(spec(), owner);
  const promise = owner.fetch(url); assert.equal(owner.fetch, native);
  assert.deepEqual(Object.getOwnPropertyDescriptor(owner, 'fetch'), descriptor);
  assert.equal(await promise, response);
  const value = await readFetchCloneObserver(spec(), owner);
  assert.equal(value.matched_count, 1); assert.equal(value.native_fetch_count, 1); assert.equal(value.clone_count, 1);
  assert.equal(value.original_body_used_at_clone, false); assert.equal(value.original_body_used_after_clone, false);
  assert.deepEqual(value.body, { detail: 'Invalid tag key' }); assert.equal(response.bodyUsed, false);
  removeFetchCloneObserver(spec(), owner); assert.equal(await response.text(), payload);
});

test('unmatched URL/method/payload calls delegate unchanged and are never cloned', async () => {
  const putURL = url.replace(/invalid\/assignment\?.*$/, 'a'.repeat(64) + '/assignment');
  const body = '{"expected_version":3}', calls = [], responses = [], promises = [], cloneCounts = [];
  const native = function (...args) {
    calls.push({ receiver: this, args }); const response = new Response(payload, { status: 422 }); responses.push(response);
    const index = cloneCounts.length, nativeClone = response.clone.bind(response); cloneCounts.push(0);
    response.clone = () => { cloneCounts[index] += 1; return nativeClone(); };
    const promise = Promise.resolve(response); promises.push(promise); return promise;
  };
  const owner = { fetch: native }, expected = spec({ url: putURL, method: 'PUT', body }); installFetchCloneObserver(expected, owner);
  const marker = {}, variants = [[url, { method: 'PUT', body }], [putURL, { method: 'GET' }], [putURL, { method: 'PUT', body: body + ' ' }]];
  for (const args of variants) {
    const returned = owner.fetch.apply(marker, args); assert.equal(returned, promises.at(-1));
    assert.equal(await returned, responses.at(-1));
  }
  assert.equal(owner.fetch === native, false);
  const init = { method: 'PUT', body }; const result = owner.fetch.call(marker, putURL, init);
  assert.equal(owner.fetch, native); await result;
  const captured = await readFetchCloneObserver(expected, owner);
  assert.equal(captured.clone_count, 1); assert.equal(captured.native_fetch_count, 1);
  assert.equal(calls.length, 4); assert.ok(calls.every(call => call.receiver === marker));
  assert.equal(calls.at(-1).args[1], init);
  assert.ok(responses.slice(0, -1).every(response => response.bodyUsed === false));
  assert.deepEqual(cloneCounts, [0, 0, 0, 1]);
  removeFetchCloneObserver(expected, owner);
});

test('normal original consumption proceeds concurrently without waiting for the observer or replacing its Response', async () => {
  const original = new Response(payload, { status: 422 }), promise = Promise.resolve(original), owner = { fetch: () => promise };
  installFetchCloneObserver(spec(), owner);
  const returned = owner.fetch(url); assert.equal(returned, promise);
  assert.equal(await returned, original);
  assert.deepEqual(await original.json(), { detail: 'Invalid tag key' });
  assert.equal((await readFetchCloneObserver(spec(), owner)).result, 'PASS'); removeFetchCloneObserver(spec(), owner);
});

test('missing and unresolved observations time out without retrying or rejecting the application promise', async () => {
  let calls = 0; const nativePromise = new Promise(() => {}), owner = { fetch: () => { calls += 1; return nativePromise; } };
  const expected = spec({ timeoutMs: 5 }); installFetchCloneObserver(expected, owner);
  const returned = owner.fetch(url); assert.equal(returned, nativePromise);
  const value = await readFetchCloneObserver(expected, owner);
  assert.equal(value.result, 'TIMEOUT'); assert.equal(value.clone_count, 0); assert.equal(calls, 1);
  assert.equal(owner.fetch === owner[expected.slot].original, true); removeFetchCloneObserver(expected, owner);
  const missingOwner = { fetch: () => { throw new Error('must_not_fetch'); } }; installFetchCloneObserver(expected, missingOwner);
  const missing = await readFetchCloneObserver(expected, missingOwner);
  assert.equal(missing.result, 'MISSING'); assert.equal(missing.native_fetch_count, 0); removeFetchCloneObserver(expected, missingOwner);
});

test('clone timeout and size limits leave the original readable and never fetch again', async () => {
  let controller, calls = 0;
  const original = new Response(new ReadableStream({ start(value) { controller = value; } }), { status: 422 });
  const owner = { fetch: () => { calls += 1; return Promise.resolve(original); } }, expected = spec({ timeoutMs: 5 });
  installFetchCloneObserver(expected, owner); await owner.fetch(url);
  const timeout = await readFetchCloneObserver(expected, owner); assert.equal(timeout.result, 'TIMEOUT'); assert.equal(timeout.clone_count, 1);
  controller.enqueue(new TextEncoder().encode(payload)); controller.close();
  assert.equal(original.bodyUsed, false); assert.equal(await original.text(), payload); assert.equal(calls, 1);
  removeFetchCloneObserver(expected, owner);
  const largeOriginal = new Response(payload), largeOwner = { fetch: () => Promise.resolve(largeOriginal) }, small = spec({ maxBytes: 4 });
  installFetchCloneObserver(small, largeOwner); await largeOwner.fetch(url);
  assert.equal((await readFetchCloneObserver(small, largeOwner)).result, 'BODY_TOO_LARGE');
  assert.equal(await largeOriginal.text(), payload); removeFetchCloneObserver(small, largeOwner);
});

test('fetch and parse errors preserve original errors and report no raw message/body', async () => {
  const secret = new Error('SYNTHETIC_PRIVATE_SENTINEL'), nativePromise = Promise.reject(secret), owner = { fetch: () => nativePromise };
  installFetchCloneObserver(spec(), owner); const returned = owner.fetch(url); assert.equal(returned, nativePromise);
  await assert.rejects(returned, error => error === secret);
  const value = await readFetchCloneObserver(spec(), owner); assert.equal(value.result, 'FETCH_FAILED');
  assert.equal(JSON.stringify(value).includes('SYNTHETIC_PRIVATE'), false); removeFetchCloneObserver(spec(), owner);
  const invalidOwner = { fetch: () => Promise.resolve(new Response('SYNTHETIC_PRIVATE_SENTINEL')) };
  installFetchCloneObserver(spec(), invalidOwner); await invalidOwner.fetch(url);
  const invalid = await readFetchCloneObserver(spec(), invalidOwner); assert.equal(invalid.result, 'INVALID_JSON');
  assert.equal(JSON.stringify(invalid).includes('SYNTHETIC_PRIVATE'), false); removeFetchCloneObserver(spec(), invalidOwner);
});

test('synchronous native errors and private header fields are left untouched', async () => {
  const error = new Error('SYNTHETIC_PRIVATE_SENTINEL'), owner = { fetch: () => { throw error; } };
  installFetchCloneObserver(spec(), owner); assert.throws(() => owner.fetch(url), value => value === error);
  assert.equal((await readFetchCloneObserver(spec(), owner)).result, 'FETCH_FAILED'); removeFetchCloneObserver(spec(), owner);
  let headerReads = 0;
  const init = { method: 'GET', get headers() { headerReads += 1; return { Authorization: 'SYNTHETIC_PRIVATE_SENTINEL' }; } };
  const headerOwner = { fetch: (_, value) => { assert.equal(value, init); return Promise.resolve(new Response(payload)); } };
  installFetchCloneObserver(spec(), headerOwner); await headerOwner.fetch(url, init);
  await readFetchCloneObserver(spec(), headerOwner); assert.equal(headerReads, 0); removeFetchCloneObserver(spec(), headerOwner);
});

test('duplicates after restoration use native fetch untouched and are not silently retried by the observer', async () => {
  let calls = 0; const native = () => { calls += 1; return Promise.resolve(new Response(payload)); }, owner = { fetch: native };
  installFetchCloneObserver(spec(), owner); await owner.fetch(url); assert.equal(owner.fetch, native);
  await owner.fetch(url); const value = await readFetchCloneObserver(spec(), owner);
  assert.equal(calls, 2); assert.equal(value.native_fetch_count, 1); assert.equal(value.clone_count, 1);
  removeFetchCloneObserver(spec(), owner);
});

test('unsafe specifications refuse before altering fetch, and disposal never overwrites another owner', async () => {
  const native = () => Promise.resolve(new Response(payload)), owner = { fetch: native };
  for (const extra of [{ url: 'https://example.invalid/private' }, { method: 'POST' }, { body: 'unexpected' },
    { timeoutMs: 0 }, { maxBytes: 65537 }, { token: 'SYNTHETIC_PRIVATE' }, { slot: 'arbitrary' }]) {
    assert.throws(() => installFetchCloneObserver(spec(extra), owner)); assert.equal(owner.fetch, native);
  }
  const expected = spec({ timeoutMs: 5 }); installFetchCloneObserver(expected, owner);
  const replacement = () => Promise.resolve(new Response('another owner')); owner.fetch = replacement;
  const value = await readFetchCloneObserver(expected, owner); assert.equal(value.original_fetch_restored, false);
  assert.equal(removeFetchCloneObserver(expected, owner).restored, false); assert.equal(owner.fetch, replacement);
});
