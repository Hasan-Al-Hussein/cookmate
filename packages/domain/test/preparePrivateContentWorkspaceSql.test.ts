import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  configureConnection,
  SerializedWriter,
  type SqlConnection,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import {
  preparePrivateContentWorkspace,
  PrivateContentPreparationError,
  type PrivateContentPreparationOptions,
} from '../../../apps/mobile/src/features/content/preparePrivateContentWorkspace';
import { PrivateContentCleanupError } from '../../../apps/mobile/src/features/content/privateContentRuntime';
import {
  privateContentDatabaseNames,
  readPrivateContentConfiguration,
} from '../../../apps/mobile/src/features/content/privateContentConfig';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Real disposable SQLite migrations; public test keys are configuration fixtures only.
// This suite performs no release delivery, signature verification, browser mount or main DB access.
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const markerKey = 'private-content:preparation';
const at = '2026-10-01T12:00:00.000Z';
const rejected = (reason: PrivateContentPreparationError['reason']) => (error: unknown) =>
  error instanceof PrivateContentPreparationError && error.reason === reason;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-private-preparation-'));
  t.after(() => removeFixtureDirectory(directory));
  const config = readPrivateContentConfiguration(
    JSON.stringify({
      version: 1,
      origin: 'http://localhost:19093',
      installationId: randomUUID(),
      releaseId: 'private-test-release',
      trustKeys: [{ keyId: 'test', publicKeyHex: '1'.repeat(64) }],
    }),
    'http://localhost:19093',
  )!;
  const names = privateContentDatabaseNames(config.installationId);
  const file = join(directory, names.cooking);
  const opened: string[] = [];
  let live = 0;
  let wrap: (connection: SqlConnection) => SqlConnection = (connection) => connection;
  const options: PrivateContentPreparationOptions = {
    config,
    platform: { newId: randomUUID, sha256 },
    async openConnection(name) {
      assert.equal(name, names.cooking);
      assert.notEqual(name, names.content);
      assert.doesNotMatch(name, /^(cookmate|cookmate-guest|cookmate-account)\.db$/);
      opened.push(name);
      const storage = desktopConnection(file);
      live++;
      let closed = false;
      return wrap({
        ...storage.connection,
        async close() {
          if (!closed) {
            closed = true;
            await storage.connection.close();
            live--;
          }
        },
      });
    },
  };
  async function inspect<Value>(
    work: (db: ReturnType<typeof desktopConnection>['database']) => Value,
  ) {
    const storage = desktopConnection(file);
    try {
      return work(storage.database);
    } finally {
      await storage.connection.close();
    }
  }
  const databaseVersion = () =>
    inspect((db) => db.prepare('PRAGMA user_version').get()!.user_version);
  const dump = () =>
    inspect((db) => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      return JSON.stringify(
        tables.map(({ name }) => [
          name,
          db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all(),
        ]),
      );
    });
  return {
    options,
    names,
    file,
    opened,
    inspect,
    databaseVersion,
    dump,
    live: () => live,
    wrap: (value: typeof wrap) => {
      wrap = value;
    },
  };
}

async function interruptAfterCommit(f: Awaited<ReturnType<typeof fixture>>, commitNumber: number) {
  let commits = 0;
  f.wrap((connection) => ({
    ...connection,
    async exec(sql) {
      await connection.exec(sql);
      if (sql === 'COMMIT' && ++commits === commitNumber)
        throw new Error('injected acknowledgement loss');
    },
  }));
  await assert.rejects(preparePrivateContentWorkspace(f.options), /acknowledgement loss/);
  assert.equal(f.live(), 0);
  f.wrap((connection) => connection);
}

test('explicit preparation creates only reserved cooking8 and validates idempotently without rewriting later data', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await preparePrivateContentWorkspace(f.options), {
    kind: 'prepared',
    resumed: false,
  });
  assert.equal(await f.databaseVersion(), 8);
  await f.inspect((db) => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe').get()!.n, 100);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ingredient_entry').get()!.n, 960);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM instruction_passage').get()!.n, 706);
    const marker = JSON.parse(
      db.prepare('SELECT value FROM app_metadata WHERE key=?').get(markerKey)!.value as string,
    );
    assert.equal(marker.installationId, f.options.config.installationId);
    assert.equal(marker.databaseName, f.names.cooking);
    assert.equal(
      db.prepare("SELECT value FROM app_metadata WHERE key='installation_id'").get()!.value,
      marker.installationId,
    );
    db.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(
      catalogue.recipes[0]!.recipeId,
      at,
      at,
    );
    db.prepare(
      "INSERT INTO app_metadata VALUES ('test:receipt',' original durable bytes ') ",
    ).run();
  });
  const before = await f.dump();
  const result = await preparePrivateContentWorkspace({
    ...f.options,
    platform: {
      newId: () => {
        throw new Error('must reuse IDs');
      },
      sha256,
    },
  });
  assert.deepEqual(result, { kind: 'already_prepared', resumed: false });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(await f.dump(), before);
  assert.deepEqual(f.opened, [f.names.cooking, f.names.cooking]);
  assert.equal(f.live(), 0);
});

test('committed preparation marker resumes only its own interrupted6 and7 without changing its IDs or saved values', async (t) => {
  for (const [commit, schema] of [
    [2, 6],
    [3, 7],
  ] as const) {
    const f = await fixture(t);
    await interruptAfterCommit(f, commit);
    assert.equal(await f.databaseVersion(), schema);
    const marker = await f.inspect((db) => {
      db.prepare('INSERT INTO favourite VALUES (?,1,3,?,?)').run(
        catalogue.recipes[1]!.recipeId,
        at,
        at,
      );
      return db.prepare('SELECT value FROM app_metadata WHERE key=?').get(markerKey)!.value;
    });
    assert.deepEqual(
      await preparePrivateContentWorkspace({
        ...f.options,
        platform: {
          newId: () => {
            throw new Error('must not allocate new IDs');
          },
          sha256,
        },
      }),
      { kind: 'prepared', resumed: true },
    );
    assert.equal(await f.databaseVersion(), 8);
    await f.inspect((db) => {
      assert.equal(
        db.prepare('SELECT value FROM app_metadata WHERE key=?').get(markerKey)!.value,
        marker,
      );
      assert.equal(db.prepare('SELECT revision FROM favourite').get()!.revision, 3);
    });
    assert.equal(f.live(), 0);
  }
});

test('failure inserting the initial identity rolls back seed and schema together; fresh retry remains possible', async (t) => {
  const f = await fixture(t);
  f.wrap((connection) => ({
    ...connection,
    async prepare(sql) {
      const statement = await connection.prepare(sql);
      return {
        ...statement,
        async run(values) {
          if (values[0] === markerKey) throw new Error('injected preparation identity failure');
          await statement.run(values);
        },
      };
    },
  }));
  await assert.rejects(preparePrivateContentWorkspace(f.options), /identity failure/);
  assert.equal(await f.databaseVersion(), 0);
  await f.inspect((db) =>
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(),
      [],
    ),
  );
  assert.equal(f.live(), 0);
  f.wrap((connection) => connection);
  assert.equal((await preparePrivateContentWorkspace(f.options)).kind, 'prepared');
});

test('unmarked ordinary6,7,8 are rejected without mutation even if a connection provider substitutes their handle', async (t) => {
  const f = await fixture(t);
  const storage = desktopConnection(f.file);
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
  try {
    await initializeDatabase(
      writer,
      {
        identity: catalogue.identity,
        recipes: catalogue.recipes,
        recipeSources: catalogueProvenance.recipeSources,
      },
      {
        installationId: f.options.config.installationId,
        shoppingScopeId: randomUUID(),
        conversationId: randomUUID(),
      },
      {
        enablePortableRestore: true,
        enableCooking: true,
        enablePersonal: true,
        enableAccountHistory: true,
      },
    );
    for (const schema of [6, 7, 8]) {
      if (schema === 7) await migrateCookingContentDatabase(writer, { sha256 });
      if (schema === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
      const before = await f.dump();
      await assert.rejects(
        preparePrivateContentWorkspace(f.options),
        rejected('unowned_workspace'),
      );
      assert.equal(await f.databaseVersion(), schema);
      assert.equal(await f.dump(), before);
    }
  } finally {
    await writer.close();
  }
  assert.equal(f.live(), 0);
});

test('schema0 with any user object is not fresh; unsupported schemas and invalid IDs are refused', async (t) => {
  const f = await fixture(t);
  await f.inspect((db) => db.exec('CREATE VIEW existing_user_view AS SELECT 1'));
  await assert.rejects(preparePrivateContentWorkspace(f.options), rejected('unowned_workspace'));
  await f.inspect((db) => {
    db.exec('DROP VIEW existing_user_view');
    db.exec('PRAGMA user_version=5');
  });
  await assert.rejects(preparePrivateContentWorkspace(f.options), rejected('unsupported_schema'));
  await f.inspect((db) => db.exec('PRAGMA user_version=0'));
  await assert.rejects(
    preparePrivateContentWorkspace({
      ...f.options,
      platform: { sha256, newId: () => f.options.config.installationId },
    }),
    rejected('invalid_ids'),
  );
  assert.equal(await f.databaseVersion(), 0);
  assert.equal(f.live(), 0);
});

test('wrong marker origin, nested extras, installation mismatch and oversized marker are rejected before raw marker allocation', async (t) => {
  const f = await fixture(t);
  await interruptAfterCommit(f, 2);
  const original = await f.inspect(
    (db) =>
      db.prepare('SELECT value FROM app_metadata WHERE key=?').get(markerKey)!.value as string,
  );
  const record = JSON.parse(original);
  const variants = [
    canonicalContentJson({ ...record, origin: 'https://different.example' }),
    canonicalContentJson({
      ...record,
      catalogue: { ...record.catalogue, extra: 'not an identity' },
    }),
    canonicalContentJson({ ...record, installationId: randomUUID() }),
    original + '\u0000' + 'x'.repeat(1024 * 1024),
  ];
  let oversizedMaterialized = false;
  f.wrap((connection) => ({
    ...connection,
    async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
      const rows = await connection.all<Row>(sql, values);
      for (const row of rows)
        for (const value of Object.values(row))
          if (typeof value === 'string' && value.length > 2048) oversizedMaterialized = true;
      return rows;
    },
  }));
  for (const value of variants) {
    await f.inspect((db) =>
      db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(value, markerKey),
    );
    await assert.rejects(preparePrivateContentWorkspace(f.options), rejected('invalid_marker'));
    assert.equal(await f.databaseVersion(), 6);
  }
  assert.equal(oversizedMaterialized, false);
  await f.inspect((db) => {
    db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(original, markerKey);
    db.prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'").run(randomUUID());
  });
  await assert.rejects(preparePrivateContentWorkspace(f.options), rejected('invalid_marker'));
  assert.equal(f.live(), 0);
});

test('account binding or account residue prevents migration of marked6 without inspecting account payloads', async (t) => {
  const f = await fixture(t);
  await interruptAfterCommit(f, 2);
  await f.inspect((db) =>
    db
      .prepare('INSERT INTO app_metadata VALUES (?,?)')
      .run(
        'account-replication:owner',
        JSON.stringify({ schemaVersion: 1, ownerId: randomUUID() }),
      ),
  );
  const before = await f.dump();
  await assert.rejects(preparePrivateContentWorkspace(f.options), rejected('account_workspace'));
  assert.equal(await f.dump(), before);
  await f.inspect((db) => {
    db.prepare("DELETE FROM app_metadata WHERE key='account-replication:owner'").run();
    db.prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)').run(
      randomUUID(),
      randomUUID(),
    );
  });
  await assert.rejects(preparePrivateContentWorkspace(f.options), rejected('account_workspace'));
  assert.equal(await f.databaseVersion(), 6);
  assert.equal(f.live(), 0);
});

test('prepared8 revalidation rejects schema and original-source corruption without repair or writes', async (t) => {
  const f = await fixture(t);
  await preparePrivateContentWorkspace(f.options);
  await f.inspect((db) => db.exec('CREATE TABLE unexpected(value TEXT)'));
  const malformed = await f.dump();
  await assert.rejects(preparePrivateContentWorkspace(f.options));
  assert.equal(await f.dump(), malformed);
  await f.inspect((db) => {
    db.exec('DROP TABLE unexpected');
    db.prepare('UPDATE recipe SET title=? WHERE recipe_id=?').run(
      'changed original source',
      catalogue.recipes[0]!.recipeId,
    );
  });
  const corrupted = await f.dump();
  await assert.rejects(preparePrivateContentWorkspace(f.options));
  assert.equal(await f.dump(), corrupted);
  assert.equal(f.live(), 0);
});

test('hash failure leaves a marked resumable6 and rejects invalid digest output', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    preparePrivateContentWorkspace({
      ...f.options,
      platform: { newId: randomUUID, sha256: async () => 'not-sha256' },
    }),
    /Invalid private preparation digest/,
  );
  assert.equal(await f.databaseVersion(), 6);
  assert.equal(f.live(), 0);
  assert.deepEqual(await preparePrivateContentWorkspace(f.options), {
    kind: 'prepared',
    resumed: true,
  });
});

test('overlapping preparations are refused while the original drains; caller option replacement cannot redirect it', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = f.options.openConnection;
  const options: PrivateContentPreparationOptions = {
    ...f.options,
    platform: { ...f.options.platform },
    openConnection: async (name) => {
      await gate;
      return open(name);
    },
  };
  const first = preparePrivateContentWorkspace(options);
  options.openConnection = async () => {
    throw new Error('replaced opener');
  };
  options.platform.newId = () => {
    throw new Error('replaced IDs');
  };
  options.platform.sha256 = async () => {
    throw new Error('replaced hash');
  };
  await assert.rejects(preparePrivateContentWorkspace(f.options), rejected('busy'));
  release();
  assert.equal((await first).kind, 'prepared');
  assert.equal(f.opened.length, 1);
  assert.equal(f.live(), 0);
});

test('configuration failures close acquired handles; uncertain close blocks subsequent preparation rather than claiming retry', async (t) => {
  const f = await fixture(t);
  f.wrap((connection) => ({
    ...connection,
    async exec(sql) {
      if (sql === 'PRAGMA foreign_keys = ON') throw new Error('injected configure failure');
      await connection.exec(sql);
    },
  }));
  await assert.rejects(preparePrivateContentWorkspace(f.options), /configure failure/);
  assert.equal(f.live(), 0);
  f.wrap((connection) => ({
    ...connection,
    async close() {
      await connection.close();
      throw new Error('injected uncertain close');
    },
  }));
  let failure: unknown;
  await assert.rejects(preparePrivateContentWorkspace(f.options), (error: unknown) => {
    failure = error;
    return error instanceof PrivateContentCleanupError;
  });
  const opens = f.opened.length;
  await assert.rejects(
    preparePrivateContentWorkspace(f.options),
    (error: unknown) => error === failure,
  );
  assert.equal(f.opened.length, opens);
  assert.equal(f.live(), 0);
  assert.equal(await f.databaseVersion(), 8);
});
