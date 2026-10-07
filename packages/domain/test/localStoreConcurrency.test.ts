import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { RepositoryResult } from '../src/index';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-concurrency-'));
  const connections: ReturnType<typeof desktopConnection>[] = [];
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let releaseRead!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let holdNextRead = false;
  let writeBegins = 0;
  const opened = await createLocalStore({
    platform: {
      newId: randomUUID,
      sha256: async (text) => createHash('sha256').update(text).digest('hex'),
    },
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => ({
      localDate: '2026-09-28',
      timeZone: 'Asia/Dubai',
      utcOffsetMinutes: 240,
    }),
    openConnection: async (mode) => {
      const item = desktopConnection(join(directory, 'store.db'));
      connections.push(item);
      const exec = item.connection.exec;
      item.connection.exec = async (sql) => {
        if (mode === 'write' && sql === 'BEGIN IMMEDIATE') writeBegins++;
        await exec(sql);
      };
      const all = item.connection.all;
      item.connection.all = async <Row extends object>(
        sql: string,
        values?: readonly SqlValue[],
      ): Promise<Row[]> => {
        const rows = await all<Row>(sql, values);
        // Hold after a real SELECT acquires the rollback-journal read snapshot.
        if (mode === 'read' && holdNextRead && /^SELECT\b/i.test(sql.trim())) {
          holdNextRead = false;
          signalEntered();
          await release;
        }
        return rows;
      };
      return item.connection;
    },
  });
  assert.equal(opened.kind, 'ready');
  if (opened.kind !== 'ready') assert.fail();
  const services = opened.services;
  return {
    services,
    connections,
    holdRead: () => {
      holdNextRead = true;
      return entered;
    },
    release: releaseRead,
    writeBegins: () => writeBegins,
    cleanup: async () => {
      releaseRead();
      await services.close();
      await removeFixtureDirectory(directory);
    },
  };
}

test(
  'a real conversation snapshot does not make the recovery audit fail with a database lock',
  { timeout: 10_000 },
  async () => {
    const f = await fixture();
    try {
      const assistant = f.services.assistant({ connectionGeneration: () => 1 });
      const entered = f.holdRead();
      const conversation = assistant.readConversation({ limit: 1 });
      await entered;
      const before = f.writeBegins();
      const audit = assistant.refreshRecoveryGate();
      await setImmediate();
      const whileReading = f.writeBegins();
      f.release();
      const [snapshot, recovery] = await Promise.all([conversation, audit]);
      assert.equal(ready(snapshot).messages.length, 0);
      assert.equal(ready(recovery).kind, 'ready');
      assert.equal(whileReading, before, 'the writer waits for the owned read snapshot');
      assert.equal(
        f.connections[0]!.database.prepare('SELECT count(*) AS n FROM operation_receipt').get()?.n,
        0,
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'close drains a held commit and its queued read without exposing a partial snapshot',
  { timeout: 10_000 },
  async () => {
    const f = await fixture();
    let releaseCommit!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let signalCommit!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalCommit = resolve;
    });
    try {
      const review = ready(
        await f.services.commands.reviewDirect({
          kind: 'setFavourite',
          recipeId: '53064',
          saved: true,
        }),
      );
      const command = ready(await f.services.commands.prepareDirect(review));
      const connection = f.connections[0]!.connection;
      const exec = connection.exec;
      let holdOnce = true;
      connection.exec = async (sql) => {
        await exec(sql);
        if (sql === 'COMMIT' && holdOnce) {
          holdOnce = false;
          signalCommit();
          await held;
        }
      };
      const execution = f.services.commands.execute(command);
      await entered;
      let readFinished = false;
      const reading = f.services.queries.readFavourites().then((result) => {
        readFinished = true;
        return result;
      });
      await setImmediate();
      const readFinishedBeforeAcknowledgement = readFinished;
      const closing = f.services.close();
      assert.equal((await f.services.queries.readFavourites()).kind, 'failed');
      releaseCommit();
      const [result, snapshot] = await Promise.all([execution, reading, closing]);
      assert.equal(readFinishedBeforeAcknowledgement, false);
      assert.equal(result.kind, 'receipt', JSON.stringify(result));
      assert.deepEqual(
        ready(snapshot).map((item) => item.recipeId),
        ['53064'],
      );
      assert.equal(f.services.close(), closing);
    } finally {
      releaseCommit();
      await f.cleanup();
    }
  },
);

test(
  'a rolled-back reader failure leaves the shared store queue usable for a mutation',
  { timeout: 10_000 },
  async () => {
    const f = await fixture();
    try {
      const connection = f.connections[1]!.connection;
      const all = connection.all;
      let failOnce = true;
      connection.all = async <Row extends object>(
        sql: string,
        values?: readonly SqlValue[],
      ): Promise<Row[]> => {
        const rows = await all<Row>(sql, values);
        if (failOnce && /^SELECT\b/i.test(sql.trim())) {
          failOnce = false;
          throw new Error('Injected failure after real read snapshot');
        }
        return rows;
      };
      assert.equal((await f.services.queries.readFavourites()).kind, 'failed');
      const review = ready(
        await f.services.commands.reviewDirect({
          kind: 'setFavourite',
          recipeId: '53064',
          saved: true,
        }),
      );
      const command = ready(await f.services.commands.prepareDirect(review));
      assert.equal((await f.services.commands.execute(command)).kind, 'receipt');
      assert.deepEqual(
        ready(await f.services.queries.readFavourites()).map((item) => item.recipeId),
        ['53064'],
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'an ordinary confirmed mutation waits for its own reader and commits exactly once before close',
  { timeout: 10_000 },
  async () => {
    const f = await fixture();
    try {
      const review = ready(
        await f.services.commands.reviewDirect({
          kind: 'setFavourite',
          recipeId: '53064',
          saved: true,
        }),
      );
      const command = ready(await f.services.commands.prepareDirect(review));
      const entered = f.holdRead();
      const reading = f.services.queries.readFavourites();
      await entered;
      const before = f.writeBegins();
      const execution = f.services.commands.execute(command);
      await setImmediate();
      const whileReading = f.writeBegins();
      f.release();
      const [snapshot, result] = await Promise.all([reading, execution]);
      assert.deepEqual(ready(snapshot), []);
      assert.equal(result.kind, 'receipt', JSON.stringify(result));
      assert.equal(whileReading, before);
      assert.deepEqual(
        ready(await f.services.queries.readFavourites()).map((item) => item.recipeId),
        ['53064'],
      );
      assert.equal((await f.services.commands.execute(command)).kind, 'receipt');
      assert.equal(
        f.connections[0]!.database.prepare('SELECT count(*) AS n FROM operation_receipt').get()?.n,
        1,
      );
      assert.equal(f.connections[1]!.database.prepare('PRAGMA query_only').get()?.query_only, 1);
      assert.equal(
        f.connections[0]!.database.prepare('PRAGMA journal_mode').get()?.journal_mode,
        'delete',
      );
      const closing = f.services.close();
      assert.equal(f.services.close(), closing, 'close is idempotent');
      await closing;
      assert.equal((await f.services.queries.readFavourites()).kind, 'failed');
    } finally {
      await f.cleanup();
    }
  },
);
