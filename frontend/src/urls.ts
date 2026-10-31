// The manager uses hash navigation; its document lives at the proxy's directory
// mount. This is routing context only, never an authentication/runtime-mode signal.
export function appBasePath(pathname = window.location.pathname): string {
  if (pathname.length > 2048 || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(pathname)) {
    throw new Error('Invalid application path');
  }
  return pathname;
}

export function appUrl(resource: string): string {
  const [path] = resource.split('?');
  if (!path || !path.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(segment))
    || /[\s\\#]/.test(resource)) {
    throw new Error('Invalid application resource');
  }
  // An explicit origin also prevents an injected <base> from changing the target.
  return `${window.location.origin}${appBasePath()}${resource}`;
}

export function apiFetch(endpoint: string, options?: RequestInit): Promise<Response> {
  return fetch(appUrl(`api/v1/${endpoint}`), {
    ...options, credentials: 'same-origin', redirect: 'error',
  });
}
