import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  AccountReplicationError,
  createAccountScopeApprovalEvidence,
  emptyAccountSnapshot,
} from '@cookmate/account-sync';
import type {
  AccountReplicationInspection,
  AccountReplicationRepository,
  AccountReplicationScope,
} from '@cookmate/account-sync';
import type {
  AccountScopeApprovalReview,
  AccountScopeApprovalService,
} from '../../data/accountScopeApproval';
import { createAccountRuntime, type AccountRuntime } from './accountRuntime';
import { createWorkspaceSelection } from './workspaceSelection';
import { createLocalAccountSettings } from './localAccountSettings';
import type { SupabaseAccountAccess } from './supabaseAccess';
import { AccountAuthError, type AccountIdentity } from './authTypes';
import type { LocalCookMateServices } from '../../data/localServices';
import { createDeletionRecoveryJournal, type DeletionRecoveryStatus } from './deletionRecovery';
import { parseAccountAuthConfig } from './authConfig';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DELETION_OPERATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const identity = (ownerId: string): AccountIdentity => ({
  ownerId,
  displayName: null,
  email: null,
  provider: 'google',
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const completedDeletion: DeletionRecoveryStatus = {
  status: 'deleted',
  operationId: DELETION_OPERATION,
  deletedAt: '2026-09-30T10:00:00.000Z',
  expiresAt: '2026-10-30T10:00:00.000Z',
};
function deletionFixture(values = new Map<string, string>(), initial = identity(A)) {
  let responseCode: 'lost' | 'needs_review' | 'operation_changed' | 'success' = 'lost';
  let status: () => Promise<DeletionRecoveryStatus> = async () => completedDeletion;
  let statusRequests = 0;
  const requests: Array<Record<string, unknown>> = [];
  const journal = createDeletionRecoveryJournal(
    {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    },
    { now: () => '2026-09-30T10:00:01.000Z' },
  );
  const f = fixture(initial, values, {
    newId: () => DELETION_OPERATION,
    config: parseAccountAuthConfig({
      url: 'https://account.example',
      publishableKey: 'sb_publishable_synthetic',
    }),
    deletion: {
      journal,
      newToken: async () => 'a'.repeat(64),
      readStatus: async (input) => {
        statusRequests++;
        assert.deepEqual(input, { operationId: DELETION_OPERATION, recoveryToken: 'a'.repeat(64) });
        return status();
      },
    },
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(input);
      if (input.action === 'read')
        return Response.json({
          ownerId: A,
          schemaVersion: 1,
          revision: 0,
          snapshot: null,
          updatedAt: null,
          deletionPending: false,
          deletionOperationId: null,
        });
      assert.equal(input.action, 'delete');
      assert.equal((await journal.read(A))?.kind, 'pending');
      if (responseCode === 'lost') throw new Error('simulated lost reply');
      if (responseCode !== 'success')
        return Response.json({ error: responseCode }, { status: 409 });
      return Response.json({ ownerId: A, operationId: DELETION_OPERATION, deleted: true });
    },
  });
  return {
    ...f,
    journal,
    requests,
    get statusRequests() {
      return statusRequests;
    },
    reply: (value: typeof responseCode) => {
      responseCode = value;
    },
    status: (value: typeof status) => {
      status = value;
    },
  };
}
function fixture(
  initialSession: AccountIdentity | null = null,
  values = new Map<string, string>(),
  ports: Partial<
    Pick<
      Parameters<typeof createAccountRuntime>[0],
      'config' | 'fetch' | 'deletion' | 'newId' | 'auth' | 'open' | 'enableExpandedScope'
    >
  > = {},
) {
  const calls: string[] = [];
  let session = initialSession;
  let nextLogin = identity(A);
  let cancelled = false;
  let authListener: ((value: AccountIdentity | null) => void) | null = null;
  let runtime!: AccountRuntime;
  const metadata = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
  const selection = createWorkspaceSelection({
    storage: {
      read: () => metadata.read('manifest'),
      write: (value) => metadata.write('manifest', value),
    },
    assertClosed() {
      assert.equal(runtime.closed, true);
    },
    databases: {
      prepare: async (owner, clone) => {
        calls.push('prepare:' + owner + ':' + clone);
      },
      remove: async (owner) => {
        calls.push('remove:' + owner);
      },
    },
  });
  const auth = {
    readSession: async () => (session ? { identity: session, accessToken: 'session.token' } : null),
    subscribe: (listener: (value: AccountIdentity | null) => void) => {
      authListener = listener;
      return () => {
        authListener = null;
      };
    },
    signInNative: async () => {
      if (cancelled) throw new AccountAuthError('cancelled');
      session = nextLogin;
      return nextLogin;
    },
    signOut: async () => {
      calls.push('signOut');
      session = null;
    },
    dispose: async () => {
      calls.push('disposeAuth');
    },
    verifyNativeAccess: async () => undefined,
  } as unknown as SupabaseAccountAccess;
  const settings = new Map<string, ReturnType<typeof createLocalAccountSettings>>();
  runtime = createAccountRuntime({
    selection,
    auth,
    config: null,
    newId: () => B,
    fetch: async () => {
      throw new Error('No provider call allowed');
    },
    metadata,
    guestPreferences: { read: async () => null, write: async () => undefined },
    settings(owner) {
      let value = settings.get(owner);
      if (!value) {
        value = createLocalAccountSettings({
          ownerId: owner,
          store: metadata,
          isCurrent: () => runtime.isWorkspaceCurrent(owner),
        });
        settings.set(owner, value);
      }
      return value;
    },
    drainSettings: async () => {
      for (const value of settings.values()) await value.drain();
    },
    open: async (workspace) => {
      const name = workspace.kind === 'guest' ? 'guest' : workspace.ownerId;
      calls.push('open:' + name);
      return {
        kind: 'ready',
        services: {
          queries: { subscribe: () => () => undefined },
          close: async () => {
            calls.push('close:' + name);
          },
        } as unknown as LocalCookMateServices,
      };
    },
    ...ports,
  });
  async function open() {
    const result = await runtime.opener(runtime.getSnapshot().workspace)();
    assert.equal(result.kind, 'ready');
    return result.services;
  }
  return {
    runtime,
    selection,
    values,
    calls,
    open,
    auth,
    emit(value: AccountIdentity | null) {
      authListener?.(value);
    },
    clearSession() {
      session = null;
      authListener?.(null);
    },
    replaceSession(value: AccountIdentity) {
      session = value;
    },
    loginAs(owner: string) {
      nextLogin = identity(owner);
    },
    cancel() {
      cancelled = true;
    },
  };
}

test('startup cannot offer welcome while secure recovery is still being read without configured auth', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const journal = createDeletionRecoveryJournal({
    getItem: async () => {
      entered = true;
      await held;
      return null;
    },
    setItem: async () => undefined,
    removeItem: async () => undefined,
  });
  const f = fixture(null, new Map(), {
    auth: null,
    deletion: {
      journal,
      newToken: async () => 'a'.repeat(64),
      readStatus: async () => completedDeletion,
    },
  });
  const starting = f.runtime.initialize();
  await flush();
  assert.equal(entered, true);
  assert.equal(f.runtime.getSnapshot().phase, 'ready');
  assert.equal(f.runtime.getSnapshot().startupSettled, false);
  release();
  await starting;
  assert.equal(f.runtime.getSnapshot().startupSettled, true);
  assert.equal(f.runtime.getSnapshot().error, null);
  await f.runtime.dispose();
});

test('an account adapter open failure preserves the required full-browser-reload action', async () => {
  const f = fixture(null, new Map(), {
    open: async () => {
      throw new Error('Invalid VFS state');
    },
  });
  await f.runtime.initialize();
  await f.runtime.signIn('google', false);
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'account:' + A);
  const result = await f.runtime.opener(f.runtime.getSnapshot().workspace)();
  assert.deepEqual(result, {
    kind: 'failed',
    error: {
      code: 'storage_failure',
      messageKey: 'storage.web_restart_required',
      retry: 'never',
    },
  });
  assert.equal(f.runtime.getSnapshot().error, 'web_restart_required');
  assert.equal(f.runtime.closed, true);
  await f.runtime.dispose();
});

test('first sign-in preserves guest and prepares its copy only after the old store closes', async () => {
  const f = fixture();
  await f.runtime.initialize();
  const guest = await f.open();
  await f.runtime.signIn('google', false);
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'account:' + A);
  assert.equal(
    f.calls.some((value) => value.startsWith('prepare')),
    false,
  );
  assert.equal((await f.runtime.opener(f.runtime.getSnapshot().workspace)()).kind, 'failed');
  await guest.close();
  const account = await f.open();
  assert.deepEqual(f.calls.slice(0, 4), [
    'open:guest',
    'close:guest',
    'prepare:' + A + ':true',
    'open:' + A,
  ]);
  assert.equal(f.selection.getSnapshot().manifest?.guestClaim, A);
  await account.close();
  await f.runtime.dispose();
});

test('sign-out Keep leaves account data open; another account never clones it', async () => {
  const f = fixture();
  await f.runtime.initialize();
  await f.runtime.signIn('google', false);
  const a = await f.open();
  await f.runtime.signOut(false);
  assert.equal(f.runtime.getSnapshot().identity, null);
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'account:' + A);
  assert.equal(f.runtime.closed, false);
  f.loginAs(B);
  await f.runtime.signIn('google', false);
  assert.equal(
    f.calls.some((value) => value.startsWith('prepare:' + B)),
    false,
  );
  await a.close();
  const b = await f.open();
  assert.ok(f.calls.includes('prepare:' + B + ':false'));
  assert.equal(
    f.calls.some((value) => value.startsWith('remove:')),
    false,
  );
  await b.close();
  await f.runtime.dispose();
});

test('explicit removal waits for close and returns to the preserved original guest', async () => {
  const f = fixture();
  await f.runtime.initialize();
  await f.runtime.signIn('google', false);
  const a = await f.open();
  await f.runtime.signOut(true);
  assert.equal(f.calls.includes('remove:' + A), false);
  await a.close();
  const guest = await f.open();
  assert.deepEqual(f.calls.slice(-3), ['close:' + A, 'remove:' + A, 'open:guest']);
  assert.equal(f.selection.getSnapshot().manifest?.guestClaim, A);
  await guest.close();
  await f.runtime.dispose();
});

test('returning to the same account reuses its existing workspace', async () => {
  const f = fixture();
  await f.runtime.initialize();
  await f.runtime.signIn('google', false);
  const a = await f.open();
  await f.runtime.signOut(false);
  await f.runtime.signIn('google', false);
  assert.equal(f.calls.filter((value) => value.startsWith('prepare:')).length, 1);
  assert.equal(f.calls.filter((value) => value.startsWith('open:')).length, 1);
  await a.close();
  await f.runtime.dispose();
});

test('cancelled native login retains the guest workspace and exposes a specific error', async () => {
  const f = fixture();
  await f.runtime.initialize();
  const guest = await f.open();
  f.cancel();
  await f.runtime.signIn('google', false);
  assert.equal(f.runtime.getSnapshot().error, 'cancelled');
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'guest');
  assert.equal(
    f.calls.some((value) => value.startsWith('prepare:')),
    false,
  );
  await guest.close();
  await f.runtime.dispose();
});

test('runtime disposal waits for the provider to close its owned SQLite facade', async () => {
  const f = fixture();
  await f.runtime.initialize();
  const guest = await f.open();
  let ended = false;
  const disposal = f.runtime.dispose().then(() => {
    ended = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  assert.equal(f.calls.includes('disposeAuth'), false);
  await guest.close();
  await disposal;
  assert.equal(f.calls.at(-1), 'disposeAuth');
});

for (const next of ['signed-out', 'account-b'] as const)
  test('late foreground verification cannot restore A after ' + next, async () => {
    const f = fixture(identity(A));
    await f.runtime.initialize();
    const a = await f.open();
    let release!: () => void;
    let reached!: () => void;
    const checking = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.auth.verifyNativeAccess = async () => {
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const refresh = f.runtime.foreground();
    await checking;
    if (next === 'signed-out') await f.runtime.signOut(false);
    else {
      f.loginAs(B);
      await f.runtime.signIn('google', false);
    }
    release();
    await refresh;
    assert.equal(
      f.runtime.getSnapshot().identity?.ownerId ?? null,
      next === 'signed-out' ? null : B,
    );
    assert.equal(f.runtime.getSnapshot().error, null);
    await a.close();
    await f.runtime.dispose();
  });

test('restart after confirmed Remove recovers the durable choice before opening any workspace', async () => {
  const f = fixture();
  await f.runtime.initialize();
  await f.runtime.signIn('google', false);
  const a = await f.open();
  await f.runtime.signOut(true);
  assert.ok(f.values.has('cookmate.account-removal.intent'));
  await a.close();
  await f.runtime.dispose(); // No guest opener ran before this simulated restart.
  const restarted = fixture(null, f.values);
  await restarted.runtime.initialize();
  assert.equal(restarted.runtime.getSnapshot().workspaceKey, 'guest');
  assert.deepEqual(restarted.calls, ['remove:' + A]);
  assert.equal(restarted.values.has('cookmate.account-removal.intent'), false);
  await restarted.runtime.dispose();
});

test('SDK logout followed by cleanup failure still clears the public account identity', async () => {
  const f = fixture(identity(A));
  await f.runtime.initialize();
  const a = await f.open();
  f.auth.signOut = async () => {
    f.clearSession();
    throw new AccountAuthError('storage');
  };
  await f.runtime.signOut(false);
  assert.equal(f.runtime.getSnapshot().identity, null);
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'account:' + A);
  assert.equal(f.runtime.getSnapshot().error, 'storage');
  await a.close();
  await f.runtime.dispose();
});

test('a later Keep choice cancels an unexecuted failed Remove before restart', async () => {
  const f = fixture(identity(A));
  await f.runtime.initialize();
  const a = await f.open();
  const logout = f.auth.signOut;
  f.auth.signOut = async () => {
    throw new AccountAuthError('storage');
  };
  await f.runtime.signOut(true);
  assert.equal(f.runtime.getSnapshot().identity?.ownerId, A);
  assert.ok(f.values.has('cookmate.account-removal.intent'));
  f.auth.signOut = logout;
  await f.runtime.signOut(false);
  assert.equal(f.runtime.getSnapshot().identity, null);
  assert.equal(f.values.has('cookmate.account-removal.intent'), false);
  await a.close();
  await f.runtime.dispose();
  const restarted = fixture(null, f.values);
  await restarted.runtime.initialize();
  assert.equal(restarted.runtime.getSnapshot().workspaceKey, 'account:' + A);
  assert.equal(
    restarted.calls.some((value) => value.startsWith('remove:')),
    false,
  );
  await restarted.runtime.dispose();
});

test('cold startup never authenticates a revoked native identity even if SDK logout fails', async () => {
  const f = fixture(identity(A));
  f.auth.verifyNativeAccess = async () => {
    throw new AccountAuthError('session_expired');
  };
  f.auth.signOut = async () => {
    throw new AccountAuthError('storage');
  };
  await f.runtime.initialize();
  f.emit(identity(A));
  assert.equal(f.runtime.getSnapshot().identity, null);
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'guest');
  assert.equal(f.runtime.getSnapshot().error, 'session_expired');
  assert.equal(f.runtime.getSnapshot().checkingSession, false);
  assert.equal(
    f.calls.some((value) => value.startsWith('prepare:')),
    false,
  );
  await f.runtime.dispose();
});

test('revoked Apple access cannot return through an old auth event; fresh sign-in can recover', async () => {
  const f = fixture(identity(A));
  await f.runtime.initialize();
  const a = await f.open();
  f.auth.verifyNativeAccess = async () => {
    throw new AccountAuthError('session_expired');
  };
  f.auth.signOut = async () => {
    throw new AccountAuthError('storage');
  };
  await f.runtime.foreground();
  f.emit(identity(A));
  assert.equal(f.runtime.getSnapshot().identity, null);
  await f.runtime.signIn('google', false);
  assert.equal(f.runtime.getSnapshot().identity?.ownerId, A);
  await a.close();
  await f.runtime.dispose();
});

test('native background refresh stops after an in-flight foreground start', async () => {
  const f = fixture();
  await f.runtime.initialize();
  let release!: () => void;
  f.auth.startAutoRefresh = async () => {
    f.calls.push('refresh:start');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  f.auth.stopAutoRefresh = async () => {
    f.calls.push('refresh:stop');
  };
  const starting = f.runtime.setAppActive(true);
  await Promise.resolve();
  const stopping = f.runtime.setAppActive(false);
  assert.deepEqual(f.calls, ['refresh:start']);
  release();
  await Promise.all([starting, stopping]);
  assert.deepEqual(f.calls, ['refresh:start', 'refresh:stop']);
  await f.runtime.dispose();
});

test('a lost delete response retains a status action after sign-out and commits durable proof', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  const store = await f.open();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'unconfirmed');
  f.clearSession();
  await flush();
  assert.equal(f.runtime.getSnapshot().identity, null);
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'unconfirmed');
  await f.runtime.checkDeletion();
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'deleted');
  const retained = await f.journal.read(A);
  assert.equal(retained?.kind, 'confirmed');
  assert.equal(retained && 'recoveryToken' in retained, false);
  assert.equal(f.requests.filter((value) => value.action === 'delete').length, 1);
  assert.equal(
    f.calls.some((value) => value.startsWith('remove:')),
    false,
  );
  await store.close();
  await f.runtime.dispose();
  const restarted = deletionFixture(f.values);
  await restarted.runtime.initialize();
  assert.equal(restarted.runtime.getSnapshot().identity, null);
  assert.equal(restarted.runtime.getSnapshot().deletion?.kind, 'deleted');
  assert.equal(restarted.requests.length, 0);
  await restarted.runtime.dispose();
});

test('unavailable deletion status retains the exact recovery secret and never resends delete', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  const before = await f.journal.read(A);
  f.status(async () => {
    throw new Error('unavailable receipt');
  });
  await f.runtime.checkDeletion();
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'unconfirmed');
  assert.deepEqual(await f.journal.read(A), before);
  assert.equal(f.requests.filter((value) => value.action === 'delete').length, 1);
  assert.equal(f.calls.includes('signOut'), false);
  await f.runtime.dispose();
});

test('explicit retry reuses the same pending operation and secret before confirmed cleanup', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  f.reply('success');
  await f.runtime.confirmDeletion();
  const attempts = f.requests.filter((value) => value.action === 'delete');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal((await f.journal.read(A))?.kind, 'confirmed');
  assert.equal(f.runtime.getSnapshot().identity, null);
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'deleted');
  await f.runtime.dispose();
});

test('only a definitely rejected stale review can clear the exact pending deletion', async () => {
  for (const result of ['needs_review', 'operation_changed'] as const) {
    const f = deletionFixture();
    await f.runtime.initialize();
    await f.runtime.reviewDeletion();
    f.reply(result);
    await f.runtime.confirmDeletion();
    assert.equal(
      (await f.journal.read(A))?.kind ?? null,
      result === 'needs_review' ? null : 'pending',
    );
    assert.equal(
      f.runtime.getSnapshot().deletion?.kind,
      result === 'needs_review' ? 'failed' : 'unconfirmed',
    );
    assert.equal(f.calls.includes('signOut'), false);
    await f.runtime.dispose();
  }
});

test('confirmation for account A never signs out a newer SDK session for account B', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  f.status(async () => {
    f.replaceSession(identity(B));
    return completedDeletion;
  });
  await f.runtime.checkDeletion();
  await flush();
  assert.equal((await f.journal.read(A))?.kind, 'confirmed');
  assert.equal(f.runtime.getSnapshot().identity?.ownerId, B);
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'account:' + B);
  assert.equal(f.calls.includes('signOut'), false);
  assert.notEqual(f.runtime.getSnapshot().deletion?.kind, 'deleted');
  await f.runtime.dispose();
});

test('renewing the same account keeps an explicit retry usable without automatically dispatching', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  const pending = await f.journal.read(A);
  await f.runtime.signIn('google', false);
  assert.equal(f.requests.filter((value) => value.action === 'delete').length, 1);
  assert.deepEqual(await f.journal.read(A), pending);
  f.reply('success');
  await f.runtime.confirmDeletion();
  assert.equal(f.requests.filter((value) => value.action === 'delete').length, 2);
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'deleted');
  await f.runtime.dispose();
});

test('legacy deletion recovery explicitly reviews its old operation before retry', async () => {
  const values = new Map([
    [
      `cookmate.account-deletion.${A}`,
      JSON.stringify({ ownerId: A, operationId: DELETION_OPERATION, expectedRevision: 0 }),
    ],
  ]);
  const f = deletionFixture(values);
  await f.runtime.initialize();
  await f.runtime.checkDeletion();
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'unconfirmed');
  assert.equal(f.requests.length, 0);
  assert.equal(await f.journal.read(A), null);
  f.reply('success');
  await f.runtime.confirmDeletion();
  assert.equal(f.requests.filter((value) => value.action === 'delete').length, 1);
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'deleted');
  await f.runtime.dispose();
});

test('earlier A deletion remains recoverable after B sign-in and sign-out without touching B local work', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  const a = await f.open();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  assert.deepEqual(f.runtime.getSnapshot().earlierDeletions, []);
  f.loginAs(B);
  await f.runtime.signIn('google', false);
  await a.close();
  const b = await f.open();
  assert.deepEqual(f.runtime.getSnapshot().earlierDeletions, [
    { ownerId: A, operationId: DELETION_OPERATION, status: 'unconfirmed' },
  ]);
  assert.equal(f.statusRequests, 0);
  await f.runtime.signOut(false);
  const callsBeforeCheck = [...f.calls];
  const manifestBeforeCheck = f.selection.getSnapshot();
  const deletionBeforeCheck = f.runtime.getSnapshot().deletion;
  await f.runtime.checkEarlierDeletion(A);
  assert.equal(f.statusRequests, 1);
  assert.deepEqual(f.calls, callsBeforeCheck);
  assert.deepEqual(f.selection.getSnapshot(), manifestBeforeCheck);
  assert.equal(f.runtime.getSnapshot().identity, null);
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'account:' + B);
  assert.equal(f.runtime.getSnapshot().deletion, deletionBeforeCheck);
  assert.equal((await f.journal.read(A))?.kind, 'confirmed');
  assert.deepEqual(f.runtime.getSnapshot().earlierDeletions, [
    { ownerId: A, operationId: DELETION_OPERATION, status: 'deleted' },
  ]);
  assert.equal(f.requests.filter((value) => value.action === 'delete').length, 1);
  assert.equal(JSON.stringify(f.runtime.getSnapshot()).includes('a'.repeat(64)), false);
  await f.runtime.foreground();
  assert.equal(f.runtime.getSnapshot().earlierDeletions?.[0]?.status, 'deleted');
  await b.close();
  await f.runtime.dispose();
});

test('earlier A status confirmation preserves signed-in B and its existing deletion panel', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  f.loginAs(B);
  await f.runtime.signIn('google', false);
  f.values.set(
    `cookmate.account-deletion.${B}`,
    JSON.stringify({
      ownerId: B,
      operationId: A,
      expectedRevision: 2,
    }),
  );
  await f.runtime.checkDeletion();
  const currentPanel = f.runtime.getSnapshot().deletion;
  assert.equal(currentPanel?.kind, 'unconfirmed');
  const callsBeforeCheck = [...f.calls];
  await f.runtime.checkEarlierDeletion(A);
  assert.deepEqual(f.calls, callsBeforeCheck);
  assert.equal(f.runtime.getSnapshot().identity?.ownerId, B);
  assert.equal(f.runtime.getSnapshot().workspaceKey, 'account:' + B);
  assert.equal(f.runtime.getSnapshot().deletion, currentPanel);
  assert.equal(f.runtime.getSnapshot().earlierDeletions?.[0]?.status, 'deleted');
  assert.equal(f.requests.filter((value) => value.action === 'delete').length, 1);
  await f.runtime.dispose();
});

test('earlier pending and unavailable status remain recoverable with the original secret and no resend', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  f.loginAs(B);
  await f.runtime.signIn('google', false);
  const original = await f.journal.read(A);
  f.status(async () => ({ status: 'pending', operationId: DELETION_OPERATION }));
  await f.runtime.checkEarlierDeletion(A);
  assert.equal(f.runtime.getSnapshot().earlierDeletions?.[0]?.status, 'pending');
  f.status(async () => {
    throw new Error('Synthetic unavailable receipt');
  });
  await f.runtime.checkEarlierDeletion(A);
  assert.equal(f.runtime.getSnapshot().earlierDeletions?.[0]?.status, 'unconfirmed');
  assert.deepEqual(await f.journal.read(A), original);
  assert.equal(f.runtime.getSnapshot().identity?.ownerId, B);
  assert.equal(f.runtime.getSnapshot().deletion, null);
  assert.equal(f.calls.includes('signOut'), false);
  assert.equal(f.requests.filter((value) => value.action === 'delete').length, 1);
  assert.equal(f.statusRequests, 2);
  await f.runtime.dispose();
});

for (const nextOwner of [null, C])
  test(`earlier status applies the latest Auth notification when B becomes ${nextOwner === null ? 'signed out' : 'C'}`, async () => {
    const f = deletionFixture();
    await f.runtime.initialize();
    await f.runtime.reviewDeletion();
    await f.runtime.confirmDeletion();
    f.loginAs(B);
    await f.runtime.signIn('google', false);
    let complete!: (status: DeletionRecoveryStatus) => void;
    f.status(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const beforeCalls = [...f.calls];
    const checking = f.runtime.checkEarlierDeletion(A);
    await flush();
    if (nextOwner === null) {
      f.replaceSession(identity(C));
      f.emit(identity(C));
      f.clearSession();
    } else {
      f.clearSession();
      f.replaceSession(identity(nextOwner));
      f.emit(identity(nextOwner));
    }
    assert.equal(f.runtime.getSnapshot().identity?.ownerId, B);
    complete(completedDeletion);
    await checking;
    await flush();
    assert.equal(f.runtime.getSnapshot().identity?.ownerId ?? null, nextOwner);
    assert.equal(f.runtime.getSnapshot().workspaceKey, 'account:' + (nextOwner ?? B));
    assert.equal(f.runtime.getSnapshot().busy, false);
    assert.equal(f.runtime.getSnapshot().deletion, null);
    assert.deepEqual(f.calls, beforeCalls);
    assert.equal((await f.journal.read(A))?.kind, 'confirmed');
    assert.equal(f.runtime.getSnapshot().earlierDeletions?.[0]?.status, 'deleted');
    assert.equal(f.requests.filter((value) => value.action === 'delete').length, 1);
    assert.equal(f.statusRequests, 1);
    // After recovery, ordinary notifications are applied directly again.
    f.replaceSession(identity(B));
    f.emit(identity(B));
    assert.equal(f.runtime.getSnapshot().identity?.ownerId, B);
    await f.runtime.dispose();
  });

test('restart with signed-out retained B lists pending A without opening A or calling either endpoint', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  f.loginAs(B);
  await f.runtime.signIn('google', false);
  const b = await f.open();
  await f.runtime.signOut(false);
  await b.close();
  await f.runtime.dispose();
  const restarted = deletionFixture(f.values, identity(B));
  restarted.clearSession();
  await restarted.runtime.initialize();
  assert.equal(restarted.runtime.getSnapshot().workspaceKey, 'account:' + B);
  assert.equal(restarted.runtime.getSnapshot().identity, null);
  assert.deepEqual(restarted.runtime.getSnapshot().earlierDeletions, [
    { ownerId: A, operationId: DELETION_OPERATION, status: 'unconfirmed' },
  ]);
  assert.equal(
    restarted.calls.some((value) => value.startsWith('open:') || value.startsWith('remove:')),
    false,
  );
  assert.equal(restarted.requests.length, 0);
  assert.equal(restarted.statusRequests, 0);
  await restarted.runtime.dispose();
});

test('a late earlier-status result may retain proof but cannot publish into a retired runtime', async () => {
  const f = deletionFixture();
  await f.runtime.initialize();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  f.loginAs(B);
  await f.runtime.signIn('google', false);
  let complete!: (status: DeletionRecoveryStatus) => void;
  f.status(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const checking = f.runtime.checkEarlierDeletion(A);
  await flush();
  const lastVisible = f.runtime.getSnapshot();
  await f.runtime.dispose();
  complete(completedDeletion);
  await checking;
  assert.equal(f.runtime.getSnapshot(), lastVisible);
  assert.equal((await f.journal.read(A))?.kind, 'confirmed');
  assert.equal(f.calls.includes('signOut'), false);
});

test('startup rejects a removal owner with a trailing newline without modifying local work', async () => {
  const raw = JSON.stringify({ schemaVersion: 1, ownerId: A + '\n', phase: 'signed-out' });
  const f = fixture(null, new Map([['cookmate.account-removal.intent', raw]]));
  await f.runtime.initialize();
  assert.equal(f.runtime.getSnapshot().phase, 'failed');
  assert.equal(f.values.get('cookmate.account-removal.intent'), raw);
  assert.deepEqual(f.calls, []);
  await f.runtime.dispose();
});

test('legacy recovery rejects an operation with a trailing newline before preparing or sending deletion', async () => {
  const key = `cookmate.account-deletion.${A}`;
  const raw = JSON.stringify({
    ownerId: A,
    operationId: DELETION_OPERATION + '\n',
    expectedRevision: 0,
  });
  const f = deletionFixture(new Map([[key, raw]]));
  await f.runtime.initialize();
  await f.runtime.checkDeletion();
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'failed');
  await f.runtime.confirmDeletion();
  assert.equal(f.requests.length, 0);
  assert.equal(f.statusRequests, 0);
  assert.equal(await f.journal.read(A), null);
  assert.equal(f.values.get(key), raw);
  await f.runtime.dispose();
});

/** Actual coordinator with synthetic durable ports; this is runtime sequencing, not service proof. */
function expandedRuntimeFixture(pendingLegacy = false) {
  const snapshot = emptyAccountSnapshot(
    { version: 'test', fingerprint: 'a'.repeat(64) },
    {
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    },
  );
  const inspection: AccountReplicationInspection = {
    local: { storeRevision: 0, snapshot },
    journal: null,
    deviceDataOwnerId: A,
    pendingSettings: null,
    scopeApproval: null,
  };
  const remote = {
    ownerId: A,
    revision: 1,
    snapshot,
    updatedAt: '2026-10-01T12:00:00.000Z',
    deletionOperationId: null,
  };
  if (pendingLegacy)
    inspection.journal = {
      schemaVersion: 1,
      ownerId: A,
      revision: 1,
      base: null,
      observed: null,
      lastApply: null,
      pending: {
        operationId: B,
        mode: 'pull',
        capturedLocal: inspection.local,
        remote,
        proposed: snapshot,
        proposedDigest: 'c'.repeat(64),
        acknowledgement: null,
      },
    };
  const originalPending = JSON.stringify(inspection.journal?.pending);
  let release!: () => void;
  let held = pendingLegacy;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let applies = 0;
  let stages = 0;
  let reads = 0;
  let reviewed = 0;
  let currentScope!: () => AccountReplicationScope | null;
  let issued: AccountScopeApprovalReview | null = null;
  const approval: AccountScopeApprovalService = {
    read: async () => inspection.scopeApproval ?? null,
    review: async (scope) => {
      reviewed++;
      assert.deepEqual(scope, currentScope());
      if (inspection.journal?.pending) throw new AccountReplicationError('operation_pending');
      issued = Object.freeze({
        reviewId: C,
        ownerId: A,
        counts: Object.freeze({
          notes: 0,
          collections: 0,
          memberships: 0,
          manualItems: 0,
          cookingHistory: 0,
        }),
        historyIncluded: false,
        previousApprovalDigest: null,
      });
      return issued;
    },
    approve: async (scope, review, choice) => {
      assert.deepEqual(scope, currentScope());
      assert.equal(review, issued);
      assert.equal(choice.historyIncluded, false);
      const evidence = await createAccountScopeApprovalEvidence(
        {
          schemaVersion: 1,
          ownerId: A,
          scopeVersion: 2,
          personalApproved: true,
          historyIncluded: false,
          decidedAt: '2026-10-01T12:00:00.000Z',
        },
        async (value) => createHash('sha256').update(value).digest('hex'),
      );
      inspection.scopeApproval = evidence;
      inspection.local = {
        storeRevision: 0,
        scope: { version: 2, approvalDigest: evidence.digest, historyIncluded: false },
        snapshot: {
          ...snapshot,
          schemaVersion: 2,
          personal: { notes: [], collections: [], memberships: [], manualItems: [] },
        },
      };
      return evidence;
    },
  };
  const repository = {
    inspect: async () => {
      if (held) {
        held = false;
        await gate;
      }
      return structuredClone(inspection);
    },
    stage: async () => {
      stages++;
      throw new AccountReplicationError('store_busy');
    },
    apply: async () => {
      assert.equal(JSON.stringify(inspection.journal?.pending), originalPending);
      applies++;
      const receipt = {
        ownerId: A,
        operationId: B,
        storeRevision: 1,
        serverRevision: 1,
        appliedAt: remote.updatedAt,
      };
      inspection.journal = {
        schemaVersion: 1,
        ownerId: A,
        revision: 2,
        base: remote,
        observed: null,
        pending: null,
        lastApply: receipt,
      };
      inspection.local = { ...inspection.local, storeRevision: 1 };
      return receipt;
    },
  } as unknown as AccountReplicationRepository;
  const f = fixture(identity(A), new Map(), {
    enableExpandedScope: true,
    config: parseAccountAuthConfig({
      url: 'https://account.example',
      publishableKey: 'sb_publishable_synthetic',
    }),
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).action, 'read');
      reads++;
      return Response.json({
        ...remote,
        schemaVersion: 1,
        revision: 0,
        snapshot: null,
        updatedAt: null,
        deletionPending: false,
      });
    },
    open: async (_workspace, scope) => {
      currentScope = scope;
      return {
        kind: 'ready',
        services: {
          accountReplication: repository,
          accountScopeApproval: approval,
          queries: { subscribe: () => () => undefined },
          close: async () => undefined,
        } as unknown as LocalCookMateServices,
      };
    },
  });
  return {
    ...f,
    inspection,
    release,
    get stages() {
      return stages;
    },
    get applies() {
      return applies;
    },
    get reads() {
      return reads;
    },
    get reviewed() {
      return reviewed;
    },
    originalPending,
  };
}

test('expanded runtime approval persists locally and reaches a separate real coordinator merge review without staging', async () => {
  const f = expandedRuntimeFixture();
  await f.runtime.initialize();
  const opened = await f.open();
  await flush();
  assert.deepEqual(f.runtime.getSnapshot().sync, {
    kind: 'failed',
    reason: 'scope_review_required',
    pending: false,
  });
  assert.equal(f.reads, 0);
  assert.equal(f.stages, 0);
  await f.runtime.reviewSyncScope();
  const reviewed = f.runtime.getSnapshot().scopeReview;
  assert.equal(reviewed?.kind, 'review');
  if (reviewed?.kind !== 'review') assert.fail();
  await f.runtime.approveSyncScope(reviewed.review, false);
  await flush();
  assert.equal(f.inspection.scopeApproval?.record.historyIncluded, false);
  assert.equal(f.runtime.getSnapshot().scopeReview, null);
  assert.equal(f.runtime.getSnapshot().sync.kind, 'review');
  assert.equal(f.stages, 0);
  assert.equal(f.reads, 1);
  f.runtime.confirm();
  await flush();
  assert.equal(f.stages, 1);
  await opened.close();
  await f.runtime.dispose();
});

test('scope review drains a legacy operation then recovers its original bytes before permitting expansion', async () => {
  const f = expandedRuntimeFixture(true);
  await f.runtime.initialize();
  const opened = await f.open();
  await flush();
  const reviewing = f.runtime.reviewSyncScope();
  await flush();
  assert.equal(f.reviewed, 0);
  assert.equal(JSON.stringify(f.inspection.journal?.pending), f.originalPending);
  f.release();
  await reviewing;
  await flush();
  assert.deepEqual(f.runtime.getSnapshot().scopeReview, {
    kind: 'failed',
    reason: 'operation_pending',
  });
  assert.equal(f.applies, 1);
  assert.equal(f.inspection.journal?.schemaVersion, 1);
  assert.equal(f.inspection.journal?.pending, null);
  assert.equal(f.reads, 0);
  assert.equal(f.stages, 0);
  await f.runtime.reviewSyncScope();
  assert.equal(f.runtime.getSnapshot().scopeReview?.kind, 'review');
  await opened.close();
  await f.runtime.dispose();
});
