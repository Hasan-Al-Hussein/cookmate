import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureConnection,
  SerializedWriter,
  StorageFault,
} from '../../../apps/mobile/src/data/sql';
import type { RecoveryImpact, SqlSession } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

test('writer captures impact before queuing and does not release work before acknowledged observer publication', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const writer = new SerializedWriter(fixture.connection);
  const events: string[] = [];
  const impacts: RecoveryImpact[] = [];
  let releasePublication!: () => void;
  const heldPublication = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  let publicationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    publicationStarted = resolve;
  });
  let escaped: SqlSession | undefined;
  let commits = 0;
  writer.setObserver({
    begin: async (_session, impact) => {
      impacts.push(impact);
      events.push('begin');
    },
    beforeCommit: async (session) => {
      await assert.rejects(escaped!.exec('CREATE TABLE escaped(value TEXT)'), /scope has ended/);
      await assert.rejects(
        session.exec('CREATE TABLE observer_write(value TEXT)'),
        /cannot mutate/,
      );
      events.push('validated');
    },
    committed: async (reader) => {
      assert.equal(
        (await reader.all<{ count: number }>('SELECT COUNT(*) AS count FROM retained'))[0]!.count,
        1,
      );
      events.push('acknowledged');
      if (++commits === 1) {
        publicationStarted();
        await heldPublication;
      }
      events.push('published');
    },
    failed: () => {
      events.push('failed');
    },
  });
  try {
    const ids = ['owned-id'];
    const first = writer.transaction(
      async (session) => {
        escaped = session;
        events.push('work');
        await session.exec('CREATE TABLE retained(value TEXT)');
        const statement = await session.prepare('INSERT INTO retained VALUES (?)');
        await statement.run(['committed']);
      },
      { kind: 'intents', userIntentIds: ids },
    );
    ids[0] = 'caller-mutated-id';
    const second = writer.transaction(async (session) => {
      escaped = session;
      events.push('second');
    });
    await started;
    assert.deepEqual(impacts, [{ kind: 'intents', userIntentIds: ['owned-id'] }]);
    assert.deepEqual(events, ['begin', 'work', 'validated', 'acknowledged']);
    assert.deepEqual(fixture.statementCounts(), { prepared: 1, finalized: 1 });
    releasePublication();
    await Promise.all([first, second]);
    assert.deepEqual(impacts[1], { kind: 'all' });
    assert.equal(events.includes('failed'), false);
    assert.ok(events.indexOf('published') < events.indexOf('second'));
  } finally {
    releasePublication();
    await writer.close();
  }
});

test('lost commit acknowledgement invalidates observer and never publishes its staged proof', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  const exec = fixture.connection.exec;
  fixture.connection.exec = async (sql) => {
    await exec(sql);
    if (sql === 'COMMIT') throw new Error('lost commit acknowledgement');
  };
  const writer = new SerializedWriter(fixture.connection);
  let published = 0;
  let invalidated = 0;
  writer.setObserver({
    begin: async () => {},
    committed: async () => {
      published++;
    },
    failed: () => {
      invalidated++;
    },
  });
  try {
    await assert.rejects(
      writer.transaction(async (session) => {
        await session.exec('CREATE TABLE durable(value TEXT)');
      }),
      /lost commit acknowledgement/,
    );
    assert.equal(published, 0);
    assert.equal(invalidated, 1);
    assert.equal(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='durable'")
        .get()!.count,
      1,
    );
    await assert.rejects(
      writer.transaction(async () => assert.fail('damaged writer reused')),
      /requires recovery/,
    );
    assert.equal(published, 0);
  } finally {
    await writer.close();
  }
});

test('final admission follows pending SQL settlement and observer validation without submitting COMMIT on rejection', async () => {
  const fixture = desktopConnection();
  await configureConnection(fixture.connection);
  fixture.database.exec('CREATE TABLE admission(value TEXT)');
  const writer = new SerializedWriter(fixture.connection);
  const exec = fixture.connection.exec;
  const events: string[] = [];
  let current = true;
  const original = new Error('runtime changed');
  fixture.connection.exec = async (sql) => {
    if (sql.startsWith('INSERT INTO admission')) {
      await Promise.resolve();
      current = false;
      events.push('pending');
    }
    if (sql === 'COMMIT') events.push('commit');
    await exec(sql);
  };
  writer.setObserver({
    begin: async () => undefined,
    beforeCommit: async () => {
      await Promise.resolve();
      events.push('validated');
    },
    committed: async () => {
      events.push('published');
    },
    failed: () => {
      events.push('failed');
    },
  });
  try {
    await assert.rejects(
      writer.transaction(
        async (session) => {
          void session.exec("INSERT INTO admission VALUES ('tentative')");
        },
        undefined,
        () => {
          events.push('admission');
          if (!current) throw original;
        },
      ),
      (error: unknown) => error === original,
    );
    assert.deepEqual(events, ['pending', 'validated', 'admission', 'failed']);
    assert.equal(fixture.database.prepare('SELECT count(*) AS n FROM admission').get()?.n, 0);
    assert.equal(await writer.transaction(async () => 'reusable'), 'reusable');
  } finally {
    await writer.close();
  }
});

test('only final admission errors become reconciliation uncertainty when rollback or observer cleanup fails', async () => {
  for (const admission of [false, true])
    for (const fault of ['rollback', 'observer'] as const) {
      const fixture = desktopConnection();
      await configureConnection(fixture.connection);
      const writer = new SerializedWriter(fixture.connection);
      const exec = fixture.connection.exec;
      const original = new Error('original rejection');
      fixture.connection.exec = async (sql) => {
        if (fault === 'rollback' && sql === 'ROLLBACK') throw new Error('rollback failure');
        await exec(sql);
      };
      writer.setObserver({
        begin: async () => undefined,
        committed: async () => assert.fail('must not publish'),
        failed: () => {
          if (fault === 'observer') throw new Error('observer cleanup failure');
        },
      });
      try {
        await assert.rejects(
          writer.transaction(
            async (session) => {
              await session.exec('CREATE TABLE tentative(value TEXT)');
              if (!admission) throw original;
            },
            undefined,
            admission
              ? () => {
                  throw original;
                }
              : undefined,
          ),
          (error: unknown) => {
            if (!admission) assert.equal(error, original);
            else {
              assert.ok(error instanceof StorageFault);
              assert.equal(error.code, 'storage_failure');
              assert.match(error.message, /requires reconciliation/);
            }
            return true;
          },
        );
        await assert.rejects(
          writer.transaction(async () => undefined),
          /requires recovery/,
        );
        if (fault === 'rollback') await exec('ROLLBACK');
        assert.equal(
          fixture.database
            .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='tentative'")
            .get()?.n,
          0,
        );
      } finally {
        await writer.close();
      }
    }
});
