import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createPortableBackup } from '../src/portableBackup';
import type {
  CookMateServices,
  DirectActionInput,
  Immutable,
  PortableBackupEnvelope,
  PortableRestoreResult,
  RepositoryResult,
} from '../src/index';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const timestamp = '2026-09-30T12:00:00.000Z';
const platform = {
  newId: randomUUID,
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
};
function ready<T>(result: RepositoryResult<T>): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function committed(result: PortableRestoreResult) {
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail();
  return result.receipt;
}
async function fixture(enable = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-restore-'));
  const filename = join(directory, 'store.db');
  let connections: ReturnType<typeof desktopConnection>[] = [];
  let services: CookMateServices;
  const open = async (enabled: boolean, commandPlatform = platform) =>
    createLocalStore({
      enablePortableRestore: enabled,
      platform: commandPlatform,
      now: () => timestamp,
      dateContext: () => ({
        localDate: '2026-09-30',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      openConnection: async () => {
        const connection = desktopConnection(filename);
        connections.push(connection);
        return connection.connection;
      },
    });
  const initial = await open(enable);
  assert.equal(initial.kind, 'ready');
  if (initial.kind !== 'ready') assert.fail();
  services = initial.services;
  return {
    get services() {
      return services;
    },
    get restore() {
      assert.ok(services.portableRestore);
      return services.portableRestore;
    },
    get connections() {
      return connections;
    },
    get database() {
      return connections[0]!.database;
    },
    async sibling(commandPlatform = platform) {
      const result = await open(true, commandPlatform);
      assert.equal(result.kind, 'ready', JSON.stringify(result));
      if (result.kind !== 'ready') assert.fail();
      return result.services;
    },
    async reopen(enabled = true) {
      await services.close();
      connections = [];
      const result = await open(enabled);
      assert.equal(result.kind, 'ready', JSON.stringify(result));
      if (result.kind !== 'ready') assert.fail();
      services = result.services;
    },
    async rejectedReopen(enabled: boolean) {
      await services.close();
      connections = [];
      const result = await open(enabled);
      assert.equal(result.kind, 'failed');
    },
    async action(input: DirectActionInput) {
      const review = ready(await services.commands.reviewDirect(input));
      const command = ready(await services.commands.prepareDirect(review));
      const result = await services.commands.execute(command);
      assert.equal(result.kind, 'receipt', JSON.stringify(result));
      if (result.kind !== 'receipt') assert.fail();
      return { command, result };
    },
    async prepared(serialized: string) {
      const review = ready(await this.restore.review(serialized));
      assert.deepEqual(review.blockers, []);
      return ready(await this.restore.prepare(review));
    },
    async close() {
      await services.close();
      await removeFixtureDirectory(directory);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function backup(f: Fixture) {
  return ready(await f.services.queries.readPortableBackup());
}
async function changed(
  source: Immutable<PortableBackupEnvelope>,
  change: (copy: PortableBackupEnvelope) => void,
) {
  const copy = JSON.parse(JSON.stringify(source)) as PortableBackupEnvelope;
  change(copy);
  return JSON.stringify(await createPortableBackup(copy, platform.sha256));
}
function allUserRows(f: Fixture) {
  const tables = [
    'favourite',
    'plan_occurrence',
    'shopping_scope',
    'shopping_selection',
    'shopping_group',
    'shopping_contribution',
    'purchase_state',
    'saved_preference',
    'source_preference_link',
    'preference_state',
    'message',
    'conversation',
    'operation_receipt',
    'pending_intent',
    'command_slot',
    'app_metadata',
    'state_revision',
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      JSON.stringify(f.database.prepare(`SELECT * FROM ${table}`).all()),
    ]),
  );
}
async function populate(f: Fixture) {
  const saved = await f.action({ kind: 'setFavourite', recipeId: '52835', saved: true });
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
  await f.action({ kind: 'setPurchased', groupKey: shopping.groups[0]!.groupKey, purchased: true });
  const preference = await f.action({
    kind: 'savePreference',
    type: 'cuisine',
    explicitValue: 'Italian',
  });
  const preferenceId = ready(await f.services.queries.readPreferences()).items[0]!.preferenceId;
  const conversationId = f.database.prepare('SELECT conversation_id AS id FROM conversation').get()!
    .id as string;
  const messageId = randomUUID();
  f.database
    .prepare('INSERT INTO message VALUES (?, ?, 0, 0, ?, ?, ?, ?)')
    .run(
      messageId,
      conversationId,
      'user',
      JSON.stringify('synthetic cooking preference'),
      'complete',
      timestamp,
    );
  f.database
    .prepare('UPDATE conversation SET composer_draft=?')
    .run(JSON.stringify('synthetic retained draft'));
  f.database
    .prepare('INSERT INTO source_preference_link VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run(
      messageId,
      preferenceId,
      'cuisine',
      JSON.stringify('Italian'),
      1,
      preference.command.operationId,
    );
  return { saved, preferenceId, messageId, shopping, plan };
}

test('migration is explicit, atomic and preserves populated schema-2 cooking state and receipts', async () => {
  const f = await fixture(false);
  try {
    assert.equal(f.services.portableRestore, undefined);
    await populate(f);
    const original = allUserRows(f);
    const exportV2 = await backup(f);
    assert.equal(exportV2.databaseSchemaVersion, 2);
    await f.reopen(false);
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.deepEqual(allUserRows(f), original);
    await f.reopen(true);
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 3);
    assert.deepEqual(allUserRows(f), original);
    assert.equal((await backup(f)).databaseSchemaVersion, 3);
    assert.deepEqual(ready(await f.restore.review(JSON.stringify(exportV2))).blockers, []);
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
    await f.rejectedReopen(false);
  } finally {
    await f.close();
  }
});

test('migration rejects a foreign schema without adding the restore journal', async () => {
  const f = await fixture(false);
  try {
    f.database.exec('CREATE TABLE unrelated_layout (value TEXT)');
    await f.rejectedReopen(true);
  } finally {
    await f.close();
  }
});

test('same-catalogue replacement preserves conversation/receipts, rebases revisions and archives provenance', async () => {
  const source = await fixture(false);
  const target = await fixture();
  try {
    const imported = await populate(source);
    await source.action({
      kind: 'savePreference',
      preferenceId: imported.preferenceId,
      type: 'cuisine',
      explicitValue: 'Spanish',
    });
    const serialized = JSON.stringify(await backup(source), null, 2);
    const local = await populate(target);
    const old = await backup(target);
    const protectedTables = allUserRows(target);
    const prepared = await target.prepared(serialized);
    const receipt = committed(await target.restore.execute(prepared));
    assert.equal(receipt.importedPreferenceRemovals, 1);
    assert.equal(receipt.shopping.restoredChecks, 1);
    assert.equal(receipt.shopping.uncheckedImportedChecks, 0);
    assert.ok(receipt.revision > old.sourceRevision);
    assert.equal(
      ready(await target.restore.readArchive(prepared.operationId, 'imported')),
      serialized,
    );
    const before = JSON.parse(
      ready(await target.restore.readArchive(prepared.operationId, 'before'))!,
    ) as PortableBackupEnvelope;
    assert.deepEqual(before.data, old.data);
    for (const table of [
      'message',
      'conversation',
      'operation_receipt',
      'pending_intent',
      'command_slot',
      'app_metadata',
    ])
      assert.equal(allUserRows(target)[table], protectedTables[table], table);
    const provenance = target.database.prepare('SELECT * FROM source_preference_link').all();
    assert.equal(provenance.length, 1, 'No fabricated imported source-message links');
    assert.equal(provenance[0]!.source_message_id, local.messageId);
    assert.equal(provenance[0]!.removed_revision, receipt.revision);
    const after = await backup(target);
    assert.deepEqual(receipt.restoredCounts, after.counts);
    assert.equal(after.data.shopping.scope.scopeId, old.data.shopping.scope.scopeId);
    assert.deepEqual(
      after.data.shopping.scope.occurrenceIds,
      (await backup(source)).data.shopping.scope.occurrenceIds,
    );
    assert.deepEqual(
      after.data.occurrences.map((item) => item.placement),
      imported.plan.occurrences.map((item) => item.placement),
    );
    assert.equal(after.data.preferences.snapshot.items[0]!.value, 'Spanish');
    assert.equal(after.data.preferences.snapshot.items[0]!.revision, receipt.revision);
    assert.equal(after.data.preferences.removals[0]!.preferenceId, local.preferenceId);
    assert.equal(
      after.data.preferences.removals.some((item) => item.preferenceId === imported.preferenceId),
      false,
      'Foreign withdrawal clocks remain in the original archive',
    );
    assert.equal(after.counts.purchasedItems, 1);
    assert.deepEqual(ready(await target.restore.readReceipt(prepared.operationId)), receipt);
    await target.action({ kind: 'setFavourite', recipeId: '52839', saved: true });
    const later = await backup(target);
    assert.deepEqual(committed(await target.restore.execute(prepared)), receipt);
    assert.deepEqual((await backup(target)).data, later.data);
    await target.reopen();
    assert.deepEqual(
      committed(await target.restore.execute(prepared)),
      receipt,
      'Restart retry only reads an existing proven receipt',
    );
    assert.deepEqual((await backup(target)).data, later.data);
    assert.equal(
      (await target.services.commands.execute(local.saved.command)).kind,
      'receipt',
      'Historical commands return their old proof',
    );
    assert.deepEqual((await backup(target)).data, later.data);
  } finally {
    await source.close();
    await target.close();
  }
});

test('whole-file invalid integrity, unknown recipes and catalogue mismatch leave all data untouched', async () => {
  const f = await fixture();
  try {
    await populate(f);
    const source = await backup(f);
    const original = allUserRows(f);
    const corrupt = JSON.stringify({
      ...source,
      integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
    });
    assert.equal((await f.restore.review(corrupt)).kind, 'failed');
    const unknown = await changed(source, (copy) => {
      copy.data.favourites[0]!.recipeId = '9999999999';
    });
    const unknownReview = ready(await f.restore.review(unknown));
    assert.deepEqual(unknownReview.unknownRecipeIds, ['9999999999']);
    assert.equal(unknownReview.referenceSummary?.restoreAuthorized, false);
    assert.deepEqual(unknownReview.referenceSummary?.unresolved, [
      { recipeId: '9999999999', reasons: ['recipe_unavailable'] },
    ]);
    assert.equal(unknownReview.referenceSummary?.archiveResolution, 'unavailable');
    assert.ok(unknownReview.blockers.includes('unknown_recipes'));
    assert.equal((await f.restore.prepare(unknownReview)).kind, 'failed');
    const mismatch = await changed(source, (copy) => {
      copy.catalogue.fingerprint = 'f'.repeat(64);
    });
    const mismatchReview = ready(await f.restore.review(mismatch));
    assert.ok(mismatchReview.blockers.includes('catalogue_mismatch'));
    assert.deepEqual(mismatchReview.referenceSummary?.knownExactRecipeIds, []);
    assert.ok(
      mismatchReview.referenceSummary?.unresolved.every((item) =>
        item.reasons.includes('catalogue_mismatch'),
      ),
    );
    assert.deepEqual(allUserRows(f), original);
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS n FROM portable_restore_operation').get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('stale and cloned approvals cannot replace data; pre-restore favourite reviews are fenced', async () => {
  const f = await fixture();
  try {
    const serialized = JSON.stringify(await backup(f));
    const review = ready(await f.restore.review(serialized));
    assert.equal((await f.restore.prepare({ ...review })).kind, 'failed');
    const prepared = ready(await f.restore.prepare(review));
    const direct = ready(
      await f.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '52835',
        saved: true,
      }),
    );
    committed(await f.restore.execute(prepared));
    assert.equal((await f.services.commands.prepareDirect(direct)).kind, 'failed');
    const other = await f.prepared(serialized);
    assert.equal((await f.restore.execute({ ...other })).kind, 'failed');
    await f.action({ kind: 'setFavourite', recipeId: '52839', saved: true });
    assert.equal((await f.restore.execute(other)).kind, 'failed');
    assert.equal(ready(await f.services.queries.readFavourites())[0]!.recipeId, '52839');
  } finally {
    await f.close();
  }
});

test('an already prepared favourite blocks restore, including a change after prepare', async () => {
  const f = await fixture();
  try {
    const serialized = JSON.stringify(await backup(f));
    const prepared = await f.prepared(serialized);
    const direct = ready(
      await f.services.commands.prepareDirect(
        ready(
          await f.services.commands.reviewDirect({
            kind: 'setFavourite',
            recipeId: '52835',
            saved: true,
          }),
        ),
      ),
    );
    assert.ok(ready(await f.restore.review(serialized)).blockers.includes('active_actions'));
    assert.equal((await f.restore.execute(prepared)).kind, 'failed');
    assert.equal((await f.services.commands.execute(direct)).kind, 'receipt');
    assert.equal(ready(await f.services.queries.readFavourites()).length, 1);
  } finally {
    await f.close();
  }
});

test('the exclusive restore lease rejects new direct/assistant admission until completion', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const prepared = await f.prepared(JSON.stringify(await backup(f)));
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = f.connections[0]!.connection;
    const original = connection.all;
    let once = true;
    connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      const rows = await original<Row>(sql, values);
      if (once && sql.includes('FROM portable_restore_operation WHERE operation_id')) {
        once = false;
        entered();
        await blocked;
      }
      return rows;
    };
    const restoring = f.restore.execute(prepared);
    await started;
    assert.equal(
      (
        await f.services.commands.reviewDirect({
          kind: 'setFavourite',
          recipeId: '52835',
          saved: true,
        })
      ).kind,
      'failed',
    );
    assert.equal((await f.restore.review(JSON.stringify({}))).kind, 'failed');
    const assistant = f.services.assistant({ connectionGeneration: () => 0 });
    assert.equal((await assistant.readConversation()).kind, 'failed');
    release();
    committed(await restoring);
    await f.action({ kind: 'setFavourite', recipeId: '52835', saved: true });
  } finally {
    release();
    await f.close();
  }
});

for (const stage of ['snapshot', 'plan', 'projection', 'journal', 'commit'] as const) {
  test(`restore ${stage} failure rolls back all effects and creates no receipt`, async () => {
    const f = await fixture();
    try {
      const serialized = JSON.stringify(await backup(f));
      await populate(f);
      const prepared = await f.prepared(serialized);
      const before = allUserRows(f);
      const connection = f.connections[0]!.connection;
      const originalPrepare = connection.prepare;
      const originalExec = connection.exec;
      const originalAll = connection.all;
      let failedOnce = false;
      const inject = () => {
        failedOnce = true;
        throw new Error(`synthetic ${stage} failure`);
      };
      connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
        if (
          !failedOnce &&
          stage === 'snapshot' &&
          sql.includes('FROM favourite ORDER BY recipe_id')
        )
          inject();
        return originalAll<Row>(sql, values);
      };
      connection.exec = async (sql) => {
        if (
          !failedOnce &&
          ((stage === 'plan' && sql === 'DELETE FROM plan_occurrence') ||
            (stage === 'commit' && sql === 'COMMIT'))
        )
          inject();
        return originalExec(sql);
      };
      connection.prepare = async (sql) => {
        const statement = await originalPrepare(sql);
        return {
          ...statement,
          run: async (values) => {
            if (
              !failedOnce &&
              ((stage === 'projection' &&
                sql.startsWith('UPDATE shopping_scope SET projection_revision')) ||
                (stage === 'journal' && sql.startsWith('INSERT INTO portable_restore_operation')))
            )
              inject();
            return statement.run(values);
          },
        };
      };
      assert.equal((await f.restore.execute(prepared)).kind, 'failed');
      assert.equal(failedOnce, true);
      assert.deepEqual(allUserRows(f), before);
      assert.equal(ready(await f.restore.readReceipt(prepared.operationId)), null);
    } finally {
      await f.close();
    }
  });
}

test('lost commit acknowledgement reads the independent durable restore receipt', async () => {
  const f = await fixture();
  try {
    const serialized = JSON.stringify(await backup(f));
    await f.action({ kind: 'setFavourite', recipeId: '52835', saved: true });
    const prepared = await f.prepared(serialized);
    const connection = f.connections[0]!.connection;
    const original = connection.exec;
    let once = true;
    connection.exec = async (sql) => {
      await original(sql);
      if (sql === 'COMMIT' && once) {
        once = false;
        throw new Error('synthetic lost acknowledgement');
      }
    };
    const receipt = committed(await f.restore.execute(prepared));
    assert.equal(ready(await f.services.queries.readFavourites()).length, 0);
    assert.equal(receipt.restoredCounts.favourites, 0);
    await f.reopen();
    assert.deepEqual(ready(await f.restore.readReceipt(prepared.operationId)), receipt);
    assert.deepEqual(committed(await f.restore.execute(prepared)), receipt);
  } finally {
    await f.close();
  }
});

test('demand mismatch and pending imported projections never inherit purchased credit', async () => {
  const f = await fixture();
  try {
    await populate(f);
    const source = await backup(f);
    for (const mode of ['fingerprint', 'grouping', 'pending'] as const) {
      const serialized = await changed(source, (copy) => {
        const mark = copy.data.shopping.purchaseMarks.find((item) => item.purchased)!;
        if (mode === 'fingerprint') mark.demandFingerprint = 'f'.repeat(64);
        if (mode === 'grouping') mark.groupingVersion = 'unknown-grouping';
        if (mode === 'pending') copy.data.shopping.projectionStatus = 'pending';
      });
      const review = ready(await f.restore.review(serialized));
      assert.deepEqual(review.shopping, { restoredChecks: 0, uncheckedImportedChecks: 1 });
      const receipt = committed(await f.restore.execute(ready(await f.restore.prepare(review))));
      assert.deepEqual(receipt.shopping, review.shopping);
      assert.equal(
        ready(await f.services.queries.readShopping()).groups.filter((item) => item.purchased)
          .length,
        0,
      );
    }
  } finally {
    await f.close();
  }
});

test('restore exports retain known catalogue and cannot change source recipe quantities', async () => {
  const f = await fixture();
  try {
    await populate(f);
    const source = await backup(f);
    committed(await f.restore.execute(await f.prepared(JSON.stringify(source))));
    const after = await backup(f);
    assert.deepEqual(after.catalogue, catalogue.identity);
    const recipe = ready(await f.services.queries.readRecipe('52835'))!;
    assert.deepEqual(
      recipe.ingredients,
      catalogue.recipes.find((item) => item.recipeId === '52835')!.ingredients,
    );
    assert.deepEqual(
      after.data.occurrences.map(({ revision: _revision, ...item }) => item),
      source.data.occurrences.map(({ revision: _revision, ...item }) => item),
    );
  } finally {
    await f.close();
  }
});

test('a migration failure after creating the table rolls back schema and preserves existing rows', async () => {
  const connection = desktopConnection();
  const writer = new SerializedWriter(connection.connection);
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
  try {
    await configureConnection(connection.connection);
    await initializeDatabase(writer, seed, ids);
    connection.database
      .prepare('INSERT INTO favourite VALUES (?, 1, 7, ?, ?)')
      .run('52835', timestamp, timestamp);
    const before = JSON.stringify(connection.database.prepare('SELECT * FROM favourite').all());
    const original = connection.connection.exec;
    connection.connection.exec = async (sql) => {
      await original(sql);
      if (sql.includes('CREATE TABLE portable_restore_operation'))
        throw new Error('synthetic migration interruption');
    };
    await assert.rejects(initializeDatabase(writer, seed, ids, { enablePortableRestore: true }));
    assert.equal(connection.database.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.equal(
      connection.database
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='portable_restore_operation'")
        .get()!.n,
      0,
    );
    assert.equal(
      JSON.stringify(connection.database.prepare('SELECT * FROM favourite').all()),
      before,
    );
    assert.equal(
      connection.database
        .prepare("SELECT value FROM app_metadata WHERE key='installation_id'")
        .get()!.value,
      ids.installationId,
    );
    connection.connection.exec = original;
    await initializeDatabase(writer, seed, ids, { enablePortableRestore: true });
    assert.equal(connection.database.prepare('PRAGMA user_version').get()!.user_version, 3);
  } finally {
    await writer.close();
  }
});

test('an in-flight command registration cannot be overtaken by restore', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const prepared = await f.prepared(JSON.stringify(await backup(f)));
    const directReview = ready(
      await f.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '52835',
        saved: true,
      }),
    );
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = f.connections[0]!.connection;
    const original = connection.prepare;
    let once = true;
    connection.prepare = async (sql) => {
      const statement = await original(sql);
      return {
        ...statement,
        run: async (values) => {
          if (once && sql.includes('INSERT INTO pending_intent')) {
            once = false;
            entered();
            await blocked;
          }
          return statement.run(values);
        },
      };
    };
    const registering = f.services.commands.prepareDirect(directReview);
    await started;
    const denied = await f.restore.execute(prepared);
    assert.equal(denied.kind, 'failed');
    if (denied.kind !== 'failed') assert.fail();
    assert.equal(denied.error.messageKey, 'restore.store_busy');
    release();
    const direct = ready(await registering);
    assert.equal((await f.restore.execute(prepared)).kind, 'failed');
    assert.equal((await f.services.commands.execute(direct)).kind, 'receipt');
    assert.equal(ready(await f.services.queries.readFavourites())[0]!.recipeId, '52835');
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS n FROM portable_restore_operation').get()!.n,
      0,
    );
  } finally {
    release();
    await f.close();
  }
});

test('committed restore notifications can immediately read the new state', async () => {
  const f = await fixture();
  try {
    const serialized = JSON.stringify(await backup(f));
    await f.action({ kind: 'setFavourite', recipeId: '52835', saved: true });
    const prepared = await f.prepared(serialized);
    let refreshed: ReturnType<CookMateServices['queries']['readFavourites']> | undefined;
    const unsubscribe = f.services.queries.subscribe(() => {
      refreshed = f.services.queries.readFavourites();
    });
    committed(await f.restore.execute(prepared));
    assert.ok(refreshed);
    assert.deepEqual(ready(await refreshed), []);
    unsubscribe();
  } finally {
    await f.close();
  }
});

test('corrupted archives and receipt conflicts fail closed without replacement', async () => {
  const f = await fixture();
  try {
    const serialized = JSON.stringify(await backup(f));
    const prepared = await f.prepared(serialized);
    committed(await f.restore.execute(prepared));
    await f.action({ kind: 'setFavourite', recipeId: '52835', saved: true });
    assert.equal(
      (await f.restore.execute({ ...prepared, importFingerprint: 'f'.repeat(64) })).kind,
      'failed',
    );
    const after = allUserRows(f);
    f.database
      .prepare('UPDATE portable_restore_operation SET before_json=? WHERE operation_id=?')
      .run('{}', prepared.operationId);
    assert.equal((await f.restore.readArchive(prepared.operationId, 'before')).kind, 'failed');
    assert.equal(ready(await f.restore.readArchive(prepared.operationId, 'imported')), serialized);
    assert.deepEqual(allUserRows(f), after);
    await f.services.close();
    assert.equal((await f.restore.readReceipt(prepared.operationId)).kind, 'failed');
  } finally {
    await f.close();
  }
});

test('exhausted local revisions block restore before any replacement', async () => {
  const f = await fixture();
  try {
    const serialized = JSON.stringify(await backup(f));
    f.database
      .prepare("UPDATE state_revision SET revision=? WHERE collection='store'")
      .run(Number.MAX_SAFE_INTEGER);
    const prepared = await f.prepared(serialized);
    const before = allUserRows(f);
    assert.equal((await f.restore.execute(prepared)).kind, 'failed');
    assert.deepEqual(allUserRows(f), before);
    assert.equal(ready(await f.restore.readReceipt(prepared.operationId)), null);
  } finally {
    await f.close();
  }
});

test('a second facade cannot register its pre-restore favourite review after another facade restores', async () => {
  const f = await fixture();
  let sibling: CookMateServices | undefined;
  let release = () => {};
  try {
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayHash = false;
    sibling = await f.sibling({
      ...platform,
      sha256: async (value) => {
        if (delayHash) {
          delayHash = false;
          entered();
          await blocked;
        }
        return platform.sha256(value);
      },
    });
    const stale = ready(
      await sibling.commands.reviewDirect({ kind: 'setFavourite', recipeId: '52835', saved: true }),
    );
    const prepared = await f.prepared(JSON.stringify(await backup(f)));
    delayHash = true;
    const registering = sibling.commands.prepareDirect(stale);
    await started;
    const receipt = committed(await f.restore.execute(prepared));
    release();
    const rejected = await registering;
    assert.equal(rejected.kind, 'failed');
    if (rejected.kind !== 'failed') assert.fail();
    assert.equal(rejected.error.messageKey, 'restore.workspace_changed');
    assert.deepEqual(ready(await f.services.queries.readFavourites()), []);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM pending_intent').get()!.n, 0);
    assert.equal(
      f.database
        .prepare('SELECT MAX(committed_revision) AS epoch FROM portable_restore_operation')
        .get()!.epoch,
      receipt.revision,
    );
    const fresh = ready(
      await sibling.commands.reviewDirect({ kind: 'setFavourite', recipeId: '52835', saved: true }),
    );
    const command = ready(await sibling.commands.prepareDirect(fresh));
    assert.equal((await sibling.commands.execute(command)).kind, 'receipt');
    assert.equal(ready(await f.services.queries.readFavourites())[0]!.recipeId, '52835');
  } finally {
    release();
    await sibling?.close();
    await f.close();
  }
});

test('a newly opened disabled facade cannot learn a migrated schema from its first later write', async () => {
  const legacy = await fixture(false);
  let upgraded: CookMateServices | undefined;
  try {
    assert.equal(legacy.services.portableRestore, undefined);
    const stale = ready(
      await legacy.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '52835',
        saved: true,
      }),
    );
    const original = JSON.stringify(await backup(legacy));
    // No writer calls through the legacy facade after open: its recovery gate must already be pinned.
    upgraded = await legacy.sibling();
    assert.ok(upgraded.portableRestore);
    const review = ready(await upgraded.portableRestore.review(original));
    const prepared = ready(await upgraded.portableRestore.prepare(review));
    committed(await upgraded.portableRestore.execute(prepared));
    const before = allUserRows(legacy);
    const rejected = await legacy.services.commands.prepareDirect(stale);
    assert.equal(rejected.kind, 'failed');
    if (rejected.kind !== 'failed') assert.fail();
    assert.equal(rejected.error.code, 'storage_failure');
    assert.deepEqual(allUserRows(legacy), before);
    assert.equal(legacy.database.prepare('SELECT COUNT(*) AS n FROM pending_intent').get()!.n, 0);
    // Re-review alone cannot revive the old facade. Reopening with the explicit rollout is required.
    const fresh = ready(
      await legacy.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '52839',
        saved: true,
      }),
    );
    assert.equal((await legacy.services.commands.prepareDirect(fresh)).kind, 'failed');
    const valid = ready(
      await upgraded.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '52839',
        saved: true,
      }),
    );
    const command = ready(await upgraded.commands.prepareDirect(valid));
    assert.equal((await upgraded.commands.execute(command)).kind, 'receipt');
    assert.equal(ready(await upgraded.queries.readFavourites())[0]!.recipeId, '52839');
  } finally {
    await upgraded?.close();
    await legacy.close();
  }
});

test('restore receipt counts come from actual retained state rather than imported counts', async () => {
  const f = await fixture();
  try {
    const empty = await backup(f);
    await populate(f);
    const prepared = await f.prepared(JSON.stringify(empty));
    const receipt = committed(await f.restore.execute(prepared));
    const actual = await backup(f);
    assert.deepEqual(receipt.restoredCounts, actual.counts);
    assert.equal(receipt.restoredCounts.favourites, 0);
    assert.equal(receipt.restoredCounts.plannedMeals, 0);
    assert.equal(receipt.restoredCounts.selectedMeals, 0);
    assert.equal(receipt.restoredCounts.preferences, 0);
    assert.equal(receipt.restoredCounts.purchasedItems, 0);
    assert.equal(receipt.restoredCounts.preferenceRemovals, 1);
    assert.ok(
      receipt.restoredCounts.purchaseMarks > 0,
      'Dormant local purchase identities remain fenced',
    );
    assert.notDeepEqual(receipt.restoredCounts, empty.counts);
    const corrupt = {
      ...receipt,
      restoredCounts: { ...receipt.restoredCounts, purchaseMarks: -1 },
    };
    f.database
      .prepare('UPDATE portable_restore_operation SET receipt_json=? WHERE operation_id=?')
      .run(JSON.stringify(corrupt), prepared.operationId);
    assert.equal((await f.restore.readReceipt(prepared.operationId)).kind, 'failed');
  } finally {
    await f.close();
  }
});
