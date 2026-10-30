import { afterEach, expect, test, vi } from 'vitest';
import { apiFetch, appBasePath, appUrl } from './urls';

afterEach(() => {
  document.querySelectorAll('base').forEach(element => element.remove());
  window.history.replaceState(null, '', `${window.location.origin}/`);
  vi.unstubAllGlobals();
});

test.each(['/', '/api/hassio_ingress/synthetic_A-123/', '/another/Ingress_token_456/'])('URLs stay under the document mount %s', async prefix => {
  window.history.replaceState(null, '', `${prefix}?ignored=external#music`);
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  const base = document.createElement('base');
  base.href = 'https://untrusted.example/';
  document.head.append(base);
  expect(appBasePath()).toBe(prefix);
  expect(appUrl('spotify-logo-black.svg')).toBe(`${window.location.origin}${prefix}spotify-logo-black.svg`);
  await apiFetch('music/search?q=a%26b&media_type=album', { method: 'GET', credentials: 'include', redirect: 'follow' });
  expect(fetchMock).toHaveBeenCalledWith(`${window.location.origin}${prefix}api/v1/music/search?q=a%26b&media_type=album`, {
    method: 'GET', credentials: 'same-origin', redirect: 'error',
  });
});

test.each([
  '', 'relative/', '//untrusted.example/', 'https://untrusted.example/', '/no-trailing-slash',
  '/double//slash/', '/a/../', '/a/./', '/a/%2e%2e/', '/a/%2F/', '/a/%252f/',
  '/a\\evil/', '/a/?query/', '/a/#hash/', '/a/ space/', '/a/\n/', '/\n', '/<script>/', '/Å/', `/${'a'.repeat(2048)}/`,
])('rejects unsafe or ambiguous prefix %j', prefix => {
  expect(() => appBasePath(prefix)).toThrow('Invalid application path');
});

test.each(['', '/api/v1/tags', '//untrusted.example', 'https://untrusted.example', '../api', './api', 'a/../api',
  'a/%2e%2e/api', 'a/%2f/api', 'a//api', 'a\\api', 'api#fragment', 'api?x=\nvalue'])('rejects escaping resource %j before fetch', endpoint => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  expect(() => appUrl(endpoint)).toThrow('Invalid application resource');
  expect(() => apiFetch(endpoint)).toThrow('Invalid application resource');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('redirect failures propagate without retrying another URL', async () => {
  const fetchMock = vi.fn().mockRejectedValue(new TypeError('redirect rejected'));
  vi.stubGlobal('fetch', fetchMock);
  await expect(apiFetch('export')).rejects.toThrow('redirect rejected');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
