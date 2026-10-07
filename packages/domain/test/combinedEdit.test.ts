import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import { commandFingerprintInput } from '@cookmate/contracts';
import type { CommandPayload, CommandResult, LocalCommand, Placement } from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import type { StoreChange } from '../src/services';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import { createPlanCommandHandlers } from '../../../apps/mobile/src/data/planCommands';
import { createShoppingCommandHandlers } from '../../../apps/mobile/src/data/shoppingCommands';
import { createShoppingRepository } from '../../../apps/mobile/src/data/shoppingRepository';
import {
  createStateRepositories,
  readReceiptInSnapshot,
} from '../../../apps/mobile/src/data/stateRepositories';
import { readSnapshot } from '../../../apps/mobile/src/data/query';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
const projection = {
  sha256: platform.sha256,
  readRecipe: (id: string) => catalogue.recipes.find((recipe) => recipe.recipeId === id),
};
const prepare = createCommandPreparer(platform, catalogueBoundary);
const placement = (day: number, mealKey: Placement['mealKey'] = 'dinner'): Placement => ({
  actualDate: `2026-09-${day}`,
  mealKey,
});

function receipt(result: CommandResult) {
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail();
  assert.equal(result.receipt.schemaVersion, 1);
  return result.receipt;
}

async function fixture() {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId: randomUUID(), shoppingScopeId: randomUUID(), conversationId: randomUUID() },
  );
  const reader = new SerializedReader(storage.connection);
  const state = createStateRepositories(reader, catalogueBoundary);
  const shopping = createShoppingRepository(reader, projection);
  const events: StoreChange[] = [];
  const faults = { statement: '', hits: 0 };
  const originalPrepare = storage.connection.prepare;
  storage.connection.prepare = async (sql) => {
    const statement = await originalPrepare(sql);
    return {
      ...statement,
      run: async (values) => {
        if (faults.statement && sql.startsWith(faults.statement)) {
          faults.hits++;
          throw new Error('injected combined-edit transaction failure');
        }
        await statement.run(values);
      },
    };
  };
  const executor = createCommandExecutor({
    writer,
    catalogue: catalogueBoundary,
    platform,
    handlers: {
      ...createPlanCommandHandlers(projection),
      ...createShoppingCommandHandlers(projection),
    },
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => ({ localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    readReceipt: (id) =>
      readSnapshot(reader, (session) => readReceiptInSnapshot(session, id, catalogueBoundary)),
    onCommitted: (change) => events.push(change),
  });
  const register = async (payload: CommandPayload) => {
    const command = await prepare(payload);
    assert.equal(command.schemaVersion, 2);
    await registerReadyIntent(
      writer,
      {
        userIntentId: command.userIntentId,
        revision: command.intentRevision,
        phase: 'ready',
        slots: [{ slotId: randomUUID(), command }],
      },
      catalogueBoundary,
      platform,
    );
    return command;
  };
  const run = async (payload: CommandPayload) => executor.execute(await register(payload));
  const plan = async () => {
    const result = await state.readPlan('2026-09-01', '2026-10-31');
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    if (result.kind !== 'ready') assert.fail();
    return result.value;
  };
  const list = async () => {
    const result = await shopping.readShopping();
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    if (result.kind !== 'ready') assert.fail();
    return result.value;
  };
  const add = async (recipeId: string, target: Placement) => {
    const occurrenceId = randomUUID();
    receipt(
      await run({
        kind: 'addPlan',
        occurrenceId,
        recipeId,
        placement: target,
        expectedTarget: { kind: 'empty' },
      }),
    );
    return (await plan()).occurrences.find((row) => row.occurrenceId === occurrenceId)!;
  };
  const select = async (occurrenceIds: string[]) =>
    receipt(
      await run({
        kind: 'setShoppingSelection',
        occurrenceIds,
        expectedShoppingScopeRevision: (await list()).scope.revision,
      }),
    );
  const purchaseAll = async () => {
    const before = await list();
    for (const group of before.groups)
      receipt(
        await run({
          kind: 'setPurchased',
          scopeId: before.scope.scopeId,
          groupKey: group.groupKey,
          purchased: true,
          expectedDemandFingerprint: group.demandFingerprint,
          expectedRevision: group.revision,
        }),
      );
  };
  const snapshot = () =>
    Object.fromEntries(
      [
        'plan_occurrence',
        'shopping_scope',
        'shopping_selection',
        'shopping_group',
        'shopping_contribution',
        'purchase_state',
        'state_revision',
        'pending_intent',
        'command_slot',
        'operation_receipt',
      ].map((table) => [
        table,
        storage.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  const revisions = () =>
    storage.database
      .prepare('SELECT collection, revision FROM state_revision ORDER BY collection')
      .all();
  return {
    ...storage,
    ...executor,
    register,
    run,
    plan,
    list,
    add,
    select,
    purchaseAll,
    snapshot,
    revisions,
    faults,
    events,
    close: () => writer.close(),
  };
}

test('combined recipe/date/meal edit preserves occurrence identity and updates selected demand in one operation', async () => {
  for (const selected of [false, true]) {
    const f = await fixture();
    try {
      const source = await f.add('53150', placement(28));
      const unrelated = await f.add('53064', placement(29, 'lunch'));
      await f.select([unrelated.occurrenceId, ...(selected ? [source.occurrenceId] : [])]);
      await f.purchaseAll();
      const before = await f.list();
      const originalOther = (await f.plan()).occurrences.find(
        (row) => row.occurrenceId === unrelated.occurrenceId,
      )!;
      const eventCount = f.events.length;
      const planRevision = f.database
        .prepare("SELECT revision FROM state_revision WHERE collection='plan'")
        .get()!.revision as number;
      const command = await f.register({
        kind: 'editPlan',
        occurrenceId: source.occurrenceId,
        expectedRevision: source.revision,
        expectedShoppingScopeRevision: before.scope.revision,
        recipeId: '53064',
        placement: placement(30, 'breakfast'),
      });
      const committed = receipt(await f.execute(command));
      assert.equal(committed.outcome, 'committed');
      assert.equal(committed.shoppingProjection, selected ? 'current' : 'unchanged');
      assert.deepEqual(committed.effects, [
        {
          kind: 'plan',
          entityId: source.occurrenceId,
          revision: source.revision + 1,
          change: 'updated',
          recipeId: '53064',
          placement: placement(30, 'breakfast'),
        },
      ]);
      const afterPlan = await f.plan();
      assert.equal(afterPlan.occurrences.length, 2);
      assert.deepEqual(
        afterPlan.occurrences.find((row) => row.occurrenceId === source.occurrenceId),
        {
          ...source,
          recipeId: '53064',
          placement: placement(30, 'breakfast'),
          revision: source.revision + 1,
        },
      );
      assert.deepEqual(
        afterPlan.occurrences.find((row) => row.occurrenceId === unrelated.occurrenceId),
        originalOther,
      );
      assert.equal(
        f.database.prepare("SELECT revision FROM state_revision WHERE collection='plan'").get()!
          .revision,
        planRevision + 1,
      );
      assert.equal(f.events.length, eventCount + 1);
      assert.deepEqual(f.events.at(-1)!.collections, selected ? ['plan', 'shopping'] : ['plan']);
      const after = await f.list();
      assert.deepEqual(after.scope, before.scope);
      if (selected) {
        assert.equal(after.projectionRevision, before.projectionRevision + 1);
        assert.ok(after.groups.length > 0);
        assert.ok(after.groups.every((group) => !group.purchased));
        const contributions = after.groups.flatMap((group) => group.contributions);
        assert.ok(contributions.every((row) => row.recipeId === '53064'));
        assert.equal(new Set(contributions.map((row) => row.occurrenceId)).size, 2);
        const expected = projection.readRecipe('53064')!;
        assert.equal(
          contributions.filter((row) => row.occurrenceId === source.occurrenceId).length,
          expected.ingredients.length +
            expected.annotations.filter(
              (annotation) => annotation.kind === 'instruction_only_ingredient',
            ).length,
        );
      } else assert.deepEqual(after, before);
      assert.equal(f.database.prepare('PRAGMA foreign_key_check').all().length, 0);
      const savedState = f.snapshot();
      assert.deepEqual(receipt(await f.execute(command)), committed);
      assert.deepEqual(f.snapshot(), savedState);
      assert.equal(f.events.length, eventCount + 1);
      const changed: LocalCommand = {
        ...command,
        command: {
          kind: 'editPlan',
          occurrenceId: source.occurrenceId,
          expectedRevision: source.revision,
          expectedShoppingScopeRevision: before.scope.revision,
          recipeId: '53064',
          placement: placement(30, 'lunch'),
        },
      };
      changed.payloadFingerprint = await platform.sha256(commandFingerprintInput(changed));
      const conflictingReplay = await f.execute(changed);
      assert.equal(conflictingReplay.kind, 'failed');
      if (conflictingReplay.kind === 'failed')
        assert.equal(conflictingReplay.error.code, 'operation_conflict');
      assert.deepEqual(f.snapshot(), savedState);
      await f.select([]);
      const afterSelectionChange = f.snapshot();
      assert.deepEqual(receipt(await f.execute(command)), committed);
      assert.deepEqual(f.snapshot(), afterSelectionChange);
    } finally {
      await f.close();
    }
  }
});

test('exact edit no-op preserves selected demand, purchase marks and revisions but requires the current scope guard', async () => {
  const f = await fixture();
  try {
    const source = await f.add('53150', placement(28));
    await f.select([source.occurrenceId]);
    await f.purchaseAll();
    const before = await f.list();
    const beforePlan = await f.plan();
    const beforeRevisions = f.revisions();
    const eventCount = f.events.length;
    const payload: Extract<CommandPayload, { kind: 'editPlan' }> = {
      kind: 'editPlan',
      occurrenceId: source.occurrenceId,
      expectedRevision: source.revision,
      expectedShoppingScopeRevision: before.scope.revision,
      recipeId: source.recipeId,
      placement: source.placement,
    };
    const command = await f.register(payload);
    const noOp = receipt(await f.execute(command));
    assert.equal(noOp.outcome, 'no_op');
    assert.equal(noOp.shoppingProjection, 'unchanged');
    assert.deepEqual(await f.list(), before);
    assert.deepEqual(await f.plan(), beforePlan);
    assert.deepEqual(f.revisions(), beforeRevisions);
    assert.equal(f.events.length, eventCount);
    const replayBefore = f.snapshot();
    assert.deepEqual(receipt(await f.execute(command)), noOp);
    assert.deepEqual(f.snapshot(), replayBefore);
    const stale = await f.register({
      ...payload,
      expectedShoppingScopeRevision: before.scope.revision + 1,
    });
    const staleBefore = f.snapshot();
    const failed = await f.execute(stale);
    assert.equal(failed.kind, 'failed');
    if (failed.kind === 'failed') assert.equal(failed.error.code, 'stale_context');
    assert.deepEqual(f.snapshot(), staleBefore);
  } finally {
    await f.close();
  }
});

test('combined edits reject stale occurrence, stale selection and occupied target without partial recipe or placement changes', async () => {
  const f = await fixture();
  try {
    const source = await f.add('53150', placement(28));
    const occupied = await f.add('53064', placement(29, 'lunch'));
    await f.select([source.occurrenceId]);
    const before = await f.list();
    const payload: Extract<CommandPayload, { kind: 'editPlan' }> = {
      kind: 'editPlan',
      occurrenceId: source.occurrenceId,
      expectedRevision: source.revision,
      expectedShoppingScopeRevision: before.scope.revision,
      recipeId: '53064',
      placement: placement(30, 'breakfast'),
    };
    for (const invalid of [
      { ...payload, expectedRevision: source.revision + 1 },
      { ...payload, expectedShoppingScopeRevision: before.scope.revision - 1 },
      { ...payload, placement: occupied.placement },
    ]) {
      const command = await f.register(invalid);
      const savedState = f.snapshot();
      const eventCount = f.events.length;
      const failed = await f.execute(command);
      assert.equal(failed.kind, 'failed');
      if (failed.kind === 'failed') assert.equal(failed.error.code, 'stale_context');
      assert.deepEqual(f.snapshot(), savedState);
      assert.equal(f.events.length, eventCount);
    }
  } finally {
    await f.close();
  }
});

test('combined edit failure after occurrence or projection writes rolls back all demand, purchases, revisions and receipt before retry', async () => {
  for (const failureStage of [
    'UPDATE plan_occurrence',
    'INSERT INTO shopping_contribution',
    'INSERT INTO operation_receipt',
  ]) {
    const f = await fixture();
    try {
      const source = await f.add('53150', placement(28));
      await f.select([source.occurrenceId]);
      await f.purchaseAll();
      const before = await f.list();
      const command = await f.register({
        kind: 'editPlan',
        occurrenceId: source.occurrenceId,
        expectedRevision: source.revision,
        expectedShoppingScopeRevision: before.scope.revision,
        recipeId: '53064',
        placement: placement(30, 'breakfast'),
      });
      const savedState = f.snapshot();
      const eventCount = f.events.length;
      f.faults.statement = failureStage;
      const failed = await f.execute(command);
      assert.equal(failed.kind, 'failed', failureStage);
      if (failed.kind === 'failed') assert.equal(failed.error.code, 'storage_failure');
      assert.equal(f.faults.hits, 1, failureStage);
      assert.deepEqual(f.snapshot(), savedState, failureStage);
      assert.deepEqual(await f.list(), before);
      assert.equal(f.events.length, eventCount);
      f.faults.statement = '';
      const committed = receipt(await f.execute(command));
      assert.deepEqual(receipt(await f.execute(command)), committed);
      assert.equal(f.events.length, eventCount + 1);
      assert.equal((await f.plan()).occurrences[0]!.revision, source.revision + 1);
      assert.equal((await f.list()).projectionRevision, before.projectionRevision + 1);
      assert.equal(f.database.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      await f.close();
    }
  }
});
