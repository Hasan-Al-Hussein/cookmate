import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { CommandPayload, CommandResult, ConversationOrigin } from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import type { StoreChange } from '../src/services';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import { readConversationClearScope } from '../../../apps/mobile/src/data/conversationClearScope';
import { createClearConversationCommandHandler } from '../../../apps/mobile/src/data/clearConversationCommand';
import { preferenceCommandHandlers } from '../../../apps/mobile/src/data/preferenceCommands';
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
import { desktopConnection } from './helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
const prepare = createCommandPreparer(platform, catalogueBoundary);
const date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
const timestamp = '2026-09-28T00:00:00.000Z';

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
  const conversationId = randomUUID();
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId: randomUUID(), shoppingScopeId: randomUUID(), conversationId },
  );
  const reader = new SerializedReader(storage.connection);
  const state = createStateRepositories(reader, catalogueBoundary);
  const faults = { receipt: false };
  const originalPrepare = storage.connection.prepare;
  storage.connection.prepare = async (sql) => {
    const statement = await originalPrepare(sql);
    return {
      ...statement,
      run: async (values) => {
        if (faults.receipt && sql.startsWith('INSERT INTO operation_receipt'))
          throw new Error('injected receipt failure');
        await statement.run(values);
      },
    };
  };
  const events: StoreChange[] = [];
  const executor = createCommandExecutor({
    writer,
    catalogue: catalogueBoundary,
    platform,
    handlers: {
      ...preferenceCommandHandlers,
      ...createClearConversationCommandHandler({
        catalogue: catalogueBoundary,
        sha256: platform.sha256,
      }),
    },
    now: () => timestamp,
    dateContext: () => date,
    readReceipt: (id) =>
      readSnapshot(reader, (session) => readReceiptInSnapshot(session, id, catalogueBoundary)),
    onCommitted: (change) => events.push(change),
  });
  const register = async (payload: CommandPayload, origin?: ConversationOrigin) => {
    const reviewed =
      payload.kind === 'clearConversation'
        ? {
            ...payload,
            expectedScopeFingerprint: (
              await reader.transaction((session) =>
                readConversationClearScope(session, {
                  catalogue: catalogueBoundary,
                  sha256: platform.sha256,
                }),
              )
            ).fingerprint,
          }
        : payload;
    const command = await prepare(reviewed, origin ? { origin } : {});
    assert.equal(command.schemaVersion, 2);
    await registerReadyIntent(
      writer,
      {
        userIntentId: command.userIntentId,
        revision: command.intentRevision,
        phase: 'ready',
        ...(origin ? { origin } : {}),
        slots: [{ slotId: randomUUID(), command }],
      },
      catalogueBoundary,
      platform,
    );
    return command;
  };
  const source = (text: string, role: 'user' | 'assistant' = 'user'): ConversationOrigin => {
    const header = storage.database
      .prepare('SELECT generation, next_sequence FROM conversation')
      .get()!;
    const messageId = randomUUID();
    storage.database
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        messageId,
        conversationId,
        header.generation!,
        header.next_sequence!,
        role,
        JSON.stringify(text),
        'complete',
        timestamp,
      );
    storage.database.exec('UPDATE conversation SET next_sequence=next_sequence+1');
    if (role === 'user')
      storage.database
        .prepare('INSERT INTO message_context VALUES (?, ?, ?)')
        .run(
          messageId,
          JSON.stringify(date),
          storage.database
            .prepare("SELECT revision FROM state_revision WHERE collection='preferences'")
            .get()!.revision!,
        );
    return { conversationId, generation: header.generation as number, messageId };
  };
  const preferences = async () => {
    const result = await state.readPreferences();
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    if (result.kind !== 'ready') assert.fail();
    return result.value;
  };
  const links = () =>
    storage.database
      .prepare(
        `SELECT source_message_id AS sourceMessageId, preference_id AS preferenceId,
    type, value AS valueJson, saved_revision AS savedRevision, removed_revision AS removedRevision,
    save_operation_id AS saveOperationId FROM source_preference_link ORDER BY saved_revision, source_message_id`,
      )
      .all()
      .map((row) => ({
        sourceMessageId: row.sourceMessageId as string,
        preferenceId: row.preferenceId as string,
        type: row.type as string,
        savedRevision: row.savedRevision as number,
        removedRevision: row.removedRevision as number | null,
        saveOperationId: row.saveOperationId as string,
        value: JSON.parse(row.valueJson as string) as string,
      }));
  const snapshot = () =>
    Object.fromEntries(
      [
        'saved_preference',
        'preference_state',
        'source_preference_link',
        'state_revision',
        'message',
        'message_context',
        'conversation',
        'conversation_memory_state',
        'pending_intent',
        'command_slot',
        'operation_receipt',
        'assistant_acceptance',
      ].map((table) => [
        table,
        storage.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  return {
    ...storage,
    ...executor,
    register,
    source,
    preferences,
    links,
    snapshot,
    faults,
    events,
    conversationId,
    run: async (payload: CommandPayload, origin?: ConversationOrigin) =>
      executor.execute(await register(payload, origin)),
    close: () => writer.close(),
  };
}

test('duplicate save links the retained USER to the actual saved ID and row version, not the requested ID or global revision', async () => {
  const f = await fixture();
  try {
    const firstSource = f.source('Remember Italian; no peanuts tonight');
    const id = randomUUID();
    receipt(
      await f.run(
        {
          kind: 'savePreference',
          preferenceId: id,
          type: 'cuisine',
          explicitValue: 'Italian',
          expectedPreferenceRevision: 0,
        },
        firstSource,
      ),
    );
    receipt(
      await f.run({
        kind: 'savePreference',
        preferenceId: randomUUID(),
        type: 'ingredient_like',
        explicitValue: 'Beans',
        expectedPreferenceRevision: 1,
      }),
    );
    const laterSource = f.source('Remember Italian again');
    const requestedId = randomUUID();
    const duplicate = await f.register(
      {
        kind: 'savePreference',
        preferenceId: requestedId,
        type: 'cuisine',
        explicitValue: 'Italian',
        expectedPreferenceRevision: 2,
      },
      laterSource,
    );
    const saved = receipt(await f.execute(duplicate));
    assert.equal(saved.outcome, 'no_op');
    assert.equal(saved.effects[0]!.entityId, id);
    assert.equal((await f.preferences()).revision, 2);
    const link = f.links().find((item) => item.sourceMessageId === laterSource.messageId)!;
    assert.deepEqual(link, {
      sourceMessageId: laterSource.messageId,
      preferenceId: id,
      type: 'cuisine',
      value: 'Italian',
      savedRevision: 1,
      removedRevision: null,
      saveOperationId: duplicate.operationId,
    });
    assert.equal(
      f.links().some((item) => item.preferenceId === requestedId),
      false,
    );
    const beforeReplay = f.snapshot();
    const events = f.events.length;
    assert.deepEqual(receipt(await f.execute(duplicate)), saved);
    assert.deepEqual(f.snapshot(), beforeReplay);
    assert.equal(f.events.length, events);
    receipt(
      await f.run(
        {
          kind: 'savePreference',
          preferenceId: randomUUID(),
          type: 'cuisine',
          explicitValue: 'Italian',
          expectedPreferenceRevision: 2,
        },
        laterSource,
      ),
    );
    assert.equal(f.links().length, 2);
    assert.equal(
      f.links().find((item) => item.sourceMessageId === laterSource.messageId)!.saveOperationId,
      duplicate.operationId,
    );
    assert.equal((await f.preferences()).lastRemovalRevision, null);
    const assistant = f.source('Suggested Greek', 'assistant');
    receipt(
      await f.run(
        {
          kind: 'savePreference',
          preferenceId: randomUUID(),
          type: 'cuisine',
          explicitValue: 'Greek',
          expectedPreferenceRevision: 2,
        },
        assistant,
      ),
    );
    assert.equal(f.links().length, 2);
  } finally {
    await f.close();
  }
});

test('replacement, removal, re-addition and clear withdraw exact versions and advance only actual-removal watermark', async () => {
  const f = await fixture();
  try {
    assert.equal(
      receipt(await f.run({ kind: 'clearPreferences', expectedPreferenceRevision: 0 })).outcome,
      'no_op',
    );
    assert.equal(
      receipt(
        await f.run({
          kind: 'removePreference',
          preferenceId: randomUUID(),
          expectedPreferenceRevision: 0,
        }),
      ).outcome,
      'no_op',
    );
    assert.deepEqual(await f.preferences(), { revision: 0, lastRemovalRevision: null, items: [] });
    assert.equal(f.events.length, 0);
    const id = randomUUID();
    const otherId = randomUUID();
    const original = f.source('Remember Italian; no peanuts tonight');
    receipt(
      await f.run(
        {
          kind: 'savePreference',
          preferenceId: id,
          type: 'cuisine',
          explicitValue: 'Italian',
          expectedPreferenceRevision: 0,
        },
        original,
      ),
    );
    const other = f.source('Remember beans');
    receipt(
      await f.run(
        {
          kind: 'savePreference',
          preferenceId: otherId,
          type: 'ingredient_like',
          explicitValue: 'Beans',
          expectedPreferenceRevision: 1,
        },
        other,
      ),
    );
    const correction = f.source('Remember Thai instead');
    receipt(
      await f.run(
        {
          kind: 'savePreference',
          preferenceId: id,
          type: 'cuisine',
          explicitValue: 'Thai',
          expectedPreferenceRevision: 2,
        },
        correction,
      ),
    );
    assert.equal((await f.preferences()).lastRemovalRevision, 3);
    assert.deepEqual(
      f.links().map((link) => [link.savedRevision, link.removedRevision]),
      [
        [1, 3],
        [2, null],
        [3, null],
      ],
    );
    receipt(
      await f.run({ kind: 'removePreference', preferenceId: id, expectedPreferenceRevision: 3 }),
    );
    assert.equal((await f.preferences()).lastRemovalRevision, 4);
    assert.deepEqual(
      f.links().map((link) => [link.savedRevision, link.removedRevision]),
      [
        [1, 3],
        [2, null],
        [3, 4],
      ],
    );
    const removalAgain = receipt(
      await f.run({ kind: 'removePreference', preferenceId: id, expectedPreferenceRevision: 4 }),
    );
    assert.equal(removalAgain.outcome, 'no_op');
    assert.equal((await f.preferences()).lastRemovalRevision, 4);
    const readd = f.source('Remember Italian anew');
    receipt(
      await f.run(
        {
          kind: 'savePreference',
          preferenceId: id,
          type: 'cuisine',
          explicitValue: 'Italian',
          expectedPreferenceRevision: 4,
        },
        readd,
      ),
    );
    assert.equal((await f.preferences()).lastRemovalRevision, 4);
    assert.deepEqual(
      f.links().map((link) => [link.savedRevision, link.removedRevision]),
      [
        [1, 3],
        [2, null],
        [3, 4],
        [5, null],
      ],
    );
    receipt(await f.run({ kind: 'clearPreferences', expectedPreferenceRevision: 5 }));
    assert.deepEqual(await f.preferences(), { revision: 6, lastRemovalRevision: 6, items: [] });
    assert.deepEqual(
      f.links().map((link) => [link.savedRevision, link.removedRevision]),
      [
        [1, 3],
        [2, 6],
        [3, 4],
        [5, 6],
      ],
    );
    assert.equal(
      receipt(await f.run({ kind: 'clearPreferences', expectedPreferenceRevision: 6 })).outcome,
      'no_op',
    );
    assert.deepEqual(await f.preferences(), { revision: 6, lastRemovalRevision: 6, items: [] });
    assert.equal(
      f.database.prepare('SELECT text FROM message WHERE message_id=?').get(original.messageId)
        ?.text,
      JSON.stringify('Remember Italian; no peanuts tonight'),
    );
  } finally {
    await f.close();
  }
});

test('withdrawal of a preference saved outside conversation still advances the watermark without inventing links', async () => {
  const f = await fixture();
  try {
    const preferenceId = randomUUID();
    receipt(
      await f.run({
        kind: 'savePreference',
        preferenceId,
        type: 'cuisine',
        explicitValue: 'Italian',
        expectedPreferenceRevision: 0,
      }),
    );
    receipt(
      await f.run({
        kind: 'savePreference',
        preferenceId,
        type: 'cuisine',
        explicitValue: 'Thai',
        expectedPreferenceRevision: 1,
      }),
    );
    assert.equal((await f.preferences()).lastRemovalRevision, 2);
    receipt(await f.run({ kind: 'removePreference', preferenceId, expectedPreferenceRevision: 2 }));
    assert.deepEqual(await f.preferences(), { revision: 3, lastRemovalRevision: 3, items: [] });
    assert.equal(f.links().length, 0);
    assert.ok(f.events.every((change) => !change.collections.includes('conversation')));
  } finally {
    await f.close();
  }
});

test('clear conversation removes provenance and accepted memory but retains preferences, watermark and historical receipt replay', async () => {
  const f = await fixture();
  try {
    const source = f.source('Remember Italian');
    const id = randomUUID();
    const save = await f.register(
      {
        kind: 'savePreference',
        preferenceId: id,
        type: 'cuisine',
        explicitValue: 'Italian',
        expectedPreferenceRevision: 0,
      },
      source,
    );
    const saved = receipt(await f.execute(save));
    receipt(
      await f.run({ kind: 'removePreference', preferenceId: id, expectedPreferenceRevision: 1 }),
    );
    receipt(
      await f.run(
        {
          kind: 'savePreference',
          preferenceId: randomUUID(),
          type: 'ingredient_like',
          explicitValue: 'Beans',
          expectedPreferenceRevision: 2,
        },
        f.source('Remember beans'),
      ),
    );
    const memoryId = randomUUID();
    f.database
      .prepare(
        'INSERT INTO memory_entry VALUES (?, ?, 1, \'context\', \'{"kind":"conversation"}\')',
      )
      .run(memoryId, source.messageId);
    f.database
      .prepare("INSERT INTO memory_source_review VALUES (?, 'retain', 1)")
      .run(source.messageId);
    f.database
      .prepare(
        'UPDATE conversation_memory_state SET projection_revision=1, working_after_sequence=0, carry_memory_ids_json=?',
      )
      .run(JSON.stringify([memoryId]));
    const pending = await f.register(
      {
        kind: 'savePreference',
        preferenceId: randomUUID(),
        type: 'cuisine',
        explicitValue: 'Indian',
        expectedPreferenceRevision: 3,
      },
      source,
    );
    const beforePreferences = await f.preferences();
    const clear = await f.register({
      kind: 'clearConversation',
      conversationId: f.conversationId,
      expectedGeneration: 0,
    });
    const cleared = receipt(await f.execute(clear));
    assert.deepEqual(await f.preferences(), beforePreferences);
    for (const table of [
      'message',
      'message_context',
      'memory_entry',
      'memory_source_review',
      'source_preference_link',
      'assistant_acceptance',
    ]) {
      assert.equal(
        f.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
        0,
        table,
      );
    }
    assert.deepEqual(
      {
        ...f.database
          .prepare(
            'SELECT generation, projection_revision, working_after_sequence, carry_memory_ids_json FROM conversation_memory_state',
          )
          .get(),
      },
      {
        generation: 1,
        projection_revision: 0,
        working_after_sequence: null,
        carry_memory_ids_json: '[]',
      },
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      4,
    );
    assert.deepEqual(receipt(await f.execute(save)), saved);
    assert.deepEqual(receipt(await f.execute(clear)), cleared);
    assert.equal(f.links().length, 0);
    assert.equal((await f.execute(pending)).kind, 'failed');
    assert.equal((await f.preferences()).lastRemovalRevision, 2);
  } finally {
    await f.close();
  }
});

test('receipt failure rolls back every preference/provenance/watermark or chat-clear write and exact command can retry', async () => {
  for (const action of ['save', 'replace', 'remove', 'clear', 'clear_chat']) {
    const f = await fixture();
    try {
      const id = randomUUID();
      receipt(
        await f.run(
          {
            kind: 'savePreference',
            preferenceId: id,
            type: 'cuisine',
            explicitValue: 'Italian',
            expectedPreferenceRevision: 0,
          },
          f.source('Remember Italian'),
        ),
      );
      receipt(
        await f.run(
          {
            kind: 'savePreference',
            preferenceId: randomUUID(),
            type: 'ingredient_like',
            explicitValue: 'Beans',
            expectedPreferenceRevision: 1,
          },
          f.source('Remember beans'),
        ),
      );
      const payload: CommandPayload =
        action === 'save' || action === 'replace'
          ? {
              kind: 'savePreference',
              preferenceId: action === 'save' ? randomUUID() : id,
              type: 'cuisine',
              explicitValue: 'Thai',
              expectedPreferenceRevision: 2,
            }
          : action === 'remove'
            ? { kind: 'removePreference', preferenceId: id, expectedPreferenceRevision: 2 }
            : action === 'clear'
              ? { kind: 'clearPreferences', expectedPreferenceRevision: 2 }
              : {
                  kind: 'clearConversation',
                  conversationId: f.conversationId,
                  expectedGeneration: 0,
                };
      const origin =
        action === 'save' || action === 'replace' ? f.source('Remember Thai') : undefined;
      const command = await f.register(payload, origin);
      const before = f.snapshot();
      const eventCount = f.events.length;
      f.faults.receipt = true;
      const failed = await f.execute(command);
      assert.equal(failed.kind, 'failed', action);
      if (failed.kind === 'failed') assert.equal(failed.error.code, 'storage_failure');
      assert.deepEqual(f.snapshot(), before, action);
      assert.equal(f.events.length, eventCount);
      f.faults.receipt = false;
      const committed = receipt(await f.execute(command));
      assert.deepEqual(receipt(await f.execute(command)), committed);
      assert.equal(f.database.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      await f.close();
    }
  }
});

test('public preference reads and duplicate provenance comparisons preserve exact UTF-16 text', async () => {
  const f = await fixture();
  try {
    const values = [
      '\0',
      'Italian\0tonight',
      '\ud800'.repeat(256),
      '\udfff',
      'e\u0301🍲',
      '"literal\\u0000"',
    ];
    for (const [index, value] of values.entries()) {
      const id = randomUUID();
      const source = f.source(`Remember ${value}`);
      const saved = receipt(
        await f.run(
          {
            kind: 'savePreference',
            preferenceId: id,
            type: 'cuisine',
            explicitValue: value,
            expectedPreferenceRevision: index,
          },
          source,
        ),
      );
      assert.equal(saved.outcome, 'committed');
      assert.equal(
        (await f.preferences()).items.find((item) => item.preferenceId === id)!.value,
        value,
      );
      const duplicate = receipt(
        await f.run(
          {
            kind: 'savePreference',
            preferenceId: randomUUID(),
            type: 'cuisine',
            explicitValue: value,
            expectedPreferenceRevision: index + 1,
          },
          source,
        ),
      );
      assert.equal(duplicate.outcome, 'no_op');
      assert.equal(f.links().find((item) => item.preferenceId === id)!.value, value);
    }
    assert.equal(f.links().length, values.length);
  } finally {
    await f.close();
  }
});
