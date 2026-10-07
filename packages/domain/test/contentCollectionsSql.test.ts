import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import type { OverlayHead } from '@cookmate/catalogue/content';
import type { PersonalCommand, RepositoryResult } from '../src';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  createContentCollections,
  type ContentCollectionCommand,
} from '../../../apps/mobile/src/data/contentCollections';
import { createContentManualShopping } from '../../../apps/mobile/src/data/contentManualShopping';
import { createContentPersonalNotes } from '../../../apps/mobile/src/data/contentPersonalNotes';
import { readPersonalState } from '../../../apps/mobile/src/data/personalRecords';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T20:00:00.000Z';
const authoredId = '910000001',
  unknownId = '999999999';
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function create(
  overrides: Partial<Extract<ContentCollectionCommand, { kind: 'createCollection' }>> = {},
): Extract<ContentCollectionCommand, { kind: 'createCollection' }> {
  return {
    kind: 'createCollection',
    operationId: randomUUID(),
    expectedEpoch: 0,
    collectionId: randomUUID(),
    name: 'Weeknight dinners',
    ...overrides,
  };
}
function member(
  collectionId: string,
  expectedCollectionRevision: number,
  overrides: Partial<Extract<ContentCollectionCommand, { kind: 'setCollectionMembership' }>> = {},
): Extract<ContentCollectionCommand, { kind: 'setCollectionMembership' }> {
  return {
    kind: 'setCollectionMembership',
    operationId: randomUUID(),
    expectedEpoch: 0,
    collectionId,
    expectedCollectionRevision,
    recipeId: authoredId,
    expectedRevision: null,
    present: true,
    ...overrides,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, version: 6 | 8 = 8) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-collections-'));
  const path = join(directory, 'cooking.db'),
    installationId = randomUUID();
  const seed = desktopConnection(path);
  await configureConnection(seed.connection);
  const initial = new SerializedWriter(seed.connection);
  await initializeDatabase(
    initial,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId, shoppingScopeId: randomUUID(), conversationId: randomUUID() },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  if (version === 8) {
    await migrateCookingContentDatabase(initial, { sha256 });
    await migrateAccountContentHistoryDatabase(initial, { sha256 });
  }
  await initial.close();
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 1 };
  let head: OverlayHead = {
    releaseId: 'collections-fixture',
    sequence: 1,
    fingerprint: 'a'.repeat(64),
  };
  let inventory: readonly string[] = [
    ...catalogue.recipes.map((recipe) => recipe.recipeId),
    authoredId,
  ];
  let inspectedHead: OverlayHead | undefined;
  let unavailable = false,
    loseCommit = false,
    failReceiptReads = false,
    failReceiptWrite = false;
  let hashPause:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  let inspectPause: typeof hashPause, readPause: typeof hashPause;
  let readDb!: ReturnType<typeof desktopConnection>, writeDb!: ReturnType<typeof desktopConnection>;
  let reader!: SerializedReader, writer!: SerializedWriter;
  let collections!: ReturnType<typeof createContentCollections>,
    notes!: ReturnType<typeof createContentPersonalNotes>,
    manual!: ReturnType<typeof createContentManualShopping>;
  let closed = true;
  const changes: unknown[] = [],
    oversizedTransfers: string[] = [],
    noteReads: string[] = [];
  let inspections = 0;
  function inspectRows<Row extends object>(sql: string, rows: Row[]): Row[] {
    if (/\brecipe_note\b/.test(sql)) noteReads.push(sql);
    if (
      rows.some((row) =>
        Object.values(row).some((value: unknown) =>
          typeof value === 'string'
            ? value.length > 65_536
            : value instanceof Uint8Array && value.byteLength > 65_536,
        ),
      )
    )
      oversizedTransfers.push(sql);
    return rows;
  }
  async function open() {
    readDb = desktopConnection(path);
    writeDb = desktopConnection(path);
    await configureConnection(readDb.connection);
    await configureConnection(writeDb.connection);
    const queue = new SqlTransactionQueue();
    reader = new SerializedReader(readDb.connection, queue);
    writer = new SerializedWriter(writeDb.connection, queue);
    const exec = writeDb.connection.exec;
    writeDb.connection.exec = async (sql) => {
      await exec(sql);
      if (loseCommit && sql === 'COMMIT') {
        loseCommit = false;
        throw new Error('Lost acknowledgement');
      }
    };
    const prepare = writeDb.connection.prepare;
    writeDb.connection.prepare = async (sql) => {
      if (failReceiptWrite && sql.startsWith('INSERT INTO personal_operation')) {
        failReceiptWrite = false;
        throw new Error('Receipt write failed');
      }
      return prepare(sql);
    };
    const readAll = readDb.connection.all;
    readDb.connection.all = async <Row extends object>(
      sql: string,
      values?: readonly SqlValue[],
    ) => {
      if (failReceiptReads && sql.includes('personal_operation'))
        throw new Error('Receipt unavailable');
      const rows = inspectRows(sql, await readAll<Row>(sql, values));
      if (readPause && sql.includes('FROM personal_collection WHERE deleted=0')) {
        const pause = readPause;
        readPause = undefined;
        pause.entered.resolve();
        await pause.release.promise;
      }
      return rows;
    };
    const writeAll = writeDb.connection.all;
    writeDb.connection.all = async <Row extends object>(
      sql: string,
      values?: readonly SqlValue[],
    ) => inspectRows(sql, await writeAll<Row>(sql, values));
    if (
      version === 8 &&
      writeDb.database.prepare('SELECT revision FROM app_content_adoption').get()!.revision === 0
    )
      writeDb.database
        .prepare('UPDATE app_content_adoption SET revision=1,head_json=?')
        .run(JSON.stringify(head));
    const options = {
      reader,
      writer,
      installationId,
      now: () => at,
      getAccess: () => access,
      assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
        assert.deepEqual(access, scope);
        return undefined;
      },
      onCommitted: (change: unknown) => changes.push(change),
      platform: {
        newId: randomUUID,
        async sha256(text: string) {
          if (hashPause) {
            const pause = hashPause;
            hashPause = undefined;
            pause.entered.resolve();
            await pause.release.promise;
          }
          return sha256(text);
        },
      },
    };
    const contentStore: Parameters<typeof createContentCollections>[0]['contentStore'] = {
      async withVerifiedReferenceInspection(expected, refs, work) {
        inspections++;
        if (unavailable) throw new Error('Content unavailable');
        assert.deepEqual(expected, head);
        assert.deepEqual(refs, []);
        if (inspectPause) {
          const pause = inspectPause;
          inspectPause = undefined;
          pause.entered.resolve();
          await pause.release.promise;
        }
        let active = true;
        try {
          return await work({
            head: inspectedHead ?? head,
            latestHead: head,
            entries: [],
            adoptedRecipeIds: inventory,
            assertActive() {
              assert.ok(active);
              return undefined;
            },
          });
        } finally {
          active = false;
        }
      },
    };
    collections = createContentCollections({ ...options, contentStore });
    notes = createContentPersonalNotes({ ...options, contentStore });
    manual = createContentManualShopping(options);
    closed = false;
  }
  async function close() {
    if (closed) return;
    closed = true;
    collections.close();
    notes.close();
    manual.close();
    await reader.close();
    await writer.close();
  }
  t.after(async () => {
    await close();
    await removeFixtureDirectory(directory);
  });
  await open();
  return {
    get collections() {
      return collections;
    },
    get notes() {
      return notes;
    },
    get manual() {
      return manual;
    },
    get database() {
      return writeDb.database;
    },
    get reader() {
      return reader;
    },
    get writer() {
      return writer;
    },
    get inspections() {
      return inspections;
    },
    changes,
    oversizedTransfers,
    noteReads,
    async reopen() {
      await close();
      await open();
    },
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    setInventory(value: readonly string[]) {
      inventory = value;
    },
    setInspectedHead(value: OverlayHead) {
      inspectedHead = value;
    },
    setUnavailable(value = true) {
      unavailable = value;
    },
    rollback() {
      head = { releaseId: 'collections-rollback', sequence: 2, fingerprint: 'b'.repeat(64) };
      inventory = catalogue.recipes.map((recipe) => recipe.recipeId);
      writeDb.database
        .prepare('UPDATE app_content_adoption SET revision=revision+1,head_json=?')
        .run(JSON.stringify(head));
    },
    loseCommit() {
      loseCommit = true;
    },
    failReads(value = true) {
      failReceiptReads = value;
    },
    failReceiptWrite() {
      failReceiptWrite = true;
    },
    pauseHash() {
      const pause = { entered: deferred(), release: deferred() };
      hashPause = pause;
      return pause;
    },
    pauseInspection() {
      const pause = { entered: deferred(), release: deferred() };
      inspectPause = pause;
      return pause;
    },
    pauseRead() {
      const pause = { entered: deferred(), release: deferred() };
      readPause = pause;
      return pause;
    },
  };
}

test('authored identity-only membership, Unicode collection, remove/re-add and exact delete survive reopen', async (t) => {
  const f = await fixture(t),
    command = create({ name: 'عشاء\u0000☕\ud800' });
  ready(await f.collections.execute(command));
  assert.equal(ready(await f.collections.readRecipeMemberships(authoredId)).memberships.length, 0);
  ready(await f.collections.execute(member(command.collectionId, 1)));
  assert.equal(
    f.database.prepare('SELECT COUNT(*) n FROM recipe_identity WHERE recipe_id=?').get(authoredId)!
      .n,
    1,
  );
  assert.equal(
    f.database
      .prepare('SELECT COUNT(*) n FROM recipe_content_revision WHERE recipe_id=?')
      .get(authoredId)!.n,
    0,
  );
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM plan_content_pin').get()!.n, 0);
  await f.reopen();
  const page = ready(await f.collections.readCollection(command.collectionId));
  assert.equal(page.collection.name, command.name);
  assert.equal(page.collection.memberCount, 1);
  assert.equal(page.items[0]!.recipeId, authoredId);
  ready(
    await f.collections.execute(
      member(command.collectionId, 2, { expectedRevision: 2, present: false }),
    ),
  );
  const removed = ready(await f.collections.readRecipeMemberships(authoredId)).memberships[0]!;
  assert.equal(removed.present, false);
  assert.equal(removed.revision, 3);
  ready(await f.collections.execute(member(command.collectionId, 3, { expectedRevision: 3 })));
  ready(
    await f.collections.execute({
      kind: 'renameCollection',
      operationId: randomUUID(),
      expectedEpoch: 0,
      collectionId: command.collectionId,
      expectedRevision: 4,
      name: 'Renamed',
    }),
  );
  const review = ready(await f.collections.reviewDeleteCollection(command.collectionId));
  assert.deepEqual(review.affectedRecipeIds, [authoredId]);
  assert.equal(review.name, 'Renamed');
  const op = randomUUID(),
    receipt = ready(await f.collections.deleteCollection(review, op));
  assert.equal(receipt.affectedMemberships, 1);
  assert.equal(ready(await f.collections.readCollections()).items.length, 0);
  assert.equal(ready(await f.collections.readRecipeMemberships(authoredId)).memberships.length, 0);
  assert.deepEqual(
    { ...f.database.prepare('SELECT name,deleted,revision FROM personal_collection').get() },
    { name: null, deleted: 1, revision: 6 },
  );
  assert.equal(
    f.database.prepare('SELECT present FROM personal_collection_member').get()!.present,
    0,
  );
  await f.reopen();
  assert.deepEqual(ready(await f.collections.deleteCollection(review, op)), receipt);
  assert.deepEqual(ready(await f.collections.readReceipt(op)), receipt);
  assert.equal((await f.notes.readReceipt(op)).kind, 'failed');
  assert.equal((await f.manual.resolveOperation(op)).kind, 'failed');
  assert.equal(
    (await f.collections.execute({ ...command, operationId: randomUUID() })).kind,
    'failed',
  );
  assert.deepEqual(f.noteReads, []);
});

test('retained memberships remain readable/removable/deletable after rollback or unavailable delivery', async (t) => {
  const f = await fixture(t),
    first = create(),
    second = create();
  ready(await f.collections.execute(first));
  ready(await f.collections.execute(member(first.collectionId, 1)));
  ready(await f.collections.execute(second));
  ready(await f.collections.execute(member(second.collectionId, 3)));
  f.rollback();
  f.setUnavailable();
  assert.equal(ready(await f.collections.readCollections()).items.length, 2);
  assert.equal(ready(await f.collections.readCollection(first.collectionId)).items.length, 1);
  assert.equal(ready(await f.collections.readRecipeMemberships(authoredId)).memberships.length, 2);
  ready(
    await f.collections.execute(
      member(first.collectionId, 2, { expectedRevision: 2, present: false }),
    ),
  );
  assert.equal(
    (await f.collections.execute(member(first.collectionId, 5, { expectedRevision: 5 }))).kind,
    'failed',
  );
  const review = ready(await f.collections.reviewDeleteCollection(second.collectionId));
  ready(await f.collections.deleteCollection(review, randomUUID()));
  assert.equal(
    ready(await f.collections.readRecipeMemberships(authoredId)).memberships[0]!.present,
    false,
  );
  assert.equal(ready(await f.collections.readCollections()).items.length, 1);
});

test('unknown/raw identity and mismatched inspection do not authorize fresh memberships', async (t) => {
  const f = await fixture(t),
    command = create();
  ready(await f.collections.execute(command));
  f.database.prepare('INSERT INTO recipe_identity VALUES (?)').run(unknownId);
  assert.equal((await f.collections.readRecipeMemberships(unknownId)).kind, 'failed');
  assert.equal(
    (await f.collections.execute(member(command.collectionId, 1, { recipeId: unknownId }))).kind,
    'failed',
  );
  f.setInspectedHead({ releaseId: 'other', sequence: 1, fingerprint: 'c'.repeat(64) });
  assert.equal((await f.collections.execute(member(command.collectionId, 1))).kind, 'failed');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_collection_member').get()!.n, 0);
});

test('pages, memberships, names and epoch use stale revision guards', async (t) => {
  const f = await fixture(t),
    command = create();
  ready(await f.collections.execute(command));
  ready(await f.collections.execute(member(command.collectionId, 1)));
  const second = catalogue.recipes[0]!.recipeId;
  ready(await f.collections.execute(member(command.collectionId, 2, { recipeId: second })));
  const page = ready(await f.collections.readCollection(command.collectionId, { limit: 1 }));
  assert.ok(page.nextCursor);
  assert.equal(
    ready(
      await f.collections.readCollection(command.collectionId, {
        cursor: page.nextCursor,
        limit: 1,
      }),
    ).items.length,
    1,
  );
  ready(
    await f.collections.execute({
      kind: 'renameCollection',
      operationId: randomUUID(),
      expectedEpoch: 0,
      collectionId: command.collectionId,
      expectedRevision: 3,
      name: 'Fresh name',
    }),
  );
  assert.equal(
    (await f.collections.readCollection(command.collectionId, { cursor: page.nextCursor })).kind,
    'failed',
  );
  assert.equal(
    (
      await f.collections.execute(
        member(command.collectionId, 3, { expectedRevision: 2, present: false }),
      )
    ).kind,
    'failed',
  );
  assert.equal(
    (
      await f.collections.execute(
        member(command.collectionId, 4, { expectedRevision: 3, present: false }),
      )
    ).kind,
    'failed',
  );
  f.database.exec('UPDATE personal_state SET epoch=1');
  assert.equal((await f.collections.execute(create())).kind, 'failed');
  assert.equal(
    (await f.collections.readCollection(command.collectionId, { limit: 51 })).kind,
    'failed',
  );
});

test('delete requires an issued exact review; changed members/name, epoch, adoption or restore invalidate it', async (t) => {
  for (const change of ['copied', 'name', 'members', 'epoch', 'adoption', 'restore'] as const)
    await t.test(change, async (t) => {
      const f = await fixture(t),
        command = create();
      ready(await f.collections.execute(command));
      const review = ready(await f.collections.reviewDeleteCollection(command.collectionId));
      if (change === 'name')
        ready(
          await f.collections.execute({
            kind: 'renameCollection',
            operationId: randomUUID(),
            expectedEpoch: 0,
            collectionId: command.collectionId,
            expectedRevision: 1,
            name: 'New name',
          }),
        );
      if (change === 'members') ready(await f.collections.execute(member(command.collectionId, 1)));
      if (change === 'epoch') f.database.exec('UPDATE personal_state SET epoch=1');
      if (change === 'adoption') f.rollback();
      if (change === 'restore')
        f.database
          .prepare('INSERT INTO app_metadata VALUES (?,?)')
          .run('account-replication:apply-epoch', '1');
      assert.equal(
        (
          await f.collections.deleteCollection(
            change === 'copied' ? { ...review } : review,
            randomUUID(),
          )
        ).kind,
        'failed',
      );
      assert.equal(ready(await f.collections.readCollections()).items.length, 1);
    });
});

test('lost ACK, exact replay and cancellation recover without content delivery or a new write', async (t) => {
  const f = await fixture(t),
    parent = create();
  ready(await f.collections.execute(parent));
  const command = member(parent.collectionId, 1);
  f.loseCommit();
  const receipt = ready(await f.collections.execute(command));
  await f.reopen();
  f.rollback();
  f.setUnavailable();
  assert.deepEqual(ready(await f.collections.execute(command)), receipt);
  assert.equal((await f.collections.execute({ ...command, present: false })).kind, 'failed');
  const cancelled = member(parent.collectionId, 2, { recipeId: unknownId });
  const fence = ready(await f.collections.resolveOperation(cancelled.operationId));
  assert.equal(fence.outcome, 'cancelled');
  assert.equal(fence.commandKind, null);
  assert.deepEqual(ready(await f.collections.execute(cancelled)), fence);
  const review = ready(await f.collections.reviewDeleteCollection(parent.collectionId)),
    op = randomUUID();
  f.loseCommit();
  const deleted = ready(await f.collections.deleteCollection(review, op));
  await f.reopen();
  assert.deepEqual(ready(await f.collections.deleteCollection(review, op)), deleted);
  assert.equal(
    (await f.collections.deleteCollection({ ...review, affectedRecipeIds: [] }, op)).kind,
    'failed',
  );
});

test('receipt failure rolls back membership identity; uncertain commit resolves after reopen', async (t) => {
  const f = await fixture(t),
    parent = create();
  ready(await f.collections.execute(parent));
  const command = member(parent.collectionId, 1);
  f.failReceiptWrite();
  assert.equal((await f.collections.execute(command)).kind, 'failed');
  assert.equal(
    f.database.prepare('SELECT COUNT(*) n FROM recipe_identity WHERE recipe_id=?').get(authoredId)!
      .n,
    0,
  );
  f.writer.setObserver({
    async begin() {},
    async beforeCommit() {
      f.failReads();
    },
    async committed() {},
    failed() {},
  });
  f.loseCommit();
  const result = await f.collections.execute(command);
  assert.equal(result.kind, 'uncertain');
  f.failReads(false);
  await f.reopen();
  assert.equal(
    ready(await f.collections.resolveOperation(command.operationId)).outcome,
    'committed',
  );
  assert.equal(ready(await f.collections.readCollection(parent.collectionId)).items.length, 1);
});

test('notes/manual receipts and commands never cross collection capabilities', async (t) => {
  const f = await fixture(t),
    command = create();
  const note: Extract<PersonalCommand, { kind: 'saveNote' }> = {
    kind: 'saveNote',
    operationId: randomUUID(),
    expectedEpoch: 0,
    noteId: randomUUID(),
    recipeId: authoredId,
    expectedRevision: null,
    text: 'Private text',
  };
  const manual: Extract<PersonalCommand, { kind: 'addManualItem' }> = {
    kind: 'addManualItem',
    operationId: randomUUID(),
    expectedEpoch: 0,
    itemId: randomUUID(),
    fields: { name: 'Filters', amountText: null, unitText: null, category: 'other' },
  };
  (
    await Promise.all([
      f.collections.execute(command),
      f.notes.execute(note),
      f.manual.execute(manual),
    ])
  ).forEach(ready);
  for (const result of [
    await f.collections.readReceipt(note.operationId),
    await f.collections.resolveOperation(note.operationId),
    await f.collections.execute({ ...command, operationId: note.operationId }),
    await f.collections.readReceipt(manual.operationId),
    await f.collections.resolveOperation(manual.operationId),
    await f.notes.readReceipt(command.operationId),
    await f.notes.resolveOperation(command.operationId),
    await f.manual.readReceipt(command.operationId),
    await f.manual.resolveOperation(command.operationId),
    await f.collections.execute(note as unknown as ContentCollectionCommand),
    await f.collections.execute(manual as unknown as ContentCollectionCommand),
  ]) {
    assert.equal(result.kind, 'failed');
    assert.equal('value' in result, false);
  }
  f.noteReads.length = 0;
  f.database.exec('PRAGMA ignore_check_constraints=ON');
  f.database.prepare('UPDATE recipe_note SET text=?').run('x'.repeat(1_048_576));
  f.database.exec('PRAGMA ignore_check_constraints=OFF');
  ready(await f.collections.readRecipeMemberships(authoredId));
  ready(await f.collections.readCollections());
  assert.deepEqual(f.noteReads, []);
  assert.deepEqual(f.oversizedTransfers, []);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 3);
});

test('close and owner retirement suppress in-flight private reads and commits', async (t) => {
  const f = await fixture(t),
    command = create();
  ready(await f.collections.execute(command));
  const readingPause = f.pauseRead(),
    reading = f.collections.readCollections();
  await readingPause.entered.promise;
  f.collections.close();
  readingPause.release.resolve();
  assert.equal((await reading).kind, 'failed');
  await f.reopen();
  const pause = f.pauseInspection(),
    saving = f.collections.execute(member(command.collectionId, 1));
  await pause.entered.promise;
  f.setAccess({ ownerId: null, authGeneration: 2 });
  pause.release.resolve();
  assert.equal((await saving).kind, 'failed');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_collection_member').get()!.n, 0);
  await f.reopen();
  f.writer.setObserver({
    async begin() {},
    async beforeCommit() {
      f.collections.close();
    },
    async committed() {},
    failed() {},
  });
  assert.equal((await f.collections.execute(create())).kind, 'uncertain');
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_collection').get()!.n, 1);
});

test('postcommit subscriber retirement leaves only a recoverable receipt, never a late result', async (t) => {
  const f = await fixture(t),
    command = create();
  let later = 0;
  f.collections.subscribe(() => {
    throw new Error('View failed');
  });
  f.collections.subscribe(() => f.setAccess({ ownerId: null, authGeneration: 2 }));
  f.collections.subscribe(() => {
    later++;
  });
  assert.equal((await f.collections.execute(command)).kind, 'uncertain');
  assert.equal(later, 0);
  await f.reopen();
  assert.equal(ready(await f.collections.readReceipt(command.operationId))!.outcome, 'committed');
});

test('owner, installation, restore and adoption changes cannot cross a pending request', async (t) => {
  for (const boundary of ['owner', 'installation', 'restore', 'adoption'] as const)
    await t.test(boundary, async (t) => {
      const f = await fixture(t),
        pause = f.pauseHash(),
        saving = f.collections.execute(create());
      await pause.entered.promise;
      if (boundary === 'owner')
        f.database
          .prepare('INSERT INTO app_metadata VALUES (?,?)')
          .run(
            'account-replication:owner',
            JSON.stringify({ schemaVersion: 1, ownerId: randomUUID() }),
          );
      if (boundary === 'installation')
        f.database
          .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
          .run(randomUUID());
      if (boundary === 'restore')
        f.database
          .prepare('INSERT INTO app_metadata VALUES (?,?)')
          .run('account-replication:apply-epoch', '1');
      if (boundary === 'adoption') f.rollback();
      pause.release.resolve();
      assert.notEqual((await saving).kind, 'ready');
      assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 0);
    });
});

test('caller mutation, hostile review objects and oversized requests are bounded before hashing', async (t) => {
  const f = await fixture(t),
    command = create(),
    pause = f.pauseHash(),
    saving = f.collections.execute(command);
  await pause.entered.promise;
  command.name = 'Caller mutation';
  pause.release.resolve();
  ready(await saving);
  assert.equal(ready(await f.collections.readCollections()).items[0]!.name, 'Weeknight dinners');
  const review = ready(await f.collections.reviewDeleteCollection(command.collectionId));
  let getterCalls = 0;
  const accessor = Object.defineProperty({ ...review }, 'affectedRecipeIds', {
    enumerable: true,
    get() {
      getterCalls++;
      return [];
    },
  });
  for (const bad of [
    accessor,
    { ...review, name: 'x'.repeat(1_048_576) },
    { ...review, affectedRecipeIds: Array(50_001).fill(authoredId) },
    { ...review, affectedRecipeIds: [authoredId, authoredId] },
    { ...review, extra: true },
  ])
    assert.equal((await f.collections.deleteCollection(bad, randomUUID())).kind, 'failed');
  assert.equal(getterCalls, 0);
  const page = Object.defineProperty({}, 'cursor', {
    enumerable: true,
    get() {
      getterCalls++;
      return '';
    },
  });
  assert.equal((await f.collections.readCollection(command.collectionId, page)).kind, 'failed');
  assert.equal(getterCalls, 0);
  assert.equal((await f.collections.execute({ ...create(), name: 'x'.repeat(81) })).kind, 'failed');
  assert.equal(
    (
      await f.collections.execute({
        ...create(),
        extra: true,
      } as unknown as ContentCollectionCommand)
    ).kind,
    'failed',
  );
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 1);
});

test('schema8 remains explicit; the ordinary schema6 parser and engine path are unchanged', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.reader.transaction((session) => readPersonalState(session)),
    { code: 'incompatible_version' },
  );
  const six = await fixture(t, 6);
  assert.equal((await six.collections.readCollections()).kind, 'failed');
  assert.equal((await six.collections.execute(create())).kind, 'failed');
  assert.equal((await six.reader.transaction((session) => readPersonalState(session))).epoch, 0);
  assert.equal(six.database.prepare('PRAGMA user_version').get()!.user_version, 6);
});

test('receipt family, cancellation shape, counts and future clocks are admitted before disclosure', async (t) => {
  const f = await fixture(t),
    command = create();
  ready(await f.collections.execute(command));
  const receipt = ready(await f.collections.readReceipt(command.operationId))!;
  for (const replacement of [
    { ...receipt, commandKind: 'saveNote' },
    { ...receipt, commandKind: 'addManualItem' },
    { ...receipt, outcome: 'cancelled' },
    { ...receipt, revision: receipt.revision + 1 },
    { ...receipt, epoch: 1 },
    { ...receipt, affectedMemberships: 1 },
    { ...receipt, commandKind: 'setCollectionMembership', affectedMemberships: 0 },
    { ...receipt, commandKind: 'deleteCollection', affectedMemberships: 50_001 },
    { ...receipt, commandKind: 'deleteCollection', outcome: 'no_op' },
  ]) {
    f.database
      .prepare('UPDATE personal_operation SET receipt_json=?')
      .run(JSON.stringify(replacement));
    for (const result of [
      await f.collections.readReceipt(command.operationId),
      await f.collections.resolveOperation(command.operationId),
    ]) {
      assert.equal(result.kind, 'failed');
      assert.equal('value' in result, false);
    }
  }
});

test('replay rechecks bounded receipts after async hashing before materializing them', async (t) => {
  const f = await fixture(t),
    parent = create();
  ready(await f.collections.execute(parent));
  const command = member(parent.collectionId, 1);
  ready(await f.collections.execute(command));
  const pause = f.pauseHash(),
    replaying = f.collections.execute(command);
  await pause.entered.promise;
  f.database.exec('PRAGMA ignore_check_constraints=ON');
  f.database
    .prepare('UPDATE personal_operation SET receipt_json=? WHERE operation_id=?')
    .run('x'.repeat(1_048_576), command.operationId);
  f.database.exec('PRAGMA ignore_check_constraints=OFF');
  pause.release.resolve();
  assert.notEqual((await replaying).kind, 'ready');
  assert.deepEqual(f.oversizedTransfers, []);
});

test('collection and membership scalar TEXT/BLOB corruption never crosses either SQL bridge', async (t) => {
  for (const [table, fields] of [
    [
      'personal_collection',
      ['collection_id', 'name', 'deleted', 'revision', 'created_at', 'updated_at'],
    ],
    [
      'personal_collection_member',
      ['collection_id', 'recipe_id', 'present', 'revision', 'updated_at'],
    ],
  ] as const)
    for (const field of fields)
      for (const kind of ['text', 'blob'] as const)
        await t.test(`${table}.${field} ${kind}`, async (t) => {
          const f = await fixture(t),
            command = create();
          ready(await f.collections.execute(command));
          ready(await f.collections.execute(member(command.collectionId, 1)));
          f.database.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
          f.database
            .prepare(`UPDATE ${table} SET ${field}=?`)
            .run(kind === 'text' ? 'x'.repeat(1_048_576) : Buffer.alloc(1_048_576, 120));
          f.database.exec('PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=OFF');
          for (const result of [
            await f.collections.readCollections(),
            await f.collections.readCollection(command.collectionId),
            await f.collections.readRecipeMemberships(authoredId),
            await f.collections.reviewDeleteCollection(command.collectionId),
            await f.collections.execute(create()),
          ])
            assert.equal(result.kind, 'failed');
          assert.deepEqual(f.oversizedTransfers, []);
          assert.equal(f.database.prepare('SELECT COUNT(*) n FROM personal_operation').get()!.n, 2);
        });
});

test('bounded shared clocks are checked before every collection read and recovery entrypoint', async (t) => {
  for (const [table, field, where] of [
    ['personal_state', 'revision', 'singleton=1'],
    ['personal_state', 'epoch', 'singleton=1'],
    ['state_revision', 'revision', "collection='store'"],
  ] as const)
    for (const kind of ['text', 'blob'] as const)
      await t.test(`${table}.${field} ${kind}`, async (t) => {
        const f = await fixture(t),
          command = create();
        ready(await f.collections.execute(command));
        const review = ready(await f.collections.reviewDeleteCollection(command.collectionId));
        f.database.exec('PRAGMA ignore_check_constraints=ON');
        f.database
          .prepare(`UPDATE ${table} SET ${field}=? WHERE ${where}`)
          .run(kind === 'text' ? 'x'.repeat(1_048_576) : Buffer.alloc(1_048_576, 120));
        f.database.exec('PRAGMA ignore_check_constraints=OFF');
        for (const result of [
          await f.collections.readCollections(),
          await f.collections.readCollection(command.collectionId),
          await f.collections.readRecipeMemberships(authoredId),
          await f.collections.reviewDeleteCollection(command.collectionId),
          await f.collections.deleteCollection(review, randomUUID()),
          await f.collections.execute(create()),
          await f.collections.readReceipt(command.operationId),
          await f.collections.resolveOperation(command.operationId),
        ])
          assert.equal(result.kind, 'failed');
        assert.deepEqual(f.oversizedTransfers, []);
      });
});

test('future row clocks, malformed names/dates, tombstones and missing FKs reject the complete private view', async (t) => {
  for (const sql of [
    'UPDATE personal_collection SET revision=3',
    'UPDATE personal_collection_member SET revision=3',
    'UPDATE personal_collection SET revision=1',
    "UPDATE personal_collection SET name='123'",
    "UPDATE personal_collection SET updated_at='invalid'",
    'UPDATE personal_collection SET deleted=1',
    'UPDATE personal_collection SET deleted=1,name=NULL',
    "UPDATE personal_collection_member SET updated_at='invalid'",
    "DELETE FROM recipe_identity WHERE recipe_id='910000001'",
    'DELETE FROM personal_collection',
  ])
    await t.test(sql, async (t) => {
      const f = await fixture(t),
        command = create();
      ready(await f.collections.execute(command));
      ready(await f.collections.execute(member(command.collectionId, 1)));
      f.database.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
      f.database.exec(sql);
      f.database.exec('PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=OFF');
      assert.equal((await f.collections.readCollections()).kind, 'failed');
      assert.equal((await f.collections.readRecipeMemberships(authoredId)).kind, 'failed');
    });
});

test('active collections, retained tombstones and membership row counts are bounded before full reads', async (t) => {
  for (const boundary of ['active', 'retained', 'memberships'] as const)
    await t.test(boundary, async (t) => {
      const f = await fixture(t);
      f.database.exec('UPDATE personal_state SET revision=1');
      if (boundary === 'memberships') {
        const id = randomUUID();
        f.database
          .prepare('INSERT INTO personal_collection VALUES (?,?,0,1,?,?)')
          .run(id, JSON.stringify('List'), at, at);
        f.database.exec(
          'WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<50001) INSERT INTO recipe_identity SELECT CAST(900000000+n AS TEXT) FROM rows',
        );
        f.database
          .prepare(
            'INSERT INTO personal_collection_member SELECT ?,recipe_id,1,1,? FROM recipe_identity WHERE CAST(recipe_id AS INTEGER)>900000000',
          )
          .run(id, at);
      } else {
        const deleted = boundary === 'retained',
          count = deleted ? 10001 : 101;
        f.database
          .prepare(
            `WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<?)
        INSERT INTO personal_collection SELECT printf('00000000-0000-4000-8000-%012d',n),?,?,1,?,? FROM rows`,
          )
          .run(count, deleted ? null : JSON.stringify('List'), deleted ? 1 : 0, at, at);
      }
      assert.equal((await f.collections.readCollections()).kind, 'failed');
      assert.equal((await f.collections.execute(create())).kind, 'failed');
      assert.deepEqual(f.oversizedTransfers, []);
    });
});
