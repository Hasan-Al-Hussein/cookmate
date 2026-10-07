import type { CommandPlatform } from '@cookmate/domain';
import type { DateContext } from '@cookmate/contracts';
import type { AccountReplicationScope, AccountSnapshotOptions } from '@cookmate/account-sync';
import { isAppId, isRevision } from '../../data/conversationRecords';
import { openContentCookingStore } from '../../data/contentCookingStore';
import {
  openContentReleaseStore,
  type ContentReleaseStageInput,
  type ContentVerificationPorts,
} from '../../data/contentReleaseStore';
import type { SqlConnection } from '../../data/sql';
import {
  createContentWorkspaceHost,
  type ContentWorkspaceHost,
  type ContentUpdateJournal,
} from './contentWorkspaceHost';
import {
  ownPrivateContentConfiguration,
  privateContentDatabaseNames,
  privateContentAccountDatabaseName,
  type PrivateContentConfiguration,
} from './privateContentConfig';
import { createPrivateContentTransport } from './privateContentTransport';

export interface PrivateContentRuntime {
  /** Stable private-state partition; distinct from the host's per-opening access generation. */
  readonly storageScope: Readonly<{ installationId: string; ownerId: string | null }>;
  readonly host: ContentWorkspaceHost;
  fetchRelease(): Promise<ContentReleaseStageInput>;
  close(): Promise<void>;
}
export class PrivateContentCleanupError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, 'Private recipe resources could not be closed.');
    this.name = 'PrivateContentCleanupError';
  }
}
export interface PrivateContentRuntimeOptions {
  config: Readonly<PrivateContentConfiguration>;
  /** Exact reserved names only. Existing schema8 is mandatory; this code never migrates or seeds. */
  openConnection(name: string): Promise<SqlConnection>;
  verification(): Promise<ContentVerificationPorts>;
  journal: ContentUpdateJournal;
  platform: CommandPlatform;
  now(): string;
  dateContext(): DateContext;
  fetch(url: string, options: RequestInit): Promise<Response>;
  /** Trusted account lifecycle only: a prepared, reviewed and bound separate owner copy.
   * Default remains the existing guest installation. Never derive this from route parameters.
   */
  account?: {
    scope: Readonly<AccountReplicationScope>;
    currentScope(): AccountReplicationScope | null;
    subscribeAccess(listener: () => void): () => void;
    verifyPrepared(): Promise<void>;
    getLocalSettings(): AccountSnapshotOptions;
  };
  /** Retained local copy after sign-out, selected by the existing workspace lifecycle.
   * This grants local access only. No account services or authenticated scope are created.
   * Mutually exclusive with account; switching between them requires close and reopen.
   */
  localAccount?: {
    ownerId: string;
    workspaceGeneration: number;
    isCurrent(): boolean;
    subscribeAccess(listener: () => void): () => void;
    verifyPrepared(): Promise<void>;
  };
}

export async function openPrivateContentRuntime(
  options: PrivateContentRuntimeOptions,
): Promise<PrivateContentRuntime> {
  const config = ownPrivateContentConfiguration(options.config);
  if (options.account && options.localAccount)
    throw new Error('Choose authenticated or retained local account access, not both.');
  const account = options.account
    ? Object.freeze({
        scope: Object.freeze({ ...options.account.scope }),
        currentScope: options.account.currentScope,
        subscribeAccess: options.account.subscribeAccess,
        verifyPrepared: options.account.verifyPrepared,
        getLocalSettings: options.account.getLocalSettings,
      })
    : undefined;
  const localAccount = options.localAccount
    ? Object.freeze({
        ownerId: options.localAccount.ownerId,
        workspaceGeneration: options.localAccount.workspaceGeneration,
        isCurrent: options.localAccount.isCurrent,
        subscribeAccess: options.localAccount.subscribeAccess,
        verifyPrepared: options.localAccount.verifyPrepared,
      })
    : undefined;
  if (account && (!isAppId(account.scope.ownerId) || !isRevision(account.scope.authGeneration)))
    throw new Error('Invalid private account scope.');
  if (
    localAccount &&
    (!isAppId(localAccount.ownerId) || !isRevision(localAccount.workspaceGeneration))
  )
    throw new Error('Invalid retained local account selection.');
  const ownerId = account?.scope.ownerId ?? localAccount?.ownerId ?? null;
  const baseNames = privateContentDatabaseNames(config.installationId);
  const names =
    ownerId !== null
      ? {
          ...baseNames,
          cooking: privateContentAccountDatabaseName(config.installationId, ownerId),
        }
      : baseNames;
  const { openConnection, verification, now, dateContext, fetch } = options;
  const platform = Object.freeze({
    newId: options.platform.newId,
    sha256: options.platform.sha256,
  });
  const journal = Object.freeze({
    read: options.journal.read.bind(options.journal),
    save: options.journal.save.bind(options.journal),
    clear: options.journal.clear.bind(options.journal),
  });
  const connections = new Set<SqlConnection>();
  const rawConnections = new Set<SqlConnection>();
  let active = true;
  // ContentAdoptionAccess uses this generation as a local lifetime fence, including guest mode.
  // The local-selection generation is never passed to an account replication service.
  const access =
    account?.scope ??
    Object.freeze({
      ownerId,
      authGeneration: localAccount?.workspaceGeneration ?? 1,
    });
  const listeners = new Set<() => void>();
  let delivery: Awaited<ReturnType<typeof openContentReleaseStore>> | undefined;
  let cooking: Awaited<ReturnType<typeof openContentCookingStore>> | undefined;
  let host: ContentWorkspaceHost | undefined;
  let transport: ReturnType<typeof createPrivateContentTransport> | undefined;
  const getAccess = () => {
    if (!active) return null;
    if (localAccount && !localAccount.isCurrent()) return null;
    if (account) {
      const current = account.currentScope();
      if (
        !current ||
        current.ownerId !== account.scope.ownerId ||
        current.authGeneration !== account.scope.authGeneration
      )
        return null;
    }
    return access;
  };
  const check = () => {
    if (!getAccess()) throw new Error('Private recipe workspace is closed.');
  };
  async function open(name: string) {
    check();
    const connection = await openConnection(name);
    if (rawConnections.has(connection))
      throw new Error('Private recipe connections must be distinct.');
    rawConnections.add(connection);
    let closing: Promise<void> | undefined;
    const tracked: SqlConnection = {
      exec: connection.exec.bind(connection),
      all: connection.all.bind(connection),
      prepare: connection.prepare.bind(connection),
      close() {
        if (!closing)
          closing = Promise.resolve()
            .then(() => connection.close())
            .then(
              () => {
                connections.delete(tracked);
                rawConnections.delete(connection);
              },
              (error) => {
                closing = undefined;
                throw error;
              },
            );
        return closing;
      },
    };
    connections.add(tracked);
    check();
    return tracked;
  }
  async function cleanup() {
    const failures: unknown[] = [];
    // Store owners drain their transactions before connection cleanup is retried.
    for (const owner of host ? [host] : [cooking, delivery]) {
      try {
        await owner?.close();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const connection of [...connections]) {
      try {
        await connection.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (host && host.retryPhotoCleanup() !== 0)
      failures.push(new Error('Private recipe image cleanup remains pending.'));
    if (failures.length)
      throw new AggregateError(failures, 'Private recipe workspace cleanup failed.');
  }
  let closing: Promise<void> | undefined;
  function close() {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    active = false;
    transport?.close();
    for (const listener of listeners) listener();
    void cleanup().then(resolve, reject);
    return closing;
  }
  try {
    check();
    if (account) {
      await account.verifyPrepared();
      check();
    } else if (localAccount) {
      await localAccount.verifyPrepared();
      check();
    }
    const ports = await verification();
    check();
    // Verify the prepared store before initializing even the separate content cache.
    const admission = await open(names.cooking);
    const version = (await admission.all<{ user_version: number }>('PRAGMA user_version'))[0]
      ?.user_version;
    if (version !== 8)
      throw new Error('Prepare an independent schema8 review workspace before opening it.');
    const identity = await admission.all<{ value: string }>(
      "SELECT value FROM app_metadata WHERE key='installation_id' AND typeof(value)='text' AND length(CAST(value AS BLOB))=36",
    );
    if (identity[0]?.value !== config.installationId)
      throw new Error('Private recipe installation does not match configuration.');
    await admission.close();
    delivery = await openContentReleaseStore({
      ...ports,
      readConnection: await open(names.content),
      writeConnection: await open(names.content),
      now: () => new Date(now()),
    });
    cooking = await openContentCookingStore({
      schemaVersion: 8,
      installationId: config.installationId,
      openConnection: () => open(names.cooking),
      contentStore: delivery,
      platform,
      now,
      dateContext,
      getAccess,
      assertAccess: () => {
        check();
        return undefined;
      },
    });
    host = await createContentWorkspaceHost({
      cooking,
      delivery,
      journal,
      instanceId: platform.newId(),
      newId: platform.newId,
      getAccess,
      ...(account ? { account: { getLocalSettings: account.getLocalSettings } } : {}),
      subscribeAccess(listener) {
        const stop = account?.subscribeAccess(listener) ?? localAccount?.subscribeAccess(listener);
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          stop?.();
        };
      },
    });
    check();
    transport = createPrivateContentTransport({
      config,
      fetch,
      newId: platform.newId,
      verification: ports,
    });
    const ownedHost = host,
      ownedTransport = transport;
    return Object.freeze({
      storageScope: Object.freeze({
        installationId: config.installationId,
        ownerId: access.ownerId,
      }),
      host: ownedHost,
      async fetchRelease() {
        check();
        const result = await ownedTransport.fetchRelease();
        check();
        return result;
      },
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch (failure) {
      throw new PrivateContentCleanupError([error, failure]);
    }
    throw error;
  }
}

/** One opening per configured installation; a failed close remains a visible barrier. */
export function createPrivateContentOpener(open: () => Promise<PrivateContentRuntime>) {
  let previous: Promise<void> = Promise.resolve();
  return () => {
    let release!: () => void, fail!: (error: unknown) => void;
    const retired = new Promise<void>((done, failed) => {
      release = done;
      fail = failed;
    });
    const opening = previous.then(open);
    previous = opening.then(
      () => retired,
      (error) => {
        if (error instanceof PrivateContentCleanupError) throw error;
      },
    );
    void previous.catch(() => undefined);
    return opening.then((runtime) => {
      let closing: Promise<void> | undefined;
      return Object.freeze({
        storageScope: runtime.storageScope,
        host: runtime.host,
        fetchRelease: runtime.fetchRelease.bind(runtime),
        close() {
          if (!closing) {
            let resolve!: () => void, reject!: (error: unknown) => void;
            closing = new Promise<void>((done, failed) => {
              resolve = done;
              reject = failed;
            });
            const failed = (error: unknown) => {
              fail(error);
              reject(error);
            };
            try {
              void Promise.resolve(runtime.close()).then(() => {
                release();
                resolve();
              }, failed);
            } catch (error) {
              failed(error);
            }
          }
          return closing;
        },
      });
    });
  };
}
