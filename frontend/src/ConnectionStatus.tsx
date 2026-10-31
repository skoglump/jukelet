import { apiFetch } from './urls';
import { useEffect, useState } from 'react';

interface Status {
  connection: 'not_configured' | 'connecting' | 'connected' | 'disconnected' | 'unauthorized';
  version: string | null;
  tag_list: string;
  scan_subscription: string;
  subscribed: boolean;
  services: Record<string, { state: string }>;
  inventory_stale: boolean;
  inventory_updated_at: string | null;
  services_updated_at: string | null;
  discovery_gap: boolean;
  error: string | null;
}

const labels = {
  not_configured: 'Home Assistant is not configured.', connecting: 'Connecting to Home Assistant…',
  connected: 'Home Assistant connected.', disconnected: 'Home Assistant disconnected.',
  unauthorized: 'Home Assistant authentication rejected.',
};

export function ConnectionStatus({ onExpired }: { onExpired: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      try {
        const response = await apiFetch('status', { signal: controller.signal, credentials: 'same-origin' });
        if (controller.signal.aborted) return;
        if (response.status === 401) { onExpired(); return; }
        if (!response.ok) throw new Error('Status unavailable');
        const result = await response.json() as Status;
        if (!result || !(result.connection in labels) || !result.services) throw new Error('Invalid status');
        if (!controller.signal.aborted) { setStatus(result); setFailed(false); }
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => { void poll(); }, 10_000);
      }
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [onExpired]);
  return <section id="connections" aria-label="Home Assistant status" aria-live="polite">
    <h2>Connections</h2>
    {failed && <p role="alert">Unable to refresh connection status. Displayed information may be stale.</p>}
    {!status ? !failed && <p role="status">Loading connection status…</p> : <>
      <p>{labels[status.connection]} {status.version && `Version ${status.version}`}</p>
      <p>Tag reads: {status.tag_list}. Scan notifications: {status.scan_subscription}
        {status.subscribed ? ' (subscribed)' : ' (not subscribed)'}.</p>
      <ul>{Object.entries(status.services).map(([name, capability]) =>
        <li key={name}>SpotifyPlus {name.replaceAll('_', ' ')}: {capability.state}</li>)}</ul>
      {status.inventory_stale && <p>Tag cache is stale or has not been loaded.</p>}
      {status.inventory_updated_at && <p>Tag cache updated: {new Date(status.inventory_updated_at).toLocaleString()}</p>}
      {status.services_updated_at && <p>Capabilities updated: {new Date(status.services_updated_at).toLocaleString()}</p>}
      {status.discovery_gap && <p>Some scan notifications may have been missed. Reconnection refreshes the registry.</p>}
      {status.error && <p>Last HA error: {status.error.replaceAll('_', ' ')}.</p>}
    </>}
  </section>;
}
