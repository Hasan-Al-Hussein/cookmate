import { catalogueMatches, isUtcInstant } from '@cookmate/contracts';
import type { CatalogueIdentity, ContractError } from '@cookmate/contracts';
import {
  buildShoppingProjection,
  createPortableBackup,
  normalizePortableRestoreSource,
  PORTABLE_RESTORE_ARCHIVE_LIMIT,
  portableRestoreWarnings,
  reconcilePortableRestorePurchases,
  summarizePortableBackupReferences,
  validatePortableBackup,
  validatePortableBackupCounts,
} from '@cookmate/domain';
import type {
  CommandPlatform,
  Immutable,
  PortableBackupEnvelope,
  PortableRestoreBlocker,
  PortableRestoreReceipt,
  PortableRestoreReview,
  PortableRestoreService,
  RepositoryResult,
  ShoppingProjectionOptions,
  StoreChange,
} from '@cookmate/domain';
import { isAppId } from './conversationRecords';
import { readBackupData } from './portableBackup';
import { withdrawPreferenceVersions } from './preferenceProvenance';
import { freezeResult, readRevision } from './query';
import {
  nextStoredRevision,
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from './shoppingRepository';
import { encodeStoredText } from './storedText';
import { runBound, StorageFault } from './sql';
import type { SerializedReader, SerializedWriter, SqlSession } from './sql';
import {
  checkPortablePersonalRestore,
  portableHistoryMatchesCatalogue,
  portableHistoryHasKnownRemovals,
  replaceExpandedBackupData,
} from './portableRestoreExpanded';

interface Options extends ShoppingProjectionOptions {
  reader: SerializedReader;
  writer: SerializedWriter;
  catalogue: Readonly<CatalogueIdentity>;
  knownRecipeIds: ReadonlySet<string>;
  platform: CommandPlatform;
  now(): string;
  /** Synchronous facade lease excludes pending and newly admitted operations until released. */
  acquireExclusive(): (() => void) | null;
  onCommitted(change: StoreChange, expanded?: { personal: boolean; cookingHistory: boolean }): void;
}
class RestoreFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function fault(key: string, code: ContractError['code'] = 'stale_context'): never {
  throw new RestoreFault({ code, messageKey: `restore.${key}`, retry: 'after_correction' });
}
const errorDetail = (error: unknown): ContractError =>
  error instanceof RestoreFault
    ? error.detail
    : {
        code: 'storage_failure',
        messageKey: 'restore.storage_failure',
        retry: 'after_correction',
      };
const failed = (error: unknown) => ({ kind: 'failed' as const, error: errorDetail(error) });
const safeRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function requireActivated(session: SqlSession, catalogue: Readonly<CatalogueIdentity>) {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== 3 && version !== 4 && version !== 5 && version !== 6)
    fault('not_activated', 'incompatible_version');
  const manifest = (
    await session.all<CatalogueIdentity>(
      'SELECT catalogue_version AS version, fingerprint FROM catalogue_manifest WHERE singleton=1',
    )
  )[0];
  if (!manifest || !catalogueMatches(manifest, catalogue))
    fault('catalogue_changed', 'incompatible_version');
}
export async function authorityBlockers(session: SqlSession): Promise<PortableRestoreBlocker[]> {
  const active = await session.all(
    `SELECT 1 FROM pending_intent WHERE phase NOT IN ('settled','cancelled') LIMIT 1`,
  );
  const awaiting = await session.all(
    `SELECT 1 FROM assistant_intent_context WHERE lifecycle='awaiting_response' LIMIT 1`,
  );
  // A settled slot without its proof is corruption, not an opportunity to replace its effects.
  const missing =
    await session.all(`SELECT 1 FROM command_slot s JOIN pending_intent p ON p.user_intent_id=s.user_intent_id
    LEFT JOIN operation_receipt r ON r.operation_id=s.operation_id WHERE p.phase='settled' AND r.operation_id IS NULL LIMIT 1`);
  if (missing.length) fault('recovery_required', 'storage_failure');
  const archives = (
    await session.all<{ count: number }>('SELECT COUNT(*) AS count FROM portable_restore_operation')
  )[0]!.count;
  return [
    ...(active.length || awaiting.length ? ['active_actions' as const] : []),
    ...(archives >= PORTABLE_RESTORE_ARCHIVE_LIMIT ? ['archive_full' as const] : []),
  ];
}
async function snapshot(
  session: SqlSession,
  options: Options,
  source?: Immutable<PortableBackupEnvelope>,
) {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== 3 && version !== 4 && version !== 5 && version !== 6)
    fault('not_activated', 'incompatible_version');
  return createPortableBackup(
    {
      schemaVersion: source?.schemaVersion ?? 1,
      databaseSchemaVersion: version,
      createdAt: options.now(),
      catalogue: { ...options.catalogue },
      sourceRevision: await readRevision(session, 'store'),
      data: await readBackupData(
        session,
        source?.schemaVersion === 2,
        !!source?.data.cookingHistory,
      ),
    },
    options.sha256,
  );
}
export interface PortableRestoreReceiptRow {
  importFingerprint: string;
  expectedRevision: number;
  committedRevision: number;
  receiptJson: string;
}
export async function readPortableRestoreReceiptRow(
  session: SqlSession,
  id: string,
): Promise<PortableRestoreReceiptRow | null> {
  if (!isAppId(id)) fault('invalid_operation', 'invalid_input');
  const row = (
    await session.all<PortableRestoreReceiptRow>(
      `SELECT CASE WHEN typeof(import_fingerprint)='text' AND length(CAST(import_fingerprint AS BLOB))=64 THEN import_fingerprint END AS importFingerprint,
    CASE WHEN typeof(reviewed_revision)='integer' THEN reviewed_revision END AS expectedRevision,
    CASE WHEN typeof(committed_revision)='integer' THEN committed_revision END AS committedRevision,
    CASE WHEN typeof(receipt_json)='text' AND length(CAST(receipt_json AS BLOB))<=32768 THEN receipt_json END AS receiptJson FROM portable_restore_operation WHERE operation_id=?`,
      [id],
    )
  )[0];
  if (!row) return null;
  if (
    !digest(row.importFingerprint) ||
    !safeRevision(row.expectedRevision) ||
    !safeRevision(row.committedRevision) ||
    typeof row.receiptJson !== 'string'
  )
    throw new StorageFault('storage_failure', 'Restore receipt row is invalid');
  return row;
}
export async function parsePortableRestoreReceiptRow(
  session: SqlSession,
  id: string,
  row: PortableRestoreReceiptRow,
): Promise<Immutable<PortableRestoreReceipt>> {
  const value = JSON.parse(row.receiptJson) as PortableRestoreReceipt;
  if (
    !value ||
    Object.keys(value).length !== (Object.hasOwn(value, 'replacedScopes') ? 11 : 10) ||
    value.kind !== 'portable_restore' ||
    value.operationId !== id ||
    value.importFingerprint !== row.importFingerprint ||
    value.expectedRevision !== row.expectedRevision ||
    value.revision !== row.committedRevision ||
    !safeRevision(value.expectedRevision) ||
    !safeRevision(value.revision) ||
    value.revision <= value.expectedRevision ||
    !digest(value.importFingerprint) ||
    !digest(value.beforeFingerprint) ||
    !isUtcInstant(value.committedAt) ||
    !safeRevision(value.importedPreferenceRemovals) ||
    !validatePortableBackupCounts(value.restoredCounts) ||
    (Object.hasOwn(value, 'replacedScopes') &&
      (JSON.stringify(value.replacedScopes) !==
        JSON.stringify(
          value.restoredCounts.cookingHistory === undefined
            ? ['core', 'personal']
            : ['core', 'personal', 'cookingHistory'],
        ) ||
        !value.restoredCounts.personal)) ||
    (!Object.hasOwn(value, 'replacedScopes') && !!value.restoredCounts.personal) ||
    !value.shopping ||
    Object.keys(value.shopping).length !== 2 ||
    !safeRevision(value.shopping.restoredChecks) ||
    !safeRevision(value.shopping.uncheckedImportedChecks) ||
    value.revision > (await readRevision(session, 'store'))
  )
    throw new StorageFault('storage_failure', 'Restore receipt is invalid');
  return freezeResult(value);
}
async function receiptInSnapshot(
  session: SqlSession,
  id: string,
): Promise<Immutable<PortableRestoreReceipt> | null> {
  const row = await readPortableRestoreReceiptRow(session, id);
  return row ? parsePortableRestoreReceiptRow(session, id, row) : null;
}

async function nextWorkspaceRevision(
  session: SqlSession,
  source: Immutable<PortableBackupEnvelope>,
): Promise<number> {
  const rows = await session.all<{
    value: number | null;
  }>(`SELECT MAX(revision) AS value FROM state_revision
    UNION ALL SELECT MAX(revision) FROM favourite UNION ALL SELECT MAX(revision) FROM plan_occurrence
    UNION ALL SELECT MAX(revision) FROM purchase_state UNION ALL SELECT MAX(revision) FROM saved_preference
    UNION ALL SELECT MAX(revision) FROM shopping_scope UNION ALL SELECT MAX(projection_revision) FROM shopping_scope
    UNION ALL SELECT MAX(saved_revision) FROM source_preference_link UNION ALL SELECT MAX(removed_revision) FROM source_preference_link
    UNION ALL SELECT MAX(last_removal_revision) FROM preference_state`);
  if (rows.some((row) => row.value !== null && !safeRevision(row.value)))
    fault('invalid_revision', 'storage_failure');
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version === 4 || version === 5 || version === 6)
    rows.push(
      ...(await session.all<{ value: number | null }>(
        'SELECT MAX(session_revision,history_revision) AS value FROM cooking_state',
      )),
    );
  if (version === 5 || version === 6)
    rows.push(
      ...(await session.all<{ value: number | null }>(
        'SELECT revision AS value FROM personal_state UNION ALL SELECT MAX(revision) FROM recipe_note UNION ALL SELECT MAX(revision) FROM personal_collection UNION ALL SELECT MAX(revision) FROM personal_collection_member UNION ALL SELECT MAX(revision) FROM manual_shopping_item',
      )),
    );
  const imported = source.data.personal;
  const importedRevisions = [
    source.sourceRevision,
    ...source.data.favourites.map((v) => v.revision),
    ...source.data.occurrences.map((v) => v.revision),
    ...(imported
      ? [
          ...imported.notes,
          ...imported.collections,
          ...imported.memberships,
          ...imported.manualItems,
        ].map((v) => v.revision)
      : []),
    ...(source.data.cookingHistory?.entries.map((v) => v.revision) ?? []),
  ];
  if (rows.some((row) => row.value !== null && !safeRevision(row.value)))
    fault('invalid_revision', 'storage_failure');
  return nextStoredRevision(
    [...rows.map((row) => row.value ?? 0), ...importedRevisions].reduce(
      (maximum, value) => Math.max(maximum, value),
      0,
    ),
  );
}

async function replaceCookingData(
  session: SqlSession,
  source: Immutable<PortableBackupEnvelope>,
  before: Immutable<PortableBackupEnvelope>,
  options: Options,
) {
  const data = normalizePortableRestoreSource(source).data;
  const revision = await nextWorkspaceRevision(session, source);
  const ledger = await readShoppingLedgerInSnapshot(session, options);
  const scopeId = ledger.snapshot.scope.scopeId;
  // Remove dependent rows before plan identities; keep old group identities for purchase fencing.
  await runBound(session, 'DELETE FROM shopping_contribution WHERE scope_id=?', [scopeId]);
  await runBound(session, 'DELETE FROM shopping_selection WHERE scope_id=?', [scopeId]);
  await session.exec('DELETE FROM plan_occurrence');
  for (const item of data.occurrences)
    await runBound(session, 'INSERT INTO plan_occurrence VALUES (?, ?, ?, ?, ?, ?, ?)', [
      item.occurrenceId,
      item.recipeId,
      item.placement.actualDate,
      item.placement.mealKey,
      revision,
      item.createdAt,
      item.updatedAt,
    ]);
  for (const id of data.shopping.scope.occurrenceIds)
    await runBound(session, 'INSERT INTO shopping_selection VALUES (?, ?)', [scopeId, id]);
  await runBound(session, 'UPDATE shopping_scope SET revision=? WHERE scope_id=?', [
    revision,
    scopeId,
  ]);
  await rebuildShoppingInSnapshot(session, ledger, options);
  const selected = new Set(data.shopping.scope.occurrenceIds);
  const projection = await buildShoppingProjection(
    data.occurrences.filter((item) => selected.has(item.occurrenceId)),
    options,
  );
  const purchases = reconcilePortableRestorePurchases(source, projection);
  const rebuiltRevision = ledger.snapshot.projectionRevision + 1;
  await runBound(
    session,
    'UPDATE shopping_group SET projection_revision=? WHERE scope_id=? AND projection_revision=?',
    [revision, scopeId, rebuiltRevision],
  );
  await runBound(session, 'UPDATE shopping_scope SET projection_revision=? WHERE scope_id=?', [
    revision,
    scopeId,
  ]);
  await runBound(
    session,
    'UPDATE purchase_state SET purchased=0, changed=1, revision=? WHERE scope_id=?',
    [revision, scopeId],
  );
  for (const state of purchases.states)
    await runBound(
      session,
      'UPDATE purchase_state SET purchased=?, changed=? WHERE scope_id=? AND group_key=?',
      [state.purchased ? 1 : 0, state.changed ? 1 : 0, scopeId, state.groupKey],
    );
  await session.exec('DELETE FROM favourite');
  for (const item of data.favourites)
    await runBound(session, 'INSERT INTO favourite VALUES (?, ?, ?, ?, ?)', [
      item.recipeId,
      item.saved ? 1 : 0,
      revision,
      item.savedAt,
      item.updatedAt,
    ]);
  const conversationChanged = await withdrawPreferenceVersions(
    session,
    before.data.preferences.snapshot.items,
    revision,
  );
  await session.exec('DELETE FROM saved_preference');
  for (const item of data.preferences.snapshot.items)
    await runBound(session, 'INSERT INTO saved_preference VALUES (?, ?, ?, ?)', [
      item.preferenceId,
      item.type,
      encodeStoredText(item.value),
      revision,
    ]);
  const collections: StoreChange['collections'][number][] = [
    'favourites',
    'plan',
    'shopping',
    'preferences',
  ];
  if (conversationChanged) collections.push('conversation');
  for (const collection of ['store', ...collections])
    await runBound(session, 'UPDATE state_revision SET revision=? WHERE collection=?', [
      revision,
      collection,
    ]);
  await readShoppingLedgerInSnapshot(session, options);
  if ((await session.all('PRAGMA foreign_key_check')).length)
    fault('invalid_relationships', 'storage_failure');
  return { revision, collections, shopping: purchases.summary };
}

/** Restores are local replacement transactions, never executable backup commands. */
export function createPortableRestoreService(options: Options): PortableRestoreService {
  interface Source {
    serialized: string;
    envelope: Immutable<PortableBackupEnvelope>;
  }
  const reviews = new WeakMap<object, Source>();
  const prepared = new WeakMap<object, Source>();
  const validationOptions = {
    sha256: options.sha256,
    currentCatalogue: options.catalogue,
    knownRecipeIds: options.knownRecipeIds,
  };
  const read = async <Value>(
    operation: (session: SqlSession) => Promise<Value>,
  ): Promise<RepositoryResult<Value>> => {
    try {
      return await options.reader.transaction(async (session) => {
        await requireActivated(session, options.catalogue);
        return {
          kind: 'ready',
          value: freezeResult(await operation(session)),
          revision: await readRevision(session, 'store'),
        };
      });
    } catch (error) {
      return failed(error);
    }
  };
  return Object.freeze<PortableRestoreService>({
    review: async (serialized) => {
      if (typeof serialized !== 'string')
        return failed(
          new RestoreFault({
            code: 'invalid_input',
            messageKey: 'restore.invalid_file',
            retry: 'after_correction',
          }),
        );
      const validation = await validatePortableBackup(serialized, validationOptions);
      if (validation.kind !== 'ready')
        return failed(
          new RestoreFault({
            code: validation.reason === 'too_large' ? 'too_large' : 'invalid_input',
            messageKey: `restore.${validation.reason}`,
            retry: 'after_correction',
          }),
        );
      return read(async (session) => {
        if (options.writer.requiresRecovery()) fault('recovery_required', 'storage_failure');
        const physical = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
          ?.user_version;
        const expandedUnavailable =
          validation.value.schemaVersion === 2 && physical !== 5 && physical !== 6;
        const before = await snapshot(
          session,
          options,
          expandedUnavailable ? undefined : validation.value,
        );
        const blockers = await authorityBlockers(session);
        if (expandedUnavailable) blockers.push('expanded_storage_unavailable');
        if (
          !expandedUnavailable &&
          !(await checkPortablePersonalRestore(session, validation.value)).allowed
        )
          blockers.push('personal_removal_conflict');
        if (
          !expandedUnavailable &&
          (await portableHistoryHasKnownRemovals(session, validation.value))
        )
          blockers.push('history_removal_conflict');
        if (!validation.preview.catalogueMatches) blockers.push('catalogue_mismatch');
        if (validation.preview.unknownRecipeIds.length) blockers.push('unknown_recipes');
        const historyMatches = await portableHistoryMatchesCatalogue(validation.value, options);
        if (!historyMatches) blockers.push('history_content_mismatch');
        const selected = new Set(validation.value.data.shopping.scope.occurrenceIds);
        const shopping =
          blockers.includes('catalogue_mismatch') || blockers.includes('unknown_recipes')
            ? null
            : reconcilePortableRestorePurchases(
                validation.value,
                await buildShoppingProjection(
                  validation.value.data.occurrences.filter((item) =>
                    selected.has(item.occurrenceId),
                  ),
                  options,
                ),
              ).summary;
        const review: PortableRestoreReview = {
          reviewId: options.platform.newId(),
          importFingerprint: validation.value.integrity.digest,
          expectedRevision: before.sourceRevision,
          before: { ...before.counts },
          after: { ...validation.value.counts },
          blockers,
          unknownRecipeIds: [...validation.preview.unknownRecipeIds],
          referenceSummary: summarizePortableBackupReferences(validation.value, {
            currentCatalogue: options.catalogue,
            knownRecipeIds: options.knownRecipeIds,
            historyContentVerification: historyMatches ? 'verified' : 'mismatch',
          }),
          shopping,
          warnings:
            validation.value.schemaVersion === 2
              ? [
                  ...portableRestoreWarnings.filter(
                    (warning) => warning !== 'automatic_before_snapshot_is_cooking_data_only',
                  ),
                  'replaces_personal_notes_collections_and_manual_items',
                  'retains_personal_removal_records',
                  'automatic_before_snapshot_covers_every_replaced_scope',
                  ...(validation.value.data.cookingHistory
                    ? [
                        'replaces_visible_history_with_new_local_ids',
                        'old_operation_receipts_are_not_imported_or_replayed',
                        'history_clear_does_not_remove_retained_backup_archives',
                      ]
                    : ['cooking_history_is_not_included_and_stays_unchanged']),
                ]
              : portableRestoreWarnings,
          replacedScopes:
            validation.value.schemaVersion === 2
              ? [
                  'core',
                  'personal',
                  ...(validation.value.data.cookingHistory ? ['cookingHistory' as const] : []),
                ]
              : ['core'],
        };
        freezeResult(review);
        reviews.set(review, { serialized, envelope: validation.value });
        return review;
      });
    },
    prepare: async (review) =>
      read(async (session) => {
        const source = reviews.get(review);
        if (!source) fault('review_required', 'invalid_input');
        if (review.blockers.length || (await authorityBlockers(session)).length) fault('blocked');
        if (review.expectedRevision !== (await readRevision(session, 'store')))
          fault('workspace_changed');
        const command = freezeResult({
          operationId: options.platform.newId(),
          importFingerprint: review.importFingerprint,
          expectedRevision: review.expectedRevision,
        });
        prepared.set(command, source);
        return command;
      }),
    execute: async (command) => {
      const release = options.acquireExclusive();
      if (!release)
        return failed(
          new RestoreFault({
            code: 'stale_context',
            messageKey: 'restore.store_busy',
            retry: 'after_correction',
          }),
        );
      let committedChange: StoreChange | undefined;
      let committedExpanded: { personal: boolean; cookingHistory: boolean } | undefined;
      try {
        if (
          !command ||
          !isAppId(command.operationId) ||
          !digest(command.importFingerprint) ||
          !safeRevision(command.expectedRevision)
        )
          fault('invalid_operation', 'invalid_input');
        const receipt = await options.writer.transaction(
          async (session) => {
            await requireActivated(session, options.catalogue);
            const previous = await receiptInSnapshot(session, command.operationId);
            if (previous) {
              if (
                previous.importFingerprint !== command.importFingerprint ||
                previous.expectedRevision !== command.expectedRevision
              )
                fault('operation_conflict', 'invalid_input');
              return previous;
            }
            const source = prepared.get(command);
            if (!source) fault('approval_required', 'invalid_input');
            if (options.writer.requiresRecovery()) fault('recovery_required', 'storage_failure');
            if ((await authorityBlockers(session)).length) fault('blocked');
            if ((await readRevision(session, 'store')) !== command.expectedRevision)
              fault('workspace_changed');
            const validation = await validatePortableBackup(source.serialized, validationOptions);
            if (
              validation.kind !== 'ready' ||
              !validation.preview.catalogueMatches ||
              validation.preview.unknownRecipeIds.length ||
              validation.value.integrity.digest !== command.importFingerprint ||
              !(await portableHistoryMatchesCatalogue(validation.value, options))
            )
              fault('invalid_file', 'invalid_input');
            if (!(await checkPortablePersonalRestore(session, validation.value)).allowed)
              fault('personal_removal_conflict', 'invalid_input');
            if (await portableHistoryHasKnownRemovals(session, validation.value))
              fault('history_removal_conflict', 'invalid_input');
            const restoredAt = options.now();
            if (!isUtcInstant(restoredAt)) fault('invalid_clock', 'storage_failure');
            const before = await snapshot(session, options, source.envelope);
            const result = await replaceCookingData(session, source.envelope, before, options);
            await replaceExpandedBackupData(
              session,
              source.envelope,
              command.operationId,
              result.revision,
              options.sha256,
              restoredAt,
            );
            const receipt: PortableRestoreReceipt = {
              ...command,
              kind: 'portable_restore',
              committedAt: restoredAt,
              revision: result.revision,
              beforeFingerprint: before.integrity.digest,
              shopping: result.shopping,
              importedPreferenceRemovals: source.envelope.data.preferences.removals.length,
              restoredCounts: { ...(await snapshot(session, options, source.envelope)).counts },
              ...(source.envelope.schemaVersion === 2
                ? {
                    replacedScopes: [
                      'core' as const,
                      'personal' as const,
                      ...(source.envelope.data.cookingHistory ? ['cookingHistory' as const] : []),
                    ],
                  }
                : {}),
            };
            if (!isUtcInstant(receipt.committedAt)) fault('invalid_clock', 'storage_failure');
            await runBound(
              session,
              'INSERT INTO portable_restore_operation VALUES (?, ?, ?, ?, ?, ?, ?)',
              [
                command.operationId,
                command.importFingerprint,
                command.expectedRevision,
                result.revision,
                source.serialized,
                JSON.stringify(before),
                JSON.stringify(receipt),
              ],
            );
            if ((await session.all('PRAGMA foreign_key_check')).length)
              fault('invalid_relationships', 'storage_failure');
            committedChange = { revision: result.revision, collections: result.collections };
            committedExpanded = {
              personal: source.envelope.schemaVersion === 2,
              cookingHistory: !!source.envelope.data.cookingHistory,
            };
            return freezeResult(receipt);
          },
          { kind: 'all' },
        );
        // Subscribers may synchronously request fresh state; publish only after releasing admission.
        release();
        if (committedChange) options.onCommitted(committedChange, committedExpanded);
        return { kind: 'receipt', receipt };
      } catch (error) {
        // A separate reader can prove a committed receipt even when writer COMMIT acknowledgement was lost.
        if (command && isAppId(command.operationId)) {
          const proof = await read((session) => receiptInSnapshot(session, command.operationId));
          if (
            proof.kind === 'ready' &&
            proof.value &&
            proof.value.importFingerprint === command.importFingerprint &&
            proof.value.expectedRevision === command.expectedRevision
          ) {
            release();
            if (committedChange) options.onCommitted(committedChange, committedExpanded);
            return { kind: 'receipt', receipt: proof.value };
          }
          if (proof.kind === 'failed' || options.writer.requiresRecovery())
            return {
              kind: 'uncertain',
              operationId: command.operationId,
              error: errorDetail(error),
            };
        }
        return failed(error);
      } finally {
        release();
      }
    },
    readReceipt: (id) => read((session) => receiptInSnapshot(session, id)),
    readArchive: (id, archive) =>
      read(async (session) => {
        if (archive !== 'before' && archive !== 'imported')
          fault('invalid_archive', 'invalid_input');
        const receipt = await receiptInSnapshot(session, id);
        if (!receipt) return null;
        const row = (
          await session.all<{ value: string }>(
            `SELECT ${archive === 'before' ? 'before_json' : 'imported_json'} AS value FROM portable_restore_operation WHERE operation_id=?`,
            [id],
          )
        )[0]!;
        const validation = await validatePortableBackup(row.value, validationOptions);
        if (
          validation.kind !== 'ready' ||
          validation.value.integrity.digest !==
            (archive === 'before' ? receipt.beforeFingerprint : receipt.importFingerprint)
        )
          fault('archive_corrupt', 'storage_failure');
        return row.value;
      }),
  });
}
