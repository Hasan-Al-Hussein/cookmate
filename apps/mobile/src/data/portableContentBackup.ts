import { canonicalContentJson } from '@cookmate/catalogue/content';
import { catalogueMatches, type CatalogueIdentity, type ContractError } from '@cookmate/contracts';
import {
  PORTABLE_BACKUP_MAX_BYTES,
  PortableBackupError,
  personalLimits,
  portableBackupLimits,
  portablePersonalLimits,
  type Immutable,
  type RepositoryResult,
} from '@cookmate/domain';
import {
  createPortableContentBackup,
  type PortableContentBackupData,
  type PortableContentBackupEnvelope,
  type PortableContentHistoryRecord,
} from '../../../../packages/domain/src/portableBackupContent';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import { isAppId, isRevision } from './conversationRecords';
import {
  readPlanContentPins,
  requireCookingContentReadVersion,
  verifyPlanContentBindings,
  withStoredCookingHistoryEntries,
} from './cookingContentRepository';
import { COOKING_CONTENT_LIMITS } from './cookingContentSchema';
import { historyRows, readAccountCookingScope } from './cookingHistoryRows';
import { readBackupData } from './portableBackup';
import { readRevision } from './query';
import type { SerializedReader, SqlSession } from './sql';

interface Options {
  reader: SerializedReader;
  installationId: string;
  catalogue: Readonly<CatalogueIdentity>;
  sha256(text: string): Promise<string>;
  now(): string;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
}
class CaptureFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function reject(message: string, code: ContractError['code'] = 'storage_failure'): never {
  throw new CaptureFault({
    code,
    messageKey: `backup.content_${message}`,
    retry: 'after_correction',
  });
}
function stored(condition: unknown): asserts condition {
  if (!condition) reject('source_invalid');
}

type Column = readonly [name: string, maximumBytes: number | 'integer', nullable?: boolean];
const id = (name: string): Column => [name, 36];
const number = (name: string, nullable = false): Column => [name, 'integer', nullable];
const dates: Column[] = [
  ['created_at', 24],
  ['updated_at', 24],
];
const encoded = (characters: number) => characters * 6 + 2;

/** Fixed allowlisted SQL projections are admitted before any raw application field is copied. */
function projectionAdmission(session: SqlSession) {
  let bytes = 0;
  return async (table: string, maximumRows: number, columns: readonly Column[], where = '') => {
    const invalid = columns
      .map(([name, maximum, nullable]) => {
        const valid =
          maximum === 'integer'
            ? `(typeof(${name})='integer' AND ${name} BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER})`
            : `(typeof(${name})='text' AND length(CAST(${name} AS BLOB))<=${maximum})`;
        return `(CASE WHEN ${nullable ? `${name} IS NULL OR ` : ''}${valid} THEN 0 ELSE 1 END)`;
      })
      .join('+');
    const sizes = columns.map(([name]) => `COALESCE(length(CAST(${name} AS BLOB)),0)`).join('+');
    const [row] = await session.all<{ count: number; bytes: number; invalid: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(${sizes}),0) bytes,COALESCE(MAX(${invalid}),0) invalid FROM ${table} ${where}`,
    );
    stored(row && isRevision(row.count) && isRevision(row.bytes) && row.invalid === 0);
    bytes += row.bytes;
    if (row.count > maximumRows || bytes > PORTABLE_BACKUP_MAX_BYTES)
      reject('too_large', 'too_large');
  };
}
async function admitBackupProjection(session: SqlSession) {
  const admit = projectionAdmission(session);
  await admit('catalogue_manifest', 1, [
    ['catalogue_version', 320],
    ['fingerprint', 64],
  ]);
  await admit('state_revision', 6, [['collection', 32], number('revision')]);
  await admit('favourite', portableBackupLimits.favourites, [
    ['recipe_id', 20],
    number('saved'),
    number('revision'),
    ['saved_at', 24],
    ['updated_at', 24],
  ]);
  await admit('plan_occurrence', portableBackupLimits.occurrences, [
    id('occurrence_id'),
    ['recipe_id', 20],
    ['local_date', 10],
    ['meal_key', 9],
    number('revision'),
    ...dates,
  ]);
  await admit('shopping_scope', 1, [
    id('scope_id'),
    number('singleton'),
    number('revision'),
    number('projection_revision'),
    ['projection_status', 7],
  ]);
  await admit('shopping_selection', portableBackupLimits.selectedOccurrences, [
    id('scope_id'),
    id('occurrence_id'),
  ]);
  await admit('purchase_state', portableBackupLimits.purchaseMarks, [
    id('scope_id'),
    ['group_key', 64],
    ['demand_fingerprint', 64],
    number('purchased'),
    number('changed'),
    number('revision'),
  ]);
  await admit('shopping_group', portableBackupLimits.purchaseMarks, [
    id('scope_id'),
    ['group_key', 64],
    ['grouping_version', 320],
    ['demand_fingerprint', 64],
    number('projection_revision'),
  ]);
  await admit('preference_state', 1, [number('last_removal_revision', true)]);
  await admit('saved_preference', portableBackupLimits.preferences, [
    id('preference_id'),
    ['type', 64],
    ['value', 1538],
    number('revision'),
  ]);
  // Only withdrawal facts are selected, never the linked conversation or source message.
  await admit(
    'source_preference_link',
    Number.MAX_SAFE_INTEGER,
    [
      id('preference_id'),
      ['type', 64],
      ['value', 1538],
      number('saved_revision'),
      number('removed_revision'),
    ],
    'WHERE removed_revision IS NOT NULL',
  );
  await admit('recipe_note', portablePersonalLimits.notes, [
    id('note_id'),
    ['recipe_id', 20],
    ['text', encoded(personalLimits.noteCharacters), true],
    number('deleted'),
    number('revision'),
    ...dates,
  ]);
  await admit('personal_collection', portablePersonalLimits.collections, [
    id('collection_id'),
    ['name', encoded(personalLimits.collectionNameCharacters), true],
    number('deleted'),
    number('revision'),
    ...dates,
  ]);
  await admit('personal_collection_member', portablePersonalLimits.memberships, [
    id('collection_id'),
    ['recipe_id', 20],
    number('present'),
    number('revision'),
    ['updated_at', 24],
  ]);
  await admit('manual_shopping_item', portablePersonalLimits.manualItems, [
    id('item_id'),
    ['name', encoded(personalLimits.itemNameCharacters), true],
    ['amount_text', encoded(personalLimits.amountCharacters), true],
    ['unit_text', encoded(personalLimits.unitCharacters), true],
    ['category', 16, true],
    number('purchased'),
    number('deleted'),
    number('revision'),
    ...dates,
  ]);
  // Reject orphan scope rows rather than silently dropping them through filtered backup joins.
  for (const table of ['shopping_selection', 'purchase_state', 'shopping_group'])
    stored(
      (
        await session.all(
          `SELECT 1 FROM ${table} p LEFT JOIN shopping_scope s ON s.scope_id=p.scope_id WHERE s.scope_id IS NULL LIMIT 1`,
        )
      ).length === 0,
    );
  return admit;
}

export interface PortableContentCaptureOptions {
  installationId: string;
  ownerId: string | null;
  catalogue: Readonly<CatalogueIdentity>;
  sha256(text: string): Promise<string>;
  now(): string;
  assertActive(): undefined;
}
async function readPortableContentBackupInputInSnapshot(
  session: SqlSession,
  options: PortableContentCaptureOptions,
  includeCookingHistory: boolean,
) {
  options.assertActive();
  const databaseSchemaVersion = await requireCookingContentReadVersion(session);
  const [installation] = await session.all<{ id: string | null }>(
    "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
  );
  if (
    installation?.id !== options.installationId ||
    (await readBinding(session)) !== options.ownerId
  )
    reject('access_changed', 'stale_context');
  const admit = await admitBackupProjection(session);
  const manifests = await session.all<CatalogueIdentity>(
    'SELECT catalogue_version version,fingerprint FROM catalogue_manifest WHERE singleton=1',
  );
  stored(manifests.length === 1 && catalogueMatches(manifests[0]!, options.catalogue));
  await verifyPlanContentBindings(session, options.sha256);
  const {
    personal,
    cookingHistory: excludedHistory,
    ...core
  } = await readBackupData(session, true, false);
  stored(personal && !excludedHistory);
  const planReferences: PortableContentBackupData['planReferences'] = [];
  let after: string | undefined;
  do {
    const page = await readPlanContentPins(session, after ? { after } : {});
    planReferences.push(
      ...page.items.map((row) => ({ occurrenceId: row.occurrenceId, contentRef: row.ref })),
    );
    after = page.nextAfter ?? undefined;
  } while (after);
  stored(planReferences.length === core.occurrences.length);
  const cookingHistory: PortableContentHistoryRecord[] = [];
  if (includeCookingHistory) {
    await admit('cooking_state', 1, [number('history_revision'), number('history_epoch')]);
    await readAccountCookingScope(session, { contentSchema: true });
    // Combined history can inspect strict-v1 mirrors before selecting visible rows. Bound
    // their raw payloads too; the final codec separately enforces the whole encoded file cap.
    for (const [table, column] of [
      ['cooking_event', 'receipt_json'],
      ['imported_cooking_history', 'entry_json'],
      ['account_cooking_history', 'entry_json'],
    ] as const)
      await admit(
        table,
        portablePersonalLimits.history,
        [[column, 32768]],
        table === 'cooking_event' ? "WHERE state='saved'" : '',
      );
    const [state] = await session.all<{ revision: number; epoch: number }>(
      'SELECT history_revision revision,history_epoch epoch FROM cooking_state WHERE singleton=1',
    );
    stored(state && isRevision(state.revision) && isRevision(state.epoch));
    const rows = await historyRows(
      session,
      state.epoch,
      portablePersonalLimits.history + 1,
      undefined,
      { contentSchema: true },
    );
    if (rows.length > portablePersonalLimits.history) reject('too_large', 'too_large');
    await withStoredCookingHistoryEntries(session, options.sha256, async (read) => {
      for (let offset = 0; offset < rows.length; offset += COOKING_CONTENT_LIMITS.page) {
        const batch = rows.slice(offset, offset + COOKING_CONTENT_LIMITS.page);
        const keys = batch.map((row) => {
          stored(row.source);
          return { source: row.source, eventId: row.eventId };
        });
        const values = await read(keys);
        const indexed = new Map(values.map((row) => [`${row.source}:${row.value.eventId}`, row]));
        for (const row of batch) {
          const value = indexed.get(`${row.source}:${row.eventId}`);
          stored(value);
          const historyEpoch =
            'historyEpoch' in value.value ? value.value.historyEpoch : state.epoch;
          const revision = 'revision' in value.value ? value.value.revision : state.revision;
          stored(isRevision(historyEpoch) && isRevision(revision));
          const entry = { ...value.value, historyEpoch, revision };
          stored(
            entry.historyEpoch === state.epoch &&
              entry.revision > 0 &&
              entry.revision <= state.revision &&
              entry.cookedOn === row.cookedOn &&
              entry.recordedAt === row.recordedAt,
          );
          if (entry.readerVersion === 2) {
            // The SQL parent identifies imported data; the portable exact-entry format
            // carries no local storage origin and never becomes a saved-action receipt.
            const { origin: _origin, ...portable } = { origin: undefined, ...entry };
            cookingHistory.push({ kind: 'exact', entry: portable });
          } else cookingHistory.push({ kind: 'legacy', entry, pin: value.pin });
        }
      }
    });
  }
  options.assertActive();
  return {
    schemaVersion: 3 as const,
    databaseSchemaVersion,
    createdAt: options.now(),
    catalogue: { ...options.catalogue },
    sourceRevision: await readRevision(session, 'store'),
    data: {
      ...core,
      personal,
      planReferences,
      ...(includeCookingHistory ? { cookingHistory: { entries: cookingHistory } } : {}),
    },
  };
}
/** Caller owns the SQL snapshot and its access guard; captures no operation authority. */
export async function capturePortableContentBackupInSnapshot(
  session: SqlSession,
  options: PortableContentCaptureOptions,
  includeCookingHistory: boolean,
): Promise<Immutable<PortableContentBackupEnvelope>> {
  const input = await readPortableContentBackupInputInSnapshot(
    session,
    options,
    includeCookingHistory,
  );
  const value = await createPortableContentBackup(input, options.sha256);
  options.assertActive();
  return value;
}

/** Private schema7/8 capture. Exact references are metadata, never archive trust or restore authority. */
export function createPortableContentBackupReader(options: Options) {
  stored(isAppId(options.installationId));
  const baseline = Object.freeze(
    JSON.parse(canonicalContentJson(options.catalogue, 4096)) as CatalogueIdentity,
  );
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
    const value = await options.sha256(text);
    check();
    stored(/^[0-9a-f]{64}$/.test(value));
    return value;
  };
  async function capture(input?: {
    includeCookingHistory?: boolean;
  }): Promise<RepositoryResult<Immutable<PortableContentBackupEnvelope>>> {
    try {
      check();
      let selection: { includeCookingHistory?: boolean };
      try {
        selection = JSON.parse(canonicalContentJson(input === undefined ? {} : input, 256));
        if (
          !selection ||
          typeof selection !== 'object' ||
          Array.isArray(selection) ||
          Object.keys(selection).some((key) => key !== 'includeCookingHistory') ||
          (Object.hasOwn(selection, 'includeCookingHistory') &&
            typeof selection.includeCookingHistory !== 'boolean')
        )
          throw new Error();
      } catch {
        reject('invalid_options', 'invalid_input');
      }
      const snapshot = await options.reader.transaction(
        async (session) => {
          return readPortableContentBackupInputInSnapshot(
            session,
            {
              installationId: options.installationId,
              ownerId: scope.ownerId,
              catalogue: baseline,
              sha256,
              now: options.now,
              assertActive: check,
            },
            !!selection.includeCookingHistory,
          );
        },
        { kind: 'read_only' },
      );
      check();
      const value = await createPortableContentBackup(snapshot, sha256);
      check();
      return { kind: 'ready', value, revision: snapshot.sourceRevision };
    } catch (error) {
      // The codec deliberately wraps hash errors. Recheck ownership before translating those.
      try {
        check();
      } catch (scopeError) {
        error = scopeError;
      }
      return {
        kind: 'failed',
        error:
          error instanceof CaptureFault
            ? error.detail
            : {
                code:
                  error instanceof PortableBackupError && error.reason === 'too_large'
                    ? 'too_large'
                    : 'storage_failure',
                messageKey:
                  error instanceof PortableBackupError && error.reason === 'too_large'
                    ? 'backup.content_too_large'
                    : 'backup.content_export_failed',
                retry: 'after_correction',
              },
      };
    }
  }
  return Object.freeze({
    capture,
    close() {
      closed = true;
    },
  });
}
