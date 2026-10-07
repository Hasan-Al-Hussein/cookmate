import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import type { CookingChange, PersonalChange } from '@cookmate/domain';
import type { ContractError } from '@cookmate/contracts';
import type { ContentAdoptionAccess, ContentAdoptionReview } from '../../data/contentAdoption';
import type { openContentCookingStore } from '../../data/contentCookingStore';
import type { ContentReleaseReview, openContentReleaseStore } from '../../data/contentReleaseStore';
import { isAppId } from '../../data/conversationRecords';
import type { ContentPhotoResource } from './contentPhotoResourceTypes';

type Cooking = Awaited<ReturnType<typeof openContentCookingStore>>;
type Delivery = Awaited<ReturnType<typeof openContentReleaseStore>>;
export interface ContentUpdateIntent {
  version: 1;
  kind: 'activation' | 'adoption';
  installationId: string;
  ownerId: string | null;
  operationId: string;
  fingerprint: string;
}
/** Durable, private-workspace-bound storage. No in-memory production fallback. */
export interface ContentUpdateJournal {
  read(): Promise<unknown>;
  save(intent: Readonly<ContentUpdateIntent>): Promise<void>;
  /** Compare-and-clear the exact intent (or already absent); never erase a different operation. */
  clear(intent: Readonly<ContentUpdateIntent>): Promise<void>;
}
export interface ContentWorkspaceState {
  status: 'ready' | 'updating' | 'result_ready' | 'recovery_required' | 'revoked' | 'closed';
  scopeKey: string;
  pending: Readonly<ContentUpdateIntent> | null;
  cleanupPending: number;
}
interface Options {
  /** Ownership transfers to this host. Do not retain another mutable consumer of either store. */
  cooking: Cooking;
  delivery: Delivery;
  journal: ContentUpdateJournal;
  /** Unique for this opening, independent of recipe/delivery data. */
  instanceId: string;
  newId(): string;
  getAccess(): ContentAdoptionAccess | null;
  /** Must fire synchronously when owner/access authority is revoked. */
  subscribeAccess(listener: () => void): () => void;
  /** Explicit already-bound owner connection; omitted for the ordinary guest installation. */
  account?: Pick<Parameters<Cooking['connectAccount']>[0], 'getLocalSettings'>;
}
export class ContentWorkspaceHostError extends Error {
  constructor(readonly code: 'unavailable' | 'busy' | 'review_changed' | 'invalid_recovery') {
    super(`Content workspace: ${code}`);
    this.name = 'ContentWorkspaceHostError';
  }
}
const same = (a: unknown, b: unknown) => canonicalContentJson(a) === canonicalContentJson(b);

/**
 * Opt-in private8 host. It opens/migrates no database and configures no network service.
 * All consumers must use the guarded facade, never the transferred raw stores.
 * Cache activation and cooking adoption remain distinct, explicit reviewed operations.
 */
export async function createContentWorkspaceHost(options: Options) {
  const { cooking, delivery, instanceId, newId, getAccess, subscribeAccess } = options;
  const journal = Object.freeze({
    read: options.journal.read.bind(options.journal),
    save: options.journal.save.bind(options.journal),
    clear: options.journal.clear.bind(options.journal),
  });
  const scope = Object.freeze({ ...cooking.scope });
  let epoch = 0,
    inFlight = 0,
    disposed = false,
    reserved = false;
  const listeners = new Set<() => void>();
  const cleanup = new Set<ContentPhotoResource>();
  const reviews = new WeakMap<object, string>();
  let state: Readonly<ContentWorkspaceState> = Object.freeze({
    status: 'updating',
    scopeKey: `${instanceId}:0`,
    pending: null,
    cleanupPending: 0,
  });
  let detachAccess: (() => void) | undefined;
  let detachCooking: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let restore: ReturnType<Cooking['connectRestore']>;
  let account: Awaited<ReturnType<Cooking['connectAccount']>> | undefined;
  let exclusiveExecution: { kind: 'restore' | 'account'; acquired: boolean } | null = null;
  const getAccountSettings = options.account?.getLocalSettings;
  function acquireFor(kind: 'restore' | 'account') {
    const token = exclusiveExecution;
    if (
      !token ||
      token.kind !== kind ||
      token.acquired ||
      !reserved ||
      !accessValid() ||
      state.status !== 'ready'
    )
      return null;
    token.acquired = true;
    // Only the outer dispatch releases admission, after transaction and recovery work have ended.
    return () => {};
  }
  function publish(status = state.status, pending = state.pending, invalidate = false) {
    if (invalidate) epoch++;
    state = Object.freeze({
      status,
      pending,
      scopeKey: `${instanceId}:${epoch}`,
      cleanupPending: cleanup.size,
    });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A view cannot change a durable outcome. */
      }
    }
  }
  function accessValid() {
    const live = getAccess();
    return (
      !disposed && live?.ownerId === scope.ownerId && live.authGeneration === scope.authGeneration
    );
  }
  function check() {
    if (!accessValid()) throw new ContentWorkspaceHostError('unavailable');
  }
  function ready() {
    check();
    if (state.status !== 'ready') throw new ContentWorkspaceHostError('unavailable');
    if (reserved) throw new ContentWorkspaceHostError('busy');
  }
  function idle() {
    ready();
    if (inFlight) throw new ContentWorkspaceHostError('busy');
  }
  function ownIntent(raw: unknown): Readonly<ContentUpdateIntent> | null {
    if (raw === null) return null;
    const value: unknown = JSON.parse(canonicalContentJson(raw, 4096));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ContentWorkspaceHostError('invalid_recovery');
    const intent = value as ContentUpdateIntent;
    if (
      Object.keys(intent).sort().join(',') !==
        'fingerprint,installationId,kind,operationId,ownerId,version' ||
      intent.version !== 1 ||
      !['activation', 'adoption'].includes(intent.kind) ||
      intent.installationId !== cooking.installationId ||
      intent.ownerId !== scope.ownerId ||
      !isAppId(intent.operationId) ||
      typeof intent.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(intent.fingerprint)
    )
      throw new ContentWorkspaceHostError('invalid_recovery');
    return Object.freeze(intent);
  }
  function guarded<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
    return async (...args: Args): Promise<Result> => {
      ready();
      const captured = epoch;
      inFlight++;
      try {
        const result = await operation(...args);
        check();
        if (captured !== epoch || state.status !== 'ready')
          throw new ContentWorkspaceHostError('unavailable');
        return result;
      } finally {
        inFlight--;
      }
    };
  }
  function retryPhotoCleanup() {
    for (const resource of cleanup) {
      try {
        if (resource.release()) cleanup.delete(resource);
      } catch {
        /* Keep capability for retry. */
      }
    }
    if (state.cleanupPending !== cleanup.size) publish();
    return cleanup.size;
  }
  function onPhotoCleanupFailure(resource: ContentPhotoResource) {
    cleanup.add(resource);
    retryPhotoCleanup();
    if (state.cleanupPending !== cleanup.size) publish();
  }
  function close(status: 'closed' | 'revoked' = 'closed'): Promise<void> {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    disposed = true;
    const failures: unknown[] = [];
    for (const detach of [detachAccess, detachCooking]) {
      try {
        detach?.();
      } catch (error) {
        failures.push(error);
      }
    }
    publish(status, state.pending, true);
    // close() synchronously revokes store admission before its asynchronous draining work.
    void (async () => {
      for (const owned of [cooking, delivery]) {
        try {
          await owned.close();
        } catch (error) {
          failures.push(error);
        }
      }
      retryPhotoCleanup();
      if (failures.length) throw new AggregateError(failures, 'Content workspace cleanup failed');
    })().then(resolve, reject);
    return closing;
  }
  function revokeIfNeeded() {
    let valid = false;
    try {
      valid = accessValid();
    } catch {
      /* Fail closed when the owner cannot be read. */
    }
    if (!valid) void close('revoked').catch(() => undefined);
  }
  try {
    if (!isAppId(instanceId) || !isAppId(cooking.installationId))
      throw new ContentWorkspaceHostError('unavailable');
    check();
    detachAccess = subscribeAccess(revokeIfNeeded);
    if (disposed) detachAccess();
    check();
    const pending = ownIntent(await journal.read());
    check();
    detachCooking = cooking.subscribe((change) => {
      if (change.kind === 'adoption' && !disposed) publish(state.status, state.pending, true);
    });
    restore = cooking.connectRestore(() => acquireFor('restore'));
    if (getAccountSettings) {
      if (scope.ownerId === null) throw new ContentWorkspaceHostError('unavailable');
      account = await cooking.connectAccount({
        getLocalSettings: getAccountSettings,
        acquireExclusive: () => acquireFor('account'),
      });
      check();
    }
    publish(pending ? 'recovery_required' : 'ready', pending, true);
  } catch (error) {
    try {
      await close();
    } catch (failure) {
      throw new AggregateError([error, failure], 'Content host opening and cleanup failed');
    }
    throw error;
  }
  async function update<Result>(
    intent: Readonly<ContentUpdateIntent>,
    work: () => Promise<Result>,
  ) {
    idle();
    publish('updating', intent, true);
    try {
      check();
      // Save before dispatch. If acknowledgement is lost, keep the same operation identity.
      await journal.save(intent);
      check();
      const result = await work();
      check();
      // Keep the intent until the consumer explicitly acknowledges the verified result.
      // A synchronous view notification can revoke access; it must not erase recovery identity.
      publish('result_ready', intent, true);
      retryPhotoCleanup();
      check();
      return result;
    } catch (error) {
      if (!disposed) publish('recovery_required', intent, true);
      throw error;
    }
  }
  const content = Object.freeze({
    discover: guarded(cooking.content.discover),
    readCurrent: guarded(cooking.content.readCurrent),
    readExact: guarded(cooking.content.readExact),
    readPhoto: guarded(cooking.content.readPhoto),
    readPhotos: guarded(cooking.content.readPhotos),
  });
  const commands = Object.freeze({
    reviewDirect: guarded(cooking.commands.reviewDirect),
    prepareDirect: guarded(cooking.commands.prepareDirect),
    execute: guarded(cooking.commands.execute),
    readReceipt: guarded(cooking.commands.readReceipt),
    readDirectRecovery: guarded(cooking.commands.readDirectRecovery),
    acknowledgeDirectRecovery: guarded(cooking.commands.acknowledgeDirectRecovery),
  });
  const queries = Object.freeze({
    readPlan: guarded(cooking.queries.readPlan),
    readShopping: guarded(cooking.queries.readShopping),
    readFavourites: guarded(cooking.queries.readFavourites),
  });
  function personalSubscription(subscribe: typeof cooking.notes.subscribe) {
    return (listener: (change: PersonalChange) => void) => {
      ready();
      const captured = epoch;
      const forward = (change: PersonalChange) => {
        try {
          ready();
          if (captured === epoch) listener(change);
        } catch {
          /* Retired views cannot observe private changes in a replacement scope. */
        }
      };
      const stopLocal = subscribe(forward);
      let stopRestore: () => void;
      try {
        stopRestore = cooking.subscribe((change) => {
          if ((change.kind === 'restore' || change.kind === 'account') && change.personal)
            forward({
              revision: change.value.revision,
              notes: true,
              collections: true,
              manualShopping: true,
            });
        });
      } catch (error) {
        stopLocal();
        throw error;
      }
      return () => {
        stopLocal();
        stopRestore();
      };
    };
  }
  async function executeRestore(command: Parameters<typeof restore.service.execute>[0]) {
    idle();
    exclusiveExecution = { kind: 'restore', acquired: false };
    reserved = true;
    inFlight++;
    let result: Awaited<ReturnType<typeof restore.service.execute>>;
    try {
      result = await restore.service.execute(command);
    } finally {
      exclusiveExecution = null;
      reserved = false;
      inFlight--;
    }
    try {
      check();
      restore.flushCommitted();
      check();
      return result;
    } catch {
      // A synchronous refresh callback can retire the owner after a real commit.
      // Keep the original operation metadata, never return that retired private receipt.
      const error: ContractError = {
        code: 'stale_context',
        messageKey: 'restore.access_changed',
        retry: 'after_correction',
      };
      if (result.kind === 'receipt')
        return { kind: 'uncertain' as const, operationId: result.receipt.operationId, error };
      if (result.kind === 'uncertain') return { ...result, error };
      throw new ContentWorkspaceHostError('unavailable');
    }
  }
  async function applyAccount(
    ...args: Parameters<NonNullable<typeof account>['service']['apply']['apply']>
  ) {
    idle();
    if (!account) throw new ContentWorkspaceHostError('unavailable');
    exclusiveExecution = { kind: 'account', acquired: false };
    reserved = true;
    inFlight++;
    let result: Awaited<ReturnType<typeof account.service.apply.apply>>;
    try {
      result = await account.service.apply.apply(...args);
    } finally {
      exclusiveExecution = null;
      reserved = false;
      inFlight--;
    }
    // On retirement, callers retain their original journal identity for later recovery.
    // No private receipt from the retired owner may escape this host.
    check();
    account.flushCommitted();
    check();
    return result;
  }
  return Object.freeze({
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    content,
    commands,
    queries,
    backup: Object.freeze({
      capture: guarded(cooking.backup.capture),
      inspect: guarded(cooking.backup.inspect),
    }),
    restore: Object.freeze({
      review: guarded(restore.service.review),
      prepare: guarded(restore.service.prepare),
      execute: executeRestore,
      readReceipt: guarded(restore.service.readReceipt),
      readArchive: guarded(restore.service.readArchive),
    }),
    account: account
      ? Object.freeze({
          scope: account.service.scope,
          capture: guarded(account.service.capture),
          approval: Object.freeze({
            read: guarded(account.service.approval.read),
            review: guarded(account.service.approval.review),
            approve: guarded(account.service.approval.approve),
          }),
          journal: Object.freeze({
            read: guarded(account.service.journal.read),
            recover: guarded(account.service.journal.recover),
            stage: guarded(account.service.journal.stage),
            reviewPush: guarded(account.service.journal.reviewPush),
            stageReviewedPush: guarded(account.service.journal.stageReviewedPush),
            recordAcknowledgement: guarded(account.service.journal.recordAcknowledgement),
            discardRejected: guarded(account.service.journal.discardRejected),
          }),
          legacyTransition: Object.freeze({
            read: guarded(account.service.legacyTransition.read),
            review: guarded(account.service.legacyTransition.review),
            stage: guarded(account.service.legacyTransition.stage),
            recordAcknowledgement: guarded(account.service.legacyTransition.recordAcknowledgement),
            handoff: guarded(account.service.legacyTransition.handoff),
            recover: guarded(account.service.legacyTransition.recover),
          }),
          apply: Object.freeze({
            review: guarded(account.service.apply.review),
            apply: applyAccount,
            recover: guarded(account.service.apply.recover),
            inspectSettings: guarded(account.service.apply.inspectSettings),
            acknowledgeSettings: guarded(account.service.apply.acknowledgeSettings),
          }),
        })
      : null,
    sessions: Object.freeze({
      readSession: guarded(cooking.sessions.readSession),
      readResumeSession: guarded(cooking.sessions.readResumeSession),
      saveSession: guarded(cooking.sessions.saveSession),
      dismissSession: guarded(cooking.sessions.dismissSession),
      recover: guarded(cooking.sessions.recover),
    }),
    cooked: Object.freeze({
      saveCooked: guarded(cooking.cooked.saveCooked),
      prepareCookedRecovery: guarded(cooking.cooked.prepareCookedRecovery),
      readCookedRecovery: guarded(cooking.cooked.readCookedRecovery),
      resolveCookedRecovery: guarded(cooking.cooked.resolveCookedRecovery),
    }),
    subscribeCooking(listener: (change: CookingChange) => void) {
      ready();
      const captured = epoch;
      return cooking.subscribe((change) => {
        if (change.kind !== 'cooking' && change.kind !== 'restore' && change.kind !== 'account')
          return;
        try {
          ready();
          if (captured === epoch)
            listener(
              change.kind === 'cooking'
                ? change.value
                : {
                    recipeId: null,
                    historyChanged: change.cookingHistory,
                    revision: change.value.revision,
                  },
            );
        } catch {
          /* A retired reader cannot observe a later owner's cooking events. */
        }
      });
    },
    notes: Object.freeze({
      readState: guarded(cooking.notes.readState),
      readRecipeNote: guarded(cooking.notes.readRecipeNote),
      execute: guarded(cooking.notes.execute),
      readReceipt: guarded(cooking.notes.readReceipt),
      resolveOperation: guarded(cooking.notes.resolveOperation),
      subscribe: personalSubscription(cooking.notes.subscribe),
    }),
    manual: Object.freeze({
      readState: guarded(cooking.manual.readState),
      readManualShopping: guarded(cooking.manual.readManualShopping),
      execute: guarded(cooking.manual.execute),
      readReceipt: guarded(cooking.manual.readReceipt),
      resolveOperation: guarded(cooking.manual.resolveOperation),
      subscribe: personalSubscription(cooking.manual.subscribe),
    }),
    collections: Object.freeze({
      readCollections: guarded(cooking.collections.readCollections),
      readCollection: guarded(cooking.collections.readCollection),
      readRecipeMemberships: guarded(cooking.collections.readRecipeMemberships),
      execute: guarded(cooking.collections.execute),
      reviewDeleteCollection: guarded(cooking.collections.reviewDeleteCollection),
      deleteCollection: guarded(cooking.collections.deleteCollection),
      readReceipt: guarded(cooking.collections.readReceipt),
      resolveOperation: guarded(cooking.collections.resolveOperation),
      subscribe: personalSubscription(cooking.collections.subscribe),
    }),
    history: Object.freeze({ readHistory: guarded(cooking.history.readHistory) }),
    clearHistory: Object.freeze({
      reviewClearHistory: guarded(cooking.clearHistory.reviewClearHistory),
      clearHistory: guarded(cooking.clearHistory.clearHistory),
      readClearHistoryReceipt: guarded(cooking.clearHistory.readClearHistoryReceipt),
      resolveClearHistoryOperation: guarded(cooking.clearHistory.resolveClearHistoryOperation),
    }),
    readInstallationId: guarded(async () => {
      // Revalidate the persisted owner/installation before loading its recovery metadata.
      const context = await cooking.adoption.readReleaseContext();
      return {
        kind: 'ready' as const,
        revision: context.storeRevision,
        value: context.installationId,
      };
    }),
    readerStore: Object.freeze({ content, subscribe: cooking.subscribe }),
    onPhotoCleanupFailure,
    retryPhotoCleanup,
    close: () => close(),
    /** Expose a failed automatic close to the owner; no cleanup success is fabricated. */
    awaitClosed: () => closing ?? Promise.resolve(),
    delivery: Object.freeze({
      stage: guarded(delivery.stage),
      readStage: guarded(delivery.readStage),
      discardStage: guarded(delivery.discardStage),
      hydrate: guarded(delivery.hydrate),
      review: guarded(async (stageId: string) => {
        const before = await cooking.adoption.readReleaseContext();
        const hydrated = await delivery.hydrate();
        const review = await delivery.reviewStage(stageId, {
          expectedHead: hydrated.head,
          retainedRefs: before.retainedRefs,
        });
        if (!same(before, await cooking.adoption.readReleaseContext()))
          throw new ContentWorkspaceHostError('review_changed');
        reviews.set(review, canonicalContentJson(before));
        return review;
      }),
      async activate(review: Immutable<ContentReleaseReview>) {
        idle();
        const expected = reviews.get(review);
        if (!expected) throw new ContentWorkspaceHostError('review_changed');
        // Reserve the host while checking pins, so no private mutation slips between check and dispatch.
        reserved = true;
        try {
          const current = await cooking.adoption.readReleaseContext();
          check();
          if (state.status !== 'ready') throw new ContentWorkspaceHostError('unavailable');
          if (expected !== canonicalContentJson(current))
            throw new ContentWorkspaceHostError('review_changed');
        } finally {
          reserved = false;
        }
        const intent = ownIntent({
          version: 1,
          kind: 'activation',
          installationId: cooking.installationId,
          ownerId: scope.ownerId,
          operationId: newId(),
          fingerprint: review.packageFingerprint,
        })!;
        return update(intent, () => delivery.activate(review, intent.operationId));
      },
    }),
    adoption: Object.freeze({
      readMealChoices: guarded(cooking.adoption.readMealChoices),
      review: guarded(cooking.adoption.review),
      async adopt(review: Immutable<ContentAdoptionReview>) {
        const intent = ownIntent({
          version: 1,
          kind: 'adoption',
          installationId: review.installationId,
          ownerId: review.ownerId,
          operationId: review.operationId,
          fingerprint: review.requestFingerprint,
        })!;
        return update(intent, () => cooking.adoption.adopt(review));
      },
    }),
    async acknowledgeUpdate() {
      check();
      if (state.status !== 'result_ready' || !state.pending || inFlight)
        throw new ContentWorkspaceHostError('unavailable');
      const pending = state.pending;
      publish('updating', pending, true);
      try {
        check();
        await journal.clear(pending);
        check();
        publish('ready', null, true);
        check();
      } catch (error) {
        if (!disposed) publish('recovery_required', pending, true);
        throw error;
      }
    },
    async recoverUpdate() {
      check();
      if (state.status !== 'recovery_required' || !state.pending || inFlight)
        throw new ContentWorkspaceHostError('unavailable');
      const pending = state.pending;
      publish('updating', pending, true);
      try {
        check();
        const result =
          pending.kind === 'activation'
            ? await delivery.recoverActivation(pending.operationId, pending.fingerprint)
            : await cooking.adoption.recover({
                installationId: pending.installationId,
                ownerId: pending.ownerId,
                operationId: pending.operationId,
                requestFingerprint: pending.fingerprint,
              });
        check();
        if (result === null) {
          // Verified absence never means this operation succeeded.
          await journal.clear(pending);
          check();
          publish('ready', null, true);
        } else publish('result_ready', pending, true);
        check();
        return result;
      } catch (error) {
        if (!disposed) publish('recovery_required', pending, true);
        throw error;
      }
    },
  });
}

export type ContentWorkspaceHost = Awaited<ReturnType<typeof createContentWorkspaceHost>>;
