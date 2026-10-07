import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueBoundary } from '@cookmate/catalogue';
import type { DirectActionInput, RepositoryResult } from '../src/index';
import { validatePortableBackup } from '../src/portableBackup';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const timestamp = '2026-09-30T08:00:00.000Z';
const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};

function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-backup-'));
  const filename = join(directory, 'store.db');
  const connections: ReturnType<typeof desktopConnection>[] = [];
  const opened = await createLocalStore({
    platform,
    now: () => timestamp,
    dateContext: () => ({ localDate: '2026-09-30', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    openConnection: async () => {
      const connection = desktopConnection(filename);
      connections.push(connection);
      return connection.connection;
    },
  });
  assert.equal(opened.kind, 'ready');
  if (opened.kind !== 'ready') assert.fail();
  const services = opened.services;
  return {
    services,
    connections,
    database: connections[0]!.database,
    async action(input: DirectActionInput) {
      const review = ready(await services.commands.reviewDirect(input));
      const command = ready(await services.commands.prepareDirect(review));
      const result = await services.commands.execute(command);
      assert.equal(result.kind, 'receipt', JSON.stringify(result));
      if (result.kind !== 'receipt') assert.fail();
      return { command, result };
    },
    async close() {
      await services.close();
      await removeFixtureDirectory(directory);
    },
  };
}

test('exports a populated SQL snapshot with tombstones, cross-week demand and withdrawal facts only', async () => {
  const f = await fixture();
  try {
    await f.action({ kind: 'setFavourite', recipeId: '52835', saved: true });
    await f.action({ kind: 'setFavourite', recipeId: '52839', saved: true });
    await f.action({ kind: 'setFavourite', recipeId: '52839', saved: false });
    await f.action({
      kind: 'placeRecipe',
      recipeId: '52835',
      placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
    });
    await f.action({
      kind: 'placeRecipe',
      recipeId: '52839',
      placement: { actualDate: '2026-10-07', mealKey: 'lunch' },
    });
    const plan = ready(await f.services.queries.readPlan('2026-09-30', '2026-10-07'));
    await f.action({
      kind: 'setShoppingSelection',
      occurrenceIds: plan.occurrences.map((item) => item.occurrenceId),
    });
    const shopping = ready(await f.services.queries.readShopping());
    assert.ok(shopping.groups.length > 0);
    await f.action({
      kind: 'setPurchased',
      groupKey: shopping.groups[0]!.groupKey,
      purchased: true,
    });
    const saved = await f.action({
      kind: 'savePreference',
      type: 'ingredient_avoid',
      explicitValue: 'Mustard',
    });
    const preferenceId = ready(await f.services.queries.readPreferences()).items[0]!.preferenceId;
    await f.action({ kind: 'removePreference', preferenceId });
    await f.action({ kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' });

    const conversation = f.database
      .prepare('SELECT conversation_id AS id FROM conversation')
      .get()!;
    const installation = f.database
      .prepare("SELECT value FROM app_metadata WHERE key='installation_id'")
      .get()!.value as string;
    const messageId = randomUUID();
    const pendingId = randomUUID();
    f.database
      .prepare('INSERT INTO message VALUES (?, ?, 0, 0, ?, ?, ?, ?)')
      .run(
        messageId,
        conversation.id as string,
        'user',
        JSON.stringify('synthetic-private-transcript'),
        'complete',
        timestamp,
      );
    f.database
      .prepare('UPDATE conversation SET composer_draft=?')
      .run(JSON.stringify('synthetic-unsent-draft'));
    f.database
      .prepare('INSERT INTO source_preference_link VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        messageId,
        preferenceId,
        'ingredient_avoid',
        JSON.stringify('Mustard'),
        1,
        2,
        saved.command.operationId,
      );
    f.database
      .prepare('INSERT INTO pending_intent VALUES (?, 0, ?, ?)')
      .run(pendingId, 'draft', JSON.stringify({ secret: 'synthetic-pending-action' }));
    f.database
      .prepare('INSERT INTO app_metadata VALUES (?, ?)')
      .run('synthetic_secret', 'synthetic-pairing-token');
    const beforeChanges = f.database.prepare('SELECT total_changes() AS count').get()!.count;
    const statements: string[] = [];
    const connection = f.connections[1]!.connection;
    const originalRead = connection.all;
    connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      statements.push(sql);
      return originalRead<Row>(sql, values);
    };
    const result = await f.services.queries.readPortableBackup();
    const backup = ready(result);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') assert.fail();
    assert.equal(result.revision, backup.sourceRevision);
    assert.equal(backup.databaseSchemaVersion, 2);
    assert.equal(backup.counts.favourites, 1);
    assert.equal(backup.counts.tombstones, 1);
    assert.equal(backup.counts.plannedMeals, 2);
    assert.equal(backup.counts.selectedMeals, 2);
    assert.equal(backup.counts.purchasedItems, 1);
    assert.equal(backup.counts.preferences, 1);
    assert.equal(backup.counts.preferenceRemovals, 1);
    assert.equal(backup.data.preferences.snapshot.lastRemovalRevision, 2);
    assert.deepEqual(backup.data.preferences.removals[0], {
      preferenceId,
      type: 'ingredient_avoid',
      value: 'Mustard',
      savedRevision: 1,
      removedRevision: 2,
    });
    const purchased = backup.data.shopping.purchaseMarks.find((item) => item.purchased)!;
    assert.equal(purchased.groupKey, shopping.groups[0]!.groupKey);
    assert.equal(purchased.demandFingerprint, shopping.groups[0]!.demandFingerprint);
    const serialized = JSON.stringify(backup);
    for (const forbidden of [
      installation,
      messageId,
      pendingId,
      saved.command.operationId,
      'synthetic-private-transcript',
      'synthetic-unsent-draft',
      'synthetic-pending-action',
      'synthetic-pairing-token',
      'command_json',
      'operation_receipt',
    ])
      assert.equal(serialized.includes(forbidden), false, `Excluded synthetic value: ${forbidden}`);
    assert.equal(
      statements.some((sql) =>
        /\bFROM\s+(conversation|message|pending_intent|command_slot|operation_receipt|app_metadata)\b/i.test(
          sql,
        ),
      ),
      false,
    );
    assert.equal(
      statements.some((sql) => /SELECT\s+\*/i.test(sql)),
      false,
    );
    const validation = await validatePortableBackup(serialized, {
      sha256: platform.sha256,
      currentCatalogue: catalogue.identity,
      knownRecipeIds: catalogueBoundary.recipeIds,
    });
    assert.equal(validation.kind, 'ready');
    if (validation.kind !== 'ready') assert.fail();
    assert.deepEqual(validation.value, backup);
    assert.deepEqual(validation.preview.selectedDateRange, {
      first: '2026-09-30',
      last: '2026-10-07',
    });
    assert.equal(f.database.prepare('SELECT total_changes() AS count').get()!.count, beforeChanges);
    assert.equal(Object.isFrozen(backup.data.preferences.removals), true);
  } finally {
    await f.close();
  }
});

test('a command-driven linked preference edit exports the replacement and its withdrawn predecessor', async () => {
  const f = await fixture();
  try {
    const saved = await f.action({
      kind: 'savePreference',
      type: 'cuisine',
      explicitValue: 'Italian',
    });
    const preferenceId = ready(await f.services.queries.readPreferences()).items[0]!.preferenceId;
    const conversation = f.database
      .prepare('SELECT conversation_id AS id FROM conversation')
      .get()!;
    const messageId = randomUUID();
    // Model existing conversation provenance; both preference versions are saved by real commands.
    f.database
      .prepare('INSERT INTO message VALUES (?, ?, 0, 0, ?, ?, ?, ?)')
      .run(
        messageId,
        conversation.id as string,
        'user',
        JSON.stringify('synthetic preference source'),
        'complete',
        timestamp,
      );
    f.database
      .prepare('INSERT INTO source_preference_link VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(
        messageId,
        preferenceId,
        'cuisine',
        JSON.stringify('Italian'),
        1,
        saved.command.operationId,
      );
    await f.action({
      kind: 'savePreference',
      preferenceId,
      type: 'cuisine',
      explicitValue: 'Spanish',
    });
    assert.equal(
      f.database
        .prepare('SELECT removed_revision FROM source_preference_link WHERE preference_id=?')
        .get(preferenceId)!.removed_revision,
      2,
    );
    const before = f.database.prepare('SELECT total_changes() AS count').get()!.count;
    const backup = ready(await f.services.queries.readPortableBackup());
    assert.deepEqual(backup.data.preferences.snapshot, {
      revision: 2,
      lastRemovalRevision: 2,
      items: [{ preferenceId, type: 'cuisine', value: 'Spanish', revision: 2 }],
    });
    assert.deepEqual(backup.data.preferences.removals, [
      {
        preferenceId,
        type: 'cuisine',
        value: 'Italian',
        savedRevision: 1,
        removedRevision: 2,
      },
    ]);
    assert.equal(backup.counts.preferences, 1);
    assert.equal(backup.counts.preferenceRemovals, 1);
    const serialized = JSON.stringify(backup);
    assert.equal(serialized.includes(messageId), false);
    assert.equal(serialized.includes(saved.command.operationId), false);
    const validation = await validatePortableBackup(serialized, {
      sha256: platform.sha256,
      currentCatalogue: catalogue.identity,
      knownRecipeIds: catalogueBoundary.recipeIds,
    });
    assert.equal(validation.kind, 'ready');
    if (validation.kind !== 'ready') assert.fail();
    assert.deepEqual(validation.value, backup);
    assert.equal(f.database.prepare('SELECT total_changes() AS count').get()!.count, before);
  } finally {
    await f.close();
  }
});

test('a queued domain write cannot split a multi-table backup snapshot', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    await f.action({ kind: 'setFavourite', recipeId: '52835', saved: true });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = f.connections[1]!.connection;
    const read = connection.all;
    let blockOnce = true;
    connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      const rows = await read<Row>(sql, values);
      if (blockOnce && /FROM favourite ORDER BY recipe_id/.test(sql)) {
        blockOnce = false;
        entered();
        await blocked;
      }
      return rows;
    };
    const exporting = f.services.queries.readPortableBackup();
    await started;
    const saving = f.action({ kind: 'setFavourite', recipeId: '52839', saved: true });
    release();
    const backup = ready(await exporting);
    await saving;
    assert.deepEqual(
      backup.data.favourites.map((item) => item.recipeId),
      ['52835'],
    );
    assert.equal(ready(await f.services.queries.readFavourites()).length, 2);
    const next = ready(await f.services.queries.readPortableBackup());
    assert.ok(next.sourceRevision > backup.sourceRevision);
    assert.equal(next.counts.favourites, 2);
  } finally {
    release?.();
    await f.close();
  }
});

test('malformed stored data yields no partial backup and a closed facade cannot export', async () => {
  const f = await fixture();
  try {
    await f.action({ kind: 'setFavourite', recipeId: '52835', saved: true });
    f.database.prepare('UPDATE favourite SET updated_at=?').run('invalid-date');
    const before = f.database.prepare('SELECT total_changes() AS count').get()!.count;
    const failed = await f.services.queries.readPortableBackup();
    assert.equal(failed.kind, 'failed');
    assert.equal(f.database.prepare('SELECT total_changes() AS count').get()!.count, before);
    assert.equal(
      f.database.prepare('SELECT updated_at FROM favourite').get()!.updated_at,
      'invalid-date',
    );
    await f.services.close();
    assert.equal((await f.services.queries.readPortableBackup()).kind, 'failed');
  } finally {
    await f.close();
  }
});
