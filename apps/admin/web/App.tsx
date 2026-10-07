import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminDraft,
  AdminLibraryItem,
  AdminMutation,
  AdminPublicationPreparation,
  AdminSession,
  AdminUser,
} from '../src/contracts';
import { AdminApi, errorMessage, type LibraryStatus } from './api';
import { ChefMark, Dialog, Field, Notice } from './components';
import { Editor } from './Editor';
import { Library } from './Library';
import { useOperations } from './useOperations';
import { IssuanceReview } from './IssuanceReview';
import type { ArchiveSelection } from './archiveSelection';
import type { RollbackSelection } from './rollbackIssuance';
import { useTranslationOperations } from './useTranslationOperations';
import { TranslationRecovery } from './TranslationRecovery';

function SignIn({
  api,
  session,
  error,
  onSession,
  onRefresh,
}: {
  api: AdminApi;
  session: AdminSession | null;
  error: string | null;
  onSession: (session: AdminSession) => void;
  onRefresh: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function login() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.session();
      onSession(await api.login(username, password));
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setPassword('');
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <div className="auth-story">
        <img className="brand-art" src="/admin/brand.png" alt="CookMate chef-hat emblem" />
        <p className="eyebrow">COOKMATE RECIPE STUDIO</p>
        <h1>
          A place for
          <br />
          <em>good food.</em>
        </h1>
        <p>
          Care for the recipes behind CookMate.
          <br />
          Original ingredients, thoughtful edits, clear credits.
        </p>
        <span className="auth-footnote">PRIVATE EDITORIAL WORKSPACE</span>
      </div>
      <main className="auth-panel">
        <div className="wordmark">
          Cook<span>Mate</span>
        </div>
        {!session ? (
          <>
            <h2>{error ? 'The workspace is unavailable' : 'Opening your workspace…'}</h2>
            <p className="muted">Checking the local administrator session.</p>
            {error && <Notice tone="error">{error}</Notice>}
            <button className="secondary" onClick={onRefresh}>
              Retry connection
            </button>
          </>
        ) : !session.configured ? (
          <>
            <p className="eyebrow">ONE-TIME OPERATOR SETUP</p>
            <h2>Your studio is ready for its first operator.</h2>
            <p>
              No administrator account is configured. The computer’s operator must run the
              deliberate local setup command before signing in.
            </p>
            <Notice title="No default credentials">
              Accounts cannot be created from this page. Use the project’s local administrator setup
              instructions; never put a password in a URL.
            </Notice>
            <button className="secondary" onClick={onRefresh}>
              Check setup again
            </button>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void login();
            }}
          >
            <p className="eyebrow">WELCOME TO THE STUDIO</p>
            <h2>Sign in to your kitchen.</h2>
            <p className="muted">
              Use the account configured by this workspace’s operator. Existing edits in this tab
              stay here while you sign in again.
            </p>
            <Field label="Username">
              <input
                required
                autoComplete="username"
                value={username}
                maxLength={256}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
              />
            </Field>
            <Field label="Password">
              <input
                required
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </Field>
            {failure && <Notice tone="error">{failure}</Notice>}
            <button className="primary full-width" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="small muted">
              This manages private recipe drafts and configured signed releases. Issuing a release
              does not change the mobile app by itself.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [api] = useState(
    () =>
      new AdminApi(() => setSession((current) => (current ? { ...current, user: null } : null))),
  );
  const [owner, setOwner] = useState<AdminUser | null>(null);
  const [draft, setDraft] = useState<AdminDraft | null>(null);
  const [view, setView] = useState<'library' | 'editor'>('library');
  const [status, setStatus] = useState<LibraryStatus>('all');
  const [refresh, setRefresh] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [prepared, setPrepared] = useState<{
    preparation: AdminPublicationPreparation;
    title: string;
  } | null>(null);
  const [archive, setArchive] = useState<ArchiveSelection | null>(null);
  const [rollback, setRollback] = useState<RollbackSelection | null>(null);
  const [issuanceProtection, setIssuanceProtection] = useState({ pending: false, busy: false });
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<(() => void) | null>(null);
  const [reauth, setReauth] = useState(false);
  const [password, setPassword] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [signOutReview, setSignOutReview] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const signOutRunning = useRef(false);
  const refreshSession = useCallback(() => {
    setSessionError(null);
    void api
      .session()
      .then(setSession)
      .catch((failure: unknown) => setSessionError(errorMessage(failure)));
  }, [api]);
  useEffect(refreshSession, [refreshSession]);
  useEffect(() => {
    if (session?.user && !owner) setOwner(session.user);
  }, [session, owner]);
  const committed = useCallback((result: AdminMutation) => {
    setPrepared(null);
    setArchive(null);
    setRollback(null);
    setDraft(result.draft);
    setView('editor');
    setRefresh((value) => value + 1);
    setDirty(false);
    setSaved(
      `Local revision ${result.draft.revision} is confirmed by the server. The app catalogue is unchanged.`,
    );
  }, []);
  const operations = useOperations(api, session?.user ?? null, committed);
  const translationOperations = useTranslationOperations(api, session?.user ?? null, (result) => {
    setSaved(
      `Translation revision ${result.translation.revision} is confirmed by the server. It is not included in a signed release.`,
    );
  });
  const issuanceBlocked = issuanceProtection.pending || issuanceProtection.busy;
  const blocked =
    operations.blocked ||
    translationOperations.blocked ||
    localBusy ||
    loadingDraft ||
    issuanceBlocked;
  useEffect(() => {
    if (
      !dirty &&
      !operations.pending &&
      !translationOperations.blocked &&
      !localBusy &&
      !issuanceBlocked
    )
      return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, operations.pending, translationOperations.blocked, localBusy, issuanceBlocked]);
  function navigate(action: () => void) {
    if (blocked) return;
    if (dirty) setNavigation(() => action);
    else action();
  }
  function library(next: LibraryStatus = status) {
    navigate(() => {
      setView('library');
      setStatus(next);
      setDraft(null);
      setPrepared(null);
      setArchive(null);
      setRollback(null);
      setDirty(false);
      setSaved(null);
    });
  }
  async function open(item: AdminLibraryItem) {
    if (blocked) return;
    setError(null);
    setSaved(null);
    if (!item.draftId) {
      await operations.run('create', null, (id) => api.create(id, item.recipeId));
      return;
    }
    setLoadingDraft(true);
    try {
      setDraft(await api.draft(item.draftId));
      setPrepared(null);
      setArchive(null);
      setRollback(null);
      setView('editor');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoadingDraft(false);
    }
  }
  async function logout(discardWorkspace = false) {
    if (signOutRunning.current) return;
    signOutRunning.current = true;
    setSignOutBusy(true);
    setError(null);
    try {
      await api.logout();
      // Logout changes authentication only. Operation/upload references remain untouched.
      if (discardWorkspace) {
        setDraft(null);
        setPrepared(null);
        setArchive(null);
        setRollback(null);
        setView('library');
        setDirty(false);
        setSaved(null);
      }
      setSession((current) =>
        current ? { ...current, user: null, csrfToken: null, expiresAt: null } : null,
      );
      setSignOutReview(false);
      setReauth(false);
      setResolving(false);
      setPassword('');
      try {
        setSession(await api.session());
      } catch (failure) {
        setSessionError(errorMessage(failure));
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      signOutRunning.current = false;
      setSignOutBusy(false);
    }
  }
  async function confirmIdentity() {
    setReauthBusy(true);
    setError(null);
    try {
      setSession(await api.reauth(password));
      setReauth(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPassword('');
      setReauthBusy(false);
    }
  }
  const sameUser = !!session?.user && session.user.userId === owner?.userId;
  return (
    <>
      {owner && (
        <div className="studio-shell" hidden={!sameUser}>
          <aside className="sidebar">
            <a href="#main-content" className="skip-link">
              Skip to content
            </a>
            <div className="brand">
              <span className="chef-badge">
                <ChefMark />
              </span>
              <div className="wordmark">
                Cook<span>Mate</span>
                <small>RECIPE STUDIO</small>
              </div>
            </div>
            <nav aria-label="Studio navigation">
              <p className="nav-caption">WORKSPACE</p>
              {(
                [
                  ['all', 'Recipe library', '▦'],
                  ['draft', 'Drafts', '✎'],
                  ['reviewed', 'Reviewed drafts', '✓'],
                  ['prepared', 'Prepared drafts', '□'],
                  ['published', 'Published', '↑'],
                  ['archived', 'Archived', '↓'],
                ] as const
              ).map(([value, label, icon]) => (
                <button
                  key={value}
                  className={
                    view === 'library' && status === value ? 'nav-item active' : 'nav-item'
                  }
                  disabled={blocked}
                  onClick={() => library(value)}
                >
                  <span aria-hidden="true">{icon}</span>
                  {label}
                </button>
              ))}
            </nav>
            <div className="sidebar-note">
              <span className="small-leaf" aria-hidden="true">
                ⌁
              </span>
              <strong>
                Thoughtful edits.
                <br />
                Original flavour.
              </strong>
              <p>Drafts and signed releases are distinct. App adoption is verified separately.</p>
            </div>
            <div className="user-panel">
              <span className="user-initial" aria-hidden="true">
                {owner.username.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{owner.username}</strong>
                <span>{owner.role}</span>
              </div>
            </div>
            <button className="sidebar-link" onClick={() => setReauth(true)}>
              Confirm identity
            </button>
            <button
              className="sidebar-link"
              disabled={signOutBusy}
              onClick={() => setSignOutReview(true)}
            >
              Sign out
            </button>
          </aside>
          <div className="studio-body">
            <header className="topbar">
              <span>CookMate / {view === 'editor' ? 'Recipe editor' : 'Library'}</span>
              <span className="local-label">Private · Local drafts</span>
            </header>
            <main id="main-content" tabIndex={-1} className="workspace-content">
              {saved && <Notice tone="success">{saved}</Notice>}
              {error && <Notice tone="error">{error}</Notice>}
              {operations.error && (
                <Notice title="Change needs attention" tone="error">
                  {operations.error}
                  {operations.errorCode === 'reauth_required' && (
                    <button className="secondary" onClick={() => setReauth(true)}>
                      Confirm identity to continue
                    </button>
                  )}
                </Notice>
              )}
              {operations.storageError && (
                <Notice title="Recovery storage needs attention" tone="error">
                  {operations.storageError}
                </Notice>
              )}
              {operations.pending && (
                <Notice
                  title={
                    operations.busy ? 'Confirming your change…' : 'An earlier change is unconfirmed'
                  }
                >
                  <p>
                    Do not start a second change. Check the stored receipt; an absent receipt does
                    not prove the request failed.
                  </p>
                  <code>{operations.pending.operationId}</code>
                  <p className="small">
                    This tab retains the operation reference across reloads, without recipe text or
                    credentials. Keep the tab open until the outcome is confirmed.
                  </p>
                  {operations.pending.userId !== session?.user?.userId ? (
                    <p>Sign in as the account that started this operation to recover it.</p>
                  ) : (
                    <div className="inline-actions">
                      <button
                        className="secondary"
                        disabled={operations.busy}
                        onClick={() => void operations.check()}
                      >
                        Check operation receipt
                      </button>
                      {operations.canRetry && (
                        <button
                          className="text-button"
                          disabled={operations.busy}
                          onClick={() => void operations.retry()}
                        >
                          Retry exact original request
                        </button>
                      )}
                      <button
                        className="text-button"
                        disabled={operations.busy}
                        onClick={() => setResolving(true)}
                      >
                        Resolve unconfirmed change
                      </button>
                    </div>
                  )}
                </Notice>
              )}
              {operations.resolutionNotice && <Notice>{operations.resolutionNotice}</Notice>}
              <TranslationRecovery
                operations={translationOperations}
                onReauthenticate={() => setReauth(true)}
              />
              {owner.role === 'administrator' && (
                <IssuanceReview
                  key={owner.userId}
                  api={api}
                  user={sameUser ? session!.user! : owner}
                  active={sameUser && !signOutBusy}
                  prepared={prepared}
                  archive={archive}
                  rollback={rollback}
                  disabled={
                    operations.blocked ||
                    translationOperations.blocked ||
                    localBusy ||
                    loadingDraft ||
                    dirty
                  }
                  onReauthenticate={() => setReauth(true)}
                  onProtectionChange={setIssuanceProtection}
                  onIssued={() => {
                    setPrepared(null);
                    setArchive(null);
                    setRollback(null);
                    setRefresh((value) => value + 1);
                  }}
                />
              )}
              {loadingDraft && <p role="status">Opening recipe draft…</p>}
              {view === 'editor' && draft ? (
                <Editor
                  key={draft.draftId}
                  api={api}
                  draft={draft}
                  user={session?.user?.userId === owner.userId ? session.user : owner}
                  operations={operations}
                  translationOperations={translationOperations}
                  externalBlocked={issuanceBlocked || translationOperations.blocked}
                  onPrepared={(preparation, title) => {
                    setArchive(null);
                    setRollback(null);
                    setPrepared({ preparation, title });
                  }}
                  onPreparationInvalidated={() => setPrepared(null)}
                  onDirty={setDirty}
                  onLocalBusy={setLocalBusy}
                  onLoad={(nextDraft) => {
                    setDraft(nextDraft);
                    setPrepared(null);
                    setArchive(null);
                    setRollback(null);
                  }}
                  onBack={() => library()}
                  onReauthenticate={() => setReauth(true)}
                />
              ) : (
                <Library
                  api={api}
                  active={sameUser && !signOutBusy}
                  status={status}
                  refresh={refresh}
                  blocked={blocked}
                  user={sameUser ? session!.user! : owner}
                  onArchive={(selection) => {
                    if (blocked || !sameUser || session?.user?.role !== 'administrator') return;
                    setPrepared(null);
                    setArchive(selection);
                    setRollback(null);
                    setError(null);
                    setSaved(null);
                  }}
                  onRollback={(selection) => {
                    if (blocked || !sameUser || session?.user?.role !== 'administrator') return;
                    setPrepared(null);
                    setArchive(null);
                    setRollback(selection);
                    setError(null);
                    setSaved(null);
                  }}
                  onStatus={(next) => library(next)}
                  onOpen={(item) => void open(item)}
                  onCreate={() => void operations.run('create', null, (id) => api.create(id))}
                />
              )}
            </main>
            <footer className="studio-footer">
              CookMate Recipe Studio <span>Drafting is local. Source truth comes first.</span>
            </footer>
          </div>
        </div>
      )}
      {!session?.user && (
        <SignIn
          api={api}
          session={session}
          error={sessionError}
          onSession={setSession}
          onRefresh={refreshSession}
        />
      )}
      {session?.user && owner && !sameUser && (
        <div className="account-mismatch">
          <div className="wordmark">
            Cook<span>Mate</span>
          </div>
          <h1>A different account signed in.</h1>
          <p>
            Edits from the previous account are hidden and retained in this tab. Sign back into that
            account to continue them.
          </p>
          <button className="primary" disabled={signOutBusy} onClick={() => void logout()}>
            Sign out of {session.user.username}
          </button>
          {!operations.pending && !translationOperations.blocked && !issuanceBlocked && (
            <button
              className="secondary"
              onClick={() =>
                setNavigation(() => () => {
                  setDraft(null);
                  setPrepared(null);
                  setArchive(null);
                  setRollback(null);
                  setView('library');
                  setDirty(false);
                  setOwner(session.user);
                })
              }
            >
              Discard earlier edits and use this account
            </button>
          )}
        </div>
      )}
      {navigation && (
        <Dialog title="Leave these unsaved edits?" onClose={() => setNavigation(null)}>
          <p>
            Your changes are only in this tab. Leaving will discard them; saved server revisions are
            kept.
          </p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setNavigation(null)}>
              Keep editing
            </button>
            <button
              className="primary"
              onClick={() => {
                const action = navigation;
                setNavigation(null);
                setDirty(false);
                action();
              }}
            >
              Discard edits and continue
            </button>
          </div>
        </Dialog>
      )}
      {signOutReview && sameUser && (
        <Dialog
          title="Sign out of Recipe Studio?"
          onClose={() => {
            if (!signOutBusy) setSignOutReview(false);
          }}
        >
          {(dirty || localBusy) && (
            <p>
              Confirming discards unsaved edits and selected photo files in this tab. Saved server
              revisions and all retained recovery references are kept.
            </p>
          )}
          <p>
            An unconfirmed request may already have stored a change. Signing out does not cancel or
            replay it. Sign back in with the same account to check or resolve its retained
            reference. Photo uploads retain their own references; you may need to select the same
            file again.
          </p>
          {(operations.storageError || translationOperations.storageError) && (
            <p>
              Unreadable recovery storage will remain unchanged. Signing out does not repair or
              erase it.
            </p>
          )}
          <p className="small">
            Keep this tab open if you need its recovery references after signing in again.
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={signOutBusy}
              onClick={() => setSignOutReview(false)}
            >
              Stay signed in
            </button>
            <button className="primary" disabled={signOutBusy} onClick={() => void logout(true)}>
              {signOutBusy
                ? 'Signing out…'
                : dirty || localBusy
                  ? 'Discard unsaved edits and sign out'
                  : 'Sign out and keep recovery references'}
            </button>
          </div>
        </Dialog>
      )}
      {resolving && sameUser && operations.pending && (
        <Dialog
          title="Resolve unconfirmed change"
          onClose={() => {
            if (!operations.busy) setResolving(false);
          }}
        >
          <p>
            The server will recover this change if it already committed. Otherwise it will cancel
            this operation identifier and prevent its delayed request from changing the draft. This
            does not undo a saved revision or discard your unsaved edits.
          </p>
          <p className="small">
            No new save is sent. Keep the reference if the outcome cannot be confirmed.
          </p>
          <code>{operations.pending.operationId}</code>
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={operations.busy}
              onClick={() => setResolving(false)}
            >
              Keep unconfirmed
            </button>
            <button
              className="primary"
              disabled={operations.busy}
              onClick={() => {
                void operations.resolve().finally(() => setResolving(false));
              }}
            >
              {operations.busy ? 'Resolving…' : 'Resolve this operation'}
            </button>
          </div>
        </Dialog>
      )}
      {reauth && sameUser && (
        <Dialog
          title="Confirm your identity"
          onClose={() => {
            if (!reauthBusy) {
              setPassword('');
              setReauth(false);
            }
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirmIdentity();
            }}
          >
            <p>
              Enter your password to refresh recent authentication. This does not change your
              permissions.
            </p>
            <Field label="Password">
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={reauthBusy}
              />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
            <button className="primary" disabled={reauthBusy}>
              {reauthBusy ? 'Confirming…' : 'Confirm identity'}
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
}
