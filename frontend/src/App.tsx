import { useCallback, useEffect, useState, type FormEvent } from 'react';
import './style.css';
import { Inventory } from './Inventory';
import { MusicPreview } from './MusicPreview';
import { DraftList } from './Assignments';
import { Recovery } from './Recovery';
import { Publication } from './Publication';
import { ConnectionStatus } from './ConnectionStatus';
import { PlaybackStatus } from './PlaybackStatus';

interface Session {
  authenticated: true;
  mode: 'read_only' | 'manage';
  expires_at: string;
  csrf_token: string;
}

export function App() {
  const [draftRevision, setDraftRevision] = useState(0);
  const draftChanged = useCallback(() => setDraftRevision(value => value + 1), []);
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

  const expireSession = useCallback(() => {
    setSession(null);
    setError('Your session expired. Please sign in again.');
  }, []);

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
      <a className="skip-link" href="#manager">Skip to manager</a>
      {import.meta.env.MODE === 'fixture' && <aside className="fixture-banner" role="note">Synthetic fixture demo · No household connection. All tags, music, status and authentication are simulated.</aside>}
      <header><p className="eyebrow">A personal jukebox</p><h1>Jukelet</h1>
        <p className="tagline">Your music. A little more hands-on.</p></header>
      <section id="manager" aria-label="Your Jukelet">
        {loading ? <p role="status">Checking your session…</p> : session ? <>
          <span className="badge">{session.mode === 'manage' ? 'Local management' : 'Read-only'}</span><h2>Your tag and music manager</h2><p>Browse tags, edit saved assignments and discover music.</p><aside className="draft-banner">{session.mode === 'manage' && <>Manage mode also enables explicit HA tag renames, verified by registry readback. </>}Local drafts and active HA snapshots have separate outcomes. Saving never starts playback. Automatic publication requires explicit persistent opt-in.</aside>
          <nav className="manager-nav" aria-label="Manager sections"><a href="#tags">Tags</a><a href="#drafts">Local drafts</a><a href="#music">Discover music</a><a href="#publication">Publication</a><a href="#playback">Playback readiness</a><a href="#connections">Connections</a><a href="#recovery">Export and recovery</a></nav>
          <ConnectionStatus onExpired={expireSession} />
          <div className="manager-grid"><Inventory csrf={session.csrf_token} onExpired={expireSession} manage={session.mode === 'manage'} onDraftChanged={draftChanged} />
          <MusicPreview csrf={session.csrf_token} onExpired={expireSession} /></div>
          <DraftList csrf={session.csrf_token} onExpired={expireSession} onChanged={draftChanged} revision={draftRevision} manage={session.mode === 'manage'} />
          <Publication csrf={session.csrf_token} manage={session.mode === 'manage'} revision={draftRevision} onExpired={expireSession} />
          <PlaybackStatus onExpired={expireSession} />
          <Recovery csrf={session.csrf_token} manage={session.mode === 'manage'} revision={draftRevision} onExpired={expireSession} onChanged={draftChanged} />
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
      <footer>Made for music you can reach out and touch. <a href="/third-party-notices.txt">Third-party notices</a></footer>
    </main>
  );
}
