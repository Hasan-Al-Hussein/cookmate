import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { CommandPayload, CommandResult, LocalCommand, Placement } from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import type { ShoppingGroup, StoreChange } from '../src/services';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import { createPlanCommandHandlers } from '../../../apps/mobile/src/data/planCommands';
import { createShoppingCommandHandlers } from '../../../apps/mobile/src/data/shoppingCommands';
import { createShoppingRepository } from '../../../apps/mobile/src/data/shoppingRepository';
import { createDirectActionReviewer } from '../../../apps/mobile/src/data/directActionReview';
import type { DirectActionInput } from '../src/directActions';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  createStateRepositories,
  readReceiptInSnapshot,
} from '../../../apps/mobile/src/data/stateRepositories';
import { readSnapshot } from '../../../apps/mobile/src/data/query';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

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
  return result.receipt;
}
function failed(result: CommandResult, code: string) {
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.equal(result.error.code, code);
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-'));
  const path = join(directory, 'shopping.db');
  const db = desktopConnection(path);
  await configureConnection(db.connection);
  const writer = new SerializedWriter(db.connection);
  const seed = {
    identity: catalogue.identity,
    recipes: catalogue.recipes,
    recipeSources: catalogueProvenance.recipeSources,
  };
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(writer, seed, ids);
  const read = desktopConnection(path);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const reader = new SerializedReader(read.connection);
  const faults = { statement: '', commitAck: false, afterStatement: (_sql: string) => {} };
  const originalPrepare = db.connection.prepare;
  db.connection.prepare = async (sql) => {
    const statement = await originalPrepare(sql);
    return {
      ...statement,
      run: async (values) => {
        if (faults.statement && sql.startsWith(faults.statement))
          throw new Error('injected transaction fault');
        await statement.run(values);
        faults.afterStatement(sql);
      },
    };
  };
  const originalExec = db.connection.exec;
  db.connection.exec = async (sql) => {
    await originalExec(sql);
    if (sql === 'COMMIT' && faults.commitAck) {
      faults.commitAck = false;
      throw new Error('lost commit acknowledgement');
    }
  };
  const state = createStateRepositories(reader, catalogueBoundary);
  const shopping = createShoppingRepository(reader, projection);
  const reviewer = createDirectActionReviewer(reader, {
    ...projection,
    platform,
    catalogue: catalogueBoundary,
  });
  const review = async (input: DirectActionInput) => {
    const result = await reviewer(input);
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    if (result.kind !== 'ready') assert.fail();
    return result.value;
  };
  const events: StoreChange[] = [];
  let currentDate = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  const executor = createCommandExecutor({
    writer,
    catalogue: catalogueBoundary,
    platform,
    handlers: {
      ...createPlanCommandHandlers(projection),
      ...createShoppingCommandHandlers(projection),
    },
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => currentDate,
    readReceipt: (operationId) =>
      readSnapshot(reader, (session) =>
        readReceiptInSnapshot(session, operationId, catalogueBoundary),
      ),
    onCommitted: (change) => events.push(change),
  });
  const register = async (command: LocalCommand) => {
    await registerReadyIntent(
      writer,
      {
        userIntentId: command.userIntentId,
        revision: command.intentRevision,
        phase: 'ready',
        ...(command.origin ? { origin: command.origin } : {}),
        slots: [{ slotId: randomUUID(), command }],
      },
      catalogueBoundary,
      platform,
    );
    return command;
  };
  const execute = async (payload: CommandPayload) =>
    executor.execute(await register(await prepare(payload)));
  const snapshot = async () => {
    const result = await shopping.readShopping();
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    if (result.kind !== 'ready') assert.fail();
    return result.value;
  };
  const plan = async () => {
    const result = await state.readPlan('2026-09-01', '2026-10-31');
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') assert.fail();
    return result.value;
  };
  const add = async (recipeId: string, target: Placement) => {
    const occurrenceId = randomUUID();
    receipt(
      await execute({
        kind: 'addPlan',
        occurrenceId,
        recipeId,
        placement: target,
        expectedTarget: { kind: 'empty' },
      }),
    );
    return (await plan()).occurrences.find((item) => item.occurrenceId === occurrenceId)!;
  };
  const select = async (occurrenceIds: string[]) =>
    execute({
      kind: 'setShoppingSelection',
      occurrenceIds,
      expectedShoppingScopeRevision: (await snapshot()).scope.revision,
    });
  const purchase = async (group: ShoppingGroup, purchased = true) =>
    execute({
      kind: 'setPurchased',
      scopeId: ids.shoppingScopeId,
      groupKey: group.groupKey,
      expectedDemandFingerprint: group.demandFingerprint,
      expectedRevision: group.revision,
      purchased,
    });
  return {
    ...executor,
    executePayload: execute,
    register,
    db,
    writer,
    reader,
    ids,
    faults,
    events,
    state,
    shopping,
    snapshot,
    plan,
    add,
    select,
    purchase,
    review,
    path,
    seed,
    changeDate: (date: typeof currentDate) => {
      currentDate = date;
    },
    close: async () => {
      await reader.close();
      await writer.close();
      await removeFixtureDirectory(directory);
    },
  };
}

test('selection review predicts exact canonical groups, unchanged marks, provenance changes, removals and dormant re-addition', async () => {
  const f = await fixture();
  try {
    const first = await f.add('53064', placement(28));
    const duplicate = await f.add('53064', placement(29));
    const other = await f.add('53150', placement(30));
    const inspectAndApply = async (ids: string[]) => {
      const before = await f.snapshot();
      const beforeChanges = f.db.database.prepare('SELECT total_changes() AS n').get()?.n;
      const reviewed = await f.review({ kind: 'setShoppingSelection', occurrenceIds: ids });
      assert.equal(
        f.db.database.prepare('SELECT total_changes() AS n').get()?.n,
        beforeChanges,
        'review is read-only',
      );
      if (
        reviewed.consequences.kind !== 'shopping_selection' ||
        reviewed.payload.kind !== 'setShoppingSelection'
      )
        assert.fail();
      assert.equal(typeof reviewed.payload.expectedShoppingRevision, 'number');
      const effects = reviewed.consequences.shoppingEffects;
      const command = await f.register(await prepare(reviewed.payload));
      const result = receipt(await f.execute(command));
      const after = await f.snapshot();
      const retained = [...effects.added, ...effects.demandChanged, ...effects.unchanged];
      assert.equal(retained.length, after.groups.length);
      for (const effect of retained) {
        const actual = after.groups.find((group) => group.groupKey === effect.groupKey)!;
        assert.ok(actual);
        assert.deepEqual(effect.after, {
          quantityLabel: actual.quantityLabel,
          purchased: actual.purchased,
          changed: actual.changed,
        });
        assert.equal(effect.displayName, actual.displayName);
      }
      for (const effect of [...effects.removed, ...effects.demandChanged, ...effects.unchanged]) {
        const actual = before.groups.find((group) => group.groupKey === effect.groupKey)!;
        assert.ok(actual);
        assert.deepEqual(effect.before, {
          quantityLabel: actual.quantityLabel,
          purchased: actual.purchased,
          changed: actual.changed,
        });
      }
      for (const effect of effects.removed) {
        assert.equal(effect.after, null);
        assert.equal(
          after.groups.some((group) => group.groupKey === effect.groupKey),
          false,
        );
      }
      return { effects, result, after, command };
    };
    const initial = await inspectAndApply([first.occurrenceId]);
    assert.ok(initial.effects.added.length > 0);
    assert.equal(
      initial.effects.removed.length +
        initial.effects.demandChanged.length +
        initial.effects.unchanged.length,
      0,
    );
    const sourceGroup = initial.after.groups.find(
      (group) => group.quantityLabel === 'Review source instructions',
    )!;
    assert.ok(sourceGroup);
    receipt(await f.purchase(sourceGroup));
    const same = await inspectAndApply([first.occurrenceId]);
    assert.equal(same.result.outcome, 'no_op');
    assert.equal(same.effects.unchanged.length, initial.after.groups.length);
    assert.equal(same.effects.checkedMarksRequiringReview + same.effects.checkedMarksRemoved, 0);
    assert.equal(
      same.effects.unchanged.find((group) => group.groupKey === sourceGroup.groupKey)!.after!
        .purchased,
      true,
    );
    const expanded = await inspectAndApply([duplicate.occurrenceId, first.occurrenceId]);
    assert.equal(expanded.effects.demandChanged.length, initial.after.groups.length);
    assert.equal(expanded.effects.checkedMarksRequiringReview, 1);
    const sameLabel = expanded.effects.demandChanged.find(
      (group) => group.groupKey === sourceGroup.groupKey,
    )!;
    assert.equal(
      sameLabel.before!.quantityLabel,
      sameLabel.after!.quantityLabel,
      'same visible quantity still has changed exact demand',
    );
    assert.equal(sameLabel.after!.purchased, false);
    assert.equal(sameLabel.after!.changed, true);
    const mixed = await inspectAndApply([first.occurrenceId, other.occurrenceId]);
    assert.ok(mixed.effects.added.length > 0);
    receipt(await f.purchase(mixed.after.groups[0]!));
    const removed = await inspectAndApply([]);
    assert.equal(removed.effects.removed.length, mixed.after.groups.length);
    assert.equal(removed.effects.checkedMarksRemoved, 1);
    const readded = await inspectAndApply([first.occurrenceId]);
    assert.ok(
      readded.effects.added.every((group) => !group.after!.purchased && group.after!.changed),
    );
    assert.deepEqual(await f.execute(removed.command), {
      kind: 'receipt',
      receipt: removed.result,
    });
  } finally {
    await f.close();
  }
});

test('selection purchase-state guard rejects changed checked marks before registration and execution, preserving legacy commands and receipt replay', async () => {
  const f = await fixture();
  try {
    const occurrence = await f.add('53064', placement(28));
    receipt(await f.select([occurrence.occurrenceId]));
    const reviewed = await f.review({ kind: 'setShoppingSelection', occurrenceIds: [] });
    const registered = await f.register(await prepare(reviewed.payload));
    const unregistered = await prepare(reviewed.payload);
    const before = await f.snapshot();
    receipt(await f.purchase(before.groups[0]!));
    await assert.rejects(f.register(unregistered), {
      name: 'CommandFault',
      message: 'shopping.reviewed_purchases_changed',
    });
    failed(await f.execute(registered), 'stale_context');
    const after = await f.snapshot();
    assert.deepEqual(after.scope, before.scope);
    assert.equal(after.groups[0]!.purchased, true);
    const latest = await f.review({ kind: 'setShoppingSelection', occurrenceIds: [] });
    if (latest.consequences.kind !== 'shopping_selection') assert.fail();
    assert.equal(latest.consequences.shoppingEffects.checkedMarksRemoved, 1);
    const command = await f.register(await prepare(latest.payload));
    const cleared = receipt(await f.execute(command));
    // Existing low-level legacy commands have no new optional field and retain their semantics.
    receipt(await f.select([occurrence.occurrenceId]));
    assert.deepEqual(await f.execute(command), { kind: 'receipt', receipt: cleared });
  } finally {
    await f.close();
  }
});

test('relative-date context changed during awaited SQL rolls back the whole command before commit', async () => {
  const f = await fixture();
  try {
    const command = await f.register(
      await prepare(
        {
          kind: 'addPlan',
          occurrenceId: randomUUID(),
          recipeId: '53150',
          placement: placement(29),
          expectedTarget: { kind: 'empty' },
        },
        {
          relativeDateGuard: {
            interpretedAt: {
              localDate: '2026-09-28',
              timeZone: 'Asia/Dubai',
              utcOffsetMinutes: 240,
            },
            resolvedDate: '2026-09-29',
            sourceMessageId: randomUUID(),
          },
        },
      ),
    );
    f.faults.afterStatement = (sql) => {
      if (sql.startsWith('INSERT INTO operation_receipt'))
        f.changeDate({ localDate: '2026-09-29', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 });
    };
    failed(await f.execute(command), 'stale_context');
    assert.equal((await f.plan()).occurrences.length, 0);
    assert.equal((await f.snapshot()).groups.length, 0);
    assert.equal(f.db.database.prepare('SELECT COUNT(*) AS n FROM operation_receipt').get()!.n, 0);
    assert.equal(
      f.db.database.prepare("SELECT revision FROM state_revision WHERE collection='store'").get()!
        .revision,
      0,
    );
    assert.deepEqual(f.events, []);
    f.faults.afterStatement = () => {};
    f.changeDate({ localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 });
    receipt(await f.execute(command));
  } finally {
    await f.close();
  }
});

test('actual plan commands require explicit selection, preserve repeated occurrences and keep exact retry/no-op distinct', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.snapshot()).groups.length, 0);
    const a = await f.add('53150', placement(28));
    const b = await f.add('53150', placement(29));
    assert.deepEqual((await f.snapshot()).scope.occurrenceIds, []);
    const command = await f.register(
      await prepare({
        kind: 'setShoppingSelection',
        occurrenceIds: [b.occurrenceId, a.occurrenceId],
        expectedShoppingScopeRevision: 0,
      }),
    );
    const first = receipt(await f.execute(command));
    assert.deepEqual(receipt(await f.execute(command)), first);
    const list = await f.snapshot();
    assert.equal(list.scope.revision, 1);
    assert.equal(
      list.groups.flatMap((group) => group.contributions).length,
      2 * (projection.readRecipe('53150')!.ingredients.length + 1),
    );
    assert.equal(
      new Set(list.groups.flatMap((group) => group.contributions.map((item) => item.occurrenceId)))
        .size,
      2,
    );
    assert.equal(receipt(await f.select([a.occurrenceId, b.occurrenceId])).outcome, 'no_op');
    assert.equal((await f.snapshot()).projectionRevision, list.projectionRevision);
    failed(
      await f.executePayload({
        kind: 'addPlan',
        occurrenceId: randomUUID(),
        recipeId: '53064',
        placement: a.placement,
        expectedTarget: { kind: 'empty' },
      }),
      'stale_context',
    );
    failed(
      await f.executePayload({
        kind: 'setShoppingSelection',
        occurrenceIds: [a.occurrenceId, randomUUID()],
        expectedShoppingScopeRevision: 1,
      }),
      'stale_context',
    );
    assert.deepEqual(await f.snapshot(), list);
    assert.ok(Object.isFrozen(list.groups[0]!.contributions[0]));
  } finally {
    await f.close();
  }
});

test('selected placement-only edit leaves every demand mark unchanged; recipe replacement retains ID and selection with reset demand', async () => {
  const f = await fixture();
  try {
    const a = await f.add('53150', placement(28));
    receipt(await f.select([a.occurrenceId]));
    for (const group of (await f.snapshot()).groups) receipt(await f.purchase(group));
    const before = await f.snapshot();
    receipt(
      await f.executePayload({
        kind: 'editPlan',
        occurrenceId: a.occurrenceId,
        expectedRevision: a.revision,
        expectedShoppingScopeRevision: before.scope.revision,
        recipeId: a.recipeId,
        placement: placement(29),
      }),
    );
    const moved = await f.snapshot();
    assert.deepEqual(moved.groups, before.groups);
    assert.equal(moved.projectionRevision, before.projectionRevision);
    assert.equal(moved.selectedOccurrences[0]!.placement.actualDate, '2026-09-29');
    const current = moved.selectedOccurrences[0]!;
    assert.equal(
      receipt(
        await f.executePayload({
          kind: 'editPlan',
          occurrenceId: current.occurrenceId,
          expectedRevision: current.revision,
          expectedShoppingScopeRevision: moved.scope.revision,
          recipeId: current.recipeId,
          placement: current.placement,
        }),
      ).outcome,
      'no_op',
    );
    failed(
      await f.executePayload({
        kind: 'editPlan',
        occurrenceId: current.occurrenceId,
        expectedRevision: current.revision,
        expectedShoppingScopeRevision: moved.scope.revision + 1,
        recipeId: '53064',
        placement: current.placement,
      }),
      'stale_context',
    );
    receipt(
      await f.executePayload({
        kind: 'replacePlanRecipe',
        occurrenceId: current.occurrenceId,
        expectedRevision: current.revision,
        expectedShoppingScopeRevision: moved.scope.revision,
        recipeId: '53064',
        placement: current.placement,
      }),
    );
    const replaced = await f.snapshot();
    assert.deepEqual(replaced.scope, before.scope);
    assert.equal(replaced.selectedOccurrences[0]!.recipeId, '53064');
    assert.ok(replaced.groups.every((group) => !group.purchased));
    assert.equal(
      replaced.groups.flatMap((group) => group.contributions).length,
      projection.readRecipe('53064')!.ingredients.length + 1,
    );
  } finally {
    await f.close();
  }
});

test('occupied move matrix preserves source occurrence identity/inclusion and never inherits destination selection or credit', async () => {
  for (const selectedA of [false, true])
    for (const selectedB of [false, true]) {
      const f = await fixture();
      try {
        const a = await f.add('53150', placement(28));
        const b = await f.add('53150', placement(29));
        const unrelated = await f.add('53064', placement(30));
        receipt(
          await f.select([
            ...(selectedA ? [a.occurrenceId] : []),
            ...(selectedB ? [b.occurrenceId] : []),
          ]),
        );
        for (const group of (await f.snapshot()).groups) receipt(await f.purchase(group));
        const before = await f.snapshot();
        const command = await f.register(
          await prepare({
            kind: 'movePlanReplacing',
            occurrenceId: a.occurrenceId,
            expectedRevision: a.revision,
            expectedShoppingScopeRevision: before.scope.revision,
            destinationOccurrenceId: b.occurrenceId,
            expectedDestinationRevision: b.revision,
            recipeId: a.recipeId,
            placement: b.placement,
          }),
        );
        const result = receipt(await f.execute(command));
        assert.deepEqual(receipt(await f.execute(command)), result);
        const list = await f.snapshot();
        const plan = await f.plan();
        assert.equal(plan.occurrences.length, 2);
        assert.equal(
          plan.occurrences.find((item) => item.occurrenceId === a.occurrenceId)!.placement
            .actualDate,
          '2026-09-29',
        );
        assert.ok(plan.occurrences.some((item) => item.occurrenceId === unrelated.occurrenceId));
        assert.ok(!plan.occurrences.some((item) => item.occurrenceId === b.occurrenceId));
        assert.deepEqual(list.scope.occurrenceIds, selectedA ? [a.occurrenceId] : []);
        assert.equal(list.scope.revision, before.scope.revision + (selectedB ? 1 : 0));
        if (selectedA && !selectedB) assert.deepEqual(list.groups, before.groups);
        if (selectedA && selectedB)
          assert.ok(list.groups.every((group) => !group.purchased && group.changed));
        if (!selectedA) assert.equal(list.groups.length, 0);
        assert.equal(result.effects.length, 2);
      } finally {
        await f.close();
      }
    }
});

test('occurrence A/B and scope-only changes reject stale occupied confirmations without overwriting state', async () => {
  for (const mode of ['source', 'destination', 'scope'] as const) {
    const f = await fixture();
    try {
      const a = await f.add('53150', placement(28));
      const b = await f.add('53064', placement(29));
      const command = await f.register(
        await prepare({
          kind: 'movePlanReplacing',
          occurrenceId: a.occurrenceId,
          expectedRevision: a.revision,
          expectedShoppingScopeRevision: 0,
          destinationOccurrenceId: b.occurrenceId,
          expectedDestinationRevision: b.revision,
          recipeId: a.recipeId,
          placement: b.placement,
        }),
      );
      if (mode === 'scope') receipt(await f.select([a.occurrenceId]));
      else {
        const target = mode === 'source' ? a : b;
        receipt(
          await f.executePayload({
            kind: 'editPlan',
            occurrenceId: target.occurrenceId,
            expectedRevision: target.revision,
            expectedShoppingScopeRevision: 0,
            recipeId: target.recipeId,
            placement: placement(30),
          }),
        );
      }
      const before = { plan: await f.plan(), shopping: await f.snapshot() };
      failed(await f.execute(command), 'stale_context');
      assert.deepEqual({ plan: await f.plan(), shopping: await f.snapshot() }, before);
    } finally {
      await f.close();
    }
  }
});

test('projection and receipt faults roll back a real occupied move, selection, purchase state and revisions; same command retries', async () => {
  for (const statement of ['INSERT INTO shopping_contribution', 'INSERT INTO operation_receipt']) {
    const f = await fixture();
    try {
      const a = await f.add('53150', placement(28));
      const b = await f.add('53064', placement(29));
      receipt(await f.select([a.occurrenceId, b.occurrenceId]));
      receipt(await f.purchase((await f.snapshot()).groups[0]!));
      const before = { plan: await f.plan(), shopping: await f.snapshot(), events: [...f.events] };
      const command = await f.register(
        await prepare({
          kind: 'movePlanReplacing',
          occurrenceId: a.occurrenceId,
          expectedRevision: a.revision,
          expectedShoppingScopeRevision: before.shopping.scope.revision,
          destinationOccurrenceId: b.occurrenceId,
          expectedDestinationRevision: b.revision,
          recipeId: a.recipeId,
          placement: b.placement,
        }),
      );
      f.faults.statement = statement;
      failed(await f.execute(command), 'storage_failure');
      assert.deepEqual(
        { plan: await f.plan(), shopping: await f.snapshot(), events: f.events },
        before,
      );
      f.faults.statement = '';
      receipt(await f.execute(command));
      assert.equal((await f.plan()).occurrences.length, 1);
      assert.equal(f.db.statementCounts().prepared, f.db.statementCounts().finalized);
    } finally {
      await f.close();
    }
  }
});

test('purchase revision and demand guards reject stale toggles; deselect/reselect and sole occurrence deletion cannot restore credit', async () => {
  const f = await fixture();
  try {
    const a = await f.add('53150', placement(28));
    const b = await f.add('53150', placement(29));
    receipt(await f.select([a.occurrenceId]));
    const group = (await f.snapshot()).groups[0]!;
    receipt(await f.purchase(group));
    failed(await f.purchase(group, false), 'stale_context');
    const checked = (await f.snapshot()).groups[0]!;
    receipt(await f.select([a.occurrenceId, b.occurrenceId]));
    failed(await f.purchase(checked), 'stale_context');
    assert.ok((await f.snapshot()).groups.every((item) => !item.purchased && item.changed));
    receipt(await f.select([]));
    assert.equal((await f.snapshot()).groups.length, 0);
    receipt(await f.select([a.occurrenceId]));
    assert.ok((await f.snapshot()).groups.every((item) => !item.purchased && item.changed));
    receipt(await f.purchase((await f.snapshot()).groups[0]!));
    const current = await f.snapshot();
    receipt(
      await f.executePayload({
        kind: 'removePlan',
        occurrenceId: a.occurrenceId,
        expectedRevision: a.revision,
        expectedShoppingScopeRevision: current.scope.revision,
      }),
    );
    assert.deepEqual((await f.snapshot()).scope.occurrenceIds, []);
    assert.equal((await f.plan()).occurrences.length, 1);
    receipt(await f.select([b.occurrenceId]));
    assert.ok((await f.snapshot()).groups.every((item) => !item.purchased));
  } finally {
    await f.close();
  }
});

test('purchase and selection commands serialized concurrently cannot mark changed demand', async () => {
  const f = await fixture();
  try {
    const a = await f.add('53150', placement(28));
    const b = await f.add('53150', placement(29));
    receipt(await f.select([a.occurrenceId]));
    const before = await f.snapshot();
    const group = before.groups[0]!;
    const select = await f.register(
      await prepare({
        kind: 'setShoppingSelection',
        occurrenceIds: [a.occurrenceId, b.occurrenceId],
        expectedShoppingScopeRevision: before.scope.revision,
      }),
    );
    const toggle = await f.register(
      await prepare({
        kind: 'setPurchased',
        scopeId: before.scope.scopeId,
        groupKey: group.groupKey,
        expectedDemandFingerprint: group.demandFingerprint,
        expectedRevision: group.revision,
        purchased: true,
      }),
    );
    const results = await Promise.all([f.execute(select), f.execute(toggle)]);
    receipt(results[0]!);
    failed(results[1]!, 'stale_context');
    assert.ok((await f.snapshot()).groups.every((item) => !item.purchased));
  } finally {
    await f.close();
  }
});

test('real shopping rows and receipts survive close/reopen, and persisted quantity corruption returns failure without reset', async () => {
  const f = await fixture();
  let reopenedWriter: SerializedWriter | undefined;
  try {
    const a = await f.add('53150', placement(28));
    receipt(await f.select([a.occurrenceId]));
    const bought = receipt(await f.purchase((await f.snapshot()).groups[0]!));
    const before = await f.snapshot();
    await f.reader.close();
    await f.writer.close();
    const reopened = desktopConnection(f.path);
    await configureConnection(reopened.connection);
    reopenedWriter = new SerializedWriter(reopened.connection);
    assert.equal(
      await initializeDatabase(reopenedWriter, f.seed, {
        installationId: randomUUID(),
        shoppingScopeId: randomUUID(),
        conversationId: randomUUID(),
      }),
      'existing',
    );
    const reader = new SerializedReader(reopened.connection);
    const result = await createShoppingRepository(reader, projection).readShopping();
    assert.equal(result.kind, 'ready');
    if (result.kind === 'ready') assert.deepEqual(result.value, before);
    const recovered = await createStateRepositories(reader, catalogueBoundary).readReceipt(
      bought.operationId,
    );
    if (recovered.kind !== 'ready') assert.fail();
    assert.deepEqual(recovered.value, bought);
    reopened.database.exec(
      "UPDATE shopping_contribution SET quantity_json='{}' WHERE rowid=(SELECT MIN(rowid) FROM shopping_contribution)",
    );
    const rowsBefore = reopened.database.prepare('SELECT * FROM shopping_contribution').all();
    assert.equal(
      (await createShoppingRepository(reader, projection).readShopping()).kind,
      'failed',
    );
    assert.deepEqual(
      reopened.database.prepare('SELECT * FROM shopping_contribution').all(),
      rowsBefore,
    );
  } finally {
    await reopenedWriter?.close();
    await f.close();
  }
});

test('lost acknowledgement on an occupied move reconciles its durable receipt without duplicate moves or notifications', async () => {
  const f = await fixture();
  try {
    const a = await f.add('53150', placement(28));
    const b = await f.add('53064', placement(29));
    receipt(await f.select([a.occurrenceId, b.occurrenceId]));
    const before = await f.snapshot();
    const command = await f.register(
      await prepare({
        kind: 'movePlanReplacing',
        occurrenceId: a.occurrenceId,
        expectedRevision: a.revision,
        expectedShoppingScopeRevision: before.scope.revision,
        destinationOccurrenceId: b.occurrenceId,
        expectedDestinationRevision: b.revision,
        recipeId: a.recipeId,
        placement: b.placement,
      }),
    );
    const eventCount = f.events.length;
    f.faults.commitAck = true;
    const first = receipt(await f.execute(command));
    assert.deepEqual(receipt(await f.execute(command)), first);
    assert.equal(f.events.length, eventCount + 1);
    assert.equal((await f.plan()).occurrences.length, 1);
    assert.deepEqual((await f.snapshot()).scope.occurrenceIds, [a.occurrenceId]);
  } finally {
    await f.close();
  }
});
