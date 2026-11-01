/** Bounded orchestration diagnostics; no I/O on import. */
import assert from 'node:assert/strict';

const OPERATIONS = new Set(['phase', 'native_read', 'native_evaluate', 'response_body',
  'response_headers', 'browser_context', 'browser_page', 'browser_close', 'dom', 'write_ledger']);
const STAGES = new Set(['local_inputs', 'root_readiness_receipt', 'qmp_identity', 'tls',
  'private_browser_credentials', 'browser_dependencies', 'normal_ha_login', 'sidebar', 'native_manager',
  'native_bootstrap_reads', 'native_inventory_dom', 'synthetic_metadata_preview',
  'native_css_asset_assertion', 'native_js_asset_assertion', 'independent_native_prewrite_guards',
  'diagnostic_partial_state', 'diagnostic_HA_name_readback', 'diagnostic_DOM_snapshot',
  'close_browsers_and_assess', 'complete']);
const CHECKPOINTS = new Set(['begin', 'complete', 'timeout', 'failed', 'headers', 'body', 'dom', 'ledger']);
const CATEGORIES = new Set(['session', 'connection', 'inventory', 'inbox', 'capabilities', 'publication',
  'playback', 'assignments', 'tag_assignment', 'tag_name', 'metadata', 'recovery', 'other_app_read']);

export function nativeEndpointCategory(endpoint) {
  const path = endpoint.split('?')[0];
  const fixed = { session: 'session', status: 'connection', tags: 'inventory', 'tags/inbox': 'inbox',
    'music/capabilities': 'capabilities', publication: 'publication', 'playback-status': 'playback',
    assignments: 'assignments', 'music/resolve': 'metadata', recovery: 'recovery' };
  if (Object.hasOwn(fixed, path)) return fixed[path];
  if (/^tags\/[a-f0-9]{64}\/assignment$/.test(path)) return 'tag_assignment';
  if (/^tags\/[a-f0-9]{64}\/name$/.test(path)) return 'tag_name';
  return 'other_app_read';
}

export function createProgressStream(write) {
  let sequence = 0;
  const started = performance.now();
  return value => {
    const allowed = ['role', 'stage', 'checkpoint', 'operation', 'status', 'count', 'category'];
    assert.ok(value && Object.keys(value).every(key => allowed.includes(key)));
    assert.ok(['A', 'B', 'coordinator'].includes(value.role)); assert.ok(STAGES.has(value.stage));
    assert.ok(CHECKPOINTS.has(value.checkpoint)); assert.ok(OPERATIONS.has(value.operation));
    if (Object.hasOwn(value, 'status')) assert.ok(Number.isInteger(value.status) && value.status >= 0 && value.status <= 599);
    if (Object.hasOwn(value, 'count')) assert.ok(Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 1000);
    if (Object.hasOwn(value, 'category')) assert.ok(CATEGORIES.has(value.category));
    const event = { schema_version: 1, event: 'native_progress', sequence: ++sequence,
      elapsed_ms: Math.floor(performance.now() - started), ...value };
    write(JSON.stringify(event) + '\n');
  };
}

function failure(code, operation) {
  const error = new Error(code); error.code = code; error.operation = operation;
  return error;
}

export async function withinDeadline(kind, operation, { timeoutMs = 15000, notify = () => {} } = {}) {
  assert.ok(OPERATIONS.has(kind)); assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  let timer;
  notify({ operation: kind, checkpoint: 'begin' });
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('native_deadline', kind)), timeoutMs); }),
    ]);
    notify({ operation: kind, checkpoint: 'complete' }); return result;
  } catch (error) {
    const timedOut = error?.code === 'native_deadline';
    notify({ operation: kind, checkpoint: timedOut ? 'timeout' : 'failed' });
    throw failure(timedOut ? 'native_deadline' : 'native_operation_failed', kind);
  } finally { clearTimeout(timer); }
}

export async function closeBrowserBounded(browser, { timeoutMs = 5000, notify = () => {} } = {}) {
  if (!browser) return { cleanup_confirmed: true, reason: 'not_started' };
  try {
    await withinDeadline('browser_close', () => browser.close(), { timeoutMs, notify });
    return { cleanup_confirmed: true, reason: 'public_close_resolved' };
  } catch (error) {
    return { cleanup_confirmed: false, reason: error.code === 'native_deadline' ? 'close_deadline' : 'close_failed' };
  }
}

export function memoizedBrowserCleanup(getBrowser, options = {}, onResult = () => {}) {
  let result;
  return () => result ??= (async () => {
    const closed = await closeBrowserBounded(getBrowser(), options); onResult(closed); return closed;
  })();
}
