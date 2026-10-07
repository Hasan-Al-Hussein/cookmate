import { catalogue as bundledCatalogue } from '@cookmate/catalogue';
import { AccountReplicationError } from '@cookmate/account-sync';
import {
  canonicalContentJson,
  projectContentLookup,
  OVERLAY_LIMITS,
  validateOverlayHead,
  type ContentLookup,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import {
  catalogueMatches,
  isUtcInstant,
  type CatalogueIdentity,
  type ContractError,
} from '@cookmate/contracts';
import {
  buildShoppingProjection,
  PORTABLE_BACKUP_MAX_BYTES,
  portableRestoreWarnings,
  reconcilePortableRestorePurchases,
  validatePortableBackup,
  type Immutable,
  type PortableRestoreReview,
  type PortableRestoreReceipt,
  type PortableRestoreResult,
  type PreparedPortableRestore,
  type RepositoryResult,
  type StoreChange,
} from '@cookmate/domain';
import {
  validatePortableContentBackup,
  type PortableContentBackupEnvelope,
} from '../../../../packages/domain/src/portableBackupContent';
import {
  ACCOUNT_GUEST_KEY,
  ACCOUNT_SETTINGS_KEY,
  readBinding,
  readJournal,
  readPendingSettings,
} from './accountReplicationRecords';
import { assertAccountContentApprovalAvailable } from './accountContentScopeApproval';
import { ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX } from './accountLegacyTransitionKeys';
import type { ContentAdoptionAccess } from './contentAdoption';
import type {
  ContentReferenceInspectionView,
  openContentReleaseStore,
} from './contentReleaseStore';
import { isAppId, isRevision } from './conversationRecords';
import {
  admitCookingWorkspaceClocks,
  readAdoptionInSnapshot,
  retainCookingRevisionInSnapshot,
  verifyCookingPinBindings,
} from './cookingContentRepository';
import { capturePortableContentBackupInSnapshot } from './portableContentBackup';
import {
  inspectPortableContentHistory,
  readPortableContentHistoryRemovals,
} from './portableContentInspection';
import { replacePortableContentExpandedData } from './portableContentRestoreExpanded';
import { checkPortablePersonalRestore } from './portablePersonalRestore';
import {
  authorityBlockers,
  readPortableRestoreReceiptRow,
  parsePortableRestoreReceiptRow,
} from './portableRestore';
import {
  createPinnedShoppingProjectionOptions,
  readPinnedShoppingContextInSnapshot,
} from './pinnedShoppingRepository';
import { withdrawPreferenceVersions } from './preferenceProvenance';
import { freezeResult, readRevision } from './query';
import { readRestoreEpoch } from './restoreEpoch';
import {
  nextStoredRevision,
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from './shoppingRepository';
import { encodeStoredText } from './storedText';
import {
  runBound,
  type SerializedReader,
  type SerializedWriter,
  type SqlSession,
  type SqlValue,
} from './sql';

interface Options {
  /** Explicit private8 caller; omitted preserves the existing private7 path. */
  cookingSchemaVersion?: 8;
  reader: SerializedReader;
  writer: SerializedWriter;
  contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReferenceInspection'
  >;
  installationId: string;
  catalogue: Readonly<CatalogueIdentity>;
  sha256(text: string): Promise<string>;
  now(): string;
  newId(): string;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
  /** Shared host admission includes pending direct/cooking/adoption and global recovery work. */
  acquireExclusive(): (() => void) | null;
  onCommitted(change: StoreChange, expanded?: { personal: boolean; cookingHistory: boolean }): void;
}
interface Fence {
  installationId: string;
  ownerId: string | null;
  authGeneration: number;
  adoptedHead: OverlayHead | null;
  adoptionRevision: number;
  restoreEpoch: number;
  storeRevision: number;
}
type ExtraBlocker =
  | 'content_unavailable'
  | 'history_unresolved'
  | 'account_operation_pending'
  | 'favourite_removal_conflict'
  | 'preference_removal_conflict';
export interface PortableContentRestoreReview
  extends Omit<PortableRestoreReview, 'blockers'>, Fence {
  latestHead: OverlayHead | null;
  blockers: (PortableRestoreReview['blockers'][number] | ExtraBlocker)[];
}
export interface PortableContentRestoreReceipt extends PortableRestoreReceipt {
  contentContext: Omit<Fence, 'authGeneration' | 'storeRevision'> & {
    schemaVersion: 3;
    latestHead: OverlayHead | null;
  };
}
interface Capability {
  serialized: string;
  source: Immutable<PortableContentBackupEnvelope>;
  before: Immutable<PortableContentBackupEnvelope>;
  fence: Immutable<Fence>;
  latestHead: Immutable<OverlayHead> | null;
  refs: RecipeContentRef[];
}
class RestoreFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function reject(key: string, code: ContractError['code'] = 'stale_context'): never {
  throw new RestoreFault({ code, messageKey: `restore.${key}`, retry: 'after_correction' });
}
function requireValue(condition: unknown): asserts condition {
  if (!condition) reject('stored_evidence_invalid', 'storage_failure');
}
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a: unknown, b: unknown) =>
  canonicalContentJson(a, PORTABLE_BACKUP_MAX_BYTES) ===
  canonicalContentJson(b, PORTABLE_BACKUP_MAX_BYTES);
const refKey = (ref: Immutable<RecipeContentRef>) => canonicalContentJson(ref, 2048);
const detail = (error: unknown): ContractError =>
  error instanceof RestoreFault
    ? error.detail
    : {
        code: 'storage_failure',
        messageKey: 'restore.storage_failure',
        retry: 'after_correction',
      };
const failed = (error: unknown) => ({ kind: 'failed' as const, error: detail(error) });
function guarded(session: SqlSession, check: () => undefined): SqlSession {
  return {
    async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
      check();
      const result = await session.all<Row>(sql, values);
      check();
      return result;
    },
    async exec(sql) {
      check();
      await session.exec(sql);
      check();
    },
    async prepare(sql) {
      check();
      const statement = await session.prepare(sql);
      check();
      return {
        async run(values) {
          check();
          await statement.run(values);
          check();
        },
        finalize: () => statement.finalize(),
      };
    },
  };
}

/** Private reviewed replacement. Files contain data; only this live host supplies authority. */
export function createPortableContentRestoreService(options: Options) {
  requireValue(
    isAppId(options.installationId) &&
      (options.cookingSchemaVersion === undefined || options.cookingSchemaVersion === 8),
  );
  const cookingSchemaVersion = options.cookingSchemaVersion ?? 7;
  const contentOptions = Object.freeze({
    contentSchema: true as const,
    ...(cookingSchemaVersion === 8 ? { cookingSchemaVersion: 8 as const } : {}),
  });
  const baseline = freezeResult(
    JSON.parse(canonicalContentJson(options.catalogue, 4096)) as CatalogueIdentity,
  );
  const access = options.getAccess();
  if (
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !isRevision(access.authGeneration)
  )
    reject('access_changed');
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  let closed = false;
  const reviews = new WeakMap<object, Capability>(),
    commands = new WeakMap<object, Capability>();
  function check(): undefined {
    const live = options.getAccess();
    if (
      closed ||
      !live ||
      live.ownerId !== scope.ownerId ||
      live.authGeneration !== scope.authGeneration
    )
      reject('access_changed');
    try {
      if (options.assertAccess(scope) !== undefined) reject('access_changed');
    } catch {
      reject('access_changed');
    }
    return undefined;
  }
  async function sha256(text: string) {
    check();
    const value = await options.sha256(text);
    check();
    requireValue(hash(value));
    return value;
  }
  function newId() {
    check();
    const id = options.newId();
    requireValue(isAppId(id));
    return id;
  }
  function now() {
    check();
    const time = options.now();
    requireValue(isUtcInstant(time));
    return time;
  }
  async function workspace(session: SqlSession): Promise<Immutable<Fence>> {
    check();
    if (
      (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !==
      cookingSchemaVersion
    )
      reject('not_activated', 'incompatible_version');
    const [installation] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (
      installation?.id !== options.installationId ||
      (await readBinding(session)) !== scope.ownerId
    )
      reject('access_changed');
    const [manifest] = await session.all<CatalogueIdentity>(
      "SELECT CASE WHEN typeof(catalogue_version)='text' AND length(CAST(catalogue_version AS BLOB))<=320 THEN catalogue_version END version,CASE WHEN typeof(fingerprint)='text' AND length(CAST(fingerprint AS BLOB))=64 THEN fingerprint END fingerprint FROM catalogue_manifest WHERE singleton=1",
    );
    if (!manifest || !catalogueMatches(manifest, baseline))
      reject('catalogue_changed', 'incompatible_version');
    await admitCookingWorkspaceClocks(session);
    const [clock] = await session.all<{ valid: number }>(
      `SELECT CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       THEN 1 ELSE 0 END valid FROM state_revision WHERE collection='store'`,
    );
    requireValue(clock?.valid === 1);
    const adoption = await readAdoptionInSnapshot(session);
    const result = freezeResult({
      installationId: options.installationId,
      ...scope,
      adoptedHead: adoption.head,
      adoptionRevision: adoption.revision,
      restoreEpoch: await readRestoreEpoch(session),
      storeRevision: await readRevision(session, 'store'),
    });
    check();
    return result;
  }
  async function capture(session: SqlSession, includeHistory: boolean, at: string, active = check) {
    return capturePortableContentBackupInSnapshot(
      session,
      {
        installationId: options.installationId,
        ownerId: scope.ownerId,
        catalogue: baseline,
        sha256,
        now: () => at,
        assertActive: active,
      },
      includeHistory,
    );
  }
  async function blockers(session: SqlSession): Promise<PortableContentRestoreReview['blockers']> {
    if (options.writer.requiresRecovery()) reject('recovery_required', 'storage_failure');
    const result: PortableContentRestoreReview['blockers'] = await authorityBlockers(session);
    if (cookingSchemaVersion === 8) {
      if (scope.ownerId === null) {
        // A guest never reads private account journals, even when their values are malformed.
        for (const pattern of [
          'account-replication:journal:*',
          'account-replication:content-journal:*',
          'account-replication:content-initial-guest:*',
          ACCOUNT_GUEST_KEY,
          `${ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX}*`,
        ])
          requireValue(
            (await session.all('SELECT 1 FROM app_metadata WHERE key GLOB ? LIMIT 1', [pattern]))
              .length === 0,
          );
        if (
          (await session.all('SELECT 1 FROM app_metadata WHERE key=?', [ACCOUNT_SETTINGS_KEY]))
            .length
        )
          result.push('account_operation_pending');
      } else {
        try {
          await assertAccountContentApprovalAvailable(session, scope.ownerId, sha256);
        } catch (error) {
          if (
            error instanceof AccountReplicationError &&
            ['operation_pending', 'settings_pending', 'recovery_required'].includes(error.reason)
          )
            result.push('account_operation_pending');
          else throw error;
        }
      }
    } else {
      if (await readPendingSettings(session, baseline)) result.push('account_operation_pending');
      const journals = await session.all<{ key: string | null }>(
        "SELECT CASE WHEN typeof(key)='text' AND length(CAST(key AS BLOB))<=80 THEN key END key FROM app_metadata WHERE key LIKE 'account-replication:journal:%' LIMIT 21",
      );
      requireValue(journals.length <= 20);
      for (const row of journals) {
        const ownerId = row.key?.slice('account-replication:journal:'.length);
        requireValue(isAppId(ownerId));
        const journal = await readJournal(session, ownerId, sha256);
        requireValue(journal);
        if (journal.pending) result.push('account_operation_pending');
      }
    }
    // Unacknowledged direct results still have a host promise to settle, even if their intent is settled.
    if (
      (await session.all('SELECT 1 FROM direct_command_recovery LIMIT 1')).length &&
      !result.includes('active_actions')
    )
      result.push('active_actions');
    return result;
  }
  async function read<Value>(
    work: (session: SqlSession) => Promise<Value>,
  ): Promise<RepositoryResult<Value>> {
    try {
      check();
      const value = await options.reader.transaction(
        async (raw) => {
          const session = guarded(raw, check);
          await workspace(session);
          const result = await work(session);
          check();
          return {
            kind: 'ready' as const,
            value: freezeResult(result) as Value,
            revision: await readRevision(session, 'store'),
          };
        },
        { kind: 'read_only' },
      );
      check();
      return value;
    } catch (error) {
      return failed(error);
    }
  }
  async function storedReceipt(
    session: SqlSession,
    operationId: string,
  ): Promise<Immutable<PortableRestoreReceipt | PortableContentRestoreReceipt> | null> {
    if (!isAppId(operationId)) reject('invalid_operation', 'invalid_input');
    const row = await readPortableRestoreReceiptRow(session, operationId);
    if (!row) return null;
    const parsed: unknown = JSON.parse(row.receiptJson);
    if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'contentContext'))
      return parsePortableRestoreReceiptRow(session, operationId, row);
    const { contentContext, ...receipt } = parsed as Record<string, unknown>;
    requireValue(
      contentContext && typeof contentContext === 'object' && !Array.isArray(contentContext),
    );
    const context = contentContext as PortableContentRestoreReceipt['contentContext'];
    const contextKeys = [
      'schemaVersion',
      'installationId',
      'ownerId',
      'adoptedHead',
      'latestHead',
      'adoptionRevision',
      'restoreEpoch',
    ];
    requireValue(
      Object.keys(context).length === contextKeys.length &&
        contextKeys.every((key) => Object.hasOwn(context, key)) &&
        context.schemaVersion === 3 &&
        isAppId(context.installationId) &&
        (context.ownerId === null || isAppId(context.ownerId)) &&
        isRevision(context.adoptionRevision) &&
        isRevision(context.restoreEpoch) &&
        (context.adoptedHead === null || validateOverlayHead(context.adoptedHead)) &&
        (context.latestHead === null || validateOverlayHead(context.latestHead)),
    );
    requireValue(
      context.restoreEpoch <= row.expectedRevision &&
        (context.adoptedHead === null
          ? context.adoptionRevision === 0
          : context.adoptionRevision > 0 &&
            context.latestHead !== null &&
            context.latestHead.sequence >= context.adoptedHead.sequence &&
            (context.latestHead.sequence !== context.adoptedHead.sequence ||
              same(context.latestHead, context.adoptedHead))),
    );
    if (context.ownerId !== scope.ownerId || context.installationId !== options.installationId)
      reject('access_changed');
    const core = await parsePortableRestoreReceiptRow(session, operationId, {
      ...row,
      receiptJson: JSON.stringify(receipt),
    });
    requireValue(core.replacedScopes?.includes('personal'));
    return freezeResult({ ...core, contentContext: context });
  }
  const receipt = (id: string) => read((session) => storedReceipt(session, id));
  function lookups(view: ContentReferenceInspectionView, refs: readonly RecipeContentRef[]) {
    requireValue(view.entries.length === refs.length);
    const map = new Map<string, ContentLookup>();
    view.entries.forEach((row, index) => {
      requireValue(same(row.ref, refs[index]));
      map.set(refKey(row.ref), row.lookup);
    });
    return map;
  }
  function candidateOptions(
    source: Immutable<PortableContentBackupEnvelope>,
    map: ReadonlyMap<string, ContentLookup>,
  ) {
    const refs = new Map(
      source.data.planReferences.map((row) => [row.occurrenceId, row.contentRef]),
    );
    const selected = new Set(source.data.shopping.scope.occurrenceIds);
    return createPinnedShoppingProjectionOptions(
      source.data.occurrences
        .filter((row) => selected.has(row.occurrenceId))
        .map((occurrence) => ({ occurrence, contentRef: refs.get(occurrence.occurrenceId)! })),
      {
        sha256,
        lookupExact: (ref) => projectContentLookup(map.get(refKey(ref)) ?? { kind: 'missing' }),
      },
    );
  }
  function adoptedIdentities(view: ContentReferenceInspectionView): ReadonlySet<string> {
    view.assertActive();
    const value: unknown = JSON.parse(canonicalContentJson(view.adoptedRecipeIds, 512 * 1024));
    requireValue(
      Array.isArray(value) &&
        value.length <= OVERLAY_LIMITS.overrides + bundledCatalogue.recipes.length &&
        value.every((id) => typeof id === 'string' && /^[0-9]{1,20}$/.test(id)) &&
        new Set(value).size === value.length,
    );
    return new Set(value);
  }
  async function preferenceRemovalConflict(
    session: SqlSession,
    source: Immutable<PortableContentBackupEnvelope>,
    before: Immutable<PortableContentBackupEnvelope>,
  ) {
    const current = new Map(
      before.data.preferences.snapshot.items.map((row) => [row.preferenceId, row]),
    );
    const proposed = source.data.preferences.snapshot.items.filter((row) => {
      const active = current.get(row.preferenceId);
      return !active || active.type !== row.type || active.value !== row.value;
    });
    if (!proposed.length) return false;
    // A direct preference deletion may retain only this global marker, without a source link.
    // The file cannot prove that a newly introduced choice is not the one previously removed.
    if (before.data.preferences.snapshot.lastRemovalRevision !== null) return true;
    const conflicts = (rows: typeof source.data.preferences.removals) =>
      proposed.some((item) =>
        rows.some(
          (removed) =>
            removed.preferenceId === item.preferenceId ||
            (removed.type === item.type && removed.value === item.value),
        ),
      );
    if (conflicts(before.data.preferences.removals) || conflicts(source.data.preferences.removals))
      return true;
    const ids = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(operation_id)='text' AND length(CAST(operation_id AS BLOB))=36 THEN operation_id END id FROM portable_restore_operation LIMIT 21",
    );
    requireValue(ids.length <= 20);
    for (const row of ids) {
      requireValue(isAppId(row.id));
      const saved = await storedReceipt(session, row.id);
      requireValue(saved);
      const [archive] = await session.all<{ json: string | null }>(
        "SELECT CASE WHEN typeof(imported_json)='text' AND length(CAST(imported_json AS BLOB))<=? THEN imported_json END json FROM portable_restore_operation WHERE operation_id=?",
        [PORTABLE_BACKUP_MAX_BYTES, row.id],
      );
      requireValue(archive && typeof archive.json === 'string');
      const checked =
        'contentContext' in saved
          ? await validatePortableContentBackup(archive.json, { sha256 })
          : await validatePortableBackup(archive.json, {
              sha256,
              currentCatalogue: baseline,
              knownRecipeIds: bundledCatalogue.boundary.recipeIds,
            });
      requireValue(
        checked.kind === 'ready' && checked.value.integrity.digest === saved.importFingerprint,
      );
      if (conflicts(checked.value.data.preferences.removals)) return true;
    }
    return false;
  }
  async function assess(
    session: SqlSession,
    source: Immutable<PortableContentBackupEnvelope>,
    before: Immutable<PortableContentBackupEnvelope>,
    map: ReadonlyMap<string, ContentLookup>,
    known: ReadonlySet<string>,
    active: () => undefined,
  ) {
    const blocked = await blockers(session);
    if (!catalogueMatches(source.catalogue, baseline)) blocked.push('catalogue_mismatch');
    if ([...map.values()].some((lookup) => lookup.kind !== 'readable'))
      blocked.push('content_unavailable');
    const ids = [
      ...source.data.favourites.map((row) => row.recipeId),
      ...source.data.occurrences.map((row) => row.recipeId),
      ...source.data.personal.notes.map((row) => row.recipeId),
      ...source.data.personal.memberships.map((row) => row.recipeId),
      ...(source.data.cookingHistory?.entries.map((row) => row.entry.recipeId) ?? []),
    ];
    const unknownRecipeIds = [...new Set(ids.filter((id) => !known.has(id)))].sort();
    if (unknownRecipeIds.length) blocked.push('unknown_recipes');
    const removedFavourites = new Set(
      before.data.favourites.filter((row) => !row.saved).map((row) => row.recipeId),
    );
    if (source.data.favourites.some((row) => row.saved && removedFavourites.has(row.recipeId)))
      blocked.push('favourite_removal_conflict');
    if (await preferenceRemovalConflict(session, source, before))
      blocked.push('preference_removal_conflict');
    if (!(await checkPortablePersonalRestore(session, source, contentOptions)).allowed)
      blocked.push('personal_removal_conflict');
    const historyIssues = await inspectPortableContentHistory(
      source,
      map,
      await readPortableContentHistoryRemovals(session, source, scope.ownerId),
      sha256,
      active,
    );
    if (historyIssues.some((issue) => issue.reason === 'unresolved_legacy'))
      blocked.push('history_unresolved');
    if (historyIssues.some((issue) => issue.reason === 'metadata_mismatch'))
      blocked.push('history_content_mismatch');
    if (historyIssues.some((issue) => issue.reason === 'previously_removed'))
      blocked.push('history_removal_conflict');
    let shopping: PortableRestoreReview['shopping'] = null;
    if (
      !blocked.some((value) =>
        ['catalogue_mismatch', 'content_unavailable', 'unknown_recipes'].includes(value),
      )
    ) {
      const projection = candidateOptions(source, map),
        selected = new Set(source.data.shopping.scope.occurrenceIds);
      shopping = reconcilePortableRestorePurchases(
        source,
        await buildShoppingProjection(
          source.data.occurrences.filter((row) => selected.has(row.occurrenceId)),
          projection,
        ),
      ).summary;
    }
    active();
    return { blockers: [...new Set(blocked)], unknownRecipeIds, shopping };
  }
  async function reserve<Value>(
    capability: Capability,
    work: (view: ContentReferenceInspectionView, active: () => undefined) => Promise<Value>,
  ) {
    check();
    const result = await options.contentStore.withVerifiedReferenceInspection(
      capability.fence.adoptedHead,
      capability.refs,
      async (view) => {
        const active = (): undefined => {
          check();
          view.assertActive();
          return undefined;
        };
        active();
        if (!same(view.latestHead, capability.latestHead)) reject('content_changed');
        const value = await work(view, active);
        active();
        return value;
      },
    );
    check();
    return result;
  }
  async function requireUnchanged(session: SqlSession, cap: Capability) {
    if (!same(await workspace(session), cap.fence)) reject('workspace_changed');
    const current = await capture(session, !!cap.source.data.cookingHistory, cap.before.createdAt);
    if (current.integrity.digest !== cap.before.integrity.digest) reject('workspace_changed');
  }
  async function review(
    serialized: string,
  ): Promise<RepositoryResult<Immutable<PortableContentRestoreReview>>> {
    try {
      check();
      const validation = await validatePortableContentBackup(serialized, { sha256 });
      check();
      if (validation.kind !== 'ready')
        reject(
          validation.reason,
          validation.reason === 'too_large' ? 'too_large' : 'invalid_input',
        );
      const source = validation.value;
      const before = await options.reader.transaction(
        async (raw) => {
          const session = guarded(raw, check),
            fence = await workspace(session);
          const snapshot = await capture(session, !!source.data.cookingHistory, now());
          return { fence, snapshot };
        },
        { kind: 'read_only' },
      );
      check();
      const previouslySelected = new Set(before.snapshot.data.shopping.scope.occurrenceIds);
      const refs = [
        ...new Map(
          [
            ...validation.preview.exactReferences,
            ...before.snapshot.data.planReferences
              .filter((row) => previouslySelected.has(row.occurrenceId))
              .map((row) => row.contentRef),
          ].map((ref) => [refKey(ref), ref]),
        ).values(),
      ];
      if (refs.length > OVERLAY_LIMITS.retainedRefs) reject('too_many_references', 'too_large');
      const result = await options.contentStore.withVerifiedReferenceInspection(
        before.fence.adoptedHead,
        refs,
        async (view) => {
          const active = (): undefined => {
            check();
            view.assertActive();
            return undefined;
          };
          const cap: Capability = {
            serialized,
            source,
            before: before.snapshot,
            fence: before.fence,
            latestHead: view.latestHead,
            refs,
          };
          return options.reader.transaction(
            async (raw) => {
              const session = guarded(raw, active);
              await requireUnchanged(session, cap);
              const assessment = await assess(
                session,
                source,
                before.snapshot,
                lookups(view, refs),
                adoptedIdentities(view),
                active,
              );
              const result = freezeResult({
                ...before.fence,
                latestHead: view.latestHead,
                reviewId: newId(),
                importFingerprint: source.integrity.digest,
                expectedRevision: before.fence.storeRevision,
                before: before.snapshot.counts,
                after: source.counts,
                ...assessment,
                warnings: [
                  ...portableRestoreWarnings.filter(
                    (value) => value !== 'automatic_before_snapshot_is_cooking_data_only',
                  ),
                  'automatic_before_snapshot_covers_every_replaced_scope',
                  'replaces_personal_notes_collections_and_manual_items',
                  'retains_personal_removal_records',
                  ...(source.data.cookingHistory
                    ? [
                        'replaces_visible_history_with_new_local_ids',
                        'old_operation_receipts_are_not_imported_or_replayed',
                      ]
                    : ['cooking_history_is_not_included_and_stays_unchanged']),
                ],
                replacedScopes: [
                  'core',
                  'personal',
                  ...(source.data.cookingHistory ? ['cookingHistory'] : []),
                ] as ('core' | 'personal' | 'cookingHistory')[],
              });
              active();
              reviews.set(result, cap);
              return result;
            },
            { kind: 'read_only' },
          );
        },
      );
      check();
      return { kind: 'ready', value: result, revision: before.fence.storeRevision };
    } catch (error) {
      return failed(error);
    }
  }
  async function prepare(
    value: Immutable<PortableContentRestoreReview>,
  ): Promise<RepositoryResult<Immutable<PreparedPortableRestore>>> {
    try {
      check();
      const cap = reviews.get(value);
      if (!cap) reject('review_required', 'invalid_input');
      if (value.blockers.length) reject('blocked');
      const command = await reserve(cap, async (view, active) =>
        options.reader.transaction(
          async (raw) => {
            const session = guarded(raw, active);
            await requireUnchanged(session, cap);
            if (
              (
                await assess(
                  session,
                  cap.source,
                  cap.before,
                  lookups(view, cap.refs),
                  adoptedIdentities(view),
                  active,
                )
              ).blockers.length
            )
              reject('blocked');
            const command = freezeResult({
              operationId: newId(),
              importFingerprint: cap.source.integrity.digest,
              expectedRevision: cap.fence.storeRevision,
            });
            active();
            commands.set(command, cap);
            return command;
          },
          { kind: 'read_only' },
        ),
      );
      check();
      return { kind: 'ready', value: command, revision: cap.fence.storeRevision };
    } catch (error) {
      return failed(error);
    }
  }
  async function nextRevision(
    session: SqlSession,
    source: Immutable<PortableContentBackupEnvelope>,
  ) {
    for (const [table, columns] of [
      ['state_revision', ['revision']],
      ['favourite', ['revision']],
      ['plan_occurrence', ['revision']],
      ['purchase_state', ['revision']],
      ['saved_preference', ['revision']],
      ['shopping_scope', ['revision', 'projection_revision']],
      ['source_preference_link', ['saved_revision', 'removed_revision']],
      ['preference_state', ['last_removal_revision']],
      ['cooking_state', ['session_revision', 'history_revision']],
      ['personal_state', ['revision']],
      ['recipe_note', ['revision']],
      ['personal_collection', ['revision']],
      ['personal_collection_member', ['revision']],
      ['manual_shopping_item', ['revision']],
    ] as const) {
      const invalid = columns
        .map(
          (column) =>
            `(${column} IS NOT NULL AND (typeof(${column})<>'integer' OR ${column}<0 OR ${column}>9007199254740991))`,
        )
        .join(' OR ');
      requireValue(
        (await session.all(`SELECT 1 FROM ${table} WHERE ${invalid} LIMIT 1`)).length === 0,
      );
    }
    const rows = await session.all<{
      value: number | null;
    }>(`SELECT MAX(revision) value FROM state_revision
      UNION ALL SELECT MAX(revision) FROM favourite UNION ALL SELECT MAX(revision) FROM plan_occurrence
      UNION ALL SELECT MAX(revision) FROM purchase_state UNION ALL SELECT MAX(revision) FROM saved_preference
      UNION ALL SELECT MAX(revision) FROM shopping_scope UNION ALL SELECT MAX(projection_revision) FROM shopping_scope
      UNION ALL SELECT MAX(saved_revision) FROM source_preference_link UNION ALL SELECT MAX(removed_revision) FROM source_preference_link
      UNION ALL SELECT MAX(last_removal_revision) FROM preference_state
      UNION ALL SELECT MAX(session_revision,history_revision) FROM cooking_state
      UNION ALL SELECT revision FROM personal_state UNION ALL SELECT MAX(revision) FROM recipe_note
      UNION ALL SELECT MAX(revision) FROM personal_collection UNION ALL SELECT MAX(revision) FROM personal_collection_member UNION ALL SELECT MAX(revision) FROM manual_shopping_item`);
    requireValue(rows.every((row) => row.value === null || isRevision(row.value)));
    const imported = [
      source.sourceRevision,
      ...source.data.favourites.map((row) => row.revision),
      ...source.data.occurrences.map((row) => row.revision),
      ...Object.values(source.data.personal)
        .flat()
        .map((row) => row.revision),
      ...(source.data.cookingHistory?.entries.map((row) => row.entry.revision) ?? []),
    ];
    return nextStoredRevision(
      [...rows.map((row) => row.value ?? 0), ...imported].reduce(
        (max, value) => Math.max(max, value),
        0,
      ),
    );
  }
  async function replaceCore(
    session: SqlSession,
    cap: Capability,
    map: ReadonlyMap<string, ContentLookup>,
    revision: number,
  ) {
    const ports = {
      sha256,
      lookupExact: (ref: RecipeContentRef) =>
        projectContentLookup(map.get(refKey(ref)) ?? { kind: 'missing' }),
    };
    const old = await readPinnedShoppingContextInSnapshot(session, ports),
      ledger = await readShoppingLedgerInSnapshot(session, old.options),
      scopeId = ledger.snapshot.scope.scopeId;
    const data = cap.source.data;
    await runBound(session, 'DELETE FROM shopping_contribution WHERE scope_id=?', [scopeId]);
    await runBound(session, 'DELETE FROM shopping_selection WHERE scope_id=?', [scopeId]);
    await session.exec('DELETE FROM plan_content_pin');
    await session.exec('DELETE FROM plan_occurrence');
    for (const row of data.occurrences)
      await runBound(session, 'INSERT INTO plan_occurrence VALUES (?,?,?,?,?,?,?)', [
        row.occurrenceId,
        row.recipeId,
        row.placement.actualDate,
        row.placement.mealKey,
        revision,
        row.createdAt,
        row.updatedAt,
      ]);
    for (const { occurrenceId, contentRef } of data.planReferences)
      await runBound(session, 'INSERT INTO plan_content_pin VALUES (?,?,?,?)', [
        occurrenceId,
        contentRef.recipeId,
        contentRef.revisionId,
        contentRef.contentFingerprint,
      ]);
    for (const id of data.shopping.scope.occurrenceIds)
      await runBound(session, 'INSERT INTO shopping_selection VALUES (?,?)', [scopeId, id]);
    await runBound(session, 'UPDATE shopping_scope SET revision=? WHERE scope_id=?', [
      revision,
      scopeId,
    ]);
    const projectionOptions = candidateOptions(cap.source, map);
    await rebuildShoppingInSnapshot(session, ledger, projectionOptions);
    const selected = new Set(data.shopping.scope.occurrenceIds);
    const purchases = reconcilePortableRestorePurchases(
      cap.source,
      await buildShoppingProjection(
        data.occurrences.filter((row) => selected.has(row.occurrenceId)),
        projectionOptions,
      ),
    );
    await runBound(
      session,
      'UPDATE shopping_group SET projection_revision=? WHERE scope_id=? AND projection_revision=?',
      [revision, scopeId, ledger.snapshot.projectionRevision + 1],
    );
    await runBound(session, 'UPDATE shopping_scope SET projection_revision=? WHERE scope_id=?', [
      revision,
      scopeId,
    ]);
    await runBound(
      session,
      'UPDATE purchase_state SET purchased=0,changed=1,revision=? WHERE scope_id=?',
      [revision, scopeId],
    );
    for (const state of purchases.states)
      await runBound(
        session,
        'UPDATE purchase_state SET purchased=?,changed=? WHERE scope_id=? AND group_key=?',
        [state.purchased ? 1 : 0, state.changed ? 1 : 0, scopeId, state.groupKey],
      );
    await session.exec('DELETE FROM favourite');
    const favourites = new Map(data.favourites.map((row) => [row.recipeId, row]));
    for (const previous of cap.before.data.favourites) {
      if (!previous.saved) favourites.set(previous.recipeId, previous);
      else if (!favourites.has(previous.recipeId))
        favourites.set(previous.recipeId, { ...previous, saved: false, updatedAt: now() });
    }
    for (const row of favourites.values())
      await runBound(session, 'INSERT INTO favourite VALUES (?,?,?,?,?)', [
        row.recipeId,
        row.saved ? 1 : 0,
        revision,
        row.savedAt,
        row.updatedAt,
      ]);
    const conversationChanged = await withdrawPreferenceVersions(
      session,
      cap.before.data.preferences.snapshot.items,
      revision,
    );
    await session.exec('DELETE FROM saved_preference');
    for (const row of data.preferences.snapshot.items)
      await runBound(session, 'INSERT INTO saved_preference VALUES (?,?,?,?)', [
        row.preferenceId,
        row.type,
        encodeStoredText(row.value),
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
    await readShoppingLedgerInSnapshot(session, projectionOptions);
    return { collections, shopping: purchases.summary };
  }
  async function execute(
    command: Immutable<PreparedPortableRestore>,
  ): Promise<PortableRestoreResult> {
    let request: Immutable<PreparedPortableRestore> | undefined;
    let release: (() => void) | null = null,
      dispatched = false,
      committedChange: StoreChange | undefined;
    const unlock = () => {
      const done = release;
      release = null;
      done?.();
    };
    try {
      check();
      const owned: unknown = JSON.parse(canonicalContentJson(command, 2048));
      if (
        !owned ||
        typeof owned !== 'object' ||
        Object.keys(owned).length !== 3 ||
        !('operationId' in owned) ||
        !isAppId(owned.operationId) ||
        !('importFingerprint' in owned) ||
        !hash(owned.importFingerprint) ||
        !('expectedRevision' in owned) ||
        !isRevision(owned.expectedRevision)
      )
        reject('invalid_operation', 'invalid_input');
      request = freezeResult(owned as PreparedPortableRestore);
      const currentRequest = request;
      release = options.acquireExclusive();
      if (!release) reject('store_busy');
      const previous = await receipt(currentRequest.operationId);
      if (previous.kind === 'failed') return previous;
      if (previous.value) {
        if (
          previous.value.importFingerprint !== currentRequest.importFingerprint ||
          previous.value.expectedRevision !== currentRequest.expectedRevision
        )
          reject('operation_conflict', 'invalid_input');
        return { kind: 'receipt', receipt: previous.value };
      }
      const cap = commands.get(command);
      if (!cap) reject('approval_required', 'invalid_input');
      const result = await reserve(cap, async (view, active) => {
        const map = lookups(view, cap.refs),
          known = adoptedIdentities(view);
        dispatched = true;
        const committed = await options.writer.transaction(
          async (raw) => {
            const session = guarded(raw, active);
            await requireUnchanged(session, cap);
            if ((await assess(session, cap.source, cap.before, map, known, active)).blockers.length)
              reject('blocked');
            const restoredAt = now(),
              before = await capture(session, !!cap.source.data.cookingHistory, restoredAt, active);
            const revision = await nextRevision(session, cap.source);
            for (const lookup of map.values()) {
              if (lookup.kind !== 'readable') reject('content_unavailable', 'invalid_input');
              await retainCookingRevisionInSnapshot(session, lookup.value.revision, sha256);
            }
            // Identity-only personal/favourite references need no recipe body or invented revision.
            const identities = new Set([
              ...cap.source.data.favourites.map((row) => row.recipeId),
              ...cap.source.data.personal.notes.map((row) => row.recipeId),
              ...cap.source.data.personal.memberships.map((row) => row.recipeId),
            ]);
            for (const recipeId of identities) {
              requireValue(known.has(recipeId));
              await runBound(
                session,
                'INSERT INTO recipe_identity VALUES (?) ON CONFLICT(recipe_id) DO NOTHING',
                [recipeId],
              );
            }
            const core = await replaceCore(session, cap, map, revision);
            await replacePortableContentExpandedData(
              session,
              cap.source,
              currentRequest.operationId,
              revision,
              sha256,
              restoredAt,
              contentOptions,
            );
            const context: PortableContentRestoreReceipt['contentContext'] = {
              schemaVersion: 3,
              installationId: options.installationId,
              ownerId: scope.ownerId,
              adoptedHead: cap.fence.adoptedHead,
              latestHead: cap.latestHead,
              adoptionRevision: cap.fence.adoptionRevision,
              restoreEpoch: cap.fence.restoreEpoch,
            };
            const saved: PortableContentRestoreReceipt = {
              ...currentRequest,
              kind: 'portable_restore',
              committedAt: restoredAt,
              revision,
              beforeFingerprint: before.integrity.digest,
              shopping: core.shopping,
              importedPreferenceRemovals: cap.source.data.preferences.removals.length,
              restoredCounts: { ...cap.source.counts },
              replacedScopes: [
                'core',
                'personal',
                ...(cap.source.data.cookingHistory ? ['cookingHistory' as const] : []),
              ],
              contentContext: context,
            };
            await runBound(
              session,
              'INSERT INTO portable_restore_operation VALUES (?,?,?,?,?,?,?)',
              [
                currentRequest.operationId,
                currentRequest.importFingerprint,
                currentRequest.expectedRevision,
                revision,
                cap.serialized,
                JSON.stringify(before),
                canonicalContentJson(saved, 32768),
              ],
            );
            await verifyCookingPinBindings(session, sha256);
            saved.restoredCounts = {
              ...(await capture(session, !!cap.source.data.cookingHistory, restoredAt, active))
                .counts,
            };
            await runBound(
              session,
              'UPDATE portable_restore_operation SET receipt_json=? WHERE operation_id=?',
              [canonicalContentJson(saved, 32768), currentRequest.operationId],
            );
            if ((await session.all('PRAGMA foreign_key_check')).length)
              reject('invalid_relationships', 'storage_failure');
            committedChange = { revision, collections: core.collections };
            active();
            return freezeResult(saved);
          },
          { kind: 'all' },
          active,
        );
        active();
        return committed;
      });
      check();
      unlock();
      if (committedChange)
        options.onCommitted(committedChange, {
          personal: true,
          cookingHistory: !!cap.source.data.cookingHistory,
        });
      return { kind: 'receipt', receipt: result };
    } catch (error) {
      if (dispatched && request && isAppId(request.operationId)) {
        const proof = await receipt(request!.operationId);
        if (
          proof.kind === 'ready' &&
          proof.value &&
          proof.value.importFingerprint === request!.importFingerprint &&
          proof.value.expectedRevision === request!.expectedRevision
        ) {
          unlock();
          if (committedChange)
            options.onCommitted(committedChange, {
              personal: true,
              cookingHistory: proof.value.replacedScopes?.includes('cookingHistory') ?? false,
            });
          return { kind: 'receipt', receipt: proof.value };
        }
        if (proof.kind === 'failed' || options.writer.requiresRecovery())
          return { kind: 'uncertain', operationId: request!.operationId, error: detail(error) };
      }
      return failed(error);
    } finally {
      unlock();
    }
  }
  async function readArchive(operationId: string, archive: 'before' | 'imported') {
    return read(async (session): Promise<string | null> => {
      if (archive !== 'before' && archive !== 'imported')
        reject('invalid_archive', 'invalid_input');
      const saved = await storedReceipt(session, operationId);
      if (!saved) return null;
      const column = archive === 'before' ? 'before_json' : 'imported_json';
      const [row] = await session.all<{ value: string | null }>(
        `SELECT CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=? THEN ${column} END value FROM portable_restore_operation WHERE operation_id=?`,
        [PORTABLE_BACKUP_MAX_BYTES, operationId],
      );
      requireValue(row && typeof row.value === 'string');
      const validation =
        'contentContext' in saved
          ? await validatePortableContentBackup(row.value, { sha256 })
          : await validatePortableBackup(row.value, {
              sha256,
              currentCatalogue: baseline,
              knownRecipeIds: bundledCatalogue.boundary.recipeIds,
            });
      check();
      requireValue(
        validation.kind === 'ready' &&
          validation.value.integrity.digest ===
            (archive === 'before' ? saved.beforeFingerprint : saved.importFingerprint),
      );
      return row.value;
    });
  }
  return Object.freeze({
    review,
    prepare,
    execute,
    readReceipt: receipt,
    readArchive,
    close() {
      closed = true;
    },
  });
}
