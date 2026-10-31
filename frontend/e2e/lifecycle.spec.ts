// Compiled UI + synthetic normalized API. This is not Supervisor/HA OS evidence.
import { expect, test, type Page } from '@playwright/test';

const prefix = '/api/hassio_ingress/synthetic_A-123/';
const origin = 'http://127.0.0.1:4176';
const uri = 'spotify:album:0123456789ABCDEFGHIJKL';
const pendingUri = 'spotify:playlist:ABCDEFGHIJKL0123456789';
const exactId = '  Synthetic:Å/04:AB  ';
const exportFile = { name: 'synthetic-recovery.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
  schema_version: 1, assignments: [{ ha_tag_id: exactId, spotify_uri: uri, media_type: 'album', enabled: true, shuffle: false, playback_profile_id: 'default' }],
})) };
const manager = (page: Page) => page.getByRole('heading', { name: 'Your tag and music manager', exact: true });
const recovery = (page: Page) => page.getByRole('region', { name: 'Export and recovery', exact: true });
const publication = (page: Page) => page.getByRole('region', { name: 'Publication status', exact: true });
const review = (page: Page) => page.getByRole('region', { name: 'Review immutable snapshot', exact: true });
const restore = (page: Page) => page.getByRole('region', { name: 'Restore preview', exact: true });

async function state(page: Page, values: Record<string, string>, mount = prefix) {
  expect((await page.request.post(`${mount}__fixtures/state`, { data: { scenario: 'manage', ...values } })).status()).toBe(200);
}
async function setup(page: Page, values: Record<string, string> = {}, mount = prefix) {
  expect((await page.request.post('/__proxy/state', { data: { prefix: mount, reset: true } })).ok()).toBe(true);
  await state(page, { reset: 'yes', seed: 'yes', runtime: 'ingress', ...values }, mount);
  await page.goto(mount);
}
function requests(page: Page, mount = prefix) {
  const api: { method: string; path: string; csrf: string | undefined; body: Record<string, unknown> | null }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith(`${origin}${mount}api/v1/`)) return;
    api.push({ method: request.method(), path: new URL(request.url()).pathname, csrf: request.headers()['x-csrf-token'], body: request.postDataJSON() as Record<string, unknown> | null });
  });
  return { api, errors, mutations: () => api.filter(request => request.method !== 'GET') };
}
async function safe(page: Page) {
  const log = await page.request.get('/__proxy/log').then(response => response.json());
  expect(log.outside).toEqual([]); expect(log.externalHits).toBe(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
}
async function reject(page: Page, access = 'gateway401') {
  await state(page, { access });
  await publication(page).getByRole('button', { name: 'Refresh publication status' }).click();
  await expect(page.getByRole('heading', { name: 'Check your access', exact: true })).toBeFocused();
  await expect(manager(page)).toHaveCount(0);
}
async function reopen(page: Page, values: Record<string, string> = {}, selectedTag = false) {
  await state(page, { access: 'ok', renew: 'yes', ...values });
  await page.getByRole('button', { name: 'Check access again', exact: true }).click();
  await expect(manager(page)).toBeVisible();
  await expect(selectedTag ? page.getByRole('region', { name: 'Tag detail' }).getByRole('heading', { name: 'Kitchen token', exact: true }) : manager(page)).toBeFocused();
}
async function preparePublication(page: Page) {
  const response = page.waitForResponse(`${origin}${prefix}api/v1/publication/review`);
  await publication(page).getByRole('button', { name: 'Review snapshot publication' }).click();
  const token = (await (await response).json()).review_token as string;
  await expect(review(page).getByRole('heading', { name: 'Review snapshot', exact: true })).toBeFocused();
  return token;
}
async function prepareRestore(page: Page) {
  const response = page.waitForResponse(`${origin}${prefix}api/v1/restores/preview`);
  await recovery(page).getByRole('button', { name: 'Preview restore', exact: true }).click();
  const token = (await (await response).json()).preview_token as string;
  await expect(restore(page).getByRole('heading', { name: 'Reviewed restore' })).toBeFocused();
  return token;
}

test('standalone flow remains explicit under an Ingress-shaped mount', async ({ page }) => {
  const seen = requests(page);
  await setup(page, { runtime: 'standalone' });
  await expect(page.getByLabel('App secret')).toBeFocused();
  await page.keyboard.type('synthetic-fixture-secret'); await page.keyboard.press('Enter');
  await expect(manager(page)).toBeFocused();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByLabel('Spotify URI or link', { exact: true }).fill(pendingUri);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('App secret')).toBeFocused();
  await expect(page.getByLabel('App secret')).toHaveValue('');
  await page.getByLabel('App secret').fill('synthetic-fixture-secret'); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Spotify URI or link', { exact: true })).toHaveValue('');
  expect(seen.mutations().map(request => request.method)).toEqual(['POST', 'DELETE', 'POST']);
  expect(seen.errors).toEqual([]); await safe(page);
});

test('explicit Ingress at root never offers an app secret or app-only logout', async ({ page }) => {
  const seen = requests(page, '/');
  await setup(page, {}, '/');
  await expect(manager(page)).toBeFocused();
  await expect(page.getByLabel('App secret')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await expect(page.getByText('Access is managed by Home Assistant. Manage sign-in there.')).toBeVisible();
  expect(seen.mutations()).toEqual([]); expect(seen.errors).toEqual([]); await safe(page);
});

for (const access of ['gateway401', 'gateway403', 'denied']) test(`${access} is accessible and manually recoverable without login loops or writes`, async ({ page }) => {
  const seen = requests(page);
  await page.clock.install();
  await setup(page, { access });
  await expect(page.getByRole('heading', { name: 'Check your access', exact: true })).toBeFocused();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('App secret')).toHaveCount(0);
  const count = seen.api.length;
  await page.clock.fastForward(30000);
  expect(seen.api.length).toBe(count); expect(seen.mutations()).toEqual([]);
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Check access again' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => seen.api.length).toBe(count + 1);
  await expect(page.getByRole('alert')).toBeVisible();
  await reopen(page);
  await expect(page.getByLabel('App secret')).toHaveCount(0);
  expect(seen.mutations()).toEqual([]); expect(seen.errors).toEqual([]); await safe(page);
});

test('network failure has no secret form and only a deliberate access check retries', async ({ page }) => {
  const seen = requests(page);
  await page.route(`**${prefix}api/v1/session`, route => route.abort('connectionfailed'));
  await setup(page);
  await expect(page.getByRole('heading', { name: 'Check your access', exact: true })).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('Unable to reach Jukelet');
  await expect(page.getByLabel('App secret')).toHaveCount(0);
  expect(seen.mutations()).toEqual([]);
  await page.unroute(`**${prefix}api/v1/session`);
  await page.getByRole('button', { name: 'Check access again' }).click();
  await expect(manager(page)).toBeFocused(); await safe(page);
});

test('expiry and synthetic page reopening recover only the same user inputs and File, without saving', async ({ page }) => {
  const seen = requests(page);
  await page.clock.install();
  await setup(page, { session_seconds: '5' });
  await page.getByRole('button', { name: 'View tag Kitchen token' }).click();
  const editor = page.getByRole('region', { name: 'Tag detail' });
  await editor.getByLabel('Draft Spotify URI or link').fill(pendingUri);
  await editor.getByLabel('Draft media type').selectOption('playlist');
  await editor.getByLabel('Enabled draft').uncheck();
  await page.getByLabel('Spotify URI or link', { exact: true }).fill(pendingUri);
  await recovery(page).getByLabel('Logical export JSON file').setInputFiles(exportFile);
  await page.clock.fastForward(6000);
  await expect(page.getByRole('heading', { name: 'Check your access' })).toBeFocused();
  await expect(editor).toHaveCount(0); await expect(page.getByText(exportFile.name, { exact: true })).toHaveCount(0);
  expect(seen.mutations()).toEqual([]);
  await reopen(page, { session_seconds: '3600' }, true);
  await expect(editor.getByLabel('Draft Spotify URI or link')).toHaveValue(pendingUri);
  await expect(editor.getByLabel('Enabled draft')).not.toBeChecked();
  await expect(editor).toContainText(exactId);
  await expect(editor.getByRole('button', { name: 'Save local draft', exact: true })).toBeDisabled();
  await expect(editor.getByLabel('I reviewed recovered input against the current draft')).not.toBeChecked();
  await expect(recovery(page)).toContainText(`${exportFile.name} Retained for this authorized user`);
  await expect(recovery(page).getByRole('button', { name: 'Preview restore', exact: true })).toBeEnabled();
  await expect(restore(page)).toHaveCount(0); expect(seen.mutations()).toEqual([]);
  // Headless Chromium does not hide background tabs. Exercise the browser's
  // lifecycle event boundary explicitly; this does not certify HA's iframe.
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.getByRole('heading', { name: 'Check your access' })).toBeVisible();
  await reopen(page, {}, true);
  await expect(editor.getByLabel('Draft Spotify URI or link')).toHaveValue(pendingUri);
  await reject(page, 'denied'); await reopen(page, { user: 'synthetic-user-b' });
  await expect(editor).toHaveCount(0);
  await expect(page.getByLabel('Spotify URI or link', { exact: true })).toHaveValue('');
  await expect(recovery(page).getByRole('button', { name: 'Preview restore', exact: true })).toBeDisabled();
  await expect(recovery(page)).not.toContainText(exportFile.name);
  expect(seen.mutations()).toEqual([]); expect(seen.errors).toEqual([]); await safe(page);
});

test('session renewal drops old reviews and attestations; cancel and fresh explicit confirmations use new CSRF', async ({ page }) => {
  const seen = requests(page);
  await setup(page);
  const oldPublication = await preparePublication(page);
  await review(page).getByLabel('I reviewed this exact snapshot and its preferences').check();
  await recovery(page).getByLabel('Logical export JSON file').setInputFiles(exportFile);
  const oldRestore = await prepareRestore(page);
  await restore(page).getByLabel('Restore conflict policy').selectOption('replace');
  await restore(page).getByLabel('I reviewed the restore rows and conflict policy').check();
  await reject(page); const before = seen.mutations().length; await reopen(page);
  expect(seen.mutations().length).toBe(before);
  await expect(review(page)).toHaveCount(0); await expect(restore(page)).toHaveCount(0);
  const cancelledPublication = await preparePublication(page);
  await review(page).getByRole('button', { name: 'Cancel publication review' }).click();
  await expect(publication(page).getByRole('button', { name: 'Review snapshot publication' })).toBeFocused();
  expect(seen.api.filter(request => request.path.endsWith('/publication/confirm'))).toHaveLength(0);
  const freshPublication = await preparePublication(page);
  expect(new Set([oldPublication, cancelledPublication, freshPublication]).size).toBe(3);
  await expect(review(page).getByLabel('I reviewed this exact snapshot and its preferences')).not.toBeChecked();
  await expect(review(page).getByRole('button', { name: 'Confirm snapshot publication' })).toBeDisabled();
  await review(page).getByLabel('I reviewed this exact snapshot and its preferences').check();
  await review(page).getByRole('button', { name: 'Confirm snapshot publication' }).focus(); await page.keyboard.press('Enter');
  await expect(publication(page)).toContainText('Immutable snapshot queued');
  const cancelledRestore = await prepareRestore(page);
  await restore(page).getByLabel('Restore conflict policy').selectOption('replace');
  await restore(page).getByLabel('I reviewed the restore rows and conflict policy').check();
  await recovery(page).getByRole('button', { name: 'Cancel restore preview' }).click();
  await expect(recovery(page).getByRole('button', { name: 'Preview restore', exact: true })).toBeFocused();
  const freshRestore = await prepareRestore(page);
  expect(new Set([oldRestore, cancelledRestore, freshRestore]).size).toBe(3);
  await expect(restore(page).getByLabel('Restore conflict policy')).toHaveValue('');
  await expect(restore(page).getByLabel('I reviewed the restore rows and conflict policy')).not.toBeChecked();
  await expect(restore(page).getByRole('button', { name: 'Confirm local restore' })).toBeDisabled();
  await restore(page).getByLabel('Restore conflict policy').selectOption('replace');
  await restore(page).getByLabel('I reviewed the restore rows and conflict policy').check();
  await restore(page).getByRole('button', { name: 'Confirm local restore' }).focus(); await page.keyboard.press('Enter');
  await expect(recovery(page).getByRole('status')).toContainText('1 local drafts restored');
  const confirms = seen.api.filter(request => request.path.endsWith('/confirm'));
  expect(confirms).toHaveLength(2);
  expect(confirms.map(request => request.csrf)).toEqual(['synthetic-fixture-csrf-1', 'synthetic-fixture-csrf-1']);
  expect(confirms.map(request => request.body?.review_token ?? request.body?.preview_token)).toEqual([freshPublication, freshRestore]);
  expect(seen.api.filter(request => request.path.endsWith('/session')).every(request => request.method === 'GET')).toBe(true);
  expect(seen.errors).toEqual([]); await safe(page);
});

test('concurrent saved edits reject stale publication and restore reviews without retrying', async ({ page }) => {
  const seen = requests(page);
  await setup(page); await preparePublication(page);
  await recovery(page).getByLabel('Logical export JSON file').setInputFiles(exportFile); await prepareRestore(page);
  const draft = await page.request.get(`${prefix}api/v1/assignments`).then(response => response.json());
  const saved = draft.assignments[0];
  const result = await page.request.put(`${prefix}api/v1/tags/${saved.tag_key}/assignment`, { headers: { 'X-CSRF-Token': 'synthetic-fixture-csrf' }, data: { ...saved, input: saved.spotify_uri, expected_version: saved.version } });
  expect(result.status()).toBe(200);
  await review(page).getByLabel('I reviewed this exact snapshot and its preferences').check();
  await review(page).getByRole('button', { name: 'Confirm snapshot publication' }).click();
  await expect(publication(page).getByRole('alert')).toContainText('Review the current snapshot again');
  await expect(review(page)).toHaveCount(0);
  await restore(page).getByLabel('Restore conflict policy').selectOption('replace');
  await restore(page).getByLabel('I reviewed the restore rows and conflict policy').check();
  await restore(page).getByRole('button', { name: 'Confirm local restore' }).click();
  await expect(recovery(page).getByRole('alert')).toContainText('Preview again');
  await expect(restore(page).getByRole('button', { name: 'Confirm local restore' })).toBeDisabled();
  expect(seen.api.filter(request => request.path.endsWith('/confirm'))).toHaveLength(2);
  expect(seen.errors).toEqual([]); await safe(page);
});

for (const width of [1024, 600, 390, 320]) test(`Ingress manager, reviews and denied state fit ${width}px with keyboard focus`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await setup(page);
  await expect(manager(page)).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Tags', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'View tag Kitchen token' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Tag detail' }).getByRole('heading', { name: 'Kitchen token', exact: true })).toBeFocused();
  await preparePublication(page);
  await recovery(page).getByLabel('Logical export JSON file').setInputFiles(exportFile); await prepareRestore(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await page.locator('button:visible,input:visible,select:visible').all()) {
    const box = await control.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width + 1).toBeTruthy();
  }
  if (width === 600 || width === 390) await page.screenshot({ path: `test-results/lifecycle-${width}-reviews.png`, fullPage: true });
  await reject(page, 'gateway403');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Check access again' })).toBeFocused();
  if (width === 390) await page.screenshot({ path: 'test-results/lifecycle-390-denied.png' });
  await safe(page);
});
