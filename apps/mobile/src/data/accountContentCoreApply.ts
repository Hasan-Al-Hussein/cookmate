import { catalogueBoundary } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  OVERLAY_LIMITS,
  projectContentLookup,
  type ContentLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { catalogueMatches, isUtcInstant } from '@cookmate/contracts';
import { portableBackupLimits, type Immutable, type StoreChange } from '@cookmate/domain';
import {
  accountContentSnapshotFromBackup,
  normalizeAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../../../packages/account-sync/src/contentSnapshot';
import {
  canonicalPortableContentJson,
  validatePortableContentBackup,
  type PortableContentBackupEnvelope,
} from '../../../../packages/domain/src/portableBackupContent';
import {
  ACCOUNT_APPLY_EPOCH_KEY,
  fail,
  readBinding,
  readMetadata,
  revision as validRevision,
  uuid,
  writeMetadata,
} from './accountReplicationRecords';
import type { ContentReferenceInspectionView } from './contentReleaseStore';
import {
  readAdoptionInSnapshot,
  retainCookingRevisionInSnapshot,
} from './cookingContentRepository';
import { readPinnedShoppingContextInSnapshot } from './pinnedShoppingRepository';
import { capturePortableContentBackupInSnapshot } from './portableContentBackup';
import { withdrawPreferenceVersions } from './preferenceProvenance';
import { readRevision } from './query';
import {
  nextStoredRevision,
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from './shoppingRepository';
import { runBound, type SqlSession, type SqlValue } from './sql';
import { encodeStoredText } from './storedText';
import {
  assertAccountContentRemovalResolution,
  createAccountContentRemovalReview,
  type AccountContentRemovalResolution,
} from './accountContentRemovalReview';

export interface AccountContentCoreApplyOptions {
  view: ContentReferenceInspectionView;
  sha256(text: string): Promise<string>;
  now: string;
  revision: number;
  assertAccess(): undefined;
  removalResolution?: Immutable<AccountContentRemovalResolution>;
}
const canonical = canonicalPortableContentJson;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const refKey = (ref: Immutable<RecipeContentRef>) => canonicalContentJson(ref, 512);
function core(snapshot: Immutable<AccountContentSnapshot>) {
  const { favourites, plan, planReferences, shopping, preferences } = snapshot;
  return { favourites, plan, planReferences, shopping, preferences };
}
function portableCore(snapshot: Immutable<PortableContentBackupEnvelope>) {
  const { personal: _personal, cookingHistory: _history, ...value } = snapshot.data;
  return value;
}

/** Aggregate/typed clocks only: no personal/history payloads or operation authority are read. */
async function greatestRevision(session: SqlSession): Promise<number> {
  if ((await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8)
    fail('stored_data_invalid');
  let greatest = 0;
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
    ['cooking_session', ['revision']],
    ['app_content_adoption', ['revision']],
    ['personal_state', ['revision']],
    ['recipe_note', ['revision']],
    ['personal_collection', ['revision']],
    ['personal_collection_member', ['revision']],
    ['manual_shopping_item', ['revision']],
  ] as const) {
    for (const column of columns) {
      const [row] = await session.all<{ value: number | null; invalid: number }>(
        `SELECT MAX(CASE WHEN typeof(${column})='integer' THEN ${column} END) value,COALESCE(MAX(CASE WHEN ${column} IS NOT NULL AND (typeof(${column})<>'integer' OR ${column}<0 OR ${column}>9007199254740991) THEN 1 ELSE 0 END),0) invalid FROM ${table}`,
      );
      if (!row || row.invalid !== 0 || (row.value !== null && !validRevision(row.value)))
        fail('stored_data_invalid');
      greatest = Math.max(greatest, row.value ?? 0);
    }
  }
  const epoch = await readMetadata(session, ACCOUNT_APPLY_EPOCH_KEY, 32);
  if (epoch !== null && !validRevision(epoch)) fail('stored_data_invalid');
  return Math.max(greatest, epoch ?? 0);
}

/** Private schema8 metadata-only allocator. Caller admits owner/access and holds its transaction. */
export async function nextAccountContentApplyRevision(session: SqlSession): Promise<number> {
  return nextStoredRevision(await greatestRevision(session));
}

/** The shared withdrawal helper selects one sentinel per live link, so bound that cardinality
 * before using it. No message bodies, source-message IDs or stored preference text are copied here.
 */
async function admitPreferenceLinks(session: SqlSession) {
  const [row] = await session.all<{ count: number; invalid: number }>(
    `SELECT COUNT(*) count,COALESCE(SUM(CASE WHEN typeof(preference_id)<>'text' OR length(CAST(preference_id AS BLOB))<>36 OR typeof(saved_revision)<>'integer' OR saved_revision<0 OR saved_revision>9007199254740991 THEN 1 ELSE 0 END),0) invalid FROM source_preference_link WHERE removed_revision IS NULL`,
  );
  if (
    !row ||
    !validRevision(row.count) ||
    row.count > portableBackupLimits.preferenceRemovals ||
    row.invalid !== 0
  )
    fail('stored_data_invalid');
}

/** Read-only policy for the host's already validated, current capture. A live-only account
 * snapshot omits these local removals, so merge success/fingerprints cannot authorize revival.
 * Only an issued exact review can admit a selected restoration; a boolean cannot bypass it.
 */
export async function assertAccountContentCoreRemovalAdmission(
  session: SqlSession,
  candidate: Immutable<AccountContentSnapshot>,
  before: Immutable<PortableContentBackupEnvelope>,
  resolution?: Immutable<AccountContentRemovalResolution>,
): Promise<void> {
  const archivePresent =
    (await session.all('SELECT 1 FROM portable_restore_operation LIMIT 1')).length > 0;
  if (resolution) {
    assertAccountContentRemovalResolution(resolution, candidate, before, archivePresent);
    return;
  }
  if (createAccountContentRemovalReview(candidate, before, archivePresent).conflicts.length)
    fail('recovery_required');
}

/**
 * Private schema8 core data apply inside the host's held content reservation and SQL transaction.
 * The host owns exact reviewed merge/capture authority, installation/auth/adoption/restore fencing,
 * and final COMMIT/postack guards. Apply core first, then personal/history, then its existing journal.
 * No personal/history/settings/journal or operation receipts are written by this primitive.
 */
export async function applyAccountContentCore(
  raw: SqlSession,
  ownerId: string,
  candidateInput: Immutable<AccountContentSnapshot>,
  beforePortableInput: Immutable<PortableContentBackupEnvelope>,
  beforeAccountInput: Immutable<AccountContentSnapshot>,
  options: AccountContentCoreApplyOptions,
): Promise<StoreChange> {
  const { view, sha256: hashPort, now, revision, assertAccess } = options;
  if (!uuid(ownerId) || !isUtcInstant(now) || !validRevision(revision) || revision === 0)
    fail('invalid_input');
  const active = (): undefined => {
    if (assertAccess() !== undefined || view.assertActive() !== undefined) fail('account_changed');
    return undefined;
  };
  active();
  // Every caller-owned data input is copied before the first SQL/hash await.
  const candidate = normalizeAccountContentSnapshot(candidateInput),
    beforeAccount = normalizeAccountContentSnapshot(beforeAccountInput),
    portableBytes = canonical(beforePortableInput),
    head = JSON.parse(
      canonicalContentJson(view.head, 1024),
    ) as ContentReferenceInspectionView['head'];
  const adopted: unknown = JSON.parse(canonical(view.adoptedRecipeIds, 512 * 1024));
  if (
    !Array.isArray(adopted) ||
    adopted.length > OVERLAY_LIMITS.overrides + catalogueBoundary.recipeIds.size ||
    !adopted.every((id) => typeof id === 'string' && /^[0-9]{1,20}$/.test(id)) ||
    new Set(adopted).size !== adopted.length
  )
    fail('stored_data_invalid');
  const identities = new Set<string>(adopted);
  const entries = view.entries;
  if (!Array.isArray(entries) || entries.length > OVERLAY_LIMITS.retainedRefs)
    fail('stored_data_invalid');
  const lookups = new Map<string, ContentLookup>();
  for (const entry of entries) {
    const key = refKey(entry.ref);
    if (lookups.has(key)) fail('stored_data_invalid');
    lookups.set(key, entry.lookup);
  }
  active();
  const session: SqlSession = {
    async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
      active();
      const value = await raw.all<Row>(sql, values);
      active();
      return value;
    },
    async exec(sql) {
      active();
      await raw.exec(sql);
      active();
    },
    async prepare(sql) {
      active();
      const statement = await raw.prepare(sql);
      try {
        active();
      } catch (error) {
        await statement.finalize();
        throw error;
      }
      return {
        async run(values) {
          active();
          await statement.run(values);
          active();
        },
        async finalize() {
          await statement.finalize();
          active();
        },
      };
    },
  };
  const sha256 = async (text: string) => {
    active();
    const value = await hashPort(text);
    active();
    if (!/^[0-9a-f]{64}$/.test(value)) fail('stored_data_invalid');
    return value;
  };
  if (
    (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8 ||
    (await session.all<{ foreign_keys: number }>('PRAGMA foreign_keys'))[0]?.foreign_keys !== 1
  )
    fail('stored_data_invalid');
  if ((await readBinding(session)) !== ownerId) fail('different_data_owner');
  if ((await session.all('SELECT 1 FROM pragma_foreign_key_check LIMIT 1')).length)
    fail('stored_data_invalid');
  if (!same((await readAdoptionInSnapshot(session)).head, head)) fail('local_changed');
  const validated = await validatePortableContentBackup(portableBytes, { sha256 });
  if (validated.kind !== 'ready' || validated.value.databaseSchemaVersion !== 8)
    fail('invalid_input');
  const before = validated.value;
  if (
    !catalogueMatches(candidate.catalogue, before.catalogue) ||
    !catalogueMatches(beforeAccount.catalogue, before.catalogue)
  )
    fail('invalid_input');
  const projected = await accountContentSnapshotFromBackup(
    before,
    { appPreferences: beforeAccount.appPreferences, profile: beforeAccount.profile },
    { schemaVersion: 3, includeCookingHistory: false },
    sha256,
  );
  if (!same(core(projected), core(beforeAccount))) fail('local_changed');
  const [installation] = await session.all<{ id: string | null }>(
    "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
  );
  if (!uuid(installation?.id)) fail('stored_data_invalid');
  const actual = await capturePortableContentBackupInSnapshot(
    session,
    {
      installationId: installation.id,
      ownerId,
      catalogue: before.catalogue,
      sha256,
      now: () => now,
      assertActive: active,
    },
    false,
  );
  if (
    actual.sourceRevision !== before.sourceRevision ||
    !same(portableCore(actual), portableCore(before))
  )
    fail('local_changed');
  await assertAccountContentCoreRemovalAdmission(
    session,
    candidate,
    before,
    options.removalResolution,
  );
  if (revision <= (await greatestRevision(session))) fail('local_changed');
  await admitPreferenceLinks(session);
  const ports = {
    sha256,
    lookupExact: (ref: RecipeContentRef) => {
      active();
      return projectContentLookup(lookups.get(refKey(ref)) ?? { kind: 'missing' });
    },
  };
  // Only selected saved pins need body access; an unused withdrawn plan can be retained/removed.
  const oldContext = await readPinnedShoppingContextInSnapshot(session, ports),
    ledger = await readShoppingLedgerInSnapshot(session, oldContext.options),
    scopeId = ledger.snapshot.scope.scopeId;
  const previousRefs = new Map(
    before.data.planReferences.map((row) => [row.occurrenceId, row.contentRef]),
  );
  const refs = new Map(candidate.planReferences.map((row) => [row.occurrenceId, row.contentRef]));
  const newIds = [
    ...new Set([
      ...candidate.favourites.map((row) => row.recipeId),
      ...candidate.plan.map((row) => row.recipeId),
    ]),
  ];
  if (newIds.some((id) => !identities.has(id))) fail('invalid_input');
  // Same exact saved occurrence pins remain local integrity evidence, not authority for new bodies.
  const retained = new Set<string>();
  for (const row of candidate.planReferences) {
    const key = refKey(row.contentRef);
    if (same(previousRefs.get(row.occurrenceId) ?? null, row.contentRef) || retained.has(key))
      continue;
    const lookup = lookups.get(key);
    if (lookup?.kind !== 'readable' || !same(lookup.value.revision.ref, row.contentRef))
      fail('invalid_input');
    await retainCookingRevisionInSnapshot(session, lookup.value.revision, sha256);
    retained.add(key);
  }
  for (let offset = 0; offset < newIds.length; offset += 400) {
    const batch = newIds.slice(offset, offset + 400),
      existing = await session.all<{ id: string }>(
        `SELECT recipe_id id FROM recipe_identity WHERE recipe_id IN (${batch.map(() => '?').join(',')})`,
        batch,
      ),
      known = new Set(existing.map((row) => row.id));
    for (const id of batch)
      if (!known.has(id)) await runBound(session, 'INSERT INTO recipe_identity VALUES (?)', [id]);
  }
  const collections: StoreChange['collections'][number][] = [];
  if (!same(beforeAccount.favourites, candidate.favourites)) {
    const next = new Map(candidate.favourites.map((row) => [row.recipeId, row])),
      old = new Map(before.data.favourites.map((row) => [row.recipeId, row]));
    for (const row of before.data.favourites)
      if (row.saved && !next.has(row.recipeId))
        await runBound(
          session,
          'UPDATE favourite SET saved=0,revision=?,updated_at=? WHERE recipe_id=?',
          [revision, now, row.recipeId],
        );
    for (const row of candidate.favourites)
      if (!old.get(row.recipeId)?.saved || old.get(row.recipeId)?.savedAt !== row.savedAt)
        await runBound(
          session,
          'INSERT INTO favourite VALUES (?,?,?,?,?) ON CONFLICT(recipe_id) DO UPDATE SET saved=1,revision=excluded.revision,saved_at=excluded.saved_at,updated_at=excluded.updated_at',
          [row.recipeId, 1, revision, row.savedAt, now],
        );
    collections.push('favourites');
  }
  const planChanged =
      !same(beforeAccount.plan, candidate.plan) ||
      !same(beforeAccount.planReferences, candidate.planReferences),
    selectionChanged = !same(
      beforeAccount.shopping.selectedOccurrenceIds,
      candidate.shopping.selectedOccurrenceIds,
    ),
    marksChanged = !same(beforeAccount.shopping.purchaseMarks, candidate.shopping.purchaseMarks);
  if (planChanged || selectionChanged || marksChanged) {
    if (planChanged || selectionChanged) {
      await runBound(session, 'DELETE FROM shopping_contribution WHERE scope_id=?', [scopeId]);
      await runBound(session, 'DELETE FROM shopping_selection WHERE scope_id=?', [scopeId]);
      if (planChanged) {
        const old = new Map(before.data.occurrences.map((row) => [row.occurrenceId, row]));
        await session.exec('DELETE FROM plan_content_pin');
        await session.exec('DELETE FROM plan_occurrence');
        for (const row of candidate.plan) {
          const previous = old.get(row.occurrenceId),
            ref = refs.get(row.occurrenceId)!;
          const unchanged =
            previous &&
            same({ ...previous, revision: 0 }, { ...row, revision: 0 }) &&
            same(previousRefs.get(row.occurrenceId), ref);
          await runBound(session, 'INSERT INTO plan_occurrence VALUES (?,?,?,?,?,?,?)', [
            row.occurrenceId,
            row.recipeId,
            row.placement.actualDate,
            row.placement.mealKey,
            unchanged ? previous.revision : revision,
            row.createdAt,
            row.updatedAt,
          ]);
          await runBound(session, 'INSERT INTO plan_content_pin VALUES (?,?,?,?)', [
            row.occurrenceId,
            ref.recipeId,
            ref.revisionId,
            ref.contentFingerprint,
          ]);
        }
        collections.push('plan');
      }
      for (const id of candidate.shopping.selectedOccurrenceIds)
        await runBound(session, 'INSERT INTO shopping_selection VALUES (?,?)', [scopeId, id]);
      const nextContext = await readPinnedShoppingContextInSnapshot(session, ports);
      await rebuildShoppingInSnapshot(session, ledger, nextContext.options);
    }
    const context = await readPinnedShoppingContextInSnapshot(session, ports),
      rebuilt = await readShoppingLedgerInSnapshot(session, context.options),
      marks = new Map(candidate.shopping.purchaseMarks.map((row) => [row.groupKey, row]));
    for (const group of rebuilt.groups) {
      const mark = marks.get(group.groupKey),
        matches =
          group.projectionRevision === rebuilt.snapshot.projectionRevision &&
          mark &&
          mark.groupingVersion === group.groupingVersion &&
          mark.demandFingerprint === group.demandFingerprint;
      const purchased = matches && mark.purchased ? 1 : 0,
        changed = matches ? (mark.changed ? 1 : 0) : 1;
      if (group.purchased !== purchased || group.changed !== changed)
        await runBound(
          session,
          'UPDATE purchase_state SET purchased=?,changed=?,revision=? WHERE scope_id=? AND group_key=?',
          [purchased, changed, revision, scopeId, group.groupKey],
        );
    }
    await runBound(session, 'UPDATE shopping_scope SET revision=? WHERE scope_id=?', [
      revision,
      scopeId,
    ]);
    collections.push('shopping');
  }
  if (!same(beforeAccount.preferences, candidate.preferences)) {
    const next = new Map(candidate.preferences.map((row) => [row.preferenceId, row])),
      old = new Map(before.data.preferences.snapshot.items.map((row) => [row.preferenceId, row]));
    const withdrawn = before.data.preferences.snapshot.items.filter((row) => {
      const proposed = next.get(row.preferenceId);
      return !proposed || proposed.type !== row.type || proposed.value !== row.value;
    });
    const conversationChanged = await withdrawPreferenceVersions(session, withdrawn, revision);
    for (const row of withdrawn)
      await runBound(session, 'DELETE FROM saved_preference WHERE preference_id=?', [
        row.preferenceId,
      ]);
    for (const row of candidate.preferences) {
      const previous = old.get(row.preferenceId);
      if (!previous || previous.type !== row.type || previous.value !== row.value)
        await runBound(session, 'INSERT INTO saved_preference VALUES (?,?,?,?)', [
          row.preferenceId,
          row.type,
          encodeStoredText(row.value),
          revision,
        ]);
    }
    collections.push('preferences');
    if (conversationChanged) collections.push('conversation');
  }
  // Like the existing account apply, even identical core data invalidates earlier direct reviews.
  for (const collection of ['store', ...collections])
    await runBound(session, 'UPDATE state_revision SET revision=? WHERE collection=?', [
      revision,
      collection,
    ]);
  await writeMetadata(session, ACCOUNT_APPLY_EPOCH_KEY, revision, 32);
  const finalContext = await readPinnedShoppingContextInSnapshot(session, ports);
  await readShoppingLedgerInSnapshot(session, finalContext.options);
  // Retained favourite tombstones/provenance can outlive the incoming wire rows. Admit the
  // resulting stored projection too, so replacement cannot commit an unreadable over-limit store.
  await capturePortableContentBackupInSnapshot(
    session,
    {
      installationId: installation.id,
      ownerId,
      catalogue: before.catalogue,
      sha256,
      now: () => now,
      assertActive: active,
    },
    false,
  );
  if (
    (await session.all('SELECT 1 FROM pragma_foreign_key_check LIMIT 1')).length ||
    (await readRevision(session, 'store')) !== revision
  )
    fail('stored_data_invalid');
  active();
  return { revision, collections };
}
