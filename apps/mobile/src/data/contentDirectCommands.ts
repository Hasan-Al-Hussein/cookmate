import { catalogue, catalogueBoundary, readonlyIds } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  validateOverlayHead,
  validateRecipeContentRef,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import {
  checkLocalCommand,
  commandFingerprintInput,
  matchOperationReceipt,
  validateLocalCommand,
  validatePendingIntent,
  type CatalogueBoundary,
  type CatalogueIdentity,
  type CommandResult,
  type ContractError,
  type DateContext,
  type LocalCommand,
  type OperationReceipt,
  type PendingIntent,
} from '@cookmate/contracts';
import {
  CommandPreparationError,
  createCommandPreparer,
  type CommandPlatform,
  type DirectActionInput,
  type DirectActionReview,
  type Immutable,
  type RepositoryResult,
  type StoreChange,
  type CookMateQueries,
  type CookMateCommands,
  type DirectRecoveryEntry,
} from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import { createContentCommandContext, type ContentCommandContext } from './contentCommandContext';
import type { ContentReadingView, openContentReleaseStore } from './contentReleaseStore';
import { isAppId, parseStoredIntent } from './conversationRecords';
import { readAdoptionInSnapshot } from './cookingContentRepository';
import {
  CommandFault,
  createCommandExecutor,
  registerReadyIntent,
  rejectCommand,
} from './commandExecutor';
import { createDirectActionReviewer } from './directActionReview';
import {
  readInheritedCommandAuthorityInSnapshot,
  readInheritedReceiptAuthorityInSnapshot,
} from './contentInheritedCommandAuthority';
import { createPlanCommandHandlers } from './planCommands';
import { freezeResult, readRevision } from './query';
import { readRestoreEpoch } from './restoreEpoch';
import { createShoppingCommandHandlers } from './shoppingCommands';
import { favouriteCommandHandlers } from './favouriteCommands';
import { admitContentFavouriteRows } from './contentWorkspaceQueries';
import { readReceiptInSnapshot } from './stateRepositories';
import {
  runBound,
  type SerializedReader,
  type SerializedWriter,
  type SqlSession,
  type SqlValue,
} from './sql';

interface Options {
  /** Default 7; schema 8 mutation admission is an explicit private-host choice. */
  commandSchemaVersion?: 7 | 8;
  reader: SerializedReader;
  writer: SerializedWriter;
  contentStore: Pick<Awaited<ReturnType<typeof openContentReleaseStore>>, 'withVerifiedReading'>;
  installationId: string;
  platform: CommandPlatform;
  now(): string;
  dateContext(): DateContext;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
  onCommitted(change: StoreChange): void;
}
interface Workspace extends ContentAdoptionAccess {
  installationId: string;
  restoreEpoch: number;
  adoptionRevision: number;
  head: OverlayHead | null;
}
interface Authority extends Workspace {
  formatVersion: 1;
  catalogue: CatalogueIdentity;
  /** Authenticated reviewed identities, never reconstructed from receipt effects. */
  recipeIds: string[];
}
interface Reviewed {
  authority: Authority;
  refs: RecipeContentRef[];
  material?: Promise<{ command: LocalCommand; intent: PendingIntent }>;
}
const COMMAND_BYTES = 65536;
const AUTHORITY_BYTES = 4096;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left, AUTHORITY_BYTES) === canonicalContentJson(right, AUTHORITY_BYTES);
function requireEvidence(value: unknown): asserts value {
  if (!value) rejectCommand('storage_failure', 'content.direct_evidence_invalid');
}
function errorDetail(error: unknown): ContractError {
  return error instanceof CommandFault || error instanceof CommandPreparationError
    ? error.detail
    : { code: 'storage_failure', messageKey: 'content.direct_failed', retry: 'after_correction' };
}
function parseAuthority(text: string): Authority {
  const value: unknown = JSON.parse(text);
  requireEvidence(
    record(value) &&
      exact(value, [
        'formatVersion',
        'installationId',
        'ownerId',
        'authGeneration',
        'restoreEpoch',
        'adoptionRevision',
        'head',
        'catalogue',
        'recipeIds',
      ]) &&
      value.formatVersion === 1 &&
      isAppId(value.installationId) &&
      (value.ownerId === null || isAppId(value.ownerId)) &&
      revision(value.authGeneration) &&
      revision(value.restoreEpoch) &&
      revision(value.adoptionRevision) &&
      (value.head === null || validateOverlayHead(value.head)) &&
      record(value.catalogue) &&
      exact(value.catalogue, ['version', 'fingerprint']) &&
      typeof value.catalogue.version === 'string' &&
      value.catalogue.version.length > 0 &&
      value.catalogue.version.length <= 80 &&
      hash(value.catalogue.fingerprint) &&
      Array.isArray(value.recipeIds) &&
      value.recipeIds.length <= 3 &&
      value.recipeIds.every((id: unknown) => typeof id === 'string' && /^[0-9]{1,20}$/.test(id)) &&
      new Set(value.recipeIds).size === value.recipeIds.length &&
      canonicalContentJson(value, AUTHORITY_BYTES) === text,
  );
  const authority = value as unknown as Authority;
  // This is a cross-field integrity check, not trust in a stored/unsigned head.
  // New effects also compare this identity with a freshly verified content view.
  requireEvidence(
    authority.head === null
      ? authority.adoptionRevision === 0 && same(authority.catalogue, catalogue.identity)
      : authority.adoptionRevision > 0 &&
          same(authority.catalogue, {
            version: `overlay-v2:${authority.head.sequence}`,
            fingerprint: authority.head.fingerprint,
          }),
  );
  return freezeResult(authority);
}
function boundary(authority: Authority): CatalogueBoundary {
  return Object.freeze({
    identity: authority.catalogue,
    recipeIds: readonlyIds(new Set(authority.recipeIds)),
    hasSource: () => false,
  });
}
function directCommand(input: Immutable<LocalCommand>): LocalCommand {
  const value: unknown = JSON.parse(canonicalContentJson(input, COMMAND_BYTES));
  if (
    !validateLocalCommand(value) ||
    value.origin ||
    ![
      'addPlan',
      'editPlan',
      'replacePlanRecipe',
      'movePlanReplacing',
      'removePlan',
      'setShoppingSelection',
      'setPurchased',
      'setFavourite',
    ].includes(value.command.kind)
  )
    rejectCommand('invalid_input', 'content.direct_command_required');
  return freezeResult(value);
}
function directInput(input: Immutable<DirectActionInput>): DirectActionInput {
  if (
    input.kind === 'setShoppingSelection' &&
    (!Array.isArray(input.occurrenceIds) ||
      input.occurrenceIds.length > 1000 ||
      input.occurrenceIds.some((id) => !isAppId(id)) ||
      new Set(input.occurrenceIds).size !== input.occurrenceIds.length)
  )
    rejectCommand('invalid_input', 'shopping.invalid_selection');
  const value = JSON.parse(canonicalContentJson(input, COMMAND_BYTES)) as DirectActionInput;
  if (
    !['placeRecipe', 'removePlan', 'setShoppingSelection', 'setPurchased', 'setFavourite'].includes(
      value.kind,
    )
  )
    rejectCommand('invalid_input', 'content.direct_action_required');
  return freezeResult(value);
}

/**
 * Private schema7 command host, with explicit schema8 opt-in and schema7/8 historical recovery.
 * The host supplies a
 * live access generation and owns all handles. Lock order is content then cooking;
 * the initial cooking capture ends before reserving content. Recovery uses retained
 * per-command authority and never current content availability as proof of past effects.
 */
export function createContentDirectCommands(options: Options) {
  const commandSchemaVersion = options.commandSchemaVersion ?? 7;
  requireEvidence(commandSchemaVersion === 7 || commandSchemaVersion === 8);
  requireEvidence(isAppId(options.installationId));
  const access = options.getAccess();
  if (
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !revision(access.authGeneration)
  )
    rejectCommand('stale_context', 'content.access_changed');
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  const reviews = new WeakMap<object, Reviewed>();
  let closed = false;
  function check(): undefined {
    const live = options.getAccess();
    if (
      closed ||
      !live ||
      live.ownerId !== scope.ownerId ||
      live.authGeneration !== scope.authGeneration ||
      options.assertAccess(scope) !== undefined
    )
      rejectCommand('stale_context', 'content.access_changed');
    return undefined;
  }
  const sha256 = async (text: string) => {
    check();
    const result = await options.platform.sha256(text);
    check();
    return result;
  };
  const platform = { newId: options.platform.newId, sha256 };
  const projection = { readRecipe: catalogue.getRecipe, sha256 };
  async function owner(session: SqlSession) {
    check();
    const schema = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
      ?.user_version;
    requireEvidence(schema === 7 || schema === 8);
    const [row] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (row?.id !== options.installationId || (await readBinding(session)) !== scope.ownerId)
      rejectCommand('stale_context', 'content.access_changed');
    check();
  }
  async function workspace(session: SqlSession): Promise<Workspace> {
    await owner(session);
    const adoption = await readAdoptionInSnapshot(session);
    const restoreEpoch = await readRestoreEpoch(session);
    check();
    return {
      ...scope,
      installationId: options.installationId,
      restoreEpoch,
      adoptionRevision: adoption.revision,
      head: adoption.head,
    };
  }
  async function requireWorkspace(session: SqlSession, expected: Workspace) {
    const current = await workspace(session);
    const { installationId, ownerId, authGeneration, restoreEpoch, adoptionRevision, head } =
      expected;
    if (
      !same(current, {
        installationId,
        ownerId,
        authGeneration,
        restoreEpoch,
        adoptionRevision,
        head,
      })
    )
      rejectCommand('stale_context', 'content.direct_workspace_changed');
  }
  async function favouriteSession(raw: SqlSession, expected: Workspace): Promise<SqlSession> {
    const session = recoverySession(raw);
    requireEvidence(
      commandSchemaVersion === 8 &&
        (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version === 8,
    );
    await requireWorkspace(session, expected);
    const [clock] = await session.all<{ value: number | null }>(
      "SELECT CASE WHEN typeof(revision)='integer' THEN revision END value FROM state_revision WHERE collection='store'",
    );
    requireEvidence(revision(clock?.value));
    return session;
  }
  async function refs(
    session: SqlSession,
    proposed: readonly string[] = [],
  ): Promise<RecipeContentRef[]> {
    // CASE limits prevent malformed scalar allocation even with foreign keys disabled.
    const rows = await session.all<{
      recipeId: string | null;
      revisionId: string | null;
      contentFingerprint: string | null;
    }>(
      `SELECT CASE WHEN typeof(s.recipe_id)='text' AND length(CAST(s.recipe_id AS BLOB))<=20 THEN s.recipe_id END recipeId,
        CASE WHEN typeof(s.revision_id)='text' AND length(CAST(s.revision_id AS BLOB))<=120 THEN s.revision_id END revisionId,
        CASE WHEN typeof(s.content_fingerprint)='text' AND length(CAST(s.content_fingerprint AS BLOB))=64 THEN s.content_fingerprint END contentFingerprint
        FROM plan_occurrence p LEFT JOIN plan_content_pin s ON s.occurrence_id=p.occurrence_id AND s.recipe_id=p.recipe_id
        WHERE p.occurrence_id IN (SELECT occurrence_id FROM shopping_selection UNION SELECT value FROM json_each(?)) LIMIT 2001`,
      [JSON.stringify(proposed)],
    );
    requireEvidence(rows.length <= 2000 && rows.every(validateRecipeContentRef));
    const unique = new Map<string, RecipeContentRef>();
    for (const row of rows) {
      requireEvidence(validateRecipeContentRef(row));
      unique.set(canonicalContentJson(row, 1024), row);
    }
    if (unique.size > 1000) rejectCommand('unsupported_request', 'content.direct_reference_limit');
    return [...unique.values()];
  }
  async function capture(proposed?: readonly string[], favourite = false) {
    check();
    const result = await options.reader.transaction(
      async (session) => ({
        workspace: await workspace(session),
        refs: favourite ? [] : await refs(session, proposed),
      }),
      { kind: 'read_only' },
    );
    check();
    return result;
  }
  async function reserve<Value>(
    expected: Workspace,
    retained: readonly RecipeContentRef[],
    work: (
      admission: { context?: ContentCommandContext; commandBoundary: CatalogueBoundary },
      guard: () => undefined,
    ) => Promise<Value>,
    removalId?: string,
  ): Promise<Value> {
    check();
    if (removalId !== undefined) {
      // Removing an existing local choice needs no recipe body or delivery. This
      // boundary grants only the retained identity; it cannot authorize a save.
      const local = parseAuthority(
        canonicalContentJson(
          {
            ...expected,
            formatVersion: 1,
            catalogue: expected.head
              ? {
                  version: `overlay-v2:${expected.head.sequence}`,
                  fingerprint: expected.head.fingerprint,
                }
              : catalogue.identity,
            recipeIds: [removalId],
          },
          AUTHORITY_BYTES,
        ),
      );
      await options.reader.transaction(
        async (raw) => {
          const session = await favouriteSession(raw, expected);
          await requireFavouriteIdentity(session, removalId);
        },
        { kind: 'read_only' },
      );
      check();
      const result = await work({ commandBoundary: boundary(local) }, check);
      check();
      return result;
    }
    const result = await options.contentStore.withVerifiedReading(
      expected.head,
      retained,
      async (view: ContentReadingView) => {
        const guard = (): undefined => {
          check();
          requireEvidence(view.assertActive() === undefined);
          return undefined;
        };
        guard();
        requireEvidence(same(view.head, expected.head));
        const context = await createContentCommandContext({
          view,
          expectedAdoptionRevision: expected.adoptionRevision,
          commandSchemaVersion,
          sha256,
        });
        guard();
        const value = await work({ context, commandBoundary: context.commandBoundary }, guard);
        guard();
        return value;
      },
    );
    check();
    return result;
  }
  async function requireFavouriteIdentity(session: SqlSession, recipeId: string) {
    const rows = await admitContentFavouriteRows(session);
    if (!rows.some((row) => row.recipeId === recipeId))
      rejectCommand('stale_context', 'content.favourite_missing');
  }
  async function authority(session: SqlSession, command: LocalCommand): Promise<Authority | null> {
    await owner(session);
    // Existing executor/registration readers may now materialize this one intent.
    // Admit its scalar/payload bounds first without loading corrupted private bytes.
    requireEvidence(
      (
        await session.all(
          `SELECT 1 FROM pending_intent WHERE user_intent_id=? AND (
      typeof(intent_json)<>'text' OR length(CAST(intent_json AS BLOB))>131072 OR
      typeof(phase)<>'text' OR length(CAST(phase AS BLOB))>32 OR typeof(revision)<>'integer' OR revision<0 OR revision>9007199254740991) LIMIT 1`,
          [command.userIntentId],
        )
      ).length === 0,
    );
    // This private host creates exactly one slot per intent. Establish membership
    // before shared slot/advanceIntent readers, which also serve multi-action hosts.
    const [counts] = await session.all<{ slots: number; receipts: number }>(
      `SELECT (SELECT COUNT(*) FROM command_slot WHERE user_intent_id=?) slots,
        (SELECT COUNT(*) FROM operation_receipt WHERE user_intent_id=?) receipts`,
      [command.userIntentId, command.userIntentId],
    );
    requireEvidence(counts && counts.slots <= 1 && counts.receipts <= 1);
    requireEvidence(
      (
        await session.all(
          `SELECT 1 FROM command_slot WHERE (user_intent_id=? OR operation_id=?) AND (
        user_intent_id<>? OR operation_id<>? OR typeof(slot_id)<>'text' OR length(CAST(slot_id AS BLOB))<>36 OR
        typeof(position)<>'integer' OR position<>0) LIMIT 1`,
          [command.userIntentId, command.operationId, command.userIntentId, command.operationId],
        )
      ).length === 0 &&
        (
          await session.all(
            `SELECT 1 FROM operation_receipt WHERE user_intent_id=? AND (
        typeof(operation_id)<>'text' OR length(CAST(operation_id AS BLOB))<>36 OR operation_id<>?) LIMIT 1`,
            [command.userIntentId, command.operationId],
          )
        ).length === 0,
    );
    const [row] = await session.all<{
      fingerprint: string | null;
      json: string | null;
      slot: string | null;
      slotId: string;
      intent: string | null;
    }>(
      `SELECT CASE WHEN typeof(a.payload_fingerprint)='text' AND length(CAST(a.payload_fingerprint AS BLOB))=64 THEN a.payload_fingerprint END fingerprint,
       CASE WHEN typeof(a.authority_json)='text' AND length(CAST(a.authority_json AS BLOB))<=4096 THEN a.authority_json END json,
       CASE WHEN typeof(s.command_json)='text' AND length(CAST(s.command_json AS BLOB))<=65536 THEN s.command_json END slot,
       s.slot_id slotId,
       CASE WHEN typeof(p.intent_json)='text' AND length(CAST(p.intent_json AS BLOB))<=131072 THEN p.intent_json END intent
       FROM content_command_authority a LEFT JOIN command_slot s ON s.operation_id=a.operation_id
       LEFT JOIN pending_intent p ON p.user_intent_id=s.user_intent_id WHERE a.operation_id=?`,
      [command.operationId],
    );
    if (!row) {
      requireEvidence(
        (
          await session.all(
            'SELECT 1 FROM command_slot WHERE operation_id=? UNION ALL SELECT 1 FROM operation_receipt WHERE operation_id=? LIMIT 1',
            [command.operationId, command.operationId],
          )
        ).length === 0,
      );
      return null;
    }
    requireEvidence(
      row.json !== null &&
        row.slot !== null &&
        row.intent !== null &&
        isAppId(row.slotId) &&
        hash(row.fingerprint),
    );
    const saved = parseAuthority(row.json);
    if (saved.installationId !== options.installationId || saved.ownerId !== scope.ownerId)
      rejectCommand('stale_context', 'content.access_changed');
    const slot: unknown = JSON.parse(row.slot);
    const intent: unknown = JSON.parse(row.intent);
    requireEvidence(
      validatePendingIntent(intent) &&
        !intent.origin &&
        intent.slots.length === 1 &&
        intent.userIntentId === command.userIntentId &&
        intent.slots[0]!.slotId === row.slotId &&
        intent.slots[0]!.command.operationId === command.operationId &&
        commandFingerprintInput(intent.slots[0]!.command) === commandFingerprintInput(command),
    );
    if (
      row.fingerprint !== command.payloadFingerprint ||
      !validateLocalCommand(slot) ||
      slot.operationId !== command.operationId ||
      commandFingerprintInput(slot) !== commandFingerprintInput(command)
    )
      rejectCommand('operation_conflict', 'command.operation_reused');
    requireEvidence(checkLocalCommand(command, boundary(saved)).ok);
    check();
    return saved;
  }
  async function preflightReceipt(session: SqlSession, operationId: string) {
    requireEvidence(
      (
        await session.all(
          `SELECT 1 FROM operation_receipt WHERE operation_id=? AND (
      typeof(user_intent_id)<>'text' OR length(CAST(user_intent_id AS BLOB))<>36 OR
      typeof(payload_fingerprint)<>'text' OR length(CAST(payload_fingerprint AS BLOB))<>64 OR
      typeof(outcome)<>'text' OR length(CAST(outcome AS BLOB))>16 OR typeof(committed_at)<>'text' OR length(CAST(committed_at AS BLOB))>40 OR
      typeof(shopping_projection)<>'text' OR length(CAST(shopping_projection AS BLOB))>16 OR
      typeof(effects_json)<>'text' OR length(CAST(effects_json AS BLOB))>16384) LIMIT 1`,
          [operationId],
        )
      ).length === 0,
    );
  }
  async function ownCommand(input: Immutable<LocalCommand>) {
    check();
    const command = directCommand(input);
    if ((await sha256(commandFingerprintInput(command))) !== command.payloadFingerprint)
      rejectCommand('operation_conflict', 'command.fingerprint_mismatch');
    return command;
  }
  async function recover(
    input: Immutable<LocalCommand>,
  ): Promise<RepositoryResult<OperationReceipt | null>> {
    try {
      const command = await ownCommand(input);
      const result = await options.reader.transaction(
        async (session) => {
          const saved = await authority(session, command);
          await preflightReceipt(session, command.operationId);
          const receipt = saved
            ? await readReceiptInSnapshot(session, command.operationId, boundary(saved))
            : null;
          if (receipt && matchOperationReceipt(command, receipt) !== 'existing')
            rejectCommand('operation_conflict', 'command.operation_reused');
          check();
          return {
            kind: 'ready' as const,
            value: freezeResult(receipt),
            revision: await readRevision(session, 'store'),
          };
        },
        { kind: 'read_only' },
      );
      check();
      return result;
    } catch (error) {
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  async function operationInSnapshot(session: SqlSession, operationId: string) {
    await owner(session);
    const inherited = await readInheritedCommandAuthorityInSnapshot(session, operationId);
    const [retained] = await session.all<{ authority: string | null }>(
      "SELECT CASE WHEN typeof(authority_json)='text' AND length(CAST(authority_json AS BLOB))<=4096 THEN authority_json END authority FROM content_command_authority WHERE operation_id=?",
      [operationId],
    );
    if (retained) {
      requireEvidence(!inherited);
      requireEvidence(typeof retained.authority === 'string');
      const saved = parseAuthority(retained.authority);
      if (saved.installationId !== options.installationId || saved.ownerId !== scope.ownerId)
        rejectCommand('stale_context', 'content.access_changed');
    } else if (inherited) {
      if (
        inherited.installationId !== options.installationId ||
        inherited.ownerId !== scope.ownerId
      )
        rejectCommand('stale_context', 'content.access_changed');
      requireEvidence(same(inherited.catalogue, catalogue.identity));
    } else {
      requireEvidence(
        (
          await session.all(
            'SELECT 1 FROM command_slot WHERE operation_id=? UNION ALL SELECT 1 FROM operation_receipt WHERE operation_id=? LIMIT 1',
            [operationId, operationId],
          )
        ).length === 0,
      );
      check();
      return null;
    }
    const [row] = await session.all<{
      command: string | null;
      userIntentId: string | null;
      slotId: string | null;
    }>(
      "SELECT CASE WHEN typeof(command_json)='text' AND length(CAST(command_json AS BLOB))<=65536 THEN command_json END command,CASE WHEN typeof(user_intent_id)='text' AND length(CAST(user_intent_id AS BLOB))=36 THEN user_intent_id END userIntentId,CASE WHEN typeof(slot_id)='text' AND length(CAST(slot_id AS BLOB))=36 THEN slot_id END slotId FROM command_slot WHERE operation_id=?",
      [operationId],
    );
    requireEvidence(row && typeof row.command === 'string');
    let command: LocalCommand;
    let commandBoundary: CatalogueBoundary;
    if (inherited) {
      const parsed = checkLocalCommand(JSON.parse(row.command), catalogueBoundary);
      requireEvidence(parsed.ok);
      command = freezeResult(parsed.value);
      requireEvidence(
        command.operationId === inherited.operationId &&
          command.userIntentId === inherited.userIntentId &&
          command.payloadFingerprint === inherited.payloadFingerprint,
      );
      requireEvidence(
        (await sha256(commandFingerprintInput(command))) === command.payloadFingerprint,
      );
      commandBoundary = catalogueBoundary;
    } else {
      command = await ownCommand(JSON.parse(row.command));
      const saved = await authority(session, command);
      requireEvidence(saved);
      commandBoundary = boundary(saved);
    }
    requireEvidence(command.operationId === operationId);
    requireEvidence(command.userIntentId === row.userIntentId && isAppId(row.slotId));
    await preflightReceipt(session, operationId);
    const receipt = await readReceiptInSnapshot(session, operationId, commandBoundary);
    if (receipt && matchOperationReceipt(command, receipt) !== 'existing')
      rejectCommand('operation_conflict', 'command.operation_reused');
    const [intentRow] = await session.all<{
      userIntentId: string;
      revision: number;
      phase: string;
      intent: string | null;
    }>(
      "SELECT CASE WHEN typeof(user_intent_id)='text' AND length(CAST(user_intent_id AS BLOB))=36 THEN user_intent_id END userIntentId,CASE WHEN typeof(revision)='integer' THEN revision END revision,CASE WHEN typeof(phase)='text' AND length(CAST(phase AS BLOB))<=32 THEN phase END phase,CASE WHEN typeof(intent_json)='text' AND length(CAST(intent_json AS BLOB))<=131072 THEN intent_json END intent FROM pending_intent WHERE user_intent_id=?",
      [command.userIntentId],
    );
    requireEvidence(intentRow && typeof intentRow.intent === 'string');
    const intent = parseStoredIntent(intentRow.intent, intentRow);
    requireEvidence(
      command.intentRevision === intent.revision &&
        canonicalContentJson(command.origin ?? null) ===
          canonicalContentJson(intent.origin ?? null) &&
        intent.slots.some(
          (slot) =>
            slot.slotId === row.slotId &&
            slot.command.operationId === command.operationId &&
            slot.command.payloadFingerprint === command.payloadFingerprint &&
            commandFingerprintInput(slot.command) === commandFingerprintInput(command),
        ),
    );
    if (!receipt && intent.phase === 'settled') requireEvidence(false);
    check();
    return { command, receipt, intent };
  }
  async function historicalReceipt(session: SqlSession, operationId: string) {
    await owner(session);
    const marker = await readInheritedReceiptAuthorityInSnapshot(session, operationId);
    if (!marker) return (await operationInSnapshot(session, operationId))?.receipt ?? null;
    if (marker.installationId !== options.installationId || marker.ownerId !== scope.ownerId)
      rejectCommand('stale_context', 'content.access_changed');
    // A receipt retained after conversation clearing proves only its original result.
    // It cannot replace missing command authority or authorize recovery execution.
    requireEvidence(
      !(await readInheritedCommandAuthorityInSnapshot(session, operationId)) &&
        (
          await session.all(
            'SELECT 1 FROM content_command_authority WHERE operation_id=? UNION ALL SELECT 1 FROM command_slot WHERE operation_id=? UNION ALL SELECT 1 FROM direct_command_recovery WHERE operation_id=? LIMIT 1',
            [operationId, operationId, operationId],
          )
        ).length === 0,
    );
    await preflightReceipt(session, operationId);
    const receipt = await readReceiptInSnapshot(session, operationId, catalogueBoundary);
    requireEvidence(
      receipt &&
        receipt.userIntentId === marker.userIntentId &&
        receipt.payloadFingerprint === marker.payloadFingerprint &&
        (await sha256(canonicalContentJson(receipt, 32768))) === marker.receiptDigest,
    );
    check();
    return receipt;
  }
  async function recoveryEntry(
    session: SqlSession,
    row: { sequence: number; operationId: string },
  ): Promise<DirectRecoveryEntry> {
    requireEvidence(revision(row.sequence) && row.sequence > 0 && isAppId(row.operationId));
    const saved = await operationInSnapshot(session, row.operationId);
    requireEvidence(saved);
    const { intent } = saved;
    requireEvidence(!intent.origin && !saved.command.origin);
    check();
    return {
      sequence: row.sequence,
      operationId: row.operationId,
      userIntentId: saved.command.userIntentId,
      commandKind: saved.command.command.kind,
      phase: intent.phase,
      outcome: saved.receipt
        ? 'receipt'
        : ['cancelled', 'reconciling'].includes(intent.phase)
          ? 'not_executed'
          : 'unresolved',
      receipt: saved.receipt,
    };
  }
  // Queue behind the writer so absence cannot be sampled ahead of an in-flight settlement.
  function recoverySession(raw: SqlSession): SqlSession {
    return {
      async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
        check();
        const rows = await raw.all<Row>(sql, values);
        check();
        return rows;
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
          finalize: () => statement.finalize(),
        };
      },
    };
  }
  async function recoveryRevision(session: SqlSession): Promise<number> {
    const [row] = await session.all<{ revision: number | null }>(
      "SELECT CASE WHEN typeof(revision)='integer' THEN revision END revision FROM state_revision WHERE collection='store'",
    );
    requireEvidence(revision(row?.revision));
    return row.revision;
  }
  const recovery: Pick<CookMateQueries, 'readReceipt' | 'readDirectRecovery'> &
    Pick<CookMateCommands, 'acknowledgeDirectRecovery'> = {
    async readReceipt(operationId) {
      try {
        check();
        if (!isAppId(operationId)) rejectCommand('invalid_input', 'command.invalid_operation');
        const result = await options.writer.transaction(
          async (raw) => {
            const session = recoverySession(raw);
            const receipt = await historicalReceipt(session, operationId);
            const result = {
              kind: 'ready' as const,
              revision: await recoveryRevision(session),
              value: freezeResult(receipt),
            };
            check();
            return result;
          },
          { kind: 'read_only' },
        );
        check();
        return result;
      } catch (error) {
        return { kind: 'failed', error: errorDetail(error) };
      }
    },
    async readDirectRecovery(input = {}) {
      try {
        check();
        const owned: unknown = JSON.parse(canonicalContentJson(input, 1024));
        if (
          !record(owned) ||
          Object.keys(owned).some((key) => key !== 'afterSequence' && key !== 'limit')
        )
          rejectCommand('invalid_input', 'command.invalid_recovery_page');
        const after = owned.afterSequence ?? 0,
          limit = owned.limit ?? 30;
        if (
          !revision(after) ||
          typeof limit !== 'number' ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          rejectCommand('invalid_input', 'command.invalid_recovery_page');
        const result = await options.writer.transaction(
          async (raw) => {
            const session = recoverySession(raw);
            await owner(session);
            const rows = await session.all<{ sequence: number; operationId: string }>(
              "SELECT sequence,CASE WHEN typeof(operation_id)='text' AND length(CAST(operation_id AS BLOB))=36 THEN operation_id END operationId FROM direct_command_recovery WHERE sequence>? ORDER BY sequence LIMIT ?",
              [after, limit + 1],
            );
            const entries: DirectRecoveryEntry[] = [];
            for (const row of rows.slice(0, limit)) entries.push(await recoveryEntry(session, row));
            const result = {
              kind: 'ready' as const,
              revision: await recoveryRevision(session),
              value: freezeResult({
                entries,
                nextAfterSequence: rows.length > limit ? entries.at(-1)!.sequence : null,
              }),
            };
            check();
            return result;
          },
          { kind: 'read_only' },
        );
        check();
        return result;
      } catch (error) {
        return { kind: 'failed', error: errorDetail(error) };
      }
    },
    async acknowledgeDirectRecovery(operationId) {
      try {
        check();
        if (!isAppId(operationId)) rejectCommand('invalid_input', 'command.invalid_operation');
        const result = await options.writer.transaction(
          async (raw) => {
            const session = recoverySession(raw);
            await owner(session);
            const [row] = await session.all<{ sequence: number; operationId: string }>(
              'SELECT sequence,operation_id operationId FROM direct_command_recovery WHERE operation_id=?',
              [operationId],
            );
            if (row) {
              const actual = await recoveryEntry(session, row);
              if (actual.outcome === 'unresolved')
                rejectCommand('already_pending', 'command.outcome_unresolved');
              await runBound(session, 'DELETE FROM direct_command_recovery WHERE operation_id=?', [
                operationId,
              ]);
            }
            const result = {
              kind: 'ready' as const,
              revision: await recoveryRevision(session),
              value: null,
            };
            check();
            return result;
          },
          { kind: 'none' },
          check,
        );
        check();
        return result;
      } catch (error) {
        return { kind: 'failed', error: errorDetail(error) };
      }
    },
  };
  return Object.freeze({
    ...recovery,
    async reviewDirect(
      input: Immutable<DirectActionInput>,
    ): Promise<RepositoryResult<Immutable<DirectActionReview>>> {
      try {
        check();
        const owned = directInput(input);
        if (owned.kind === 'setFavourite' && commandSchemaVersion !== 8)
          rejectCommand('invalid_input', 'content.direct_action_required');
        const captured = await capture(
          owned.kind === 'setShoppingSelection' ? owned.occurrenceIds : undefined,
          owned.kind === 'setFavourite',
        );
        return await reserve(
          captured.workspace,
          captured.refs,
          async ({ context, commandBoundary }) =>
            createDirectActionReviewer(
              options.reader,
              {
                ...projection,
                platform,
                catalogue: commandBoundary,
                async onReviewed(session, review) {
                  await requireWorkspace(session, captured.workspace);
                  const consequence = review.consequences;
                  if (consequence.kind === 'favourite') {
                    await admitContentFavouriteRows(
                      await favouriteSession(session, captured.workspace),
                    );
                    if (consequence.saved) {
                      requireEvidence(context);
                      context.requireCurrent(consequence.recipeId);
                    } else
                      await requireFavouriteIdentity(
                        await favouriteSession(session, captured.workspace),
                        consequence.recipeId,
                      );
                  }
                  const ids =
                    consequence.kind === 'plan'
                      ? [
                          ...new Set(
                            [
                              consequence.source?.recipeId,
                              consequence.destination?.recipeId,
                              consequence.resultRecipeId,
                            ].filter((id): id is string => typeof id === 'string'),
                          ),
                        ].sort()
                      : consequence.kind === 'favourite'
                        ? [consequence.recipeId]
                        : [];
                  requireEvidence(
                    ids.length <= 3 && ids.every((id) => commandBoundary.recipeIds.has(id)),
                  );
                  const saved = parseAuthority(
                    canonicalContentJson(
                      {
                        ...captured.workspace,
                        formatVersion: 1,
                        catalogue: commandBoundary.identity,
                        recipeIds: ids,
                      },
                      AUTHORITY_BYTES,
                    ),
                  );
                  reviews.set(review, { authority: saved, refs: captured.refs });
                },
              },
              owned.kind === 'setFavourite' ? undefined : context,
            )(owned),
          owned.kind === 'setFavourite' && !owned.saved ? owned.recipeId : undefined,
        );
      } catch (error) {
        return { kind: 'failed', error: errorDetail(error) };
      }
    },
    async prepareDirect(
      review: Immutable<DirectActionReview>,
    ): Promise<RepositoryResult<Immutable<LocalCommand>>> {
      try {
        check();
        const saved = reviews.get(review);
        if (!saved) rejectCommand('stale_context', 'content.direct_review_required');
        // Cache operation and slot before awaiting. Concurrent confirmations/retries
        // retain one identity even if registration acknowledgement is lost.
        saved.material ??= (async () => {
          const command = await createCommandPreparer(
            platform,
            boundary(saved.authority),
          )(review.payload);
          return {
            command,
            intent: freezeResult({
              userIntentId: command.userIntentId,
              revision: command.intentRevision,
              phase: 'ready' as const,
              slots: [{ slotId: platform.newId(), command }],
            }),
          };
        })();
        const material = await saved.material;
        return await reserve(
          saved.authority,
          saved.refs,
          async ({ context, commandBoundary }, guard) => {
            requireEvidence(same(saved.authority.catalogue, commandBoundary.identity));
            let insert = false;
            await registerReadyIntent(
              options.writer,
              material.intent,
              commandBoundary,
              platform,
              review.guard,
              {
                trackDirectRecovery: true,
                expectedRestoreEpoch: saved.authority.restoreEpoch,
                hooks: {
                  async beforeRegister(session) {
                    guard();
                    // A database upgrade after review cannot silently authorize registration.
                    if (material.command.command.kind === 'setFavourite') {
                      await favouriteSession(session, saved.authority);
                      if (material.command.command.saved) {
                        requireEvidence(context);
                        context.requireCurrent(material.command.command.recipeId);
                      } else
                        await requireFavouriteIdentity(
                          await favouriteSession(session, saved.authority),
                          material.command.command.recipeId,
                        );
                    } else {
                      requireEvidence(context);
                      await context.enter(session);
                    }
                    await requireWorkspace(session, saved.authority);
                    const prior = await authority(session, material.command);
                    insert = prior === null;
                    if (prior && !same(prior, saved.authority))
                      rejectCommand('operation_conflict', 'content.direct_authority_changed');
                  },
                  async afterRegister(session) {
                    if (insert)
                      await runBound(
                        session,
                        'INSERT INTO content_command_authority VALUES (?,?,?)',
                        [
                          material.command.operationId,
                          material.command.payloadFingerprint,
                          canonicalContentJson(saved.authority, AUTHORITY_BYTES),
                        ],
                      );
                    else
                      requireEvidence(
                        same(await authority(session, material.command), saved.authority),
                      );
                    guard();
                  },
                  assertCommitAdmission: guard,
                },
              },
            );
            guard();
            const result = await options.reader.transaction(
              async (session) => {
                await owner(session);
                return {
                  kind: 'ready' as const,
                  value: material.command,
                  revision: await readRevision(session, 'store'),
                };
              },
              { kind: 'read_only' },
            );
            guard();
            return result;
          },
          material.command.command.kind === 'setFavourite' && !material.command.command.saved
            ? material.command.command.recipeId
            : undefined,
        );
      } catch (error) {
        return { kind: 'failed', error: errorDetail(error) };
      }
    },
    async execute(input: Immutable<LocalCommand>): Promise<CommandResult> {
      let command: LocalCommand | undefined;
      let dispatchStarted = false;
      try {
        command = await ownCommand(input);
        const receipt = await recover(command);
        if (receipt.kind === 'failed') throw new CommandFault(receipt.error);
        if (receipt.value) return { kind: 'receipt', receipt: receipt.value };
        const owned = command;
        const captured = await options.reader.transaction(
          async (session) => {
            const saved = await authority(session, owned);
            if (!saved) rejectCommand('stale_context', 'command.intent_not_registered');
            await requireWorkspace(session, saved);
            return {
              saved,
              refs:
                owned.command.kind === 'setFavourite'
                  ? []
                  : await refs(
                      session,
                      owned.command.kind === 'setShoppingSelection'
                        ? owned.command.occurrenceIds
                        : undefined,
                    ),
            };
          },
          { kind: 'read_only' },
        );
        return await reserve(
          captured.saved,
          captured.refs,
          async ({ context, commandBoundary }, guard) => {
            requireEvidence(same(captured.saved.catalogue, commandBoundary.identity));
            const executor = createCommandExecutor({
              writer: options.writer,
              catalogue: commandBoundary,
              platform,
              handlers: {
                ...createPlanCommandHandlers(projection, context),
                ...createShoppingCommandHandlers(projection, context),
                async setFavourite(raw, payload, timestamp, execution) {
                  requireEvidence(commandSchemaVersion === 8);
                  const session = await favouriteSession(raw, captured.saved);
                  await admitContentFavouriteRows(session);
                  if (payload.saved) {
                    requireEvidence(context);
                    context.requireCurrent(payload.recipeId);
                    await runBound(
                      session,
                      'INSERT INTO recipe_identity(recipe_id) VALUES (?) ON CONFLICT(recipe_id) DO NOTHING',
                      [payload.recipeId],
                    );
                  } else await requireFavouriteIdentity(session, payload.recipeId);
                  guard();
                  const result = await favouriteCommandHandlers.setFavourite!(
                    session,
                    payload,
                    timestamp,
                    execution,
                  );
                  await admitContentFavouriteRows(session);
                  guard();
                  return result;
                },
              },
              now: options.now,
              dateContext: options.dateContext,
              readReceipt: () => recover(owned),
              onCommitted: options.onCommitted,
              directHooks: {
                async enter(session, current) {
                  guard();
                  requireEvidence(await authority(session, current));
                  await preflightReceipt(session, current.operationId);
                  guard();
                  return guard;
                },
                async beforeExecute(session, current) {
                  const registered = await authority(session, current);
                  requireEvidence(registered);
                  requireEvidence(same(registered.catalogue, commandBoundary.identity));
                  await requireWorkspace(session, registered);
                  guard();
                },
              },
            });
            dispatchStarted = true;
            return executor.execute(owned);
          },
          owned.command.kind === 'setFavourite' && !owned.command.saved
            ? owned.command.recipeId
            : undefined,
        );
      } catch (error) {
        // A reservation/owner failure after dispatch cannot undo or disprove a
        // cooking COMMIT. Suppress stale evidence and recover through the reader.
        if (dispatchStarted && command)
          return { kind: 'uncertain', operationId: command.operationId };
        return {
          kind: 'failed',
          operationId: command?.operationId ?? input.operationId,
          error: errorDetail(error),
        };
      }
    },
    recover,
    close() {
      closed = true;
    },
  });
}
