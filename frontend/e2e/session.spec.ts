import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('container login, reload, cookie boundary, and logout', async ({ page, context }) => {
  const file = process.env.JUKELET_SECRET_FILE;
  if (!file || !process.env.JUKELET_E2E_URL) throw new Error('Run through scripts/smoke.py --browser');
  const syntheticSecret = readFileSync(file, 'utf8').trim();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('App secret').fill(syntheticSecret);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Home Assistant is not configured.')).toBeVisible();
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find((item) => item.name === 'jukelet_session');
  expect(Boolean(cookie?.httpOnly && cookie.sameSite === 'Strict')).toBe(true);
  expect(cookie?.secure).toBe(false); // Explicit localhost development configuration only.
  expect(await page.evaluate(() => document.cookie)).toBe('');
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByText('Registry unavailable. Connect Home Assistant to load registered tags.')).toBeVisible();
  const exactId = '  Synthetic:Å/04:AB  ';
  const source = JSON.stringify({ variables: { tags: {
    [exactId]: { media_content_type: 'album', media_content_id: 'spotify:album:0123456789ABCDEFGHIJKL' },
    'unsupported-track': { media_content_type: 'track', media_content_id: 'spotify:track:0123456789ABCDEFGHIJKL' },
  } } });
  await page.getByLabel('JSON or YAML file (up to 1 MiB)').setInputFiles({
    name: 'synthetic-mapping.json', mimeType: 'application/json', buffer: Buffer.from(source),
  });
  await page.getByRole('button', { name: 'Preview file', exact: true }).click();
  await expect(page.getByText('Row 1: Accepted for preview')).toBeVisible();
  await expect(page.getByText('Row 2: Rejected')).toBeVisible();
  await expect(page.getByText('Only albums and playlists are supported')).toBeVisible();
  await page.getByLabel('Spotify URI or link').fill('spotify:album:0123456789ABCDEFGHIJKL');
  await page.getByRole('button', { name: 'Preview URI', exact: true }).click();
  const musicPreview = page.getByLabel('Selected music preview');
  await expect(musicPreview.getByText('spotify:album:0123456789ABCDEFGHIJKL')).toBeVisible();
  await expect(musicPreview.getByText(/Lookup availability does not determine playability/)).toBeVisible();
  await expect(page.getByText('Row 1: Accepted for preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Browse library', exact: true })).toBeDisabled();
  await page.getByLabel('Spotify URI or link').fill('https://untrusted.example/album/fixture');
  await page.getByRole('button', { name: 'Preview URI', exact: true }).click();
  await expect(page.getByText(/Unsupported Spotify URI, link or media type/)).toBeVisible();
  await expect(musicPreview.getByText('spotify:album:0123456789ABCDEFGHIJKL')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download preview report' }).click();
  const downloaded = await downloadPromise;
  const reportPath = await downloaded.path();
  if (!reportPath) throw new Error('Report download missing');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  expect(report.rows[0].ha_tag_id).toBe(exactId);
  expect(report.counts).toEqual({ mappings: 2, accepted: 1, rejected: 1, matched: null, unassigned: null, orphaned: null });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('App secret')).toHaveValue('');
  expect((await context.cookies()).some((item) => item.name === 'jukelet_session')).toBe(false);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/login-mobile.png' });
});
