import { canonicalContentJson, type OverlayHead } from '@cookmate/catalogue/content';
import type { ContractError } from '@cookmate/contracts';
import { portablePersonalLimits } from '@cookmate/domain';
import type {
  CommandPlatform,
  DeleteCollectionReview,
  Immutable,
  PersonalChange,
  PersonalCommand,
  PersonalMutationResult,
  PersonalReceipt,
  RepositoryResult,
} from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import { readAdoptionInSnapshot } from './cookingContentRepository';
import { isAppId, isRevision } from './conversationRecords';
import { createPersonalRepository } from './personalRepository';
import { readPersonalReceipt, readPersonalState } from './personalRecords';
import { readRestoreEpoch } from './restoreEpoch';
import type { SerializedReader, SerializedWriter, SqlSession, SqlValue } from './sql';

export interface ContentPersonalOptions {
  reader: SerializedReader;
  writer: SerializedWriter;
  installationId: string;
  platform: CommandPlatform;
  now(): string;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
  onCommitted(change: PersonalChange): void;
}
export interface PersonalRowsAdmission {
  admit(session: SqlSession): Promise<void>;
  /** Notes may reserve verified content before cooking SQL; manual data needs no reservation. */
  reserve?<Value>(
    head: OverlayHead | null,
    work: (guard: () => undefined) => Promise<Value>,
  ): Promise<Value>;
  release?(): void;
}
export type PreparePersonalRows = (session: SqlSession) => Promise<PersonalRowsAdmission>;
interface Policy {
  family: 'notes' | 'manual' | 'collections';
  commandKinds: readonly PersonalCommand['kind'][];
  receiptKinds?: readonly NonNullable<PersonalReceipt['commandKind']>[];
  recipeIds?: ReadonlySet<string>;
  beforeSaveNote?(session: SqlSession, recipeId: string): Promise<void>;
  beforeSetCollectionMembership?(session: SqlSession, recipeId: string): Promise<void>;
  beforeDeleteCollection?(review: Immutable<DeleteCollectionReview>): void;
  onClose?(): void;
}
interface Fence {
  adoptionRevision: number;
  head: OverlayHead | null;
  restoreEpoch: number;
}
interface Admission {
  fence: Fence;
  guard(): undefined;
  rows?: PersonalRowsAdmission;
  operationId?: string;
  onWrite?(): void;
}
const LIMITS = Object.freeze({
  operations: 20_000,
  operationBytes: 8 * 1024 * 1024,
  commandBytes: 32_768,
});
export const samePersonalFence = (a: unknown, b: unknown) =>
  canonicalContentJson(a, 4096) === canonicalContentJson(b, 4096);
class PersonalAdmissionFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}

/** Shared private8 scope and recovery boundary; it never owns or opens a physical store. */
export function createContentPersonalAdmission(options: ContentPersonalOptions, policy: Policy) {
  const { reader, writer, installationId, now, getAccess, assertAccess, onCommitted } = options;
  const { family, beforeSaveNote, beforeSetCollectionMembership, beforeDeleteCollection, onClose } =
    policy;
  const commandKinds = Object.freeze([...policy.commandKinds]);
  const receiptKinds = Object.freeze([...(policy.receiptKinds ?? commandKinds)]);
  const recipeIds = policy.recipeIds ?? new Set<string>();
  const hashPort = options.platform.sha256,
    newId = options.platform.newId;
  const readTransaction = reader.transaction.bind(reader),
    writeTransaction = writer.transaction.bind(writer);
  function reject(reason: string, code: ContractError['code'] = 'storage_failure'): never {
    throw new PersonalAdmissionFault({
      code,
      messageKey: `content.${family}_${reason}`,
      retry: 'after_correction',
    });
  }
  function stored(value: unknown): void {
    if (!value) reject('stored_invalid');
  }
  const failure = (error: unknown) => ({
    kind: 'failed' as const,
    error:
      error instanceof PersonalAdmissionFault
        ? error.detail
        : {
            code: 'storage_failure' as const,
            messageKey: `content.${family}_unavailable`,
            retry: 'after_correction' as const,
          },
  });
  const access = getAccess();
  if (
    !isAppId(installationId) ||
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !isRevision(access.authGeneration)
  )
    reject('access_changed', 'stale_context');
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  let closed = false,
    admission: Admission | undefined;
  // Each facade's one hidden engine owns a scoped admission; SQL still shares the host queue.
  let tail: Promise<unknown> = Promise.resolve();
  function check(): undefined {
    const current = getAccess();
    if (
      closed ||
      !current ||
      current.ownerId !== scope.ownerId ||
      current.authGeneration !== scope.authGeneration ||
      assertAccess(scope) !== undefined
    )
      reject('access_changed', 'stale_context');
    return undefined;
  }
  function guarded(raw: SqlSession, guard: () => undefined): SqlSession {
    return {
      async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
        guard();
        const rows = await raw.all<Row>(sql, values);
        guard();
        return rows;
      },
      async exec(sql) {
        guard();
        await raw.exec(sql);
        guard();
      },
      async prepare(sql) {
        guard();
        const statement = await raw.prepare(sql);
        try {
          guard();
        } catch (error) {
          await statement.finalize();
          throw error;
        }
        return {
          async run(values) {
            guard();
            await statement.run(values);
            guard();
          },
          async finalize() {
            await statement.finalize();
            guard();
          },
        };
      },
    };
  }
  async function fence(session: SqlSession): Promise<Fence> {
    stored(
      (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version === 8,
    );
    // Bound scalars in SQL before shared parsers can transfer corrupt TEXT/BLOB clocks.
    const [clocks] = await session.all<{
      personalRevision: number | null;
      personalEpoch: number | null;
      storeRevision: number | null;
      adoptionRevision: number | null;
      invalidRestore: number;
    }>(`SELECT
      (SELECT CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991 THEN revision END FROM personal_state WHERE singleton=1) personalRevision,
      (SELECT CASE WHEN typeof(epoch)='integer' AND epoch BETWEEN 0 AND 9007199254740991 THEN epoch END FROM personal_state WHERE singleton=1) personalEpoch,
      (SELECT CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991 THEN revision END FROM state_revision WHERE collection='store') storeRevision,
      (SELECT CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991 THEN revision END FROM app_content_adoption WHERE singleton=1) adoptionRevision,
      (SELECT COUNT(*) FROM portable_restore_operation WHERE typeof(committed_revision)<>'integer' OR committed_revision NOT BETWEEN 0 AND 9007199254740991) invalidRestore`);
    stored(
      clocks &&
        isRevision(clocks.personalRevision) &&
        isRevision(clocks.personalEpoch) &&
        isRevision(clocks.storeRevision) &&
        isRevision(clocks.adoptionRevision) &&
        clocks.invalidRestore === 0,
    );
    const [row] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (row?.id !== installationId || (await readBinding(session)) !== scope.ownerId)
      reject('access_changed', 'stale_context');
    const adoption = await readAdoptionInSnapshot(session);
    return {
      adoptionRevision: adoption.revision,
      head: adoption.head,
      restoreEpoch: await readRestoreEpoch(session),
    };
  }
  async function admitOperation(session: SqlSession, id: string) {
    const [usage] = await session.all<{
      count: number;
      bytes: number;
      invalid: number;
    }>(`SELECT COUNT(*) count,
      COALESCE(SUM(length(CAST(operation_id AS BLOB))+COALESCE(length(CAST(request_fingerprint AS BLOB)),0)+length(CAST(receipt_json AS BLOB))),0) bytes,
      COALESCE(SUM(CASE WHEN typeof(operation_id)<>'text' OR length(CAST(operation_id AS BLOB))<>36
      OR (request_fingerprint IS NOT NULL AND (typeof(request_fingerprint)<>'text' OR length(CAST(request_fingerprint AS BLOB))<>64))
      OR typeof(receipt_json)<>'text' OR length(CAST(receipt_json AS BLOB))>4096 THEN 1 ELSE 0 END),0) invalid FROM personal_operation`);
    stored(
      usage &&
        isRevision(usage.count) &&
        usage.count <= LIMITS.operations &&
        isRevision(usage.bytes) &&
        usage.bytes <= LIMITS.operationBytes &&
        usage.invalid === 0,
    );
    const row = await readPersonalReceipt(session, id);
    if (!row) return;
    const receipt = row.receipt;
    if (receipt.commandKind !== null && !receiptKinds.some((kind) => kind === receipt.commandKind))
      reject('operation_conflict', 'operation_conflict');
    const state = await readPersonalState(session, 8);
    stored(
      receipt.epoch <= state.epoch &&
        receipt.revision <= state.revision &&
        (receipt.commandKind === 'deleteCollection'
          ? receipt.outcome === 'committed' &&
            receipt.affectedMemberships <= portablePersonalLimits.memberships
          : receipt.commandKind === 'setCollectionMembership'
            ? receipt.affectedMemberships === (receipt.outcome === 'committed' ? 1 : 0)
            : receipt.affectedMemberships === 0) &&
        (receipt.outcome === 'cancelled' || receipt.revision > 0),
    );
  }
  async function enter(raw: SqlSession, owned: Admission) {
    owned.guard();
    const session = guarded(raw, owned.guard);
    if (!samePersonalFence(await fence(session), owned.fence))
      reject('workspace_changed', 'stale_context');
    if (owned.operationId) await admitOperation(session, owned.operationId);
    await owned.rows?.admit(session);
    return session;
  }
  function current() {
    check();
    if (!admission) reject('admission_required');
    admission.guard();
    return admission;
  }
  const engine = createPersonalRepository({
    reader: {
      async transaction(work) {
        const owned = current();
        const result = await readTransaction(
          async (raw) => {
            const session = await enter(raw, owned),
              value = await work(session);
            if (!samePersonalFence(await fence(session), owned.fence))
              reject('workspace_changed', 'stale_context');
            return value;
          },
          { kind: 'read_only' },
          owned.guard,
        );
        owned.guard();
        return result;
      },
    },
    writer: {
      requiresRecovery: writer.requiresRecovery.bind(writer),
      async transaction(work, impact) {
        const owned = current();
        owned.onWrite?.();
        const result = await writeTransaction(
          async (raw) => {
            const session = await enter(raw, owned),
              value = await work(session);
            if (!samePersonalFence(await fence(session), owned.fence))
              reject('workspace_changed', 'stale_context');
            if (owned.operationId) await admitOperation(session, owned.operationId);
            await owned.rows?.admit(session);
            return value;
          },
          impact,
          owned.guard,
        );
        owned.guard();
        return result;
      },
    },
    platform: {
      newId,
      async sha256(text) {
        const owned = current();
        const hash = await hashPort(text);
        owned.guard();
        return hash;
      },
    },
    recipeIds,
    now,
    onCommitted(change) {
      check();
      onCommitted(change);
    },
    privatePersonal: {
      schemaVersion: 8,
      commandKinds,
      ...(beforeSaveNote ? { beforeSaveNote } : {}),
      ...(beforeSetCollectionMembership ? { beforeSetCollectionMembership } : {}),
      ...(beforeDeleteCollection ? { beforeDeleteCollection } : {}),
    },
  });
  function run<Value>(
    operationId: string | undefined,
    work: () => Promise<Value>,
    prepare?: PreparePersonalRows,
    onWrite?: () => void,
  ): Promise<Value> {
    const result = tail
      .then(async () => {
        check();
        let rows: PersonalRowsAdmission | undefined;
        try {
          const before = await readTransaction(
            async (raw) => {
              const session = guarded(raw, check),
                value = await fence(session);
              if (operationId) await admitOperation(session, operationId);
              rows = await prepare?.(session);
              return value;
            },
            { kind: 'read_only' },
            check,
          );
          check();
          async function apply(guard: () => undefined) {
            admission = {
              fence: before,
              guard,
              ...(rows ? { rows } : {}),
              ...(operationId ? { operationId } : {}),
              ...(onWrite ? { onWrite } : {}),
            };
            try {
              guard();
              const value = await work();
              guard();
              return value;
            } finally {
              admission = undefined;
            }
          }
          return await (rows?.reserve ? rows.reserve(before.head, apply) : apply(check));
        } finally {
          rows?.release?.();
        }
      })
      .then((value) => {
        check();
        return value;
      });
    tail = result.catch(() => undefined);
    return result;
  }
  async function read<Value>(
    work: () => Promise<RepositoryResult<Value>>,
    prepare?: PreparePersonalRows,
    id?: string,
  ): Promise<RepositoryResult<Value>> {
    try {
      return await run(id, work, prepare);
    } catch (error) {
      return failure(error);
    }
  }
  async function mutate(
    id: string,
    work: () => Promise<PersonalMutationResult>,
    prepare?: PreparePersonalRows,
  ): Promise<PersonalMutationResult> {
    let dispatched = false;
    try {
      if (!isAppId(id)) reject('invalid_operation', 'invalid_input');
      return await run(id, work, prepare, () => {
        dispatched = true;
      });
    } catch (error) {
      if (dispatched) return { kind: 'uncertain', operationId: id, error: failure(error).error };
      return failure(error);
    }
  }
  function ownCommand<Command extends PersonalCommand>(input: Immutable<Command>): Command {
    const command = JSON.parse(canonicalContentJson(input, LIMITS.commandBytes)) as Command;
    if (!command || !commandKinds.includes(command.kind) || !isAppId(command.operationId))
      reject('invalid_command', 'invalid_input');
    return command;
  }
  const service = Object.freeze({
    readState: () => read(engine.readState),
    readReceipt(id: string) {
      if (!isAppId(id))
        return Promise.resolve(
          failure(
            new PersonalAdmissionFault({
              code: 'invalid_input',
              messageKey: `content.${family}_invalid_operation`,
              retry: 'after_correction',
            }),
          ),
        );
      return read(() => engine.readReceipt(id), undefined, id);
    },
    resolveOperation: (id: string) => mutate(id, () => engine.resolveOperation(id)),
    subscribe(listener: (change: PersonalChange) => void) {
      check();
      return engine.subscribe((change) => {
        check();
        listener(change);
      });
    },
    close() {
      closed = true;
      onClose?.();
      engine.close();
    },
  });
  return {
    engine,
    service,
    read,
    mutate,
    ownCommand,
    check,
    stored,
    reject,
    failure,
    currentFence: () => canonicalContentJson(current().fence, 4096),
  };
}
