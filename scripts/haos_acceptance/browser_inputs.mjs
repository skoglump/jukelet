/** Local synthetic inputs only. Importing this module performs no I/O. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE = 'jukelet-m5-issue62-matrix-kvm';
export const CONTROL_ROOT = '/tmp/jukelet-issue62-matrix-control';
export const LOCAL_ORIGIN = 'https://127.0.0.1:18223';
export const PROXY_ORIGIN = 'https://127.0.0.1:28223';
export const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const hash = value => createHash('sha256').update(value).digest('hex');

function invalid() { throw new Error('invalid_fixture_input'); }

export function readBoundedFile(path, limit, { root = CONTROL_ROOT, certificate = false } = {}) {
  if (dirname(path) !== root || realpathSync(root) !== root) invalid();
  const directory = lstatSync(root);
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700
    || directory.uid !== process.getuid() || directory.gid !== process.getgid()) invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid()
      || metadata.gid !== process.getgid() || metadata.size < 1 || metadata.size > limit
      || ![0o600, ...(certificate ? [0o644] : [])].includes(metadata.mode & 0o777)) invalid();
    const bytes = Buffer.alloc(limit + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (length !== metadata.size || after.size !== metadata.size
      || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs
      || after.ino !== metadata.ino) invalid();
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

export function parseCredentials(raw, expectedRole) {
  const value = JSON.parse(raw);
  // JSON.parse alone silently accepts duplicate properties. Tokenizing strings
  // first prevents a quoted password from being mistaken for an object key.
  const tokens = raw.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|true|false|null|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g) ?? [];
  const keys = tokens.flatMap((token, index) => tokens[index + 1] === ':' ? [JSON.parse(token)] : []);
  const fields = ['schema_version', 'fixture', 'synthetic', 'origin', 'role', 'username', 'password'];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || keys.length !== fields.length
    || new Set(keys).size !== keys.length || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key)) || value.schema_version !== 1
    || value.fixture !== FIXTURE || value.synthetic !== true || value.origin !== LOCAL_ORIGIN
    || !['administrator', 'denied'].includes(expectedRole) || value.role !== expectedRole
    || typeof value.username !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(value.username)
    || typeof value.password !== 'string' || value.password.length < 16 || value.password.length > 256
    || /[\u0000-\u001f\u007f]/.test(value.password)) invalid();
  return Object.freeze({ username: value.username, password: value.password });
}

export function readPublicInputs(path) {
  if (dirname(path) !== CONTROL_ROOT || !/^[a-z][a-z0-9_-]{0,63}\.json$/.test(path.split('/').at(-1))) invalid();
  const documentBytes = readBoundedFile(path, 16384);
  const validation = spawnSync('python3', ['-B', '-m', 'scripts.haos_acceptance', 'validate', path], {
    cwd: REPOSITORY, encoding: 'utf8', maxBuffer: 65536,
  });
  if (validation.status !== 0) invalid();
  const report = JSON.parse(validation.stdout);
  const document = JSON.parse(documentBytes);
  if (report.result !== 'PASS_LOCAL_INPUT' || report.fixture !== FIXTURE
    || report.origin !== LOCAL_ORIGIN || document.origin !== LOCAL_ORIGIN) invalid();
  if (!sameIdentity(report.declared_candidate, document.candidate)
    || !sameIdentity(report.declared_bridge, document.bridge)) invalid();
  const certificate = readBoundedFile(join(CONTROL_ROOT, document.certificate_file), 32768, { certificate: true });
  return { document, certificate, configuration_sha256: hash(documentBytes), local_validation: report };
}

export function sameIdentity(left, right) {
  if (!left || !right || Array.isArray(left) || Array.isArray(right)
    || Object.keys(left).length !== Object.keys(right).length) return false;
  return Object.keys(left).every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

export function readCredentials(document, role) {
  const key = role === 'administrator' ? 'admin_credentials_file' : role === 'denied' ? 'denied_credentials_file' : null;
  if (!key || typeof document[key] !== 'string' || !/^[a-z][a-z0-9_-]{0,63}\.json$/.test(document[key])) invalid();
  return parseCredentials(readBoundedFile(join(CONTROL_ROOT, document[key]), 16384).toString('utf8'), role);
}

export function readOnlyRequestAllowed(url, method, origin = LOCAL_ORIGIN) {
  if (![LOCAL_ORIGIN, PROXY_ORIGIN].includes(origin)) return false;
  let target;
  try { target = new URL(url); } catch { return false; }
  if (target.origin !== origin || target.username || target.password) return false;
  if (['GET', 'HEAD'].includes(method)) return true;
  if (method !== 'POST') return false;
  if (/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/api\/v1\/music\/resolve$/.test(target.pathname)) return target.search === '';
  return /^\/auth\/(?:token|login_flow(?:\/[A-Za-z0-9_-]+)?)$/.test(target.pathname) && target.search === '';
}

export function websocketAllowed(url, origin = LOCAL_ORIGIN) {
  try {
    const target = new URL(url);
    return [LOCAL_ORIGIN, PROXY_ORIGIN].includes(origin)
      && target.href === origin.replace('https:', 'wss:') + '/api/websocket';
  } catch { return false; }
}

export function ingressPrefix(url, origin = LOCAL_ORIGIN) {
  const target = new URL(url);
  if (target.origin !== origin || target.username || target.password
    || !/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/$/.test(target.pathname)) invalid();
  return target.pathname;
}

export function blockedRequestCategory(url, method, resource, context) {
  let reason = 'invalid_url';
  try {
    const target = new URL(url);
    reason = target.origin !== LOCAL_ORIGIN ? 'outside_origin'
      : target.pathname.startsWith('/api/hassio_ingress/') ? 'disallowed_ingress_method'
        : 'disallowed_ha_method';
  } catch { /* Never include URL or exception text in the category. */ }
  const safeMethod = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) ? method : 'OTHER';
  const safeResource = ['document', 'stylesheet', 'image', 'font', 'script', 'fetch', 'xhr', 'media', 'manifest', 'websocket'].includes(resource) ? resource : 'other';
  const safeContext = ['ha_parent', 'ingress_frame', 'child_frame'].includes(context) ? context : 'unknown';
  return [reason, safeContext, safeMethod, safeResource].join('|');
}

export function assetSummary(assets) {
  const result = { total: assets.length, css_200: 0, js_200: 0, extension_status: {} };
  for (const asset of assets) {
    const extension = ['css', 'js'].includes(asset.extension) ? asset.extension : 'other';
    const status = Number.isInteger(asset.status) && asset.status >= 0 && asset.status <= 599 ? String(asset.status) : 'invalid';
    const key = extension + '_' + status;
    result.extension_status[key] = (result.extension_status[key] ?? 0) + 1;
    if (extension === 'css' && status === '200') result.css_200 += 1;
    if (extension === 'js' && status === '200') result.js_200 += 1;
  }
  return result;
}

const PUBLIC_HA_ORIGINS = new Set([
  'https://www.home-assistant.io', 'https://version.home-assistant.io',
  'https://brands.home-assistant.io', 'https://alerts.home-assistant.io',
  'https://analytics.home-assistant.io',
]);
const STATIC_HA_PATHS = Object.freeze({
  '/': 'public_ha_root', '/stable.json': 'public_version_stable',
  '/beta.json': 'public_version_beta', '/dev.json': 'public_version_dev',
  '/brands.json': 'public_brand_index', '/manifest.json': 'public_manifest',
});

export function blockedEndpointEvidence(url) {
  let target;
  try { target = new URL(url); } catch { return { origin_category: 'invalid_url' }; }
  let origin;
  if (PUBLIC_HA_ORIGINS.has(target.origin)) {
    origin = { origin_category: 'known_public_ha', public_origin: target.origin };
  } else if (['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)) {
    const port = target.port || (target.protocol === 'https:' ? '443' : target.protocol === 'http:' ? '80' : 'other');
    origin = { origin_category: 'loopback', port_bucket: target.origin === LOCAL_ORIGIN ? 'native_https_18223'
      : target.origin === PROXY_ORIGIN ? 'proxy_https_28223'
        : target.protocol === 'http:' && port === '18280' ? 'bootstrap_http_18280' : 'other_loopback_port' };
  } else {
    origin = { origin_category: 'other_origin_sha256', origin_sha256: hash(target.origin) };
  }
  const path = PUBLIC_HA_ORIGINS.has(target.origin) && Object.hasOwn(STATIC_HA_PATHS, target.pathname)
    ? { path_category: STATIC_HA_PATHS[target.pathname] }
    : { path_category: 'path_sha256', path_sha256: hash(target.pathname) };
  return { ...origin, ...path };
}

export function pageErrorSource(stack) {
  if (typeof stack !== 'string') return 'unknown';
  let parent = false;
  // Error text can contain arbitrary values: inspect stack-frame lines only and
  // never emit those lines, their URLs, the message or a stack trace.
  for (const line of stack.split('\n').slice(1)) {
    for (const match of line.matchAll(/https?:\/\/[^\s)]+/g)) {
      let url;
      try { url = new URL(match[0]); } catch { continue; }
      if (![LOCAL_ORIGIN, PROXY_ORIGIN].includes(url.origin)) continue;
      if (/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/assets\//.test(url.pathname)) return 'jukelet_ingress_asset';
      if (/^\/(?:frontend_latest|frontend_es5|frontend_data)\//.test(url.pathname)) parent = true;
    }
  }
  return parent ? 'ha_parent_frontend' : 'unknown';
}

export function matchesInvestigatedRequest(url) {
  try {
    const target = new URL(url);
    return hash(target.origin) === '6f7d956a4d23259282d0cf5bb34a1d541547da5ed25c1e623a04024f126303ad'
      && hash(target.pathname) === '6fcdeabf6fe777b39e3f499f451d20133b7fc6b80fcd015acb5c0f47a659a927';
  } catch { return false; }
}

export function serviceWorkerSourceLookup(url) {
  if (typeof url !== 'string') return null;
  let target;
  try { target = new URL(url); } catch { return null; }
  const match = target.pathname.match(/^\/home-assistant\/frontend\/([1-9][0-9]{7}\.(?:0|[1-9][0-9]{0,3}))\/src\/util\/register-service-worker\.ts$/);
  if (target.origin !== 'https://raw.githubusercontent.com' || !match
    || url !== target.origin + target.pathname || target.search || target.hash
    || target.username || target.password) return null;
  return { kind: 'ha_frontend_register_service_worker_original_source', frontend_version: match[1],
    origin_sha256: hash(target.origin), path_sha256: hash(target.pathname) };
}

export function headerPresence(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {
    headers_available: false, requestHasAuthorizationHeader: null, requestHasCookieHeader: null,
  };
  const names = Object.keys(headers).map(key => key.toLowerCase());
  return { headers_available: true, requestHasAuthorizationHeader: names.includes('authorization'),
    requestHasCookieHeader: names.includes('cookie') };
}

export function projectScriptFrame(frame) {
  const functionName = typeof frame?.functionName === 'string' ? frame.functionName : '';
  const functionEvidence = ['fetch', 'send', 'load', 'request', 'then', 'catch', 'get'].includes(functionName)
    ? { function_name: functionName } : { function_sha256: hash(functionName) };
  const position = key => Number.isInteger(frame?.[key]) && frame[key] >= 0 && frame[key] < 100000000 ? frame[key] + 1 : null;
  const location = { line: position('lineNumber'), column: position('columnNumber'), location_base: 1, ...functionEvidence };
  let target;
  try { target = new URL(frame?.url); } catch {
    return { source: 'unknown', script_url_sha256: hash(typeof frame?.url === 'string' ? frame.url : ''), ...location };
  }
  const ownedOrigin = [LOCAL_ORIGIN, PROXY_ORIGIN].includes(target.origin);
  const publicPath = /^\/(?:frontend_latest|frontend_es5|frontend_data)\/[A-Za-z0-9_.-]{1,120}[.-][a-f0-9]{6,64}\.js$/.test(target.pathname)
    || ['/hassio/app/entrypoint.js', '/api/hassio/app/entrypoint.js'].includes(target.pathname);
  if (ownedOrigin && publicPath) return { source: 'ha_parent_frontend', script_path: target.pathname, ...location };
  return { source: ownedOrigin && /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/assets\//.test(target.pathname) ? 'jukelet_ingress_asset' : 'unknown',
    script_origin_sha256: hash(target.origin), script_path_sha256: hash(target.pathname), ...location };
}

export function projectPageErrorFrames(stack) {
  if (typeof stack !== 'string') return [];
  const frames = [];
  for (const line of stack.slice(0, 32768).split('\n').slice(1)) {
    for (const match of line.matchAll(/https?:\/\/[^\s)]+/g)) {
      const location = match[0].match(/:(\d+):(\d+)$/);
      const url = location ? match[0].slice(0, -location[0].length) : match[0];
      const functionName = line.match(/^\s*at\s+(?:async\s+)?(.+?)\s*\(/)?.[1] ?? '';
      frames.push(projectScriptFrame({ url, functionName,
        lineNumber: location ? Number(location[1]) - 1 : null,
        columnNumber: location ? Number(location[2]) - 1 : null }));
      if (frames.length === 8) return frames;
    }
  }
  return frames;
}

export function expectedTypeErrorUndefinedAddEventListener(name, message, stack) {
  if (name !== 'TypeError' || message !== "Cannot read properties of undefined (reading 'addEventListener')"
    || typeof stack !== 'string' || stack.length > 32768 || pageErrorSource(stack) !== 'ha_parent_frontend') return false;
  const frameText = stack.split('\n').slice(1).join('\n');
  if (/\b(?:blob|data|file|webpack-internal|chrome-extension):/.test(frameText)) return false;
  const urls = [...frameText.matchAll(/https?:\/\/[^\s)]+/g)];
  const frames = projectPageErrorFrames(stack);
  return urls.length > 0 && urls.length <= 8 && frames.length === urls.length
    && frames.every(frame => frame.source === 'ha_parent_frontend');
}
