import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  projectContentLookup,
  type ContentLookup,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import {
  AccountReplicationError,
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
  type AccountReplicationScope,
  type AccountSnapshotOptions,
} from '@cookmate/account-sync';
import {
  accountLegacyContentTransitionFingerprint,
  serializeAccountLegacyContentTransition,
  type AccountLegacyContentTransitionDraft,
} from '../../account-sync/src/contentLegacyTransition';
import {
  accountContentPendingFingerprint,
  serializeAccountContentJournal,
} from '../../account-sync/src/contentReplicationRecords';
import { canonicalPortableContentJson } from '../src/portableBackupContent';
import { convertBundledLegacyAccountSnapshot } from '../../../apps/mobile/src/data/accountLegacyContentConversion';
import { accountLegacyContentTransitionKey } from '../../../apps/mobile/src/data/accountLegacyTransitionKeys';
import { readAccountLegacyContentTransitionState } from '../../../apps/mobile/src/data/accountLegacyTransitionStorage';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../account-sync/src/contentSnapshot';
import type { Immutable, StoreChange } from '../src';
import { createAccountContentApplyService } from '../../../apps/mobile/src/data/accountContentApply';
import { captureAccountContentLocal } from '../../../apps/mobile/src/data/accountContentCapture';
import { createAccountContentJournalRepository } from '../../../apps/mobile/src/data/accountContentJournal';
import {
  assertAccountContentApprovalAvailable,
  createAccountContentScopeApprovalService,
} from '../../../apps/mobile/src/data/accountContentScopeApproval';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_SETTINGS_KEY,
  journalKey as legacyJournalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { retainCookingRevisionInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import type { ContentReferenceInspectionView } from '../../../apps/mobile/src/data/contentReleaseStore';
import { readPinnedShoppingContextInSnapshot } from '../../../apps/mobile/src/data/pinnedShoppingRepository';
import { readShoppingLedgerInSnapshot } from '../../../apps/mobile/src/data/shoppingRepository';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { published } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Real independent SQLite connections and private journal/approval/apply services. Content
// inspection below is a controlled host port: no signature, hosted service or runtime claim.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const later = '2026-10-01T13:00:00.000Z';
const journalKey = `account-replication:content-journal:${ownerId}`;
const reason =
  (...wanted: string[]) =>
  (error: unknown) =>
    error instanceof AccountReplicationError && wanted.includes(error.reason);
const settings = (): AccountSnapshotOptions => ({
  appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
  profile: { displayName: null },
});
const copy = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const mutable = (value: Immutable<AccountContentSnapshot>): AccountContentSnapshot =>
  JSON.parse(JSON.stringify(value)) as AccountContentSnapshot;
type ServiceOptions = Parameters<typeof createAccountContentApplyService>[0];

async function fixture(t: TestContext, historyIncluded = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-account-content-apply-'));
  const filename = join(directory, 'cooking.db');
  let write = desktopConnection(filename),
    read = desktopConnection(filename);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  let queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  const installationId = randomUUID(),
    shoppingScopeId = randomUUID(),
    conversationId = randomUUID();
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId, shoppingScopeId, conversationId },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  write.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId }));
  await migrateCookingContentDatabase(writer, { sha256 });
  await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const document = authoredFixture('90001');
  document.recipe.ingredients = [
    { position: 1, rawName: 'Salt', rawMeasure: '100g' },
    { position: 2, rawName: 'Oil', rawMeasure: '1 tbsp' },
  ];
  const first = await published(document, 'apply-first');
  document.recipe.ingredients[0]!.rawMeasure = '200g';
  document.recipe.title = 'Soup second exact version';
  const second = await published(document, 'apply-second');
  await writer.transaction((session) =>
    retainCookingRevisionInSnapshot(session, first.revision, sha256),
  );
  let adopted: OverlayHead = {
    releaseId: 'apply-fixture-head',
    sequence: 2,
    fingerprint: 'a'.repeat(64),
  };
  let latest: OverlayHead = copy(adopted);
  write.database
    .prepare('UPDATE app_content_adoption SET head_json=?,revision=1')
    .run(JSON.stringify(adopted));
  const localEvent = {
    readerVersion: 2,
    recipeId: first.revision.ref.recipeId,
    contentRef: copy(first.revision.ref),
    eventId: randomUUID(),
    recipeTitle: first.revision.document.recipe.title,
    photoAssetId: first.revision.document.media[0]!.assetId,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'PRIVATE ORIGINAL COOKING RECEIPT',
    historyEpoch: 0,
    revision: 1,
  };
  const receiptBytes =
    JSON.stringify({ kind: 'saved', event: localEvent, closedSession: null }, null, 2) + '\n';
  write.database
    .prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)")
    .run(localEvent.eventId, localEvent.cookedOn, at, 'c'.repeat(64), receiptBytes);
  write.database
    .prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)')
    .run(
      localEvent.eventId,
      localEvent.recipeId,
      first.revision.ref.revisionId,
      first.revision.ref.contentFingerprint,
    );
  write.database
    .prepare('INSERT INTO personal_operation VALUES (?,?,?)')
    .run(randomUUID(), 'c'.repeat(64), JSON.stringify({ private: 'ORIGINAL PERSONAL RECEIPT' }));
  write.database
    .prepare('UPDATE conversation SET composer_draft=?')
    .run(JSON.stringify('PRIVATE UNSENT MESSAGE'));
  write.database.exec(
    "UPDATE cooking_state SET history_revision=1; UPDATE state_revision SET revision=1 WHERE collection='store'",
  );
  const scope: AccountReplicationScope = { ownerId, authGeneration: 1 };
  let current: AccountReplicationScope | null = { ...scope },
    localSettings = settings();
  let busy = false,
    held = false,
    storeOpen = true,
    reservations = 0;
  let afterRun: ((sql: string, values: readonly SqlValue[]) => void) | undefined;
  let afterRead: ((sql: string) => void) | undefined;
  let afterCommit: (() => void) | undefined;
  let afterObserver: (() => void) | undefined;
  let afterHash: (() => void) | undefined;
  let afterInspection: (() => void) | undefined;
  const lookups = new Map<string, ContentLookup>(
    [first, second].map((publication) => [
      canonicalContentJson(publication.revision.ref),
      {
        kind: 'readable',
        state: 'historical',
        value: {
          origin: 'published',
          publication,
          revision: publication.revision,
          retainedSources: [],
        },
      },
    ]),
  );
  function installHooks() {
    for (const connection of [write.connection, read.connection]) {
      const all = connection.all;
      connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
        const rows = await all<Row>(sql, values);
        afterRead?.(sql);
        return rows;
      };
    }
    const prepare = write.connection.prepare,
      exec = write.connection.exec;
    write.connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        ...statement,
        run: async (values) => {
          await statement.run(values);
          afterRun?.(sql, values);
        },
      };
    };
    write.connection.exec = async (sql) => {
      await exec(sql);
      if (sql === 'COMMIT') {
        const effect = afterCommit;
        afterCommit = undefined;
        effect?.();
      }
    };
    writer.setObserver({
      async begin() {},
      async beforeCommit() {
        const effect = afterObserver;
        afterObserver = undefined;
        effect?.();
      },
      async committed() {},
      failed() {},
    });
  }
  installHooks();
  const contentStore: ServiceOptions['contentStore'] = {
    async withVerifiedReferenceInspection(expected, refs, work) {
      assert.deepEqual(expected, adopted, 'controlled content head mismatch');
      assert.ok(storeOpen, 'controlled content store closed');
      reservations++;
      let live = true;
      const view: ContentReferenceInspectionView = {
        head: copy(adopted),
        latestHead: copy(latest),
        adoptedRecipeIds: [...catalogue.recipes.map((row) => row.recipeId), '90001'],
        entries: refs.map((ref) => ({
          ref: copy(ref),
          lookup: lookups.get(canonicalContentJson(ref)) ?? { kind: 'missing' },
        })),
        assertActive() {
          assert.ok(live && storeOpen, 'controlled inspection expired');
          return undefined;
        },
      };
      try {
        const result = await work(view);
        afterInspection?.();
        view.assertActive();
        return result;
      } finally {
        live = false;
        reservations--;
      }
    },
  };
  const notifications: {
    change: StoreChange;
    expanded: { personalRevision?: number; historyRevision?: number };
  }[] = [];
  const captureOptions = {
    installationId,
    catalogue: catalogue.identity,
    currentScope: () => current,
    getLocalSettings: () => localSettings,
    now: () => later,
    sha256: async (text: string) => {
      const digest = await sha256(text);
      const effect = afterHash;
      afterHash = undefined;
      effect?.();
      return digest;
    },
  };
  function createService() {
    return createAccountContentApplyService({
      ...captureOptions,
      reader,
      writer,
      contentStore,
      acquireExclusive() {
        if (busy || held) return null;
        held = true;
        return () => {
          held = false;
        };
      },
      onCommitted(change, expanded) {
        notifications.push({ change, expanded });
      },
    });
  }
  let service = createService(),
    journal = createAccountContentJournalRepository({ ...captureOptions, reader, writer });
  const approvals = createAccountContentScopeApprovalService({
    ...captureOptions,
    reader,
    writer,
    newId: randomUUID,
  });
  const approval = await approvals.review(scope);
  await approvals.approve(scope, approval, { historyIncluded });
  approvals.close();
  const capture = () =>
    reader.transaction((session) => captureAccountContentLocal(session, current!, captureOptions), {
      kind: 'read_only',
    });
  async function stage(
    proposal?: (snapshot: AccountContentSnapshot) => void,
    mode: 'push' | 'pull' = 'push',
    ack = true,
  ) {
    const capturedLocal = await capture(),
      proposed = mutable(capturedLocal.snapshot);
    proposal?.(proposed);
    const operationId = randomUUID(),
      remote = {
        ownerId,
        revision: 4,
        snapshot: proposed,
        updatedAt: at,
        deletionOperationId: null,
      };
    let result =
      mode === 'push'
        ? await journal.stageReviewedPush(
            current!,
            await journal.reviewPush(current!, { operationId, remote }),
            { initialImportReviewed: true },
          )
        : await journal.stage(current!, {
            operationId,
            expectedJournalRevision: 0,
            expectedDeviceDataOwnerId: ownerId,
            initialImportReviewed: true,
            capturedLocal,
            remote,
            proposed,
            mode,
          });
    assert.ok(result.pending);
    const identity = {
      operationId: result.pending.operationId,
      requestFingerprint: result.pending.requestFingerprint,
    };
    if (mode === 'push' && ack)
      result = await journal.recordAcknowledgement(current!, {
        ...identity,
        receipt: { ownerId, operationId: identity.operationId, revision: 5, committedAt: at },
      });
    return {
      journal: result,
      identity,
      proposed: mutable(result.pending!.proposed),
      capturedLocal,
    };
  }
  // Seed only the already-acknowledged handoff boundary. This tests actual local apply and
  // recovery, not the still-private transition review, HTTP authentication or dispatch host.
  async function legacyHandoff(observedOnly = false) {
    const original = emptyAccountSnapshot(catalogue.identity, settings());
    const remote = {
      ownerId,
      revision: 4,
      snapshot: original,
      updatedAt: at,
      deletionOperationId: null,
    };
    const observed = {
      revision: remote.revision,
      updatedAt: remote.updatedAt,
      snapshotDigest: await sha256(canonicalAccountSnapshot(original)),
    };
    const old = {
      schemaVersion: 1,
      ownerId,
      revision: 1,
      base: observedOnly ? null : remote,
      observed,
      pending: null,
      lastApply: observedOnly
        ? null
        : {
            ownerId,
            operationId: randomUUID(),
            storeRevision: 1,
            serverRevision: 4,
            appliedAt: at,
          },
    };
    const oldBytes = JSON.stringify(old, null, 2) + '\n';
    write.database
      .prepare('INSERT INTO app_metadata VALUES (?,?)')
      .run(legacyJournalKey(ownerId), oldBytes);
    const local = await capture(),
      proposed = mutable(local.snapshot);
    rich(proposed);
    const conversion = await convertBundledLegacyAccountSnapshot(original, sha256);
    const draft: AccountLegacyContentTransitionDraft = {
      ownerId,
      installationId,
      legacy: {
        journalDigest: await sha256(oldBytes),
        journalRevision: old.revision,
        base: old.base,
        observed,
        baseProjectionDigest: observedOnly ? null : conversion.convertedDigest,
      },
      remote,
      remoteDigest: conversion.sourceDigest,
      remoteProjectionDigest: conversion.convertedDigest,
      capturedLocal: {
        storeRevision: local.storeRevision,
        snapshot: mutable(local.snapshot),
        scope: copy(local.scope),
        fenceDigest: await sha256(canonicalPortableContentJson(local.fence, 32768)),
      },
      networkOperationId: randomUUID(),
      localApplyOperationId: randomUUID(),
      proposed,
      proposedDigest: await sha256(canonicalAccountContentSnapshot(proposed)),
      review: { initialImportReviewed: true, resolutions: {} },
    };
    const acknowledgement = {
      ownerId,
      operationId: draft.networkOperationId,
      revision: 5,
      committedAt: '2026-10-01T12:10:00.123456+00:00',
    };
    const accepted = {
      ownerId,
      revision: 5,
      snapshot: proposed,
      updatedAt: acknowledgement.committedAt,
      deletionOperationId: null,
    };
    const pendingDraft = {
      operationId: draft.localApplyOperationId,
      mode: 'pull' as const,
      capturedLocal: draft.capturedLocal,
      remote: accepted,
      proposed,
    };
    const requestFingerprint = await accountContentPendingFingerprint(
      ownerId,
      installationId,
      draft.legacy.journalDigest,
      pendingDraft,
      sha256,
    );
    const identity = { operationId: draft.localApplyOperationId, requestFingerprint };
    const transition = {
      ...draft,
      schemaVersion: 1 as const,
      kind: 'legacy_to_content3' as const,
      revision: 3,
      requestFingerprint: await accountLegacyContentTransitionFingerprint(draft, sha256),
      acknowledgement,
      handoff: { requestFingerprint },
      lastApply: null,
    };
    const contentJournal = {
      schemaVersion: 3,
      ownerId,
      installationId,
      revision: 1,
      legacyJournalDigest: draft.legacy.journalDigest,
      scope: draft.capturedLocal.scope,
      base: null,
      observed: {
        revision: accepted.revision,
        updatedAt: accepted.updatedAt,
        snapshotDigest: draft.proposedDigest,
      },
      pending: {
        ...pendingDraft,
        requestFingerprint,
        proposedDigest: draft.proposedDigest,
        acknowledgement: null,
      },
      lastApply: null,
    };
    write.database
      .prepare('INSERT INTO app_metadata VALUES (?,?)')
      .run(
        accountLegacyContentTransitionKey(ownerId),
        await serializeAccountLegacyContentTransition(transition, ownerId, installationId, sha256),
      );
    write.database
      .prepare('INSERT INTO app_metadata VALUES (?,?)')
      .run(
        journalKey,
        await serializeAccountContentJournal(contentJournal, ownerId, installationId, sha256),
      );
    return { identity, proposed, oldBytes, transition };
  }
  function rich(snapshot: AccountContentSnapshot) {
    const collectionId = randomUUID();
    snapshot.favourites.push({ recipeId: '90001', savedAt: at });
    for (const [index, publication] of [first, second].entries()) {
      const occurrenceId = randomUUID();
      snapshot.plan.push({
        occurrenceId,
        recipeId: '90001',
        placement: { actualDate: index ? '2026-10-08' : '2026-10-01', mealKey: 'dinner' },
        createdAt: at,
        updatedAt: at,
      });
      snapshot.planReferences.push({ occurrenceId, contentRef: copy(publication.revision.ref) });
      snapshot.shopping.selectedOccurrenceIds.push(occurrenceId);
    }
    snapshot.personal.notes.push({
      noteId: randomUUID(),
      recipeId: '90001',
      text: '  Exact personal note\n量 🍲 ',
      deleted: false,
      createdAt: at,
      updatedAt: at,
    });
    snapshot.personal.collections.push({
      collectionId,
      name: 'Exact dinners',
      deleted: false,
      createdAt: at,
      updatedAt: at,
    });
    snapshot.personal.memberships.push({
      collectionId,
      recipeId: '90001',
      present: true,
      updatedAt: at,
    });
    snapshot.personal.manualItems.push({
      kind: 'manual',
      itemId: randomUUID(),
      name: ' Raw lemons ',
      amountText: '2½',
      unitText: ' bags ',
      category: 'produce',
      purchased: true,
      deleted: false,
      createdAt: at,
      updatedAt: at,
    });
    if (snapshot.cookingHistory)
      snapshot.cookingHistory.entries.push({
        kind: 'exact',
        entry: {
          readerVersion: 2,
          recipeId: '90001',
          contentRef: copy(second.revision.ref),
          eventId: randomUUID(),
          recipeTitle: second.revision.document.recipe.title,
          photoAssetId: second.revision.document.media[0]!.assetId,
          cookedOn: '2026-09-30',
          timeZone: 'Asia/Dubai',
          recordedAt: at,
          note: 'Exact account history',
        },
      });
  }
  const tableNames = write.database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
  const dump = () =>
    JSON.stringify(
      tableNames.map((table) => [
        table,
        write.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  const authority = () =>
    JSON.stringify(
      [
        'cooking_event',
        'local_history_content_pin',
        'cooking_session',
        'personal_operation',
        'operation_receipt',
        'message',
        'conversation',
      ].map((table) => [
        table,
        write.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  t.after(async () => {
    service.close();
    journal.close();
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  return {
    get db() {
      return write.database;
    },
    get service() {
      return service;
    },
    get journal() {
      return journal;
    },
    get writer() {
      return writer;
    },
    get reader() {
      return reader;
    },
    scope,
    first,
    second,
    localEvent,
    receiptBytes,
    lookups,
    notifications,
    stage,
    legacyHandoff,
    transitionState: () =>
      reader.transaction(
        (session) =>
          readAccountLegacyContentTransitionState(session, ownerId, installationId, sha256),
        { kind: 'read_only' },
      ),
    rich,
    capture,
    dump,
    authority,
    rawJournal: () =>
      write.database.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey)!.value,
    busy(value: boolean) {
      busy = value;
    },
    setScope(value: AccountReplicationScope | null) {
      current = value;
    },
    setSettings(value: AccountSnapshotOptions) {
      localSettings = value;
    },
    latest(value: OverlayHead) {
      latest = value;
    },
    get head() {
      return copy(adopted);
    },
    closeContent() {
      storeOpen = false;
    },
    reservations: () => reservations,
    held: () => held,
    afterRun(effect: typeof afterRun) {
      afterRun = effect;
    },
    afterRead(effect: typeof afterRead) {
      afterRead = effect;
    },
    afterCommit(effect: typeof afterCommit) {
      afterCommit = effect;
    },
    afterObserver(effect: typeof afterObserver) {
      afterObserver = effect;
    },
    afterHash(effect: typeof afterHash) {
      afterHash = effect;
    },
    afterInspection(effect: typeof afterInspection) {
      afterInspection = effect;
    },
    newService: createService,
    async ledger() {
      return reader.transaction(async (session) => {
        const context = await readPinnedShoppingContextInSnapshot(session, {
          sha256,
          lookupExact: (ref) =>
            projectContentLookup(lookups.get(canonicalContentJson(ref)) ?? { kind: 'missing' }),
        });
        return readShoppingLedgerInSnapshot(session, context.options);
      });
    },
    async reopen() {
      service.close();
      journal.close();
      await reader.close();
      await writer.close();
      write = desktopConnection(filename);
      read = desktopConnection(filename);
      await configureConnection(write.connection);
      await configureConnection(read.connection);
      await read.connection.exec('PRAGMA query_only=ON');
      queue = new SqlTransactionQueue();
      writer = new SerializedWriter(write.connection, queue);
      reader = new SerializedReader(read.connection, queue);
      installHooks();
      service = createService();
      journal = createAccountContentJournalRepository({ ...captureOptions, reader, writer });
    },
  };
}

test('legacy handoff atomically completes both records while retaining original evidence and late local edits', async (t) => {
  for (const observedOnly of [false, true]) {
    const f = await fixture(t),
      staged = await f.legacyHandoff(observedOnly),
      authority = f.authority();
    const noteId = randomUUID();
    f.db
      .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,2,?,?)')
      .run(
        noteId,
        catalogue.recipes[0]!.recipeId,
        JSON.stringify('Late question, after remote acceptance'),
        later,
        later,
      );
    f.db.exec(
      "UPDATE state_revision SET revision=2 WHERE collection='store'; UPDATE personal_state SET revision=2",
    );
    const review = await f.service.review(f.scope, staged.identity);
    const receipt = await f.service.apply(f.scope, review);
    const state = await f.transitionState(),
      journal = await f.journal.read(f.scope);
    assert.deepEqual(state.transition!.lastApply, receipt);
    assert.deepEqual(journal!.lastApply, receipt);
    assert.equal(state.transition!.revision, staged.transition.revision + 1);
    assert.equal(state.transition!.legacy.base === null, observedOnly);
    assert.equal(journal!.pending, null);
    assert.equal(receipt.serverRevision, 5);
    assert.equal(
      canonicalAccountContentSnapshot(journal!.base!.snapshot!),
      canonicalAccountContentSnapshot(staged.proposed),
    );
    assert.equal(
      f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(legacyJournalKey(ownerId))!
        .value,
      staged.oldBytes,
    );
    assert.ok((await f.capture()).snapshot.personal.notes.some((row) => row.noteId === noteId));
    assert.equal(f.authority(), authority);
    assert.equal(f.notifications.length, 1);
  }
});

test('legacy handoff failures after either journal write roll back all cooking data and both operation records', async (t) => {
  for (const key of [journalKey, accountLegacyContentTransitionKey(ownerId)]) {
    const f = await fixture(t),
      staged = await f.legacyHandoff(),
      review = await f.service.review(f.scope, staged.identity),
      before = f.dump();
    let fired = false;
    f.afterRun((sql, values) => {
      if (sql.startsWith('INSERT INTO app_metadata') && values[0] === key) {
        fired = true;
        throw new Error('injected transition commit failure');
      }
    });
    await assert.rejects(f.service.apply(f.scope, review), /injected transition/);
    assert.equal(fired, true);
    assert.equal(f.dump(), before);
    assert.equal((await f.transitionState()).transition!.lastApply, null);
    assert.equal(await f.service.recover(f.scope, staged.identity), null);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.held(), false);
  }
});

test('lost legacy local-install commit acknowledgement recovers the exact two-record receipt after reopen', async (t) => {
  const f = await fixture(t),
    staged = await f.legacyHandoff(),
    review = await f.service.review(f.scope, staged.identity);
  f.afterCommit(() => {
    throw new Error('lost transition acknowledgement');
  });
  const receipt = await f.service.apply(f.scope, review),
    after = f.dump();
  assert.deepEqual((await f.transitionState()).transition!.lastApply, receipt);
  await f.reopen();
  assert.deepEqual(await f.service.recover(f.scope, staged.identity), receipt);
  assert.deepEqual((await f.transitionState()).transition!.lastApply, receipt);
  assert.equal(f.dump(), after);
  assert.equal(f.notifications.length, 1);
});

test('changed transition bytes invalidate an issued apply review even if the transition is otherwise valid', async (t) => {
  const f = await fixture(t),
    staged = await f.legacyHandoff(),
    review = await f.service.review(f.scope, staged.identity);
  const key = accountLegacyContentTransitionKey(ownerId);
  const raw = String(f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)!.value);
  f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(raw + '\n', key);
  const before = f.dump();
  await assert.rejects(f.service.apply(f.scope, review), reason('journal_changed'));
  assert.equal(f.dump(), before);
  assert.equal(f.notifications.length, 0);
  const fresh = await f.service.review(f.scope, staged.identity);
  await f.service.apply(f.scope, fresh);
  assert.ok((await f.transitionState()).transition!.lastApply);
});

test('recovery refuses a half-completed handoff or changed original legacy bytes', async (t) => {
  const f = await fixture(t),
    staged = await f.legacyHandoff(),
    key = accountLegacyContentTransitionKey(ownerId);
  const pendingBytes = String(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)!.value,
  );
  const receipt = await f.service.apply(f.scope, await f.service.review(f.scope, staged.identity));
  const completedBytes = String(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)!.value,
  );
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(key);
  await assert.rejects(f.service.recover(f.scope, staged.identity), reason('recovery_required'));
  await assert.rejects(f.capture(), reason('recovery_required'));
  await assert.rejects(f.journal.read(f.scope), reason('recovery_required'));
  f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(key, completedBytes);
  f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(pendingBytes, key);
  const half = f.dump();
  await assert.rejects(f.service.recover(f.scope, staged.identity), reason('stored_data_invalid'));
  assert.equal(f.dump(), half);
  f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(completedBytes, key);
  assert.deepEqual(await f.service.recover(f.scope, staged.identity), receipt);
  f.db
    .prepare('UPDATE app_metadata SET value=? WHERE key=?')
    .run(staged.oldBytes + '\n', legacyJournalKey(ownerId));
  await assert.rejects(f.service.recover(f.scope, staged.identity), reason('stored_data_invalid'));
});

test('pre-handoff and linked pending transitions block ordinary capture and new scope approval', async (t) => {
  const f = await fixture(t),
    staged = await f.legacyHandoff();
  const assertApproval = () =>
    f.reader.transaction(
      (session) => assertAccountContentApprovalAvailable(session, ownerId, sha256),
      { kind: 'read_only' },
    );
  await assert.rejects(f.capture(), reason('operation_pending'));
  await assert.rejects(assertApproval(), reason('operation_pending'));
  assert.equal(
    (await f.service.review(f.scope, staged.identity)).merge.status,
    'merged',
    'Only the exact linked local apply can still read',
  );
  const key = accountLegacyContentTransitionKey(ownerId);
  const raw = JSON.parse(
    String(f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)!.value),
  );
  raw.handoff = null;
  raw.acknowledgement = null;
  raw.revision = 1;
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(journalKey);
  f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(JSON.stringify(raw), key);
  const before = f.dump();
  await assert.rejects(f.capture(), reason('operation_pending'));
  await assert.rejects(assertApproval(), reason('operation_pending'));
  assert.equal(f.dump(), before);
});

test('completed legacy transition allows the next ordinary sync and retains the original transition receipt', async (t) => {
  const f = await fixture(t),
    staged = await f.legacyHandoff();
  const originalReceipt = await f.service.apply(
    f.scope,
    await f.service.review(f.scope, staged.identity),
  );
  const sidecarBefore = (await f.transitionState()).digest;
  const current = await f.journal.read(f.scope);
  f.db
    .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,?, ?,?)')
    .run(
      randomUUID(),
      catalogue.recipes[0]!.recipeId,
      JSON.stringify('A later account sync'),
      originalReceipt.storeRevision + 1,
      later,
      later,
    );
  f.db
    .prepare("UPDATE state_revision SET revision=? WHERE collection='store'")
    .run(originalReceipt.storeRevision + 1);
  f.db.prepare('UPDATE personal_state SET revision=?').run(originalReceipt.storeRevision + 1);
  const pushReview = await f.journal.reviewPush(f.scope, {
    operationId: randomUUID(),
    remote: current!.base!,
  });
  const next = await f.journal.stageReviewedPush(f.scope, pushReview, {
    initialImportReviewed: false,
  });
  const identity = {
    operationId: next.pending!.operationId,
    requestFingerprint: next.pending!.requestFingerprint,
  };
  await f.journal.recordAcknowledgement(f.scope, {
    ...identity,
    receipt: { ownerId, operationId: identity.operationId, revision: 6, committedAt: later },
  });
  const receipt = await f.service.apply(f.scope, await f.service.review(f.scope, identity));
  assert.equal(receipt.serverRevision, 6);
  assert.ok(receipt.storeRevision > originalReceipt.storeRevision);
  const retained = await f.transitionState();
  assert.deepEqual(retained.transition!.lastApply, originalReceipt);
  assert.equal(retained.digest, sidecarBefore);
  assert.deepEqual(await f.service.recover(f.scope, identity), receipt);
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(legacyJournalKey(ownerId))!
      .value,
    staged.oldBytes,
  );
});

test('deleting both transition and original legacy records cannot convert a pending or completed handoff into an ordinary journal', async (t) => {
  for (const completed of [false, true]) {
    const f = await fixture(t),
      staged = await f.legacyHandoff();
    if (completed) await f.service.apply(f.scope, await f.service.review(f.scope, staged.identity));
    f.db
      .prepare('DELETE FROM app_metadata WHERE key=?')
      .run(accountLegacyContentTransitionKey(ownerId));
    f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(legacyJournalKey(ownerId));
    const before = f.dump();
    await assert.rejects(f.service.recover(f.scope, staged.identity), reason('local_changed'));
    await assert.rejects(f.journal.read(f.scope), reason('local_changed'));
    await assert.rejects(f.capture(), reason('local_changed'));
    await assert.rejects(f.service.review(f.scope, staged.identity), reason('local_changed'));
    assert.equal(f.dump(), before);
  }
});

test('acknowledged apply atomically writes exact core, personal and history while preserving accepted server base and late local edits', async (t) => {
  const f = await fixture(t),
    staged = await f.stage(f.rich),
    authority = f.authority();
  const recipeId = catalogue.recipes[0]!.recipeId;
  const lateNoteId = randomUUID();
  f.db
    .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,2,?,?)')
    .run(lateNoteId, recipeId, JSON.stringify('Late local-only note'), later, later);
  f.db.exec(
    "UPDATE state_revision SET revision=2 WHERE collection='store'; UPDATE personal_state SET revision=2",
  );
  const review = await f.service.review(f.scope, staged.identity);
  assert.equal(review.merge.status, 'merged');
  assert.ok(Object.isFrozen(review));
  assert.deepEqual(review.comparison.account, staged.proposed);
  assert.deepEqual(
    review.comparison.local.planReferences,
    staged.capturedLocal.snapshot.planReferences,
  );
  assert.deepEqual(review.comparison.local.personal.notes, [
    {
      noteId: lateNoteId,
      recipeId,
      text: 'Late local-only note',
      deleted: false,
      createdAt: later,
      updatedAt: later,
    },
  ]);
  assert.deepEqual(
    review.comparison.local.cookingHistory,
    staged.capturedLocal.snapshot.cookingHistory,
  );
  assert.ok(
    Object.isFrozen(review.comparison) &&
      Object.isFrozen(review.comparison.local.personal.notes[0]),
  );
  assert.ok(Object.isFrozen(review.comparison.account!.planReferences[0]!.contentRef));
  assert.equal(
    Reflect.set(review.comparison.account!.personal.notes[0]!, 'text', 'Attempted alteration'),
    false,
  );
  const receipt = await f.service.apply(f.scope, review);
  assert.equal(receipt.serverRevision, 5);
  assert.equal(receipt.operationId, staged.identity.operationId);
  const settled = await f.journal.read(f.scope);
  assert.ok(settled);
  assert.equal(settled.pending, null);
  assert.deepEqual(settled.lastApply, receipt);
  assert.equal(
    canonicalAccountContentSnapshot(settled.base!.snapshot!),
    canonicalAccountContentSnapshot(staged.proposed),
  );
  const current = await f.capture();
  assert.equal(current.snapshot.personal.notes.length, 2);
  assert.ok(current.snapshot.personal.notes.some((row) => row.text === 'Late local-only note'));
  assert.deepEqual(current.snapshot.planReferences, staged.proposed.planReferences);
  assert.equal(current.snapshot.personal.manualItems[0]!.amountText, '2½');
  assert.deepEqual(
    current.snapshot.cookingHistory!.entries.map((row) => row.entry.eventId).sort(),
    staged.proposed.cookingHistory!.entries.map((row) => row.entry.eventId).sort(),
  );
  assert.equal(f.authority(), authority);
  assert.equal(f.notifications.length, 1);
  assert.ok(f.notifications[0]!.expanded.personalRevision);
  assert.ok(f.notifications[0]!.expanded.historyRevision);
  assert.equal((await f.ledger()).groups.length, 2);
  assert.equal(f.reservations(), 0);
  assert.equal(f.held(), false);
});

test('pull applies the exact retained account state without fabricating a push acknowledgement', async (t) => {
  const f = await fixture(t, false),
    staged = await f.stage(f.rich, 'pull');
  assert.equal(staged.journal.pending!.acknowledgement, null);
  const review = await f.service.review(f.scope, staged.identity),
    receipt = await f.service.apply(f.scope, review);
  assert.deepEqual(review.comparison.local, staged.capturedLocal.snapshot);
  assert.deepEqual(review.comparison.account, staged.journal.pending!.remote.snapshot);
  assert.equal(receipt.serverRevision, 4);
  assert.deepEqual((await f.journal.read(f.scope))!.base, staged.journal.pending!.remote);
});

test('lost apply COMMIT acknowledgement recovers exact durable receipt, then retry and reopen do not reapply', async (t) => {
  const f = await fixture(t),
    staged = await f.stage(f.rich),
    review = await f.service.review(f.scope, staged.identity);
  f.afterCommit(() => {
    throw new Error('lost apply commit acknowledgement');
  });
  const receipt = await f.service.apply(f.scope, review),
    after = f.dump();
  await assert.rejects(f.service.apply(f.scope, review), reason('operation_changed'));
  assert.deepEqual(await f.service.recover(f.scope, staged.identity), receipt);
  assert.equal(f.dump(), after);
  assert.equal(f.notifications.length, 1);
  await f.reopen();
  assert.deepEqual(await f.service.recover(f.scope, staged.identity), receipt);
  assert.equal(f.dump(), after);
  assert.equal(f.notifications.length, 1);
});

test('a fault after core, personal or history writes rolls back every subsystem and leaves the exact pending journal', async (t) => {
  for (const prefix of [
    'INSERT INTO plan_occurrence',
    'INSERT INTO recipe_note',
    'INSERT INTO account_cooking_history(',
  ]) {
    const f = await fixture(t),
      staged = await f.stage(f.rich),
      review = await f.service.review(f.scope, staged.identity),
      before = f.dump();
    let fired = false;
    f.afterRun((sql) => {
      if (sql.startsWith(prefix)) {
        fired = true;
        throw new Error(`injected ${prefix}`);
      }
    });
    await assert.rejects(f.service.apply(f.scope, review), /injected/);
    assert.equal(fired, true);
    assert.equal(f.dump(), before);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.reservations(), 0);
    assert.equal(f.held(), false);
    f.afterRun(undefined);
    assert.equal(await f.service.recover(f.scope, staged.identity), null);
  }
});

test('late exact-history content mismatch rolls back already executed core and personal work', async (t) => {
  const f = await fixture(t),
    staged = await f.stage((snapshot) => {
      f.rich(snapshot);
      snapshot.cookingHistory!.entries.at(-1)!.entry.recipeTitle = 'Wrong immutable title';
    });
  const review = await f.service.review(f.scope, staged.identity),
    before = f.dump();
  let personalWrites = 0;
  f.afterRun((sql) => {
    if (sql.startsWith('INSERT INTO recipe_note')) personalWrites++;
  });
  await assert.rejects(f.service.apply(f.scope, review), reason('history_content_mismatch'));
  assert.ok(personalWrites > 0);
  assert.equal(f.dump(), before);
  assert.equal(f.notifications.length, 0);
});

test('missing acknowledgement, cloned review and another service token cannot authorize local writes', async (t) => {
  const f = await fixture(t),
    staged = await f.stage(f.rich, 'push', false),
    before = f.dump();
  await assert.rejects(
    f.service.review(f.scope, staged.identity),
    reason('acknowledgement_required'),
  );
  assert.equal(f.dump(), before);
  const acknowledged = await f.journal.recordAcknowledgement(f.scope, {
    ...staged.identity,
    receipt: { ownerId, operationId: staged.identity.operationId, revision: 5, committedAt: at },
  });
  assert.ok(acknowledged.pending!.acknowledgement);
  const review = await f.service.review(f.scope, staged.identity),
    unchanged = f.dump(),
    other = f.newService();
  try {
    await assert.rejects(f.service.apply(f.scope, copy(review)), reason('invalid_input'));
    await assert.rejects(other.apply(f.scope, review), reason('invalid_input'));
  } finally {
    other.close();
  }
  assert.equal(f.dump(), unchanged);
  assert.equal(f.notifications.length, 0);
});

test('explicit removal conflicts require exact reviewed choices; unused choices or no choice do not mutate', async (t) => {
  const f = await fixture(t, false),
    noteId = randomUUID();
  const staged = await f.stage((snapshot) => {
    snapshot.personal.notes.push({
      noteId,
      recipeId: '90001',
      text: 'Account live note',
      deleted: false,
      createdAt: at,
      updatedAt: at,
    });
  });
  f.db.prepare('INSERT INTO recipe_note VALUES (?,?,NULL,1,2,?,?)').run(noteId, '90001', at, later);
  f.db.exec(
    "UPDATE personal_state SET revision=2; UPDATE state_revision SET revision=2 WHERE collection='store'",
  );
  const review = await f.service.review(f.scope, staged.identity),
    before = f.dump();
  assert.equal(review.merge.status, 'needs_review');
  if (review.merge.status !== 'needs_review') assert.fail();
  assert.equal(review.merge.conflicts.length, 1);
  await assert.rejects(f.service.apply(f.scope, review), reason('invalid_input'));
  await assert.rejects(f.service.apply(f.scope, review, { unrelated: 'account' }));
  assert.equal(f.dump(), before);
  const choice = review.merge.conflicts[0]!.id;
  await f.service.apply(f.scope, review, { [choice]: 'local' });
  assert.equal(
    f.db.prepare('SELECT deleted FROM recipe_note WHERE recipe_id=?').get('90001')!.deleted,
    1,
  );
  assert.equal(
    (await f.journal.read(f.scope))!.base!.snapshot!.personal.notes[0]!.deleted,
    false,
    'Accepted server base is not rewritten to the local removal choice',
  );
  const settled = f.dump();
  await assert.rejects(
    f.service.apply(f.scope, review, { [choice]: 'account' }),
    reason('operation_changed'),
  );
  assert.equal(f.dump(), settled);
  assert.equal(f.notifications.length, 1);
});

test('competing issued tokens in one host or separate hosts cannot report old receipts as acceptance of different conflict choices', async (t) => {
  for (const separate of [false, true]) {
    const f = await fixture(t, false),
      noteId = randomUUID();
    const staged = await f.stage((snapshot) =>
      snapshot.personal.notes.push({
        noteId,
        recipeId: '90001',
        text: 'Remote live note',
        deleted: false,
        createdAt: at,
        updatedAt: at,
      }),
    );
    f.db
      .prepare('INSERT INTO recipe_note VALUES (?,?,NULL,1,2,?,?)')
      .run(noteId, '90001', at, later);
    f.db.exec(
      "UPDATE personal_state SET revision=2; UPDATE state_revision SET revision=2 WHERE collection='store'",
    );
    const second = separate ? f.newService() : f.service;
    try {
      const firstReview = await f.service.review(f.scope, staged.identity);
      const secondReview = await second.review(f.scope, staged.identity);
      assert.notEqual(firstReview, secondReview);
      assert.equal(firstReview.merge.status, 'needs_review');
      assert.equal(secondReview.merge.status, 'needs_review');
      if (
        firstReview.merge.status !== 'needs_review' ||
        secondReview.merge.status !== 'needs_review'
      )
        assert.fail();
      const firstChoice = firstReview.merge.conflicts[0]!.id,
        secondChoice = secondReview.merge.conflicts[0]!.id;
      assert.equal(firstChoice, secondChoice);
      const receipt = await f.service.apply(f.scope, firstReview, { [firstChoice]: 'local' });
      const settled = f.dump();
      await assert.rejects(
        second.apply(f.scope, secondReview, { [secondChoice]: 'account' }),
        reason('operation_changed'),
      );
      assert.deepEqual(await second.recover(f.scope, staged.identity), receipt);
      assert.equal(f.dump(), settled);
      assert.equal(
        f.db.prepare('SELECT deleted FROM recipe_note WHERE recipe_id=?').get('90001')!.deleted,
        1,
      );
      assert.equal(f.notifications.length, 1);
      assert.equal(f.held(), false);
    } finally {
      if (separate) second.close();
    }
  }
});

test('owner loss, service close and content lifetime loss during writes roll back without notifications', async (t) => {
  for (const loss of ['owner', 'close', 'content'] as const) {
    const f = await fixture(t),
      staged = await f.stage(f.rich),
      review = await f.service.review(f.scope, staged.identity),
      before = f.dump();
    let fired = false;
    f.afterRun((sql) => {
      if (!fired && sql.startsWith('INSERT INTO plan_occurrence')) {
        fired = true;
        if (loss === 'owner') f.setScope({ ownerId: otherOwnerId, authGeneration: 2 });
        else if (loss === 'close') f.service.close();
        else f.closeContent();
      }
    });
    await assert.rejects(f.service.apply(f.scope, review));
    assert.equal(fired, true);
    assert.equal(f.dump(), before);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.held(), false);
    assert.equal(f.reservations(), 0);
  }
});

test('final admission after awaited observer denies owner drift before COMMIT', async (t) => {
  const f = await fixture(t),
    staged = await f.stage(f.rich),
    review = await f.service.review(f.scope, staged.identity),
    before = f.dump();
  f.afterObserver(() => f.setScope(null));
  await assert.rejects(f.service.apply(f.scope, review), reason('account_changed'));
  assert.equal(f.dump(), before);
  assert.equal(f.notifications.length, 0);
});

test('owner loss after durable COMMIT suppresses delivery but original owner can recover exact application', async (t) => {
  const f = await fixture(t),
    staged = await f.stage(f.rich),
    review = await f.service.review(f.scope, staged.identity);
  f.afterCommit(() => f.setScope({ ownerId: otherOwnerId, authGeneration: 2 }));
  await assert.rejects(f.service.apply(f.scope, review), reason('account_changed'));
  assert.equal(f.notifications.length, 0);
  f.setScope(f.scope);
  const receipt = await f.service.recover(f.scope, staged.identity);
  assert.ok(receipt);
  assert.equal((await f.journal.read(f.scope))!.pending, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM plan_occurrence').get()!.n, 2);
});

test('changed settings, adoption, latest trusted head, restore epoch or local clocks stale a reviewed apply', async (t) => {
  for (const change of ['settings', 'adoption', 'latest', 'restore', 'store'] as const) {
    const f = await fixture(t),
      staged = await f.stage(f.rich),
      review = await f.service.review(f.scope, staged.identity);
    if (change === 'settings')
      f.setSettings({ ...settings(), profile: { displayName: 'Changed after review' } });
    else if (change === 'adoption')
      f.db.exec('UPDATE app_content_adoption SET revision=revision+1');
    else if (change === 'latest')
      f.latest({ releaseId: 'new-latest', sequence: 3, fingerprint: 'b'.repeat(64) });
    else if (change === 'restore')
      f.db
        .prepare('INSERT INTO portable_restore_operation VALUES (?,?,1,2,?,?,?)')
        .run(randomUUID(), 'a'.repeat(64), '{}', '{}', '{}');
    else f.db.exec("UPDATE state_revision SET revision=2 WHERE collection='store'");
    const before = f.dump();
    await assert.rejects(f.service.apply(f.scope, review));
    assert.equal(f.dump(), before);
    assert.equal(f.notifications.length, 0);
  }
});

test('history exclusion preserves local and remote history, with durable settings applied and acknowledged separately', async (t) => {
  const f = await fixture(t, false),
    historyBefore = f.db.prepare('SELECT * FROM cooking_event').all();
  const staged = await f.stage((snapshot) => {
    f.rich(snapshot);
    snapshot.appPreferences.theme = 'dark';
    snapshot.profile.displayName = 'Account name';
    snapshot.cookingHistory = {
      entries: [
        {
          kind: 'exact',
          entry: {
            readerVersion: 2,
            recipeId: '90001',
            contentRef: copy(f.second.revision.ref),
            eventId: randomUUID(),
            recipeTitle: f.second.revision.document.recipe.title,
            photoAssetId: null,
            cookedOn: '2026-10-01',
            timeZone: 'Asia/Dubai',
            recordedAt: at,
            note: 'Remote excluded history',
          },
        },
      ],
      removedEventIds: [],
    };
  }, 'pull');
  const review = await f.service.review(f.scope, staged.identity),
    receipt = await f.service.apply(f.scope, review);
  assert.deepEqual(f.db.prepare('SELECT * FROM cooking_event').all(), historyBefore);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_cooking_history').get()!.n, 0);
  assert.deepEqual(
    (await f.journal.read(f.scope))!.base!.snapshot!.cookingHistory,
    staged.proposed.cookingHistory,
  );
  const pending = await f.service.inspectSettings(f.scope);
  assert.ok(pending);
  assert.equal(pending.operationId, receipt.operationId);
  assert.equal(pending.projection.appPreferences.theme, 'dark');
  await assert.rejects(f.capture(), reason('settings_pending'));
  await assert.rejects(f.service.acknowledgeSettings(f.scope, pending), reason('settings_changed'));
  f.setSettings(copy(pending.projection));
  await f.service.acknowledgeSettings(f.scope, pending);
  assert.equal(await f.service.inspectSettings(f.scope), null);
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(ACCOUNT_SETTINGS_KEY),
    undefined,
  );
  await f.service.acknowledgeSettings(f.scope, pending);
  assert.equal((await f.capture()).snapshot.appPreferences.theme, 'dark');
});

test('exclusive admission refuses overlapping work and released inspections never leak on review failure', async (t) => {
  const f = await fixture(t),
    staged = await f.stage(f.rich),
    review = await f.service.review(f.scope, staged.identity),
    before = f.dump();
  f.busy(true);
  await assert.rejects(f.service.apply(f.scope, review), reason('store_busy'));
  assert.equal(f.dump(), before);
  f.busy(false);
  f.afterInspection(() => f.setScope(null));
  await assert.rejects(f.service.review(f.scope, staged.identity), reason('account_changed'));
  assert.equal(f.reservations(), 0);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.dump(), before);
});

test('live-only account proposals cannot bypass retained local favourite and preference removals', async (t) => {
  for (const removed of ['favourite', 'preference'] as const) {
    const f = await fixture(t, false);
    if (removed === 'favourite')
      f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run('90001', at, at);
    else
      f.db.exec(
        "UPDATE preference_state SET last_removal_revision=1; UPDATE state_revision SET revision=1 WHERE collection='preferences'",
      );
    const staged = await f.stage((snapshot) => {
      if (removed === 'favourite') snapshot.favourites.push({ recipeId: '90001', savedAt: at });
      else
        snapshot.preferences.push({
          preferenceId: randomUUID(),
          type: 'ingredient_avoid',
          value: 'Nuts',
        });
    }, 'pull');
    const review = await f.service.review(f.scope, staged.identity),
      before = f.dump();
    assert.equal(review.merge.status, 'merged');
    assert.deepEqual(review.blockers, ['removed_core_choices']);
    await assert.rejects(f.service.apply(f.scope, review), reason('recovery_required'));
    assert.equal(f.dump(), before);
    assert.equal(f.notifications.length, 0);
    assert.ok((await f.journal.read(f.scope))!.pending);
  }
});

test('issued core-removal choices keep or restore exact rows without rewriting the accepted server base', async (t) => {
  for (const kind of ['favourite', 'preference'] as const) {
    for (const decision of ['keep_local', 'save_account_version'] as const) {
      const f = await fixture(t, false),
        preferenceId = randomUUID();
      if (kind === 'favourite')
        f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run('90001', at, at);
      else
        f.db.exec(
          "UPDATE preference_state SET last_removal_revision=1; UPDATE state_revision SET revision=1 WHERE collection='preferences'",
        );
      const staged = await f.stage((snapshot) => {
        if (kind === 'favourite') snapshot.favourites.push({ recipeId: '90001', savedAt: at });
        else snapshot.preferences.push({ preferenceId, type: 'ingredient_avoid', value: 'Nuts' });
      }, 'pull');
      const review = await f.service.review(f.scope, staged.identity),
        before = f.dump();
      assert.equal(review.removalReview?.conflicts.length, 1);
      const id = review.removalReview!.conflicts[0]!.id;
      await assert.rejects(
        f.service.apply(f.scope, copy(review), undefined, { [id]: decision }),
        reason('invalid_input'),
      );
      await assert.rejects(
        f.service.apply(f.scope, review, undefined, {}),
        reason('invalid_input'),
      );
      assert.equal(f.dump(), before);
      const receipt = await f.service.apply(f.scope, review, undefined, { [id]: decision });
      assert.deepEqual(await f.service.recover(f.scope, staged.identity), receipt);
      const current = (await f.capture()).snapshot;
      assert.equal(
        kind === 'favourite' ? current.favourites.length : current.preferences.length,
        decision === 'keep_local' ? 0 : 1,
      );
      const base = (await f.journal.read(f.scope))!.base!.snapshot!;
      assert.equal(kind === 'favourite' ? base.favourites.length : base.preferences.length, 1);
      const settled = f.dump();
      await assert.rejects(
        f.service.apply(f.scope, review, undefined, {
          [id]: decision === 'keep_local' ? 'save_account_version' : 'keep_local',
        }),
        reason('operation_changed'),
      );
      assert.equal(f.dump(), settled);
      assert.equal(f.notifications.length, 1);
    }
  }
});

test('core removal review expires when exact tombstone evidence changes even without a clock increment', async (t) => {
  const f = await fixture(t, false);
  f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run('90001', at, at);
  const staged = await f.stage(
    (snapshot) => snapshot.favourites.push({ recipeId: '90001', savedAt: at }),
    'pull',
  );
  const review = await f.service.review(f.scope, staged.identity);
  f.db.prepare('UPDATE favourite SET updated_at=? WHERE recipe_id=?').run(later, '90001');
  const before = f.dump();
  await assert.rejects(
    f.service.apply(f.scope, review, undefined, { 'favourite:90001': 'save_account_version' }),
    reason('local_changed'),
  );
  assert.equal(f.dump(), before);
  assert.equal(f.notifications.length, 0);
});

test('resolved ordinary merge receives a fresh core-removal review before a restored value can be applied', async (t) => {
  const f = await fixture(t, false),
    preferenceId = randomUUID();
  const staged = await f.stage(
    (snapshot) =>
      snapshot.preferences.push({ preferenceId, type: 'cuisine', value: 'Account version' }),
    'pull',
  );
  f.db
    .prepare('INSERT INTO saved_preference VALUES (?,?,?,2)')
    .run(preferenceId, 'cuisine', JSON.stringify('Local version'));
  f.db.exec(
    "UPDATE preference_state SET last_removal_revision=1; UPDATE state_revision SET revision=2 WHERE collection IN ('store','preferences')",
  );
  const review = await f.service.review(f.scope, staged.identity);
  assert.equal(review.merge.status, 'needs_review');
  if (review.merge.status !== 'needs_review') assert.fail();
  const resolutions = { [review.merge.conflicts[0]!.id]: 'account' as const },
    before = f.dump();
  await assert.rejects(f.service.apply(f.scope, review, resolutions), reason('recovery_required'));
  assert.equal(f.dump(), before);
  const resolved = await f.service.review(f.scope, staged.identity, resolutions);
  assert.equal(resolved.merge.status, 'merged');
  assert.equal(resolved.removalReview?.conflicts.length, 1);
  await f.service.apply(f.scope, resolved, undefined, {
    [`preference:${preferenceId}`]: 'keep_local',
  });
  assert.equal((await f.capture()).snapshot.preferences[0]!.value, 'Local version');
  assert.equal(
    (await f.journal.read(f.scope))!.base!.snapshot!.preferences[0]!.value,
    'Account version',
  );
});
