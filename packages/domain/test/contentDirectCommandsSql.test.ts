import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledContentSnapshot,
  verifySignedContentOverlay,
  type EffectiveContentSnapshot,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import type { CommandResult, LocalCommand } from '@cookmate/contracts';
import type { DirectActionInput, DirectActionReview, Immutable, RepositoryResult } from '../src';
import { createContentDirectCommands } from '../../../apps/mobile/src/data/contentDirectCommands';
import { contentCommandSession } from '../../../apps/mobile/src/data/contentCommandContext';
import { retainVerifiedRevisionsInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import type {
  ContentReadingView,
  openContentReleaseStore,
} from '../../../apps/mobile/src/data/contentReleaseStore';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import { recoverInterruptedAssistantWork } from '../../../apps/mobile/src/data/assistantRecovery';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { member, published, signed } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z';
const recipeId = catalogue.recipes[0]!.recipeId;
const placement = (day: number) => ({
  actualDate: `2026-10-${String(day).padStart(2, '0')}`,
  mealKey: 'dinner' as const,
});
function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: { kind: string; error?: { messageKey: string } }, message?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (message) assert.equal(result.error?.messageKey, message);
}
function receipt(result: CommandResult) {
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail();
  return result.receipt;
}

async function fixture(
  t: TestContext,
  withInherited: boolean | 'receipt-only' = false,
  commandSchemaVersion: 7 | 8 = 7,
) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-host-'));
  const path = join(directory, 'cooking.db'),
    write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  t.after(async () => {
    await reader.close();
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
  const inherited: { command: Immutable<LocalCommand>; receipt: ReturnType<typeof receipt> }[] = [];
  if (withInherited) {
    const opened = await createLocalStore({
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
      openConnection: async () => desktopConnection(path).connection,
      platform: { sha256, newId: randomUUID },
      now: () => at,
      dateContext: () => ({
        localDate: '2026-10-01',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
    });
    assert.equal(opened.kind, 'ready');
    if (opened.kind !== 'ready') assert.fail();
    try {
      for (const input of [
        { kind: 'setFavourite', recipeId, saved: true },
        { kind: 'placeRecipe', recipeId, placement: placement(8) },
      ] as const) {
        const review = ready(await opened.services.commands.reviewDirect(input));
        const command = ready(await opened.services.commands.prepareDirect(review));
        inherited.push({
          command,
          receipt: receipt(await opened.services.commands.execute(command)),
        });
      }
    } finally {
      await opened.services.close();
    }
    if (withInherited === 'receipt-only') {
      // Original committed receipts with cleared command records. The actual
      // conversation-clear journey is separately exercised in migration tests.
      for (const item of inherited) {
        write.database
          .prepare('DELETE FROM direct_command_recovery WHERE operation_id=?')
          .run(item.command.operationId);
        write.database
          .prepare('DELETE FROM pending_intent WHERE user_intent_id=?')
          .run(item.command.userIntentId);
      }
    }
  }
  await migrateCookingContentDatabase(writer, { sha256 });
  if (commandSchemaVersion === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 0 };
  let head: OverlayHead | null = null,
    snapshot: EffectiveContentSnapshot | null = null;
  const faults = {
    contentUnavailable: false,
    wrongIdentity: false,
    afterContent: false,
    calls: 0,
    failedStatement: '',
    ackLost: false,
    afterCommit: undefined as (() => void) | undefined,
    beforeCommit: undefined as (() => void) | undefined,
  };
  writer.setObserver({
    async begin() {},
    async committed() {},
    failed() {},
    async beforeCommit() {
      const hook = faults.beforeCommit;
      faults.beforeCommit = undefined;
      hook?.();
    },
  });
  const exec = write.connection.exec,
    prepare = write.connection.prepare;
  write.connection.exec = async (sql) => {
    await exec(sql);
    if (sql === 'COMMIT') {
      const hook = faults.afterCommit;
      faults.afterCommit = undefined;
      hook?.();
      if (faults.ackLost) {
        faults.ackLost = false;
        throw new Error('Fixture lost COMMIT acknowledgement');
      }
    }
  };
  write.connection.prepare = async (sql) => {
    const statement = await prepare(sql);
    return {
      ...statement,
      async run(values) {
        if (faults.failedStatement && sql.startsWith(faults.failedStatement))
          throw new Error('Fixture failed mutation');
        await statement.run(values);
      },
    };
  };
  // Core-verified snapshots, controlled lifetime reservation. Real cross-database
  // signature/media locking is covered by the separate signed admin bridge suite.
  const contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReading'
  > = {
    async withVerifiedReading(expected, refs, callback) {
      faults.calls++;
      if (faults.contentUnavailable) throw new Error('Fixture unavailable content');
      assert.deepEqual(expected, head);
      for (const ref of refs)
        if (snapshot) assert.equal(snapshot.lookupExact(ref).kind, 'readable');
      let active = true;
      const view: ContentReadingView = {
        head,
        latestHead: head,
        snapshot:
          snapshot && faults.wrongIdentity
            ? { ...snapshot, identity: { ...snapshot.identity, fingerprint: 'f'.repeat(64) } }
            : snapshot,
        hasWithdrawal: false,
        assertActive() {
          assert.ok(active, 'Fixture reservation expired');
          return undefined;
        },
        async readPhoto() {
          throw new Error('Unused photo port');
        },
      };
      try {
        const value = await callback(view);
        if (faults.afterContent) throw new Error('Fixture reservation acknowledgement lost');
        return value;
      } finally {
        active = false;
      }
    },
  };
  const changes: unknown[] = [];
  const options = {
    reader,
    writer,
    contentStore,
    installationId: ids.installationId,
    platform: { sha256, newId: randomUUID },
    now: () => at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    getAccess: () => access,
    assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
      assert.deepEqual(access, scope);
      return undefined;
    },
    onCommitted(change: unknown) {
      changes.push(change);
    },
  };
  const create = (version?: 7 | 8) =>
    createContentDirectCommands({
      ...options,
      ...(version === undefined ? {} : { commandSchemaVersion: version }),
    });
  const host = create(commandSchemaVersion);
  async function command(day = 1, selected = host, id = recipeId) {
    const review = ready(
      await selected.reviewDirect({ kind: 'placeRecipe', recipeId: id, placement: placement(day) }),
    );
    return ready(await selected.prepareDirect(review));
  }
  function count(table: string) {
    return write.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
  }
  function bind(ownerId: string | null, generation: number) {
    access = { ownerId, authGeneration: generation };
    if (ownerId === null)
      write.database
        .prepare("DELETE FROM app_metadata WHERE key='account-replication:owner'")
        .run();
    else
      write.database
        .prepare("INSERT OR REPLACE INTO app_metadata VALUES ('account-replication:owner',?)")
        .run(JSON.stringify({ schemaVersion: 1, ownerId }));
  }
  async function authored() {
    const baseline = await createBundledContentSnapshot(sha256),
      publication = await published(authoredFixture('900000091'), 'host-first');
    const envelope = await signed({
      formatVersion: 2,
      releaseId: 'host-release-1',
      sequence: 1,
      previous: null,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: { ...catalogue.identity },
      entries: [member(publication)],
    });
    snapshot = await verifySignedContentOverlay(envelope, {
      sha256,
      baseline: { identity: { ...catalogue.identity }, revisions: baseline.revisions },
      expectedCurrent: null,
      minimumSequence: 0,
      readerVersion: 1,
      publications: [publication],
      retainedRefs: [],
      trustVerifier: {
        async verify(value) {
          return value.signature === 'synthetic_signature_no_crypto';
        },
      },
      mediaVerifier: {
        async verify() {
          return true;
        },
      },
      archive: {
        async readRelease() {
          return null;
        },
        async readPublication() {
          return null;
        },
      },
    });
    head = {
      releaseId: envelope.manifest.releaseId,
      sequence: 1,
      fingerprint: envelope.fingerprint,
    };
    write.database
      .prepare('UPDATE app_content_adoption SET revision=1,head_json=?')
      .run(JSON.stringify(head));
    return publication.revision.ref.recipeId;
  }
  return {
    host,
    create,
    command,
    count,
    bind,
    faults,
    write,
    read,
    writer,
    changes,
    ids,
    inherited,
    authored,
    getSnapshot: () => snapshot,
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
  };
}

test('schema8 favourite authored save/no-op/remove retains exact operation authority and survives host reopen', async (t) => {
  const f = await fixture(t, false, 8),
    id = await f.authored();
  const input = { kind: 'setFavourite', recipeId: id, saved: true } as const;
  const command = ready(await f.host.prepareDirect(ready(await f.host.reviewDirect(input))));
  const saved = receipt(await f.host.execute(command));
  assert.equal(saved.outcome, 'committed');
  assert.equal(
    f.write.database.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(id)!.saved,
    1,
  );
  const authority = JSON.parse(
    String(
      f.write.database
        .prepare('SELECT authority_json FROM content_command_authority WHERE operation_id=?')
        .get(command.operationId)!.authority_json,
    ),
  );
  assert.deepEqual(authority.recipeIds, [id]);
  const reopened = f.create(8);
  assert.deepEqual(ready(await reopened.recover(command)), saved);
  assert.deepEqual(receipt(await reopened.execute(command)), saved);
  const noop = ready(await reopened.prepareDirect(ready(await reopened.reviewDirect(input))));
  assert.equal(receipt(await reopened.execute(noop)).outcome, 'no_op');
  const remove = ready(
    await reopened.prepareDirect(ready(await reopened.reviewDirect({ ...input, saved: false }))),
  );
  assert.equal(receipt(await reopened.execute(remove)).outcome, 'committed');
  assert.equal(
    f.write.database.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(id)!.saved,
    0,
  );
  assert.equal(f.count('plan_occurrence'), 0);
  assert.equal(
    f.write.database
      .prepare('SELECT COUNT(*) n FROM recipe_content_revision WHERE recipe_id=?')
      .get(id)!.n,
    0,
  );
});

test('favourite saved receipt replays without content after lost SQL acknowledgement', async (t) => {
  const f = await fixture(t, false, 8),
    id = await f.authored();
  const command = ready(
    await f.host.prepareDirect(
      ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: true })),
    ),
  );
  f.faults.ackLost = true;
  const first = await f.host.execute(command);
  assert.ok(first.kind === 'receipt' || first.kind === 'uncertain');
  assert.equal(f.count('operation_receipt'), 1);
  f.faults.contentUnavailable = true;
  const saved = ready(await f.create(8).recover(command));
  assert.ok(saved);
  assert.deepEqual(receipt(await f.create(8).execute(command)), saved);
  assert.equal(f.count('operation_receipt'), 1);
  assert.equal(
    f.write.database.prepare('SELECT revision FROM favourite WHERE recipe_id=?').get(id)!.revision,
    1,
  );
});

test('saved identity removal needs no delivery during review, registration, execution, no-op or receipt replay', async (t) => {
  const f = await fixture(t, false, 8),
    id = await f.authored();
  const save = ready(
    await f.host.prepareDirect(
      ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: true })),
    ),
  );
  receipt(await f.host.execute(save));
  const calls = f.faults.calls;
  f.faults.contentUnavailable = true;
  const review = ready(
    await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: false }),
  );
  const remove = ready(await f.host.prepareDirect(review));
  const removed = receipt(await f.host.execute(remove));
  assert.equal(removed.outcome, 'committed');
  assert.equal(f.faults.calls, calls);
  const repeat = ready(
    await f.host.prepareDirect(
      ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: false })),
    ),
  );
  assert.equal(receipt(await f.host.execute(repeat)).outcome, 'no_op');
  assert.deepEqual(receipt(await f.create(8).execute(remove)), removed);
  assert.deepEqual(ready(await f.host.recover(remove)), removed);
  assert.equal(f.faults.calls, calls);
  failed(
    await f.host.reviewDirect({
      kind: 'setFavourite',
      recipeId: catalogue.recipes[0]!.recipeId,
      saved: false,
    }),
    'content.favourite_missing',
  );
  failed(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: true }));
  assert.equal(
    f.write.database.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(id)!.saved,
    0,
  );
});

test('body-free removal keeps owner and adoption fences before effects and recovery after lost acknowledgement', async (t) => {
  const f = await fixture(t, false, 8),
    id = await f.authored();
  receipt(
    await f.host.execute(
      ready(
        await f.host.prepareDirect(
          ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: true })),
        ),
      ),
    ),
  );
  f.faults.contentUnavailable = true;
  const review = ready(
    await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: false }),
  );
  f.write.database.exec('UPDATE app_content_adoption SET revision=revision+1');
  failed(await f.host.prepareDirect(review), 'content.direct_workspace_changed');
  const remove = ready(
    await f.host.prepareDirect(
      ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: false })),
    ),
  );
  f.faults.beforeCommit = () => f.setAccess(null);
  assert.equal((await f.host.execute(remove)).kind, 'uncertain');
  assert.equal(
    f.write.database.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(id)!.saved,
    1,
  );
  f.setAccess({ ownerId: null, authGeneration: 0 });
  f.faults.ackLost = true;
  const result = await f.host.execute(remove);
  assert.ok(result.kind === 'receipt' || result.kind === 'uncertain');
  const recovered = ready(await f.create(8).recover(remove));
  assert.ok(recovered);
  assert.equal(recovered.outcome, 'committed');
  assert.equal(
    f.write.database.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(id)!.saved,
    0,
  );
});

test('favourite commit followed by owner loss reports uncertainty and keeps the original receipt for its owner', async (t) => {
  const f = await fixture(t, false, 8),
    id = await f.authored();
  const command = ready(
    await f.host.prepareDirect(
      ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: true })),
    ),
  );
  f.faults.afterCommit = () => f.setAccess(null);
  const result = await f.host.execute(command);
  assert.equal(result.kind, 'uncertain');
  assert.equal(
    f.write.database.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(id)!.saved,
    1,
  );
  failed(await f.host.recover(command));
  f.setAccess({ ownerId: null, authGeneration: 0 });
  assert.ok(ready(await f.create(8).recover(command)));
  assert.equal(f.count('operation_receipt'), 1);
});

test('favourite owner loss and adoption changes prevent uncommitted effects but preserve recoverable evidence', async (t) => {
  for (const mutation of ['owner', 'adoption'] as const) {
    const f = await fixture(t, false, 8),
      id = await f.authored();
    const command = ready(
      await f.host.prepareDirect(
        ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: true })),
      ),
    );
    if (mutation === 'owner') f.setAccess(null);
    else f.write.database.exec('UPDATE app_content_adoption SET revision=revision+1');
    failed(await f.host.execute(command));
    assert.equal(f.count('favourite'), 0);
    assert.equal(f.count('operation_receipt'), 0);
    assert.equal(f.count('content_command_authority'), 1);
  }
});

test('failed favourite write rolls back neutral authenticated identity insertion and receipt', async (t) => {
  const f = await fixture(t, false, 8),
    id = await f.authored();
  const command = ready(
    await f.host.prepareDirect(
      ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId: id, saved: true })),
    ),
  );
  f.faults.failedStatement = 'INSERT INTO favourite';
  failed(await f.host.execute(command));
  assert.equal(f.count('operation_receipt'), 0);
  assert.equal(
    f.write.database.prepare('SELECT 1 FROM recipe_identity WHERE recipe_id=?').get(id),
    undefined,
  );
  f.faults.failedStatement = '';
  assert.equal(receipt(await f.host.execute(command)).outcome, 'committed');
});

test('new favourite host commands require explicit actual schema8 and real issued review', async (t) => {
  const old = await fixture(t),
    f = await fixture(t, false, 8);
  failed(
    await old.host.reviewDirect({ kind: 'setFavourite', recipeId, saved: true }),
    'content.direct_action_required',
  );
  failed(
    await f.create().reviewDirect({ kind: 'setFavourite', recipeId, saved: true }),
    'content.direct_action_required',
  );
  const review = ready(await f.host.reviewDirect({ kind: 'setFavourite', recipeId, saved: true }));
  failed(
    await f.host.prepareDirect(JSON.parse(JSON.stringify(review))),
    'content.direct_review_required',
  );
  f.write.database.exec('PRAGMA user_version=7');
  failed(await f.host.prepareDirect(review));
  assert.equal(f.count('command_slot'), 0);
  assert.equal(f.count('favourite'), 0);
});

test('global content recovery pages actual retained authority and acknowledges only settled notices', async (t) => {
  const f = await fixture(t),
    authoredId = await f.authored();
  const first = await f.command(1, f.host, authoredId),
    firstReceipt = receipt(await f.host.execute(first));
  const second = await f.command(2, f.host, authoredId),
    secondReceipt = receipt(await f.host.execute(second));
  const pending = await f.command(3, f.host, authoredId);
  f.faults.contentUnavailable = true;
  const calls = f.faults.calls;
  const a = ready(await f.host.readDirectRecovery({ limit: 1 }));
  assert.equal(a.entries.length, 1);
  assert.equal(a.entries[0]!.operationId, first.operationId);
  assert.deepEqual(a.entries[0]!.receipt, firstReceipt);
  assert.ok(a.nextAfterSequence);
  const b = ready(
    await f.host.readDirectRecovery({ afterSequence: a.nextAfterSequence!, limit: 1 }),
  );
  assert.equal(b.entries[0]!.operationId, second.operationId);
  assert.deepEqual(b.entries[0]!.receipt, secondReceipt);
  const c = ready(
    await f.host.readDirectRecovery({ afterSequence: b.nextAfterSequence!, limit: 1 }),
  );
  assert.equal(c.entries[0]!.operationId, pending.operationId);
  assert.equal(c.entries[0]!.outcome, 'unresolved');
  failed(await f.host.acknowledgeDirectRecovery(pending.operationId), 'command.outcome_unresolved');
  ready(await f.host.acknowledgeDirectRecovery(first.operationId));
  ready(await f.host.acknowledgeDirectRecovery(first.operationId));
  assert.equal(f.count('operation_receipt'), 2);
  assert.equal(f.count('content_command_authority'), 3);
  assert.equal(f.count('direct_command_recovery'), 2);
  assert.deepEqual(ready(await f.create().readReceipt(first.operationId)), firstReceipt);
  assert.equal(ready(await f.create().readReceipt(randomUUID())), null);
  assert.equal(
    f.faults.calls,
    calls,
    'Historical proof does not fetch withdrawn or unavailable content',
  );
});

test('global recovery preserves actual pre-migration favourite and Plan receipts beside new content records', async (t) => {
  const f = await fixture(t, true);
  const command = await f.command(),
    saved = receipt(await f.host.execute(command));
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  const entries = ready(await f.host.readDirectRecovery()).entries;
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((row) => row.commandKind),
    ['setFavourite', 'addPlan', 'addPlan'],
  );
  for (const item of f.inherited) {
    assert.deepEqual(ready(await f.host.readReceipt(item.command.operationId)), item.receipt);
    ready(await f.host.acknowledgeDirectRecovery(item.command.operationId));
    assert.deepEqual(ready(await f.create().readReceipt(item.command.operationId)), item.receipt);
  }
  assert.deepEqual(ready(await f.host.readReceipt(command.operationId)), saved);
  assert.equal(ready(await f.host.readDirectRecovery()).entries.length, 1);
  f.write.database
    .prepare('DELETE FROM content_command_authority WHERE operation_id=?')
    .run(command.operationId);
  failed(await f.host.readReceipt(command.operationId));
  failed(await f.host.readDirectRecovery());
  assert.equal(
    f.count('direct_command_recovery'),
    1,
    'Missing new authority is not treated as an inherited operation',
  );
});

test('global content recovery uses real schema8 and refuses corrupt settled outcome evidence', async (t) => {
  const f = await fixture(t);
  const command = await f.command(),
    saved = receipt(await f.host.execute(command));
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  assert.deepEqual(ready(await f.host.readReceipt(command.operationId)), saved);
  assert.equal(ready(await f.host.readDirectRecovery()).entries[0]!.outcome, 'receipt');
  f.write.database
    .prepare('DELETE FROM operation_receipt WHERE operation_id=?')
    .run(command.operationId);
  failed(await f.host.readDirectRecovery());
  failed(await f.host.readReceipt(command.operationId));
  failed(await f.host.acknowledgeDirectRecovery(command.operationId));
  assert.equal(f.count('direct_command_recovery'), 1);
});

test('inherited recovery rejects a changed embedded command fingerprint without altering original receipts', async (t) => {
  const f = await fixture(t, true);
  const item = f.inherited[0]!;
  const row = f.write.database
    .prepare('SELECT intent_json FROM pending_intent WHERE user_intent_id=?')
    .get(item.command.userIntentId)!;
  assert.equal(typeof row.intent_json, 'string');
  const intent = JSON.parse(row.intent_json as string);
  intent.slots[0].command.payloadFingerprint = 'f'.repeat(64);
  f.write.database
    .prepare('UPDATE pending_intent SET intent_json=? WHERE user_intent_id=?')
    .run(JSON.stringify(intent), item.command.userIntentId);
  failed(await f.host.readReceipt(item.command.operationId));
  failed(await f.host.readDirectRecovery());
  f.write.database
    .prepare('UPDATE pending_intent SET intent_json=? WHERE user_intent_id=?')
    .run(row.intent_json as string, item.command.userIntentId);
  assert.deepEqual(ready(await f.host.readReceipt(item.command.operationId)), item.receipt);
});

test('receipt-only migration provenance exposes exact retained results without inventing recovery commands', async (t) => {
  const f = await fixture(t, 'receipt-only');
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  f.faults.contentUnavailable = true;
  assert.equal(ready(await f.host.readDirectRecovery()).entries.length, 0);
  for (const item of f.inherited) {
    assert.deepEqual(ready(await f.host.readReceipt(item.command.operationId)), item.receipt);
    failed(await f.host.execute(item.command));
  }
  assert.equal(f.count('command_slot'), 0);
  assert.equal(f.count('operation_receipt'), f.inherited.length);
  const item = f.inherited[0]!;
  f.write.database
    .prepare('UPDATE operation_receipt SET committed_at=? WHERE operation_id=?')
    .run('2026-10-02T12:00:00.000Z', item.command.operationId);
  failed(await f.host.readReceipt(item.command.operationId));
  f.write.database
    .prepare('UPDATE operation_receipt SET committed_at=? WHERE operation_id=?')
    .run(item.receipt.committedAt, item.command.operationId);
  assert.deepEqual(ready(await f.create().readReceipt(item.command.operationId)), item.receipt);
  const foreignOwner = randomUUID();
  f.bind(foreignOwner, 1);
  f.setAccess({ ownerId: foreignOwner, authGeneration: 1 });
  failed(await f.create().readReceipt(item.command.operationId));
});

test('global content recovery keeps cancelled notices separate from saved receipts', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
  const entry = ready(await f.host.readDirectRecovery()).entries[0]!;
  assert.equal(entry.outcome, 'not_executed');
  assert.equal(entry.receipt, null);
  ready(await f.host.acknowledgeDirectRecovery(command.operationId));
  assert.equal(f.count('direct_command_recovery'), 0);
  assert.equal(f.count('operation_receipt'), 0);
  assert.equal(f.count('content_command_authority'), 1);
});

test('global recovery rejects foreign owner before command payloads and bounds oversized stored commands', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  receipt(await f.host.execute(command));
  f.bind(randomUUID(), 1);
  const other = f.create(),
    all = f.write.connection.all;
  let commandPayloadReads = 0;
  f.write.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    if (sql.includes('command_json')) commandPayloadReads++;
    return all<Row>(sql, values);
  };
  failed(await other.readDirectRecovery(), 'content.access_changed');
  failed(await other.readReceipt(command.operationId), 'content.access_changed');
  failed(await other.acknowledgeDirectRecovery(command.operationId), 'content.access_changed');
  assert.equal(commandPayloadReads, 0);
  assert.equal(f.count('direct_command_recovery'), 1);
  f.bind(null, 0);
  f.write.database
    .prepare('UPDATE command_slot SET command_json=? WHERE operation_id=?')
    .run(JSON.stringify({ private: 'x'.repeat(1024 * 1024) }), command.operationId);
  f.write.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    const rows = await all<Row>(sql, values);
    if (sql.includes('FROM command_slot WHERE operation_id=?') && sql.includes('command_json'))
      assert.ok(rows.every((row) => (row as { command: unknown }).command === null));
    return rows;
  };
  failed(await f.host.readDirectRecovery());
  failed(await f.host.acknowledgeDirectRecovery(command.operationId));
  assert.equal(f.count('direct_command_recovery'), 1);
});

test('global recovery owns bounded paging and guards acknowledgement at commit', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  receipt(await f.host.execute(command));
  for (const input of [
    { limit: 0 },
    { limit: 101 },
    { afterSequence: -1 },
    { limit: 1, unexpected: 1 },
  ])
    failed(await f.host.readDirectRecovery(input));
  failed(await f.host.readReceipt('invalid'));
  failed(await f.host.acknowledgeDirectRecovery('invalid'));
  f.faults.beforeCommit = () => f.setAccess(null);
  failed(await f.host.acknowledgeDirectRecovery(command.operationId));
  assert.equal(f.count('direct_command_recovery'), 1);
  f.bind(null, 0);
  f.faults.afterCommit = () => f.setAccess(null);
  failed(await f.host.acknowledgeDirectRecovery(command.operationId));
  assert.equal(f.count('direct_command_recovery'), 0);
  f.bind(null, 1);
  const reopened = f.create();
  assert.equal(ready(await reopened.readDirectRecovery()).entries.length, 0);
  assert.ok(ready(await reopened.readReceipt(command.operationId)));
});

test('global recovery stops reading private payloads immediately when access is revoked during SQL', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  receipt(await f.host.execute(command));
  const all = f.write.connection.all;
  let payloadReads = 0;
  f.write.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    if (sql.includes('command_json') || sql.includes('intent_json')) payloadReads++;
    const rows = await all<Row>(sql, values);
    if (sql.includes('FROM content_command_authority')) f.setAccess(null);
    return rows;
  };
  for (const run of [
    () => f.host.readReceipt(command.operationId),
    () => f.host.readDirectRecovery(),
    () => f.host.acknowledgeDirectRecovery(command.operationId),
  ]) {
    f.bind(null, 0);
    failed(await run(), 'content.access_changed');
  }
  assert.equal(payloadReads, 0);
  assert.equal(f.count('direct_command_recovery'), 1);
});

test('global recovery bounds corrupt store clocks and queues behind active writer settlement', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  receipt(await f.host.execute(command));
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const writer = f.writer.transaction(async () => {
    entered();
    await hold;
  });
  await started;
  let settled = false;
  const result = f.host.readDirectRecovery().then((value) => {
    settled = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await writer;
  assert.equal(ready(await result).entries.length, 1);
  f.write.database
    .prepare("UPDATE state_revision SET revision=? WHERE collection='store'")
    .run('x'.repeat(2 * 1024 * 1024) + '\0');
  const all = f.write.connection.all;
  f.write.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    const rows = await all<Row>(sql, values);
    if (sql.includes('FROM state_revision'))
      assert.ok(rows.every((row) => (row as { revision: unknown }).revision === null));
    return rows;
  };
  failed(await f.host.readDirectRecovery());
  failed(await f.host.readReceipt(command.operationId));
  failed(await f.host.acknowledgeDirectRecovery(command.operationId));
  assert.equal(f.count('direct_command_recovery'), 1);
});

test('explicit schema8 commands preserve exact authored pins and Shopping through add, move, replace and removal', async (t) => {
  const f = await fixture(t, false, 8);
  assert.equal(f.write.database.prepare('PRAGMA user_version').get()!.user_version, 8);
  const authoredId = await f.authored();
  const current = f.getSnapshot()!.lookupCurrent(authoredId);
  assert.equal(current.kind, 'readable');
  if (current.kind !== 'readable') assert.fail();
  const expected = current.value.revision.ref;
  async function act(input: DirectActionInput) {
    const review = ready(await f.host.reviewDirect(input));
    const command = ready(await f.host.prepareDirect(review));
    receipt(await f.host.execute(command));
    return command.command;
  }
  const first = await act({ kind: 'placeRecipe', recipeId: authoredId, placement: placement(1) });
  assert.equal(first.kind, 'addPlan');
  if (first.kind !== 'addPlan') assert.fail();
  const pin = () =>
    f.write.database
      .prepare(
        'SELECT recipe_id recipeId,revision_id revisionId,content_fingerprint contentFingerprint FROM plan_content_pin WHERE occurrence_id=?',
      )
      .get(first.occurrenceId);
  assert.deepEqual({ ...pin() }, expected);
  assert.equal(f.count('shopping_selection'), 0);
  await act({ kind: 'setShoppingSelection', occurrenceIds: [first.occurrenceId] });
  const group = f.write.database.prepare('SELECT group_key FROM shopping_contribution').get()!;
  assert.equal(typeof group.group_key, 'string');
  const groupKey = group.group_key as string;
  await act({ kind: 'setPurchased', groupKey, purchased: true });
  const purchase = () =>
    f.write.database.prepare('SELECT * FROM purchase_state WHERE group_key=?').get(groupKey);
  const marked = purchase();
  assert.equal(marked!.purchased, 1);
  const moved = await act({
    kind: 'placeRecipe',
    recipeId: authoredId,
    occurrenceId: first.occurrenceId,
    placement: placement(2),
  });
  assert.equal(moved.kind, 'editPlan');
  assert.deepEqual({ ...pin() }, expected);
  assert.deepEqual(
    purchase(),
    marked,
    'Moving the exact selected version does not change demand or the mark',
  );
  const source = f.write.database
    .prepare(
      'SELECT raw_name,raw_measure,revision_id,content_fingerprint FROM shopping_contribution',
    )
    .get()!;
  assert.equal(source.raw_name, 'Salt');
  assert.equal(source.raw_measure, null);
  assert.equal(source.revision_id, expected.revisionId);
  assert.equal(source.content_fingerprint, expected.contentFingerprint);

  const replaced = await act({ kind: 'placeRecipe', recipeId, placement: placement(2) });
  assert.equal(replaced.kind, 'replacePlanRecipe');
  assert.equal(pin()!.recipeId, recipeId);
  assert.notEqual(pin()!.contentFingerprint, expected.contentFingerprint);
  assert.equal(
    f.write.database.prepare('SELECT occurrence_id FROM shopping_selection').get()!.occurrence_id,
    first.occurrenceId,
  );
  assert.ok(
    f.write.database
      .prepare('SELECT recipe_id FROM shopping_contribution')
      .all()
      .every((row) => row.recipe_id === recipeId),
  );

  const second = await act({ kind: 'placeRecipe', recipeId: authoredId, placement: placement(3) });
  assert.equal(second.kind, 'addPlan');
  if (second.kind !== 'addPlan') assert.fail();
  await act({
    kind: 'setShoppingSelection',
    occurrenceIds: [first.occurrenceId, second.occurrenceId],
  });
  const displaced = await act({
    kind: 'placeRecipe',
    recipeId,
    occurrenceId: first.occurrenceId,
    placement: placement(3),
  });
  assert.equal(displaced.kind, 'movePlanReplacing');
  assert.equal(f.count('plan_occurrence'), 1);
  assert.equal(f.count('plan_content_pin'), 1);
  assert.equal(pin()!.recipeId, recipeId);
  assert.equal(f.count('shopping_selection'), 1);
  const removed = await act({ kind: 'removePlan', occurrenceId: first.occurrenceId });
  assert.equal(removed.kind, 'removePlan');
  assert.equal(f.count('plan_occurrence'), 0);
  assert.equal(f.count('plan_content_pin'), 0);
  assert.equal(f.count('shopping_selection'), 0);
  assert.equal(f.count('shopping_contribution'), 0);
  assert.deepEqual(f.write.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('schema8 requires explicit mutation opt-in and leaves the generic schema7 retention gate closed', async (t) => {
  const f = await fixture(t, false, 8);
  const authoredId = await f.authored();
  const defaultHost = f.create();
  failed(
    await defaultHost.reviewDirect({
      kind: 'placeRecipe',
      recipeId: authoredId,
      placement: placement(1),
    }),
  );
  assert.equal(f.count('content_command_authority'), 0);
  assert.equal(f.count('pending_intent'), 0);
  await assert.rejects(f.writer.transaction(async (session) => contentCommandSession(session)));
  await assert.rejects(
    f.writer.transaction(async (session) =>
      retainVerifiedRevisionsInSnapshot(session, f.getSnapshot()!, [], sha256),
    ),
  );
  assert.equal(f.count('plan_occurrence'), 0);
  assert.equal(f.count('operation_receipt'), 0);
  const command = await f.command(1, f.host, authoredId);
  receipt(await f.host.execute(command));
  assert.equal(f.count('plan_content_pin'), 1);
});

test('physical schema changes after review deny registration, while old schema7 receipts remain readable on8', async (t) => {
  const f = await fixture(t);
  const first = await f.command();
  const saved = receipt(await f.host.execute(first));
  const review = ready(
    await f.host.reviewDirect({ kind: 'placeRecipe', recipeId, placement: placement(2) }),
  );
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  failed(await f.host.prepareDirect(review));
  assert.equal(f.count('content_command_authority'), 1);
  assert.equal(f.count('command_slot'), 1);
  assert.deepEqual(ready(await f.host.readReceipt(first.operationId)), saved);
  assert.deepEqual(receipt(await f.host.execute(first)), saved);
  const explicit = f.create(8);
  const next = await f.command(2, explicit);
  receipt(await explicit.execute(next));
  assert.equal(f.count('plan_occurrence'), 2);
});

test('schema8 opt-in fails on physical7 and inherited schema6 commands cannot create new schema8 effects', async (t) => {
  const f = await fixture(t, true);
  failed(
    await f.create(8).reviewDirect({ kind: 'placeRecipe', recipeId, placement: placement(1) }),
  );
  assert.equal(f.count('content_command_authority'), 0);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  const host = f.create(8),
    prior = f.count('plan_occurrence');
  for (const item of f.inherited) {
    assert.deepEqual(ready(await host.readReceipt(item.command.operationId)), item.receipt);
    failed(await host.execute(item.command));
  }
  assert.equal(f.count('plan_occurrence'), prior);
  assert.equal(f.count('content_command_authority'), 0);
});

test('schema8 writes roll back exact retention and pins on SQL or final owner failure', async (t) => {
  const f = await fixture(t, false, 8),
    id = await f.authored();
  const command = await f.command(1, f.host, id);
  const retainedBefore = f.count('recipe_content_revision');
  assert.equal(typeof retainedBefore, 'number');
  if (typeof retainedBefore !== 'number') assert.fail();
  f.faults.failedStatement = 'INSERT INTO operation_receipt';
  failed(await f.host.execute(command));
  assert.equal(f.count('recipe_content_revision'), retainedBefore);
  assert.equal(f.count('plan_occurrence'), 0);
  assert.equal(f.count('plan_content_pin'), 0);
  assert.equal(f.count('operation_receipt'), 0);
  f.faults.failedStatement = '';
  f.faults.beforeCommit = () => f.setAccess(null);
  assert.equal((await f.host.execute(command)).kind, 'uncertain');
  assert.equal(f.count('recipe_content_revision'), retainedBefore);
  assert.equal(f.count('plan_content_pin'), 0);
  f.bind(null, 0);
  receipt(await f.host.execute(command));
  assert.equal(f.count('recipe_content_revision'), retainedBefore + 1);
  assert.equal(f.count('operation_receipt'), 1);
});

test('schema8 exact command lost COMMIT response recovers one durable receipt without reapplying', async (t) => {
  const f = await fixture(t, false, 8),
    id = await f.authored();
  const command = await f.command(1, f.host, id);
  f.faults.ackLost = true;
  const saved = receipt(await f.host.execute(command));
  assert.equal(f.writer.requiresRecovery(), true);
  f.host.close();
  f.faults.contentUnavailable = true;
  const host = f.create(8),
    calls = f.faults.calls;
  assert.deepEqual(ready(await host.recover(command)), saved);
  assert.deepEqual(receipt(await host.execute(command)), saved);
  assert.equal(f.faults.calls, calls);
  assert.equal(f.count('plan_occurrence'), 1);
  assert.equal(f.count('plan_content_pin'), 1);
  assert.equal(f.count('operation_receipt'), 1);
});

test('schema8 stale adoption, restore and owner fences reject pending writes before effects', async (t) => {
  const f = await fixture(t, false, 8);
  const command = await f.command();
  await f.authored();
  failed(await f.host.execute(command), 'content.direct_workspace_changed');
  const next = await f.command(2);
  f.write.database
    .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','1')")
    .run();
  failed(await f.host.execute(next), 'content.direct_workspace_changed');
  f.bind(randomUUID(), 1);
  failed(await f.host.execute(next), 'content.access_changed');
  assert.equal(f.count('operation_receipt'), 0);
  assert.equal(f.count('plan_content_pin'), 0);
  assert.equal(f.count('plan_occurrence'), 0);
});

test('registered command survives factory recreation; concurrent confirmation retains one operation', async (t) => {
  const f = await fixture(t);
  const review = ready(
    await f.host.reviewDirect({ kind: 'placeRecipe', recipeId, placement: placement(1) }),
  );
  const [a, b] = await Promise.all([f.host.prepareDirect(review), f.host.prepareDirect(review)]);
  const command = ready(a);
  assert.deepEqual(ready(b), command);
  assert.equal(f.count('content_command_authority'), 1);
  f.host.close();
  const reopened = f.create(),
    saved = receipt(await reopened.execute(command));
  assert.equal(f.count('plan_content_pin'), 1);
  assert.deepEqual(ready(await reopened.recover(command)), saved);
  assert.deepEqual(receipt(await reopened.execute(command)), saved);
  assert.equal(f.count('operation_receipt'), 1);
  assert.equal(f.changes.length, 1);
  assert.deepEqual(f.write.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('exact review is required; guest disappearance, owner switches and generation changes cannot authorize writes', async (t) => {
  const f = await fixture(t);
  const review = ready(
    await f.host.reviewDirect({ kind: 'placeRecipe', recipeId, placement: placement(1) }),
  );
  failed(
    await f.host.prepareDirect(JSON.parse(JSON.stringify(review)) as Immutable<DirectActionReview>),
    'content.direct_review_required',
  );
  f.setAccess(null);
  failed(await f.host.prepareDirect(review), 'content.access_changed');
  assert.throws(f.create);
  f.bind(null, 0);
  const command = ready(await f.host.prepareDirect(review));
  f.bind(null, 1);
  failed(await f.host.execute(command), 'content.access_changed');
  failed(await f.create().execute(command), 'content.direct_workspace_changed');
  const another = randomUUID();
  f.bind(another, 2);
  failed(await f.create().recover(command), 'content.access_changed');
  assert.equal(f.count('operation_receipt'), 0);
  assert.equal(f.count('plan_occurrence'), 0);
});

test('restore/adoption/installation guards fence new effects while genuine receipts remain owner-scoped historical evidence', async (t) => {
  const f = await fixture(t),
    owner = randomUUID();
  f.bind(owner, 1);
  const host = f.create(),
    first = await f.command(1, host),
    oldReceipt = receipt(await host.execute(first)),
    pending = await f.command(2, host);
  f.write.database
    .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','1')")
    .run();
  failed(await host.execute(pending), 'content.direct_workspace_changed');
  f.write.database.exec('UPDATE app_content_adoption SET revision=1');
  f.bind(owner, 2);
  const reopened = f.create();
  f.faults.contentUnavailable = true;
  const calls = f.faults.calls;
  assert.deepEqual(ready(await reopened.recover(first)), oldReceipt);
  assert.deepEqual(receipt(await reopened.execute(first)), oldReceipt);
  assert.equal(f.faults.calls, calls, 'receipt recovery must not reopen content');
  f.write.database
    .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
    .run(randomUUID());
  failed(await reopened.recover(first), 'content.access_changed');
  assert.equal(f.count('plan_occurrence'), 1);
});

test('stale selected-plan guard rejects registration and all unsupported/origin commands are blocked', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  receipt(await f.host.execute(command));
  assert.equal(command.command.kind, 'addPlan');
  if (command.command.kind !== 'addPlan') assert.fail();
  const review = ready(
    await f.host.reviewDirect({
      kind: 'setShoppingSelection',
      occurrenceIds: [command.command.occurrenceId],
    }),
  );
  f.write.database.exec("UPDATE state_revision SET revision=revision+1 WHERE collection='plan'");
  failed(await f.host.prepareDirect(review), 'shopping.reviewed_meals_changed');
  assert.equal(f.count('content_command_authority'), 1);
  failed(
    await f.host.reviewDirect({ kind: 'setFavourite', recipeId, saved: true }),
    'content.direct_action_required',
  );
  const origin = { conversationId: randomUUID(), generation: 0, messageId: randomUUID() };
  failed(await f.host.execute({ ...command, origin }), 'content.direct_command_required');
  const bad = {
    ...command,
    command: { kind: 'clearPreferences' as const, expectedPreferenceRevision: 0 },
  };
  failed(await f.host.execute(bad), 'content.direct_command_required');
});

test('registration acknowledgement loss retries the same operation without duplicate authority', async (t) => {
  const f = await fixture(t);
  const review = ready(
    await f.host.reviewDirect({ kind: 'placeRecipe', recipeId, placement: placement(1) }),
  );
  f.faults.afterContent = true;
  failed(await f.host.prepareDirect(review));
  f.faults.afterContent = false;
  assert.equal(f.count('content_command_authority'), 1);
  const stored = JSON.parse(
    f.write.database.prepare('SELECT command_json FROM command_slot').get()!.command_json as string,
  ) as LocalCommand;
  const retry = ready(await f.host.prepareDirect(review));
  assert.deepEqual(retry, stored);
  assert.equal(f.count('direct_command_recovery'), 1);
  receipt(await f.host.execute(retry));
});

test('mid-write failure and final owner-admission rejection roll back pins, receipts and effects', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  f.faults.failedStatement = 'INSERT INTO operation_receipt';
  failed(await f.host.execute(command));
  assert.equal(f.count('plan_occurrence'), 0);
  assert.equal(f.count('plan_content_pin'), 0);
  assert.equal(ready(await f.host.recover(command)), null);
  f.faults.failedStatement = '';
  f.faults.beforeCommit = () => f.setAccess(null);
  // The final guard runs after the transaction observer's asynchronous work.
  assert.equal((await f.host.execute(command)).kind, 'uncertain');
  assert.equal(f.count('operation_receipt'), 0);
  assert.equal(f.count('plan_occurrence'), 0);
  f.bind(null, 0);
  receipt(await f.host.execute(command));
});

test('cooking COMMIT ack loss reconciles independently; post-reservation failure preserves uncertainty', async (t) => {
  const f = await fixture(t),
    first = await f.command();
  const second = await f.command(2);
  f.faults.afterContent = true;
  assert.equal((await f.host.execute(second)).kind, 'uncertain');
  f.faults.afterContent = false;
  assert.ok(ready(await f.host.recover(second)));
  // Actual SQL acknowledgement loss poisons the writer; recovery remains read-only.
  f.faults.ackLost = true;
  const saved = receipt(await f.host.execute(first));
  assert.deepEqual(ready(await f.host.recover(first)), saved);
  assert.equal(f.count('operation_receipt'), 2);
  assert.equal(f.count('plan_occurrence'), 2);
});

test('owner drift during COMMIT suppresses returned receipt; a new same-owner host can recover it', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  f.faults.afterCommit = () => f.setAccess(null);
  assert.equal((await f.host.execute(command)).kind, 'uncertain');
  assert.equal(f.count('operation_receipt'), 1);
  failed(await f.host.recover(command), 'content.access_changed');
  assert.equal(f.changes.length, 0);
  f.bind(null, 1);
  assert.ok(ready(await f.create().recover(command)));
});

test('missing, noncanonical and oversized authority fails closed without backfilling or reading raw oversized payload', async (t) => {
  const f = await fixture(t);
  const review = ready(
      await f.host.reviewDirect({ kind: 'placeRecipe', recipeId, placement: placement(1) }),
    ),
    command = ready(await f.host.prepareDirect(review));
  const original = f.write.database
    .prepare('SELECT authority_json FROM content_command_authority')
    .get()!.authority_json as string;
  f.write.database.exec('DELETE FROM content_command_authority');
  failed(await f.host.prepareDirect(review), 'content.direct_evidence_invalid');
  assert.equal(f.count('content_command_authority'), 0);
  f.write.database
    .prepare('INSERT INTO content_command_authority VALUES (?,?,?)')
    .run(command.operationId, command.payloadFingerprint, ` ${original}`);
  failed(await f.host.execute(command), 'content.direct_evidence_invalid');
  f.write.database.exec('PRAGMA ignore_check_constraints=ON');
  f.write.database
    .prepare('UPDATE content_command_authority SET authority_json=?')
    .run(JSON.stringify({ private: 'x'.repeat(2 * 1024 * 1024) }));
  const all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, values);
    if (sql.includes('FROM content_command_authority'))
      assert.ok(rows.every((row) => (row as { json: unknown }).json === null));
    return rows;
  };
  failed(await f.host.recover(command), 'content.direct_evidence_invalid');
  assert.equal(f.count('operation_receipt'), 0);
});

test('authored receipt identities survive removal and later unavailable content without trusting arbitrary IDs', async (t) => {
  const f = await fixture(t),
    authoredId = await f.authored(),
    command = await f.command(1, f.host, authoredId);
  const saved = receipt(await f.host.execute(command));
  assert.equal(command.command.kind, 'addPlan');
  if (command.command.kind !== 'addPlan') assert.fail();
  const review = ready(
    await f.host.reviewDirect({ kind: 'removePlan', occurrenceId: command.command.occurrenceId }),
  );
  const removal = ready(await f.host.prepareDirect(review)),
    removed = receipt(await f.host.execute(removal));
  assert.equal(f.count('plan_occurrence'), 0);
  f.faults.contentUnavailable = true;
  const calls = f.faults.calls;
  assert.deepEqual(ready(await f.create().recover(command)), saved);
  assert.deepEqual(ready(await f.create().recover(removal)), removed);
  assert.equal(f.faults.calls, calls);
  const altered = JSON.parse(JSON.stringify(command)) as LocalCommand;
  if (altered.command.kind !== 'addPlan') assert.fail();
  altered.command.recipeId = '99999999999999999';
  failed(await f.create().recover(altered), 'command.fingerprint_mismatch');
});

test('catalogue identity is bound to its recorded head and cannot silently follow a newer adoption', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  const original = f.write.database
    .prepare('SELECT authority_json FROM content_command_authority')
    .get()!.authority_json as string;
  const saved = JSON.parse(original) as {
    catalogue: { version: string; fingerprint: string };
    head: OverlayHead | null;
    adoptionRevision: number;
  };
  saved.catalogue.fingerprint = 'f'.repeat(64);
  f.write.database
    .prepare('UPDATE content_command_authority SET authority_json=?')
    .run(canonicalContentJson(saved));
  const calls = f.faults.calls;
  failed(await f.host.execute(command), 'content.direct_evidence_invalid');
  assert.equal(f.faults.calls, calls, 'incoherent authority is rejected before reading any body');
  saved.catalogue = { ...catalogue.identity };
  await f.authored();
  saved.head = JSON.parse(
    f.write.database.prepare('SELECT head_json FROM app_content_adoption').get()!
      .head_json as string,
  ) as OverlayHead;
  saved.adoptionRevision = 1;
  f.write.database
    .prepare('UPDATE content_command_authority SET authority_json=?')
    .run(canonicalContentJson(saved));
  failed(await f.host.execute(command), 'content.direct_evidence_invalid');
  assert.equal(f.faults.calls, calls);
  assert.equal(f.count('plan_occurrence'), 0);
  assert.equal(f.count('operation_receipt'), 0);
});

test('registration and new effects require the exact verified context identity', async (t) => {
  const f = await fixture(t),
    id = await f.authored();
  const review = ready(
    await f.host.reviewDirect({ kind: 'placeRecipe', recipeId: id, placement: placement(1) }),
  );
  // Deliberately inconsistent test port: the signed envelope/head is unchanged,
  // while its projected catalogue identity is wrong. No host field is trusted alone.
  f.faults.wrongIdentity = true;
  failed(await f.host.prepareDirect(review), 'content.direct_evidence_invalid');
  assert.equal(f.count('content_command_authority'), 0);
  f.faults.wrongIdentity = false;
  const command = ready(await f.host.prepareDirect(review));
  f.faults.wrongIdentity = true;
  failed(await f.host.execute(command), 'content.direct_evidence_invalid');
  assert.equal(f.count('operation_receipt'), 0);
  assert.equal(f.count('plan_occurrence'), 0);
});

test('NUL-suffixed scalar corruption is rejected before raw byte allocation in shared readers', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  f.write.database.exec('PRAGMA ignore_check_constraints=ON');
  let oversizedMaterialized = false;
  for (const connection of [f.read.connection, f.write.connection]) {
    const all = connection.all;
    connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      const rows = await all<Row>(sql, values);
      if (
        rows.some((row) =>
          Object.values(row).some(
            (value: unknown) => typeof value === 'string' && value.length > 131072,
          ),
        )
      )
        oversizedMaterialized = true;
      return rows;
    };
  }
  const suffix = '\0' + 'x'.repeat(2 * 1024 * 1024);
  for (const [table, column] of [
    ['command_slot', 'slot_id'],
    ['pending_intent', 'phase'],
    ['content_command_authority', 'payload_fingerprint'],
  ] as const) {
    const original = f.write.database.prepare(`SELECT ${column} value FROM ${table}`).get()!
      .value as string;
    f.write.database.prepare(`UPDATE ${table} SET ${column}=?`).run(original + suffix);
    failed(await f.host.execute(command), 'content.direct_evidence_invalid');
    assert.equal(oversizedMaterialized, false, column);
    f.write.database.prepare(`UPDATE ${table} SET ${column}=?`).run(original);
  }
  receipt(await f.host.execute(command));
  for (const column of ['outcome', 'committed_at', 'shopping_projection'] as const) {
    const original = f.write.database
      .prepare(`SELECT ${column} value FROM operation_receipt`)
      .get()!.value as string;
    f.write.database.prepare(`UPDATE operation_receipt SET ${column}=?`).run(original + suffix);
    failed(await f.host.recover(command), 'content.direct_evidence_invalid');
    assert.equal(oversizedMaterialized, false, column);
    f.write.database.prepare(`UPDATE operation_receipt SET ${column}=?`).run(original);
  }
  assert.ok(ready(await f.host.recover(command)));
});

test('private single-slot intents reject foreign receipt membership before shared bulk reads or mutation', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  let bulkRead = false;
  const all = f.write.connection.all;
  f.write.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    if (
      sql.startsWith(
        'SELECT operation_id AS operationId FROM operation_receipt WHERE user_intent_id',
      )
    )
      bulkRead = true;
    return all<Row>(sql, values);
  };
  const insert = f.write.database.prepare('INSERT INTO operation_receipt VALUES (?,?,?,?,?,?,?)');
  insert.run(randomUUID(), command.userIntentId, 'a'.repeat(64), 'no_op', at, 'unchanged', '[]');
  failed(await f.host.execute(command), 'content.direct_evidence_invalid');
  assert.equal(bulkRead, false);
  for (let n = 0; n < 256; n++)
    insert.run(randomUUID(), command.userIntentId, 'a'.repeat(64), 'no_op', at, 'unchanged', '[]');
  failed(await f.host.execute(command), 'content.direct_evidence_invalid');
  assert.equal(bulkRead, false);
  assert.equal(f.count('plan_occurrence'), 0);
  f.write.database.exec('DELETE FROM operation_receipt');
  f.write.database
    .prepare('INSERT INTO command_slot VALUES (?,?,?,?,?)')
    .run(randomUUID(), command.userIntentId, 1, randomUUID(), JSON.stringify(command));
  failed(await f.host.execute(command), 'content.direct_evidence_invalid');
  assert.equal(f.count('operation_receipt'), 0);
  assert.equal(f.count('plan_occurrence'), 0);
});
