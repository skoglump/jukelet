/** One expected native fetch only; imports perform no I/O. */
export function installFetchCloneObserver(spec, owner = globalThis) {
  const keys = ['slot', 'token', 'url', 'method', 'body', 'timeoutMs', 'maxBytes'];
  const invalid = () => { throw new Error('invalid_fetch_observer'); };
  if (!spec || Object.keys(spec).length !== keys.length || keys.some(key => !Object.hasOwn(spec, key))
    || spec.slot !== '__jukeletIssue62FetchClone' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(spec.token) || typeof spec.url !== 'string'
    || !['GET', 'PUT'].includes(spec.method) || !Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 5000
    || !Number.isInteger(spec.maxBytes) || spec.maxBytes < 1 || spec.maxBytes > 65536) invalid();
  let target; try { target = new URL(spec.url); } catch { invalid(); }
  if (target.origin !== 'https://127.0.0.1:18223' || target.href !== spec.url || target.username || target.password || target.hash
    || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/api\/v1\/tags\/(?:[a-f0-9]{64}|invalid)\/assignment$/.test(target.pathname)
    || [...target.searchParams].some(([key, value]) => key !== 'jukelet_capture' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    || [...target.searchParams].length > 1
    || (spec.method === 'GET' ? spec.body !== null : typeof spec.body !== 'string' || !spec.body.length || new TextEncoder().encode(spec.body).length > 8192 || target.search || target.pathname.endsWith('/invalid/assignment'))) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'fetch'), original = owner.fetch;
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.writable !== true || typeof original !== 'function'
    || owner[spec.slot] !== undefined) invalid();
  let resolve, timer, reader;
  const completion = new Promise(done => { resolve = done; });
  const state = { token: spec.token, matched_count: 0, native_fetch_count: 0, clone_count: 0,
    response: null, original, completion, settled: false };
  const restore = () => {
    if (owner.fetch === wrapped) Object.defineProperty(owner, 'fetch', descriptor);
    return owner.fetch === original;
  };
  const cancelClone = () => { try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* No raw errors. */ } };
  const finish = (result, extra = {}) => {
    if (state.settled) return;
    state.settled = true; clearTimeout(timer);
    if (result !== 'PASS') cancelClone();
    resolve({ result, matched_count: state.matched_count, native_fetch_count: state.native_fetch_count,
      clone_count: state.clone_count, original_fetch_restored: restore(), ...extra });
  };
  const matches = args => {
    if (args[0] !== spec.url) return false;
    const init = args[1];
    if (init !== undefined && (!init || ![Object.prototype, null].includes(Object.getPrototypeOf(init)))) return false;
    const method = init === undefined ? undefined : Object.getOwnPropertyDescriptor(init, 'method');
    const body = init === undefined ? undefined : Object.getOwnPropertyDescriptor(init, 'body');
    if ((method && !Object.hasOwn(method, 'value')) || (body && !Object.hasOwn(body, 'value'))) return false;
    return (method?.value ?? 'GET') === spec.method
      && (spec.method === 'GET' ? body?.value === undefined || body?.value === null : body?.value === spec.body);
  };
  async function capture(response) {
    if (state.settled) return;
    state.response = response;
    const before = response.bodyUsed;
    let clone;
    try { clone = response.clone(); state.clone_count += 1; reader = clone.body.getReader(); }
    catch { finish('CLONE_FAILED'); return; }
    const chunks = []; let size = 0;
    try {
      while (!state.settled) {
        const next = await reader.read(); if (state.settled) return;
        if (next.done) break;
        size += next.value.byteLength;
        if (size > spec.maxBytes) { finish('BODY_TOO_LARGE'); return; }
        chunks.push(next.value);
      }
      if (state.settled) return;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { finish('INVALID_JSON'); return; }
      finish('PASS', { status: response.status, body, bytes_read: size,
        original_body_used_at_clone: before, original_body_used_after_clone: response.bodyUsed, clone_body_used: clone.bodyUsed });
    } catch { finish('CLONE_FAILED'); }
    finally { try { reader?.releaseLock(); } catch { /* A pending read is bounded by the observer deadline. */ } }
  }
  function wrapped(...args) {
    let match = false; try { match = !state.settled && matches(args); } catch { /* Delegate unchanged. */ }
    if (match) { state.matched_count += 1; restore(); }
    let promise;
    try { if (match) state.native_fetch_count += 1; promise = Reflect.apply(original, this, args); }
    catch (error) { if (match) finish('FETCH_FAILED'); throw error; }
    if (match) {
      try { promise.then(response => capture(response), () => finish('FETCH_FAILED')).catch(() => finish('CLONE_FAILED')); }
      catch { finish('FETCH_FAILED'); }
    }
    // Never return an observer chain: the application receives its exact native
    // promise and Response, and is never delayed waiting for the clone.
    return promise;
  }
  state.dispose = () => {
    if (!state.settled) finish(state.matched_count ? 'DISPOSED' : 'MISSING');
    clearTimeout(timer); cancelClone(); return { restored: restore(), matched_count: state.matched_count, clone_count: state.clone_count };
  };
  owner[spec.slot] = state;
  Object.defineProperty(owner, 'fetch', { ...descriptor, value: wrapped });
  timer = setTimeout(() => finish(state.matched_count ? 'TIMEOUT' : 'MISSING'), spec.timeoutMs);
  return { armed: true };
}

export async function readFetchCloneObserver({ slot, token }, owner = globalThis) {
  const state = owner[slot];
  if (slot !== '__jukeletIssue62FetchClone' || !state || state.token !== token) throw new Error('fetch_observer_unavailable');
  return { ...await state.completion, original_body_used_current: state.response?.bodyUsed ?? null,
    original_fetch_restored: owner.fetch === state.original };
}

export function removeFetchCloneObserver({ slot, token }, owner = globalThis) {
  const state = owner[slot];
  if (slot !== '__jukeletIssue62FetchClone' || !state || state.token !== token) throw new Error('fetch_observer_unavailable');
  const result = state.dispose(); delete owner[slot]; return result;
}
