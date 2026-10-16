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
  await expect(page.getByText('Integrations not connected.')).toBeVisible();
  await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find((item) => item.name === 'jukelet_session');
  expect(Boolean(cookie?.httpOnly && cookie.sameSite === 'Strict')).toBe(true);
  expect(cookie?.secure).toBe(false); // Explicit localhost development configuration only.
  expect(await page.evaluate(() => document.cookie)).toBe('');
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('App secret')).toHaveValue('');
  expect((await context.cookies()).some((item) => item.name === 'jukelet_session')).toBe(false);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/login-mobile.png' });
});
