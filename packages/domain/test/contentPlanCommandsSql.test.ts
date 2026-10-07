import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import {
  createBundledContentSnapshot,
  createContentReader,
  verifySignedContentOverlay,
  type ContentOverlayManifest,
  type EffectiveContentSnapshot,
  type OverlayHead,
  type PublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import type { CommandPayload, CommandResult, Placement } from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import {
  createContentCommandContext,
  type ContentCommandContext,
} from '../../../apps/mobile/src/data/contentCommandContext';
import type { ContentReadingView } from '../../../apps/mobile/src/data/contentReleaseStore';
import { createPlanCommandHandlers } from '../../../apps/mobile/src/data/planCommands';
import { createShoppingCommandHandlers } from '../../../apps/mobile/src/data/shoppingCommands';
import { readShoppingLedgerInSnapshot } from '../../../apps/mobile/src/data/shoppingRepository';
import { readReceiptInSnapshot } from '../../../apps/mobile/src/data/stateRepositories';
import { readSnapshot } from '../../../apps/mobile/src/data/query';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { member, published, signed } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z',
  authorId = '900000001',
  otherId = '900000002';
const platform = { sha256, newId: randomUUID };
const legacyProjection = { sha256, readRecipe: catalogue.getRecipe };
const placement = (day: number): Placement => ({
  actualDate: `2026-10-${String(day).padStart(2, '0')}`,
  mealKey: 'dinner',
});
function receipt(result: CommandResult) {
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail();
  return result.receipt;
}
function failed(result: CommandResult, code?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (result.kind !== 'failed') assert.fail();
  if (code) assert.equal(result.error.code, code);
  return result.error;
}
// Core-verified controlled content ports. Actual signatures and cross-connection
// reservation/commit lifetime are proven in the separate content-store suites.
async function contentFixture() {
  const baseline = await createBundledContentSnapshot(sha256);
  const document = authoredFixture(authorId),
    other = authoredFixture(otherId);
  if (document.kind !== 'authored' || other.kind !== 'authored') throw new Error('fixture');
  document.recipe.ingredients = [{ position: 1, rawName: 'Salt', rawMeasure: '100g' }];
  other.recipe.ingredients = [{ position: 1, rawName: 'Oil', rawMeasure: '1 tbsp' }];
  let current = await published(document, 'plan-authored-1');
  const otherPublication = await published(other, 'plan-other-1');
  const releases = new Map<string, { manifest: ContentOverlayManifest; fingerprint: string }>(),
    publications = new Map<string, PublishedRecipeRevision>();
  let head: OverlayHead | null = null,
    snapshot: EffectiveContentSnapshot;
  async function issue(mode: 'first' | 'quantity' | 'archive' | 'withdraw' = 'first') {
    const sequence = (head?.sequence ?? 0) + 1;
    if (mode === 'quantity') {
      const next = clone(current.revision.document);
      if (next.kind !== 'authored') throw new Error('fixture');
      next.provenance.basedOn = clone(current.revision.ref);
      next.recipe.ingredients[0]!.rawMeasure = '200g';
      current = await published(next, `plan-authored-${sequence}`);
    }
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `plan-release-${sequence}`,
      sequence,
      previous: head,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: { ...catalogue.identity },
      entries: [
        mode === 'withdraw'
          ? { state: 'withdrawn', recipeId: authorId, reason: 'Fixture withdrawn' }
          : mode === 'archive'
            ? {
                state: 'archived',
                ref: clone(current.revision.ref),
                publicationFingerprint: current.publicationFingerprint,
                reason: 'Fixture archived',
              }
            : member(current),
        member(otherPublication),
      ],
    };
    const envelope = await signed(manifest);
    const newly = [current, otherPublication].filter(
      (item) => !publications.has(`${item.revision.ref.recipeId}|${item.revision.ref.revisionId}`),
    );
    snapshot = await verifySignedContentOverlay(envelope, {
      sha256,
      baseline: { identity: { ...catalogue.identity }, revisions: baseline.revisions },
      expectedCurrent: head,
      minimumSequence: head?.sequence ?? 0,
      readerVersion: 1,
      publications: newly,
      retainedRefs: [...publications.values()].map((item) => item.revision.ref),
      trustVerifier: {
        async verify(value) {
          return (
            value.keyId === 'fixture-key' && value.signature === 'synthetic_signature_no_crypto'
          );
        },
      },
      mediaVerifier: {
        async verify() {
          return true;
        },
      },
      archive: {
        async readRelease(id) {
          return releases.get(id) ?? null;
        },
        async readPublication(id, revisionId) {
          return publications.get(`${id}|${revisionId}`) ?? null;
        },
      },
    });
    head = { releaseId: manifest.releaseId, sequence, fingerprint: envelope.fingerprint };
    releases.set(manifest.releaseId, { manifest, fingerprint: envelope.fingerprint });
    for (const item of newly)
      publications.set(`${item.revision.ref.recipeId}|${item.revision.ref.revisionId}`, item);
  }
  await issue();
  return {
    issue,
    get head() {
      return head!;
    },
    get snapshot() {
      return snapshot;
    },
    get ref() {
      return current.revision.ref;
    },
  };
}

async function fixture(t: TestContext, bundled = false) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-content-')),
    path = join(directory, 'cooking.db'),
    write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  t.after(async () => {
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    ids,
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  await migrateCookingContentDatabase(writer, { sha256 });
  const content = await contentFixture();
  let revision = 0,
    active = true,
    context: ContentCommandContext;
  const faults = { statement: '', commitAck: false, afterStatement: (_sql: string) => {} };
  const originalPrepare = write.connection.prepare,
    originalExec = write.connection.exec;
  write.connection.prepare = async (sql) => {
    const statement = await originalPrepare(sql);
    return {
      ...statement,
      async run(values) {
        if (faults.statement && sql.startsWith(faults.statement))
          throw new Error('fixture command write fault');
        await statement.run(values);
        faults.afterStatement(sql);
      },
    };
  };
  write.connection.exec = async (sql) => {
    await originalExec(sql);
    if (sql === 'COMMIT' && faults.commitAck) {
      faults.commitAck = false;
      throw new Error('fixture lost acknowledgement');
    }
  };
  async function refresh(useBundled = false) {
    // Fixture setup simulates an already committed adoption; production head writes remain in contentAdoption.
    write.database
      .prepare('UPDATE app_content_adoption SET revision=?,head_json=?')
      .run(revision, useBundled ? null : JSON.stringify(content.head));
    const view: ContentReadingView = {
      head: useBundled ? null : content.head,
      latestHead: content.head,
      snapshot: useBundled ? null : content.snapshot,
      hasWithdrawal: false,
      assertActive() {
        assert.equal(active, true, 'content reservation expired');
        return undefined;
      },
      async readPhoto() {
        throw new Error('photo port unused');
      },
    };
    context = await createContentCommandContext({
      view,
      expectedAdoptionRevision: revision,
      sha256,
    });
  }
  await refresh(bundled);
  function executor(selected: ContentCommandContext | undefined = context) {
    const boundary = selected?.commandBoundary ?? catalogueBoundary;
    return createCommandExecutor({
      writer,
      catalogue: boundary,
      platform,
      handlers: {
        ...createPlanCommandHandlers(legacyProjection, selected),
        ...createShoppingCommandHandlers(legacyProjection, selected),
      },
      now: () => at,
      dateContext: () => ({
        localDate: '2026-10-01',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      readReceipt: (id) =>
        readSnapshot(reader, (session) => readReceiptInSnapshot(session, id, boundary)),
      onCommitted() {},
    });
  }
  async function register(payload: CommandPayload) {
    const boundary = context.commandBoundary;
    const command = await createCommandPreparer(platform, boundary)(payload);
    await registerReadyIntent(
      writer,
      {
        userIntentId: command.userIntentId,
        revision: command.intentRevision,
        phase: 'ready',
        slots: [{ slotId: randomUUID(), command }],
      },
      boundary,
      platform,
    );
    return command;
  }
  const run = async (payload: CommandPayload, selected = context) =>
    executor(selected).execute(await register(payload));
  const scopeRevision = () =>
    write.database.prepare('SELECT revision FROM shopping_scope').get()!.revision as number;
  const pin = (id: string) =>
    write.database
      .prepare(
        'SELECT recipe_id recipeId,revision_id revisionId,content_fingerprint contentFingerprint FROM plan_content_pin WHERE occurrence_id=?',
      )
      .get(id);
  const occurrence = (id: string) =>
    write.database.prepare('SELECT * FROM plan_occurrence WHERE occurrence_id=?').get(id)!;
  const add = async (recipeId: string, day: number) => {
    const occurrenceId = randomUUID();
    receipt(
      await run({
        kind: 'addPlan',
        occurrenceId,
        recipeId,
        placement: placement(day),
        expectedTarget: { kind: 'empty' },
      }),
    );
    return occurrenceId;
  };
  const select = (occurrenceIds: string[]) =>
    run({
      kind: 'setShoppingSelection',
      occurrenceIds,
      expectedShoppingScopeRevision: scopeRevision(),
    });
  const shopping = () =>
    reader.transaction(
      async (session) =>
        (await readShoppingLedgerInSnapshot(session, await context.projection(session))).snapshot,
      { kind: 'read_only' },
    );
  return {
    db: write.database,
    writer,
    reader,
    ids,
    content,
    faults,
    run,
    register,
    executor,
    scopeRevision,
    pin,
    occurrence,
    add,
    select,
    shopping,
    get context() {
      return context;
    },
    setActive(value: boolean) {
      active = value;
    },
    async next(mode: Parameters<typeof content.issue>[0]) {
      await content.issue(mode);
      revision++;
      await refresh();
    },
  };
}
function state(db: ReturnType<typeof desktopConnection>['database']) {
  return [
    'plan_occurrence',
    'plan_content_pin',
    'shopping_scope',
    'shopping_selection',
    'shopping_contribution',
    'shopping_group',
    'purchase_state',
    'operation_receipt',
    'state_revision',
    'recipe_identity',
    'recipe_content_revision',
    'recipe_content_source',
  ].map((table) => ({ table, rows: db.prepare(`SELECT * FROM ${table}`).all() }));
}

test('authored add/select/replace/remove uses existing receipts and exact source identities without workbook rows', async (t) => {
  const f = await fixture(t),
    id = await f.add(authorId, 1);
  assert.deepEqual({ ...f.pin(id)! }, f.content.ref);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipe WHERE recipe_id=?').get(authorId)!.n, 0);
  receipt(await f.select([id]));
  assert.equal((await f.shopping()).groups[0]!.quantityLabel, '100 g');
  const command = await f.register({
    kind: 'replacePlanRecipe',
    occurrenceId: id,
    expectedRevision: 1,
    recipeId: otherId,
    placement: placement(1),
    expectedShoppingScopeRevision: f.scopeRevision(),
  });
  const first = receipt(await f.executor().execute(command)),
    snapshot = state(f.db);
  assert.equal(f.pin(id)!.recipeId, otherId);
  assert.equal((await f.shopping()).groups[0]!.displayName, 'Oil');
  assert.deepEqual(receipt(await f.executor().execute(command)), first);
  assert.deepEqual(state(f.db), snapshot);
  receipt(
    await f.run({
      kind: 'editPlan',
      occurrenceId: id,
      expectedRevision: 2,
      recipeId: authorId,
      placement: placement(2),
      expectedShoppingScopeRevision: f.scopeRevision(),
    }),
  );
  assert.equal(f.pin(id)!.recipeId, authorId);
  assert.equal(f.occurrence(id).local_date, placement(2).actualDate);
  assert.equal((await f.shopping()).groups[0]!.quantityLabel, '100 g');
  receipt(
    await f.run({
      kind: 'removePlan',
      occurrenceId: id,
      expectedRevision: 3,
      expectedShoppingScopeRevision: f.scopeRevision(),
    }),
  );
  assert.equal(f.pin(id), undefined);
  assert.equal((await f.shopping()).groups.length, 0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('same recipe occurrences keep separate revisions; moves and same-recipe no-ops preserve old demand and purchase marks', async (t) => {
  const f = await fixture(t),
    first = await f.add(authorId, 1),
    firstRef = f.pin(first);
  receipt(await f.select([first]));
  const group = (await f.shopping()).groups[0]!;
  receipt(
    await f.run({
      kind: 'setPurchased',
      scopeId: f.ids.shoppingScopeId,
      groupKey: group.groupKey,
      expectedDemandFingerprint: group.demandFingerprint,
      expectedRevision: group.revision,
      purchased: true,
    }),
  );
  await f.next('quantity');
  const before = f.db.prepare('SELECT * FROM purchase_state').all();
  receipt(
    await f.run({
      kind: 'editPlan',
      occurrenceId: first,
      expectedRevision: 1,
      recipeId: authorId,
      placement: placement(2),
      expectedShoppingScopeRevision: f.scopeRevision(),
    }),
  );
  const noop = receipt(
    await f.run({
      kind: 'replacePlanRecipe',
      occurrenceId: first,
      expectedRevision: 2,
      recipeId: authorId,
      placement: placement(2),
      expectedShoppingScopeRevision: f.scopeRevision(),
    }),
  );
  assert.equal(noop.outcome, 'no_op');
  assert.deepEqual(f.pin(first), firstRef);
  assert.deepEqual(f.db.prepare('SELECT * FROM purchase_state').all(), before);
  const second = await f.add(authorId, 3);
  assert.notEqual(f.pin(first)!.revisionId, f.pin(second)!.revisionId);
  receipt(await f.select([first, second]));
  const shopping = await f.shopping();
  assert.equal(shopping.groups[0]!.quantityLabel, '300 g');
  assert.equal(shopping.groups[0]!.purchased, false);
  assert.equal(
    f.db.prepare('SELECT COUNT(DISTINCT revision_id) n FROM shopping_contribution').get()!.n,
    2,
  );
});

test('move-replacing keeps source pin and removes destination pin and selected contribution atomically', async (t) => {
  const f = await fixture(t),
    source = await f.add(authorId, 1),
    destination = await f.add(otherId, 2),
    ref = f.pin(source);
  receipt(await f.select([source, destination]));
  await f.next('quantity');
  receipt(
    await f.run({
      kind: 'movePlanReplacing',
      occurrenceId: source,
      expectedRevision: 1,
      destinationOccurrenceId: destination,
      expectedDestinationRevision: 1,
      recipeId: authorId,
      placement: placement(2),
      expectedShoppingScopeRevision: f.scopeRevision(),
    }),
  );
  assert.deepEqual(f.pin(source), ref);
  assert.equal(f.pin(destination), undefined);
  const shopping = await f.shopping();
  assert.deepEqual(shopping.scope.occurrenceIds, [source]);
  assert.equal(shopping.groups[0]!.quantityLabel, '100 g');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('stale adoption head, occurrence and selection guards reject without content or demand changes', async (t) => {
  const f = await fixture(t),
    id = await f.add(authorId, 1),
    old = f.context;
  await f.next('quantity');
  for (const [payload, context] of [
    [
      {
        kind: 'addPlan',
        occurrenceId: randomUUID(),
        recipeId: authorId,
        placement: placement(2),
        expectedTarget: { kind: 'empty' },
      },
      old,
    ],
    [
      {
        kind: 'editPlan',
        occurrenceId: id,
        expectedRevision: 9,
        recipeId: otherId,
        placement: placement(1),
        expectedShoppingScopeRevision: f.scopeRevision(),
      },
      f.context,
    ],
    [
      { kind: 'setShoppingSelection', occurrenceIds: [id], expectedShoppingScopeRevision: 99 },
      f.context,
    ],
  ] as const) {
    const before = state(f.db);
    failed(await f.run(payload as CommandPayload, context), 'stale_context');
    assert.deepEqual(state(f.db), before);
  }
});

test('missing pins, unavailable demand, expired reservation and context-free schema7 writes fail closed', async (t) => {
  const f = await fixture(t),
    id = await f.add(authorId, 1);
  receipt(await f.select([id]));
  const select: CommandPayload = {
    kind: 'setShoppingSelection',
    occurrenceIds: [],
    expectedShoppingScopeRevision: f.scopeRevision(),
  };
  const command = await f.register(select),
    before = state(f.db);
  f.setActive(false);
  failed(await f.executor().execute(command));
  assert.deepEqual(state(f.db), before);
  f.setActive(true);
  const noContext = createCommandExecutor({
    writer: f.writer,
    catalogue: f.context.commandBoundary,
    platform,
    handlers: {
      ...createPlanCommandHandlers(legacyProjection),
      ...createShoppingCommandHandlers(legacyProjection),
    },
    now: () => at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    readReceipt: (operationId) =>
      readSnapshot(f.reader, (session) =>
        readReceiptInSnapshot(session, operationId, f.context.commandBoundary),
      ),
    onCommitted() {},
  });
  failed(await noContext.execute(command));
  const addCommand = await f.register({
    kind: 'addPlan',
    occurrenceId: randomUUID(),
    recipeId: otherId,
    placement: placement(2),
    expectedTarget: { kind: 'empty' },
  });
  failed(await noContext.execute(addCommand));
  assert.deepEqual(state(f.db), before);
  f.db.exec('PRAGMA foreign_keys=OFF');
  f.db.prepare('DELETE FROM plan_content_pin WHERE occurrence_id=?').run(id);
  f.db.exec('PRAGMA foreign_keys=ON');
  const corrupted = state(f.db);
  failed(await f.executor().execute(command));
  assert.deepEqual(state(f.db), corrupted);
});

test('archived authored plans use identity validation for moves, destination removal and durable receipt recovery', async (t) => {
  const f = await fixture(t),
    first = randomUUID();
  const addCommand = await f.register({
    kind: 'addPlan',
    occurrenceId: first,
    recipeId: authorId,
    placement: placement(1),
    expectedTarget: { kind: 'empty' },
  });
  const saved = receipt(await f.executor().execute(addCommand));
  const destination = await f.add(authorId, 2),
    source = await f.add(otherId, 3),
    ref = f.pin(first);
  receipt(await f.select([first, destination, source]));
  await f.next('archive');
  const discovery = createContentReader(f.content.snapshot);
  assert.equal(discovery.boundary.recipeIds.has(authorId), false);
  assert.equal(discovery.getRecipe(authorId), undefined);
  assert.equal(f.context.commandBoundary.recipeIds.has(authorId), true);
  assert.equal(
    f.context.commandBoundary.hasSource({ recipeId: authorId, section: 'recipe' }),
    false,
  );
  receipt(
    await f.run({
      kind: 'editPlan',
      occurrenceId: first,
      expectedRevision: 1,
      recipeId: authorId,
      placement: placement(4),
      expectedShoppingScopeRevision: f.scopeRevision(),
    }),
  );
  assert.deepEqual(f.pin(first), ref);
  const moved = receipt(
    await f.run({
      kind: 'movePlanReplacing',
      occurrenceId: source,
      expectedRevision: 1,
      destinationOccurrenceId: destination,
      expectedDestinationRevision: 1,
      recipeId: otherId,
      placement: placement(2),
      expectedShoppingScopeRevision: f.scopeRevision(),
    }),
  );
  assert.ok(
    moved.effects.some(
      (effect) =>
        effect.kind === 'plan' && effect.recipeId === authorId && effect.change === 'removed',
    ),
  );
  receipt(
    await f.run({
      kind: 'removePlan',
      occurrenceId: first,
      expectedRevision: 2,
      expectedShoppingScopeRevision: f.scopeRevision(),
    }),
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM plan_occurrence WHERE recipe_id=?').get(authorId)!.n,
    0,
  );
  // New reservation/context, no remaining plan identity to infer from, and a later signed head.
  await f.next('archive');
  const after = state(f.db);
  assert.deepEqual(
    await f.reader.transaction(
      (session) =>
        readReceiptInSnapshot(session, addCommand.operationId, f.context.commandBoundary),
      { kind: 'read_only' },
    ),
    saved,
  );
  assert.deepEqual(receipt(await f.executor().execute(addCommand)), saved);
  assert.deepEqual(state(f.db), after);
  const unknown = '999999999';
  assert.equal(f.context.commandBoundary.recipeIds.has(unknown), false);
  assert.equal('add' in f.context.commandBoundary.recipeIds, false);
  f.context.commandBoundary.recipeIds.forEach((_id, _key, ids) =>
    assert.equal(ids, f.context.commandBoundary.recipeIds),
  );
  await assert.rejects(
    f.register({
      kind: 'addPlan',
      occurrenceId: randomUUID(),
      recipeId: unknown,
      placement: placement(5),
      expectedTarget: { kind: 'empty' },
    }),
    /contract.unknown_recipe/,
  );
  assert.deepEqual(state(f.db), after);
});

test('archived saved demand remains exact but archived/withdrawn recipes cannot create new pins', async (t) => {
  const f = await fixture(t),
    id = await f.add(authorId, 1),
    ref = f.pin(id);
  receipt(await f.select([id]));
  await f.next('archive');
  assert.equal((await f.shopping()).groups[0]!.quantityLabel, '100 g');
  assert.deepEqual(f.pin(id), ref);
  for (const mode of ['archive', 'withdraw'] as const) {
    if (mode === 'withdraw') await f.next('withdraw');
    const before = state(f.db);
    const error = failed(
      await f.run({
        kind: 'addPlan',
        occurrenceId: randomUUID(),
        recipeId: authorId,
        placement: placement(2),
        expectedTarget: { kind: 'empty' },
      }),
      'stale_context',
    );
    assert.equal(error.messageKey, 'content.current_recipe_unavailable');
    assert.deepEqual(state(f.db), before);
  }
  await assert.rejects(f.shopping(), /Pinned shopping content/);
  const before = state(f.db);
  failed(await f.select([]));
  assert.deepEqual(state(f.db), before);
});

test('pin/source and shopping failures roll back, while lost acknowledgements recover the existing command receipt', async (t) => {
  const f = await fixture(t),
    id = await f.add(authorId, 1);
  receipt(await f.select([id]));
  const command = await f.register({
    kind: 'replacePlanRecipe',
    occurrenceId: id,
    expectedRevision: 1,
    recipeId: otherId,
    placement: placement(1),
    expectedShoppingScopeRevision: f.scopeRevision(),
  });
  for (const prefix of ['INSERT INTO plan_content_pin', 'INSERT INTO shopping_contribution']) {
    const before = state(f.db);
    f.faults.statement = prefix;
    failed(await f.executor().execute(command));
    assert.deepEqual(state(f.db), before);
  }
  f.faults.statement = '';
  const beforeExpiry = state(f.db);
  f.faults.afterStatement = (sql) => {
    if (sql.startsWith('DELETE FROM plan_content_pin')) f.setActive(false);
  };
  failed(await f.executor().execute(command));
  assert.deepEqual(state(f.db), beforeExpiry);
  f.setActive(true);
  f.faults.afterStatement = () => {};
  f.faults.commitAck = true;
  const saved = receipt(await f.executor().execute(command)),
    after = state(f.db);
  assert.equal(saved.outcome, 'committed');
  assert.deepEqual(receipt(await f.executor().execute(command)), saved);
  assert.deepEqual(state(f.db), after);
});

test('null adopted head uses independently packaged exact pins', async (t) => {
  const f = await fixture(t, true),
    id = await f.add(catalogue.recipes[0]!.recipeId, 1);
  receipt(await f.select([id]));
  assert.ok(f.pin(id));
  assert.ok((await f.shopping()).groups.length);
  assert.equal(f.db.prepare('SELECT head_json FROM app_content_adoption').get()!.head_json, null);
});
