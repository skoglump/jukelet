import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import './style.css';
import { Inventory } from './Inventory';
import { MusicPreview } from './MusicPreview';
import { DraftList } from './Assignments';
import { Recovery } from './Recovery';
import { Publication } from './Publication';
import { ConnectionStatus } from './ConnectionStatus';
import { PlaybackStatus } from './PlaybackStatus';
import { apiFetch, appBasePath, appUrl } from './urls';
import { parseSession, sessionBody, standaloneLoginRequired, type Runtime, type Session } from './session';
import { SessionAccess, SessionAccessContext, type InputDraft } from './sessionAccess';

// Read afresh at each boundary: browser visibility can change across an await.
function pageHidden() { return document.visibilityState === 'hidden'; }

export function App() {
  try { appBasePath(); }
  catch { return <main><h1>Jukelet</h1><p role="alert">Invalid application path. Open Jukelet at its configured directory address.</p></main>; }
  return <AppContent />;
}

function AppContent() {
  const [draftRevision, setDraftRevision] = useState(0);
  const [access, setAccess] = useState<SessionAccess | null>(null);
  const activeAccess = useRef<SessionAccess | null>(null);
  const authOperation = useRef(0);
  const pendingAuth = useRef<AbortController | null>(null);
  const inputDrafts = useRef(new Map<string, InputDraft>());
  const draftOwner = useRef<string | null>(null);
  const session = access?.session ?? null;
  const draftChanged = useCallback(() => {
    if (access?.active && activeAccess.current === access) setDraftRevision(value => value + 1);
  }, [access]);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [loginAvailable, setLoginAvailable] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const accessHeading = useRef<HTMLHeadingElement>(null);
  const managerHeading = useRef<HTMLHeadingElement>(null);
  const loginInput = useRef<HTMLInputElement>(null);

  const pauseAccess = useCallback(() => {
    const current = activeAccess.current;
    if (current?.active) current.reject();
    else {
      authOperation.current += 1;
      pendingAuth.current?.abort();
      setBusy(false); setLoading(false); setSecret('');
    }
    setLoginAvailable(false);
    setError('Access was paused while this page was away. Check access again before continuing.');
  }, []);

  const acceptSession = useCallback((nextSession: Session) => {
    // Visibility may already be hidden before mount or before its event is
    // delivered. No authentication callback may grant authority in that state.
    if (pageHidden()) { pauseAccess(); return; }
    activeAccess.current?.close();
    const owner = JSON.stringify([nextSession.runtime, nextSession.user_id, nextSession.mode]);
    if (draftOwner.current !== owner) { inputDrafts.current.clear(); draftOwner.current = owner; }
    const next: SessionAccess = new SessionAccess(nextSession, () => {
      if (activeAccess.current !== next) return;
      authOperation.current += 1;
      pendingAuth.current?.abort();
      activeAccess.current = null;
      setAccess(null); setBusy(false); setLoading(false); setSecret('');
      setLoginAvailable(nextSession.runtime === 'standalone');
      setError(nextSession.runtime === 'ingress'
        ? 'Your session expired or access changed. Check access again through Home Assistant.'
        : 'Your session expired. Please sign in again.');
    }, inputDrafts.current);
    activeAccess.current = next;
    setAccess(next); setRuntime(nextSession.runtime); setLoginAvailable(false); setBusy(false);
  }, [pauseAccess]);

  useEffect(() => {
    const visibility = () => { if (pageHidden()) pauseAccess(); };
    const reopen = (event: PageTransitionEvent) => { if (event.persisted) pauseAccess(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pauseAccess);
    window.addEventListener('pageshow', reopen);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pauseAccess);
      window.removeEventListener('pageshow', reopen);
      authOperation.current += 1;
      pendingAuth.current?.abort();
      activeAccess.current?.close();
      activeAccess.current = null;
      inputDrafts.current.clear(); draftOwner.current = null;
    };
  }, [pauseAccess]);

  useEffect(() => {
    if (!loading) {
      if (access) managerHeading.current?.focus();
      else if (loginAvailable) loginInput.current?.focus();
      else accessHeading.current?.focus();
    }
  }, [loading, access, loginAvailable]);

  useEffect(() => {
    // A hidden initial document has no prior visibilitychange to revoke it.
    // Remain paused until a deliberate check from a visible page.
    if (pageHidden()) { pauseAccess(); return; }
    const controller = new AbortController();
    const operation = ++authOperation.current;
    pendingAuth.current?.abort(); pendingAuth.current = controller;
    setLoading(true); setLoginAvailable(false); setError('');
    async function checkSession() {
      try {
        const response = await apiFetch('session', { signal: controller.signal });
        if (controller.signal.aborted || operation !== authOperation.current) return;
        if (pageHidden()) { pauseAccess(); return; }
        if (response.status === 401 || response.status === 403) {
          const body = await sessionBody(response).catch(() => null);
          if (controller.signal.aborted || operation !== authOperation.current) return;
          if (pageHidden()) { pauseAccess(); return; }
          if (response.status === 401 && standaloneLoginRequired(body)) {
            setRuntime('standalone'); setLoginAvailable(true);
          } else setError('Access was not accepted. Reopen Jukelet from Home Assistant with an administrator account, or check the configured app address, then try again.');
          return;
        }
        if (!response.ok) throw new Error('Session unavailable');
        const result = parseSession(await sessionBody(response));
        if (!controller.signal.aborted && operation === authOperation.current) acceptSession(result);
      } catch {
        if (!controller.signal.aborted && operation === authOperation.current) setError('Unable to reach Jukelet or verify your session. Please try again.');
      } finally { if (!controller.signal.aborted && operation === authOperation.current) setLoading(false); }
    }
    void checkSession();
    return () => controller.abort();
  }, [checkAttempt, acceptSession, pauseAccess]);

  useEffect(() => {
    if (!access) return;
    const timeout = window.setTimeout(() => access.reject(), Math.max(0, Date.parse(access.session.expires_at) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [access]);

  const expireSession = useCallback(() => {
    if (activeAccess.current === access) access?.reject();
  }, [access]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pageHidden()) { pauseAccess(); return; }
    if (!loginAvailable || runtime !== 'standalone' || busy) return;
    const operation = ++authOperation.current;
    const controller = new AbortController();
    pendingAuth.current?.abort(); pendingAuth.current = controller;
    setBusy(true); setError('');
    try {
      const response = await apiFetch('session', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }),
      });
      if (controller.signal.aborted || operation !== authOperation.current) return;
      if (pageHidden()) { pauseAccess(); return; }
      if (response.status === 401) setError('That app secret was not accepted.');
      else if (response.status === 429) setError('Too many attempts. Please wait a minute.');
      else if (!response.ok) setError('Unable to sign in. Please try again.');
      else {
        const result = parseSession(await sessionBody(response));
        if (!controller.signal.aborted && operation === authOperation.current) acceptSession(result);
      }
    } catch { if (!controller.signal.aborted && operation === authOperation.current) setError('Unable to reach Jukelet. Please try again.'); }
    finally { if (operation === authOperation.current) { setSecret(''); setBusy(false); } }
  }

  async function logout() {
    if (!access || !session || session.runtime !== 'standalone' || busy) return;
    const operation = ++authOperation.current;
    setBusy(true); setError('');
    try {
      const response = await apiFetch('session', {
        method: 'DELETE', credentials: 'same-origin', signal: access.signal,
        headers: { 'X-CSRF-Token': session.csrf_token },
      });
      if (!access.active || activeAccess.current !== access || operation !== authOperation.current) return;
      if (response.ok || response.status === 401) { access.close(); activeAccess.current = null; inputDrafts.current.clear(); draftOwner.current = null; setAccess(null); setLoginAvailable(true); }
      else setError('Unable to sign out. Please try again.');
    } catch { if (access.active && activeAccess.current === access && operation === authOperation.current) setError('Unable to reach Jukelet. Please try again.'); }
    finally { if (operation === authOperation.current) setBusy(false); }
  }

  return (
    <main>
      <a className="skip-link" href="#manager">Skip to manager</a>
      {import.meta.env.MODE === 'fixture' && <aside className="fixture-banner" role="note">Synthetic fixture demo · No household connection. All tags, music, status and authentication are simulated.</aside>}
      <header><p className="eyebrow">A personal jukebox</p><h1>Jukelet</h1>
        <p className="tagline">Your music. A little more hands-on.</p></header>
      <section id="manager" aria-label="Your Jukelet">
        {loading ? <p role="status">Checking your session…</p> : session && access ? <SessionAccessContext.Provider value={access}>
          <span className="badge">{session.mode === 'manage' ? 'Local management' : 'Read-only'}</span><h2 ref={managerHeading} tabIndex={-1}>Your tag and music manager</h2><p>Browse tags, edit saved assignments and discover music.</p><aside className="draft-banner">{session.mode === 'manage' && <>Manage mode also enables explicit HA tag renames, verified by registry readback. </>}Local drafts and active HA snapshots have separate outcomes. Saving never starts playback. Automatic publication requires explicit persistent opt-in.</aside>
          <nav className="manager-nav" aria-label="Manager sections"><a href="#tags">Tags</a><a href="#drafts">Local drafts</a><a href="#music">Discover music</a><a href="#publication">Publication</a><a href="#playback">Playback readiness</a><a href="#connections">Connections</a><a href="#recovery">Export and recovery</a></nav>
          <ConnectionStatus onExpired={expireSession} />
          <div className="manager-grid"><Inventory csrf={session.csrf_token} onExpired={expireSession} manage={session.mode === 'manage'} onDraftChanged={draftChanged} />
          <MusicPreview csrf={session.csrf_token} onExpired={expireSession} /></div>
          <DraftList csrf={session.csrf_token} onExpired={expireSession} onChanged={draftChanged} revision={draftRevision} manage={session.mode === 'manage'} />
          <Publication csrf={session.csrf_token} manage={session.mode === 'manage'} revision={draftRevision} onExpired={expireSession} />
          <PlaybackStatus onExpired={expireSession} />
          <Recovery csrf={session.csrf_token} manage={session.mode === 'manage'} revision={draftRevision} onExpired={expireSession} onChanged={draftChanged} />
          {session.runtime === 'standalone' ? <button disabled={busy} onClick={() => void logout()}>{busy ? 'Signing out…' : 'Sign out'}</button>
            : <p>Access is managed by Home Assistant. Manage sign-in there.</p>}
        </SessionAccessContext.Provider> : loginAvailable ? <form onSubmit={(event) => void login(event)}>
          <h2>Welcome back</h2><p>Use your app secret to sign in.</p>
          <label htmlFor="secret">App secret</label>
          <input id="secret" ref={loginInput} type="password" autoComplete="current-password" required
            maxLength={128} value={secret} onChange={(event) => setSecret(event.target.value)} />
          <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form> : <section aria-label="Session access"><h2 ref={accessHeading} tabIndex={-1}>Check your access</h2>
          <p>Open Jukelet from Home Assistant with an administrator account, or use your configured standalone address.</p>
          <button onClick={() => setCheckAttempt(value => value + 1)}>Check access again</button>
        </section>}
        {error && <p role="alert">{error}</p>}
      </section>
      <footer>Made for music you can reach out and touch. <a href={appUrl('third-party-notices.txt')}>Third-party notices</a></footer>
    </main>
  );
}
