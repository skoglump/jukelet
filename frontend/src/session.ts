// Browser authority comes only from the backend session contract, never routing.
export type Runtime = 'standalone' | 'ingress';

export interface Session {
  authenticated: true;
  mode: 'read_only' | 'manage';
  runtime: Runtime;
  user_id: string | null;
  expires_at: string;
  csrf_token: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSession(value: unknown): Session {
  if (!record(value)
    || value.authenticated !== true
    || (value.mode !== 'read_only' && value.mode !== 'manage')
    || (value.runtime !== 'standalone' && value.runtime !== 'ingress')
    || (value.runtime === 'standalone' ? value.user_id !== null
      : typeof value.user_id !== 'string' || !/^[0-9a-f]{32}$/.test(value.user_id))
    || typeof value.csrf_token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.csrf_token)
    || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))
    || Date.parse(value.expires_at) <= Date.now()) {
    throw new Error('Invalid session');
  }
  return value as unknown as Session;
}

export function standaloneLoginRequired(value: unknown): boolean {
  return record(value) && record(value.detail)
    && value.detail.code === 'standalone_authentication_required'
    && value.detail.runtime === 'standalone';
}

export async function sessionBody(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('Invalid session response');
  }
  return await response.json() as unknown;
}
