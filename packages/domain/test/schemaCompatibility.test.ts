import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { DATABASE_SCHEMA_VERSION, validatePreferenceSnapshot } from '@cookmate/contracts';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { configureConnection, runBound, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const seed = {
  identity: catalogue.identity,
  recipes: catalogue.recipes,
  recipeSources: catalogueProvenance.recipeSources,
};
const identifiers = () => ({
  installationId: randomUUID(),
  shoppingScopeId: randomUUID(),
  conversationId: randomUUID(),
});
const timestamp = '2026-09-28T00:00:00.000Z';
type Fixture = ReturnType<typeof desktopConnection>;

async function withDatabase(
  check: (
    fixture: Fixture,
    writer: SerializedWriter,
    ids: ReturnType<typeof identifiers>,
  ) => Promise<void> | void,
): Promise<void> {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  try {
    const ids = identifiers();
    assert.equal(await initializeDatabase(writer, seed, ids), 'created');
    await check(fixture, writer, ids);
  } finally {
    await writer.close();
  }
}

function insertMessage(fixture: Fixture, conversationId: string, sequence = 0): string {
  const messageId = randomUUID();
  fixture.database
    .prepare("INSERT INTO message VALUES (?, ?, 0, ?, 'user', ?, 'complete', ?)")
    .run(
      messageId,
      conversationId,
      sequence,
      JSON.stringify(`Original source ${sequence}`),
      timestamp,
    );
  return messageId;
}

function insertIntent(fixture: Fixture): string {
  const intentId = randomUUID();
  fixture.database
    .prepare("INSERT INTO pending_intent VALUES (?, 0, 'awaiting_response', '{}')")
    .run(intentId);
  return intentId;
}

function insertReceipt(fixture: Fixture, intentId: string, operationId = randomUUID()): string {
  fixture.database
    .prepare('INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(operationId, intentId, 'a'.repeat(64), 'no_op', timestamp, 'unchanged', '[]');
  return operationId;
}

test('fresh genesis is database version two and initializes memory state once', async () => {
  await withDatabase(async (fixture, writer, ids) => {
    assert.equal(DATABASE_SCHEMA_VERSION, 2);
    assert.equal(fixture.database.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.deepEqual(
      { ...fixture.database.prepare('SELECT * FROM conversation_memory_state').get() },
      {
        conversation_id: ids.conversationId,
        generation: 0,
        projection_revision: 0,
        working_after_sequence: null,
        carry_memory_ids_json: '[]',
      },
    );
    assert.deepEqual(
      { ...fixture.database.prepare('SELECT * FROM preference_state').get() },
      {
        singleton: 1,
        last_removal_revision: null,
      },
    );
    fixture.database.exec('UPDATE preference_state SET last_removal_revision = 7');
    fixture.database.exec('UPDATE conversation_memory_state SET projection_revision = 4');
    const changes = fixture.database.prepare('SELECT total_changes() AS count').get()?.count;
    assert.equal(await initializeDatabase(writer, seed, identifiers()), 'existing');
    assert.equal(fixture.database.prepare('SELECT total_changes() AS count').get()?.count, changes);
    assert.equal(
      fixture.database.prepare('SELECT conversation_id FROM conversation_memory_state').get()
        ?.conversation_id,
      ids.conversationId,
    );
    assert.equal(
      fixture.database.prepare('SELECT projection_revision FROM conversation_memory_state').get()
        ?.projection_revision,
      4,
    );
    assert.equal(
      fixture.database.prepare('SELECT last_removal_revision FROM preference_state').get()
        ?.last_removal_revision,
      7,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM recipe').get()?.count,
      100,
    );
  });
});

test('version one, unknown versions and unversioned state reject without deletion or reseed', async () => {
  for (const version of [0, 1, 3, 99]) {
    const fixture = desktopConnection();
    await configureConnection(fixture.connection);
    const writer = new SerializedWriter(fixture.connection);
    try {
      fixture.database.exec('CREATE TABLE saved_state (value TEXT NOT NULL)');
      fixture.database.prepare('INSERT INTO saved_state VALUES (?)').run('retained user state');
      fixture.database.exec(`PRAGMA user_version = ${version}`);
      const changes = fixture.database.prepare('SELECT total_changes() AS count').get()?.count;
      await assert.rejects(initializeDatabase(writer, seed, identifiers()), {
        code: 'incompatible_version',
      });
      assert.equal(
        fixture.database.prepare('SELECT total_changes() AS count').get()?.count,
        changes,
      );
      assert.equal(
        fixture.database.prepare('SELECT value FROM saved_state').get()?.value,
        'retained user state',
      );
      assert.equal(fixture.database.prepare('PRAGMA user_version').get()?.user_version, version);
      assert.deepEqual(
        fixture.database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
        ['saved_state'],
      );
    } finally {
      await writer.close();
    }
  }
});

test('incomplete, altered and extra version-two layouts preserve saved state on rejection', async () => {
  for (const change of [
    'DROP TABLE assistant_intent_context',
    'ALTER TABLE reference_set RENAME COLUMN ordinal TO old_ordinal',
    'DROP INDEX reference_set_message',
    'DROP TABLE assistant_acceptance',
    'ALTER TABLE memory_entry RENAME COLUMN revision TO old_revision',
    'DROP INDEX memory_relation_target',
    'CREATE TABLE unexpected_state (value TEXT)',
  ]) {
    const fixture = desktopConnection();
    await configureConnection(fixture.connection);
    const writer = new SerializedWriter(fixture.connection);
    try {
      const ids = identifiers();
      await initializeDatabase(writer, seed, ids);
      fixture.database
        .prepare('INSERT INTO favourite VALUES (?, 1, 1, ?, ?)')
        .run('53064', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z');
      fixture.database.exec(change);
      const changes = fixture.database.prepare('SELECT total_changes() AS count').get()?.count;
      await assert.rejects(initializeDatabase(writer, seed, identifiers()), {
        code: 'incompatible_version',
      });
      assert.equal(
        fixture.database.prepare('SELECT total_changes() AS count').get()?.count,
        changes,
      );
      assert.equal(
        fixture.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count,
        1,
      );
      assert.equal(
        fixture.database
          .prepare("SELECT value FROM app_metadata WHERE key = 'installation_id'")
          .get()?.value,
        ids.installationId,
      );
      assert.equal(fixture.database.prepare('PRAGMA user_version').get()?.user_version, 2);
    } finally {
      await writer.close();
    }
  }
});

test('working memory state enforces owner, revisions, boundary and bounded carry JSON', async () => {
  await withDatabase((fixture) => {
    assert.throws(
      () =>
        fixture.database
          .prepare("INSERT INTO conversation_memory_state VALUES (?, 0, 0, NULL, '[]')")
          .run(randomUUID()),
      /FOREIGN KEY/,
    );
    for (const column of ['generation', 'projection_revision', 'working_after_sequence']) {
      assert.throws(
        () => fixture.database.exec(`UPDATE conversation_memory_state SET ${column} = -1`),
        /CHECK/,
      );
    }
    const updateCarry = fixture.database.prepare(
      'UPDATE conversation_memory_state SET carry_memory_ids_json = ?',
    );
    for (const invalid of [
      'not JSON',
      '{}',
      JSON.stringify(Array.from({ length: 33 }, () => randomUUID())),
      JSON.stringify(['é'.repeat(2050)]),
    ]) {
      assert.throws(() => updateCarry.run(invalid), /CHECK|malformed JSON/);
    }
    updateCarry.run(JSON.stringify(Array.from({ length: 32 }, () => randomUUID())));
    assert.throws(
      () => fixture.database.exec('INSERT INTO preference_state VALUES (2, NULL)'),
      /CHECK/,
    );
    assert.throws(
      () => fixture.database.exec('UPDATE preference_state SET last_removal_revision = -1'),
      /CHECK/,
    );
  });
});

test('source context, review, entries and relations enforce foreign keys, uniqueness and bounded JSON', async () => {
  await withDatabase((fixture, _writer, ids) => {
    const sourceId = insertMessage(fixture, ids.conversationId);
    const laterSourceId = insertMessage(fixture, ids.conversationId, 1);
    const context = fixture.database.prepare('INSERT INTO message_context VALUES (?, ?, ?)');
    assert.throws(() => context.run(randomUUID(), '{}', 0), /FOREIGN KEY/);
    assert.throws(() => context.run(sourceId, 'not JSON', 0), /CHECK/);
    assert.throws(() => context.run(sourceId, JSON.stringify('é'.repeat(2050)), 0), /CHECK/);
    assert.throws(() => context.run(sourceId, '{}', -1), /CHECK/);
    context.run(sourceId, '{}', 0);

    const review = fixture.database.prepare('INSERT INTO memory_source_review VALUES (?, ?, ?)');
    assert.throws(() => review.run(randomUUID(), 'pending', 0), /FOREIGN KEY/);
    assert.throws(() => review.run(sourceId, 'forgotten', 0), /CHECK/);
    assert.throws(() => review.run(sourceId, 'pending', -1), /CHECK/);
    review.run(sourceId, 'pending', 0);
    for (const disposition of ['retain', 'non_memory', 'unresolved']) {
      fixture.database.prepare('UPDATE memory_source_review SET disposition = ?').run(disposition);
    }

    const entry = fixture.database.prepare('INSERT INTO memory_entry VALUES (?, ?, ?, ?, ?)');
    const memoryId = randomUUID();
    const laterMemoryId = randomUUID();
    assert.throws(() => entry.run(memoryId, randomUUID(), 0, 'constraint', '{}'), /FOREIGN KEY/);
    assert.throws(() => entry.run(memoryId, sourceId, -1, 'constraint', '{}'), /CHECK/);
    assert.throws(() => entry.run(memoryId, sourceId, 0, 'summary', '{}'), /CHECK/);
    assert.throws(() => entry.run(memoryId, sourceId, 0, 'context', 'not JSON'), /CHECK/);
    assert.throws(
      () => entry.run(memoryId, sourceId, 0, 'context', JSON.stringify('é'.repeat(2050))),
      /CHECK/,
    );
    entry.run(memoryId, sourceId, 0, 'constraint', '{}');
    assert.throws(() => entry.run(randomUUID(), sourceId, 0, 'constraint', '{}'), /UNIQUE/);
    entry.run(laterMemoryId, laterSourceId, 0, 'correction', '{}');
    assert.equal(
      fixture.database
        .prepare('PRAGMA table_info(memory_entry)')
        .all()
        .some((column) => column.name === 'quote'),
      false,
    );

    const relation = fixture.database.prepare('INSERT INTO memory_relation VALUES (?, ?, ?, ?, ?)');
    assert.throws(() => relation.run(randomUUID(), 0, memoryId, 'supersedes', 0), /FOREIGN KEY/);
    assert.throws(
      () => relation.run(laterMemoryId, 0, randomUUID(), 'supersedes', 0),
      /FOREIGN KEY/,
    );
    assert.throws(() => relation.run(laterMemoryId, -1, memoryId, 'supersedes', 0), /CHECK/);
    assert.throws(() => relation.run(laterMemoryId, 0, memoryId, 'replaces', 0), /CHECK/);
    assert.throws(() => relation.run(laterMemoryId, 0, memoryId, 'supersedes', -1), /CHECK/);
    relation.run(laterMemoryId, 0, memoryId, 'supersedes', 0);
    assert.throws(() => relation.run(laterMemoryId, 0, memoryId, 'conflicts_with', 0), /UNIQUE/);
    assert.throws(() => relation.run(laterMemoryId, 1, memoryId, 'supersedes', 0), /UNIQUE/);
  });
});

test('preference source links preserve exact values with a byte envelope and shared code-point validation', async () => {
  await withDatabase((fixture, _writer, ids) => {
    const sourceId = insertMessage(fixture, ids.conversationId);
    const operationId = insertReceipt(fixture, randomUUID());
    const preferenceId = randomUUID();
    const insert = fixture.database.prepare(
      'INSERT INTO source_preference_link VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    assert.throws(
      () =>
        insert.run(
          randomUUID(),
          preferenceId,
          'cuisine',
          JSON.stringify('Italian'),
          1,
          null,
          operationId,
        ),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        insert.run(
          sourceId,
          preferenceId,
          'unknown',
          JSON.stringify('Italian'),
          1,
          null,
          operationId,
        ),
      /CHECK/,
    );
    for (const value of ['', '\ud800'.repeat(257)]) {
      assert.throws(
        () =>
          insert.run(
            sourceId,
            preferenceId,
            'cuisine',
            JSON.stringify(value),
            1,
            null,
            operationId,
          ),
        /CHECK/,
      );
    }
    assert.throws(
      () =>
        insert.run(
          sourceId,
          preferenceId,
          'cuisine',
          JSON.stringify('Italian'),
          -1,
          null,
          operationId,
        ),
      /CHECK/,
    );
    assert.throws(
      () =>
        insert.run(
          sourceId,
          preferenceId,
          'cuisine',
          JSON.stringify('Italian'),
          1,
          -1,
          operationId,
        ),
      /CHECK/,
    );
    insert.run(
      sourceId,
      preferenceId,
      'cuisine',
      JSON.stringify('🍲'.repeat(256)),
      1,
      2,
      operationId,
    );
    assert.throws(
      () =>
        insert.run(
          sourceId,
          preferenceId,
          'cuisine',
          JSON.stringify('Italian'),
          1,
          null,
          operationId,
        ),
      /UNIQUE/,
    );
    insert.run(sourceId, preferenceId, 'cuisine', JSON.stringify('Italian'), 3, null, operationId);
    for (const [index, value] of [
      'x'.repeat(257),
      '\0',
      'Italian\0tonight',
      '\ud800'.repeat(256),
      '\udfff',
      'e\u0301🍲',
      '"literal\\u0000"',
    ].entries()) {
      const revision = index + 4;
      const isValid = validatePreferenceSnapshot({
        revision,
        lastRemovalRevision: null,
        items: [{ preferenceId, type: 'cuisine', value, revision }],
      });
      assert.equal(isValid, index > 0);
      // SQL bounds the encoded envelope; shared validation owns the code-point limit.
      const encoded = JSON.stringify(value);
      insert.run(sourceId, preferenceId, 'cuisine', encoded, revision, null, operationId);
      const stored = fixture.database
        .prepare(
          'SELECT hex(value) AS value_hex, value AS value_json FROM source_preference_link WHERE saved_revision = ?',
        )
        .get(revision);
      assert.equal(stored?.value_hex, Buffer.from(encoded, 'utf8').toString('hex').toUpperCase());
      assert.equal(JSON.parse(stored?.value_json as string), value);
    }
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM source_preference_link').get()?.count,
      9,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      0,
    );
    assert.throws(
      () =>
        fixture.database
          .prepare('DELETE FROM operation_receipt WHERE operation_id = ?')
          .run(operationId),
      /FOREIGN KEY/,
    );
  });
});

test('link and successful receipt may be inserted in either order but missing receipt rolls back', async () => {
  await withDatabase(async (fixture, writer, ids) => {
    const sourceId = insertMessage(fixture, ids.conversationId);
    const operationId = randomUUID();
    const preferenceId = randomUUID();
    await writer.transaction(async (session) => {
      await runBound(
        session,
        'INSERT INTO source_preference_link VALUES (?, ?, ?, ?, 1, NULL, ?)',
        [sourceId, preferenceId, 'cuisine', JSON.stringify('Italian'), operationId],
      );
      await runBound(session, 'INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)', [
        operationId,
        randomUUID(),
        'a'.repeat(64),
        'committed',
        timestamp,
        'unchanged',
        '[]',
      ]);
    });
    await assert.rejects(
      writer.transaction(async (session) => {
        await runBound(
          session,
          'INSERT INTO source_preference_link VALUES (?, ?, ?, ?, 2, NULL, ?)',
          [sourceId, preferenceId, 'cuisine', JSON.stringify('Italian'), randomUUID()],
        );
        await session.exec('UPDATE preference_state SET last_removal_revision = 2');
      }),
      /FOREIGN KEY/,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM source_preference_link').get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare('SELECT last_removal_revision FROM preference_state').get()
        ?.last_removal_revision,
      null,
    );
    assert.equal(fixture.database.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});

test('immutable acceptance is independently versioned, bounded and owned by a retained intent', async () => {
  await withDatabase((fixture) => {
    const intentId = insertIntent(fixture);
    const acceptance = fixture.database.prepare(
      'INSERT INTO assistant_acceptance VALUES (?, ?, ?, ?)',
    );
    assert.throws(
      () => acceptance.run(randomUUID(), 'memory-acceptance-v1', 'a'.repeat(64), '{}'),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => acceptance.run(intentId, 'memory-acceptance-v2', 'a'.repeat(64), '{}'),
      /CHECK/,
    );
    assert.throws(
      () => acceptance.run(intentId, 'memory-acceptance-v1', 'a'.repeat(63), '{}'),
      /CHECK/,
    );
    assert.throws(
      () => acceptance.run(intentId, 'memory-acceptance-v1', 'a'.repeat(64), 'not JSON'),
      /CHECK/,
    );
    assert.throws(
      () =>
        acceptance.run(
          intentId,
          'memory-acceptance-v1',
          'a'.repeat(64),
          JSON.stringify('é'.repeat(262144)),
        ),
      /CHECK/,
    );
    acceptance.run(
      intentId,
      'memory-acceptance-v1',
      'a'.repeat(64),
      JSON.stringify('é'.repeat(262143)),
    );
    assert.throws(
      () => acceptance.run(intentId, 'memory-acceptance-v1', 'a'.repeat(64), '{}'),
      /UNIQUE/,
    );
  });
});

test('chat deletion cascades memory, links and acceptance while preferences, watermark and receipts survive', async () => {
  await withDatabase((fixture, _writer, ids) => {
    const sourceId = insertMessage(fixture, ids.conversationId);
    const laterSourceId = insertMessage(fixture, ids.conversationId, 1);
    const intentId = insertIntent(fixture);
    const operationId = insertReceipt(fixture, intentId);
    const preferenceId = randomUUID();
    const memoryId = randomUUID();
    const laterMemoryId = randomUUID();
    fixture.database.prepare("INSERT INTO message_context VALUES (?, '{}', 0)").run(sourceId);
    fixture.database
      .prepare("INSERT INTO memory_source_review VALUES (?, 'retain', 0)")
      .run(sourceId);
    fixture.database
      .prepare("INSERT INTO memory_entry VALUES (?, ?, 0, 'constraint', '{}')")
      .run(memoryId, sourceId);
    fixture.database
      .prepare("INSERT INTO memory_entry VALUES (?, ?, 0, 'correction', '{}')")
      .run(laterMemoryId, laterSourceId);
    fixture.database
      .prepare("INSERT INTO memory_relation VALUES (?, 0, ?, 'supersedes', 0)")
      .run(laterMemoryId, memoryId);
    fixture.database
      .prepare("INSERT INTO saved_preference VALUES (?, 'cuisine', ?, 3)")
      .run(preferenceId, JSON.stringify('Italian'));
    fixture.database
      .prepare("INSERT INTO source_preference_link VALUES (?, ?, 'cuisine', ?, 1, 2, ?)")
      .run(sourceId, preferenceId, JSON.stringify('Italian'), operationId);
    fixture.database.exec('UPDATE preference_state SET last_removal_revision = 2');
    fixture.database
      .prepare(
        "INSERT INTO assistant_intent_context VALUES (?, 1, 'accepted', 0, '{}', '{}', '{}', '[]')",
      )
      .run(intentId);
    fixture.database
      .prepare("INSERT INTO assistant_acceptance VALUES (?, 'memory-acceptance-v1', ?, '{}')")
      .run(intentId, 'a'.repeat(64));
    fixture.database.prepare('DELETE FROM message WHERE message_id = ?').run(sourceId);
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM memory_relation').get()?.count,
      0,
    );
    fixture.database.prepare('DELETE FROM message WHERE message_id = ?').run(laterSourceId);
    fixture.database.prepare('DELETE FROM pending_intent WHERE user_intent_id = ?').run(intentId);
    fixture.database
      .prepare('DELETE FROM conversation WHERE conversation_id = ?')
      .run(ids.conversationId);
    for (const table of [
      'conversation_memory_state',
      'message_context',
      'memory_source_review',
      'memory_entry',
      'memory_relation',
      'source_preference_link',
      'assistant_intent_context',
      'assistant_acceptance',
    ]) {
      assert.equal(
        fixture.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
        0,
        table,
      );
    }
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare('SELECT last_removal_revision FROM preference_state').get()
        ?.last_removal_revision,
      2,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      1,
    );
    assert.equal(fixture.database.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});

test('assistant context has bounded versioned lifecycle and cascades independently of receipts', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  try {
    await initializeDatabase(writer, seed, identifiers());
    const intentId = randomUUID();
    fixture.database
      .prepare('INSERT INTO pending_intent VALUES (?, 0, ?, ?)')
      .run(intentId, 'awaiting_response', '{}');
    const insert = fixture.database.prepare(
      'INSERT INTO assistant_intent_context VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
    );
    assert.throws(
      () => insert.run(intentId, 2, 'awaiting_response', '{}', null, null, '[]'),
      /CHECK/,
    );
    assert.throws(() => insert.run(intentId, 1, 'accepted', '{}', null, null, '[]'), /CHECK/);
    assert.throws(
      () =>
        insert.run(
          intentId,
          1,
          'awaiting_response',
          JSON.stringify('é'.repeat(70000)),
          null,
          null,
          '[]',
        ),
      /CHECK/,
    );
    assert.throws(
      () => insert.run(randomUUID(), 1, 'awaiting_response', '{}', null, null, '[]'),
      /FOREIGN KEY/,
    );
    insert.run(intentId, 1, 'awaiting_response', '{}', null, null, '[]');
    fixture.database
      .prepare('INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        randomUUID(),
        intentId,
        'a'.repeat(64),
        'no_op',
        '2026-09-28T00:00:00.000Z',
        'unchanged',
        '[]',
      );
    fixture.database.prepare('DELETE FROM pending_intent WHERE user_intent_id = ?').run(intentId);
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM assistant_intent_context').get()
        ?.count,
      0,
    );
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      1,
    );
  } finally {
    await writer.close();
  }
});
