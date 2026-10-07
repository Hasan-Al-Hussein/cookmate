import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { CommandPayload, PendingIntent } from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import { preferenceCommandHandlers } from '../../../apps/mobile/src/data/preferenceCommands';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
const prepare = createCommandPreparer(platform, catalogueBoundary);
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
  let failReceipt = false;
  const nativePrepare = storage.connection.prepare;
  storage.connection.prepare = async (sql) => {
    const statement = await nativePrepare(sql);
    return {
      ...statement,
      run: async (values) => {
        if (failReceipt && sql.startsWith('INSERT INTO operation_receipt'))
          throw new Error('receipt fault');
        await statement.run(values);
      },
    };
  };
  const executor = createCommandExecutor({
    writer,
    catalogue: catalogueBoundary,
    platform,
    handlers: preferenceCommandHandlers,
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => ({ localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    readReceipt: async () => {
      throw new Error('This fixture has no independent recovery reader');
    },
    onCommitted: () => undefined,
  });
  const register = async (payload: CommandPayload) => {
    const command = await prepare(payload);
    const intent: PendingIntent = {
      userIntentId: command.userIntentId,
      revision: command.intentRevision,
      phase: 'ready',
      slots: [{ slotId: randomUUID(), command }],
    };
    await registerReadyIntent(writer, intent, catalogueBoundary, platform);
    return command;
  };
  return {
    ...storage,
    writer,
    ...executor,
    register,
    run: async (payload: CommandPayload) => executor.execute(await register(payload)),
    injectReceiptFailure: (enabled: boolean) => {
      failReceipt = enabled;
    },
  };
}

test('explicit preference create/update/deduplicate uses current collection authority and truthful receipts', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    const first = await f.run({
      kind: 'savePreference',
      preferenceId: id,
      type: 'cuisine',
      explicitValue: 'Indian',
      expectedPreferenceRevision: 0,
    });
    assert.equal(first.kind, 'receipt');
    const duplicate = await f.run({
      kind: 'savePreference',
      preferenceId: randomUUID(),
      type: 'cuisine',
      explicitValue: 'Indian',
      expectedPreferenceRevision: 1,
    });
    assert.equal(duplicate.kind, 'receipt');
    if (duplicate.kind === 'receipt') {
      assert.equal(duplicate.receipt.outcome, 'no_op');
      assert.equal(duplicate.receipt.effects[0]!.entityId, id);
    }
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      1,
    );
    assert.equal(
      f.database
        .prepare("SELECT revision FROM state_revision WHERE collection = 'preferences'")
        .get()?.revision,
      1,
    );
    assert.equal(
      (
        await f.run({
          kind: 'savePreference',
          preferenceId: id,
          type: 'cuisine',
          explicitValue: 'Italian',
          expectedPreferenceRevision: 1,
        })
      ).kind,
      'receipt',
    );
    assert.equal(
      f.database.prepare('SELECT value FROM saved_preference').get()?.value,
      JSON.stringify('Italian'),
    );
    assert.equal(f.database.prepare('SELECT revision FROM saved_preference').get()?.revision, 2);
    const stale = await f.run({ kind: 'clearPreferences', expectedPreferenceRevision: 1 });
    assert.equal(stale.kind, 'failed');
    if (stale.kind === 'failed') assert.equal(stale.error.code, 'stale_context');
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      1,
    );
  } finally {
    await f.writer.close();
  }
});

test('preference removal/clear is scoped, with no-op behavior and no hidden transcript import', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.run({
      kind: 'savePreference',
      preferenceId: id,
      type: 'ingredient_avoid',
      explicitValue: 'Walnuts',
      expectedPreferenceRevision: 0,
    });
    f.database
      .prepare('UPDATE conversation SET composer_draft = ?')
      .run(JSON.stringify('Keep this draft'));
    f.database
      .prepare('INSERT INTO favourite VALUES (?, 1, 1, ?, ?)')
      .run('53064', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z');
    const removed = await f.run({
      kind: 'removePreference',
      preferenceId: id,
      expectedPreferenceRevision: 1,
    });
    assert.equal(removed.kind, 'receipt');
    const noOp = await f.run({
      kind: 'removePreference',
      preferenceId: id,
      expectedPreferenceRevision: 2,
    });
    assert.equal(noOp.kind, 'receipt');
    if (noOp.kind === 'receipt') assert.equal(noOp.receipt.outcome, 'no_op');
    await f.run({
      kind: 'savePreference',
      preferenceId: randomUUID(),
      type: 'dietary_style',
      explicitValue: 'Vegetarian',
      expectedPreferenceRevision: 2,
    });
    assert.equal(
      (await f.run({ kind: 'clearPreferences', expectedPreferenceRevision: 3 })).kind,
      'receipt',
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      0,
    );
    assert.equal(
      f.database.prepare('SELECT composer_draft FROM conversation').get()?.composer_draft,
      JSON.stringify('Keep this draft'),
    );
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count, 1);
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      5,
    );
    const clearedAgain = await f.run({ kind: 'clearPreferences', expectedPreferenceRevision: 4 });
    if (clearedAgain.kind !== 'receipt') assert.fail('expected actual no-op receipt');
    assert.equal(clearedAgain.receipt.outcome, 'no_op');
  } finally {
    await f.writer.close();
  }
});

test('receipt insertion failure rolls back clearing multiple preferences and exact operation can retry', async () => {
  const f = await fixture();
  try {
    for (const [index, value] of ['Italian', 'Indian'].entries())
      await f.run({
        kind: 'savePreference',
        preferenceId: randomUUID(),
        type: 'cuisine',
        explicitValue: value,
        expectedPreferenceRevision: index,
      });
    const command = await f.register({ kind: 'clearPreferences', expectedPreferenceRevision: 2 });
    f.injectReceiptFailure(true);
    assert.equal((await f.execute(command)).kind, 'failed');
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      2,
    );
    assert.equal(
      f.database
        .prepare("SELECT revision FROM state_revision WHERE collection = 'preferences'")
        .get()?.revision,
      2,
    );
    f.injectReceiptFailure(false);
    const receipt = await f.execute(command);
    assert.equal(receipt.kind, 'receipt');
    assert.deepEqual(await f.execute(command), receipt);
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      0,
    );
    assert.equal(
      f.database
        .prepare("SELECT revision FROM state_revision WHERE collection = 'preferences'")
        .get()?.revision,
      3,
    );
  } finally {
    await f.writer.close();
  }
});

test('preference capacity and edit collisions cannot overwrite other saved preferences', async () => {
  const f = await fixture();
  try {
    const ids = Array.from({ length: 100 }, () => randomUUID());
    ids.forEach((id, index) =>
      f.database
        .prepare('INSERT INTO saved_preference VALUES (?, ?, ?, 1)')
        .run(id, 'cuisine', JSON.stringify(`Cuisine ${index}`)),
    );
    f.database.exec("UPDATE state_revision SET revision = 1 WHERE collection = 'preferences'");
    const full = await f.run({
      kind: 'savePreference',
      preferenceId: randomUUID(),
      type: 'ingredient_like',
      explicitValue: 'Beans',
      expectedPreferenceRevision: 1,
    });
    assert.equal(full.kind, 'failed');
    if (full.kind === 'failed') assert.equal(full.error.code, 'too_large');
    const collision = await f.run({
      kind: 'savePreference',
      preferenceId: ids[0]!,
      type: 'cuisine',
      explicitValue: 'Cuisine 1',
      expectedPreferenceRevision: 1,
    });
    assert.equal(collision.kind, 'failed');
    assert.equal(
      f.database.prepare('SELECT value FROM saved_preference WHERE preference_id = ?').get(ids[0]!)
        ?.value,
      JSON.stringify('Cuisine 0'),
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      100,
    );
  } finally {
    await f.writer.close();
  }
});
