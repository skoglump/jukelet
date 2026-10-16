import { useEffect, useState, type FormEvent } from 'react';
import './style.css';

interface Session {
  authenticated: true;
  mode: 'read_only';
  expires_at: string;
  csrf_token: string;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/session', { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error('Session unavailable');
        return await response.json() as Session;
      })
      .then((result) => { if (!controller.signal.aborted) setSession(result); })
      .catch(() => {
        if (!controller.signal.aborted) setError('Unable to reach Jukelet. Please try again.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!session) return;
    const timeout = window.setTimeout(() => {
      setSession(null);
      setError('Your session expired. Please sign in again.');
    }, Math.max(0, Date.parse(session.expires_at) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [session]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/session', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }),
      });
      if (response.status === 401) setError('That app secret was not accepted.');
      else if (response.status === 429) setError('Too many attempts. Please wait a minute.');
      else if (!response.ok) setError('Unable to sign in. Please try again.');
      else setSession(await response.json() as Session);
    } catch { setError('Unable to reach Jukelet. Please try again.'); }
    finally { setSecret(''); setBusy(false); }
  }

  async function logout() {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/session', {
        method: 'DELETE', credentials: 'same-origin',
        headers: { 'X-CSRF-Token': session.csrf_token },
      });
      if (response.ok || response.status === 401) setSession(null);
      else setError('Unable to sign out. Please try again.');
    } catch { setError('Unable to reach Jukelet. Please try again.'); }
    finally { setBusy(false); }
  }

  return (
    <main>
      <header><p className="eyebrow">A personal jukebox</p><h1>Jukelet</h1>
        <p className="tagline">Your music. A little more hands-on.</p></header>
      <section aria-label="Your Jukelet">
        {loading ? <p role="status">Checking your session…</p> : session ? <>
          <span className="badge">Read-only</span><h2>A place for your music</h2>
          <p>Integrations not connected.</p>
          <p className="muted">Tag inventory and music discovery will arrive in the next milestone.</p>
          <button disabled={busy} onClick={() => void logout()}>{busy ? 'Signing out…' : 'Sign out'}</button>
        </> : <form onSubmit={(event) => void login(event)}>
          <h2>Welcome back</h2><p>Use your app secret to sign in.</p>
          <label htmlFor="secret">App secret</label>
          <input id="secret" type="password" autoComplete="current-password" required
            maxLength={128} value={secret} onChange={(event) => setSecret(event.target.value)} />
          <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>}
        {error && <p role="alert">{error}</p>}
      </section>
      <footer>Made for music you can reach out and touch.</footer>
    </main>
  );
}
