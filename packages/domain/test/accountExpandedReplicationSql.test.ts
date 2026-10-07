import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AccountRemoteError,
  AccountReplicationError,
  accountSnapshotsEqual,
  canonicalAccountHistory,
  createAccountScopeApprovalEvidence,
  createAccountSyncCoordinator,
} from '@cookmate/account-sync';
import type {
  AccountApplyInput,
  AccountCommitReceipt,
  AccountRemote,
  AccountRemoteState,
  AccountReplicationJournal,
  AccountReplicationScope,
  AccountSnapshot,
  AccountSnapshotV2,
} from '@cookmate/account-sync';
import type { DirectActionInput, PersonalCommand, RepositoryResult, SaveCookedInput } from '../src';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import type { LocalCookMateServices } from '../../../apps/mobile/src/data/localServices';
import { accountScopeApprovalKey } from '../../../apps/mobile/src/data/accountScopeApproval';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z';
const later = '2026-10-01T12:01:00.000Z';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const recipeId = '52835';
const otherRecipe = '52839';
const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const copy = <Value>(value: Value): Value => structuredClone(value);
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
const failure = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;
const server = (
  snapshot: AccountSnapshot | null = null,
  revision = snapshot ? 1 : 0,
): AccountRemoteState => ({
  ownerId,
  revision,
  snapshot,
  updatedAt: snapshot ? at : null,
  deletionOperationId: null,
});

/** Deliberately in-memory transport. Only the two local stores are real SQL databases. */
function simulatedRemote(initial = server()) {
  let state = copy(initial);
  let reads = 0;
  const commits: { operationId: string; expectedRevision: number; snapshot: AccountSnapshot }[] =
    [];
  const receipts = new Map<string, AccountCommitReceipt>();
  const remote: AccountRemote = {
    ownerId,
    read: async () => {
      reads++;
      return copy(state);
    },
    commit: async (input) => {
      const previous = receipts.get(input.operationId);
      if (previous) return copy(previous);
      if (input.expectedRevision !== state.revision) throw new AccountRemoteError('needs_review');
      commits.push(copy(input));
      const receipt = {
        ownerId,
        operationId: input.operationId,
        revision: state.revision + 1,
        committedAt: at,
      };
      state = server(copy(input.snapshot), receipt.revision);
      receipts.set(input.operationId, receipt);
      return copy(receipt);
    },
    delete: async () => {
      throw new Error('Deletion is outside this fixture');
    },
  };
  return {
    remote,
    commits,
    get reads() {
      return reads;
    },
    get state() {
      return copy(state);
    },
  };
}

async function fixture(enableExpandedScope = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-expanded-'));
  const filename = join(directory, 'store.db');
  let services: LocalCookMateServices;
  let write: ReturnType<typeof desktopConnection>;
  let scope: AccountReplicationScope = { ownerId, authGeneration: 1 };
  let failManualInsert = false,
    loseCommit = false;
  let onApplyWrite: (() => void) | null = null;
  const reads: string[] = [];
  async function open() {
    const result = await createLocalStore({
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
      accountReplication: {
        enableExpandedScope,
        currentScope: () => scope,
        getLocalSettings: () => ({
          appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
          profile: { displayName: null },
        }),
      },
      platform: { newId: randomUUID, sha256 },
      now: () => at,
      dateContext: () => ({
        localDate: '2026-10-01',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      openConnection: async (mode) => {
        const handle = desktopConnection(filename);
        if (mode === 'write') write = handle;
        const all = handle.connection.all;
        handle.connection.all = async (sql, values) => {
          reads.push(sql);
          return all(sql, values);
        };
        const exec = handle.connection.exec;
        handle.connection.exec = async (sql) => {
          await exec(sql);
          if (mode === 'write' && sql === 'COMMIT' && loseCommit) {
            loseCommit = false;
            throw new Error('injected lost local COMMIT response');
          }
        };
        const prepare = handle.connection.prepare;
        handle.connection.prepare = async (sql) => {
          const statement = await prepare(sql);
          return {
            finalize: () => statement.finalize(),
            run: async (values) => {
              if (
                mode === 'write' &&
                failManualInsert &&
                sql.startsWith('INSERT INTO manual_shopping_item')
              ) {
                failManualInsert = false;
                throw new Error('injected expanded apply failure');
              }
              await statement.run(values);
              if (mode === 'write' && onApplyWrite && sql.startsWith('UPDATE state_revision')) {
                const callback = onApplyWrite;
                onApplyWrite = null;
                callback();
              }
            },
          };
        };
        return handle.connection;
      },
    });
    assert.equal(result.kind, 'ready', JSON.stringify(result));
    if (result.kind !== 'ready') assert.fail();
    services = result.services;
    assert.ok(
      services.personal &&
        services.cooking &&
        services.accountReplication &&
        services.accountScopeApproval,
    );
  }
  await open();
  return {
    get services() {
      return services;
    },
    get database() {
      return write.database;
    },
    get scope() {
      return { ...scope };
    },
    setScope(next: AccountReplicationScope) {
      scope = { ...next };
    },
    get repository() {
      return services.accountReplication!;
    },
    get approval() {
      return services.accountScopeApproval!;
    },
    reads,
    failApply() {
      failManualInsert = true;
    },
    loseApplyCommitResponse() {
      loseCommit = true;
    },
    changeOwnerDuringApply() {
      onApplyWrite = () => {
        scope = { ownerId: otherOwner, authGeneration: scope.authGeneration + 1 };
      };
    },
    async approve(historyIncluded: boolean) {
      const review = await services.accountScopeApproval!.review(scope);
      const evidence = await services.accountScopeApproval!.approve(scope, review, {
        historyIncluded,
      });
      return { review, evidence };
    },
    inspect() {
      return services.accountReplication!.inspect(scope);
    },
    coordinator(remote: AccountRemote) {
      const captured = { ...scope };
      return createAccountSyncCoordinator({
        scope: captured,
        isCurrent: () =>
          captured.ownerId === scope.ownerId && captured.authGeneration === scope.authGeneration,
        enableExpandedScope: true,
        repository: services.accountReplication!,
        remote,
        newId: randomUUID,
        projectSettings: async () => true,
      });
    },
    async stage(proposed?: AccountSnapshot, remote = server(), mode: 'push' | 'pull' = 'push') {
      const inspection = await this.inspect();
      return services.accountReplication!.stage(scope, {
        operationId: randomUUID(),
        expectedJournalRevision: inspection.journal?.revision ?? 0,
        expectedDeviceDataOwnerId: inspection.deviceDataOwnerId,
        initialImportReviewed: true,
        capturedLocal: inspection.local,
        remote,
        proposed: proposed ?? inspection.local.snapshot,
        mode,
      });
    },
    async ack(journal: AccountReplicationJournal) {
      assert.ok(journal.pending);
      return services.accountReplication!.recordAcknowledgement(scope, {
        operationId: journal.pending.operationId,
        receipt: {
          ownerId,
          operationId: journal.pending.operationId,
          revision: journal.pending.remote.revision + 1,
          committedAt: at,
        },
      });
    },
    async applyInput(journal: AccountReplicationJournal): Promise<AccountApplyInput> {
      const inspection = await this.inspect();
      assert.ok(journal.pending && inspection.journal);
      return {
        operationId: journal.pending.operationId,
        expectedJournalRevision: inspection.journal.revision,
        expectedLocal: inspection.local,
        rebased: journal.pending.proposed,
      };
    },
    dump() {
      const tables = write.database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      return JSON.stringify(
        tables.map(({ name }) => [name, write.database.prepare(`SELECT * FROM "${name}"`).all()]),
      );
    },
    async reopen(expandedScope = enableExpandedScope) {
      await services.close();
      enableExpandedScope = expandedScope;
      await open();
    },
    async close() {
      await services.close();
      await removeFixtureDirectory(directory);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function action(f: Fixture, input: DirectActionInput) {
  const review = ready(await f.services.commands.reviewDirect(input));
  const command = ready(await f.services.commands.prepareDirect(review));
  const result = await f.services.commands.execute(command);
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  return command;
}
async function seedPersonal(f: Fixture) {
  const personal = f.services.personal!;
  const epoch = ready(await personal.readRecipePersonal(recipeId)).epoch;
  const noteId = randomUUID(),
    collectionId = randomUUID(),
    itemId = randomUUID();
  const text = '  Exact note\n\u0000\ud800 عربي  ',
    name = '  Family\u0000 dinners  ';
  const fields = {
    name: '  ليمون\u0000\udfff  ',
    amountText: '  ½–2  ',
    unitText: ' packs ',
    category: 'produce' as const,
  };
  const execute = async (command: PersonalCommand) => ready(await personal.execute(command));
  const identity = () => ({ operationId: randomUUID(), expectedEpoch: epoch });
  await execute({
    ...identity(),
    kind: 'saveNote',
    noteId,
    recipeId,
    expectedRevision: null,
    text,
  });
  const created = await execute({ ...identity(), kind: 'createCollection', collectionId, name });
  await execute({
    ...identity(),
    kind: 'setCollectionMembership',
    collectionId,
    recipeId,
    expectedCollectionRevision: created.revision,
    expectedRevision: null,
    present: true,
  });
  const added = await execute({ ...identity(), kind: 'addManualItem', itemId, fields });
  await execute({
    ...identity(),
    kind: 'setManualPurchased',
    itemId,
    expectedRevision: added.revision,
    purchased: true,
  });
  await action(f, { kind: 'setFavourite', recipeId, saved: true });
  return { noteId, collectionId, itemId, text, name, fields };
}
async function saveCooked(f: Fixture, chosenRecipe = recipeId) {
  const cooking = f.services.cooking!;
  const content = ready(await cooking.readSession(chosenRecipe)).currentContent;
  const page = ready(await cooking.readHistory());
  const input: SaveCookedInput = {
    eventId: randomUUID(),
    recipeId: chosenRecipe,
    contentFingerprint: content.contentFingerprint,
    readerVersion: 1,
    expectedHistoryEpoch: page.historyEpoch,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    note: '  Cooked note\n\u0000 Exact  ',
  };
  const receipt = ready(await cooking.saveCooked(input));
  assert.equal(receipt.kind, 'saved');
  return { input, receipt };
}
async function sync(f: Fixture, remote: AccountRemote) {
  const coordinator = f.coordinator(remote);
  try {
    await coordinator.sync();
    const state = coordinator.getSnapshot();
    if (state.kind === 'review') {
      assert.equal(state.canConfirm, true, JSON.stringify(state));
      await coordinator.confirm();
    }
    assert.equal(
      coordinator.getSnapshot().kind,
      'synced',
      JSON.stringify(coordinator.getSnapshot()),
    );
  } finally {
    await coordinator.invalidate();
  }
}
function expanded(snapshot: AccountSnapshot): AccountSnapshotV2 {
  assert.equal(snapshot.schemaVersion, 2);
  if (snapshot.schemaVersion !== 2) assert.fail();
  return snapshot;
}
const privateRead = (sql: string) =>
  /\b(?:FROM|JOIN)\s+(?:recipe_note|personal_collection(?:_member)?|manual_shopping_item)\b/i.test(
    sql,
  );
const historyRead = (sql: string) =>
  /\b(?:FROM|JOIN)\s+(?:cooking_event|imported_cooking_history|account_cooking_history(?:_removed)?|cooking_history_withdrawal)\b/i.test(
    sql,
  );

test('without durable approval expanded inspection remains v1 and coordinator makes no private read or remote request', async () => {
  const f = await fixture();
  try {
    await seedPersonal(f);
    await saveCooked(f);
    f.reads.length = 0;
    const inspection = await f.inspect();
    assert.equal(inspection.local.snapshot.schemaVersion, 1);
    assert.equal(inspection.scopeApproval, null);
    assert.equal(f.reads.some(privateRead), false);
    assert.equal(f.reads.some(historyRead), false);
    const remote = simulatedRemote(),
      coordinator = f.coordinator(remote.remote);
    await coordinator.sync();
    assert.deepEqual(coordinator.getSnapshot(), {
      kind: 'failed',
      reason: 'scope_review_required',
      pending: false,
    });
    assert.equal(remote.reads, 0);
    assert.equal(remote.commits.length, 0);
    assert.equal(f.reads.some(privateRead), false);
    assert.equal(f.reads.some(historyRead), false);
    await coordinator.invalidate();
    await assert.rejects(f.stage(), failure('scope_review_required'));
    assert.equal((await f.inspect()).journal, null);
    assert.equal(f.reads.some(privateRead), false);
    assert.equal(f.reads.some(historyRead), false);
  } finally {
    await f.close();
  }
});

test('personal-only approval captures exact v2 personal fields without reading or uploading saved history', async () => {
  const f = await fixture();
  try {
    const seeded = await seedPersonal(f);
    await saveCooked(f);
    const approval = await f.approve(false);
    assert.deepEqual(approval.review.counts, {
      notes: 1,
      collections: 1,
      memberships: 1,
      manualItems: 1,
      cookingHistory: 1,
    });
    f.reads.length = 0;
    const snapshot = expanded((await f.inspect()).local.snapshot);
    assert.equal(Object.hasOwn(snapshot, 'cookingHistory'), false);
    assert.equal(f.reads.some(historyRead), false);
    assert.equal(snapshot.personal.notes[0]!.noteId, seeded.noteId);
    assert.equal(snapshot.personal.notes[0]!.text, seeded.text);
    const remote = simulatedRemote();
    await sync(f, remote.remote);
    assert.equal(remote.commits.length, 1);
    assert.equal(Object.hasOwn(remote.commits[0]!.snapshot, 'cookingHistory'), false);
    assert.deepEqual(expanded(remote.state.snapshot!).personal, snapshot.personal);
    await f.reopen();
    assert.deepEqual(expanded((await f.inspect()).local.snapshot).personal, snapshot.personal);
    assert.equal(ready(await f.services.cooking!.readHistory()).items.length, 1);
  } finally {
    await f.close();
  }
});

test('two independent stores push/pull exact personal identities and genuine history, preserve receipts and reopen', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    const seeded = await seedPersonal(a),
      cooked = await saveCooked(a);
    await a.approve(true);
    await b.approve(true);
    const source = expanded((await a.inspect()).local.snapshot);
    assert.equal(source.cookingHistory!.entries[0]!.eventId, cooked.input.eventId);
    const remote = simulatedRemote();
    await sync(a, remote.remote);
    await sync(b, remote.remote);
    assert.equal(remote.commits.length, 1, 'second empty store should pull the accepted snapshot');
    assert.ok(accountSnapshotsEqual((await b.inspect()).local.snapshot, source));
    assert.equal(
      ready(await b.services.personal!.readRecipePersonal(recipeId)).note!.text,
      seeded.text,
    );
    const manual = ready(await b.services.personal!.readManualShopping()).items[0]!;
    assert.equal(manual.itemId, seeded.itemId);
    assert.equal(manual.purchased, true);
    assert.deepEqual(
      {
        name: manual.name,
        amountText: manual.amountText,
        unitText: manual.unitText,
        category: manual.category,
      },
      seeded.fields,
    );
    const collection = ready(await b.services.personal!.readCollection(seeded.collectionId));
    assert.equal(collection.collection.name, seeded.name);
    assert.equal(collection.items[0]!.recipeId, recipeId);
    const readHistory = ready(await b.services.cooking!.readHistory());
    assert.equal(readHistory.items[0]!.eventId, cooked.input.eventId);
    assert.equal(readHistory.items[0]!.note, cooked.input.note);
    assert.deepEqual(
      ready(await a.services.cooking!.readCookedReceipt(cooked.input.eventId)),
      cooked.receipt,
    );
    assert.equal(
      ready(await b.services.cooking!.readCookedReceipt(cooked.input.eventId)),
      null,
      'remote history is not a fabricated local completion receipt',
    );
    await a.reopen();
    await b.reopen();
    assert.ok(accountSnapshotsEqual((await a.inspect()).local.snapshot, source));
    assert.ok(accountSnapshotsEqual((await b.inspect()).local.snapshot, source));
    assert.equal(
      ready(await b.services.cooking!.readHistory()).items[0]!.eventId,
      cooked.input.eventId,
    );
    await sync(b, remote.remote);
    assert.equal(remote.commits.length, 1);
  } finally {
    await a.close();
    await b.close();
  }
});

test('expanded apply rollback is atomic across history, personal, core and journal; a lost local acknowledgement recovers once', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    await seedPersonal(a);
    const cooked = await saveCooked(a);
    await a.approve(true);
    await b.approve(true);
    const source = expanded((await a.inspect()).local.snapshot);
    const staged = await b.stage(source, server(source), 'pull');
    const input = await b.applyInput(staged),
      before = b.dump();
    b.failApply();
    await assert.rejects(b.repository.apply(b.scope, input), /injected expanded apply failure/);
    assert.equal(b.dump(), before);
    assert.equal(await b.repository.readApplyReceipt(b.scope, input.operationId), null);
    b.loseApplyCommitResponse();
    const receipt = await b.repository.apply(b.scope, input);
    assert.equal(receipt.operationId, input.operationId);
    await b.reopen();
    assert.deepEqual(await b.repository.readApplyReceipt(b.scope, input.operationId), receipt);
    assert.deepEqual(await b.repository.apply(b.scope, input), receipt);
    assert.equal(
      ready(await b.services.cooking!.readHistory()).items.filter(
        (entry) => entry.eventId === cooked.input.eventId,
      ).length,
      1,
    );
    assert.ok(accountSnapshotsEqual((await b.inspect()).local.snapshot, source));
    assert.equal(
      b.database.prepare('SELECT COUNT(*) AS count FROM personal_operation').get()!.count,
      0,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test('changed durable approval digest blocks a pending apply and public approval changes are blocked while pending', async () => {
  const f = await fixture();
  try {
    await seedPersonal(f);
    const { evidence } = await f.approve(false);
    const staged = await f.ack(await f.stage()),
      input = await f.applyInput(staged);
    await assert.rejects(f.approval.review(f.scope), failure('operation_pending'));
    const replacement = await createAccountScopeApprovalEvidence(
      { ...evidence.record, decidedAt: later },
      sha256,
    );
    f.database
      .prepare('UPDATE app_metadata SET value=? WHERE key=?')
      .run(JSON.stringify(replacement), accountScopeApprovalKey(ownerId));
    const before = f.dump();
    await assert.rejects(f.repository.apply(f.scope, input), failure('scope_changed'));
    assert.equal(f.dump(), before);
    assert.equal(await f.repository.readApplyReceipt(f.scope, input.operationId), null);
  } finally {
    await f.close();
  }
});

test('owner change after apply writes is rejected by final admission with every transaction effect rolled back', async () => {
  const f = await fixture();
  try {
    await seedPersonal(f);
    await f.approve(true);
    const staged = await f.ack(await f.stage()),
      input = await f.applyInput(staged),
      scope = f.scope;
    const before = f.dump();
    f.changeOwnerDuringApply();
    await assert.rejects(f.repository.apply(scope, input), failure('account_changed'));
    assert.equal(f.dump(), before);
    f.setScope(scope);
    assert.equal(await f.repository.readApplyReceipt(scope, input.operationId), null);
  } finally {
    await f.close();
  }
});

test('history-off retains full remote history in the merge base but neither collects nor applies device history', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    await seedPersonal(a);
    const accountCooked = await saveCooked(a),
      localCooked = await saveCooked(b, otherRecipe);
    await a.approve(true);
    await b.approve(false);
    const remote = simulatedRemote();
    await sync(a, remote.remote);
    const remoteHistory = expanded(remote.state.snapshot!).cookingHistory!;
    b.reads.length = 0;
    await sync(b, remote.remote);
    assert.equal(b.reads.some(historyRead), false);
    const inspection = await b.inspect();
    assert.equal(Object.hasOwn(expanded(inspection.local.snapshot), 'cookingHistory'), false);
    assert.equal(
      canonicalAccountHistory(expanded(inspection.journal!.base!.snapshot!).cookingHistory!),
      canonicalAccountHistory(remoteHistory),
    );
    const deviceHistory = ready(await b.services.cooking!.readHistory()).items;
    assert.deepEqual(
      deviceHistory.map((entry) => entry.eventId),
      [localCooked.input.eventId],
    );
    assert.equal(
      deviceHistory.some((entry) => entry.eventId === accountCooked.input.eventId),
      false,
    );
    assert.equal(
      b.database.prepare('SELECT COUNT(*) AS count FROM account_cooking_history').get()!.count,
      0,
    );
    await b.reopen();
    await sync(b, remote.remote);
    assert.equal(remote.commits.length, 1);
    assert.equal(
      canonicalAccountHistory(expanded(remote.state.snapshot!).cookingHistory!),
      canonicalAccountHistory(remoteHistory),
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test('stale clear review fails after account history arrives; an approved clear propagates withdrawals and cannot revive', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    const cooked = await saveCooked(a);
    await a.approve(true);
    await b.approve(true);
    const staleReview = ready(await b.services.cooking!.reviewClearHistory());
    const remote = simulatedRemote();
    await sync(a, remote.remote);
    await sync(b, remote.remote);
    assert.equal(
      (await b.services.cooking!.clearHistory(staleReview, randomUUID())).kind,
      'failed',
    );
    assert.equal(ready(await b.services.cooking!.readHistory()).items.length, 1);
    const review = ready(await b.services.cooking!.reviewClearHistory());
    const clear = ready(await b.services.cooking!.clearHistory(review, randomUUID()));
    assert.equal(clear.clearedCount, 1);
    const clearedSnapshot = expanded((await b.inspect()).local.snapshot);
    assert.deepEqual(clearedSnapshot.cookingHistory!.entries, []);
    assert.ok(clearedSnapshot.cookingHistory!.removedEventIds.includes(cooked.input.eventId));
    await sync(b, remote.remote);
    await sync(a, remote.remote);
    assert.equal(ready(await a.services.cooking!.readHistory()).items.length, 0);
    assert.deepEqual(ready(await a.services.cooking!.saveCooked(cooked.input)), cooked.receipt);
    assert.equal(ready(await a.services.cooking!.readHistory()).items.length, 0);
    await a.reopen();
    await b.reopen();
    await sync(a, remote.remote);
    await sync(b, remote.remote);
    for (const device of [a, b]) {
      assert.equal(ready(await device.services.cooking!.readHistory()).items.length, 0);
      assert.ok(
        expanded((await device.inspect()).local.snapshot).cookingHistory!.removedEventIds.includes(
          cooked.input.eventId,
        ),
      );
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test('retained legacy pending settles with its exact bytes before expanded approval can stage new data', async () => {
  const f = await fixture(false);
  try {
    const seeded = await seedPersonal(f),
      cooked = await saveCooked(f);
    const legacy = await f.stage();
    assert.equal(legacy.schemaVersion, 1);
    assert.equal(legacy.pending!.proposed.schemaVersion, 1);
    const pending = copy(legacy.pending!);
    await f.reopen(true);
    assert.deepEqual((await f.inspect()).journal!.pending, pending);
    const remote = simulatedRemote(),
      coordinator = f.coordinator(remote.remote);
    await coordinator.sync();
    assert.deepEqual(coordinator.getSnapshot(), {
      kind: 'failed',
      reason: 'scope_review_required',
      pending: false,
    });
    await coordinator.invalidate();
    assert.equal(remote.commits.length, 1);
    assert.equal(remote.commits[0]!.operationId, pending.operationId);
    assert.deepEqual(remote.commits[0]!.snapshot, pending.proposed);
    assert.equal((await f.inspect()).journal!.pending, null);
    assert.equal(
      ready(await f.services.personal!.readRecipePersonal(recipeId)).note!.text,
      seeded.text,
    );
    assert.deepEqual(
      ready(await f.services.cooking!.readCookedReceipt(cooked.input.eventId)),
      cooked.receipt,
    );
    await assert.rejects(f.stage(), failure('scope_review_required'));
    await f.approve(false);
    await sync(f, remote.remote);
    assert.equal(remote.commits.length, 2);
    assert.equal(remote.commits[1]!.snapshot.schemaVersion, 2);
    assert.equal(expanded(remote.commits[1]!.snapshot).personal.notes[0]!.text, seeded.text);
    assert.equal(Object.hasOwn(remote.commits[1]!.snapshot, 'cookingHistory'), false);
  } finally {
    await f.close();
  }
});
