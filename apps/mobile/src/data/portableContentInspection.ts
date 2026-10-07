import {
  canonicalContentJson,
  OVERLAY_LIMITS,
  type ContentLookup,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { catalogueMatches, type ContractError } from '@cookmate/contracts';
import {
  cookingContentIdentity,
  type Immutable,
  type PortableBackupCounts,
  type PortableBackupFailure,
  type RepositoryResult,
} from '@cookmate/domain';
import {
  validatePortableContentBackup,
  type PortableContentBackupEnvelope,
} from '../../../../packages/domain/src/portableBackupContent';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import type { openContentReleaseStore } from './contentReleaseStore';
import { isAppId, isRevision } from './conversationRecords';
import { admitCookingWorkspaceClocks, readAdoptionInSnapshot } from './cookingContentRepository';
import { readAccountCookingScope } from './cookingHistoryRows';
import { freezeResult, readRevision } from './query';
import { readRestoreEpoch } from './restoreEpoch';
import type { SerializedReader, SqlSession } from './sql';

interface Options {
  reader: SerializedReader;
  contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReferenceInspection'
  >;
  installationId: string;
  sha256(text: string): Promise<string>;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
}
export interface PortableContentReferenceInspection {
  backupDigest: string;
  counts: PortableBackupCounts;
  adoptedHead: OverlayHead | null;
  latestHead: OverlayHead | null;
  references: {
    ref: RecipeContentRef;
    state: 'current' | 'archived' | 'historical' | 'withdrawn' | 'missing';
  }[];
  historyIssues: {
    eventId: string;
    reason: 'unresolved_legacy' | 'metadata_mismatch' | 'previously_removed';
  }[];
  /** Authenticated lookup was performed; individual references may still be unavailable. */
  archiveVerification: 'performed';
  exactReferencesAvailable: boolean;
  /** This inspection has no write capability and is never a replacement approval. */
  restoreAvailable: false;
  warnings: readonly [
    'personal_data_plaintext',
    'checksum_is_not_authentication',
    'restore_review_and_apply_required',
  ];
}
export type PortableContentInspectionResult =
  | RepositoryResult<Immutable<PortableContentReferenceInspection>>
  | { kind: 'invalid'; reason: PortableBackupFailure };

class InspectionFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function reject(message: string, code: ContractError['code'] = 'storage_failure'): never {
  throw new InspectionFault({
    code,
    messageKey: `backup.content_inspection_${message}`,
    retry: 'after_correction',
  });
}
function stored(condition: unknown): asserts condition {
  if (!condition) reject('stored_evidence_invalid');
}
const key = (ref: Immutable<RecipeContentRef>) => canonicalContentJson(ref, 2048);

export async function readPortableContentHistoryRemovals(
  session: SqlSession,
  source: Immutable<PortableContentBackupEnvelope>,
  ownerId: string | null,
) {
  const account = await readAccountCookingScope(session, { contentSchema: true });
  stored(account && account.ownerId === ownerId);
  const ids = source.data.cookingHistory?.entries.map((row) => row.entry.eventId) ?? [];
  const removed = new Set<string>();
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const placeholders = batch.map(() => '?').join(',');
    const rows = await session.all<{ eventId: string }>(
      `SELECT event_id AS eventId FROM cooking_history_withdrawal WHERE event_id IN (${placeholders})
        UNION SELECT event_id AS eventId FROM account_cooking_history_removed WHERE owner_id=? AND event_id IN (${placeholders})
        UNION SELECT event_id AS eventId FROM cooking_event WHERE state IN ('cleared','cancelled') AND event_id IN (${placeholders})
        UNION SELECT source_event_id AS eventId FROM imported_cooking_history removed WHERE source_event_id IN (${placeholders}) AND EXISTS(SELECT 1 FROM cooking_history_withdrawal withdrawal WHERE withdrawal.event_id=removed.event_id)`,
      [...batch, ownerId, ...batch, ...batch, ...batch],
    );
    rows.forEach((row) => removed.add(row.eventId));
  }
  return removed;
}

export async function inspectPortableContentHistory(
  source: Immutable<PortableContentBackupEnvelope>,
  lookups: ReadonlyMap<string, ContentLookup>,
  removed: ReadonlySet<string>,
  sha256: (text: string) => Promise<string>,
  assertActive: () => undefined,
): Promise<PortableContentReferenceInspection['historyIssues']> {
  const historyIssues: PortableContentReferenceInspection['historyIssues'] = [];
  const legacyIdentities = new Map<string, Awaited<ReturnType<typeof cookingContentIdentity>>>();
  for (const row of source.data.cookingHistory?.entries ?? []) {
    if (removed.has(row.entry.eventId))
      historyIssues.push({ eventId: row.entry.eventId, reason: 'previously_removed' });
    if (row.kind === 'legacy' && row.pin.kind === 'unresolved') {
      historyIssues.push({ eventId: row.entry.eventId, reason: 'unresolved_legacy' });
      continue;
    }
    const ref =
      row.kind === 'exact' ? row.entry.contentRef : row.pin.kind === 'exact' ? row.pin.ref : null;
    stored(ref);
    const lookup = lookups.get(key(ref));
    stored(lookup);
    if (lookup.kind !== 'readable') continue;
    stored(key(lookup.value.revision.ref) === key(ref));
    const document = lookup.value.revision.document;
    let matches = row.entry.recipeTitle === document.recipe.title;
    if (row.kind === 'exact') {
      matches =
        matches &&
        (row.entry.photoAssetId === null ||
          document.media.some((media) => media.assetId === row.entry.photoAssetId));
    } else if (document.kind !== 'imported') matches = false;
    else {
      let identity = legacyIdentities.get(key(ref));
      if (!identity) {
        identity = await cookingContentIdentity(
          document.recipe,
          document.provenance.catalogue,
          sha256,
        );
        legacyIdentities.set(key(ref), identity);
      }
      assertActive();
      matches =
        matches &&
        row.entry.photoKey === document.recipe.photoKey &&
        catalogueMatches(row.entry.catalogue, identity.catalogue) &&
        row.entry.contentFingerprint === identity.contentFingerprint &&
        row.entry.readerVersion === identity.readerVersion;
    }
    if (!matches) historyIssues.push({ eventId: row.entry.eventId, reason: 'metadata_mismatch' });
  }
  assertActive();
  return historyIssues;
}

/** Private schema7/8 inspection. File contents never become content trust or operation authority. */
export function createPortableContentBackupInspector(options: Options) {
  if (!isAppId(options.installationId)) reject('invalid_installation', 'invalid_input');
  const access = options.getAccess();
  if (
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !isRevision(access.authGeneration)
  )
    reject('access_changed', 'stale_context');
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  let closed = false;
  function check(): undefined {
    const live = options.getAccess();
    if (
      closed ||
      !live ||
      live.ownerId !== scope.ownerId ||
      live.authGeneration !== scope.authGeneration
    )
      reject('access_changed', 'stale_context');
    try {
      if (options.assertAccess(scope) !== undefined) reject('access_changed', 'stale_context');
    } catch {
      reject('access_changed', 'stale_context');
    }
    return undefined;
  }
  const sha256 = async (text: string) => {
    check();
    const result = await options.sha256(text);
    check();
    stored(typeof result === 'string' && /^[0-9a-f]{64}$/.test(result));
    return result;
  };
  async function workspace(session: SqlSession) {
    check();
    const [installation] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (
      installation?.id !== options.installationId ||
      (await readBinding(session)) !== scope.ownerId
    )
      reject('access_changed', 'stale_context');
    await admitCookingWorkspaceClocks(session);
    const [clock] = await session.all<{ valid: number }>(
      `SELECT CASE WHEN typeof(revision)='integer' AND revision BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
       THEN 1 ELSE 0 END valid FROM state_revision WHERE collection='store'`,
    );
    stored(clock?.valid === 1);
    const result = {
      adoption: await readAdoptionInSnapshot(session),
      restoreEpoch: await readRestoreEpoch(session),
      storeRevision: await readRevision(session, 'store'),
    };
    check();
    return result;
  }
  async function inspect(serialized: string): Promise<PortableContentInspectionResult> {
    try {
      check();
      const decoded = await validatePortableContentBackup(serialized, { sha256 });
      // The codec maps hash exceptions into invalid input; access loss must still stay visible.
      check();
      if (decoded.kind === 'invalid') return decoded;
      const refs = decoded.preview.exactReferences;
      if (refs.length > OVERLAY_LIMITS.retainedRefs) reject('too_many_references', 'too_large');
      const before = await options.reader.transaction(workspace, { kind: 'read_only' });
      check();
      const result = await options.contentStore.withVerifiedReferenceInspection(
        before.adoption.head,
        refs,
        async (view) => {
          const active = (): undefined => {
            check();
            view.assertActive();
            return undefined;
          };
          active();
          const removed = await options.reader.transaction(
            async (session) => {
              const current = await workspace(session);
              if (canonicalContentJson(current) !== canonicalContentJson(before))
                reject('workspace_changed', 'stale_context');
              const value = await readPortableContentHistoryRemovals(
                session,
                decoded.value,
                scope.ownerId,
              );
              active();
              return value;
            },
            { kind: 'read_only' },
          );
          active();
          stored(view.entries.length === refs.length);
          const lookups = new Map<string, ContentLookup>();
          view.entries.forEach((entry, index) => {
            stored(key(entry.ref) === key(refs[index]!));
            lookups.set(key(entry.ref), entry.lookup);
          });
          const historyIssues = await inspectPortableContentHistory(
            decoded.value,
            lookups,
            removed,
            sha256,
            active,
          );
          active();
          // The metadata comparison can await hashing; reject any workspace change during it.
          await options.reader.transaction(
            async (session) => {
              if (canonicalContentJson(await workspace(session)) !== canonicalContentJson(before))
                reject('workspace_changed', 'stale_context');
            },
            { kind: 'read_only' },
          );
          active();
          const references = view.entries.map(({ ref, lookup }) => ({
            ref,
            state: lookup.kind === 'readable' ? lookup.state : lookup.kind,
          }));
          return freezeResult({
            backupDigest: decoded.value.integrity.digest,
            counts: decoded.value.counts,
            adoptedHead: view.head,
            latestHead: view.latestHead,
            references,
            historyIssues,
            archiveVerification: 'performed' as const,
            exactReferencesAvailable: references.every(
              (row) => !['missing', 'withdrawn'].includes(row.state),
            ),
            restoreAvailable: false as const,
            warnings: [
              'personal_data_plaintext',
              'checksum_is_not_authentication',
              'restore_review_and_apply_required',
            ] as const,
          });
        },
      );
      check();
      return { kind: 'ready', value: result, revision: before.storeRevision };
    } catch (error) {
      // Codec and archive failures must not disguise retirement of this owner-bound facade.
      try {
        check();
      } catch (scopeError) {
        error = scopeError;
      }
      return {
        kind: 'failed',
        error:
          error instanceof InspectionFault
            ? error.detail
            : {
                code: 'storage_failure',
                messageKey: 'backup.content_inspection_failed',
                retry: 'after_correction',
              },
      };
    }
  }
  return Object.freeze({
    inspect,
    close() {
      closed = true;
    },
  });
}
