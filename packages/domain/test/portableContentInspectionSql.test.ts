import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  createRecipeContentRevision,
  type ContentLookup,
} from '@cookmate/catalogue/content';
import { cookingContentIdentity } from '../src';
import {
  createPortableContentBackup,
  type PortableContentBackupInput,
} from '../src/portableBackupContent';
import {
  createPortableContentBackupInspector,
  type PortableContentInspectionResult,
} from '../../../apps/mobile/src/data/portableContentInspection';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Real disposable SQLite; controlled trusted-reference port here. Actual signatures/media are
// exercised separately by content-store SQL tests and the signed admin/private bridge.
const at = '2026-10-01T12:00:00.000Z';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function ready(result: PortableContentInspectionResult) {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: PortableContentInspectionResult, key?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (result.kind !== 'failed') assert.fail();
  if (key) assert.equal(result.error.messageKey, `backup.content_inspection_${key}`);
  assert.equal(Object.hasOwn(result, 'value'), false);
}
async function fixture(t: TestContext, databaseVersion: 7 | 8 = 7) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-inspection-'));
  const path = join(directory, 'cooking.db'),
    write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  t.after(async () => {
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  const installationId = randomUUID();
  await initializeDatabase(
    writer,
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
  await migrateCookingContentDatabase(writer, { sha256 });
  if (databaseVersion === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const db = write.database;
  const revision = await createRecipeContentRevision(
    authoredFixture('52835'),
    'inspection-first',
    sha256,
  );
  const nextDocument = authoredFixture('52835');
  nextDocument.recipe.title = 'New exact title';
  const next = await createRecipeContentRevision(nextDocument, 'inspection-next', sha256);
  const lookups = new Map<string, ContentLookup>();
  for (const [value, state] of [
    [revision, 'historical'],
    [next, 'current'],
  ] as const)
    lookups.set(canonicalContentJson(value.ref), {
      kind: 'readable',
      state,
      value: {
        origin: 'packaged_baseline',
        revision: value,
        publication: null,
        retainedSources: [],
      },
    });
  const occurrenceId = randomUUID();
  const input: PortableContentBackupInput = {
    schemaVersion: 3,
    databaseSchemaVersion: 7,
    createdAt: at,
    catalogue: catalogue.identity,
    sourceRevision: 1,
    data: {
      favourites: [],
      occurrences: [
        {
          occurrenceId,
          recipeId: next.ref.recipeId,
          placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
          revision: 1,
          createdAt: at,
          updatedAt: at,
        },
      ],
      shopping: {
        scope: { scopeId: randomUUID(), revision: 1, occurrenceIds: [occurrenceId] },
        projectionRevision: 1,
        projectionStatus: 'current',
        purchaseMarks: [],
      },
      preferences: {
        snapshot: { revision: 0, lastRemovalRevision: null, items: [] },
        removals: [],
      },
      personal: { notes: [], collections: [], memberships: [], manualItems: [] },
      planReferences: [{ occurrenceId, contentRef: next.ref }],
      cookingHistory: {
        entries: [
          {
            kind: 'exact',
            entry: {
              readerVersion: 2,
              recipeId: revision.ref.recipeId,
              contentRef: revision.ref,
              eventId: randomUUID(),
              recipeTitle: revision.document.recipe.title,
              photoAssetId: revision.document.media[0]!.assetId,
              cookedOn: '2026-10-01',
              timeZone: 'Asia/Dubai',
              recordedAt: at,
              note: 'PRIVATE NOTE SENTINEL',
              historyEpoch: 0,
              revision: 1,
            },
          },
        ],
      },
    },
  };
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 1 };
  let onHash: ((text: string) => Promise<void>) | undefined;
  let beforeView: (() => void) | undefined;
  let afterView: (() => void) | undefined;
  let calls = 0;
  const options: Parameters<typeof createPortableContentBackupInspector>[0] = {
    reader,
    installationId,
    sha256: async (text) => {
      await onHash?.(text);
      return sha256(text);
    },
    getAccess: () => access,
    assertAccess: (scope) => {
      assert.deepEqual(scope, access);
      return undefined;
    },
    contentStore: {
      async withVerifiedReferenceInspection(head, refs, work) {
        calls++;
        beforeView?.();
        const result = await work({
          head,
          latestHead: head,
          adoptedRecipeIds: [
            ...new Set(
              [...lookups.values()].flatMap((lookup) =>
                lookup.kind === 'readable' ? [lookup.value.revision.ref.recipeId] : [],
              ),
            ),
          ],
          entries: refs.map((ref) => ({
            ref,
            lookup: lookups.get(canonicalContentJson(ref)) ?? { kind: 'missing' },
          })),
          assertActive: () => undefined,
        });
        afterView?.();
        return result;
      },
    },
  };
  const inspector = createPortableContentBackupInspector(options);
  t.after(() => inspector.close());
  const serialize = async () => JSON.stringify(await createPortableContentBackup(input, sha256));
  const bytes = () =>
    JSON.stringify(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => [row.name, db.prepare(`SELECT * FROM "${row.name}"`).all()]),
    );
  return {
    db,
    read,
    input,
    inspector,
    options,
    revision,
    next,
    lookups,
    serialize,
    bytes,
    calls: () => calls,
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    onHash(value: typeof onHash) {
      onHash = value;
    },
    beforeView(value: typeof beforeView) {
      beforeView = value;
    },
    afterView(value: typeof afterView) {
      afterView = value;
    },
  };
}

test('exact historical and current refs of one recipe are inspected without bodies, private text or write authority', async (t) => {
  const f = await fixture(t),
    before = f.bytes();
  const result = ready(await f.inspector.inspect(await f.serialize()));
  assert.deepEqual(
    result.references.map((r) => r.state),
    ['current', 'historical'],
  );
  assert.equal(result.archiveVerification, 'performed');
  assert.equal(result.exactReferencesAvailable, true);
  assert.equal(result.restoreAvailable, false);
  assert.deepEqual(result.historyIssues, []);
  assert.ok(Object.isFrozen(result.references[0]!.ref));
  const text = JSON.stringify(result);
  assert.ok(
    !text.includes('PRIVATE NOTE SENTINEL') &&
      !text.includes('rawMeasure') &&
      !text.includes('rawText'),
  );
  assert.equal(f.bytes(), before);
});

test('unknown and withdrawn exact references stay unavailable without substitution or omitted rows', async (t) => {
  const f = await fixture(t);
  f.lookups.delete(canonicalContentJson(f.next.ref));
  f.lookups.set(canonicalContentJson(f.revision.ref), {
    kind: 'withdrawn',
    recipeId: f.revision.ref.recipeId,
    reason: 'PRIVATE POLICY REASON',
  });
  const result = ready(await f.inspector.inspect(await f.serialize()));
  assert.deepEqual(
    result.references.map((r) => r.state),
    ['missing', 'withdrawn'],
  );
  assert.equal(result.exactReferencesAvailable, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE POLICY REASON'));
});

test('checksum-valid exact history cannot mislabel the verified title or photograph', async (t) => {
  const f = await fixture(t),
    entry = f.input.data.cookingHistory!.entries[0]!.entry;
  entry.recipeTitle = 'Forged title';
  assert.deepEqual(ready(await f.inspector.inspect(await f.serialize())).historyIssues, [
    { eventId: entry.eventId, reason: 'metadata_mismatch' },
  ]);
  entry.recipeTitle = f.revision.document.recipe.title;
  assert.ok('photoAssetId' in entry);
  entry.photoAssetId = `sha256:${'f'.repeat(64)}`;
  assert.equal(
    ready(await f.inspector.inspect(await f.serialize())).historyIssues[0]!.reason,
    'metadata_mismatch',
  );
  entry.photoAssetId = null;
  assert.deepEqual(ready(await f.inspector.inspect(await f.serialize())).historyIssues, []);
});

test('legacy exact identity is checked against original imported evidence; unresolved identity remains explicit', async (t) => {
  const f = await fixture(t),
    recipe = catalogue.recipes[0]!;
  const revision = await createBundledRecipeRevision(recipe.recipeId, sha256);
  f.lookups.set(canonicalContentJson(revision.ref), {
    kind: 'readable',
    state: 'archived',
    value: { origin: 'packaged_baseline', revision, publication: null, retainedSources: [] },
  });
  const entry = {
    ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: null,
    historyEpoch: 0,
    revision: 1,
  };
  f.input.data.cookingHistory = {
    entries: [{ kind: 'legacy', entry, pin: { kind: 'exact', ref: revision.ref } }],
  };
  assert.deepEqual(ready(await f.inspector.inspect(await f.serialize())).historyIssues, []);
  entry.contentFingerprint = 'f'.repeat(64);
  assert.equal(
    ready(await f.inspector.inspect(await f.serialize())).historyIssues[0]!.reason,
    'metadata_mismatch',
  );
  f.input.data.cookingHistory.entries[0] = {
    kind: 'legacy',
    entry,
    pin: { kind: 'unresolved', reason: 'content_mismatch' },
  };
  assert.equal(
    ready(await f.inspector.inspect(await f.serialize())).historyIssues[0]!.reason,
    'unresolved_legacy',
  );
});

test('guest withdrawal and redacted local receipts deny revival without altering any table', async (t) => {
  const f = await fixture(t),
    eventId = f.input.data.cookingHistory!.entries[0]!.entry.eventId;
  f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(eventId);
  const before = f.bytes();
  assert.deepEqual(ready(await f.inspector.inspect(await f.serialize())).historyIssues, [
    { eventId, reason: 'previously_removed' },
  ]);
  assert.equal(f.bytes(), before);
  f.db.prepare('DELETE FROM cooking_history_withdrawal WHERE event_id=?').run(eventId);
  f.db.prepare("INSERT INTO cooking_event VALUES (?,0,'cleared',NULL,NULL,NULL,NULL)").run(eventId);
  assert.equal(
    ready(await f.inspector.inspect(await f.serialize())).historyIssues[0]!.reason,
    'previously_removed',
  );
});

test('account removals are owner-bound; foreign rows and missing binding fail closed', async (t) => {
  const f = await fixture(t, 8),
    eventId = f.input.data.cookingHistory!.entries[0]!.entry.eventId;
  f.db.prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)').run(ownerId, eventId);
  failed(await f.inspector.inspect(await f.serialize()));
  f.db
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId }));
  f.setAccess({ ownerId, authGeneration: 2 });
  const scoped = createPortableContentBackupInspector(f.options);
  t.after(() => scoped.close());
  assert.equal(
    ready(await scoped.inspect(await f.serialize())).historyIssues[0]!.reason,
    'previously_removed',
  );
  failed(await f.inspector.inspect(await f.serialize()), 'access_changed');
});

test('owner revoke during hashing and close after archive callback never return a usable inspection', async (t) => {
  const f = await fixture(t, 8),
    serialized = await f.serialize();
  f.onHash(async () => {
    f.setAccess(null);
  });
  failed(await f.inspector.inspect(serialized), 'access_changed');
  assert.equal(f.calls(), 0);
  f.onHash(undefined);
  f.setAccess({ ownerId: null, authGeneration: 1 });
  f.afterView(() => f.inspector.close());
  failed(await f.inspector.inspect(serialized), 'access_changed');
});

test('adoption, restore and store changes between reference selection and lookup require a new inspection', async (t) => {
  const f = await fixture(t),
    serialized = await f.serialize();
  for (const sql of [
    'UPDATE app_content_adoption SET revision=revision+1',
    "UPDATE state_revision SET revision=revision+1 WHERE collection='store'",
    "INSERT OR REPLACE INTO app_metadata VALUES ('account-replication:apply-epoch','1')",
  ]) {
    f.beforeView(() => f.db.exec(sql));
    failed(await f.inspector.inspect(serialized), 'workspace_changed');
  }
});

test('malformed, old-format and checksum-invalid files never reach content trust or change SQL', async (t) => {
  const f = await fixture(t),
    before = f.bytes();
  const serialized = await f.serialize();
  for (const value of [
    '{',
    serialized.replace('"schemaVersion":3', '"schemaVersion":1'),
    serialized.replace('"schemaVersion":3', '"schemaVersion":2'),
    serialized.replace('PRIVATE NOTE SENTINEL', 'changed'),
  ])
    assert.equal((await f.inspector.inspect(value)).kind, 'invalid');
  assert.equal(f.calls(), 0);
  assert.equal(f.bytes(), before);
});

test('wrong installation or schema does not inspect data under a fabricated workspace', async (t) => {
  const f = await fixture(t),
    serialized = await f.serialize();
  const wrong = createPortableContentBackupInspector({
    ...f.options,
    installationId: randomUUID(),
  });
  failed(await wrong.inspect(serialized), 'access_changed');
  wrong.close();
  f.db.exec('PRAGMA user_version=6');
  failed(await f.inspector.inspect(serialized));
  assert.equal(f.calls(), 0);
});

test('actual schema8 inspects format3 sources from7 and8 with exact unavailable refs and no restore authority', async (t) => {
  const f = await fixture(t, 8);
  assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 8);
  const before = f.bytes();
  for (const sourceVersion of [7, 8] as const) {
    f.input.databaseSchemaVersion = sourceVersion;
    const current = ready(await f.inspector.inspect(await f.serialize()));
    assert.deepEqual(
      current.references.map((row) => row.state),
      ['current', 'historical'],
    );
    assert.equal(current.restoreAvailable, false);
    assert.equal(current.exactReferencesAvailable, true);
    assert.deepEqual(current.historyIssues, []);
  }
  f.lookups.delete(canonicalContentJson(f.next.ref));
  f.lookups.set(canonicalContentJson(f.revision.ref), {
    kind: 'withdrawn',
    recipeId: f.revision.ref.recipeId,
    reason: 'PRIVATE WITHDRAWAL REASON',
  });
  const unavailable = ready(await f.inspector.inspect(await f.serialize()));
  assert.deepEqual(unavailable.references, [
    { ref: f.next.ref, state: 'missing' },
    { ref: f.revision.ref, state: 'withdrawn' },
  ]);
  assert.equal(unavailable.exactReferencesAvailable, false);
  assert.equal(unavailable.restoreAvailable, false);
  assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE|rawMeasure|rawText/);
  assert.equal(f.bytes(), before);
});

test('schema8 inspection fences reject oversized and invalid clocks before and during reference verification', async (t) => {
  const f = await fixture(t, 8),
    serialized = await f.serialize();
  const restoreId = randomUUID();
  f.db
    .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
    .run(restoreId, 'a'.repeat(64), '{}', '{}', '{}');
  const all = f.read.connection.all;
  let oversizedTransfers = 0;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, values);
    for (const row of rows)
      for (const value of Object.values(row))
        if ((typeof value === 'string' || value instanceof Uint8Array) && value.length >= 1048576)
          oversizedTransfers++;
    return rows;
  };
  try {
    for (const [table, column, predicate] of [
      ['app_content_adoption', 'revision', 'singleton=1'],
      ['portable_restore_operation', 'committed_revision', '1'],
      ['state_revision', 'revision', "collection='store'"],
    ]) {
      const original = f.db
        .prepare(`SELECT ${column} value FROM ${table} WHERE ${predicate}`)
        .get() as { value: number };
      for (const stage of ['before', 'during'] as const)
        for (const value of ['x'.repeat(1048576), Buffer.alloc(1048576), -1, 0.5, 2 ** 53]) {
          let changes: unknown;
          const corrupt = () => {
            f.db.exec('PRAGMA ignore_check_constraints=ON');
            f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${predicate}`).run(value);
            f.db.exec('PRAGMA ignore_check_constraints=OFF');
            changes = f.db.prepare('SELECT total_changes() count').get();
          };
          const calls = f.calls();
          if (stage === 'before') corrupt();
          else f.beforeView(corrupt);
          failed(await f.inspector.inspect(serialized));
          assert.equal(f.calls(), calls + (stage === 'during' ? 1 : 0));
          assert.equal(oversizedTransfers, 0, `${table}.${column} crossed the SQL bridge`);
          assert.deepEqual(f.db.prepare('SELECT total_changes() count').get(), changes);
          f.beforeView(undefined);
          f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${predicate}`).run(original.value);
        }
    }
    ready(await f.inspector.inspect(serialized));
  } finally {
    f.beforeView(undefined);
    f.read.connection.all = all;
  }
});

test('schema8 inspection reports retirement when the guard or archive callback rejects', async (t) => {
  const f = await fixture(t, 8),
    serialized = await f.serialize();
  const retired = createPortableContentBackupInspector({
    ...f.options,
    assertAccess: () => {
      throw new Error('Synthetic retired owner');
    },
  });
  t.after(() => retired.close());
  const result = await retired.inspect(serialized);
  failed(result, 'access_changed');
  assert.equal(result.kind === 'failed' && result.error.code, 'stale_context');
  assert.equal(f.calls(), 0);
  f.afterView(() => {
    f.inspector.close();
    throw new Error('Synthetic retired archive callback');
  });
  failed(await f.inspector.inspect(serialized), 'access_changed');
});
