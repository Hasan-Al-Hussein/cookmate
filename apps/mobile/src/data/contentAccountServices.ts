import type { AccountReplicationScope, AccountSnapshotOptions } from '@cookmate/account-sync';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { createAccountContentApplyService } from './accountContentApply';
import { captureAccountContentLocal } from './accountContentCapture';
import { createAccountContentJournalRepository } from './accountContentJournal';
import { createAccountContentScopeApprovalService } from './accountContentScopeApproval';
import { createAccountLegacyTransitionRepository } from './accountLegacyTransitionRepository';
import { exact, fail, readBinding, revision, uuid } from './accountReplicationRecords';
import type { SerializedReader, SerializedWriter, SqlSession, SqlValue } from './sql';

type ApplyOptions = Parameters<typeof createAccountContentApplyService>[0];
export interface ContentAccountBootstrapOptions {
  reader: Pick<SerializedReader, 'transaction'>;
  writer: Pick<SerializedWriter, 'transaction' | 'requiresRecovery'>;
  installationId: string;
  catalogue: Readonly<CatalogueIdentity>;
  /** Authenticated account selected by the lifecycle owner, not a persisted binding claim. */
  scope: Readonly<AccountReplicationScope>;
  currentScope(): AccountReplicationScope | null;
  getLocalSettings(): AccountSnapshotOptions;
  now(): string;
  newId(): string;
  sha256(text: string): Promise<string>;
}
export interface ContentAccountServicesOptions extends ContentAccountBootstrapOptions {
  contentStore: ApplyOptions['contentStore'];
  acquireExclusive: ApplyOptions['acquireExclusive'];
  onCommitted: ApplyOptions['onCommitted'];
}

function port<Service extends { close(): void }>(service: Service) {
  const { close: _close, ...methods } = service;
  return Object.freeze(methods);
}

/** Borrowed transactions share the host queue; only journal staging may initially bind a clone. */
async function createAccountGuard(options: ContentAccountBootstrapOptions, bootstrap: boolean) {
  const { installationId, currentScope, getLocalSettings, now, newId, sha256 } = options;
  if (
    !uuid(installationId) ||
    !exact(options.scope, ['ownerId', 'authGeneration']) ||
    !uuid(options.scope.ownerId) ||
    !revision(options.scope.authGeneration)
  )
    fail('invalid_input');
  const scope = Object.freeze({ ...options.scope });
  const catalogue = Object.freeze({ ...options.catalogue });
  const readTransaction = options.reader.transaction.bind(options.reader),
    writeTransaction = options.writer.transaction.bind(options.writer),
    requiresRecovery = options.writer.requiresRecovery.bind(options.writer);
  let closed = false;
  function check(): undefined {
    const current = currentScope();
    if (
      closed ||
      !current ||
      current.ownerId !== scope.ownerId ||
      current.authGeneration !== scope.authGeneration
    )
      fail('account_changed');
    return undefined;
  }
  function guarded(raw: SqlSession): SqlSession {
    return {
      async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
        check();
        const result = await raw.all<Row>(sql, values);
        check();
        return result;
      },
      async exec(sql) {
        check();
        await raw.exec(sql);
        check();
      },
      async prepare(sql) {
        check();
        const statement = await raw.prepare(sql);
        try {
          check();
        } catch (error) {
          await statement.finalize();
          throw error;
        }
        return {
          async run(values) {
            check();
            await statement.run(values);
            check();
          },
          // Finalization remains available after retirement; it conveys no saved result.
          finalize: () => statement.finalize(),
        };
      },
    };
  }
  async function admit(session: SqlSession) {
    const [schema] = await session.all<{ user_version: number }>('PRAGMA user_version');
    if (schema?.user_version !== 8) fail('stored_data_invalid');
    const [installation] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (installation?.id !== installationId) fail('different_data_owner');
    const binding = await readBinding(session);
    if (binding !== scope.ownerId && !(bootstrap && binding === null)) fail('different_data_owner');
    return binding;
  }
  function transaction(
    run: SerializedReader['transaction'],
    allowInitialBinding = false,
  ): SerializedReader['transaction'] {
    return async (work, impact, assertCommitAdmission) => {
      check();
      const result = await run(
        async (raw) => {
          const session = guarded(raw);
          const before = await admit(session);
          const value = await work(session);
          check();
          const after = await admit(session);
          if (
            after !== before &&
            !(allowInitialBinding && before === null && after === scope.ownerId)
          )
            fail('different_data_owner');
          return value;
        },
        impact,
        () => {
          check();
          assertCommitAdmission?.();
          return check();
        },
      );
      check();
      return result;
    };
  }
  const reader = Object.freeze({ transaction: transaction(readTransaction) });
  const writer = Object.freeze({
    transaction: transaction(writeTransaction),
    requiresRecovery() {
      check();
      return requiresRecovery();
    },
  });
  const stagingWriter = Object.freeze({
    ...writer,
    transaction: transaction(writeTransaction, bootstrap),
  });
  await reader.transaction(
    async (session) => {
      if (bootstrap && (await readBinding(session)) !== null) fail('different_data_owner');
    },
    { kind: 'read_only' },
  );
  const common = {
    reader,
    writer,
    installationId,
    catalogue,
    currentScope() {
      check();
      return scope;
    },
    getLocalSettings() {
      check();
      const settings = getLocalSettings();
      check();
      return settings;
    },
    now,
    newId,
    async sha256(text: string) {
      check();
      const result = await sha256(text);
      check();
      return result;
    },
  };
  return {
    common,
    stagingWriter,
    scope,
    check,
    capture: () =>
      reader.transaction((session) => captureAccountContentLocal(session, scope, common), {
        kind: 'read_only',
      }),
    close() {
      closed = true;
    },
  };
}

/** Existing scope3 services for an already bound private8 owner; no transport or activation. */
export async function createContentAccountServices(options: ContentAccountServicesOptions) {
  const { acquireExclusive, onCommitted } = options;
  const contentStore = Object.freeze({
    withVerifiedReferenceInspection: options.contentStore.withVerifiedReferenceInspection,
  });
  const guard = await createAccountGuard(options, false);
  const { common, scope, check } = guard;
  const approval = createAccountContentScopeApprovalService(common);
  const journal = createAccountContentJournalRepository(common);
  const legacyTransition = createAccountLegacyTransitionRepository(common);
  const apply = createAccountContentApplyService({
    ...common,
    contentStore,
    acquireExclusive() {
      check();
      const release = acquireExclusive();
      try {
        check();
        return release;
      } catch (error) {
        release?.();
        throw error;
      }
    },
    onCommitted(change, expanded) {
      check();
      onCommitted(change, expanded);
      check();
    },
  });
  return Object.freeze({
    scope,
    approval: port(approval),
    journal: port(journal),
    legacyTransition: port(legacyTransition),
    apply: port(apply),
    capture: guard.capture,
    close() {
      guard.close();
      approval.close();
      journal.close();
      legacyTransition.close();
      apply.close();
    },
  });
}

export type ContentAccountServices = Awaited<ReturnType<typeof createContentAccountServices>>;

/**
 * First-account review on a private8 clone whose lifecycle marker the caller already verified.
 * Construction requires no persisted binding. This never prepares a workspace or writes a
 * binding itself: existing reviewed journal staging commits binding, archive and pending request
 * together. After staging it permits same-owner recovery; a bound reopen uses the ordinary facade.
 */
export async function createContentAccountBootstrap(options: ContentAccountBootstrapOptions) {
  const guard = await createAccountGuard(options, true);
  const approval = createAccountContentScopeApprovalService(guard.common);
  const journal = createAccountContentJournalRepository({
    ...guard.common,
    writer: guard.stagingWriter,
  });
  return Object.freeze({
    scope: guard.scope,
    approval: port(approval),
    capture: guard.capture,
    journal: port(journal),
    close() {
      guard.close();
      approval.close();
      journal.close();
    },
  });
}

export type ContentAccountBootstrap = Awaited<ReturnType<typeof createContentAccountBootstrap>>;
