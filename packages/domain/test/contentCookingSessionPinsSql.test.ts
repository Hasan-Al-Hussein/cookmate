import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  createRecipeContentRevision,
  type RecipeContentRevision,
} from '@cookmate/catalogue/content';
import { cookingContentIdentity, type CookingSession } from '../src';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import {
  readStoredCookingSession,
  retainCookingRevisionInSnapshot,
  verifyCookingPinBindings,
} from '../../../apps/mobile/src/data/cookingContentRepository';
import { COOKING_CONTENT_LIMITS } from '../../../apps/mobile/src/data/cookingContentSchema';
import type { ContentCookingSession } from '../../../apps/mobile/src/data/contentCookingRecords';
import {
  configureConnection,
  SerializedWriter,
  StorageFault,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// These are explicitly seeded local persistence fixtures. They do not establish publication
// signatures, content adoption, host command authority or mounted-reader acceptance.
const at = '2026-10-01T12:00:00.000Z';
const requestFingerprint = 'a'.repeat(64);
type Store = ReturnType<typeof desktopConnection> & { writer: SerializedWriter };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-session-pins-'));
  const path = join(directory, 'cooking.db');
  const writers: SerializedWriter[] = [];
  const open = async (): Promise<Store> => {
    const handle = desktopConnection(path);
    await configureConnection(handle.connection);
    const writer = new SerializedWriter(handle.connection);
    writers.push(writer);
    return { ...handle, writer };
  };
  const store = await open();
  t.after(async () => {
    for (const writer of writers) await writer.close();
    await removeFixtureDirectory(directory);
  });
  await initializeDatabase(
    store.writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId: randomUUID(), shoppingScopeId: randomUUID(), conversationId: randomUUID() },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  return { ...store, open };
}

function insertSession(store: Store, value: CookingSession | ContentCookingSession) {
  const json = JSON.stringify(value, null, 2);
  store.database
    .prepare('INSERT INTO cooking_session VALUES (?,?,?,?,?,?,?,?)')
    .run(
      value.recipeId,
      value.sessionId,
      value.revision,
      value.state,
      value.updatedAt,
      value.lastOperationId,
      requestFingerprint,
      json,
    );
  return json;
}

async function authored(t: TestContext) {
  const store = await fixture(t);
  await migrateCookingContentDatabase(store.writer, { sha256 });
  const revision = await createRecipeContentRevision(
    authoredFixture(),
    'fixture-session-v1',
    sha256,
  );
  await store.writer.transaction((session) =>
    retainCookingRevisionInSnapshot(session, revision, sha256),
  );
  const value: ContentCookingSession = {
    readerVersion: 2,
    recipeId: revision.ref.recipeId,
    contentRef: { ...revision.ref },
    sessionId: randomUUID(),
    revision: 3,
    passageSequence: 2,
    state: 'active',
    updatedAt: at,
    lastOperationId: randomUUID(),
  };
  const json = insertSession(store, value);
  store.database
    .prepare('INSERT INTO cooking_session_content_pin VALUES (?,?,?,?,NULL)')
    .run(value.sessionId, value.recipeId, revision.ref.revisionId, revision.ref.contentFingerprint);
  return { ...store, value, revision, json };
}

function retainedDigest(store: Store) {
  const digest = createHash('sha256');
  for (const table of [
    'cooking_session',
    'cooking_session_content_pin',
    'recipe_content_revision',
    'recipe_content_source',
    'cooking_state',
    'state_revision',
  ] as const) {
    digest.update(table);
    digest.update(
      JSON.stringify(store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    );
  }
  return digest.digest('hex');
}

async function rejectsUnchanged(store: Awaited<ReturnType<typeof authored>>, corrupt: () => void) {
  // Savepoint restores only this disposable corrupt fixture after both production readers run.
  store.database.exec(
    'PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; SAVEPOINT corrupt_fixture',
  );
  try {
    corrupt();
    const before = retainedDigest(store);
    await assert.rejects(
      readStoredCookingSession(store.connection, store.value.recipeId, { sha256 }),
    );
    await assert.rejects(verifyCookingPinBindings(store.connection, sha256));
    assert.equal(
      retainedDigest(store),
      before,
      'read/reopen verification must not repair persisted corruption',
    );
  } finally {
    store.database.exec(
      'ROLLBACK TO corrupt_fixture; RELEASE corrupt_fixture; PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON',
    );
  }
}

test('version-one exact and unresolved sessions survive real migration/reopen with original bytes and meaning', async (t) => {
  const store = await fixture(t);
  const first = catalogue.recipes[0]!,
    second = catalogue.recipes[1]!;
  const values: CookingSession[] = [];
  for (const recipe of [first, second]) {
    const identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
    values.push({
      ...identity,
      ...(recipe === second ? { contentFingerprint: 'e'.repeat(64) } : {}),
      sessionId: randomUUID(),
      revision: 1,
      passageSequence: 1,
      state: 'active',
      updatedAt: at,
      lastOperationId: randomUUID(),
    });
  }
  const originals = values.map((value) => insertSession(store, value));
  assert.equal(await migrateCookingContentDatabase(store.writer, { sha256 }), 'migrated');
  await store.writer.close();
  const reopened = await store.open();
  assert.equal(await migrateCookingContentDatabase(reopened.writer, { sha256 }), 'existing');
  for (const [index, value] of values.entries()) {
    const result = await reopened.writer.transaction((session) =>
      readStoredCookingSession(session, value.recipeId, { sha256 }),
    );
    assert.deepEqual(result?.session, value);
    assert.deepEqual(
      result?.pin,
      index === 0
        ? { kind: 'exact', ref: (await createBundledRecipeRevision(value.recipeId, sha256)).ref }
        : { kind: 'unresolved', reason: 'content_mismatch' },
    );
    assert.equal(
      (
        reopened.database
          .prepare('SELECT session_json FROM cooking_session WHERE recipe_id=?')
          .get(value.recipeId) as { session_json: string }
      ).session_json,
      originals[index],
    );
    assert.equal(result?.session.readerVersion, 1);
  }
});

test('authored version-two lifecycle records reopen at their exact original passage without workbook fabrication', async (t) => {
  const store = await authored(t);
  for (const state of ['active', 'dismissed', 'completed'] as const) {
    const value = { ...store.value, state };
    store.database
      .prepare('UPDATE cooking_session SET state=?,session_json=?')
      .run(state, JSON.stringify(value, null, 2));
    const result = await store.writer.transaction((session) =>
      readStoredCookingSession(session, value.recipeId, { sha256 }),
    );
    assert.deepEqual(result, { session: value, pin: { kind: 'exact', ref: store.revision.ref } });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result!.session));
    assert.ok(Object.isFrozen(result!.pin));
    assert.equal(result!.session.readerVersion, 2);
    if (result!.session.readerVersion === 2) assert.ok(Object.isFrozen(result!.session.contentRef));
  }
  for (const table of ['recipe', 'ingredient_entry', 'instruction_passage'])
    assert.equal(
      store.database.prepare(`SELECT 1 FROM ${table} WHERE recipe_id=?`).get(store.value.recipeId),
      undefined,
    );
  const before = retainedDigest(store);
  await store.writer.close();
  const reopened = await store.open();
  assert.equal(await migrateCookingContentDatabase(reopened.writer, { sha256 }), 'existing');
  assert.equal(retainedDigest(reopened), before);
  assert.equal(await readStoredCookingSession(reopened.connection, '999999', { sha256 }), null);
});

test('a newer retained revision never substitutes for the saved exact session revision', async (t) => {
  const store = await authored(t);
  const changed = authoredFixture();
  changed.recipe.instructions[1]!.rawText = 'A different preparation at the same sequence.';
  const newer = await createRecipeContentRevision(changed, 'fixture-session-v2', sha256);
  await store.writer.transaction((session) =>
    retainCookingRevisionInSnapshot(session, newer, sha256),
  );
  const result = await readStoredCookingSession(store.connection, store.value.recipeId, { sha256 });
  assert.deepEqual(result, {
    session: store.value,
    pin: { kind: 'exact', ref: store.revision.ref },
  });
  await rejectsUnchanged(store, () =>
    store.database
      .prepare('UPDATE cooking_session SET session_json=?')
      .run(JSON.stringify({ ...store.value, contentRef: newer.ref })),
  );
});

test('session references and original passage sequences must match the retained pinned document', async (t) => {
  const store = await authored(t);
  for (const change of [
    { contentRef: { ...store.revision.ref, contentFingerprint: 'f'.repeat(64) } },
    { contentRef: { ...store.revision.ref, revisionId: 'missing-revision' } },
    { contentRef: { ...store.revision.ref, recipeId: '90002' } },
    { passageSequence: 0 },
    { passageSequence: 3 },
    { readerVersion: 1 },
  ])
    await rejectsUnchanged(store, () =>
      store.database
        .prepare('UPDATE cooking_session SET session_json=?')
        .run(JSON.stringify({ ...store.value, ...change })),
    );
  // Heading sequence 1 is an original passage too; no heuristic section renumbering.
  store.database
    .prepare('UPDATE cooking_session SET session_json=?')
    .run(JSON.stringify({ ...store.value, passageSequence: 1 }));
  assert.equal(
    (await readStoredCookingSession(store.connection, store.value.recipeId, { sha256 }))!.session
      .passageSequence,
    1,
  );
});

test('parent scalar mismatches are rejected without rewriting session or pin evidence', async (t) => {
  const store = await authored(t);
  for (const [column, value] of [
    ['session_id', randomUUID()],
    ['revision', 4],
    ['state', 'dismissed'],
    ['updated_at', '2026-10-01T12:00:01.000Z'],
    ['operation_id', randomUUID()],
    ['request_fingerprint', 'not-a-hash'],
  ] as const)
    await rejectsUnchanged(store, () =>
      store.database.prepare(`UPDATE cooking_session SET ${column}=?`).run(value),
    );
});

test('version-two records cannot use absent, foreign-parent or unresolved legacy pins', async (t) => {
  const store = await authored(t);
  for (const mutate of [
    () => store.database.exec('DELETE FROM cooking_session_content_pin'),
    () =>
      store.database
        .prepare('UPDATE cooking_session_content_pin SET session_id=?')
        .run(randomUUID()),
    () =>
      store.database
        .prepare('UPDATE cooking_session_content_pin SET recipe_id=?')
        .run(catalogue.recipes[0]!.recipeId),
    () =>
      store.database.exec(
        "UPDATE cooking_session_content_pin SET revision_id=NULL,content_fingerprint=NULL,unresolved_reason='content_mismatch'",
      ),
  ])
    await rejectsUnchanged(store, mutate);
});

test('retained revision presence and its stored kind agree with the exact session document', async (t) => {
  const store = await authored(t);
  await rejectsUnchanged(store, () =>
    store.database
      .prepare('DELETE FROM recipe_content_revision WHERE recipe_id=?')
      .run(store.value.recipeId),
  );
  await rejectsUnchanged(store, () =>
    store.database
      .prepare("UPDATE recipe_content_revision SET kind='imported' WHERE recipe_id=?")
      .run(store.value.recipeId),
  );
});

test('retained authored body tampering fails actual reopen and leaves the corrupt stored bytes untouched', async (t) => {
  const store = await authored(t);
  const changed: RecipeContentRevision = JSON.parse(canonicalContentJson(store.revision));
  changed.document.recipe.instructions[1]!.rawText = 'Changed bytes with the old fingerprint.';
  store.database
    .prepare('UPDATE recipe_content_revision SET revision_json=? WHERE recipe_id=?')
    .run(canonicalContentJson(changed), store.value.recipeId);
  const before = retainedDigest(store);
  await assert.rejects(
    readStoredCookingSession(store.connection, store.value.recipeId, { sha256 }),
  );
  await store.writer.close();
  const reopened = await store.open();
  await assert.rejects(migrateCookingContentDatabase(reopened.writer, { sha256 }));
  assert.equal(retainedDigest(reopened), before);
});

test('oversized session, pin scalars and retained revisions are refused before raw materialization', async (t) => {
  const store = await authored(t);
  const originalAll = store.connection.all;
  let largest = 0;
  store.connection.all = async <Row extends object>(
    sql: string,
    values: readonly SqlValue[] = [],
  ) => {
    const rows = await originalAll<Row>(sql, values);
    for (const row of rows)
      for (const value of Object.values(row))
        if (typeof value === 'string') largest = Math.max(largest, Buffer.byteLength(value));
    return rows;
  };
  t.after(() => {
    store.connection.all = originalAll;
  });
  for (const [maximum, corrupt] of [
    [
      8192,
      () =>
        store.database
          .prepare('UPDATE cooking_session SET session_json=?')
          .run(JSON.stringify({ ...store.value, extra: 'x'.repeat(8193) })),
    ],
    [
      8192,
      () =>
        store.database.prepare('UPDATE cooking_session SET operation_id=?').run('x'.repeat(16384)),
    ],
    [
      8192,
      () =>
        store.database
          .prepare('UPDATE cooking_session_content_pin SET revision_id=?')
          .run('x'.repeat(16384)),
    ],
    [
      COOKING_CONTENT_LIMITS.revisionBytes,
      () =>
        store.database
          .prepare('UPDATE recipe_content_revision SET revision_json=? WHERE recipe_id=?')
          .run('x'.repeat(COOKING_CONTENT_LIMITS.revisionBytes + 1), store.value.recipeId),
    ],
    [
      8192,
      () =>
        store.database
          .prepare('UPDATE recipe_content_revision SET content_fingerprint=? WHERE recipe_id=?')
          .run('f'.repeat(16384), store.value.recipeId),
    ],
  ] as const) {
    largest = 0;
    await rejectsUnchanged(store, corrupt);
    assert.ok(
      largest <= maximum,
      `oversized raw value escaped SQL admission: ${largest} > ${maximum}`,
    );
  }
});

for (const limit of ['count', 'aggregate bytes'] as const) {
  test(`retained archive ${limit} overflow is rejected before any document read or hash`, async (t) => {
    const store = await authored(t);
    const paddedBytes = 1024 * 1024;
    const rows =
      limit === 'count'
        ? COOKING_CONTENT_LIMITS.revisions + 1
        : Math.floor(COOKING_CONTENT_LIMITS.archiveBytes / paddedBytes) + 1;
    // SQLite constructs this deliberately corrupt archive. No large fixture body is created,
    // copied, returned or retained in JavaScript; each padded row stays below the per-row cap.
    store.database.exec('PRAGMA ignore_check_constraints=ON');
    store.database
      .prepare(
        `WITH RECURSIVE fixture(n) AS (
      SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<?
    ) INSERT INTO recipe_content_revision
      SELECT ?, 'budget-fixture-'||n, ?, 'authored',
      ${limit === 'count' ? "'{}'" : "json_object('padding',printf('%0*d',?,0))"}
      FROM fixture`,
      )
      .run(
        rows,
        store.value.recipeId,
        requestFingerprint,
        ...(limit === 'count' ? [] : [paddedBytes]),
      );
    store.database.exec('PRAGMA ignore_check_constraints=OFF');
    const usage = () =>
      store.database
        .prepare(
          `SELECT COUNT(*) count,
      SUM(length(CAST(revision_json AS BLOB))) bytes,
      MAX(length(CAST(revision_json AS BLOB))) largest,
      total_changes() changes FROM recipe_content_revision`,
        )
        .get() as {
        count: number;
        bytes: number;
        largest: number;
        changes: number;
      };
    const before = usage();
    assert.ok(before.largest <= COOKING_CONTENT_LIMITS.revisionBytes);
    if (limit === 'count') {
      assert.ok(before.count > COOKING_CONTENT_LIMITS.revisions);
      assert.ok(before.bytes < COOKING_CONTENT_LIMITS.archiveBytes);
    } else {
      assert.ok(before.bytes > COOKING_CONTENT_LIMITS.archiveBytes);
      assert.ok(before.count < COOKING_CONTENT_LIMITS.revisions);
    }
    let hashCalls = 0,
      documentReads = 0;
    const forbiddenHash = async () => {
      hashCalls++;
      throw new Error('Body hashing preceded archive admission');
    };
    const originalAll = store.connection.all;
    store.connection.all = async <Row extends object>(
      sql: string,
      values: readonly SqlValue[] = [],
    ) => {
      const result = await originalAll<Row>(sql, values);
      for (const row of result) if (Object.hasOwn(row, 'document')) documentReads++;
      return result;
    };
    try {
      const storageFailure = (error: unknown) =>
        error instanceof StorageFault && error.code === 'storage_failure';
      await assert.rejects(
        readStoredCookingSession(store.connection, store.value.recipeId, { sha256: forbiddenHash }),
        storageFailure,
      );
      await assert.rejects(
        verifyCookingPinBindings(store.connection, forbiddenHash),
        storageFailure,
      );
      assert.equal(hashCalls, 0);
      assert.equal(documentReads, 0);
      assert.deepEqual(usage(), before, 'archive denial must be read-only');
    } finally {
      store.connection.all = originalAll;
    }
  });
}
