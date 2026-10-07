import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createBundledContentSnapshot } from '@cookmate/catalogue/content';
import {
  createContentAccountRuntime,
  type ContentAccountRuntimeOptions,
} from '../../../apps/mobile/src/features/content/createContentAccountRuntime';
import {
  privateContentAccountDatabaseName,
  privateContentDatabaseNames,
  readPrivateContentConfiguration,
} from '../../../apps/mobile/src/features/content/privateContentConfig';
import { parseAccountAuthConfig } from '../../../apps/mobile/src/features/account/authConfig';
import type { AccountIdentity } from '../../../apps/mobile/src/features/account/authTypes';
import type { SupabaseAccountAccess } from '../../../apps/mobile/src/features/account/supabaseAccess';
import {
  encodeAppPreferences,
  decodeAppPreferences,
} from '../../../apps/mobile/src/features/app-preferences/preferences';
import type { SqlConnection } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const baselinePromise = createBundledContentSnapshot(sha256);
const identity = (ownerId: string): AccountIdentity => ({
  ownerId,
  provider: 'google',
  email: null,
  displayName: null,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Actual local SQLite owners, injected in-memory installation KV and controlled Auth/HTTP.
 * No SDK, provider sign-in, browser persistence or deployed service is exercised here.
 */
async function fixture(t: TestContext, signedIn = false) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-account-composition-'));
  const config = readPrivateContentConfiguration(
    JSON.stringify({
      version: 1,
      origin: 'http://localhost:19093',
      installationId: randomUUID(),
      releaseId: 'fixture',
      trustKeys: [{ keyId: 'test', publicKeyHex: '1'.repeat(64) }],
    }),
    'http://localhost:19093',
  )!;
  const names = privateContentDatabaseNames(config.installationId);
  const accountName = (id: string) => privateContentAccountDatabaseName(config.installationId, id);
  const allowed = new Set([names.cooking, names.content, accountName(owner), accountName(other)]);
  const live = new Set<SqlConnection>();
  const values = new Map<string, string>();
  const prefix = `installation:${config.installationId}:`;
  let opens = 0,
    copies = 0,
    recoverySettled = true,
    closeFailure = false;
  const copiedDrafts: string[] = [],
    removedPrivate: string[] = [],
    requests: unknown[] = [];
  let session: AccountIdentity | null = signedIn ? identity(owner) : null;
  const authListeners = new Set<(value: AccountIdentity | null) => void>();
  let disposedAuth = false,
    authDisposeCalls = 0,
    sqlCloseCalls = 0;
  let authDisposeGate: ReturnType<typeof deferred> | undefined,
    authDisposeEntered: ReturnType<typeof deferred> | undefined;
  const auth: SupabaseAccountAccess = {
    readSession: async () =>
      session ? { identity: session, accessToken: 'controlled-token' } : null,
    subscribe(listener) {
      authListeners.add(listener);
      return () => {
        authListeners.delete(listener);
      };
    },
    signInNative: async () => {
      session = identity(owner);
      return session;
    },
    prepareWebSignIn: async () => 'https://accounts.example/auth',
    completeWebSignIn: async () => {
      session = identity(owner);
      return session;
    },
    signOut: async () => {
      session = null;
    },
    verifyNativeAccess: async () => undefined,
    startAutoRefresh: async () => undefined,
    stopAutoRefresh: async () => undefined,
    dispose: async () => {
      authDisposeCalls++;
      authDisposeEntered?.resolve();
      if (authDisposeGate) await authDisposeGate.promise;
      disposedAuth = true;
    },
  };
  let verificationGate: ReturnType<typeof deferred> | undefined,
    verificationEntered: ReturnType<typeof deferred> | undefined;
  let recentWriteGate: ReturnType<typeof deferred> | undefined,
    recentWriteEntered: ReturnType<typeof deferred> | undefined;
  const baseline = await baselinePromise;
  const options: ContentAccountRuntimeOptions = {
    recentlyViewedStore(ownerId) {
      const key = `${prefix}recent:${ownerId ?? 'guest'}`;
      return {
        read: async () => values.get(key) ?? null,
        write: async (text) => {
          recentWriteEntered?.resolve();
          if (recentWriteGate) await recentWriteGate.promise;
          values.set(key, text);
        },
      };
    },
    planningStore(ownerId) {
      const key = `${prefix}planning:${ownerId ?? 'guest'}`;
      return {
        read: async () => values.get(key) ?? null,
        write: async (text) => {
          values.set(key, text);
        },
      };
    },
    workspace: {
      config,
      catalogue: catalogue.identity,
      platform: { newId: randomUUID, sha256 },
      async openConnection(name) {
        assert.ok(allowed.has(name));
        opens++;
        const raw = desktopConnection(join(directory, name)).connection;
        let closed = false;
        const result: SqlConnection = {
          all: raw.all.bind(raw),
          exec: raw.exec.bind(raw),
          prepare: raw.prepare.bind(raw),
          async close() {
            sqlCloseCalls++;
            if (!closed) {
              await raw.close();
              closed = true;
              live.delete(result);
            }
            if (closeFailure) throw new Error('Controlled failed close');
          },
        };
        live.add(result);
        return result;
      },
      async verification() {
        verificationEntered?.resolve();
        if (verificationGate) await verificationGate.promise;
        return {
          baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
          readerVersion: 1,
          sha256,
          sha256Bytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
          trustVerifier: { verify: async () => false },
          inspectImage: async () => null,
          readBundledMedia: async () => null,
        };
      },
      journal: () => ({
        read: async () => null,
        save: async () => {
          throw new Error('No publication');
        },
        clear: async () => undefined,
      }),
      now: () => '2026-10-02T12:00:00.000Z',
      dateContext: () => ({
        localDate: '2026-10-02',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      fetch: async () => {
        throw new Error('No content transport in this test');
      },
    },
    databases: {
      async assertGuestRecoverySettled() {
        if (!recoverySettled) throw new Error('Original guest operation needs recovery');
      },
      async cloneGuestWithMarker(sourceName, targetName, marker) {
        assert.equal(sourceName, names.cooking);
        assert.ok(allowed.has(targetName));
        copies++;
        const source = desktopConnection(join(directory, sourceName)),
          temporary = join(directory, `copy-${randomUUID()}.db`);
        try {
          await backup(source.database, temporary);
        } finally {
          await source.connection.close();
        }
        const staging = desktopConnection(temporary);
        try {
          staging.database
            .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
            .run(marker.key, marker.value);
          await backup(staging.database, join(directory, targetName));
        } finally {
          await staging.connection.close();
          await unlink(temporary);
        }
      },
      deleteDatabase: async (name) => {
        assert.ok(allowed.has(name));
        await unlink(join(directory, name));
      },
      copyGuestDraft: async (id) => {
        copiedDrafts.push(id);
      },
      removeOwnerPrivateState: async (id) => {
        removedPrivate.push(id);
        values.delete(`${prefix}recent:${id}`);
        values.delete(`${prefix}planning:${id}`);
      },
    },
    metadata: {
      read: async (key) => values.get(prefix + key) ?? null,
      write: async (key, value) => {
        values.set(prefix + key, value);
      },
      remove: async (key) => {
        values.delete(prefix + key);
      },
    },
    guestPreferences: {
      read: async () =>
        encodeAppPreferences({ theme: 'dark', motion: 'reduced', locale: 'system' }),
      write: async () => {
        throw new Error('Guest preferences must not change');
      },
    },
    auth,
    accountConfig: parseAccountAuthConfig({
      url: 'https://accounts.example',
      publishableKey: 'sb_publishable_controlled',
    }),
    accountFetch: async (_input, init) => {
      const request: unknown = JSON.parse(String(init?.body));
      requests.push(request);
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          ownerId: session?.ownerId,
          revision: 0,
          snapshot: null,
          updatedAt: null,
          deletionPending: false,
          deletionOperationId: null,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
    enableContentSync: true,
  };
  const composition = createContentAccountRuntime(options);
  t.after(async () => {
    closeFailure = false;
    verificationGate?.resolve();
    authDisposeGate?.resolve();
    recentWriteGate?.resolve();
    await composition.runtime.dispose().catch(() => undefined);
    for (const connection of live) await connection.close();
    await removeFixtureDirectory(directory);
  });
  async function start() {
    await composition.prepare();
    await composition.runtime.initialize();
  }
  async function open() {
    const result = await composition.opener(composition.runtime.getSnapshot().workspace)();
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    if (result.kind !== 'ready') throw new Error('Fixture not ready');
    return result.services;
  }
  return {
    composition,
    options,
    start,
    open,
    values,
    copiedDrafts,
    removedPrivate,
    requests,
    prefix,
    directory,
    names,
    baseline,
    accountName,
    get opens() {
      return opens;
    },
    get copies() {
      return copies;
    },
    get live() {
      return live.size;
    },
    get authDisposed() {
      return disposedAuth;
    },
    get authDisposeCalls() {
      return authDisposeCalls;
    },
    get sqlCloseCalls() {
      return sqlCloseCalls;
    },
    holdAuthDispose() {
      authDisposeEntered = deferred();
      authDisposeGate = deferred();
      return { entered: authDisposeEntered.promise, release: authDisposeGate.resolve };
    },
    recovery(value: boolean) {
      recoverySettled = value;
    },
    failClose() {
      closeFailure = true;
    },
    changeOwner(id: string | null) {
      session = id ? identity(id) : null;
      for (const listener of authListeners) listener(session);
    },
    holdVerification() {
      verificationEntered = deferred();
      verificationGate = deferred();
      return { entered: verificationEntered.promise, release: verificationGate.resolve };
    },
    holdRecentWrite() {
      recentWriteEntered = deferred();
      recentWriteGate = deferred();
      return { entered: recentWriteEntered.promise, release: recentWriteGate.resolve };
    },
  };
}
async function waitFor(
  composition: ReturnType<typeof createContentAccountRuntime>,
  predicate: () => boolean,
) {
  if (predicate()) return;
  await new Promise<void>((resolve) => {
    const stop = composition.runtime.subscribe(() => {
      if (predicate()) {
        stop();
        resolve();
      }
    });
    if (predicate()) {
      stop();
      resolve();
    }
  });
}

test('construction performs no I/O and disposal closes the generic guest wrapper without consumer help', async (t) => {
  const f = await fixture(t);
  assert.equal(f.opens, 0);
  assert.equal(f.values.size, 0);
  await f.start();
  const handle = await f.open();
  assert.equal(handle.kind, 'content_workspace');
  if (handle.kind !== 'content_workspace') return;
  assert.equal(handle.access, 'guest');
  assert.equal(handle.runtime.host.account, null);
  const closing = f.composition.runtime.dispose();
  assert.strictEqual(f.composition.runtime.dispose(), closing);
  assert.notEqual(handle.runtime.host.getSnapshot().status, 'ready');
  await closing;
  assert.equal(f.live, 0);
  assert.equal(f.composition.runtime.closed, true);
  assert.equal(f.authDisposed, true);
});

test('initial account preparation uses installed settings, copies only the draft, and preserves guest SQL bytes', async (t) => {
  const f = await fixture(t, true);
  await f.start();
  const guest = desktopConnection(join(f.directory, f.names.cooking));
  const before = JSON.stringify(
    guest.database.prepare('SELECT key,value FROM app_metadata ORDER BY key').all(),
  );
  await guest.connection.close();
  const handle = await f.open();
  assert.equal(handle.kind, 'account_bootstrap');
  assert.deepEqual(f.copiedDrafts, [owner]);
  assert.equal(f.copies, 1);
  const raw = await f.composition.runtime.preferencesStore().read();
  const decoded = decodeAppPreferences(raw);
  assert.equal(decoded.ok, true);
  if (decoded.ok)
    assert.deepEqual(decoded.preferences, { theme: 'dark', motion: 'reduced', locale: 'system' });
  assert.ok([...f.values.keys()].every((key) => key.startsWith(f.prefix)));
  assert.equal(
    [...f.values.keys()].some((key) => /recovery|receipt|auth-/.test(key)),
    false,
  );
  await handle.close();
  const checked = desktopConnection(join(f.directory, f.names.cooking));
  assert.equal(
    JSON.stringify(
      checked.database.prepare('SELECT key,value FROM app_metadata ORDER BY key').all(),
    ),
    before,
  );
  await checked.connection.close();
});

test('unsettled guest recovery blocks the first copy and keeps its selection retry explicit', async (t) => {
  const f = await fixture(t, true);
  await f.start();
  f.recovery(false);
  const rejected = await f.composition.opener(f.composition.runtime.getSnapshot().workspace)();
  assert.equal(rejected.kind, 'failed');
  assert.equal(f.copies, 0);
  assert.deepEqual(f.copiedDrafts, []);
  f.recovery(true);
  const opened = await f.open();
  assert.equal(opened.kind, 'account_bootstrap');
  assert.equal(f.copies, 1);
  await opened.close();
});

test('same-owner authentication renewal changes the view fence without inventing a new local workspace generation', async (t) => {
  const f = await fixture(t, true);
  await f.start();
  const handle = await f.open();
  assert.equal(handle.kind, 'account_bootstrap');
  if (handle.kind !== 'account_bootstrap') return;
  const before = f.composition.view.getSnapshot();
  let notices = 0;
  const stop = f.composition.view.subscribe(() => {
    notices++;
  });
  await f.composition.runtime.signIn('google', false);
  const after = f.composition.view.getSnapshot();
  assert.equal(after.workspaceGeneration, before.workspaceGeneration);
  assert.ok(after.viewGeneration > before.viewGeneration);
  assert.ok(notices > 0);
  await assert.rejects(handle.services.capture());
  assert.equal(
    f.composition.runtime.closed,
    false,
    'UI must close the generic wrapped handle, not just its retired inner resource',
  );
  await handle.close();
  assert.equal(f.composition.runtime.closed, true);
  const reopened = await f.open();
  assert.equal(reopened.kind, 'account_bootstrap');
  await reopened.close();
  stop();
});

test(
  'approved bootstrap stages without uploading, then signed-out bound reopen retains the owner',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, true);
    await f.start();
    const first = await f.open();
    assert.equal(first.kind, 'account_bootstrap');
    const planning = f.composition.planningPreferences();
    await planning.hydrate();
    assert.equal(await planning.setPreference('defaultMealSlot', 'breakfast'), true);
    const recent = f.composition.recentlyViewed();
    await recent.hydrate();
    assert.equal(await recent.setEnabled(true), true);
    assert.equal(await recent.recordOpen(f.baseline.revisions[0]!.ref), true);
    await f.composition.runtime.reviewSyncScope();
    const review = f.composition.runtime.getSnapshot().scopeReview;
    assert.equal(review?.kind, 'review');
    if (review?.kind !== 'review') throw new Error('Approval unavailable');
    await f.composition.runtime.approveSyncScope(review.review, false);
    await waitFor(f.composition, () => f.composition.runtime.getSnapshot().sync.kind === 'review');
    await f.composition.runtime.dispatch({ kind: 'confirm' });
    const staged = f.composition.runtime.getSnapshot().sync;
    assert.equal(staged.kind, 'review');
    if (staged.kind === 'review') assert.equal(staged.phase, 'reopen');
    assert.ok(f.requests.length > 0);
    assert.ok(f.requests.every((value) => JSON.stringify(value) === '{"action":"read"}'));
    await first.close();
    // Avoid a server upload in this local composition test; a signed-out owner gets no account port.
    await f.composition.runtime.signOut(false);
    const local = await f.open();
    assert.equal(local.kind, 'content_workspace');
    if (local.kind !== 'content_workspace') return;
    assert.equal(local.access, 'local');
    assert.equal(local.runtime.host.account, null);
    assert.equal(local.runtime.storageScope.ownerId, owner);
    const signedOutPlanning = f.composition.planningPreferences();
    await signedOutPlanning.hydrate();
    assert.equal(signedOutPlanning.getSnapshot().preferences.defaultMealSlot, 'breakfast');
    assert.equal(await planning.setPreference('weekStart', 'sunday'), false);
    const signedOutRecent = f.composition.recentlyViewed();
    await signedOutRecent.hydrate();
    assert.equal(signedOutRecent.getSnapshot().enabled, true);
    assert.deepEqual(signedOutRecent.getSnapshot().entries[0]?.ref, f.baseline.revisions[0]!.ref);
    assert.equal(await recent.setEnabled(false), false);
    await local.close();
  },
);

test('removing a configured local account drains a late recent write before erasing it, with no guest copy', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, true);
  await f.start();
  const accountHandle = await f.open();
  assert.equal(accountHandle.kind, 'account_bootstrap');
  const recent = f.composition.recentlyViewed();
  await recent.hydrate();
  assert.equal(await recent.setEnabled(true), true);
  const gate = f.holdRecentWrite();
  const lateSave = recent.recordOpen(f.baseline.revisions[0]!.ref);
  await gate.entered;
  await f.composition.runtime.signOut(true);
  assert.equal(f.composition.runtime.getSnapshot().workspace.kind, 'guest');
  await accountHandle.close();
  let reopened = false;
  const opening = f.open().then((value) => { reopened = true; return value; });
  await Promise.resolve();
  assert.equal(reopened, false, 'pending owner write must drain before reopening');
  assert.deepEqual(f.removedPrivate, []);
  gate.release();
  assert.equal(await lateSave, false, 'retired writer must not report current-owner success');
  const guestHandle = await opening;
  assert.equal(guestHandle.kind, 'content_workspace');
  assert.deepEqual(f.removedPrivate, [owner]);
  assert.equal(f.values.has(`${f.prefix}recent:${owner}`), false);
  assert.equal(await recent.recordOpen(f.baseline.revisions[1]!.ref), false);
  const guestRecent = f.composition.recentlyViewed();
  await guestRecent.hydrate();
  assert.equal(guestRecent.getSnapshot().enabled, false);
  assert.deepEqual(guestRecent.getSnapshot().entries, []);
  assert.equal(f.values.has(`${f.prefix}recent:guest`), false);
  await guestHandle.close();
});

test('retained settings callbacks cannot revive after owner away and back', async (t) => {
  const f = await fixture(t, true);
  await f.start();
  const handle = await f.open();
  const original = f.composition.runtime.preferencesStore();
  await original.read();
  await handle.close();
  f.changeOwner(other);
  f.changeOwner(owner);
  await assert.rejects(original.read(), /owner_changed/);
  assert.notStrictEqual(f.composition.runtime.preferencesStore(), original);
  assert.equal(f.copies, 1);
});

test('disposal during pending open drains the late result and never publishes a ready handle', async (t) => {
  const f = await fixture(t);
  await f.start();
  const gate = f.holdVerification();
  const opening = f.composition.opener({ kind: 'guest' })();
  await gate.entered;
  const closing = f.composition.runtime.dispose();
  gate.release();
  assert.equal((await opening).kind, 'failed');
  await closing;
  assert.equal(f.live, 0);
  assert.equal(f.composition.runtime.closed, true);
});

test('failed closing remains a visible disposal barrier and cannot reopen or prepare', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.open();
  const gate = f.holdAuthDispose();
  f.failClose();
  const closing = f.composition.runtime.dispose();
  const rejected = assert.rejects(closing, /cleanup failed/);
  await gate.entered;
  assert.strictEqual(f.composition.runtime.dispose(), closing);
  assert.equal(f.authDisposeCalls, 1);
  assert.equal(f.authDisposed, false);
  gate.release();
  await rejected;
  assert.equal(f.authDisposed, true);
  assert.equal(f.live, 0);
  assert.throws(() => f.composition.prepare(), /closed/);
  assert.throws(() => f.composition.opener({ kind: 'guest' }), /closed/);
});

test('a synchronous retirement observer receives the same disposal promise without repeated closes', async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.open();
  const before = f.sqlCloseCalls,
    live = f.live;
  let reentered: Promise<void> | undefined;
  f.composition.view.subscribe(() => {
    reentered = f.composition.runtime.dispose();
  });
  const closing = f.composition.runtime.dispose();
  assert.strictEqual(reentered, closing);
  await closing;
  assert.equal(f.authDisposeCalls, 1);
  assert.equal(f.sqlCloseCalls - before, live);
  assert.equal(f.live, 0);
});
