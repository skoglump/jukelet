/** Opt-in normal HA login on the owned loopback fixture; no app mutation or publication. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import https from 'node:https';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '../frontend/node_modules/@playwright/test/index.mjs';

const fixture = 'jukelet-m5-disposable-kvm';
const origin = 'https://127.0.0.1:18123';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function readRegular(path, limit, mode) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > limit || (mode && (metadata.mode & 0o777) !== mode)) throw new Error('invalid fixture file');
  return readFileSync(path);
}

export function readConfig(path) {
  const root = realpathSync(dirname(path));
  if ((lstatSync(root).mode & 0o777) !== 0o700) throw new Error('fixture directory must be private');
  const config = JSON.parse(readRegular(path, 16384, 0o600));
  const keys = ['fixture', 'origin', 'credentials_file', 'certificate_file', 'source_commit', 'context_sha256', 'image_id'];
  if (Object.keys(config).length !== keys.length || keys.some(key => typeof config[key] !== 'string')
    || config.fixture !== fixture || config.origin !== origin
    || !/^[a-f0-9]{40}$/.test(config.source_commit) || !/^[a-f0-9]{64}$/.test(config.context_sha256)
    || !/^sha256:[a-f0-9]{64}$/.test(config.image_id)) throw new Error('invalid fixture identity');
  for (const key of ['credentials_file', 'certificate_file']) {
    const child = relative(root, realpathSync(config[key]));
    if (!child || child.startsWith('..') || resolve(root, child) !== config[key]) throw new Error('fixture file escapes private directory');
  }
  const credentials = JSON.parse(readRegular(config.credentials_file, 16384, 0o600));
  if (credentials.synthetic !== true || credentials.fixture_is_admin !== true
    || credentials.origin !== origin || typeof credentials.username !== 'string'
    || typeof credentials.password !== 'string' || !credentials.username || !credentials.password) throw new Error('synthetic administrator credentials required');
  const certificate = readRegular(config.certificate_file, 32768);
  return { config, credentials, certificate };
}

async function verifyTLS(certificate) {
  await new Promise((done, reject) => {
    const request = https.get(`${origin}/`, { ca: certificate, agent: false, rejectUnauthorized: true }, response => {
      response.resume();
      if (response.statusCode === 200) done(); else reject(new Error('fixture HTTPS unavailable'));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('fixture HTTPS timeout')));
  });
}

export async function probe(path) {
  let stage = 'fixture_config';
  const report = { fixture, result: 'FAIL', checks: {}, limitations: ['One real synthetic administrator and desktop Chromium; full manager/identity/mobile matrix remains #62.'] };
  let browser;
  try {
    const { config, credentials, certificate } = readConfig(path);
    Object.assign(report, { source_commit: config.source_commit, context_sha256: config.context_sha256, image_id: config.image_id });
    stage = 'tls';
    await verifyTLS(certificate);
    const publicKey = execFileSync('openssl', ['x509', '-pubkey', '-noout'], { input: certificate, stdio: ['pipe', 'pipe', 'pipe'] });
    const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: publicKey, stdio: ['pipe', 'pipe', 'pipe'] });
    const spki = createHash('sha256').update(der).digest('base64');
    report.checks.tls = { ca_and_hostname_verified: true, chromium_certificate_spki_pinned: true };
    browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let outside = 0;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { outside += 1; return route.abort(); }
      if (url.pathname.startsWith('/api/hassio_ingress/') && !['GET', 'HEAD'].includes(route.request().method())) {
        outside += 1; return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    stage = 'normal_ha_login';
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByLabel('Username', { exact: true }).fill(credentials.username);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    const save = page.getByRole('button', { name: 'Save login', exact: true });
    if (await save.isVisible().catch(() => false)) await save.click();
    stage = 'sidebar';
    const sidebar = page.getByRole('link', { name: 'Jukelet', exact: true });
    await expect(sidebar).toHaveAccessibleName('Jukelet', { timeout: 30000 });
    await expect(sidebar).toBeVisible({ timeout: 30000 });
    await sidebar.click();
    report.checks.sidebar = true;
    stage = 'ingress_interface';
    await expect.poll(() => page.frames().filter(frame => /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/.test(new URL(frame.url() || origin).pathname)).length, { timeout: 30000 }).toBe(1);
    const frame = page.frames().find(item => /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/.test(new URL(item.url() || origin).pathname));
    const mounted = new URL(frame.url());
    if (mounted.origin !== origin) throw new Error('unexpected frame origin');
    const prefix = mounted.pathname.replace(/\/$/, '') + '/';
    const fromFrame = request => { try { return request.frame() === frame; } catch { return false; } };
    report.ingress_prefix_sha256 = sha256(prefix);
    let escaped = 0;
    const assets = [];
    page.on('request', request => {
      if (!fromFrame(request)) return;
      const url = new URL(request.url());
      const canonical = url.pathname === prefix.slice(0, -1) && request.resourceType() === 'document';
      if (url.origin !== origin || (!url.pathname.startsWith(prefix) && !canonical)) escaped += 1;
    });
    page.on('response', response => {
      if (!fromFrame(response.request())) return;
      const url = new URL(response.url());
      if (url.pathname.includes('/assets/')) assets.push({ extension: url.pathname.endsWith('.css') ? 'css' : 'js', status: response.status(), prefixed: url.pathname.startsWith(prefix) });
    });
    await frame.goto(`${origin}${prefix}`, { waitUntil: 'domcontentloaded' });
    await expect(frame.getByRole('heading', { name: 'Your tag and music manager', exact: true })).toBeVisible({ timeout: 30000 });
    await expect(frame.getByText('Read-only', { exact: true })).toBeVisible();
    await expect(frame.getByLabel('App secret', { exact: true })).toHaveCount(0);
    const session = await frame.evaluate(async () => {
      const response = await fetch(new URL('api/v1/session', document.baseURI), { credentials: 'same-origin', redirect: 'error' });
      const body = await response.json();
      return { status: response.status, runtime: body.runtime, mode: body.mode, has_user_identity: typeof body.user_id === 'string' && body.user_id.length > 0 };
    });
    expect(session).toEqual({ status: 200, runtime: 'ingress', mode: 'read_only', has_user_identity: true });
    report.checks.session = session;
    stage = 'core_reconnect';
    await expect(frame.getByRole('region', { name: 'Home Assistant status' })).toContainText('Home Assistant connected.', { timeout: 30000 });
    report.checks.core_connected = true;
    expect(assets.some(asset => asset.extension === 'css' && asset.status === 200)).toBe(true);
    expect(assets.some(asset => asset.extension === 'js' && asset.status === 200)).toBe(true);
    expect(assets.every(asset => asset.prefixed && [200, 304].includes(asset.status))).toBe(true);
    expect(escaped).toBe(0); expect(outside).toBe(0);
    report.checks.assets = { css: true, javascript: true, all_prefixed: true, escaped_requests: escaped, blocked_external_or_write_requests: outside };
    stage = 'canonical_slash_query';
    const query = '?probe=canonical%2Bsafe&second=2';
    const navigation = await frame.goto(`${origin}${prefix.slice(0, -1)}${query}`, { waitUntil: 'domcontentloaded' });
    const canonical = new URL(frame.url());
    report.checks.canonical = { response_status: navigation?.status() ?? null, redirected: Boolean(navigation?.request().redirectedFrom()), slash: canonical.pathname === prefix, query_preserved: canonical.search === query };
    expect(report.checks.canonical.redirected).toBe(true);
    expect(report.checks.canonical.slash).toBe(true);
    expect(report.checks.canonical.query_preserved).toBe(true);
    await expect(frame.getByRole('heading', { name: 'Your tag and music manager', exact: true })).toBeVisible();
    expect(escaped).toBe(0); expect(outside).toBe(0);
    report.result = 'PASS';
  } catch {
    report.failed_stage = stage;
  } finally {
    if (browser) await browser.close().catch(() => { report.result = 'FAIL'; report.failed_stage ??= 'browser_cleanup'; });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stdout.write('{"result":"FAIL","failed_stage":"explicit_private_fixture_config_required"}\n');
    process.exitCode = 1;
  } else {
    const result = await probe(process.argv[2]);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.result === 'PASS' ? 0 : 1;
  }
}
