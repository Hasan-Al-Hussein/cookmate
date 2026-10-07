import { isUtcInstant } from '@cookmate/contracts';
import type { ContractError } from '@cookmate/contracts';
import { manualShoppingCategories, personalLimits } from '@cookmate/domain';
import type {
  CommandPlatform,
  CollectionMembership,
  DeleteCollectionReview,
  Immutable,
  ManualShoppingFields,
  PersonalChange,
  PersonalCollectionSummary,
  PersonalCommand,
  PersonalMutationResult,
  PersonalReceipt,
  PersonalService,
  RecipeNote,
  RepositoryResult,
} from '@cookmate/domain';
import { isAppId, isRevision } from './conversationRecords';
import { freezeResult, readRevision } from './query';
import { encodeStoredText } from './storedText';
import { runBound } from './sql';
import type { SerializedReader, SerializedWriter, SqlSession } from './sql';
import {
  collectionColumns,
  manualColumns,
  membershipColumns,
  noteColumns,
  parseCollection,
  parseManual,
  parseMembership,
  parseNote,
  personalExact,
  personalHash,
  personalObject,
  personalPositive,
  personalText,
  readPersonalReceipt,
  readPersonalState,
  requirePersonalRecord,
} from './personalRecords';
import type {
  CollectionRow,
  ManualRow,
  MembershipRow,
  NoteRow,
  PersonalState,
} from './personalRecords';

interface Options {
  reader: Pick<SerializedReader, 'transaction'>;
  writer: Pick<SerializedWriter, 'transaction' | 'requiresRecovery'>;
  platform: CommandPlatform;
  recipeIds: ReadonlySet<string>;
  now(): string;
  onCommitted(change: PersonalChange): void;
  /** Private host only: guarded transactions and authenticated identity admission are mandatory. */
  privatePersonal?: {
    schemaVersion: 8;
    commandKinds: readonly PersonalCommand['kind'][];
    beforeSaveNote?(session: SqlSession, recipeId: string): Promise<void>;
    beforeSetCollectionMembership?(session: SqlSession, recipeId: string): Promise<void>;
    beforeDeleteCollection?(review: Immutable<DeleteCollectionReview>): void;
  };
}
class PersonalFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function fault(key: string, code: ContractError['code'] = 'invalid_input'): never {
  throw new PersonalFault({ code, messageKey: `personal.${key}`, retry: 'after_correction' });
}
const failed = (error: unknown) => ({
  kind: 'failed' as const,
  error:
    error instanceof PersonalFault
      ? error.detail
      : {
          code: 'storage_failure' as const,
          messageKey: 'personal.storage_failure',
          retry: 'after_correction' as const,
        },
});
const next = (revision: number) => {
  requirePersonalRecord(isRevision(revision) && Number.isSafeInteger(revision + 1));
  return revision + 1;
};
const encode = (value: string | null) => (value === null ? null : encodeStoredText(value));
const emptyChange = { notes: false, collections: false, manualShopping: false };
type Effect = {
  entityId: string;
  changed: boolean;
  affectedMemberships: number;
  change: typeof emptyChange;
};
const effect = (
  entityId: string,
  changed: boolean,
  collection: keyof typeof emptyChange,
  affectedMemberships = 0,
): Effect => ({
  entityId,
  changed,
  affectedMemberships,
  change: { ...emptyChange, [collection]: changed },
});

/** Deliberately separate from ingredient projection, AI context and command-wire storage. */
export function createPersonalRepository(options: Options): PersonalService & {
  readState(): Promise<RepositoryResult<Immutable<PersonalState>>>;
  readRecipeNote(
    recipeId: string,
  ): Promise<RepositoryResult<Immutable<{ epoch: number; note: RecipeNote | null }>>>;
  readRecipeMemberships(
    recipeId: string,
  ): Promise<RepositoryResult<Immutable<{ epoch: number; memberships: CollectionMembership[] }>>>;
  close(): void;
  notifyRestored(revision: number): void;
} {
  const listeners = new Set<(change: PersonalChange) => void>();
  const reviews = new WeakMap<object, Immutable<DeleteCollectionReview>>();
  const requireRecipe = (recipeId: unknown): string => {
    if (typeof recipeId !== 'string' || !options.recipeIds.has(recipeId)) fault('unknown_recipe');
    return recipeId;
  };
  const timestamp = () => {
    const value = options.now();
    requirePersonalRecord(isUtcInstant(value));
    return value;
  };
  const read = async <T>(
    work: (session: SqlSession, current: PersonalState) => Promise<T>,
  ): Promise<RepositoryResult<Immutable<T>>> => {
    try {
      return await options.reader.transaction(async (session) => ({
        kind: 'ready' as const,
        revision: await readRevision(session, 'store'),
        value: freezeResult(
          await work(
            session,
            await readPersonalState(session, options.privatePersonal?.schemaVersion),
          ),
        ) as Immutable<T>,
      }));
    } catch (error) {
      return failed(error);
    }
  };
  const note = async (session: SqlSession, id: string, byRecipe = false) => {
    const row = (
      await session.all<NoteRow>(
        `SELECT ${noteColumns} FROM recipe_note WHERE ${byRecipe ? 'recipe_id' : 'note_id'}=?`,
        [id],
      )
    )[0];
    return row ? parseNote(row) : null;
  };
  const collection = async (session: SqlSession, id: string) => {
    if (!isAppId(id)) fault('invalid_collection');
    const row = (
      await session.all<CollectionRow>(
        `SELECT ${collectionColumns} FROM personal_collection WHERE collection_id=?`,
        [id],
      )
    )[0];
    return row ? parseCollection(row) : null;
  };
  const manual = async (session: SqlSession, id: string) => {
    const row = (
      await session.all<ManualRow>(
        `SELECT ${manualColumns} FROM manual_shopping_item WHERE item_id=?`,
        [id],
      )
    )[0];
    return row ? parseManual(row) : null;
  };
  const membership = async (session: SqlSession, collectionId: string, recipeId: string) => {
    const row = (
      await session.all<MembershipRow>(
        `SELECT ${membershipColumns} FROM personal_collection_member WHERE collection_id=? AND recipe_id=?`,
        [collectionId, recipeId],
      )
    )[0];
    return row ? parseMembership(row) : null;
  };
  const recipeMemberships = async (session: SqlSession, recipeId: string) =>
    (
      await session.all<MembershipRow>(
        `SELECT ${membershipColumns} FROM personal_collection_member WHERE recipe_id=? AND collection_id IN (SELECT collection_id FROM personal_collection WHERE deleted=0) ORDER BY collection_id`,
        [requireRecipe(recipeId)],
      )
    ).map(parseMembership);
  const activeCollection = async (session: SqlSession, id: string) => {
    const item = await collection(session, id);
    if (!item || item.deleted) fault('collection_missing', 'stale_context');
    return item;
  };
  const memberIds = async (session: SqlSession, id: string) =>
    (
      await session.all<{ recipeId: string }>(
        'SELECT recipe_id AS recipeId FROM personal_collection_member WHERE collection_id=? AND present=1 ORDER BY recipe_id',
        [id],
      )
    ).map((row) => {
      requirePersonalRecord(options.recipeIds.has(row.recipeId));
      return row.recipeId;
    });
  const collectionSummary = async (
    session: SqlSession,
    id: string,
  ): Promise<PersonalCollectionSummary> => ({
    ...(await activeCollection(session, id)),
    memberCount: (await memberIds(session, id)).length,
  });
  const checkRevision = (
    actual: number | null,
    expected: number | null,
    current: PersonalState,
  ) => {
    requirePersonalRecord(actual === null || actual <= current.revision);
    if (actual !== expected) fault('entity_changed', 'stale_context');
  };
  const hashRequest = async (value: unknown) => {
    const hash = await options.platform.sha256(JSON.stringify(value));
    requirePersonalRecord(personalHash(hash));
    return hash;
  };
  const publish = (change: PersonalChange) => {
    const owned = freezeResult(change);
    try {
      options.onCommitted(owned);
    } catch {
      /* A consumer cannot undo a commit. */
    }
    for (const listener of [...listeners])
      try {
        listener(owned);
      } catch {
        /* Isolate consumers. */
      }
  };
  const transact = async (
    operationId: string,
    fingerprint: string | null,
    kind: PersonalReceipt['commandKind'],
    work:
      | ((
          session: SqlSession,
          current: PersonalState,
          revision: number,
          at: string,
        ) => Promise<Effect>)
      | null,
  ): Promise<PersonalMutationResult> => {
    let change: PersonalChange | undefined;
    const proof = async (session: SqlSession) => {
      const stored = await readPersonalReceipt(session, operationId);
      if (
        stored &&
        (fingerprint === null ||
          stored.receipt.outcome === 'cancelled' ||
          stored.requestFingerprint === fingerprint)
      )
        return stored.receipt;
      return null;
    };
    try {
      const result = await options.writer.transaction(
        async (session) => {
          const current = await readPersonalState(session, options.privatePersonal?.schemaVersion);
          const existing = await readPersonalReceipt(session, operationId);
          if (existing) {
            if (
              fingerprint !== null &&
              existing.receipt.outcome !== 'cancelled' &&
              existing.requestFingerprint !== fingerprint
            )
              fault('operation_conflict');
            return {
              kind: 'ready' as const,
              revision: await readRevision(session, 'store'),
              value: freezeResult(existing.receipt),
            };
          }
          const at = timestamp();
          const applied = work ? await work(session, current, next(current.revision), at) : null;
          const revision = applied?.changed ? next(current.revision) : current.revision;
          const value: PersonalReceipt = {
            operationId,
            outcome: applied ? (applied.changed ? 'committed' : 'no_op') : 'cancelled',
            commandKind: kind,
            entityId: applied?.entityId ?? null,
            revision,
            epoch: current.epoch,
            committedAt: at,
            affectedMemberships: applied?.affectedMemberships ?? 0,
          };
          if (applied?.changed)
            await runBound(session, 'UPDATE personal_state SET revision=? WHERE singleton=1', [
              revision,
            ]);
          await runBound(session, 'INSERT INTO personal_operation VALUES (?,?,?)', [
            operationId,
            fingerprint,
            JSON.stringify(value),
          ]);
          const storeRevision = next(await readRevision(session, 'store'));
          await runBound(session, "UPDATE state_revision SET revision=? WHERE collection='store'", [
            storeRevision,
          ]);
          change = { revision: storeRevision, ...(applied?.change ?? emptyChange) };
          return { kind: 'ready' as const, revision: storeRevision, value: freezeResult(value) };
        },
        { kind: 'none' },
      );
      if (change) publish(change);
      return result;
    } catch (error) {
      const recovered = await read(proof);
      if (recovered.kind === 'ready' && recovered.value) {
        if (change) publish({ ...change, revision: recovered.revision });
        return { ...recovered, value: recovered.value };
      }
      if (options.writer.requiresRecovery() || recovered.kind === 'failed')
        return { kind: 'uncertain', operationId, error: failed(error).error };
      return failed(error);
    }
  };
  const fields = (value: unknown): ManualShoppingFields => {
    if (
      !personalObject(value) ||
      !personalExact(value, ['name', 'amountText', 'unitText', 'category']) ||
      !personalText(value.name, personalLimits.itemNameCharacters) ||
      !(
        value.amountText === null || personalText(value.amountText, personalLimits.amountCharacters)
      ) ||
      !(value.unitText === null || personalText(value.unitText, personalLimits.unitCharacters)) ||
      !manualShoppingCategories.includes(value.category as ManualShoppingFields['category'])
    )
      fault('invalid_manual_fields');
    return {
      name: value.name,
      amountText: value.amountText,
      unitText: value.unitText,
      category: value.category as ManualShoppingFields['category'],
    };
  };
  const validate = (input: Immutable<PersonalCommand>): PersonalCommand => {
    const value: unknown = JSON.parse(JSON.stringify(input));
    if (!personalObject(value) || !isAppId(value.operationId) || !isRevision(value.expectedEpoch))
      fault('invalid_command');
    const base = ['operationId', 'expectedEpoch', 'kind'];
    const keys: Record<PersonalCommand['kind'], string[]> = {
      saveNote: ['noteId', 'recipeId', 'expectedRevision', 'text'],
      deleteNote: ['noteId', 'expectedRevision'],
      createCollection: ['collectionId', 'name'],
      renameCollection: ['collectionId', 'expectedRevision', 'name'],
      setCollectionMembership: [
        'collectionId',
        'recipeId',
        'expectedCollectionRevision',
        'expectedRevision',
        'present',
      ],
      addManualItem: ['itemId', 'fields'],
      editManualItem: ['itemId', 'expectedRevision', 'fields'],
      setManualPurchased: ['itemId', 'expectedRevision', 'purchased'],
      deleteManualItem: ['itemId', 'expectedRevision'],
    };
    if (
      typeof value.kind !== 'string' ||
      !Object.hasOwn(keys, value.kind) ||
      !personalExact(value, [...base, ...keys[value.kind as PersonalCommand['kind']]])
    )
      fault('invalid_command');
    for (const key of ['noteId', 'collectionId', 'itemId'])
      if (key in value && !isAppId(value[key])) fault('invalid_identity');
    if ('recipeId' in value) requireRecipe(value.recipeId);
    if (
      'expectedRevision' in value &&
      !(
        (value.expectedRevision === null &&
          ['saveNote', 'setCollectionMembership'].includes(value.kind)) ||
        personalPositive(value.expectedRevision)
      )
    )
      fault('invalid_revision');
    if (value.kind === 'saveNote' && !personalText(value.text, personalLimits.noteCharacters))
      fault('invalid_note');
    if (
      ['createCollection', 'renameCollection'].includes(value.kind) &&
      !personalText(value.name, personalLimits.collectionNameCharacters)
    )
      fault('invalid_name');
    if (
      value.kind === 'setCollectionMembership' &&
      (!personalPositive(value.expectedCollectionRevision) || typeof value.present !== 'boolean')
    )
      fault('invalid_membership');
    if (value.kind === 'setManualPurchased' && typeof value.purchased !== 'boolean')
      fault('invalid_purchase');
    if ('fields' in value) value.fields = fields(value.fields);
    // Stable field ordering prevents object-construction order from changing an operation identity.
    return Object.fromEntries(
      [...base, ...keys[value.kind as PersonalCommand['kind']]].map((key) => [key, value[key]]),
    ) as unknown as PersonalCommand;
  };
  const execute: PersonalService['execute'] = async (input) => {
    try {
      const command = validate(input);
      if (options.privatePersonal && !options.privatePersonal.commandKinds.includes(command.kind))
        fault('unsupported_private_command');
      const fingerprint = await hashRequest(command);
      return transact(
        command.operationId,
        fingerprint,
        command.kind,
        async (session, current, revision, at) => {
          if (command.expectedEpoch !== current.epoch) fault('epoch_changed', 'stale_context');
          switch (command.kind) {
            case 'saveNote': {
              const before = await note(session, command.recipeId, true);
              checkRevision(before?.revision ?? null, command.expectedRevision, current);
              if (
                (before && before.noteId !== command.noteId) ||
                (!before && (await note(session, command.noteId)))
              )
                fault('note_identity_changed', 'stale_context');
              if (before && !before.deleted && before.text === command.text)
                return effect(command.noteId, false, 'notes');
              await options.privatePersonal?.beforeSaveNote?.(session, command.recipeId);
              await runBound(
                session,
                'INSERT INTO recipe_note VALUES (?,?,?,0,?,?,?) ON CONFLICT(recipe_id) DO UPDATE SET text=excluded.text,deleted=0,revision=excluded.revision,updated_at=excluded.updated_at',
                [
                  command.noteId,
                  command.recipeId,
                  encodeStoredText(command.text),
                  revision,
                  before?.createdAt ?? at,
                  at,
                ],
              );
              return effect(command.noteId, true, 'notes');
            }
            case 'deleteNote': {
              const before = await note(session, command.noteId);
              checkRevision(before?.revision ?? null, command.expectedRevision, current);
              if (before!.deleted) return effect(command.noteId, false, 'notes');
              await runBound(
                session,
                'UPDATE recipe_note SET text=NULL,deleted=1,revision=?,updated_at=? WHERE note_id=?',
                [revision, at, command.noteId],
              );
              return effect(command.noteId, true, 'notes');
            }
            case 'createCollection': {
              if (await collection(session, command.collectionId))
                fault('collection_exists', 'stale_context');
              const count = (
                await session.all<{ count: number }>(
                  'SELECT COUNT(*) AS count FROM personal_collection WHERE deleted=0',
                )
              )[0]!.count;
              if (count >= personalLimits.collections) fault('collection_limit', 'too_large');
              await runBound(session, 'INSERT INTO personal_collection VALUES (?,?,0,?,?,?)', [
                command.collectionId,
                encodeStoredText(command.name),
                revision,
                at,
                at,
              ]);
              return effect(command.collectionId, true, 'collections');
            }
            case 'renameCollection': {
              const before = await activeCollection(session, command.collectionId);
              checkRevision(before.revision, command.expectedRevision, current);
              if (before.name === command.name)
                return effect(command.collectionId, false, 'collections');
              await runBound(
                session,
                'UPDATE personal_collection SET name=?,revision=?,updated_at=? WHERE collection_id=?',
                [encodeStoredText(command.name), revision, at, command.collectionId],
              );
              return effect(command.collectionId, true, 'collections');
            }
            case 'setCollectionMembership': {
              const parent = await activeCollection(session, command.collectionId);
              checkRevision(parent.revision, command.expectedCollectionRevision, current);
              const before = await membership(session, command.collectionId, command.recipeId);
              checkRevision(before?.revision ?? null, command.expectedRevision, current);
              if ((before?.present ?? false) === command.present)
                return effect(command.collectionId, false, 'collections');
              await options.privatePersonal?.beforeSetCollectionMembership?.(
                session,
                command.recipeId,
              );
              await runBound(
                session,
                'INSERT INTO personal_collection_member VALUES (?,?,?,?,?) ON CONFLICT(collection_id,recipe_id) DO UPDATE SET present=excluded.present,revision=excluded.revision,updated_at=excluded.updated_at',
                [command.collectionId, command.recipeId, command.present ? 1 : 0, revision, at],
              );
              await runBound(
                session,
                'UPDATE personal_collection SET revision=?,updated_at=? WHERE collection_id=?',
                [revision, at, command.collectionId],
              );
              return effect(command.collectionId, true, 'collections', 1);
            }
            case 'addManualItem': {
              if (await manual(session, command.itemId))
                fault('manual_item_exists', 'stale_context');
              const count = (
                await session.all<{ count: number }>(
                  'SELECT COUNT(*) AS count FROM manual_shopping_item WHERE deleted=0',
                )
              )[0]!.count;
              if (count >= personalLimits.manualItems) fault('manual_item_limit', 'too_large');
              const values = command.fields;
              await runBound(
                session,
                'INSERT INTO manual_shopping_item VALUES (?,?,?,?,?,0,0,?,?,?)',
                [
                  command.itemId,
                  encodeStoredText(values.name),
                  encode(values.amountText),
                  encode(values.unitText),
                  values.category,
                  revision,
                  at,
                  at,
                ],
              );
              return effect(command.itemId, true, 'manualShopping');
            }
            case 'editManualItem':
            case 'setManualPurchased':
            case 'deleteManualItem': {
              const before = await manual(session, command.itemId);
              checkRevision(before?.revision ?? null, command.expectedRevision, current);
              if (before!.deleted) {
                if (command.kind === 'deleteManualItem')
                  return effect(command.itemId, false, 'manualShopping');
                fault('manual_item_deleted', 'stale_context');
              }
              if (command.kind === 'deleteManualItem')
                await runBound(
                  session,
                  'UPDATE manual_shopping_item SET name=NULL,amount_text=NULL,unit_text=NULL,category=NULL,purchased=0,deleted=1,revision=?,updated_at=? WHERE item_id=?',
                  [revision, at, command.itemId],
                );
              else if (command.kind === 'setManualPurchased') {
                if (before!.purchased === command.purchased)
                  return effect(command.itemId, false, 'manualShopping');
                await runBound(
                  session,
                  'UPDATE manual_shopping_item SET purchased=?,revision=?,updated_at=? WHERE item_id=?',
                  [command.purchased ? 1 : 0, revision, at, command.itemId],
                );
              } else {
                const values = command.fields;
                if (
                  before!.name === values.name &&
                  before!.amountText === values.amountText &&
                  before!.unitText === values.unitText &&
                  before!.category === values.category
                )
                  return effect(command.itemId, false, 'manualShopping');
                // A category-only correction does not change what the user already purchased.
                const purchased =
                  before!.purchased &&
                  before!.name === values.name &&
                  before!.amountText === values.amountText &&
                  before!.unitText === values.unitText;
                await runBound(
                  session,
                  'UPDATE manual_shopping_item SET name=?,amount_text=?,unit_text=?,category=?,purchased=?,revision=?,updated_at=? WHERE item_id=?',
                  [
                    encodeStoredText(values.name),
                    encode(values.amountText),
                    encode(values.unitText),
                    values.category,
                    purchased ? 1 : 0,
                    revision,
                    at,
                    command.itemId,
                  ],
                );
              }
              return effect(command.itemId, true, 'manualShopping');
            }
          }
        },
      );
    } catch (error) {
      return failed(error);
    }
  };
  const reviewDeleteCollection: PersonalService['reviewDeleteCollection'] = (id) =>
    read(async (session, current) => {
      const item = await activeCollection(session, id);
      const review = freezeResult({
        reviewId: options.platform.newId(),
        collectionId: id,
        name: item.name!,
        expectedRevision: item.revision,
        epoch: current.epoch,
        affectedRecipeIds: await memberIds(session, id),
      });
      requirePersonalRecord(isAppId(review.reviewId));
      reviews.set(review, review);
      return review;
    });
  const deleteCollection: PersonalService['deleteCollection'] = async (review, operationId) => {
    try {
      if (!isAppId(operationId)) fault('invalid_operation');
      const fingerprint = await hashRequest([
        'deleteCollection',
        review.reviewId,
        review.collectionId,
        review.expectedRevision,
        review.epoch,
        review.affectedRecipeIds,
      ]);
      return transact(
        operationId,
        fingerprint,
        'deleteCollection',
        async (session, current, revision, at) => {
          const issued = reviews.get(review);
          if (!issued) fault('delete_review_required', 'stale_context');
          options.privatePersonal?.beforeDeleteCollection?.(issued);
          if (current.epoch !== issued.epoch) fault('epoch_changed', 'stale_context');
          const parent = await activeCollection(session, issued.collectionId);
          checkRevision(parent.revision, issued.expectedRevision, current);
          const members = await memberIds(session, issued.collectionId);
          if (
            parent.name !== issued.name ||
            JSON.stringify(members) !== JSON.stringify(issued.affectedRecipeIds)
          )
            fault('membership_changed', 'stale_context');
          await runBound(
            session,
            'UPDATE personal_collection_member SET present=0,revision=?,updated_at=? WHERE collection_id=? AND present=1',
            [revision, at, issued.collectionId],
          );
          await runBound(
            session,
            'UPDATE personal_collection SET name=NULL,deleted=1,revision=?,updated_at=? WHERE collection_id=?',
            [revision, at, issued.collectionId],
          );
          return effect(issued.collectionId, true, 'collections', members.length);
        },
      );
    } catch (error) {
      return failed(error);
    }
  };
  const page = (
    input: { limit?: number; cursor?: string } | undefined,
    current: PersonalState,
    scope: string,
    revision: number,
  ) => {
    const limit = input?.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > personalLimits.pageSize)
      fault('invalid_page');
    let after = '';
    if (input?.cursor !== undefined) {
      if (typeof input.cursor !== 'string' || input.cursor.length > 512) fault('invalid_cursor');
      let value: unknown;
      try {
        value = JSON.parse(input.cursor);
      } catch {
        fault('invalid_cursor');
      }
      if (
        !personalObject(value) ||
        !personalExact(value, ['scope', 'epoch', 'revision', 'after']) ||
        value.scope !== scope ||
        !isRevision(value.epoch) ||
        !isRevision(value.revision) ||
        typeof value.after !== 'string' ||
        value.after.length > 100
      )
        fault('invalid_cursor');
      if (value.epoch !== current.epoch || value.revision !== revision)
        fault('page_changed', 'stale_context');
      after = value.after;
    }
    return {
      limit,
      after,
      cursor: (id: string) => JSON.stringify({ scope, epoch: current.epoch, revision, after: id }),
    };
  };
  return {
    readState: () => read(async (_session, current) => ({ ...current })),
    readRecipeNote: (recipeId) =>
      read(async (session, current) => ({
        epoch: current.epoch,
        note: await note(session, requireRecipe(recipeId), true),
      })),
    readRecipeMemberships: (recipeId) =>
      read(async (session, current) => ({
        epoch: current.epoch,
        memberships: await recipeMemberships(session, recipeId),
      })),
    execute,
    reviewDeleteCollection,
    deleteCollection,
    readRecipePersonal: (recipeId) =>
      read(async (session, current) => {
        requireRecipe(recipeId);
        return {
          epoch: current.epoch,
          note: await note(session, recipeId, true),
          memberships: await recipeMemberships(session, recipeId),
        };
      }),
    readCollections: () =>
      read(async (session, current) => {
        const rows = await session.all<CollectionRow & { memberCount: number }>(
          `SELECT ${collectionColumns},(SELECT COUNT(*) FROM personal_collection_member m WHERE m.collection_id=personal_collection.collection_id AND m.present=1) AS memberCount FROM personal_collection WHERE deleted=0 ORDER BY created_at,collection_id LIMIT ?`,
          [personalLimits.collections + 1],
        );
        requirePersonalRecord(rows.length <= personalLimits.collections);
        return {
          epoch: current.epoch,
          items: rows.map((row) => {
            const { memberCount, ...entity } = row;
            requirePersonalRecord(isRevision(memberCount));
            return { ...parseCollection(entity), memberCount };
          }),
        };
      }),
    readCollection: (id, input) =>
      read(async (session, current) => {
        const summary = await collectionSummary(session, id);
        const slice = page(input, current, id, summary.revision);
        const rows = await session.all<MembershipRow>(
          `SELECT ${membershipColumns} FROM personal_collection_member WHERE collection_id=? AND present=1 AND recipe_id>? ORDER BY recipe_id LIMIT ?`,
          [id, slice.after, slice.limit + 1],
        );
        const items = rows.slice(0, slice.limit).map(parseMembership);
        return {
          epoch: current.epoch,
          collection: summary,
          items,
          nextCursor: rows.length > slice.limit ? slice.cursor(items.at(-1)!.recipeId) : null,
        };
      }),
    readManualShopping: (input) =>
      read(async (session, current) => {
        const slice = page(input, current, 'manual', current.revision);
        const total = (
          await session.all<{ count: number }>(
            'SELECT COUNT(*) AS count FROM manual_shopping_item WHERE deleted=0',
          )
        )[0]!.count;
        requirePersonalRecord(isRevision(total) && total <= personalLimits.manualItems);
        const rows = await session.all<ManualRow>(
          `SELECT ${manualColumns} FROM manual_shopping_item WHERE deleted=0 AND item_id>? ORDER BY item_id LIMIT ?`,
          [slice.after, slice.limit + 1],
        );
        const items = rows.slice(0, slice.limit).map(parseManual);
        return {
          epoch: current.epoch,
          items,
          total,
          nextCursor: rows.length > slice.limit ? slice.cursor(items.at(-1)!.itemId) : null,
        };
      }),
    readReceipt: (id) =>
      read(async (session) => {
        if (!isAppId(id)) fault('invalid_operation');
        return (await readPersonalReceipt(session, id))?.receipt ?? null;
      }),
    resolveOperation: async (id) => {
      if (!isAppId(id))
        return failed(
          new PersonalFault({
            code: 'invalid_input',
            messageKey: 'personal.invalid_operation',
            retry: 'after_correction',
          }),
        );
      return transact(id, null, null, null);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notifyRestored: (revision) =>
      publish({ revision, notes: true, collections: true, manualShopping: true }),
    close: () => listeners.clear(),
  };
}
