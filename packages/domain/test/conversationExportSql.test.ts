import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RepositoryResult } from '../src/services';
import {
  CONVERSATION_EXPORT_MAX_BYTES,
  formatConversationExportText,
} from '../src/conversationExport';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const timestamp = '2026-10-01T08:00:00.000Z';
const platform = {
  newId: randomUUID,
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
};
function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-conversation-export-'));
  const connections: ReturnType<typeof desktopConnection>[] = [];
  const readSql: string[] = [];
  const readTransactions: string[] = [];
  let pageReads = 0;
  let failPage: number | null = null;
  const opened = await createLocalStore({
    platform,
    now: () => timestamp,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    openConnection: async (purpose) => {
      const connection = desktopConnection(join(directory, 'store.db'));
      connections.push(connection);
      if (purpose === 'read') {
        const all = connection.connection.all.bind(connection.connection);
        connection.connection.all = async <Row extends object>(
          sql: string,
          values?: readonly SqlValue[],
        ) => {
          readSql.push(sql);
          if (
            sql.includes('FROM message WHERE conversation_id') &&
            sql.includes('ORDER BY sequence')
          ) {
            pageReads++;
            if (pageReads === failPage) throw new Error('Injected page storage failure');
          }
          return all<Row>(sql, values);
        };
        const exec = connection.connection.exec.bind(connection.connection);
        connection.connection.exec = async (sql) => {
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) readTransactions.push(sql);
          await exec(sql);
        };
      }
      return connection.connection;
    },
  });
  assert.equal(opened.kind, 'ready');
  if (opened.kind !== 'ready') assert.fail();
  const services = opened.services;
  const database = connections[0]!.database;
  const conversationId = database.prepare('SELECT conversation_id AS id FROM conversation').get()!
    .id as string;
  const events: unknown[] = [];
  services.queries.subscribe((change) => events.push(change));
  readSql.length = 0;
  readTransactions.length = 0;
  function addMessage(
    sequence: number,
    options: {
      text?: string;
      role?: 'user' | 'assistant';
      generation?: number;
      createdAt?: string;
    } = {},
  ) {
    const id = randomUUID();
    const generation = options.generation ?? 0;
    database
      .prepare('INSERT INTO message VALUES (?,?,?,?,?,?,?,?)')
      .run(
        id,
        conversationId,
        generation,
        sequence,
        options.role ?? 'assistant',
        JSON.stringify(options.text ?? `Saved message ${sequence}`),
        'complete',
        options.createdAt ?? timestamp,
      );
    if (generation === 0)
      database
        .prepare('UPDATE conversation SET next_sequence=MAX(next_sequence,?)')
        .run(sequence + 1);
    return id;
  }
  function addReferences(messageId: string, ordinal: number, recipeIds: string[]) {
    const setId = randomUUID();
    database.prepare('INSERT INTO reference_set VALUES (?,?,?)').run(setId, messageId, ordinal);
    const insert = database.prepare('INSERT INTO reference_item VALUES (?,?,?)');
    recipeIds.forEach((id, index) => insert.run(setId, index, id));
    return setId;
  }
  let closed = false;
  return {
    database,
    services,
    events,
    readSql,
    readTransactions,
    addMessage,
    addReferences,
    failPage: (page: number) => {
      failPage = page;
    },
    read: () => services.queries.readConversationExport!(),
    async closeStore() {
      if (!closed) {
        closed = true;
        await services.close();
      }
    },
    async close() {
      await this.closeStore();
      await removeFixtureDirectory(directory);
    },
  };
}

test('facade exports all persisted display pages in one immutable read snapshot without binding or mutating', async () => {
  const f = await fixture();
  try {
    const first = f.addMessage(0, { role: 'user', text: 'Keep my exact words\nAnd this line.' });
    for (let index = 1; index <= 55; index++) f.addMessage(index);
    f.addReferences(first, 0, ['52839', '52835']);
    f.addReferences(first, 1, ['52819']);
    f.addMessage(0, { generation: 1, text: 'OTHER-GENERATION' });
    f.database
      .prepare('UPDATE conversation SET composer_draft=?')
      .run(JSON.stringify('UNSENT-SECRET'));
    f.database
      .prepare('INSERT INTO app_metadata VALUES (?,?)')
      .run('synthetic-export-private', 'KEY-PROMPT-CONSENT-ACTION');
    const beforeChanges = f.database.prepare('SELECT total_changes() AS count').get()!.count;
    const result = await f.read();
    const value = ready(result);
    assert.equal(value.counts.messages, 56);
    assert.deepEqual(
      value.messages.map((row) => row.sequence),
      Array.from({ length: 56 }, (_, index) => index),
    );
    assert.deepEqual(
      value.messages[0]!.referenceSets.map((set) => set.recipeIds),
      [['52839', '52835'], ['52819']],
    );
    assert.equal(value.counts.recipeReferences, 3);
    const serialized = JSON.stringify(value);
    for (const excluded of ['UNSENT-SECRET', 'OTHER-GENERATION', 'KEY-PROMPT-CONSENT-ACTION'])
      assert.ok(!serialized.includes(excluded));
    assert.deepEqual(f.readTransactions, ['BEGIN', 'COMMIT']);
    assert.equal(f.database.prepare('SELECT total_changes() AS count').get()!.count, beforeChanges);
    assert.deepEqual(f.events, []);
    assert.ok(Object.isFrozen(value.messages[0]!.referenceSets[0]!.recipeIds));
    assert.ok(
      !f.readSql.some((sql) =>
        /assistant_intent_context|pending_intent|operation_receipt/.test(sql),
      ),
    );
    assert.ok(formatConversationExportText(value).includes('Keep my exact words\nAnd this line.'));
  } finally {
    await f.close();
  }
});

test('empty export is explicit, separate workspaces remain isolated, and closed facade rejects reads', async () => {
  const left = await fixture();
  const right = await fixture();
  try {
    assert.equal(ready(await left.read()).counts.messages, 0);
    left.addMessage(0, { text: 'LEFT-WORKSPACE' });
    right.addMessage(0, { text: 'RIGHT-WORKSPACE' });
    assert.deepEqual(
      ready(await left.read()).messages.map((item) => item.text),
      ['LEFT-WORKSPACE'],
    );
    assert.deepEqual(
      ready(await right.read()).messages.map((item) => item.text),
      ['RIGHT-WORKSPACE'],
    );
    await left.closeStore();
    const closed = await left.read();
    assert.equal(closed.kind, 'failed');
    if (closed.kind === 'failed') assert.equal(closed.error.messageKey, 'storage.closed');
  } finally {
    await left.close();
    await right.close();
  }
});

test('1001 persisted messages fail before message paging and expose no truncated export', async () => {
  const f = await fixture();
  try {
    f.database.exec('BEGIN');
    for (let index = 0; index < 1001; index++) f.addMessage(index);
    f.database.exec('COMMIT');
    const result = await f.read();
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') {
      assert.equal(result.error.code, 'too_large');
      assert.equal(result.error.messageKey, 'conversation_export.message_limit');
    }
    assert.ok(!f.readSql.some((sql) => sql.includes('ORDER BY sequence')));
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()!.count, 1001);
  } finally {
    await f.close();
  }
});

test('multibyte persisted transcript over 2 MiB fails whole export and retains all rows', async () => {
  const f = await fixture();
  try {
    f.database.exec('BEGIN');
    for (let index = 0; index < 100; index++) f.addMessage(index, { text: '🍲'.repeat(6000) });
    f.database.exec('COMMIT');
    const result = await f.read();
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed')
      assert.equal(result.error.messageKey, 'conversation_export.byte_limit');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()!.count, 100);
  } finally {
    await f.close();
  }
});

test('failure after the first page returns no partial transcript and preserves conversation evidence', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 51; index++) f.addMessage(index);
    f.failPage(2);
    const result = await f.read();
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed')
      assert.equal(result.error.messageKey, 'conversation_export.read_failed');
    assert.deepEqual(f.readTransactions, ['BEGIN', 'ROLLBACK']);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()!.count, 51);
  } finally {
    await f.close();
  }
});

test('aggregate preflight rejects oversized stored reference sets, cardinality and IDs before display-row allocation', async () => {
  for (const fault of ['sets', 'items', 'recipe_id_bytes', 'set_id_bytes'] as const) {
    const f = await fixture();
    try {
      const messageId = f.addMessage(0);
      f.database.exec('BEGIN');
      if (fault === 'sets') {
        const insert = f.database.prepare('INSERT INTO reference_set VALUES (?,?,?)');
        for (let index = 0; index < 20000; index++) insert.run(randomUUID(), messageId, index);
      } else if (fault === 'items') {
        // Deliberately malformed retained evidence, well beyond the reader's 100-item limit.
        f.addReferences(messageId, 0, Array<string>(20000).fill('52835'));
      } else {
        f.addReferences(messageId, 0, ['52835']);
      }
      f.database.exec('COMMIT');
      if (fault === 'recipe_id_bytes' || fault === 'set_id_bytes') {
        f.database.exec('PRAGMA foreign_keys=OFF');
        f.database
          .prepare(
            fault === 'recipe_id_bytes'
              ? 'UPDATE reference_item SET recipe_id=?'
              : 'UPDATE reference_set SET reference_set_id=?',
          )
          .run('x'.repeat(CONVERSATION_EXPORT_MAX_BYTES + 1));
        f.database.exec('PRAGMA foreign_keys=ON');
      }
      const before = f.database.prepare('SELECT total_changes() AS count').get()!.count;
      const result = await f.read();
      assert.equal(result.kind, 'failed', fault);
      if (result.kind === 'failed')
        assert.equal(
          result.error.messageKey,
          fault === 'sets' || fault === 'items'
            ? 'conversation_export.invalid_record'
            : 'conversation_export.byte_limit',
        );
      assert.ok(!f.readSql.some((sql) => sql.includes('ORDER BY sequence')));
      assert.ok(
        !f.readSql.some(
          (sql) =>
            sql.includes('SELECT reference_set_id AS id') ||
            sql.includes('SELECT position, recipe_id'),
        ),
      );
      assert.equal(f.database.prepare('SELECT total_changes() AS count').get()!.count, before);
    } finally {
      await f.close();
    }
  }
});

test('invalid message or unknown stored recipe reference blocks export without repairing or dropping evidence', async () => {
  for (const fault of ['message', 'reference', 'sequence'] as const) {
    const f = await fixture();
    try {
      const id = f.addMessage(0, { createdAt: fault === 'message' ? 'invalid-time' : timestamp });
      const set = f.addReferences(id, 0, ['52835']);
      if (fault === 'reference') {
        f.database.exec('PRAGMA foreign_keys=OFF');
        f.database
          .prepare('UPDATE reference_item SET recipe_id=? WHERE reference_set_id=?')
          .run('unknown-recipe', set);
        f.database.exec('PRAGMA foreign_keys=ON');
      }
      if (fault === 'sequence') f.database.exec('UPDATE conversation SET next_sequence=0');
      const before = JSON.stringify({
        messages: f.database.prepare('SELECT * FROM message').all(),
        refs: f.database.prepare('SELECT * FROM reference_item').all(),
      });
      const result = await f.read();
      assert.equal(result.kind, 'failed', fault);
      if (result.kind === 'failed')
        assert.equal(result.error.messageKey, 'conversation_export.read_failed');
      assert.equal(
        JSON.stringify({
          messages: f.database.prepare('SELECT * FROM message').all(),
          refs: f.database.prepare('SELECT * FROM reference_item').all(),
        }),
        before,
      );
    } finally {
      await f.close();
    }
  }
});
