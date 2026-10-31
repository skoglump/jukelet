import { createContext, useCallback, useContext } from 'react';
import type { Session } from './session';
import { apiFetch } from './urls';

const bodyMethods = new Set(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
export interface InputDraft { readonly value: unknown }

/** One verified browser session. Closing it fences requests and body continuations. */
export class SessionAccess {
  private readonly controller = new AbortController();

  constructor(readonly session: Session, private readonly onRejected: () => void,
    readonly inputDrafts: Map<string, InputDraft> = new Map()) {}

  get active(): boolean { return !this.controller.signal.aborted; }
  get signal(): AbortSignal { return this.controller.signal; }
  close(): void { this.controller.abort(); }
  reject(): void {
    if (!this.active) return;
    this.close();
    this.onRejected();
  }

  private check(signal?: AbortSignal): void {
    if (!this.active || signal?.aborted) throw new DOMException('Session access unavailable', 'AbortError');
  }

  private response(response: Response, signal?: AbortSignal): Response {
    return new Proxy(response, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'clone') return () => { this.check(signal); return this.response(target.clone(), signal); };
        if (typeof value !== 'function') return value;
        const method = value.bind(target) as (...args: unknown[]) => unknown;
        if (!bodyMethods.has(String(property))) return method;
        return async (...args: unknown[]) => {
          this.check(signal);
          const result: unknown = await method(...args);
          this.check(signal);
          return result;
        };
      },
    });
  }

  async fetch(endpoint: string, options?: RequestInit): Promise<Response> {
    this.check(options?.signal ?? undefined);
    const signal = options?.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    const response = await apiFetch(endpoint, { ...options, signal });
    this.check(signal);
    if (response.status === 401 || response.status === 403) {
      // A rejected HA rename is an upstream domain outcome, not browser logout.
      // All other unverified access/CSRF/mode failures close the manager boundary.
      let domainRejection = false;
      if (response.status === 403 && options?.method === 'PATCH' && /^tags\/[A-Za-z0-9_-]+\/name$/.test(endpoint)) {
        const value: unknown = await response.clone().json().catch(() => null);
        this.check(signal);
        const detail = value && typeof value === 'object' && 'detail' in value ? value.detail : null;
        domainRejection = Boolean(detail && typeof detail === 'object' && 'code' in detail && detail.code === 'forbidden'
          && 'state' in detail && detail.state === 'rejected');
      }
      if (!domainRejection) { this.reject(); this.check(signal); }
    }
    return this.response(response, signal);
  }
}

export const SessionAccessContext = createContext<SessionAccess | null>(null);

export function useApiFetch(): typeof apiFetch {
  const access = useContext(SessionAccessContext);
  return useCallback((endpoint, options) => access ? access.fetch(endpoint, options) : apiFetch(endpoint, options), [access]);
}
