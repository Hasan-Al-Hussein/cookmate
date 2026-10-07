import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  createContentReader,
  verifySignedContentOverlay,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { buildShoppingProjection } from '../src/shoppingProjection';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { retainVerifiedRevisionsInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import {
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from '../../../apps/mobile/src/data/shoppingRepository';
import {
  createPinnedShoppingProjectionOptions,
  readPinnedShoppingContextInSnapshot,
  type PinnedShoppingPorts,
} from '../../../apps/mobile/src/data/pinnedShoppingRepository';
import {
  configureConnection,
  runBound,
  SerializedWriter,
  type SqlSession,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import {
  REVISION_SHOPPING_LIMITS,
  type PinnedShoppingOccurrence,
} from '../../../apps/mobile/src/data/revisionShoppingProjection';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import {
  member,
  overlayFixture,
  published,
  signed,
} from '../../catalogue/test/content-overlay-fixtures';

const at = '2026-10-01T00:00:00.000Z';
async function revisions(newGroup = false) {
  const document = authoredFixture();
  if (document.kind !== 'authored') throw new Error('fixture');
  document.recipe.ingredients = [
    { position: 1, rawName: 'Salt', rawMeasure: '100g' },
    { position: 2, rawName: 'Oil', rawMeasure: '1 tbsp' },
  ];
  const f = await overlayFixture(document);
  const first = f.publication;
  f.releases.set(f.manifest.releaseId, {
    manifest: f.manifest,
    fingerprint: f.envelope.fingerprint,
  });
  f.publications.set(`${first.revision.ref.recipeId}|${first.revision.ref.revisionId}`, first);
  const secondDocument = clone(document);
  secondDocument.provenance.basedOn = clone(first.revision.ref);
  secondDocument.recipe.ingredients[0]!.rawMeasure = '200g';
  const second = await published(secondDocument, 'revision-2');
  const secondManifest = {
    ...f.manifest,
    releaseId: 'overlay-2',
    sequence: 2,
    previous: { releaseId: f.manifest.releaseId, sequence: 1, fingerprint: f.envelope.fingerprint },
    entries: [member(second)],
  };
  const secondEnvelope = await signed(secondManifest);
  f.releases.set(secondManifest.releaseId, {
    manifest: secondManifest,
    fingerprint: secondEnvelope.fingerprint,
  });
  f.publications.set(`${second.revision.ref.recipeId}|${second.revision.ref.revisionId}`, second);
  const thirdDocument = clone(secondDocument);
  thirdDocument.provenance.basedOn = clone(second.revision.ref);
  thirdDocument.recipe.title = 'Title changed, exact ingredient demand retained';
  if (newGroup) thirdDocument.recipe.ingredients[0]!.rawName = 'Sea salt';
  const third = await published(thirdDocument, 'revision-3');
  const thirdManifest = {
    ...secondManifest,
    releaseId: 'overlay-3',
    sequence: 3,
    previous: {
      releaseId: secondManifest.releaseId,
      sequence: 2,
      fingerprint: secondEnvelope.fingerprint,
    },
    entries: [member(third)],
  };
  // Controlled verification ports only; this proves SQLite behavior, not hosted delivery or cryptography.
  const snapshot = await verifySignedContentOverlay(await signed(thirdManifest), {
    ...f.options,
    publications: [third],
    expectedCurrent: thirdManifest.previous,
    minimumSequence: 2,
    retainedRefs: [first.revision.ref, second.revision.ref],
  });
  return {
    snapshot,
    first: first.revision.ref,
    second: second.revision.ref,
    third: third.revision.ref,
    reader: createContentReader(snapshot),
  };
}
async function fixture(t: TestContext, migrate = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-pinned-shopping-'));
  const store = desktopConnection(join(directory, 'shopping.db'));
  await configureConnection(store.connection);
  const writer = new SerializedWriter(store.connection);
  t.after(async () => {
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    ids,
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  if (migrate) await migrateCookingContentDatabase(writer, { sha256 });
  return { ...store, writer, ids };
}
async function setup(t: TestContext, newGroup = false) {
  const f = await fixture(t),
    content = await revisions(newGroup);
  const ports: PinnedShoppingPorts = { lookupExact: content.reader.lookupExact, sha256 };
  await f.writer.transaction((session) =>
    retainVerifiedRevisionsInSnapshot(
      session,
      content.snapshot,
      [content.first, content.second, content.third],
      sha256,
    ),
  );
  const occurrenceIds = [randomUUID(), randomUUID()];
  await f.writer.transaction(async (session) => {
    const empty = await readPinnedShoppingContextInSnapshot(session, ports);
    const before = await readShoppingLedgerInSnapshot(session, empty.options);
    for (const [index, ref] of [content.first, content.second].entries()) {
      const occurrenceId = occurrenceIds[index]!;
      await runBound(session, 'INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)', [
        occurrenceId,
        ref.recipeId,
        '2026-10-01',
        index ? 'dinner' : 'lunch',
        at,
        at,
      ]);
      await runBound(session, 'INSERT INTO plan_content_pin VALUES (?,?,?,?)', [
        occurrenceId,
        ref.recipeId,
        ref.revisionId,
        ref.contentFingerprint,
      ]);
      await runBound(session, 'INSERT INTO shopping_selection VALUES (?,?)', [
        f.ids.shoppingScopeId,
        occurrenceId,
      ]);
    }
    await runBound(session, 'UPDATE shopping_scope SET revision=revision+1', []);
    const next = await readPinnedShoppingContextInSnapshot(session, ports);
    await rebuildShoppingInSnapshot(session, before, next.options);
  });
  const read = () =>
    f.writer.transaction(async (session) => {
      const context = await readPinnedShoppingContextInSnapshot(session, ports);
      return readShoppingLedgerInSnapshot(session, context.options);
    });
  const replace = (occurrenceId: string, ref: RecipeContentRef) =>
    f.writer.transaction(async (session) => {
      const context = await readPinnedShoppingContextInSnapshot(session, ports);
      const before = await readShoppingLedgerInSnapshot(session, context.options);
      await runBound(session, 'DELETE FROM shopping_contribution', []);
      await runBound(
        session,
        'UPDATE plan_content_pin SET revision_id=?,content_fingerprint=? WHERE occurrence_id=?',
        [ref.revisionId, ref.contentFingerprint, occurrenceId],
      );
      const next = await readPinnedShoppingContextInSnapshot(session, ports);
      await rebuildShoppingInSnapshot(session, before, next.options);
    });
  return { ...f, ...content, ports, occurrenceIds, read, replace };
}

test('SQLite retains two exact revisions of one recipe and reconciles only changed purchase demand', async (t) => {
  const f = await setup(t);
  const initial = await f.read();
  assert.equal(
    initial.snapshot.groups.find((group) => group.displayName === 'Salt')!.quantityLabel,
    '300 g',
  );
  assert.equal(
    initial.snapshot.groups.find((group) => group.displayName === 'Oil')!.quantityLabel,
    '2 tbsp',
  );
  assert.deepEqual(
    new Set(
      f.database
        .prepare('SELECT revision_id FROM shopping_contribution')
        .all()
        .map((row) => row.revision_id),
    ),
    new Set([f.first.revisionId, f.second.revisionId]),
  );
  f.database.exec('UPDATE purchase_state SET purchased=1,changed=0,revision=revision+1');
  const marked = await f.read();
  await f.replace(f.occurrenceIds[1]!, f.third);
  const titleOnly = await f.read();
  assert.deepEqual(
    titleOnly.snapshot.groups.map(
      ({ groupKey, demandFingerprint, purchased, changed, revision }) => ({
        groupKey,
        demandFingerprint,
        purchased,
        changed,
        revision,
      }),
    ),
    marked.snapshot.groups.map(({ groupKey, demandFingerprint, purchased, changed, revision }) => ({
      groupKey,
      demandFingerprint,
      purchased,
      changed,
      revision,
    })),
  );
  assert.equal(
    f.database
      .prepare('SELECT revision_id FROM plan_content_pin WHERE occurrence_id=?')
      .get(f.occurrenceIds[1]!)!.revision_id,
    f.third.revisionId,
  );
  await f.replace(f.occurrenceIds[0]!, f.second);
  const changed = await f.read();
  const salt = changed.snapshot.groups.find((group) => group.displayName === 'Salt')!,
    oil = changed.snapshot.groups.find((group) => group.displayName === 'Oil')!;
  assert.equal(salt.quantityLabel, '400 g');
  assert.equal(salt.purchased, false);
  assert.equal(salt.changed, true);
  assert.equal(oil.quantityLabel, '2 tbsp');
  assert.equal(oil.purchased, true);
  assert.equal(oil.changed, false);
  assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('failed exact-pin rebuild rolls back pins, contributions and purchase state in the caller transaction', async (t) => {
  const f = await setup(t);
  f.database.exec('UPDATE purchase_state SET purchased=1,revision=revision+1');
  const dump = () =>
    [
      'plan_content_pin',
      'shopping_contribution',
      'shopping_group',
      'purchase_state',
      'shopping_scope',
    ].map((table) => f.database.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
  const before = dump();
  f.database.exec(
    "CREATE TRIGGER fixture_abort_contribution BEFORE INSERT ON shopping_contribution BEGIN SELECT RAISE(ABORT,'fixture rebuild interruption'); END;",
  );
  await assert.rejects(f.replace(f.occurrenceIds[0]!, f.second), /fixture rebuild interruption/);
  assert.deepEqual(dump(), before);
  f.database.exec('DROP TRIGGER fixture_abort_contribution');
  assert.equal(
    (await f.read()).snapshot.groups.every((group) => group.purchased),
    true,
  );
});

test('actual schema eight retains exact demand and purchase reconciliation without admitting legacy projection', async (t) => {
  const f = await setup(t);
  f.database.exec('UPDATE purchase_state SET purchased=1,changed=0,revision=revision+1');
  const before = await f.read();
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 8);
  assert.deepEqual(await f.read(), before);
  await assert.rejects(
    f.writer.transaction((session) =>
      readShoppingLedgerInSnapshot(session, { readRecipe: catalogue.getRecipe, sha256 }),
    ),
    /Stored shopping/,
  );
  await f.replace(f.occurrenceIds[1]!, f.third);
  const titleOnly = await f.read();
  assert.deepEqual(
    titleOnly.snapshot.groups.map((row) => [
      row.groupKey,
      row.demandFingerprint,
      row.purchased,
      row.changed,
    ]),
    before.snapshot.groups.map((row) => [
      row.groupKey,
      row.demandFingerprint,
      row.purchased,
      row.changed,
    ]),
  );
  await f.replace(f.occurrenceIds[0]!, f.second);
  const changed = await f.read();
  const salt = changed.snapshot.groups.find((row) => row.displayName === 'Salt')!;
  const oil = changed.snapshot.groups.find((row) => row.displayName === 'Oil')!;
  assert.equal(salt.quantityLabel, '400 g');
  assert.equal(salt.purchased, false);
  assert.equal(salt.changed, true);
  assert.equal(oil.purchased, true);
  assert.equal(oil.changed, false);
  assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('schema-eight exact rebuild still rolls back all affected rows on interruption', async (t) => {
  const f = await setup(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  const dump = () =>
    [
      'plan_content_pin',
      'shopping_contribution',
      'shopping_group',
      'purchase_state',
      'shopping_scope',
    ].map((table) => f.database.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
  const before = dump();
  f.database.exec(
    "CREATE TRIGGER fixture_eight_abort BEFORE INSERT ON shopping_contribution BEGIN SELECT RAISE(ABORT,'schema eight interruption'); END;",
  );
  await assert.rejects(f.replace(f.occurrenceIds[0]!, f.second), /schema eight interruption/);
  assert.deepEqual(dump(), before);
  assert.equal(
    (await f.read()).snapshot.groups.find((row) => row.displayName === 'Salt')!.quantityLabel,
    '300 g',
  );
});

test('post-write group and aggregate-byte limits roll back new keys without stranding a readable ledger', async (t) => {
  for (const boundary of ['groups', 'bytes'] as const) {
    const f = await setup(t, true);
    f.database.exec('UPDATE purchase_state SET purchased=1,revision=revision+1');
    const count = boundary === 'groups' ? REVISION_SHOPPING_LIMITS.contributions - 2 : 6000;
    const group = f.database.prepare('INSERT INTO shopping_group VALUES (?,?,?,?,0,?,?)');
    const purchase = f.database.prepare('INSERT INTO purchase_state VALUES (?,?,?,0,1,0)');
    f.database.exec('BEGIN');
    for (let index = 0; index < count; index++) {
      const key = index.toString(16).padStart(64, '0');
      group.run(
        f.ids.shoppingScopeId,
        key,
        'fixture-dormant',
        'a'.repeat(64),
        boundary === 'bytes' ? 'x'.repeat(2048) : 'Dormant',
        'q',
      );
      purchase.run(f.ids.shoppingScopeId, key, 'a'.repeat(64));
    }
    f.database.exec('COMMIT');
    if (boundary === 'bytes') {
      // Read SQLite's declared text columns to fill this disposable ledger just below
      // the admitted byte ceiling without building megabytes of fixture rows in JS.
      let bytes = 0;
      for (const table of [
        'shopping_scope',
        'shopping_selection',
        'plan_occurrence',
        'plan_content_pin',
        'shopping_group',
        'shopping_contribution',
        'purchase_state',
      ]) {
        const columns = f.database
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .filter((column) => column.type === 'TEXT')
          .map((column) => String(column.name));
        bytes += Number(
          f.database
            .prepare(
              `SELECT COALESCE(SUM(${columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+')}),0) bytes FROM ${table}`,
            )
            .get()!.bytes,
        );
      }
      let remaining = REVISION_SHOPPING_LIMITS.sourceBytes * 4 - 32 - bytes;
      assert.ok(remaining > 0 && remaining < count * 4095);
      const pad = f.database.prepare(
        'UPDATE shopping_group SET quantity_label=? WHERE scope_id=? AND group_key=?',
      );
      f.database.exec('BEGIN');
      for (let index = 0; remaining > 0; index++) {
        const added = Math.min(4095, remaining);
        pad.run('q'.repeat(added + 1), f.ids.shoppingScopeId, index.toString(16).padStart(64, '0'));
        remaining -= added;
      }
      f.database.exec('COMMIT');
    }
    const before = (await f.read()).snapshot;
    const pins = f.database.prepare('SELECT * FROM plan_content_pin ORDER BY occurrence_id').all();
    const contributions = f.database
      .prepare('SELECT * FROM shopping_contribution ORDER BY occurrence_id,source_key')
      .all();
    await assert.rejects(
      f.replace(f.occurrenceIds[1]!, f.third),
      /Stored shopping projection is invalid/,
    );
    assert.deepEqual((await f.read()).snapshot, before);
    assert.deepEqual(
      f.database.prepare('SELECT * FROM plan_content_pin ORDER BY occurrence_id').all(),
      pins,
    );
    assert.deepEqual(
      f.database
        .prepare('SELECT * FROM shopping_contribution ORDER BY occurrence_id,source_key')
        .all(),
      contributions,
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) count FROM shopping_group').get()!.count,
      count + 2,
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) count FROM purchase_state').get()!.count,
      count + 2,
    );
  }
});

test('invalid persisted reference and oversized ledger scalar fail before broad materialization', async (t) => {
  const f = await setup(t);
  f.database.exec('PRAGMA foreign_keys=OFF');
  f.database
    .prepare('UPDATE plan_content_pin SET content_fingerprint=? WHERE occurrence_id=?')
    .run('f'.repeat(64), f.occurrenceIds[0]!);
  f.database.exec('PRAGMA foreign_keys=ON');
  await assert.rejects(f.read(), /Pinned shopping/);
  f.database.exec('PRAGMA foreign_keys=OFF');
  f.database
    .prepare('UPDATE plan_content_pin SET content_fingerprint=? WHERE occurrence_id=?')
    .run(f.first.contentFingerprint, f.occurrenceIds[0]!);
  f.database.exec('PRAGMA foreign_keys=ON');
  f.database.prepare('UPDATE shopping_contribution SET raw_name=?').run('x'.repeat(1024 * 1024));
  let broadReads = 0,
    largestReturned = 0;
  await assert.rejects(
    f.writer.transaction(async (session) => {
      const bounded: SqlSession = {
        ...session,
        all: async <Row extends object>(sql: string, values: readonly SqlValue[] = []) => {
          if (
            sql.includes('SELECT g.group_key') ||
            sql.includes('SELECT occurrence_id AS occurrenceId')
          )
            broadReads++;
          const rows = await session.all<Row>(sql, values);
          largestReturned = Math.max(largestReturned, JSON.stringify(rows).length);
          return rows;
        },
      };
      return readPinnedShoppingContextInSnapshot(bounded, f.ports);
    }),
    /Stored shopping/,
  );
  assert.equal(broadReads, 0);
  assert.ok(largestReturned < 1000);
});

test('projection options own exact inputs and reject missing, withdrawn, swapped or duplicate pins', async (t) => {
  const f = await setup(t);
  const context = await f.writer.transaction((session) =>
    readPinnedShoppingContextInSnapshot(session, f.ports),
  );
  const input = JSON.parse(JSON.stringify(context.pinnedOccurrences)) as PinnedShoppingOccurrence[];
  const options = createPinnedShoppingProjectionOptions(input, f.ports);
  input[0]!.contentRef = clone(f.third);
  const groups = await buildShoppingProjection(context.occurrences, options);
  assert.equal(groups.find((group) => group.displayName === 'Salt')!.quantityLabel, '300 g');
  assert.equal(options.readRecipe(f.first.recipeId), undefined);
  assert.throws(
    () =>
      createPinnedShoppingProjectionOptions(
        [...context.pinnedOccurrences, context.pinnedOccurrences[0]!],
        f.ports,
      ),
    /Pinned shopping/,
  );
  assert.throws(
    () =>
      createPinnedShoppingProjectionOptions(context.pinnedOccurrences, {
        ...f.ports,
        lookupExact: () => ({
          kind: 'withdrawn',
          recipeId: f.first.recipeId,
          reason: 'Synthetic withdrawal',
        }),
      }),
    /Pinned shopping/,
  );
  assert.throws(
    () =>
      createPinnedShoppingProjectionOptions(context.pinnedOccurrences, {
        ...f.ports,
        lookupExact: () => f.reader.lookupExact(f.third),
      }),
    /Pinned shopping/,
  );
});

test('schema-six legacy ledger stays readable and cannot opt into exact-pin mode', async (t) => {
  const f = await fixture(t, false);
  const legacy = { readRecipe: catalogue.getRecipe, sha256 };
  assert.equal(
    (await f.writer.transaction((session) => readShoppingLedgerInSnapshot(session, legacy)))
      .snapshot.groups.length,
    0,
  );
  const ports: PinnedShoppingPorts = {
    sha256,
    lookupExact: () => {
      throw new Error('must not resolve before schema admission');
    },
  };
  await assert.rejects(
    f.writer.transaction((session) => readPinnedShoppingContextInSnapshot(session, ports)),
    /Cooking content/,
  );
  await migrateCookingContentDatabase(f.writer, { sha256 });
  await assert.rejects(
    f.writer.transaction((session) => readShoppingLedgerInSnapshot(session, legacy)),
    /Stored shopping/,
  );
});
