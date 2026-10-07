import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import type { Recipe } from '@cookmate/contracts';
import { cookingContentIdentity } from '../src/cooking';
import type {
  CookMateServices,
  RepositoryResult,
  SaveCookedInput,
  SaveCookingSessionInput,
} from '../src/index';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const timestamp = '2026-09-30T12:00:00.000Z';
const platform = {
  newId: randomUUID,
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
};
const recipe = catalogue.recipes.find((item) => item.instructions.length >= 3)!;
const other = catalogue.recipes.find((item) => item.recipeId !== recipe.recipeId)!;
function ready<T>(result: RepositoryResult<T> | { kind: 'uncertain' }): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
async function fixture(initial = { enablePortableRestore: true, enableCooking: true }) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-cooking-'));
  const filename = join(directory, 'store.db');
  const opened: CookMateServices[] = [];
  const connections: { mode: string; handle: ReturnType<typeof desktopConnection> }[] = [];
  let loseCommit = false;
  let failEvent = false;
  let failRead = false;
  let failMigration = false;
  let hashPause: { entered(): void; wait: Promise<void> } | null = null;
  const cookingPlatform = {
    ...platform,
    sha256: async (value: string) => {
      if (hashPause && value.startsWith('["save-cooked"')) {
        const paused = hashPause;
        hashPause = null;
        paused.entered();
        await paused.wait;
      }
      return platform.sha256(value);
    },
  };
  const open = async (flags = initial) =>
    createLocalStore({
      ...flags,
      platform: cookingPlatform,
      now: () => timestamp,
      dateContext: () => ({
        localDate: '2026-09-30',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      openConnection: async (mode) => {
        const handle = desktopConnection(filename);
        connections.push({ mode, handle });
        const originalExec = handle.connection.exec;
        handle.connection.exec = async (sql) => {
          await originalExec(sql);
          if (mode === 'write' && failMigration && sql.includes('CREATE TABLE cooking_state')) {
            failMigration = false;
            throw new Error('synthetic additive migration failure');
          }
          if (mode === 'write' && loseCommit && sql === 'COMMIT') {
            loseCommit = false;
            throw new Error('synthetic lost commit acknowledgement');
          }
        };
        const originalPrepare = handle.connection.prepare;
        handle.connection.prepare = async (sql) => {
          if (mode === 'write' && failEvent && sql.startsWith('INSERT INTO cooking_event')) {
            failEvent = false;
            throw new Error('synthetic event insert failure');
          }
          return originalPrepare(sql);
        };
        const originalAll = handle.connection.all;
        handle.connection.all = async <Row extends object>(
          sql: string,
          values?: readonly SqlValue[],
        ) => {
          if (
            mode === 'read' &&
            failRead &&
            (sql.includes('cooking_event') || sql.includes('cooking_history_clear'))
          )
            throw new Error('synthetic receipt read failure');
          return originalAll<Row>(sql, values);
        };
        return handle.connection;
      },
    });
  const result = await open();
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  let services = result.services;
  opened.push(services);
  return {
    get services() {
      return services;
    },
    get cooking() {
      assert.ok(services.cooking);
      return services.cooking;
    },
    get database() {
      return connections.filter((item) => item.mode === 'write').at(-1)!.handle.database;
    },
    async open(flags = initial) {
      const result = await open(flags);
      if (result.kind === 'ready') opened.push(result.services);
      return result;
    },
    async reopen(flags = initial) {
      await services.close();
      const result = await this.open(flags);
      assert.equal(result.kind, 'ready', JSON.stringify(result));
      if (result.kind !== 'ready') assert.fail();
      services = result.services;
    },
    loseCommit() {
      loseCommit = true;
    },
    failEvent() {
      failEvent = true;
    },
    failMigration() {
      failMigration = true;
    },
    failReads(enabled = true) {
      failRead = enabled;
    },
    pauseCookedHash() {
      let release!: () => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      hashPause = { entered, wait };
      return { reached, release };
    },
    async close() {
      await Promise.all(opened.map((item) => item.close()));
      await removeFixtureDirectory(directory);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function sessionInput(
  f: Fixture,
  recipeId = recipe.recipeId,
): Promise<SaveCookingSessionInput> {
  const view = ready(await f.cooking.readSession(recipeId));
  return {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    recipeId,
    expectedRevision: view.session?.revision ?? null,
    contentFingerprint: view.currentContent.contentFingerprint,
    readerVersion: 1,
    passageSequence: view.passageSequences[0]!,
  };
}
async function cookedInput(f: Fixture, recipeId = recipe.recipeId): Promise<SaveCookedInput> {
  const view = ready(await f.cooking.readSession(recipeId));
  const page = ready(await f.cooking.readHistory({ limit: 1 }));
  return {
    eventId: randomUUID(),
    recipeId,
    contentFingerprint: view.currentContent.contentFingerprint,
    readerVersion: 1,
    expectedHistoryEpoch: page.historyEpoch,
    cookedOn: '2026-09-30',
    timeZone: 'Asia/Dubai',
  };
}
function unaffected(f: Fixture) {
  return Object.fromEntries(
    [
      'favourite',
      'plan_occurrence',
      'shopping_scope',
      'shopping_selection',
      'shopping_group',
      'shopping_contribution',
      'purchase_state',
      'saved_preference',
      'source_preference_link',
      'message',
      'conversation',
      'operation_receipt',
      'app_metadata',
    ].map((name) => [name, f.database.prepare(`SELECT * FROM ${name}`).all()]),
  );
}

test('cooking rollout is explicit; v2→3→4 preserves existing state and rejects downgraded or future opens', async () => {
  const f = await fixture({ enablePortableRestore: false, enableCooking: false });
  try {
    assert.equal(f.services.cooking, undefined);
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 2);
    const before = unaffected(f);
    await f.reopen({ enablePortableRestore: true, enableCooking: false });
    assert.equal(f.services.cooking, undefined);
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 3);
    await f.reopen({ enablePortableRestore: true, enableCooking: true });
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.deepEqual(unaffected(f), before);
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
    const database = f.database;
    assert.equal(
      (await f.open({ enablePortableRestore: true, enableCooking: false })).kind,
      'failed',
    );
    assert.equal(
      (await f.open({ enablePortableRestore: false, enableCooking: true })).kind,
      'failed',
    );
    database.exec('PRAGMA user_version = 5');
    assert.equal(
      (await f.open({ enablePortableRestore: true, enableCooking: true })).kind,
      'failed',
    );
    assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 5);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM recipe').get()!.count, 100);
  } finally {
    await f.close();
  }
});

test('new v2 store can directly activate v4 and retains original recipe source text', async () => {
  const f = await fixture({ enablePortableRestore: false, enableCooking: false });
  try {
    const before = ready(await f.services.queries.readRecipe(recipe.recipeId));
    await f.reopen({ enablePortableRestore: true, enableCooking: true });
    assert.deepEqual(ready(await f.services.queries.readRecipe(recipe.recipeId)), before);
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 4);
  } finally {
    await f.close();
  }
});

test('failed additive migration rolls back its tables and version without deleting the v3 store', async () => {
  const f = await fixture({ enablePortableRestore: true, enableCooking: false });
  try {
    const database = f.database;
    const before = unaffected(f);
    f.failMigration();
    assert.equal(
      (await f.open({ enablePortableRestore: true, enableCooking: true })).kind,
      'failed',
    );
    assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 3);
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cooking_%'").all(),
      [],
    );
    for (const [table, rows] of Object.entries(before))
      assert.deepEqual(database.prepare(`SELECT * FROM ${table}`).all(), rows);
    assert.equal(
      (await f.open({ enablePortableRestore: true, enableCooking: true })).kind,
      'ready',
    );
  } finally {
    await f.close();
  }
});

test('session lost acknowledgement recovers its saved original-passage anchor and emits committed change', async () => {
  const f = await fixture();
  try {
    const input = await sessionInput(f);
    let notices = 0;
    const stop = f.cooking.subscribe((change) => {
      assert.equal(change.historyChanged, false);
      notices++;
    });
    f.loseCommit();
    const saved = ready(await f.cooking.saveSession(input));
    assert.equal(saved.lastOperationId, input.operationId);
    assert.equal(notices, 1);
    stop();
    await f.reopen();
    assert.deepEqual(ready(await f.cooking.readSession(recipe.recipeId)).session, saved);
  } finally {
    await f.close();
  }
});

test('reading content identity is deterministic, recipe-specific, and sensitive to original passages and quantities', async () => {
  const original = await cookingContentIdentity(recipe, catalogue.identity, platform.sha256);
  const changedCatalogue = await cookingContentIdentity(
    recipe,
    { version: 'different-bundle', fingerprint: 'b'.repeat(64) },
    platform.sha256,
  );
  assert.equal(original.contentFingerprint, changedCatalogue.contentFingerprint);
  const changed = JSON.parse(JSON.stringify(recipe)) as Recipe;
  changed.instructions[0]!.rawText += ' Source correction.';
  assert.notEqual(
    (await cookingContentIdentity(changed, catalogue.identity, platform.sha256)).contentFingerprint,
    original.contentFingerprint,
  );
  const quantity = JSON.parse(JSON.stringify(recipe)) as Recipe;
  quantity.ingredients[0]!.rawMeasure += ' more';
  assert.notEqual(
    (await cookingContentIdentity(quantity, catalogue.identity, platform.sha256))
      .contentFingerprint,
    original.contentFingerprint,
  );
  assert.notEqual(
    (await cookingContentIdentity(other, catalogue.identity, platform.sha256)).contentFingerprint,
    original.contentFingerprint,
  );
});

test('session progress survives reopen, anchors original passages, and does not mark cooked', async () => {
  const f = await fixture();
  try {
    const before = unaffected(f);
    assert.equal(ready(await f.cooking.readResumeSession()), null);
    const input = await sessionInput(f);
    input.passageSequence = recipe.instructions[1]!.sequence;
    const saved = ready(await f.cooking.saveSession(input));
    assert.equal(saved.passageSequence, input.passageSequence);
    assert.deepEqual(ready(await f.cooking.saveSession(input)), saved);
    await f.reopen();
    const view = ready(await f.cooking.readSession(recipe.recipeId));
    assert.equal(view.resume, 'matching');
    assert.deepEqual(view.session, saved);
    assert.deepEqual(
      view.passageSequences,
      recipe.instructions.map((item) => item.sequence),
    );
    assert.equal(ready(await f.cooking.readResumeSession())!.session!.sessionId, saved.sessionId);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, []);
    assert.deepEqual(unaffected(f), before);
  } finally {
    await f.close();
  }
});

test('session revisions reject delayed updates; dismiss/restart retains fencing and repeated operation IDs conflict', async () => {
  const f = await fixture();
  try {
    const first = await sessionInput(f);
    const saved = ready(await f.cooking.saveSession(first));
    const second = {
      ...first,
      operationId: randomUUID(),
      expectedRevision: saved.revision,
      passageSequence: recipe.instructions[1]!.sequence,
    };
    const advanced = ready(await f.cooking.saveSession(second));
    assert.equal((await f.cooking.saveSession(first)).kind, 'failed');
    assert.equal(
      (
        await f.cooking.saveSession({
          ...second,
          passageSequence: recipe.instructions[2]!.sequence,
        })
      ).kind,
      'failed',
    );
    assert.equal(
      (await f.cooking.saveSession({ ...second, operationId: randomUUID(), passageSequence: 999 }))
        .kind,
      'failed',
    );
    const dismiss = {
      operationId: randomUUID(),
      recipeId: recipe.recipeId,
      sessionId: first.sessionId,
      expectedRevision: advanced.revision,
    };
    const dismissed = ready(await f.cooking.dismissSession(dismiss));
    assert.deepEqual(ready(await f.cooking.dismissSession(dismiss)), dismissed);
    assert.equal(ready(await f.cooking.readResumeSession()), null);
    assert.equal(
      (
        await f.cooking.saveSession({
          ...first,
          operationId: randomUUID(),
          expectedRevision: dismissed.revision,
        })
      ).kind,
      'failed',
    );
    const restart = await sessionInput(f);
    const restarted = ready(await f.cooking.saveSession(restart));
    assert.ok(restarted.revision > dismissed.revision);
    assert.equal((await f.cooking.dismissSession(dismiss)).kind, 'failed');
    assert.equal(ready(await f.cooking.readSession(recipe.recipeId)).resume, 'matching');
  } finally {
    await f.close();
  }
});

test('changed content is visible and requires a deliberate new session, never a silent section remap', async () => {
  const f = await fixture();
  try {
    const saved = ready(await f.cooking.saveSession(await sessionInput(f)));
    const altered = { ...saved, contentFingerprint: 'd'.repeat(64) };
    f.database
      .prepare('UPDATE cooking_session SET session_json=? WHERE recipe_id=?')
      .run(JSON.stringify(altered), recipe.recipeId);
    assert.equal(ready(await f.cooking.readSession(recipe.recipeId)).resume, 'content_changed');
    assert.equal(ready(await f.cooking.readResumeSession())!.resume, 'content_changed');
    const input = await sessionInput(f);
    assert.equal(
      (await f.cooking.saveSession({ ...input, sessionId: saved.sessionId })).kind,
      'failed',
    );
    const restarted = ready(await f.cooking.saveSession(input));
    assert.notEqual(restarted.sessionId, saved.sessionId);
    assert.equal(ready(await f.cooking.readSession(recipe.recipeId)).resume, 'matching');
  } finally {
    await f.close();
  }
});

test('resume picks the latest active session in one bounded lookup and skips completed/dismissed sessions', async () => {
  const f = await fixture();
  try {
    const first = ready(await f.cooking.saveSession(await sessionInput(f)));
    const second = ready(await f.cooking.saveSession(await sessionInput(f, other.recipeId)));
    assert.equal(
      ready(await f.cooking.readResumeSession())!.currentContent.recipeId,
      other.recipeId,
    );
    ready(
      await f.cooking.dismissSession({
        operationId: randomUUID(),
        recipeId: other.recipeId,
        sessionId: second.sessionId,
        expectedRevision: second.revision,
      }),
    );
    assert.equal(ready(await f.cooking.readResumeSession())!.session!.sessionId, first.sessionId);
  } finally {
    await f.close();
  }
});

test('explicit cooked event atomically closes only the matching session and is idempotent after reopen', async () => {
  const f = await fixture();
  try {
    const before = unaffected(f);
    const saved = ready(await f.cooking.saveSession(await sessionInput(f)));
    const input = {
      ...(await cookedInput(f)),
      note: 'Private note: less salt next time.',
      session: { sessionId: saved.sessionId, expectedRevision: saved.revision },
    };
    const receipt = ready(await f.cooking.saveCooked(input));
    assert.equal(receipt.kind, 'saved');
    if (receipt.kind !== 'saved') assert.fail();
    assert.equal(receipt.event.recipeTitle, recipe.title);
    assert.equal(receipt.event.photoKey, recipe.photoKey);
    assert.equal(receipt.event.recordedAt, timestamp);
    assert.equal(receipt.event.cookedOn, '2026-09-30');
    assert.equal(receipt.closedSession!.state, 'completed');
    assert.equal(ready(await f.cooking.readSession(recipe.recipeId)).resume, 'none');
    await f.reopen();
    assert.deepEqual(ready(await f.cooking.saveCooked(input)), receipt);
    assert.deepEqual(ready(await f.cooking.readCookedReceipt(input.eventId)), receipt);
    assert.equal(ready(await f.cooking.readHistory()).items.length, 1);
    assert.equal((await f.cooking.saveCooked({ ...input, note: 'changed' })).kind, 'failed');
    assert.deepEqual(unaffected(f), before);
  } finally {
    await f.close();
  }
});

test('event insert failure rolls back the session close and all revisions', async () => {
  const f = await fixture();
  try {
    const saved = ready(await f.cooking.saveSession(await sessionInput(f)));
    const input = {
      ...(await cookedInput(f)),
      session: { sessionId: saved.sessionId, expectedRevision: saved.revision },
    };
    const before = f.database.prepare('SELECT * FROM cooking_state').all();
    f.failEvent();
    assert.equal((await f.cooking.saveCooked(input)).kind, 'failed');
    assert.deepEqual(ready(await f.cooking.readSession(recipe.recipeId)).session, saved);
    assert.deepEqual(f.database.prepare('SELECT * FROM cooking_state').all(), before);
    assert.equal(ready(await f.cooking.readCookedReceipt(input.eventId)), null);
    assert.equal(ready(await f.cooking.readHistory()).items.length, 0);
    ready(await f.cooking.saveCooked(input));
  } finally {
    await f.close();
  }
});

test('stale session completion fails without history side effects; no-session cooked save leaves active progress alone', async () => {
  const f = await fixture();
  try {
    const saved = ready(await f.cooking.saveSession(await sessionInput(f)));
    const input = await cookedInput(f);
    assert.equal(
      (
        await f.cooking.saveCooked({
          ...input,
          session: { sessionId: saved.sessionId, expectedRevision: saved.revision + 1 },
        })
      ).kind,
      'failed',
    );
    assert.equal(ready(await f.cooking.readHistory()).items.length, 0);
    ready(await f.cooking.saveCooked(input));
    assert.deepEqual(ready(await f.cooking.readSession(recipe.recipeId)).session, saved);
  } finally {
    await f.close();
  }
});

test('cooked event validates actual local dates, timezone, fingerprint and Unicode note bounds', async () => {
  const f = await fixture();
  try {
    const valid = await cookedInput(f);
    for (const changes of [
      { cookedOn: '2026-02-30' },
      { cookedOn: '2026-10-01' },
      { timeZone: 'Not/AZone' },
      { contentFingerprint: 'e'.repeat(64) },
      { note: 'x'.repeat(2001) },
      { readerVersion: 2 },
    ]) {
      assert.equal(
        (await f.cooking.saveCooked({ ...valid, ...changes } as SaveCookedInput)).kind,
        'failed',
      );
    }
    ready(await f.cooking.saveCooked({ ...valid, note: '🍲'.repeat(2000) }));
    assert.equal(ready(await f.cooking.readHistory()).items[0]!.note, '🍲'.repeat(2000));
  } finally {
    await f.close();
  }
});

test('history pages are bounded, stable and non-overlapping; clear invalidates old cursors', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++)
      ready(
        await f.cooking.saveCooked({ ...(await cookedInput(f)), cookedOn: `2026-09-${30 - i}` }),
      );
    const first = ready(await f.cooking.readHistory({ limit: 2 }));
    assert.deepEqual(
      first.items.map((item) => item.cookedOn),
      ['2026-09-30', '2026-09-29'],
    );
    const second = ready(await f.cooking.readHistory({ limit: 2, cursor: first.nextCursor! }));
    const third = ready(await f.cooking.readHistory({ limit: 2, cursor: second.nextCursor! }));
    assert.equal(
      new Set([...first.items, ...second.items, ...third.items].map((item) => item.eventId)).size,
      5,
    );
    assert.equal(third.nextCursor, null);
    assert.equal((await f.cooking.readHistory({ limit: 51 })).kind, 'failed');
    assert.equal((await f.cooking.readHistory({ cursor: '{}' })).kind, 'failed');
    ready(await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()));
    assert.equal((await f.cooking.readHistory({ cursor: first.nextCursor! })).kind, 'failed');
  } finally {
    await f.close();
  }
});

test('clear needs exact issued current review, redacts private history and permanently fences deleted IDs', async () => {
  const f = await fixture();
  try {
    const input = { ...(await cookedInput(f)), note: 'PRIVATE UNRETAINED NOTE' };
    ready(await f.cooking.saveCooked(input));
    const stale = ready(await f.cooking.reviewClearHistory());
    const delayed = await cookedInput(f);
    ready(await f.cooking.saveCooked(await cookedInput(f, other.recipeId)));
    assert.equal((await f.cooking.clearHistory(stale, randomUUID())).kind, 'failed');
    const review = ready(await f.cooking.reviewClearHistory());
    assert.equal((await f.cooking.clearHistory({ ...review }, randomUUID())).kind, 'failed');
    const operationId = randomUUID();
    const receipt = ready(await f.cooking.clearHistory(review, operationId));
    assert.equal(receipt.clearedCount, 2);
    assert.equal(receipt.historyEpoch, 1);
    assert.deepEqual(ready(await f.cooking.readHistory()).items, []);
    const rows = f.database.prepare('SELECT * FROM cooking_event').all();
    assert.ok(
      rows.every(
        (row) =>
          row.state === 'cleared' &&
          row.receipt_json === null &&
          row.request_fingerprint === null &&
          row.cooked_on === null &&
          row.recorded_at === null,
      ),
    );
    assert.equal(JSON.stringify(rows).includes('PRIVATE'), false);
    assert.equal(ready(await f.cooking.saveCooked(input)).kind, 'cleared');
    assert.equal(
      ready(await f.cooking.saveCooked({ ...input, expectedHistoryEpoch: 1 })).kind,
      'cleared',
    );
    assert.equal((await f.cooking.saveCooked(delayed)).kind, 'failed');
    await f.reopen();
    ready(await f.cooking.saveCooked(await cookedInput(f)));
    assert.deepEqual(ready(await f.cooking.clearHistory(review, operationId)), receipt);
    assert.deepEqual(ready(await f.cooking.readClearHistoryReceipt(operationId)), receipt);
    assert.equal(ready(await f.cooking.readHistory()).items.length, 1);
    assert.equal(ready(await f.cooking.readCookedReceipt(input.eventId))!.kind, 'cleared');
  } finally {
    await f.close();
  }
});

test('committed cooked/clear receipts recover lost acknowledgement and uncertainty remains honest when proof cannot be read', async () => {
  const f = await fixture();
  try {
    const input = await cookedInput(f);
    f.loseCommit();
    const receipt = ready(await f.cooking.saveCooked(input));
    assert.equal(receipt.kind, 'saved');
    await f.reopen();
    const review = ready(await f.cooking.reviewClearHistory());
    const clearId = randomUUID();
    f.loseCommit();
    assert.equal(ready(await f.cooking.clearHistory(review, clearId)).clearedCount, 1);
    await f.reopen();
    const uncertain = await cookedInput(f);
    f.loseCommit();
    f.failReads();
    assert.equal((await f.cooking.saveCooked(uncertain)).kind, 'uncertain');
    f.failReads(false);
    assert.equal(ready(await f.cooking.readCookedReceipt(uncertain.eventId))!.kind, 'saved');
    await f.reopen();
    assert.equal(ready(await f.cooking.readHistory()).items.length, 1);
  } finally {
    await f.close();
  }
});

test('portable format1 honestly excludes history/session/notes and v4 restore leaves them unchanged', async () => {
  const f = await fixture();
  try {
    const backup = ready(await f.services.queries.readPortableBackup());
    assert.equal(backup.databaseSchemaVersion, 4);
    ready(await f.cooking.saveSession(await sessionInput(f)));
    ready(
      await f.cooking.saveCooked({
        ...(await cookedInput(f)),
        note: 'not covered by portable format1',
      }),
    );
    const cookingBefore = Object.fromEntries(
      ['cooking_session', 'cooking_event', 'cooking_state'].map((table) => [
        table,
        f.database.prepare(`SELECT * FROM ${table}`).all(),
      ]),
    );
    const exported = ready(await f.services.queries.readPortableBackup());
    assert.equal(JSON.stringify(exported).includes('not covered'), false);
    assert.deepEqual(Object.keys(exported.data).sort(), [
      'favourites',
      'occurrences',
      'preferences',
      'shopping',
    ]);
    const restore = f.services.portableRestore!;
    const review = ready(await restore.review(JSON.stringify(backup)));
    assert.deepEqual(review.blockers, []);
    const result = await restore.execute(ready(await restore.prepare(review)));
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    for (const [table, rows] of Object.entries(cookingBefore))
      assert.deepEqual(f.database.prepare(`SELECT * FROM ${table}`).all(), rows);
    assert.equal(ready(await f.cooking.readHistory()).items.length, 1);
  } finally {
    await f.close();
  }
});

test('a pre-migration v3 facade fails closed on its very first later mutation', async () => {
  const f = await fixture({ enablePortableRestore: true, enableCooking: false });
  try {
    const legacy = f.services;
    const review = ready(
      await legacy.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: recipe.recipeId,
        saved: true,
      }),
    );
    const enabled = await f.open({ enablePortableRestore: true, enableCooking: true });
    assert.equal(enabled.kind, 'ready', JSON.stringify(enabled));
    if (enabled.kind !== 'ready') assert.fail();
    assert.equal((await legacy.commands.prepareDirect(review)).kind, 'failed');
    assert.equal(ready(await enabled.services.queries.readFavourites()).length, 0);
  } finally {
    await f.close();
  }
});

test('crash-before-dispatch cooked recovery durably cancels its ID without clearing or completing anything', async () => {
  const f = await fixture();
  try {
    const saved = ready(await f.cooking.saveSession(await sessionInput(f)));
    const input = {
      ...(await cookedInput(f)),
      session: { sessionId: saved.sessionId, expectedRevision: saved.revision },
    };
    const before = ready(await f.cooking.readHistory());
    assert.equal(ready(await f.cooking.readCookedReceipt(input.eventId)), null);
    await f.reopen();
    const cancelled = ready(await f.cooking.resolveCookedOperation(input.eventId));
    assert.deepEqual(cancelled, {
      kind: 'cancelled',
      eventId: input.eventId,
      historyEpoch: before.historyEpoch,
    });
    assert.deepEqual(ready(await f.cooking.readHistory()), before);
    assert.deepEqual(ready(await f.cooking.readSession(recipe.recipeId)).session, saved);
    await f.reopen();
    assert.deepEqual(ready(await f.cooking.readCookedReceipt(input.eventId)), cancelled);
    assert.deepEqual(ready(await f.cooking.saveCooked(input)), cancelled);
    assert.deepEqual(ready(await f.cooking.resolveCookedOperation(input.eventId)), cancelled);
    assert.deepEqual(ready(await f.cooking.readHistory()), before);
    const clearReview = ready(await f.cooking.reviewClearHistory());
    ready(await f.cooking.clearHistory(clearReview, randomUUID()));
    assert.equal(ready(await f.cooking.readCookedReceipt(input.eventId))!.kind, 'cancelled');
  } finally {
    await f.close();
  }
});

test('terminal cooked cancellation wins against a save still hashing before writer dispatch', async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  try {
    const input = await cookedInput(f);
    const paused = f.pauseCookedHash();
    release = paused.release;
    const pending = f.cooking.saveCooked(input);
    await paused.reached;
    const cancelled = ready(await f.cooking.resolveCookedOperation(input.eventId));
    paused.release();
    assert.equal(cancelled.kind, 'cancelled');
    assert.deepEqual(ready(await pending), cancelled);
    assert.equal(ready(await f.cooking.readHistory()).items.length, 0);
    await f.reopen();
    assert.deepEqual(ready(await f.cooking.saveCooked(input)), cancelled);
  } finally {
    release?.();
    await f.close();
  }
});

test('resolving existing cooked and clear commits returns their exact receipts instead of cancelling', async () => {
  const f = await fixture();
  try {
    const input = await cookedInput(f);
    const cooked = ready(await f.cooking.saveCooked(input));
    assert.deepEqual(ready(await f.cooking.resolveCookedOperation(input.eventId)), cooked);
    const operationId = randomUUID();
    const cleared = ready(
      await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), operationId),
    );
    assert.equal(cleared.outcome, 'cleared');
    await f.reopen();
    assert.deepEqual(ready(await f.cooking.resolveClearHistoryOperation(operationId)), cleared);
    assert.equal(ready(await f.cooking.resolveCookedOperation(input.eventId)).kind, 'cleared');
  } finally {
    await f.close();
  }
});

test('clear cancellation leaves epoch and entries unchanged, survives reopen and fences queued same-ID clears', async () => {
  const f = await fixture();
  try {
    ready(await f.cooking.saveCooked(await cookedInput(f)));
    const before = ready(await f.cooking.readHistory());
    const review = ready(await f.cooking.reviewClearHistory());
    const operationId = randomUUID();
    assert.equal(ready(await f.cooking.readClearHistoryReceipt(operationId)), null);
    const resolving = f.cooking.resolveClearHistoryOperation(operationId);
    const delayedClear = f.cooking.clearHistory(review, operationId);
    const receipt = ready(await resolving);
    assert.equal(receipt.outcome, 'cancelled');
    assert.equal(receipt.clearedCount, 0);
    assert.equal(receipt.previousHistoryEpoch, before.historyEpoch);
    assert.equal(receipt.historyEpoch, before.historyEpoch);
    assert.equal(receipt.historyRevision, before.historyRevision);
    assert.deepEqual(ready(await delayedClear), receipt);
    assert.deepEqual(ready(await f.cooking.readHistory()), before);
    await f.reopen();
    assert.deepEqual(ready(await f.cooking.readClearHistoryReceipt(operationId)), receipt);
    assert.deepEqual(ready(await f.cooking.clearHistory(review, operationId)), receipt);
    assert.deepEqual(ready(await f.cooking.readHistory()), before);
    assert.equal(
      ready(await f.cooking.resolveClearHistoryOperation(operationId)).outcome,
      'cancelled',
    );
    assert.equal(
      ready(await f.cooking.clearHistory(ready(await f.cooking.reviewClearHistory()), randomUUID()))
        .outcome,
      'cleared',
    );
  } finally {
    await f.close();
  }
});

test('noncommitted uncertain save can be terminally cancelled; cancellation lost-ack uses its durable proof', async () => {
  const f = await fixture();
  try {
    const input = await cookedInput(f);
    f.failEvent();
    f.failReads();
    assert.equal((await f.cooking.saveCooked(input)).kind, 'uncertain');
    f.failReads(false);
    assert.equal(ready(await f.cooking.readCookedReceipt(input.eventId)), null);
    f.loseCommit();
    const cancelled = ready(await f.cooking.resolveCookedOperation(input.eventId));
    assert.equal(cancelled.kind, 'cancelled');
    await f.reopen();
    assert.deepEqual(ready(await f.cooking.saveCooked(input)), cancelled);
    const clearId = randomUUID();
    f.loseCommit();
    f.failReads();
    assert.equal((await f.cooking.resolveClearHistoryOperation(clearId)).kind, 'uncertain');
    f.failReads(false);
    await f.reopen();
    const clearReceipt = ready(await f.cooking.resolveClearHistoryOperation(clearId));
    assert.equal(clearReceipt.outcome, 'cancelled');
    assert.equal(clearReceipt.historyRevision, 0);
    assert.equal(clearReceipt.historyEpoch, 0);
    assert.equal(ready(await f.cooking.readHistory()).items.length, 0);
  } finally {
    await f.close();
  }
});
