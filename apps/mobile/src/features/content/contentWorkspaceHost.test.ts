import { createContentWorkspaceHost, type ContentUpdateIntent } from './contentWorkspaceHost';
import type { ContentAdoptionAccess } from '../../data/contentAdoption';
import type { ContentCookingStoreChange } from '../../data/contentCookingStore';
import type { PersonalChange } from '@cookmate/domain';
import { createLocalContentUpdateJournal } from './contentUpdateJournal';

jest.mock('../account/localAccountStorage', () => ({ localAccountStorage: {} }));
type Options = Parameters<typeof createContentWorkspaceHost>[0];
const installationId = '10000000-0000-4000-8000-000000000001';
const instanceId = '10000000-0000-4000-8000-000000000002';
const operationId = '10000000-0000-4000-8000-000000000003';
const head = { releaseId: 'release1', sequence: 1, fingerprint: 'a'.repeat(64) };
const review = { packageFingerprint: 'b'.repeat(64), head };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(ownerId: string | null = null) {
  let access: ContentAdoptionAccess | null = { ownerId, authGeneration: 1 };
  const accessListeners = new Set<() => void>();
  const changes = new Set<(change: ContentCookingStoreChange) => void>();
  const noteChanges = new Set<(change: PersonalChange) => void>();
  const manualChanges = new Set<(change: PersonalChange) => void>();
  const collectionChanges = new Set<(change: PersonalChange) => void>();
  let restoreAcquire: (() => (() => void) | null) | undefined;
  const restoreService = {
    review: jest.fn(async (..._args: unknown[]) => 'restore review'),
    prepare: jest.fn(async (..._args: unknown[]) => 'restore preparation'),
    execute: jest.fn(
      async (..._args: unknown[]): Promise<unknown> => ({
        kind: 'receipt',
        receipt: { operationId },
      }),
    ),
    readReceipt: jest.fn(async (..._args: unknown[]) => 'restore receipt'),
    readArchive: jest.fn(async (..._args: unknown[]) => 'restore archive'),
  };
  const flushCommitted = jest.fn();
  let accountAcquire: (() => (() => void) | null) | undefined;
  const accountCall = () =>
    jest.fn(async (..._args: unknown[]): Promise<unknown> => 'account result');
  const accountService = {
    scope: { ownerId, authGeneration: 1 },
    capture: accountCall(),
    approval: { read: accountCall(), review: accountCall(), approve: accountCall() },
    journal: {
      read: accountCall(),
      recover: accountCall(),
      stage: accountCall(),
      reviewPush: accountCall(),
      stageReviewedPush: accountCall(),
      recordAcknowledgement: accountCall(),
      discardRejected: accountCall(),
    },
    legacyTransition: {
      read: accountCall(),
      review: accountCall(),
      stage: accountCall(),
      recordAcknowledgement: accountCall(),
      handoff: accountCall(),
      recover: accountCall(),
    },
    apply: {
      review: accountCall(),
      apply: accountCall(),
      recover: accountCall(),
      inspectSettings: accountCall(),
      acknowledgeSettings: accountCall(),
    },
  };
  const flushAccount = jest.fn();
  let context = {
    installationId,
    ownerId,
    adoptedHead: null,
    adoptionRevision: 0,
    storeRevision: 0,
    restoreEpoch: 0,
    retainedRefs: [],
    unresolvedHistoryOrSessionCount: 0,
  };
  let saved: Readonly<ContentUpdateIntent> | null = null;
  const closeOrder: string[] = [];
  const cooking = {
    installationId,
    scope: { ...access },
    connectRestore: jest.fn((acquire: () => (() => void) | null) => {
      restoreAcquire = acquire;
      return { service: restoreService, flushCommitted };
    }),
    connectAccount: jest.fn(async (input: Parameters<Options['cooking']['connectAccount']>[0]) => {
      accountAcquire = input.acquireExclusive;
      return { service: accountService, flushCommitted: flushAccount };
    }),
    content: {
      discover: jest.fn(async () => 'discovery'),
      readCurrent: jest.fn(async () => 'recipe'),
      readExact: jest.fn(async () => 'exact'),
      readPhoto: jest.fn(async () => 'photo'),
      readPhotos: jest.fn(async () => 'photos'),
    },
    commands: {
      reviewDirect: jest.fn(async () => 'review'),
      prepareDirect: jest.fn(async () => 'prepared'),
      execute: jest.fn(async () => 'receipt'),
      readReceipt: jest.fn(async () => 'receipt'),
      readDirectRecovery: jest.fn(async () => 'recovery'),
      acknowledgeDirectRecovery: jest.fn(async () => null),
    },
    queries: {
      readPlan: jest.fn(async () => 'plan'),
      readShopping: jest.fn(async () => 'shopping'),
      readFavourites: jest.fn(async () => 'favourites'),
    },
    history: { readHistory: jest.fn(async () => 'history') },
    backup: {
      capture: jest.fn(async (..._args: unknown[]) => 'backup snapshot'),
      inspect: jest.fn(async (..._args: unknown[]) => 'backup inspection'),
    },
    sessions: {
      readSession: jest.fn(async () => 'session'),
      readResumeSession: jest.fn(async () => 'resume'),
      saveSession: jest.fn(async () => 'session receipt'),
      dismissSession: jest.fn(async () => 'dismissed session'),
      recover: jest.fn(async () => 'recovered session'),
    },
    cooked: {
      saveCooked: jest.fn(async () => 'cooked receipt'),
      prepareCookedRecovery: jest.fn(async () => 'cooked reference'),
      readCookedRecovery: jest.fn(async () => 'cooked receipt'),
      resolveCookedRecovery: jest.fn(async () => 'cooked resolution'),
    },
    notes: {
      readState: jest.fn(async () => 'note state'),
      readRecipeNote: jest.fn(async () => 'private note'),
      execute: jest.fn(async () => 'note receipt'),
      readReceipt: jest.fn(async () => 'note receipt'),
      resolveOperation: jest.fn(async () => 'note cancellation receipt'),
      subscribe(listener: (change: PersonalChange) => void) {
        noteChanges.add(listener);
        return () => {
          noteChanges.delete(listener);
        };
      },
    },
    manual: {
      readState: jest.fn(async () => 'manual state'),
      readManualShopping: jest.fn(async () => 'manual items'),
      execute: jest.fn(async () => 'manual receipt'),
      readReceipt: jest.fn(async () => 'manual receipt'),
      resolveOperation: jest.fn(async () => 'manual cancellation receipt'),
      subscribe(listener: (change: PersonalChange) => void) {
        manualChanges.add(listener);
        return () => {
          manualChanges.delete(listener);
        };
      },
    },
    collections: {
      readCollections: jest.fn(async () => 'collections'),
      readCollection: jest.fn(async () => 'collection page'),
      readRecipeMemberships: jest.fn(async () => 'memberships'),
      execute: jest.fn(async () => 'collection receipt'),
      reviewDeleteCollection: jest.fn(async () => 'collection review'),
      deleteCollection: jest.fn(async (..._args: unknown[]) => 'collection deletion receipt'),
      readReceipt: jest.fn(async () => 'collection receipt'),
      resolveOperation: jest.fn(async () => 'collection cancellation receipt'),
      subscribe(listener: (change: PersonalChange) => void) {
        collectionChanges.add(listener);
        return () => {
          collectionChanges.delete(listener);
        };
      },
    },
    clearHistory: {
      reviewClearHistory: jest.fn(async () => 'history review'),
      clearHistory: jest.fn(async () => 'history clear receipt'),
      readClearHistoryReceipt: jest.fn(async () => 'history clear receipt'),
      resolveClearHistoryOperation: jest.fn(async () => 'history cancellation receipt'),
    },
    adoption: {
      readReleaseContext: jest.fn(async () => structuredClone(context)),
      readMealChoices: jest.fn(async () => 'meal choices'),
      review: jest.fn(async () => 'review'),
      adopt: jest.fn(async () => {
        for (const callback of changes) callback({ kind: 'adoption', storeRevision: 1 });
        return 'adopted';
      }),
      recover: jest.fn(async () => 'recovered adoption'),
    },
    subscribe: (listener: (change: ContentCookingStoreChange) => void) => {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
    close: jest.fn(async () => {
      closeOrder.push('cooking');
      changes.clear();
    }),
  };
  const delivery = {
    stage: jest.fn(async () => 'stage'),
    readStage: jest.fn(async () => 'stage'),
    discardStage: jest.fn(async () => undefined),
    hydrate: jest.fn(async () => ({ kind: 'baseline', head: null, highWater: 0 })),
    reviewStage: jest.fn(async () => review),
    activate: jest.fn(async () => 'activated'),
    recoverActivation: jest.fn(async (): Promise<unknown> => 'recovered'),
    close: jest.fn(async () => {
      closeOrder.push('delivery');
    }),
  };
  const journal = {
    read: jest.fn(async () => saved),
    save: jest.fn(async (intent: Readonly<ContentUpdateIntent>) => {
      saved = intent;
    }),
    clear: jest.fn(async () => {
      saved = null;
    }),
  };
  const options = {
    cooking: cooking as unknown as Options['cooking'],
    delivery: delivery as unknown as Options['delivery'],
    journal,
    instanceId,
    newId: () => operationId,
    getAccess: () => access,
    subscribeAccess: (callback: () => void) => {
      accessListeners.add(callback);
      return () => {
        accessListeners.delete(callback);
      };
    },
  };
  return {
    options,
    cooking,
    delivery,
    journal,
    closeOrder,
    accessListeners,
    changes,
    noteChanges,
    manualChanges,
    collectionChanges,
    restoreService,
    flushCommitted,
    acquireRestore: () => restoreAcquire?.(),
    accountService,
    flushAccount,
    acquireAccount: () => accountAcquire?.(),
    setSaved(value: Readonly<ContentUpdateIntent> | null) {
      saved = value;
    },
    saved: () => saved,
    edit() {
      context = { ...context, storeRevision: context.storeRevision + 1 };
    },
    revoke() {
      access = null;
      for (const callback of accessListeners) callback();
    },
  };
}
const intent: ContentUpdateIntent = {
  version: 1,
  kind: 'activation',
  installationId,
  ownerId: null,
  operationId,
  fingerprint: review.packageFingerprint,
};

type Host = Awaited<ReturnType<typeof createContentWorkspaceHost>>;
const restoreCommand = {} as Parameters<Host['restore']['execute']>[0];
const accountOwner = '10000000-0000-4000-8000-000000000004';
const accountScope = { ownerId: accountOwner, authGeneration: 1 };
const accountOptions = {
  getLocalSettings: () => ({
    appPreferences: {
      theme: 'system' as const,
      motion: 'system' as const,
      locale: 'system' as const,
    },
    profile: { displayName: null },
  }),
};
const accountReview = {} as Parameters<NonNullable<Host['account']>['apply']['apply']>[1];

test('guest hosts do not open account services or silently bind an owner', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  expect(host.account).toBeNull();
  expect(f.cooking.connectAccount).not.toHaveBeenCalled();
  await host.close();
  const refused = fixture();
  await expect(
    createContentWorkspaceHost({ ...refused.options, account: accountOptions }),
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(refused.cooking.connectAccount).not.toHaveBeenCalled();
  expect(refused.cooking.close).toHaveBeenCalledTimes(1);
});

test('owner retirement while account services connect closes both owners before exposing a host', async () => {
  const f = fixture(accountOwner);
  const entered = deferred<void>();
  const connected = deferred<Awaited<ReturnType<typeof f.cooking.connectAccount>>>();
  f.cooking.connectAccount.mockImplementationOnce(async () => {
    entered.resolve();
    return connected.promise;
  });
  const opening = createContentWorkspaceHost({ ...f.options, account: accountOptions });
  await entered.promise;
  f.revoke();
  connected.resolve({ service: f.accountService, flushCommitted: f.flushAccount });
  await expect(opening).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.cooking.close).toHaveBeenCalledTimes(1);
  expect(f.delivery.close).toHaveBeenCalledTimes(1);
  expect(f.closeOrder).toEqual(['cooking', 'delivery']);
  expect(f.accessListeners.size).toBe(0);
});

test('bound account keeps exact issued objects and borrows the same exclusive gate as restore', async () => {
  const f = fixture(accountOwner),
    host = await createContentWorkspaceHost({ ...f.options, account: accountOptions });
  const account = host.account!;
  expect(account.scope).toEqual(accountScope);
  expect(f.acquireAccount()).toBeNull();
  const review = {} as Parameters<typeof account.approval.approve>[1];
  await account.approval.approve(accountScope, review, { historyIncluded: false });
  expect(f.accountService.approval.approve.mock.calls[0]![1]).toBe(review);
  const pendingApply = deferred<unknown>();
  f.accountService.apply.apply.mockImplementationOnce(async () => {
    const unlock = f.acquireAccount();
    expect(unlock).toEqual(expect.any(Function));
    expect(f.acquireRestore()).toBeNull();
    unlock!();
    return pendingApply.promise;
  });
  const applying = account.apply.apply(accountScope, accountReview);
  await expect(host.restore.execute(restoreCommand)).rejects.toMatchObject({ code: 'busy' });
  await expect(host.manual.readManualShopping()).rejects.toMatchObject({ code: 'busy' });
  await expect(account.journal.read(accountScope)).rejects.toMatchObject({ code: 'busy' });
  expect(f.accountService.apply.apply.mock.calls[0]![1]).toBe(accountReview);
  pendingApply.resolve('confirmed account receipt');
  await expect(applying).resolves.toBe('confirmed account receipt');
  await expect(account.capture()).resolves.toBe('account result');
  await host.close();
});

test('account apply refreshes personal and history after dispatch without dropping the mounted review', async () => {
  const f = fixture(accountOwner),
    host = await createContentWorkspaceHost({ ...f.options, account: accountOptions });
  const scopeKey = host.getSnapshot().scopeKey;
  const notes = jest.fn(),
    history = jest.fn();
  host.notes.subscribe(notes);
  host.subscribeCooking(history);
  let refresh: Promise<unknown> | undefined;
  host.manual.subscribe(() => {
    refresh = host.manual.readManualShopping();
  });
  f.flushAccount.mockImplementationOnce(() => {
    for (const listener of f.changes)
      listener({
        kind: 'account',
        value: { revision: 9, collections: ['plan', 'shopping'] },
        personal: true,
        cookingHistory: true,
      });
  });
  await host.account!.apply.apply(accountScope, accountReview);
  expect(notes).toHaveBeenCalledTimes(1);
  expect(history).toHaveBeenCalledWith({ recipeId: null, historyChanged: true, revision: 9 });
  await expect(refresh).resolves.toBe('manual items');
  expect(host.getSnapshot().scopeKey).toBe(scopeKey);
  await host.close();
});

test('account acknowledgement and apply cannot return private results after owner retirement', async () => {
  const f = fixture(accountOwner),
    host = await createContentWorkspaceHost({ ...f.options, account: accountOptions });
  const late = deferred<unknown>();
  f.accountService.journal.recordAcknowledgement.mockReturnValueOnce(late.promise);
  const pending = host.account!.journal.recordAcknowledgement(accountScope, {
    operationId,
    requestFingerprint: 'c'.repeat(64),
    receipt: {
      ownerId: accountOwner,
      operationId,
      revision: 1,
      committedAt: '2026-10-01T12:00:00.000Z',
    },
  });
  await expect(host.account!.apply.apply(accountScope, accountReview)).rejects.toMatchObject({
    code: 'busy',
  });
  f.revoke();
  late.resolve('retired private journal');
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
  await host.awaitClosed();
  const g = fixture(accountOwner),
    other = await createContentWorkspaceHost({ ...g.options, account: accountOptions });
  g.flushAccount.mockImplementationOnce(() => g.revoke());
  await expect(other.account!.apply.apply(accountScope, accountReview)).rejects.toMatchObject({
    code: 'unavailable',
  });
  await other.awaitClosed();
});

test('restore borrows the existing store and forwards the exact issued review and command', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  expect(f.cooking.connectRestore).toHaveBeenCalledTimes(1);
  expect(f.acquireRestore()).toBeNull();
  await expect(host.restore.review('original bytes')).resolves.toBe('restore review');
  const issued = {} as Parameters<Host['restore']['prepare']>[0];
  await host.restore.prepare(issued);
  expect(f.restoreService.prepare.mock.calls[0]![0]).toBe(issued);
  await host.restore.execute(restoreCommand);
  expect(f.restoreService.execute.mock.calls[0]![0]).toBe(restoreCommand);
  await host.restore.readReceipt(operationId);
  await host.restore.readArchive(operationId, 'before');
  expect(f.restoreService.review).toHaveBeenCalledWith('original bytes');
  expect(f.restoreService.readReceipt).toHaveBeenCalledWith(operationId);
  expect(f.restoreService.readArchive).toHaveBeenCalledWith(operationId, 'before');
  await host.close();
});

test('restore owns the outer exclusive gate until dispatch ends, even after engine unlock', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const late = deferred<unknown>();
  f.restoreService.execute.mockImplementationOnce(async () => {
    const unlock = f.acquireRestore();
    expect(unlock).toEqual(expect.any(Function));
    expect(f.acquireRestore()).toBeNull();
    unlock!();
    return late.promise;
  });
  const pending = host.restore.execute(restoreCommand);
  const calls = [
    () => host.backup.capture(),
    () => host.sessions.readResumeSession(),
    () => host.notes.readRecipeNote('52819'),
    () => host.manual.readManualShopping(),
    () => host.commands.execute({} as Parameters<Host['commands']['execute']>[0]),
    () => host.restore.execute(restoreCommand),
    () => host.delivery.activate({} as Parameters<Host['delivery']['activate']>[0]),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'busy' });
  late.resolve({ kind: 'receipt', receipt: { operationId } });
  await expect(pending).resolves.toMatchObject({ kind: 'receipt' });
  await expect(host.backup.capture()).resolves.toBe('backup snapshot');
  expect(f.restoreService.execute).toHaveBeenCalledTimes(1);
  await host.close();
});

test('existing reads and publication recovery prevent restore dispatch', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const late = deferred<string>();
  f.cooking.backup.capture.mockReturnValueOnce(late.promise);
  const capture = host.backup.capture();
  await expect(host.restore.execute(restoreCommand)).rejects.toMatchObject({ code: 'busy' });
  expect(f.restoreService.execute).not.toHaveBeenCalled();
  late.resolve('snapshot');
  await capture;
  await host.close();
  const held = fixture();
  held.setSaved(intent);
  const heldHost = await createContentWorkspaceHost(held.options);
  await expect(heldHost.restore.review('bytes')).rejects.toMatchObject({ code: 'unavailable' });
  await expect(heldHost.restore.execute(restoreCommand)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(held.restoreService.execute).not.toHaveBeenCalled();
  expect(held.restoreService.review).not.toHaveBeenCalled();
  await heldHost.close();
});

test('restore refreshes each subscribed family once after unlocking without retiring the receipt screen', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const originalScope = host.getSnapshot().scopeKey;
  const note = jest.fn(),
    manual = jest.fn(),
    collection = jest.fn(),
    cooking = jest.fn();
  host.notes.subscribe(note);
  host.manual.subscribe(manual);
  host.collections.subscribe(collection);
  host.subscribeCooking(cooking);
  let refresh: Promise<unknown> | undefined;
  host.manual.subscribe(() => {
    refresh = host.manual.readManualShopping();
  });
  f.flushCommitted.mockImplementationOnce(() => {
    for (const listener of f.changes)
      listener({
        kind: 'restore',
        value: { revision: 4, collections: ['plan', 'shopping', 'favourites'] },
        personal: true,
        cookingHistory: false,
      });
  });
  await host.restore.execute(restoreCommand);
  await expect(refresh).resolves.toBe('manual items');
  for (const callback of [note, manual, collection, cooking])
    expect(callback).toHaveBeenCalledTimes(1);
  expect(cooking).toHaveBeenCalledWith({ recipeId: null, historyChanged: false, revision: 4 });
  expect(host.getSnapshot().scopeKey).toBe(originalScope);
  await host.close();
});

test('owner retirement during commit notification preserves uncertainty and the original operation identity', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  f.flushCommitted.mockImplementationOnce(() => f.revoke());
  await expect(host.restore.execute(restoreCommand)).resolves.toMatchObject({
    kind: 'uncertain',
    operationId,
    error: { code: 'stale_context' },
  });
  await host.awaitClosed();
});

test('late restore receipts cannot leak to a retired owner and the gate releases on failures', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  f.restoreService.execute.mockRejectedValueOnce(new Error('storage failed'));
  await expect(host.restore.execute(restoreCommand)).rejects.toThrow('storage failed');
  await expect(host.backup.capture()).resolves.toBe('backup snapshot');
  const late = deferred<unknown>();
  f.restoreService.execute.mockReturnValueOnce(late.promise);
  const pending = host.restore.execute(restoreCommand);
  f.revoke();
  late.resolve({ kind: 'receipt', receipt: { operationId, private: 'must not escape' } });
  const outcome = await pending;
  expect(outcome).toMatchObject({ kind: 'uncertain', operationId });
  expect(outcome).not.toHaveProperty('receipt');
  await host.awaitClosed();
});

test('backup capture and inspection borrow the host and reject retired private results', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  await expect(host.backup.capture()).resolves.toBe('backup snapshot');
  expect(f.cooking.backup.capture).toHaveBeenLastCalledWith();
  await host.backup.capture({ includeCookingHistory: true });
  expect(f.cooking.backup.capture).toHaveBeenLastCalledWith({ includeCookingHistory: true });
  await expect(host.backup.inspect('original file bytes')).resolves.toBe('backup inspection');
  expect(f.cooking.backup.inspect).toHaveBeenCalledWith('original file bytes');
  const release = await host.delivery.review('stage1');
  const late = deferred<string>();
  f.cooking.backup.capture.mockReturnValueOnce(late.promise);
  const pending = host.backup.capture();
  await expect(host.delivery.activate(release)).rejects.toMatchObject({ code: 'busy' });
  f.revoke();
  late.resolve('retired owner backup');
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
  await expect(host.backup.inspect('file')).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.cooking.backup.inspect).toHaveBeenCalledTimes(1);
  await host.awaitClosed();
});

test('publication recovery blocks backup reads before touching private storage', async () => {
  const f = fixture();
  f.setSaved(intent);
  const host = await createContentWorkspaceHost(f.options);
  await expect(host.backup.capture()).rejects.toMatchObject({ code: 'unavailable' });
  await expect(host.backup.inspect('file')).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.cooking.backup.capture).not.toHaveBeenCalled();
  expect(f.cooking.backup.inspect).not.toHaveBeenCalled();
  await host.close();
});

test('exact cooking borrows the host and suppresses retired reads and notifications', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  await expect(host.sessions.readSession('52819')).resolves.toBe('session');
  await expect(host.sessions.readResumeSession()).resolves.toBe('resume');
  const listener = jest.fn();
  const stop = host.subscribeCooking(listener);
  const change = { recipeId: '52819', historyChanged: false, revision: 1 };
  for (const callback of f.changes)
    callback({
      kind: 'personal',
      value: { revision: 1, notes: true, manualShopping: false, collections: false },
    });
  expect(listener).not.toHaveBeenCalled();
  for (const callback of f.changes) callback({ kind: 'cooking', value: change });
  expect(listener).toHaveBeenCalledWith(change);
  const release = await host.delivery.review('stage1');
  const late = deferred<string>();
  f.cooking.sessions.readResumeSession.mockReturnValueOnce(late.promise);
  const pending = host.sessions.readResumeSession();
  await expect(host.delivery.activate(release)).rejects.toMatchObject({ code: 'busy' });
  f.revoke();
  late.resolve('old owner progress');
  await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
  for (const callback of f.changes) callback({ kind: 'cooking', value: change });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(() => host.subscribeCooking(listener)).toThrow();
  await expect(host.sessions.readSession('52819')).rejects.toThrow();
  stop();
  await host.awaitClosed();
});

test('cooked recovery forwards the exact metadata and never reissues a save', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const ref = { recipeId: '52819', revisionId: 'saved-v1', contentFingerprint: 'a'.repeat(64) };
  const reference = {
    formatVersion: 1 as const,
    eventId: operationId,
    requestFingerprint: 'b'.repeat(64),
    contentRef: ref,
    expectedHistoryEpoch: 0,
    session: null,
  };
  await expect(
    host.cooked.prepareCookedRecovery({
      eventId: operationId,
      contentRef: ref,
      expectedHistoryEpoch: 0,
      cookedOn: '2026-10-01',
      timeZone: 'Asia/Dubai',
      note: 'Private draft',
    }),
  ).resolves.toBe('cooked reference');
  await expect(host.cooked.readCookedRecovery(reference)).resolves.toBe('cooked receipt');
  expect(f.cooking.cooked.readCookedRecovery).toHaveBeenCalledWith(reference);
  await expect(host.cooked.resolveCookedRecovery(reference)).resolves.toBe('cooked resolution');
  expect(f.cooking.cooked.resolveCookedRecovery).toHaveBeenCalledWith(reference);
  expect(f.cooking.cooked.saveCooked).not.toHaveBeenCalled();
  const late = deferred<string>();
  f.cooking.cooked.readCookedRecovery.mockReturnValueOnce(late.promise);
  const pending = host.cooked.readCookedRecovery(reference);
  f.revoke();
  late.resolve('old private receipt');
  await expect(pending).rejects.toThrow();
  await expect(host.cooked.resolveCookedRecovery(reference)).rejects.toThrow();
  await host.awaitClosed();
});

test('publication recovery holds all exact cooking capabilities before dispatch', async () => {
  const f = fixture();
  f.setSaved(intent);
  const host = await createContentWorkspaceHost(f.options);
  await expect(host.sessions.readResumeSession()).rejects.toThrow();
  await expect(host.sessions.readSession('52819')).rejects.toThrow();
  await expect(host.sessions.saveSession({} as never)).rejects.toThrow();
  await expect(host.sessions.dismissSession({} as never)).rejects.toThrow();
  await expect(host.sessions.recover({} as never)).rejects.toThrow();
  await expect(host.cooked.prepareCookedRecovery({} as never)).rejects.toThrow();
  await expect(host.cooked.readCookedRecovery({} as never)).rejects.toThrow();
  await expect(host.cooked.resolveCookedRecovery({} as never)).rejects.toThrow();
  await expect(host.cooked.saveCooked({} as never)).rejects.toThrow();
  expect(f.cooking.sessions.saveSession).not.toHaveBeenCalled();
  expect(f.cooking.cooked.saveCooked).not.toHaveBeenCalled();
  expect(() => host.subscribeCooking(jest.fn())).toThrow();
  await host.close();
});

test('collections preserve the exact review and reject late results after owner retirement', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  await expect(host.collections.readCollections()).resolves.toBe('collections');
  await expect(host.collections.readCollection(instanceId, { limit: 20 })).resolves.toBe(
    'collection page',
  );
  await expect(host.collections.readRecipeMemberships('52819')).resolves.toBe('memberships');
  expect(f.cooking.collections.readRecipeMemberships).toHaveBeenCalledWith('52819');
  await expect(host.collections.reviewDeleteCollection(instanceId)).resolves.toBe(
    'collection review',
  );
  const exactReview = {
    reviewId: instanceId,
    collectionId: instanceId,
    name: 'Collection',
    expectedRevision: 1,
    epoch: 0,
    affectedRecipeIds: ['52819'],
  };
  await expect(host.collections.deleteCollection(exactReview, operationId)).resolves.toBe(
    'collection deletion receipt',
  );
  expect(f.cooking.collections.deleteCollection.mock.calls[0]?.[0]).toBe(exactReview);
  await expect(host.collections.readReceipt(operationId)).resolves.toBe('collection receipt');
  await expect(host.collections.resolveOperation(operationId)).resolves.toBe(
    'collection cancellation receipt',
  );
  const listener = jest.fn();
  const stop = host.collections.subscribe(listener);
  const change: PersonalChange = {
    revision: 1,
    notes: false,
    manualShopping: false,
    collections: true,
  };
  for (const callback of f.collectionChanges) callback(change);
  expect(listener).toHaveBeenCalledTimes(1);
  const release = await host.delivery.review('stage1');
  const late = deferred<string>();
  f.cooking.collections.readCollection.mockReturnValueOnce(late.promise);
  const reading = host.collections.readCollection(instanceId);
  await expect(host.delivery.activate(release)).rejects.toMatchObject({ code: 'busy' });
  f.revoke();
  late.resolve('old owner collection');
  await expect(reading).rejects.toMatchObject({ code: 'unavailable' });
  for (const callback of f.collectionChanges) callback(change);
  expect(listener).toHaveBeenCalledTimes(1);
  await expect(host.collections.deleteCollection(exactReview, operationId)).rejects.toThrow();
  await expect(host.collections.readReceipt(operationId)).rejects.toThrow();
  await expect(host.collections.resolveOperation(operationId)).rejects.toThrow();
  expect(() => host.collections.subscribe(listener)).toThrow();
  stop();
  await host.awaitClosed();
});

test('publication recovery prevents collection reads and mutations reaching the store', async () => {
  const f = fixture();
  f.setSaved(intent);
  const host = await createContentWorkspaceHost(f.options);
  await expect(host.collections.readCollections()).rejects.toThrow();
  await expect(host.collections.readRecipeMemberships('52819')).rejects.toThrow();
  await expect(host.collections.reviewDeleteCollection(instanceId)).rejects.toThrow();
  await expect(
    host.collections.execute({
      kind: 'createCollection',
      operationId,
      expectedEpoch: 0,
      collectionId: instanceId,
      name: 'Collection',
    }),
  ).rejects.toThrow();
  await expect(host.collections.resolveOperation(operationId)).rejects.toThrow();
  expect(f.cooking.collections.readCollections).not.toHaveBeenCalled();
  expect(f.cooking.collections.execute).not.toHaveBeenCalled();
  await host.close();
});

test('manual items borrow the host, hold activation and cannot outlive the owner', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  await expect(host.manual.readState()).resolves.toBe('manual state');
  await expect(host.manual.readManualShopping({ limit: 50 })).resolves.toBe('manual items');
  expect(f.cooking.manual.readManualShopping).toHaveBeenCalledWith({ limit: 50 });
  const command = {
    kind: 'setManualPurchased',
    operationId,
    expectedEpoch: 0,
    itemId: instanceId,
    expectedRevision: 1,
    purchased: true,
  } as const;
  await expect(host.manual.execute(command)).resolves.toBe('manual receipt');
  expect(f.cooking.manual.execute).toHaveBeenCalledWith(command);
  await expect(host.manual.readReceipt(operationId)).resolves.toBe('manual receipt');
  await expect(host.manual.resolveOperation(operationId)).resolves.toBe(
    'manual cancellation receipt',
  );
  const changed = jest.fn(),
    stop = host.manual.subscribe(changed);
  const notification: PersonalChange = {
    revision: 1,
    notes: false,
    collections: false,
    manualShopping: true,
  };
  for (const listener of f.manualChanges) listener(notification);
  expect(changed).toHaveBeenCalledTimes(1);
  const release = await host.delivery.review('stage1');
  const late = deferred<string>();
  f.cooking.manual.readManualShopping.mockReturnValueOnce(late.promise);
  const reading = host.manual.readManualShopping();
  await expect(host.delivery.activate(release)).rejects.toMatchObject({ code: 'busy' });
  f.revoke();
  late.resolve('old owner manual items');
  await expect(reading).rejects.toMatchObject({ code: 'unavailable' });
  for (const listener of f.manualChanges) listener(notification);
  expect(changed).toHaveBeenCalledTimes(1);
  await expect(host.manual.execute(command)).rejects.toThrow();
  await expect(host.manual.readReceipt(operationId)).rejects.toThrow();
  await expect(host.manual.resolveOperation(operationId)).rejects.toThrow();
  expect(() => host.manual.subscribe(changed)).toThrow();
  expect(f.cooking.manual.execute).toHaveBeenCalledTimes(1);
  stop();
  await host.awaitClosed();
});

test('pending publication holds manual reads, changes and recovery', async () => {
  const f = fixture();
  f.setSaved(intent);
  const host = await createContentWorkspaceHost(f.options);
  await expect(host.manual.readState()).rejects.toThrow();
  await expect(host.manual.readManualShopping()).rejects.toThrow();
  await expect(
    host.manual.execute({
      kind: 'deleteManualItem',
      operationId,
      expectedEpoch: 0,
      itemId: instanceId,
      expectedRevision: 1,
    }),
  ).rejects.toThrow();
  await expect(host.manual.readReceipt(operationId)).rejects.toThrow();
  await expect(host.manual.resolveOperation(operationId)).rejects.toThrow();
  expect(f.cooking.manual.readManualShopping).not.toHaveBeenCalled();
  expect(f.cooking.manual.execute).not.toHaveBeenCalled();
  expect(f.cooking.manual.resolveOperation).not.toHaveBeenCalled();
  await host.close();
});

test('notes forward to the same host and late results cannot cross owner retirement', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  await expect(host.notes.readState()).resolves.toBe('note state');
  await expect(host.notes.readRecipeNote('52819')).resolves.toBe('private note');
  expect(f.cooking.notes.readRecipeNote).toHaveBeenCalledWith('52819');
  const command = {
    kind: 'deleteNote',
    operationId,
    expectedEpoch: 0,
    noteId: instanceId,
    expectedRevision: 1,
  } as const;
  await expect(host.notes.execute(command)).resolves.toBe('note receipt');
  expect(f.cooking.notes.execute).toHaveBeenCalledWith(command);
  await expect(host.notes.readReceipt(operationId)).resolves.toBe('note receipt');
  await expect(host.notes.resolveOperation(operationId)).resolves.toBe('note cancellation receipt');
  const changed = jest.fn(),
    stop = host.notes.subscribe(changed);
  const notification: PersonalChange = {
    revision: 1,
    notes: true,
    collections: false,
    manualShopping: false,
  };
  for (const listener of f.noteChanges) listener(notification);
  expect(changed).toHaveBeenCalledTimes(1);
  const release = await host.delivery.review('stage1');
  const late = deferred<string>();
  f.cooking.notes.readRecipeNote.mockReturnValueOnce(late.promise);
  const reading = host.notes.readRecipeNote('52819');
  await expect(host.delivery.activate(release)).rejects.toMatchObject({ code: 'busy' });
  f.revoke();
  late.resolve('old owner private note');
  await expect(reading).rejects.toMatchObject({ code: 'unavailable' });
  for (const listener of f.noteChanges) listener(notification);
  expect(changed).toHaveBeenCalledTimes(1);
  await expect(host.notes.execute(command)).rejects.toThrow();
  await expect(host.notes.readReceipt(operationId)).rejects.toThrow();
  await expect(host.notes.resolveOperation(operationId)).rejects.toThrow();
  expect(() => host.notes.subscribe(changed)).toThrow();
  expect(f.cooking.notes.execute).toHaveBeenCalledTimes(1);
  stop();
  await host.awaitClosed();
});

test('publication recovery holds note reads, changes and recovery until settled', async () => {
  const f = fixture();
  f.setSaved(intent);
  const host = await createContentWorkspaceHost(f.options);
  await expect(host.notes.readState()).rejects.toThrow();
  await expect(host.notes.readRecipeNote('52819')).rejects.toThrow();
  await expect(
    host.notes.execute({
      kind: 'deleteNote',
      operationId,
      expectedEpoch: 0,
      noteId: instanceId,
      expectedRevision: 1,
    }),
  ).rejects.toThrow();
  await expect(host.notes.readReceipt(operationId)).rejects.toThrow();
  await expect(host.notes.resolveOperation(operationId)).rejects.toThrow();
  expect(f.cooking.notes.readRecipeNote).not.toHaveBeenCalled();
  expect(f.cooking.notes.execute).not.toHaveBeenCalled();
  expect(f.cooking.notes.resolveOperation).not.toHaveBeenCalled();
  await host.close();
});

test('activation uses all retained refs, persists identity first, hides reading, and does not adopt', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const checked = await host.delivery.review('stage1');
  expect(f.delivery.reviewStage).toHaveBeenCalledWith('stage1', {
    expectedHead: null,
    retainedRefs: [],
  });
  const settled = deferred<string>();
  f.delivery.activate.mockImplementation(async () => {
    expect(f.saved()).toEqual(intent);
    expect(host.getSnapshot().status).toBe('updating');
    return settled.promise;
  });
  const oldScope = host.getSnapshot().scopeKey;
  const updating = host.delivery.activate(checked);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await expect(host.content.readCurrent('52819')).rejects.toThrow();
  settled.resolve('activated');
  await expect(updating).resolves.toBe('activated');
  expect(host.getSnapshot().scopeKey).not.toBe(oldScope);
  expect(host.getSnapshot().status).toBe('result_ready');
  expect(f.saved()).toEqual(intent);
  await host.acknowledgeUpdate();
  expect(f.saved()).toBeNull();
  expect(f.cooking.adoption.adopt).not.toHaveBeenCalled();
  await host.close();
});
test('changed pins reject review before dispatch or journal writes', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const checked = await host.delivery.review('stage1');
  f.edit();
  await expect(host.delivery.activate(checked)).rejects.toMatchObject({ code: 'review_changed' });
  expect(f.delivery.activate).not.toHaveBeenCalled();
  expect(f.journal.save).not.toHaveBeenCalled();
  await host.close();
});

test('history and clear recovery borrow the owned services and admitted installation', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  await expect(host.readInstallationId()).resolves.toEqual({
    kind: 'ready',
    revision: 0,
    value: installationId,
  });
  await expect(host.history.readHistory({ limit: 20 })).resolves.toBe('history');
  expect(f.cooking.history.readHistory).toHaveBeenCalledWith({ limit: 20 });
  await expect(host.clearHistory.reviewClearHistory()).resolves.toBe('history review');
  const reviewed = { count: 1 } as never;
  await expect(host.clearHistory.clearHistory(reviewed, operationId)).resolves.toBe(
    'history clear receipt',
  );
  expect(f.cooking.clearHistory.clearHistory).toHaveBeenCalledWith(reviewed, operationId);
  await expect(host.clearHistory.readClearHistoryReceipt(operationId)).resolves.toBe(
    'history clear receipt',
  );
  await expect(host.clearHistory.resolveClearHistoryOperation(operationId)).resolves.toBe(
    'history cancellation receipt',
  );
  await host.close();
});

test('history reads hold activation and late private history is rejected after owner revocation', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const checked = await host.delivery.review('stage1');
  const delayed = deferred<string>();
  f.cooking.history.readHistory.mockReturnValueOnce(delayed.promise);
  const reading = host.history.readHistory();
  await expect(host.delivery.activate(checked)).rejects.toMatchObject({ code: 'busy' });
  f.revoke();
  delayed.resolve('private note');
  await expect(reading).rejects.toMatchObject({ code: 'unavailable' });
  await expect(host.readInstallationId()).rejects.toMatchObject({ code: 'unavailable' });
  await expect(host.clearHistory.clearHistory({} as never, operationId)).rejects.toThrow();
  await expect(host.clearHistory.readClearHistoryReceipt(operationId)).rejects.toThrow();
  await expect(host.clearHistory.resolveClearHistoryOperation(operationId)).rejects.toThrow();
  expect(f.cooking.clearHistory.clearHistory).not.toHaveBeenCalled();
  expect(f.cooking.clearHistory.readClearHistoryReceipt).not.toHaveBeenCalled();
  expect(f.cooking.clearHistory.resolveClearHistoryOperation).not.toHaveBeenCalled();
  await host.awaitClosed();
});

test('publication recovery blocks history changes until the pending update is settled', async () => {
  const f = fixture();
  f.setSaved(intent);
  const host = await createContentWorkspaceHost(f.options);
  await expect(host.history.readHistory()).rejects.toThrow();
  await expect(host.clearHistory.reviewClearHistory()).rejects.toThrow();
  await expect(host.clearHistory.clearHistory({} as never, operationId)).rejects.toThrow();
  expect(f.cooking.history.readHistory).not.toHaveBeenCalled();
  expect(f.cooking.clearHistory.reviewClearHistory).not.toHaveBeenCalled();
  expect(f.cooking.clearHistory.clearHistory).not.toHaveBeenCalled();
  await host.close();
});
test('the final reference check excludes new host mutations and competing activation', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const checked = await host.delivery.review('stage1');
  const capture = await f.cooking.adoption.readReleaseContext();
  const delayed = deferred<typeof capture>();
  f.cooking.adoption.readReleaseContext.mockImplementationOnce(() => delayed.promise);
  const activating = host.delivery.activate(checked);
  await expect(host.commands.execute({} as never)).rejects.toMatchObject({ code: 'busy' });
  await expect(host.delivery.activate(checked)).rejects.toMatchObject({ code: 'busy' });
  delayed.resolve(capture);
  await activating;
  expect(f.cooking.commands.execute).not.toHaveBeenCalled();
  await host.close();
});
test('lost activation acknowledgement stays fenced and recovery never redispatches', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const checked = await host.delivery.review('stage1');
  f.delivery.activate.mockRejectedValueOnce(new Error('Lost response'));
  await expect(host.delivery.activate(checked)).rejects.toThrow('Lost response');
  expect(host.getSnapshot()).toMatchObject({ status: 'recovery_required', pending: intent });
  await expect(host.queries.readShopping()).rejects.toThrow();
  await expect(host.recoverUpdate()).resolves.toBe('recovered');
  expect(f.delivery.activate).toHaveBeenCalledTimes(1);
  expect(f.delivery.recoverActivation).toHaveBeenCalledWith(operationId, intent.fingerprint);
  await host.acknowledgeUpdate();
  expect(f.saved()).toBeNull();
  await host.close();
});
test('reopening with an intent starts in recovery, and an absent receipt is returned as null', async () => {
  const f = fixture();
  f.setSaved(intent);
  f.delivery.recoverActivation.mockResolvedValueOnce(null);
  const host = await createContentWorkspaceHost(f.options);
  expect(host.getSnapshot().status).toBe('recovery_required');
  await expect(host.recoverUpdate()).resolves.toBeNull();
  expect(f.delivery.activate).not.toHaveBeenCalled();
  await host.close();
});
test('journal failure never dispatches and keeps its uncertain saved identity', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const checked = await host.delivery.review('stage1');
  f.journal.save.mockRejectedValueOnce(new Error('Quota'));
  await expect(host.delivery.activate(checked)).rejects.toThrow('Quota');
  expect(f.delivery.activate).not.toHaveBeenCalled();
  expect(host.getSnapshot().pending).toEqual(intent);
  await host.close();
});
test('owner revocation clears mounted authority, rejects delayed results and drains cooking before delivery', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const delayed = deferred<string>();
  f.cooking.content.readCurrent.mockReturnValueOnce(delayed.promise);
  const reading = host.content.readCurrent('52819');
  f.revoke();
  expect(host.getSnapshot().status).toBe('revoked');
  delayed.resolve('private content');
  await expect(reading).rejects.toThrow();
  await host.awaitClosed();
  expect(f.closeOrder).toEqual(['cooking', 'delivery']);
  expect(f.accessListeners.size).toBe(0);
});
test('invalid opening closes owned stores, and cleanup failures remain observable', async () => {
  const f = fixture();
  f.options.instanceId = 'invalid';
  f.cooking.close.mockRejectedValueOnce(new Error('Close failed'));
  await expect(createContentWorkspaceHost(f.options)).rejects.toBeInstanceOf(AggregateError);
  expect(f.delivery.close).toHaveBeenCalledTimes(1);
});
test('failed image cleanup remains owned across close and retries only that resource', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const resource = { uri: 'blob:owned', release: jest.fn(() => false) };
  host.onPhotoCleanupFailure(resource);
  host.onPhotoCleanupFailure(resource);
  expect(host.getSnapshot().cleanupPending).toBe(1);
  await host.close();
  expect(host.getSnapshot().cleanupPending).toBe(1);
  resource.release.mockReturnValue(true);
  expect(host.retryPhotoCleanup()).toBe(0);
});
test('reentrant close notification shares one promise and closes each owned store once', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  let nested: Promise<void> | undefined;
  host.subscribe(() => {
    if (host.getSnapshot().status === 'closed') nested = host.close();
  });
  const closing = host.close();
  expect(nested).toBe(closing);
  await closing;
  expect(f.cooking.close).toHaveBeenCalledTimes(1);
  expect(f.delivery.close).toHaveBeenCalledTimes(1);
});
test.each(['activation', 'recovery', 'adoption'] as const)(
  'revocation during %s result notification suppresses success and retains durable recovery',
  async (kind) => {
    const f = fixture();
    if (kind === 'recovery') f.setSaved(intent);
    const host = await createContentWorkspaceHost(f.options);
    const checked = kind === 'activation' ? await host.delivery.review('stage1') : undefined;
    host.subscribe(() => {
      if (host.getSnapshot().status === 'result_ready') f.revoke();
    });
    const operation =
      kind === 'activation'
        ? host.delivery.activate(checked!)
        : kind === 'recovery'
          ? host.recoverUpdate()
          : host.adoption.adopt({
              installationId,
              ownerId: null,
              operationId,
              requestFingerprint: 'c'.repeat(64),
            } as never);
    await expect(operation).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.saved()?.operationId).toBe(operationId);
    expect(f.journal.clear).not.toHaveBeenCalled();
    expect(host.getSnapshot().status).toBe('revoked');
    await host.awaitClosed();
  },
);
test('adoption remains explicit and journals its original operation ID', async () => {
  const f = fixture(),
    host = await createContentWorkspaceHost(f.options);
  const adoption = {
    installationId,
    ownerId: null,
    operationId,
    requestFingerprint: 'c'.repeat(64),
  };
  await host.adoption.adopt(adoption as never);
  expect(f.journal.save).toHaveBeenCalledWith({
    ...intent,
    kind: 'adoption',
    fingerprint: 'c'.repeat(64),
  });
  expect(f.delivery.activate).not.toHaveBeenCalled();
  await host.close();
});

test('durable journal round trip, idempotence and compare-and-clear protect other operations', async () => {
  const values = new Map<string, string>();
  const storage = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
  const journal = createLocalContentUpdateJournal(installationId, null, storage);
  await journal.save(intent);
  await journal.save(intent);
  const reopened = createLocalContentUpdateJournal(installationId, null, storage);
  expect(await reopened.read()).toEqual(intent);
  const other = { ...intent, operationId: instanceId };
  await expect(journal.save(other)).rejects.toThrow();
  await expect(journal.clear(other)).rejects.toThrow();
  expect(await reopened.read()).toEqual(intent);
  await journal.clear(intent);
  await journal.clear(intent);
  expect(await journal.read()).toBeNull();
});
test('journal rejects oversized/corrupt data and unconfirmed writes without overwriting it', async () => {
  let retained: string | null = 'x'.repeat(5000);
  const storage = {
    read: async () => retained,
    write: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
  };
  const journal = createLocalContentUpdateJournal(installationId, null, storage);
  await expect(journal.read()).rejects.toThrow();
  await expect(journal.save(intent)).rejects.toThrow();
  expect(storage.write).not.toHaveBeenCalled();
  retained = null;
  await expect(journal.save(intent)).rejects.toThrow('not confirmed');
});
