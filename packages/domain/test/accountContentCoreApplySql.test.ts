import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  projectContentLookup,
  type ContentLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { AccountReplicationError } from '@cookmate/account-sync';
import {
  accountContentSnapshotFromBackup,
  type AccountContentSnapshot,
} from '../../account-sync/src/contentSnapshot';
import type { Immutable } from '../src';
import type { PortableContentBackupEnvelope } from '../src/portableBackupContent';
import {
  applyAccountContentCore,
  nextAccountContentApplyRevision,
  type AccountContentCoreApplyOptions,
} from '../../../apps/mobile/src/data/accountContentCoreApply';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_APPLY_EPOCH_KEY,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import type { ContentReferenceInspectionView } from '../../../apps/mobile/src/data/contentReleaseStore';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { readPinnedShoppingContextInSnapshot } from '../../../apps/mobile/src/data/pinnedShoppingRepository';
import { capturePortableContentBackupInSnapshot } from '../../../apps/mobile/src/data/portableContentBackup';
import { readShoppingLedgerInSnapshot } from '../../../apps/mobile/src/data/shoppingRepository';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { published } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection } from './helpers/sqlite';

// Real migrations/SQLite with a controlled authenticated inspection port. The synthetic
// publications here prove neither signature/media verification nor human merge approval.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  at = '2026-10-01T12:00:00.000Z',
  later = '2026-10-01T13:00:00.000Z',
  authoredId = '90001',
  identityOnlyId = '90002',
  unknownId = '90003';
const copy = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const mutable = (value: Immutable<AccountContentSnapshot>): AccountContentSnapshot =>
  JSON.parse(JSON.stringify(value)) as AccountContentSnapshot;
const portableCopy = (
  value: Immutable<PortableContentBackupEnvelope>,
): PortableContentBackupEnvelope =>
  JSON.parse(JSON.stringify(value)) as PortableContentBackupEnvelope;
const key = (ref: Immutable<RecipeContentRef>) => canonicalContentJson(ref);
const reason = (value: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === value;
type Before = {
  portable: Immutable<PortableContentBackupEnvelope>;
  account: Immutable<AccountContentSnapshot>;
};

async function fixture(t: TestContext) {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
  t.after(() => writer.close());
  const installationId = randomUUID(),
    conversationId = randomUUID(),
    shoppingScopeId = randomUUID();
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId, conversationId, shoppingScopeId },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  const db = storage.database;
  db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
    ACCOUNT_BINDING_KEY,
    JSON.stringify({ schemaVersion: 1, ownerId }),
  );
  await migrateCookingContentDatabase(writer, { sha256 });
  await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const document = authoredFixture(authoredId);
  document.recipe.ingredients = [
    { position: 1, rawName: 'Salt', rawMeasure: '100g' },
    { position: 2, rawName: 'Oil', rawMeasure: '1 tbsp' },
  ];
  const first = await published(document, 'core-first');
  document.recipe.ingredients[0]!.rawMeasure = '200g';
  const second = await published(document, 'core-second');
  document.recipe.title = 'Only title changed';
  const third = await published(document, 'core-third');
  const lookups = new Map<string, ContentLookup>(
    [first, second, third].map((publication) => [
      key(publication.revision.ref),
      {
        kind: 'readable',
        state: publication === third ? 'current' : 'historical',
        value: {
          origin: 'published',
          revision: publication.revision,
          publication,
          retainedSources: [],
        },
      },
    ]),
  );
  const head = { releaseId: 'core-fixture-head', sequence: 3, fingerprint: 'a'.repeat(64) };
  db.prepare('UPDATE app_content_adoption SET revision=1,head_json=?').run(JSON.stringify(head));
  let live = true,
    access = true;
  const view: ContentReferenceInspectionView = {
    head,
    latestHead: head,
    adoptedRecipeIds: [...catalogue.recipes.map((row) => row.recipeId), authoredId, identityOnlyId],
    get entries() {
      return [first, second, third].map((publication) => ({
        ref: publication.revision.ref,
        lookup: lookups.get(key(publication.revision.ref)) ?? { kind: 'missing' },
      }));
    },
    assertActive() {
      assert.ok(live, 'reservation expired');
      return undefined;
    },
  };
  const check = () => {
    assert.ok(access, 'owner expired');
    return undefined;
  };
  const capture = () =>
    writer.transaction(async (session) => {
      const portable = await capturePortableContentBackupInSnapshot(
        session,
        {
          installationId,
          ownerId,
          catalogue: catalogue.identity,
          sha256,
          now: () => at,
          assertActive: check,
        },
        false,
      );
      const account = await accountContentSnapshotFromBackup(
        portable,
        {
          appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
          profile: { displayName: null },
        },
        { schemaVersion: 3, includeCookingHistory: false },
        sha256,
      );
      return { portable, account };
    });
  const apply = (
    candidate: Immutable<AccountContentSnapshot>,
    before: Before,
    overrides: Partial<AccountContentCoreApplyOptions> = {},
  ) =>
    writer.transaction(
      async (session) =>
        applyAccountContentCore(session, ownerId, candidate, before.portable, before.account, {
          view,
          sha256,
          now: later,
          revision: await nextAccountContentApplyRevision(session),
          assertAccess: check,
          ...overrides,
        }),
      { kind: 'none' },
      check,
    );
  const ledger = () =>
    writer.transaction(async (session) => {
      const context = await readPinnedShoppingContextInSnapshot(session, {
        sha256,
        lookupExact: (ref) => projectContentLookup(lookups.get(key(ref)) ?? { kind: 'missing' }),
      });
      return readShoppingLedgerInSnapshot(session, context.options);
    });
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  const dump = () =>
    JSON.stringify(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
  const unrelated = () =>
    JSON.stringify(
      tables
        .filter(
          (name) =>
            ![
              'app_metadata',
              'state_revision',
              'favourite',
              'plan_occurrence',
              'plan_content_pin',
              'shopping_selection',
              'shopping_contribution',
              'shopping_group',
              'shopping_scope',
              'purchase_state',
              'saved_preference',
              'preference_state',
              'source_preference_link',
              'recipe_identity',
              'recipe_content_revision',
              'recipe_content_source',
            ].includes(name),
        )
        .map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]),
    );
  const seed = async (selected = true) => {
    const before = await capture(),
      candidate = mutable(before.account);
    const ids = [randomUUID(), randomUUID()];
    for (const [index, ref] of [first.revision.ref, second.revision.ref].entries()) {
      candidate.plan.push({
        occurrenceId: ids[index]!,
        recipeId: ref.recipeId,
        placement: { actualDate: index ? '2026-10-15' : '2026-10-01', mealKey: 'dinner' },
        createdAt: at,
        updatedAt: at,
      });
      candidate.planReferences.push({ occurrenceId: ids[index]!, contentRef: copy(ref) });
    }
    if (selected) candidate.shopping.selectedOccurrenceIds = ids;
    await apply(candidate, before);
    return ids;
  };
  return {
    ...storage,
    db,
    writer,
    view,
    head,
    first,
    second,
    third,
    lookups,
    capture,
    apply,
    ledger,
    dump,
    unrelated,
    seed,
    conversationId,
    expire: () => {
      live = false;
    },
    revoke: () => {
      access = false;
    },
  };
}

test('private8 identical core advances only store/apply epoch and leaves other durable records intact', async (t) => {
  const f = await fixture(t),
    before = await f.capture(),
    unrelated = f.unrelated();
  const result = await f.apply(before.account, before);
  assert.deepEqual(result, { revision: 2, collections: [] });
  assert.equal(
    f.db.prepare("SELECT revision FROM state_revision WHERE collection='store'").get()!.revision,
    2,
  );
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(ACCOUNT_APPLY_EPOCH_KEY)!.value,
    '2',
  );
  assert.equal(f.unrelated(), unrelated);
});

test('private8 adds two exact revisions of one authored recipe across weeks without fake source locators', async (t) => {
  const f = await fixture(t),
    unrelated = f.unrelated(),
    ids = await f.seed();
  const ledger = await f.ledger();
  assert.equal(
    ledger.snapshot.groups.find((row) => row.displayName === 'Salt')!.quantityLabel,
    '300 g',
  );
  assert.equal(
    ledger.snapshot.groups.find((row) => row.displayName === 'Oil')!.quantityLabel,
    '2 tbsp',
  );
  assert.deepEqual(new Set(ledger.snapshot.scope.occurrenceIds), new Set(ids));
  assert.deepEqual(
    new Set(
      f.db
        .prepare('SELECT revision_id FROM plan_content_pin')
        .all()
        .map((row) => row.revision_id),
    ),
    new Set(['core-first', 'core-second']),
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM recipe WHERE recipe_id=?').get(authoredId)!.n,
    0,
  );
  assert.equal(f.unrelated(), unrelated);
});

test('private8 slot swaps preserve occurrence IDs/created dates and exact refs while replacing pins atomically', async (t) => {
  const f = await fixture(t);
  await f.seed();
  const before = await f.capture(),
    candidate = mutable(before.account),
    first = candidate.plan[0]!,
    second = candidate.plan[1]!;
  [first.placement, second.placement] = [second.placement, first.placement];
  first.updatedAt = later;
  second.updatedAt = later;
  const result = await f.apply(candidate, before);
  assert.deepEqual(result.collections, ['plan', 'shopping']);
  const actual = await f.capture();
  assert.deepEqual(actual.account.plan, candidate.plan);
  assert.deepEqual(actual.account.planReferences, candidate.planReferences);
  assert.ok(
    actual.portable.data.occurrences.every(
      (row) => row.revision === result.revision && row.createdAt === at,
    ),
  );
  assert.equal(
    (await f.ledger()).snapshot.groups.find((row) => row.displayName === 'Salt')!.quantityLabel,
    '300 g',
  );
});

test('private8 revision-only plan changes rebuild exact demand and preserve purchase marks only on matching grouping/fingerprint', async (t) => {
  const f = await fixture(t);
  const ids = await f.seed();
  f.db.exec('UPDATE purchase_state SET purchased=1,changed=0');
  const before = await f.capture(),
    candidate = mutable(before.account);
  candidate.planReferences.find((row) => row.occurrenceId === ids[0])!.contentRef = copy(
    f.second.revision.ref,
  );
  const result = await f.apply(candidate, before);
  assert.deepEqual(result.collections, ['plan', 'shopping']);
  const after = await f.ledger(),
    salt = after.snapshot.groups.find((row) => row.displayName === 'Salt')!,
    oil = after.snapshot.groups.find((row) => row.displayName === 'Oil')!;
  assert.equal(salt.quantityLabel, '400 g');
  assert.equal(salt.purchased, false);
  assert.equal(salt.changed, true);
  assert.equal(oil.purchased, true);
  assert.equal(oil.changed, false);
  f.db.exec('UPDATE purchase_state SET purchased=1,changed=0');
  const nextBefore = await f.capture(),
    next = mutable(nextBefore.account);
  next.planReferences.find((row) => row.occurrenceId === ids[0])!.contentRef = copy(
    f.third.revision.ref,
  );
  await f.apply(next, nextBefore);
  assert.ok((await f.ledger()).snapshot.groups.every((row) => row.purchased && !row.changed));
});

test('private8 unused withdrawn pins may remain or be removed, but new or selected withdrawn demand fails closed', async (t) => {
  const f = await fixture(t);
  await f.seed(false);
  for (const ref of [f.first.revision.ref, f.second.revision.ref, f.third.revision.ref])
    f.lookups.set(key(ref), {
      kind: 'withdrawn',
      recipeId: authoredId,
      reason: 'controlled withdrawal',
    });
  const before = await f.capture(),
    candidate = mutable(before.account);
  candidate.favourites.push({ recipeId: identityOnlyId, savedAt: at });
  await f.apply(candidate, before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM plan_content_pin').get()!.n, 2);
  const secondBefore = await f.capture(),
    selected = mutable(secondBefore.account);
  selected.shopping.selectedOccurrenceIds = [selected.plan[0]!.occurrenceId];
  const unchanged = f.dump();
  await assert.rejects(f.apply(selected, secondBefore));
  assert.equal(f.dump(), unchanged);
  const added = mutable(secondBefore.account),
    id = randomUUID();
  added.plan.push({
    occurrenceId: id,
    recipeId: authoredId,
    placement: { actualDate: '2026-10-20', mealKey: 'lunch' },
    createdAt: at,
    updatedAt: at,
  });
  added.planReferences.push({ occurrenceId: id, contentRef: copy(f.first.revision.ref) });
  await assert.rejects(f.apply(added, secondBefore));
  assert.equal(f.dump(), unchanged);
  const cleared = mutable(secondBefore.account);
  cleared.plan = [];
  cleared.planReferences = [];
  await f.apply(cleared, secondBefore);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM plan_content_pin').get()!.n, 0);
});

test('private8 favourites retain deletion rows and preference changes preserve raw values, source withdrawal and conversation markers', async (t) => {
  const f = await fixture(t),
    fav = catalogue.recipes[0]!.recipeId,
    removed = catalogue.recipes[1]!.recipeId,
    preferenceId = randomUUID(),
    unlinkedId = randomUUID(),
    messageId = randomUUID(),
    operationId = randomUUID();
  f.db.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(fav, at, at);
  f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run(removed, at, at);
  const raw = '  Avoid "nuts"\u0000\\ عربي  ';
  f.db
    .prepare('INSERT INTO saved_preference VALUES (?,?,?,1)')
    .run(preferenceId, 'ingredient_avoid', JSON.stringify(raw));
  f.db
    .prepare('INSERT INTO saved_preference VALUES (?,?,?,1)')
    .run(unlinkedId, 'cuisine', JSON.stringify('  Thai  '));
  f.db.exec("UPDATE state_revision SET revision=1 WHERE collection='preferences'");
  f.db
    .prepare('INSERT INTO operation_receipt VALUES (?,?,?,?,?,?,?)')
    .run(operationId, randomUUID(), 'a'.repeat(64), 'committed', at, 'unchanged', '[]');
  f.db
    .prepare('INSERT INTO message VALUES (?,?,0,0,?,?,?,?)')
    .run(
      messageId,
      f.conversationId,
      'user',
      JSON.stringify('Original immutable source'),
      'complete',
      at,
    );
  f.db
    .prepare('INSERT INTO source_preference_link VALUES (?,?,?,?,1,NULL,?)')
    .run(messageId, preferenceId, 'ingredient_avoid', JSON.stringify(raw), operationId);
  const before = await f.capture(),
    candidate = mutable(before.account),
    unrelated = f.unrelated();
  candidate.favourites = [{ recipeId: identityOnlyId, savedAt: at }];
  candidate.preferences = [
    { preferenceId, type: 'ingredient_like', value: '  Exact new "raw"\u0000  ' },
  ];
  const result = await f.apply(candidate, before);
  assert.deepEqual(result.collections, ['favourites', 'preferences', 'conversation']);
  assert.equal(f.db.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(fav)!.saved, 0);
  assert.equal(
    f.db.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(removed)!.saved,
    0,
  );
  assert.equal(
    f.db.prepare('SELECT value FROM saved_preference WHERE preference_id=?').get(preferenceId)!
      .value,
    JSON.stringify(candidate.preferences[0]!.value),
  );
  const link = f.db.prepare('SELECT value,removed_revision FROM source_preference_link').get()!;
  assert.equal(link.value, JSON.stringify(raw));
  assert.equal(link.removed_revision, result.revision);
  assert.equal(
    f.db.prepare('SELECT last_removal_revision FROM preference_state').get()!.last_removal_revision,
    result.revision,
  );
  assert.equal(f.unrelated(), unrelated);
});

test('private8 rejects stale core/reference/head, foreign owner and unknown identities without partial changes', async (t) => {
  const f = await fixture(t);
  await f.seed();
  const before = await f.capture();
  const candidate = mutable(before.account);
  candidate.favourites.push({ recipeId: identityOnlyId, savedAt: at });
  f.db.exec("UPDATE plan_occurrence SET updated_at='2026-10-01T14:00:00.000Z'");
  let prior = f.dump();
  await assert.rejects(f.apply(candidate, before), reason('local_changed'));
  assert.equal(f.dump(), prior);
  const fresh = await f.capture(),
    bad = mutable(fresh.account);
  bad.favourites.push({ recipeId: unknownId, savedAt: at });
  prior = f.dump();
  await assert.rejects(f.apply(bad, fresh));
  assert.equal(f.dump(), prior);
  f.db
    .prepare('UPDATE app_content_adoption SET head_json=?')
    .run(JSON.stringify({ ...f.head, fingerprint: 'b'.repeat(64) }));
  prior = f.dump();
  await assert.rejects(f.apply(fresh.account, fresh), reason('local_changed'));
  assert.equal(f.dump(), prior);
  f.db
    .prepare('UPDATE app_metadata SET value=? WHERE key=?')
    .run(JSON.stringify({ schemaVersion: 1, ownerId: otherOwner }), ACCOUNT_BINDING_KEY);
  let payloadReads = 0;
  const all = f.connection.all;
  f.connection.all = async (sql, values) => {
    if (/FROM favourite|FROM plan_occurrence|FROM recipe_note/.test(sql) && !sql.includes('MAX('))
      payloadReads++;
    return all(sql, values);
  };
  await assert.rejects(f.apply(fresh.account, fresh), reason('different_data_owner'));
  assert.equal(payloadReads, 0);
});

test('private8 owns all candidate/capture/options before hash awaits and rejects hostile or checksum-corrupt evidence', async (t) => {
  const f = await fixture(t),
    before = await f.capture(),
    candidate = mutable(before.account);
  candidate.favourites = [{ recipeId: identityOnlyId, savedAt: at }];
  const expected = copy(candidate),
    portable = portableCopy(before.portable),
    account = mutable(before.account),
    options: AccountContentCoreApplyOptions = {
      view: f.view,
      sha256,
      now: later,
      revision: 2,
      assertAccess: () => undefined,
    };
  options.sha256 = async (text) => {
    candidate.favourites = [];
    portable.sourceRevision = 999;
    account.preferences = [];
    options.revision = 999;
    options.now = 'invalid';
    return sha256(text);
  };
  await f.writer.transaction((session) =>
    applyAccountContentCore(session, ownerId, candidate, portable, account, options),
  );
  assert.deepEqual((await f.capture()).account.favourites, expected.favourites);
  const fresh = await f.capture(),
    corrupt = portableCopy(fresh.portable);
  corrupt.integrity.digest = 'f'.repeat(64);
  const prior = f.dump();
  await assert.rejects(f.apply(fresh.account, { ...fresh, portable: corrupt }));
  assert.equal(f.dump(), prior);
  let called = 0;
  const hostile = {
    ...mutable(fresh.account),
    get plan() {
      called++;
      return [];
    },
  };
  await assert.rejects(f.apply(hostile, fresh));
  assert.equal(called, 0);
  assert.equal(f.dump(), prior);
});

test('private8 global allocator reads typed bounded clocks only, enforces exhaustion and rejects stale caller revision', async (t) => {
  const f = await fixture(t);
  f.db.exec('UPDATE personal_state SET revision=45');
  f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(ACCOUNT_APPLY_EPOCH_KEY, '61');
  assert.equal(await f.writer.transaction(nextAccountContentApplyRevision), 62);
  const before = await f.capture(),
    prior = f.dump();
  await assert.rejects(f.apply(before.account, before, { revision: 61 }), reason('local_changed'));
  assert.equal(f.dump(), prior);
  f.db.prepare('UPDATE personal_state SET revision=?').run(Number.MAX_SAFE_INTEGER);
  await assert.rejects(f.writer.transaction(nextAccountContentApplyRevision));
  f.db.exec(
    "PRAGMA ignore_check_constraints=ON;UPDATE personal_state SET revision='not-an-integer'",
  );
  await assert.rejects(
    f.writer.transaction(nextAccountContentApplyRevision),
    reason('stored_data_invalid'),
  );
});

test('private8 bounded source admission rejects NUL-suffixed oversized fields before raw reads', async (t) => {
  const f = await fixture(t),
    before = await f.capture();
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db
    .prepare('INSERT INTO saved_preference VALUES (?,?,?,1)')
    .run(randomUUID() + '\u0000' + 'x'.repeat(100000), 'cuisine', JSON.stringify('Thai'));
  let reads = 0;
  const all = f.connection.all;
  f.connection.all = async (sql, values) => {
    if (sql.includes('SELECT preference_id AS')) reads++;
    return all(sql, values);
  };
  await assert.rejects(f.apply(before.account, before));
  assert.equal(reads, 0);
});

test('private8 midwrite, reservation expiry and caller final commit failure roll back pins, purchases and all receipts', async (t) => {
  for (const mode of ['insertion', 'reservation', 'commit'] as const) {
    const f = await fixture(t);
    await f.seed();
    const before = await f.capture(),
      candidate = mutable(before.account),
      prior = f.dump();
    candidate.planReferences[0]!.contentRef = copy(f.third.revision.ref);
    const prepare = f.connection.prepare;
    if (mode !== 'commit')
      f.connection.prepare = async (sql) => {
        const statement = await prepare(sql);
        if (sql.startsWith('INSERT INTO plan_content_pin'))
          return {
            ...statement,
            run: async (values) => {
              await statement.run(values);
              if (mode === 'insertion') throw new Error('injected pin failure');
              f.expire();
            },
          };
        return statement;
      };
    if (mode === 'commit')
      await assert.rejects(
        f.writer.transaction(
          async (session) =>
            applyAccountContentCore(session, ownerId, candidate, before.portable, before.account, {
              view: f.view,
              sha256,
              now: later,
              revision: await nextAccountContentApplyRevision(session),
              assertAccess: () => undefined,
            }),
          { kind: 'none' },
          () => {
            throw new Error('final owner guard');
          },
        ),
        /final owner guard/,
      );
    else
      await assert.rejects(
        f.apply(candidate, before),
        mode === 'insertion' ? /injected pin failure/ : /reservation expired/,
      );
    assert.equal(f.dump(), prior);
    assert.equal(f.statementCounts().prepared, f.statementCounts().finalized);
  }
});

test('private8 retained favourite removals cannot push the committed projection beyond its bound', async (t) => {
  const f = await fixture(t),
    identity = f.db.prepare('INSERT INTO recipe_identity VALUES (?)'),
    insert = f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)');
  for (let index = 0; index < 10000; index++) {
    const id = String(800000 + index);
    identity.run(id);
    insert.run(id, at, at);
  }
  const before = await f.capture(),
    candidate = mutable(before.account),
    prior = f.dump();
  candidate.favourites.push({ recipeId: identityOnlyId, savedAt: at });
  await assert.rejects(f.apply(candidate, before));
  assert.equal(f.dump(), prior);
});

test('private8 rejects remote favourite revival from a live-only base before any writes', async (t) => {
  const f = await fixture(t),
    recipeId = catalogue.recipes[0]!.recipeId;
  f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run(recipeId, at, later);
  const before = await f.capture(),
    candidate = mutable(before.account),
    prior = f.dump();
  assert.equal(before.account.favourites.length, 0);
  candidate.favourites.push({ recipeId, savedAt: at }, { recipeId: identityOnlyId, savedAt: at });
  const prepared = f.statementCounts().prepared;
  await assert.rejects(f.apply(candidate, before), reason('recovery_required'));
  assert.equal(f.dump(), prior);
  assert.equal(f.statementCounts().prepared, prepared);
  assert.equal((await f.apply(before.account, before)).collections.length, 0);
});

test('private8 retained source-link removals block same-ID and equivalent-value revival without erasing source evidence', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID(),
    messageId = randomUUID(),
    operationId = randomUUID(),
    raw = '  Avoid "nuts"\u0000  ';
  f.db
    .prepare('INSERT INTO operation_receipt VALUES (?,?,?,?,?,?,?)')
    .run(operationId, randomUUID(), 'a'.repeat(64), 'committed', at, 'unchanged', '[]');
  f.db
    .prepare('INSERT INTO message VALUES (?,?,0,0,?,?,?,?)')
    .run(messageId, f.conversationId, 'user', JSON.stringify('Original source'), 'complete', at);
  f.db
    .prepare('INSERT INTO source_preference_link VALUES (?,?,?,?,1,2,?)')
    .run(messageId, preferenceId, 'ingredient_avoid', JSON.stringify(raw), operationId);
  f.db.exec(
    "UPDATE preference_state SET last_removal_revision=2;UPDATE state_revision SET revision=2 WHERE collection='preferences'",
  );
  const before = await f.capture(),
    prior = f.dump();
  assert.equal(before.account.preferences.length, 0);
  assert.equal(before.portable.data.preferences.removals.length, 1);
  for (const preference of [
    { preferenceId, type: 'cuisine' as const, value: 'Different' },
    { preferenceId: randomUUID(), type: 'ingredient_avoid' as const, value: raw },
  ]) {
    const candidate = mutable(before.account);
    candidate.preferences = [preference];
    await assert.rejects(f.apply(candidate, before), reason('recovery_required'));
    assert.equal(f.dump(), prior);
  }
});

test('private8 global-only removal marker blocks new/changed preferences but preserves unchanged live and deletion-only transitions', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID();
  f.db
    .prepare('INSERT INTO saved_preference VALUES (?,?,?,3)')
    .run(preferenceId, 'cuisine', JSON.stringify('  Thai  '));
  f.db.exec(
    "UPDATE preference_state SET last_removal_revision=2;UPDATE state_revision SET revision=3 WHERE collection='preferences'",
  );
  const before = await f.capture(),
    prior = f.dump();
  assert.equal(before.portable.data.preferences.removals.length, 0);
  for (const preference of [
    { preferenceId: randomUUID(), type: 'cuisine' as const, value: 'New' },
    { preferenceId, type: 'cuisine' as const, value: 'Changed' },
  ]) {
    const candidate = mutable(before.account);
    candidate.preferences = [preference];
    await assert.rejects(f.apply(candidate, before), reason('recovery_required'));
    assert.equal(f.dump(), prior);
  }
  assert.deepEqual((await f.apply(before.account, before)).collections, []);
  const fresh = await f.capture(),
    deleted = mutable(fresh.account);
  deleted.preferences = [];
  assert.deepEqual((await f.apply(deleted, fresh)).collections, ['preferences']);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saved_preference').get()!.n, 0);
});

test('private8 retained restore archive blocks preference additions without hydrating archive bodies and allows unchanged live versions', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID();
  f.db
    .prepare('INSERT INTO saved_preference VALUES (?,?,?,1)')
    .run(preferenceId, 'cuisine', JSON.stringify('Thai'));
  f.db.exec("UPDATE state_revision SET revision=1 WHERE collection='preferences'");
  // Presence is deliberately sufficient; this primitive neither reads nor authenticates archives.
  f.db
    .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
    .run(randomUUID(), 'a'.repeat(64), '{"private":"before"}', '{"private":"imported"}', '{}');
  const before = await f.capture(),
    candidate = mutable(before.account),
    prior = f.dump();
  candidate.preferences.push({
    preferenceId: randomUUID(),
    type: 'ingredient_like',
    value: 'Lime',
  });
  const all = f.connection.all;
  let archiveReads = 0;
  f.connection.all = async (sql, values) => {
    if (
      /SELECT.*(?:before_json|imported_json|receipt_json).*FROM portable_restore_operation/i.test(
        sql,
      )
    ) {
      archiveReads++;
      throw new Error('Archive body must not be read');
    }
    return all(sql, values);
  };
  await assert.rejects(f.apply(candidate, before), reason('recovery_required'));
  assert.equal(f.dump(), prior);
  assert.equal(archiveReads, 0);
  assert.deepEqual((await f.apply(before.account, before)).collections, []);
  assert.equal(archiveReads, 0);
});
