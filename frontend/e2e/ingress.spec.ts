import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:4176';
const prefixes = ['/', '/api/hassio_ingress/synthetic_A-123/', '/another/Ingress_token_456/'];
const uri = 'spotify:album:0123456789ABCDEFGHIJKL';
const exactId = '  Synthetic:Å/04:AB  ';

async function setup(page: Page, prefix: string) {
  expect((await page.request.post('/__proxy/state', { data: { prefix, reset: true } })).ok()).toBe(true);
  expect((await page.request.post(`${prefix}__fixtures/state`, { data: { scenario: 'manage', reset: 'yes' } })).ok()).toBe(true);
}
async function login(page: Page, prefix: string) {
  await page.goto(`${prefix}?synthetic=1#manager`);
  await page.getByLabel('App secret').fill('synthetic-fixture-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Local management', { exact: true })).toBeVisible();
}
async function safeLog(page: Page) {
  const log = await page.request.get('/__proxy/log').then(response => response.json());
  expect(log.outside).toEqual([]);
  expect(log.externalHits).toBe(0);
  return log as { requests: { method: string; path: string }[] };
}

for (const prefix of prefixes) {
  test(`compiled manager assets and every workflow stay under ${prefix}`, async ({ page }) => {
    await setup(page, prefix);
    const requests: { method: string; url: string; body: string | null }[] = [];
    const errors: string[] = [];
    const assets: { path: string; status: number }[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({ method: request.method(), url: request.url(), body: request.postData() }));
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.includes('/assets/')) assets.push({ path, status: response.status() });
    });
    if (prefix !== '/') {
      const navigation = await page.goto(`${prefix.slice(0, -1)}?entry=canonical`);
      await expect(navigation?.request().redirectedFrom()?.response().then(response => response?.status())).resolves.toBe(308);
      expect(page.url()).toBe(`${origin}${prefix}?entry=canonical`);
      await expect(page.getByLabel('App secret')).toBeVisible();
    }
    await login(page, prefix);
    await page.reload();
    await expect(page.getByRole('button', { name: 'View tag Kitchen token' })).toBeVisible();
    expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0);
    expect(assets.filter(asset => asset.path.endsWith('.js')).length).toBeGreaterThanOrEqual(2);
    expect(assets.filter(asset => asset.path.endsWith('.css')).length).toBeGreaterThanOrEqual(2);
    for (const extension of ['.js', '.css']) expect(assets.some(asset => asset.path.endsWith(extension) && asset.status === 200)).toBe(true);
    expect(assets.every(asset => [200, 304].includes(asset.status) && asset.path.startsWith(`${prefix}assets/`)), JSON.stringify(assets)).toBe(true);

    await page.getByRole('button', { name: 'Add tag / unassigned inbox' }).click();
    const inbox = page.getByRole('region', { name: 'Tag onboarding' });
    await inbox.getByRole('button', { name: 'Choose discovered tag Kitchen token' }).click();
    const naming = inbox.getByRole('region', { name: 'HA tag name' });
    await naming.getByLabel('Requested HA tag name').fill('Synthetic renamed Å');
    await naming.getByRole('button', { name: 'Rename HA tag', exact: true }).click();
    await expect(naming.getByRole('status')).toContainText('HA rename verified by registry readback');
    await naming.getByRole('button', { name: 'Check HA name' }).click();
    await expect(naming.getByRole('status')).toContainText('Current HA name checked: Synthetic renamed Å');
    await inbox.getByLabel('Discovery view').selectOption('observed');
    await expect(inbox.getByRole('button', { name: 'Choose discovered tag Newly observed token' })).toBeVisible();
    await inbox.getByRole('button', { name: 'Close onboarding' }).click();

    const music = page.getByRole('region', { name: 'Music preview', exact: true });
    await music.getByLabel('Search music').fill('synthetic & north');
    await expect(music.getByLabel('Music results')).toContainText('album search: synthetic & north');
    await music.getByRole('button', { name: 'Browse library', exact: true }).click();
    await expect(music.getByLabel('Music results')).toContainText('album library (offset 0)');
    await music.getByRole('button', { name: 'Next music', exact: true }).click();
    await expect(music.getByLabel('Music results')).toContainText('Second library fixture');
    await music.getByLabel('Spotify URI or link', { exact: true }).fill(uri);
    await music.getByRole('button', { name: 'Preview URI', exact: true }).click();
    await expect(music.getByLabel('Selected music preview')).toContainText('Northern lights fixture');
    const logo = music.getByLabel('Selected music preview').getByRole('img', { name: 'Spotify', exact: true });
    await expect.poll(() => logo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(logo).toHaveAttribute('src', `${origin}${prefix}spotify-logo-black.svg`);

    await page.getByRole('button', { name: 'View tag Synthetic renamed Å' }).click();
    const detail = page.getByRole('region', { name: 'Tag detail' });
    await expect(detail.locator('code').first()).toHaveText(exactId);
    const editor = detail.getByRole('region', { name: 'Local draft editor' });
    await editor.getByLabel('Draft Spotify URI or link').fill(uri);
    await editor.getByRole('button', { name: 'Save local draft', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('Local draft saved');
    await detail.getByRole('button', { name: 'Look up mapping metadata' }).click();
    await expect(detail.getByText('Northern lights fixture', { exact: true })).toBeVisible();

    const publication = page.getByRole('region', { name: 'Publication status' });
    await expect(publication).toContainText('Saved app revision: 1');
    await publication.getByRole('button', { name: 'Review snapshot publication' }).click();
    const review = page.getByRole('region', { name: 'Review immutable snapshot' });
    await review.getByLabel('I reviewed this exact snapshot and its preferences').check();
    await review.getByRole('button', { name: 'Confirm snapshot publication' }).click();
    await expect(publication).toContainText('Immutable snapshot queued');
    await publication.getByRole('button', { name: 'Refresh publication status' }).click();
    await publication.getByRole('button', { name: 'Refresh publication status' }).click();
    await expect(publication).toContainText('Published: exact saved content verified active in HA.');
    await publication.getByRole('button', { name: 'Review automatic publication opt-in' }).click();
    await review.getByLabel('I reviewed this exact snapshot and its preferences').check();
    await review.getByLabel('I reviewed backups, exclusive tag-playback dispatch and rollback for automatic publication').check();
    await review.getByRole('button', { name: 'Confirm automatic publication opt-in' }).click();
    await expect(publication).toContainText('Automatic publication opted in for later saves');
    await publication.getByRole('button', { name: 'Suspend automatic publication' }).click();
    await expect(publication).toContainText('Automatic publication suspended');
    await page.getByRole('button', { name: 'Refresh playback status' }).click();
    await expect(page.getByRole('region', { name: 'Tag playback readiness' })).toContainText('Playback: independently unverified');

    const recovery = page.getByRole('region', { name: 'Export and recovery', exact: true });
    const download = page.waitForEvent('download');
    await recovery.getByRole('button', { name: 'Download mapping export' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('jukelet-export-v1.json');
    const content = await readFile((await file.path())!);
    const document = JSON.parse(content.toString());
    expect(document.assignments[0].ha_tag_id).toBe(exactId);
    expect(document.assignments[0].spotify_uri).toBe(uri);
    await recovery.getByLabel('Logical export JSON file').setInputFiles({ name: 'synthetic-export.json', mimeType: 'application/json', buffer: content });
    await recovery.getByRole('button', { name: 'Preview restore' }).click();
    const restored = recovery.getByRole('region', { name: 'Restore preview' });
    await expect(restored).toContainText('1 supported rows');
    const reportDownload = page.waitForEvent('download');
    await restored.getByRole('button', { name: 'Download restore report' }).click();
    const report = JSON.parse(await readFile((await (await reportDownload).path())!, 'utf8'));
    expect(report).not.toHaveProperty('preview_token');
    await restored.getByLabel('Restore conflict policy').selectOption('replace');
    await restored.getByLabel('I reviewed the restore rows and conflict policy').check();
    await restored.getByRole('button', { name: 'Confirm local restore' }).click();
    await expect(recovery.getByRole('status')).toContainText('1 local drafts restored');
    expect(requests.find(request => request.url.endsWith('/api/v1/restores/preview'))?.body).toBe(`{"document":${content.toString()}}`);
    await recovery.getByLabel('Logical export JSON file').setInputFiles({ name: 'unsupported.json', mimeType: 'application/json', buffer: Buffer.from('{"schema_version":2,"assignments":[]}') });
    await recovery.getByRole('button', { name: 'Preview restore' }).click();
    await expect(recovery.getByRole('alert')).toContainText('Invalid or unsupported export');
    await expect(restored.getByRole('button', { name: 'Confirm local restore' })).toBeDisabled();
    await editor.getByRole('button', { name: 'Remove local draft', exact: true }).click();
    await editor.getByRole('button', { name: 'Confirm removal' }).click();
    await expect(editor.getByRole('alert')).toContainText('Another edit changed this draft');
    await expect(editor.getByRole('button', { name: 'Confirm removal' })).toBeDisabled();
    await editor.getByRole('button', { name: 'Reload current draft' }).click();
    await editor.getByRole('button', { name: 'Remove local draft', exact: true }).click();
    await editor.getByRole('button', { name: 'Confirm removal' }).click();
    await expect(editor.getByRole('status')).toContainText('Local draft removed');

    await page.getByRole('link', { name: 'Third-party notices' }).click();
    expect(page.url()).toBe(`${origin}${prefix}third-party-notices.txt`);
    await expect(page.locator('body')).toContainText('Spotify');
    await page.goBack();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByLabel('App secret')).toBeVisible();
    // The only unprefixed browser request above is the deliberate no-slash entry,
    // which the proxy canonicalizes before serving the document or its resources.
    expect(requests.every(request => request.url.startsWith(`${origin}${prefix}`)
      || request.url === `${origin}${prefix.slice(0, -1)}?entry=canonical`)).toBe(true);
    const log = await safeLog(page);
    const api = log.requests.filter(request => request.path.startsWith(`${prefix}api/v1/`));
    for (const [method, endpoint] of [
      ['GET', 'session'], ['POST', 'session'], ['DELETE', 'session'], ['GET', 'status'], ['GET', 'tags?'], ['GET', 'tags/inbox?'],
      ['PATCH', 'tags/'], ['GET', 'music/capabilities'], ['GET', 'music/search?'], ['GET', 'music/library?'], ['POST', 'music/resolve'],
      ['GET', 'assignments?'], ['GET', 'tags/'], ['PUT', 'tags/'], ['DELETE', 'tags/'], ['GET', 'publication'], ['POST', 'publication/review'],
      ['POST', 'publication/confirm'], ['POST', 'publication/suspend'], ['GET', 'playback-status'], ['GET', 'recovery'],
      ['GET', 'export'], ['POST', 'restores/preview'], ['POST', 'restores/confirm'],
    ]) expect(api.some(request => request.method === method && request.path.startsWith(`${prefix}api/v1/${endpoint}`)), `${method} ${endpoint}`).toBe(true);
    for (const suffix of ['name', 'assignment']) expect(api.some(request => request.method === 'GET' && new RegExp(`/tags/[a-f0-9]{64}/${suffix}$`).test(request.path)), `GET tag ${suffix}`).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const redirect of ['ha', 'external'] as const) {
  test(`API redirect toward ${redirect} fails without contacting its target`, async ({ page }) => {
    const prefix = prefixes[1];
    await setup(page, prefix); await login(page, prefix);
    await page.request.post('/__proxy/state', { data: { redirect } });
    // Exercise the URL builder against an altered document base as well.
    await page.evaluate(() => { const base = document.createElement('base'); base.href = 'http://127.0.0.1:4178/'; document.head.append(base); });
    const request = page.waitForRequest(`${origin}${prefix}api/v1/music/resolve`);
    await page.getByLabel('Spotify URI or link', { exact: true }).fill(uri);
    await page.getByRole('button', { name: 'Preview URI', exact: true }).click();
    expect((await request).method()).toBe('POST');
    await expect(page.getByRole('alert')).toContainText('Failed to fetch');
    await safeLog(page);
  });
}

for (const prefix of ['/unsafe%2Fprefix/', '/unsafe%22%3E%3Cscript%3E/']) test(`malformed mount ${prefix} loads compiled UI but refuses all browser APIs`, async ({ page }) => {
  await setup(page, prefix);
  const browserRequests: string[] = [];
  page.on('request', request => browserRequests.push(request.url()));
  await page.goto(prefix);
  await expect(page.getByRole('alert')).toContainText('Invalid application path');
  expect(browserRequests.some(url => url.includes('/api/v1/'))).toBe(false);
  await expect(page.getByLabel('App secret')).toHaveCount(0);
  await safeLog(page);
});
