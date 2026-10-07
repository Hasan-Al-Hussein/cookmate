import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { AccountReplicationError, canonicalAccountHistory } from '@cookmate/account-sync';
import type { AccountCookingHistory, AccountCookingHistoryEntry } from '@cookmate/account-sync';
import { cookingContentIdentity } from '../src/cooking';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import {
  mergeAccountHistoryProjection,
  readAccountHistoryProjection,
} from '../../../apps/mobile/src/data/accountHistoryProjection';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const content = {
  catalogue: catalogue.identity,
  readRecipe: (id: string) => catalogue.recipes.find((recipe) => recipe.recipeId === id),
  sha256,
};
const failure = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;
async function entry(): Promise<AccountCookingHistoryEntry> {
  const recipe = catalogue.recipes[0]!;
  return {
    ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: '2026-10-01T12:00:00.000Z',
    note: 'Private test note',
  };
}
async function fixture() {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
  await initializeDatabase(
    writer,
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
  const bind = (owner = ownerId) =>
    storage.database
      .prepare(
        'INSERT INTO app_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId: owner }));
  bind();
  const apply = (history: AccountCookingHistory) =>
    writer.transaction((session) =>
      mergeAccountHistoryProjection(session, ownerId, history, content),
    );
  const read = () =>
    writer.transaction((session) => readAccountHistoryProjection(session, ownerId));
  return { ...storage, writer, bind, apply, read, close: () => writer.close() };
}

test('same-owner history preserves exact event identity and backup provenance without creating receipts', async () => {
  const f = await fixture();
  try {
    const original = await entry();
    const imported = { ...original, eventId: randomUUID(), origin: 'backup' as const };
    const first = await f.apply({ entries: [original, imported], removedEventIds: [] });
    assert.equal(first.changed, true);
    assert.equal(
      canonicalAccountHistory(first.history as AccountCookingHistory),
      canonicalAccountHistory({ entries: [original, imported], removedEventIds: [] }),
    );
    assert.ok(Object.isFrozen(first.history.entries[0]));
    assert.equal((await f.apply({ entries: [original], removedEventIds: [] })).changed, false);
    assert.equal((await f.read()).entries.length, 2); // omission never silently erases an event
    for (const table of [
      'cooking_event',
      'cooking_history_clear',
      'imported_cooking_history',
      'operation_receipt',
    ])
      assert.equal(f.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
    assert.deepEqual(
      f.database.prepare('SELECT * FROM cooking_state').get(),
      Object.assign(Object.create(null), {
        singleton: 1,
        session_revision: 0,
        history_revision: 0,
        history_epoch: 0,
      }),
    );
  } finally {
    await f.close();
  }
});

test('withdrawals are monotonic and stale peer history cannot revive an entry', async () => {
  const f = await fixture();
  try {
    const first = await entry();
    const second = await entry();
    await f.apply({ entries: [first], removedEventIds: [] });
    await f.apply({ entries: [], removedEventIds: [first.eventId] });
    await f.apply({ entries: [first, second], removedEventIds: [] });
    assert.deepEqual(
      (await f.read()).entries.map((item) => item.eventId),
      [second.eventId],
    );
    assert.deepEqual((await f.read()).removedEventIds, [first.eventId]);
    assert.equal(
      f.database
        .prepare('SELECT COUNT(*) AS n FROM account_cooking_history WHERE event_id=?')
        .get(first.eventId)!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('same event with different content fails before mutation and trusted recipe content must match', async () => {
  const f = await fixture();
  try {
    const first = await entry();
    await f.apply({ entries: [first], removedEventIds: [] });
    await assert.rejects(
      f.apply({ entries: [{ ...first, note: 'Changed immutable event' }], removedEventIds: [] }),
      failure('history_content_mismatch'),
    );
    for (const changed of [
      { ...first, eventId: randomUUID(), recipeTitle: 'Invented title' },
      { ...first, eventId: randomUUID(), photoKey: 'not-source-photo' },
      { ...first, eventId: randomUUID(), contentFingerprint: '0'.repeat(64) },
      {
        ...first,
        eventId: randomUUID(),
        catalogue: { ...first.catalogue, version: 'untrusted-archive' },
      },
    ])
      await assert.rejects(
        f.apply({ entries: [changed], removedEventIds: [] }),
        failure('history_content_mismatch'),
      );
    assert.deepEqual((await f.read()).entries, [first]);
  } finally {
    await f.close();
  }
});

test('owner binding and foreign contamination fail closed without reading or changing private payloads', async () => {
  const f = await fixture();
  try {
    const first = await entry();
    f.bind(otherOwner);
    await assert.rejects(
      f.apply({ entries: [first], removedEventIds: [] }),
      failure('different_data_owner'),
    );
    f.bind();
    f.database
      .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
      .run(otherOwner, randomUUID());
    await assert.rejects(f.read(), failure('different_data_owner'));
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS n FROM account_cooking_history').get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('a failed outer transaction rolls back withdrawal and projection changes together', async () => {
  const f = await fixture();
  try {
    const first = await entry();
    await f.apply({ entries: [first], removedEventIds: [] });
    await assert.rejects(
      f.writer.transaction(async (session) => {
        await mergeAccountHistoryProjection(
          session,
          ownerId,
          { entries: [], removedEventIds: [first.eventId] },
          content,
        );
        throw new Error('synthetic later apply failure');
      }),
      /synthetic later apply failure/,
    );
    assert.deepEqual((await f.read()).entries, [first]);
    assert.deepEqual((await f.read()).removedEventIds, []);
  } finally {
    await f.close();
  }
});

test('caller COMMIT admission prevents auth-generation change from committing data-only history', async () => {
  const f = await fixture();
  try {
    const first = await entry();
    let admitted = true;
    await assert.rejects(
      f.writer.transaction(
        async (session) => {
          await mergeAccountHistoryProjection(
            session,
            ownerId,
            { entries: [first], removedEventIds: [] },
            content,
          );
          admitted = false;
        },
        undefined,
        () => {
          if (!admitted) throw new AccountReplicationError('account_changed');
          return undefined;
        },
      ),
      failure('account_changed'),
    );
    assert.deepEqual((await f.read()).entries, []);
  } finally {
    await f.close();
  }
});

test('wire extras, row ceilings and byte ceilings reject the entire candidate without truncation', async () => {
  const f = await fixture();
  try {
    const first = await entry();
    await assert.rejects(
      f.apply({
        entries: [{ ...first, receipt: 'not-authority' }],
        removedEventIds: [],
      } as unknown as AccountCookingHistory),
      failure('invalid_input'),
    );
    await assert.rejects(
      f.apply({ entries: [], removedEventIds: Array.from({ length: 10001 }, () => randomUUID()) }),
      failure('invalid_input'),
    );
    const large = Array.from({ length: 2000 }, () => ({
      ...first,
      eventId: randomUUID(),
      note: 'x'.repeat(2000),
    }));
    await assert.rejects(f.apply({ entries: large, removedEventIds: [] }));
    assert.deepEqual((await f.read()).entries, []);
  } finally {
    await f.close();
  }
});

test('invalid persisted semantics and committed overlap are detected before export or retry', async () => {
  const f = await fixture();
  try {
    const first = await entry();
    f.database
      .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
      .run(ownerId, first.eventId, JSON.stringify({ ...first, timeZone: 'Not/AZone' }));
    await assert.rejects(f.read(), failure('stored_data_invalid'));
    f.database.prepare('DELETE FROM account_cooking_history').run();
    await f.apply({ entries: [first], removedEventIds: [] });
    f.database
      .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
      .run(ownerId, first.eventId);
    await assert.rejects(f.read(), failure('stored_data_invalid'));
  } finally {
    await f.close();
  }
});
