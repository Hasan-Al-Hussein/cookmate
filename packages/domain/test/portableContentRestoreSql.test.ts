import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
  type AccountSnapshotOptions,
} from '@cookmate/account-sync';
import {
  contentOverlaySignaturePayload,
  createBundledRecipeRevision,
  fingerprintContentOverlay,
  type ContentOverlayManifest,
  type OverlayEntry,
  type OverlayHead,
  type PublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import type { RepositoryResult, PortableRestoreResult } from '../src';
import { createPortableBackup } from '../src';
import {
  createPortableContentBackup,
  validatePortableContentBackup,
  type PortableContentBackupEnvelope,
  type PortableContentBackupInput,
} from '../src/portableBackupContent';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_GUEST_KEY,
  ACCOUNT_SETTINGS_KEY,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { createAccountContentScopeApprovalService } from '../../../apps/mobile/src/data/accountContentScopeApproval';
import { captureAccountContentLocal } from '../../../apps/mobile/src/data/accountContentCapture';
import { createAccountContentJournalRepository } from '../../../apps/mobile/src/data/accountContentJournal';
import { createAccountLegacyTransitionRepository } from '../../../apps/mobile/src/data/accountLegacyTransitionRepository';
import {
  createContentAdoptionService,
  type ContentAdoptionAccess,
} from '../../../apps/mobile/src/data/contentAdoption';
import { openContentReleaseStore } from '../../../apps/mobile/src/data/contentReleaseStore';
import { createPortableContentRestoreService } from '../../../apps/mobile/src/data/portableContentRestore';
import { createPortableRestoreService } from '../../../apps/mobile/src/data/portableRestore';
import { readBackupData } from '../../../apps/mobile/src/data/portableBackup';
import { createPortableContentBackupReader } from '../../../apps/mobile/src/data/portableContentBackup';
import { createContentCookingHistoryReader } from '../../../apps/mobile/src/data/contentCookingHistoryRead';
import { createContentCookingHistoryClear } from '../../../apps/mobile/src/data/contentCookingHistoryClear';
import { withdrawPreferenceVersions } from '../../../apps/mobile/src/data/preferenceProvenance';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { member, published } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Actual local SQLite, Ed25519 signatures and packaged photo bytes. No hosted service,
// production signing key, consumer UI, physical device or real user workspace is involved.
const at = '2026-10-01T12:00:00.000Z';
const sha256Bytes = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const privateText = '  Keep raw text\nملاحظات 🍲\u0000\\  ';
function ready<T>(result: RepositoryResult<T>): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function receipt(result: PortableRestoreResult) {
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail();
  return result.receipt;
}
async function fixture(t: TestContext, legacyRestore = false, databaseVersion: 7 | 8 = 7) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-restore-'));
  const path = join(directory, 'cooking.db');
  async function connection() {
    const write = desktopConnection(path),
      read = desktopConnection(path);
    await configureConnection(write.connection);
    await configureConnection(read.connection);
    await read.connection.exec('PRAGMA query_only=ON');
    const queue = new SqlTransactionQueue();
    return {
      write,
      read,
      writer: new SerializedWriter(write.connection, queue),
      reader: new SerializedReader(read.connection, queue),
    };
  }
  let current = await connection();
  const connections = [current],
    hosts: { close(): void }[] = [];
  let closeContent = async () => undefined as void;
  t.after(async () => {
    hosts.forEach((host) => host.close());
    for (const connection of connections) {
      await connection.reader.close();
      await connection.writer.close();
    }
    await closeContent();
    await removeFixtureDirectory(directory);
  });
  const installationId = randomUUID();
  await initializeDatabase(
    current.writer,
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
  let legacy: { saved: ReturnType<typeof receipt>; imported: string; before: string } | undefined;
  if (legacyRestore) {
    const legacyService = createPortableRestoreService({
      reader: current.reader,
      writer: current.writer,
      catalogue: catalogue.identity,
      knownRecipeIds: catalogue.boundary.recipeIds,
      platform: { newId: randomUUID, sha256 },
      now: () => at,
      sha256,
      readRecipe: (id) => catalogue.recipes.find((row) => row.recipeId === id),
      acquireExclusive: () => () => undefined,
      onCommitted: () => undefined,
    });
    const oldData = await current.reader.transaction(
      (session) => readBackupData(session, true, false),
      { kind: 'read_only' },
    );
    const imported = JSON.stringify(
      await createPortableBackup(
        {
          schemaVersion: 2,
          databaseSchemaVersion: 6,
          createdAt: at,
          catalogue: catalogue.identity,
          sourceRevision: 0,
          data: oldData,
        },
        sha256,
      ),
    );
    const command = ready(await legacyService.prepare(ready(await legacyService.review(imported))));
    const saved = receipt(await legacyService.execute(command));
    const before = ready(await legacyService.readArchive(command.operationId, 'before'));
    assert.ok(before);
    legacy = { saved, imported, before };
  }
  await migrateCookingContentDatabase(current.writer, { sha256 });
  const base = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256);
  const photo = await readFile(
    fileURLToPath(
      new URL(`../../catalogue/assets/photos/${base.ref.recipeId}.jpg`, import.meta.url),
    ),
  );
  const document = authoredFixture('90001');
  const metadata = await sharp(photo).metadata();
  document.recipe.photoKey = base.document.recipe.photoKey;
  document.media[0] = {
    ...document.media[0]!,
    ...base.document.media[0]!,
    recipeId: '90001',
    dimensions: {
      width: metadata.width!,
      height: metadata.height!,
      review: document.media[0]!.dimensions!.review,
    },
    rights: document.media[0]!.rights,
  };
  document.recipe.title = 'First exact restore fixture';
  const first = await published(document, 'restore-first');
  const nextDocument = clone(document);
  assert.equal(nextDocument.kind, 'authored');
  if (nextDocument.kind !== 'authored') assert.fail();
  nextDocument.recipe.title = 'Second exact restore fixture';
  nextDocument.recipe.ingredients[0]!.rawMeasure = '7 tbsp';
  nextDocument.provenance.basedOn = first.revision.ref;
  const second = await published(nextDocument, 'restore-second');
  const pair = generateKeyPairSync('ed25519');
  const keyId = 'private-restore-fixture';
  const content = await openContentReleaseStore({
    readConnection: desktopConnection(join(directory, 'content.db')).connection,
    writeConnection: desktopConnection(join(directory, 'content.db')).connection,
    now: () => new Date(at),
    sha256,
    sha256Bytes,
    readerVersion: 1,
    baseline: { identity: catalogue.identity, revisions: [base] },
    trustVerifier: createContentTrustVerifier([
      {
        keyId,
        publicKeyHex: Buffer.from(
          pair.publicKey.export({ format: 'jwk' }).x!,
          'base64url',
        ).toString('hex'),
      },
    ]),
    async inspectImage(bytes) {
      const image = sharp(bytes);
      try {
        const metadata = await image.metadata();
        return metadata.width && metadata.height && metadata.format === 'jpeg'
          ? { width: metadata.width, height: metadata.height, mimeType: 'image/jpeg' as const }
          : null;
      } finally {
        image.destroy();
      }
    },
    async readBundledMedia(reference) {
      return reference.sha256 === base.document.media[0]!.sha256 ? photo : null;
    },
  });
  closeContent = () => content.close();
  let head: OverlayHead | null = null;
  async function activate(entries: OverlayEntry[], publications: PublishedRecipeRevision[] = []) {
    const sequence = (head?.sequence ?? 0) + 1;
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `restore-release-${sequence}`,
      sequence,
      previous: head,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: catalogue.identity,
      entries,
    };
    const fingerprint = await fingerprintContentOverlay(manifest, sha256);
    const stage = await content.stage({
      stageId: `restore-stage-${sequence}`,
      envelope: {
        manifest,
        fingerprint,
        signature: {
          keyId,
          scheme: 'ed25519-hex-v1',
          value: sign(
            null,
            Buffer.from(contentOverlaySignaturePayload(manifest, fingerprint)),
            pair.privateKey,
          ).toString('hex'),
        },
      },
      publications,
      media: publications.length ? [{ sha256: base.document.media[0]!.sha256, bytes: photo }] : [],
    });
    head = (
      await content.activate(
        await content.reviewStage(stage.stageId, { expectedHead: head, retainedRefs: [] }),
        `restore-activate-${sequence}`,
      )
    ).head;
    return head;
  }
  await activate([member(first)], [first]);
  await activate([member(second)], [second]);
  await activate([{ ...member(second), state: 'archived', reason: 'Private archived fixture' }]);
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 1 };
  const accessPorts = {
    getAccess: () => access,
    assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
      assert.deepEqual(scope, access);
      return undefined;
    },
  };
  const adoption = createContentAdoptionService({
    reader: current.reader,
    writer: current.writer,
    contentStore: content,
    sha256,
    now: () => at,
    newId: randomUUID,
    ...accessPorts,
  });
  await adoption.adopt(await adoption.review({ candidateHead: head! }));
  if (databaseVersion === 8) await migrateAccountContentHistoryDatabase(current.writer, { sha256 });
  let busy = false,
    hashHook: (() => void) | undefined,
    commits = 0;
  const hash = async (value: string) => {
    const callback = hashHook;
    hashHook = undefined;
    callback?.();
    return sha256(value);
  };
  function makeService(targetVersion: 7 | 8 = databaseVersion) {
    const value = createPortableContentRestoreService({
      ...(targetVersion === 8 ? { cookingSchemaVersion: 8 as const } : {}),
      reader: current.reader,
      writer: current.writer,
      contentStore: content,
      installationId,
      catalogue: catalogue.identity,
      sha256: hash,
      now: () => at,
      newId: randomUUID,
      ...accessPorts,
      acquireExclusive() {
        if (busy) return null;
        busy = true;
        return () => {
          busy = false;
        };
      },
      onCommitted() {
        commits++;
      },
    });
    hosts.push(value);
    return value;
  }
  let service = makeService();
  const occurrenceIds = [randomUUID(), randomUUID()];
  const data: PortableContentBackupInput = {
    schemaVersion: 3,
    databaseSchemaVersion: 7,
    createdAt: at,
    catalogue: catalogue.identity,
    sourceRevision: 1,
    data: {
      favourites: [
        {
          recipeId: first.revision.ref.recipeId,
          saved: true,
          revision: 1,
          savedAt: at,
          updatedAt: at,
        },
      ],
      occurrences: [first, second].map((value, index) => ({
        occurrenceId: occurrenceIds[index]!,
        recipeId: value.revision.ref.recipeId,
        placement: { actualDate: index ? '2026-10-08' : '2026-10-01', mealKey: 'dinner' },
        revision: 1,
        createdAt: at,
        updatedAt: at,
      })),
      planReferences: [first, second].map((value, index) => ({
        occurrenceId: occurrenceIds[index]!,
        contentRef: value.revision.ref,
      })),
      shopping: {
        scope: { scopeId: randomUUID(), revision: 1, occurrenceIds },
        projectionRevision: 1,
        projectionStatus: 'current',
        purchaseMarks: [],
      },
      preferences: {
        snapshot: { revision: 0, lastRemovalRevision: null, items: [] },
        removals: [],
      },
      personal: {
        notes: [
          {
            noteId: randomUUID(),
            recipeId: first.revision.ref.recipeId,
            text: privateText,
            deleted: false,
            revision: 1,
            createdAt: at,
            updatedAt: at,
          },
        ],
        collections: [],
        memberships: [],
        manualItems: [],
      },
      cookingHistory: {
        entries: [first, second].map((value) => ({
          kind: 'exact' as const,
          entry: {
            readerVersion: 2 as const,
            recipeId: value.revision.ref.recipeId,
            contentRef: value.revision.ref,
            eventId: randomUUID(),
            recipeTitle: value.revision.document.recipe.title,
            photoAssetId: value.revision.document.media[0]!.assetId,
            cookedOn: '2026-10-01',
            timeZone: 'Asia/Dubai',
            recordedAt: at,
            note: privateText,
            historyEpoch: 0,
            revision: 1,
          },
        })),
      },
    },
  };
  const serialize = () =>
    createPortableContentBackup(data, sha256).then((value) => JSON.stringify(value));
  function rows() {
    const db = current.write.database;
    return JSON.stringify(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => [row.name, db.prepare(`SELECT * FROM "${row.name}"`).all()]),
    );
  }
  return {
    get db() {
      return current.write.database;
    },
    get service() {
      return service;
    },
    get writer() {
      return current.writer;
    },
    get reader() {
      return current.reader;
    },
    get connections() {
      return [current.read.connection, current.write.connection];
    },
    installationId,
    makeService,
    data,
    legacy,
    first,
    second,
    base,
    serialize,
    activate,
    rows,
    get commits() {
      return commits;
    },
    setBusy(value: boolean) {
      busy = value;
    },
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    bind(ownerId: string) {
      current.write.database
        .prepare('INSERT INTO app_metadata VALUES (?,?)')
        .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId }));
      service.close();
      const bound = { ownerId, authGeneration: 2 };
      access = bound;
      service = makeService();
      return bound;
    },
    onNextHash(callback: () => void) {
      hashHook = callback;
    },
    async prepared() {
      const review = ready(await service.review(await serialize()));
      assert.deepEqual(review.blockers, []);
      return ready(await service.prepare(review));
    },
    async capture() {
      const reader = createPortableContentBackupReader({
        reader: current.reader,
        installationId,
        catalogue: catalogue.identity,
        sha256,
        now: () => at,
        ...accessPorts,
      });
      try {
        return ready(await reader.capture({ includeCookingHistory: true }));
      } finally {
        reader.close();
      }
    },
    history() {
      const value = createContentCookingHistoryReader({
        reader: current.reader,
        installationId,
        sha256,
        ...accessPorts,
      });
      hosts.push(value);
      return value;
    },
    clear() {
      const value = createContentCookingHistoryClear({
        ...(databaseVersion === 8 ? { cookingSchemaVersion: 8 as const } : {}),
        reader: current.reader,
        writer: current.writer,
        installationId,
        sha256,
        now: () => at,
        newId: randomUUID,
        onCommitted: () => undefined,
        ...accessPorts,
      });
      hosts.push(value);
      return value;
    },
    async reopen() {
      service.close();
      await current.reader.close();
      await current.writer.close();
      current = await connection();
      connections.push(current);
      service = makeService();
    },
    loseNextCommitAcknowledgement() {
      const previous = current.write.connection.exec;
      let fired = false;
      current.write.connection.exec = async (sql) => {
        await previous(sql);
        if (sql === 'COMMIT' && !fired) {
          fired = true;
          throw new Error('fixture lost acknowledgement');
        }
      };
    },
    failNextImport() {
      const previous = current.write.connection.prepare;
      current.write.connection.prepare = async (sql) => {
        if (sql.startsWith('INSERT INTO imported_cooking_history'))
          throw new Error('fixture before commit');
        return previous(sql);
      };
    },
  };
}

for (const version of [7, 8] as const)
  test(`physical${version} reviewed restore applies two archived/historical exact recipe versions atomically with real signed content and raw personal text`, async (t) => {
    const f = await fixture(t, false, version),
      before = f.rows(),
      serialized = await f.serialize();
    const review = ready(await f.service.review(serialized));
    assert.deepEqual(review.blockers, []);
    assert.equal(f.rows(), before, 'review must not mutate cooking data');
    const command = ready(await f.service.prepare(review));
    const saved = receipt(await f.service.execute(command));
    assert.equal(f.commits, 1);
    assert.equal(saved.restoredCounts.plannedMeals, 2);
    const capture = await f.capture();
    const sortPins = (rows: typeof capture.data.planReferences) =>
      [...rows].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));
    assert.deepEqual(sortPins(capture.data.planReferences), sortPins(f.data.data.planReferences));
    assert.equal(capture.data.personal.notes[0]!.text, privateText);
    assert.equal(capture.data.cookingHistory?.entries.length, 2);
    assert.deepEqual(
      capture.data.cookingHistory!.entries.map((row) => row.entry.recipeTitle).sort(),
      [f.first.revision.document.recipe.title, f.second.revision.document.recipe.title].sort(),
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) count FROM content_cooking_event_authority').get()!.count,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) count FROM recipe WHERE recipe_id='90001'").get()!.count,
      0,
      'authored records never overwrite the original imported catalogue',
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(DISTINCT revision_id) count FROM shopping_contribution').get()!
        .count,
      2,
    );
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(ready(await f.service.readArchive(command.operationId, 'imported')), serialized);
    const archived = ready(await f.service.readArchive(command.operationId, 'before'));
    assert.ok(archived);
    const decoded = await validatePortableContentBackup(archived, { sha256 });
    assert.equal(decoded.kind, 'ready');
    if (decoded.kind === 'ready') assert.equal(decoded.value.data.occurrences.length, 0);
    const committed = f.rows();
    assert.deepEqual(receipt(await f.service.execute(command)), saved);
    assert.equal(f.rows(), committed, 'retry must not duplicate history or alter records');
    await f.reopen();
    assert.deepEqual(ready(await f.service.readReceipt(command.operationId)), saved);
    assert.deepEqual(receipt(await f.service.execute(command)), saved);
  });

test('cloned approvals, changed data, owner changes and a closed service cannot authorize a restore', async (t) => {
  const f = await fixture(t, false, 8),
    before = f.rows();
  const review = ready(await f.service.review(await f.serialize()));
  assert.equal((await f.service.prepare(clone(review))).kind, 'failed');
  const command = ready(await f.service.prepare(review));
  assert.equal((await f.service.execute(clone(command))).kind, 'failed');
  f.setBusy(true);
  assert.equal((await f.service.execute(command)).kind, 'failed');
  f.setBusy(false);
  f.setAccess({ ownerId: null, authGeneration: 2 });
  assert.equal((await f.service.execute(command)).kind, 'failed');
  assert.equal(f.rows(), before);
  f.setAccess({ ownerId: null, authGeneration: 1 });
  f.service.close();
  assert.equal((await f.service.execute(command)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('new authenticated withdrawal invalidates an earlier review even without changing the adopted cooking head', async (t) => {
  const f = await fixture(t, false, 8),
    command = await f.prepared(),
    before = f.rows();
  await f.activate([
    {
      recipeId: f.second.revision.ref.recipeId,
      state: 'withdrawn',
      reason: 'Private rights withdrawal',
    },
  ]);
  assert.equal((await f.service.execute(command)).kind, 'failed');
  assert.equal(f.rows(), before);
  const review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.length);
  assert.equal((await f.service.prepare(review)).kind, 'failed');
});

test('missing exact references and mismatched history metadata block the whole replacement without partial imports', async (t) => {
  const f = await fixture(t),
    before = f.rows();
  f.data.data.planReferences[0]!.contentRef = {
    ...f.first.revision.ref,
    contentFingerprint: 'e'.repeat(64),
  };
  let review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.length);
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  f.data.data.planReferences[0]!.contentRef = f.first.revision.ref;
  f.data.data.cookingHistory!.entries[0]!.entry.recipeTitle = 'Invented different title';
  review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.length);
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('write failure rolls back all plans, pins, private data, history and archives', async (t) => {
  const f = await fixture(t, false, 8),
    command = await f.prepared(),
    before = f.rows();
  f.failNextImport();
  assert.equal((await f.service.execute(command)).kind, 'failed');
  assert.equal(f.rows(), before);
  assert.equal(f.commits, 0);
});

test('lost commit acknowledgement is recovered from the durable same-operation receipt', async (t) => {
  const f = await fixture(t, false, 8),
    command = await f.prepared();
  f.loseNextCommitAcknowledgement();
  const result = await f.service.execute(command);
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  assert.equal(
    f.db.prepare('SELECT COUNT(*) count FROM portable_restore_operation').get()!.count,
    1,
  );
  await f.reopen();
  const saved = ready(await f.service.readReceipt(command.operationId));
  assert.ok(saved);
  assert.deepEqual(receipt(await f.service.execute(command)), saved);
});

test('known history removals block stale files without changing current records', async (t) => {
  const f = await fixture(t);
  const eventId = f.data.data.cookingHistory!.entries[0]!.entry.eventId;
  f.db.prepare('INSERT INTO cooking_history_withdrawal(event_id) VALUES (?)').run(eventId);
  const before = f.rows();
  const review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.length);
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('a newer signed release and local edits each invalidate the corresponding pending review', async (t) => {
  const f = await fixture(t),
    first = await f.prepared();
  await f.activate([
    { ...member(f.second), state: 'archived', reason: 'Revised private archive note' },
  ]);
  assert.equal((await f.service.execute(first)).kind, 'failed');
  const second = await f.prepared();
  f.db.exec("UPDATE state_revision SET revision=revision+1 WHERE collection='store'");
  const before = f.rows();
  assert.equal((await f.service.execute(second)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('history excluded from a subsequent restore remains byte-for-byte unchanged', async (t) => {
  const f = await fixture(t, false, 8);
  receipt(await f.service.execute(await f.prepared()));
  const history = () =>
    JSON.stringify(
      [
        'cooking_state',
        'cooking_event',
        'imported_cooking_history',
        'imported_history_content_pin',
        'local_history_content_pin',
        'cooking_history_withdrawal',
      ].map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
    );
  const before = history();
  delete f.data.data.cookingHistory;
  receipt(await f.service.execute(await f.prepared()));
  assert.equal(history(), before);
  assert.equal(ready(await f.history().readHistory()).items.length, 2);
});

test('reviewed clear after an actual restore retains imported lineage and prevents resurrection through the original file', async (t) => {
  const f = await fixture(t);
  receipt(await f.service.execute(await f.prepared()));
  const clear = f.clear();
  const review = ready(await clear.reviewClearHistory());
  const cleared = await clear.clearHistory(review, randomUUID());
  assert.equal(cleared.kind, 'ready', JSON.stringify(cleared));
  assert.equal(ready(await f.history().readHistory()).items.length, 0);
  const before = f.rows();
  const blocked = ready(await f.service.review(await f.serialize()));
  assert.ok(blocked.blockers.length);
  assert.equal((await f.service.prepare(blocked)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('owner loss during an awaited checksum leaves no review or writes', async (t) => {
  const f = await fixture(t, false, 8),
    serialized = await f.serialize(),
    before = f.rows();
  f.onNextHash(() => f.setAccess(null));
  assert.equal((await f.service.review(serialized)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('purchase marks survive only when the exact restored source demand still matches', async (t) => {
  const f = await fixture(t);
  receipt(await f.service.execute(await f.prepared()));
  f.db.exec('UPDATE purchase_state SET purchased=1,changed=0');
  const {
    format: _format,
    counts: _counts,
    integrity: _integrity,
    ...exported
  } = JSON.parse(JSON.stringify(await f.capture())) as PortableContentBackupEnvelope;
  delete exported.data.cookingHistory;
  let serialized = JSON.stringify(await createPortableContentBackup(exported, sha256));
  let review = ready(await f.service.review(serialized));
  assert.deepEqual(review.blockers, []);
  assert.ok(review.shopping && review.shopping.restoredChecks > 0);
  const saved = receipt(await f.service.execute(ready(await f.service.prepare(review))));
  assert.equal(saved.shopping.restoredChecks, review.shopping.restoredChecks);
  for (const mark of exported.data.shopping.purchaseMarks) mark.demandFingerprint = 'e'.repeat(64);
  serialized = JSON.stringify(await createPortableContentBackup(exported, sha256));
  review = ready(await f.service.review(serialized));
  assert.equal(review.shopping?.restoredChecks, 0);
  assert.ok(review.shopping && review.shopping.uncheckedImportedChecks > 0);
  receipt(await f.service.execute(ready(await f.service.prepare(review))));
  assert.equal(
    f.db.prepare('SELECT COUNT(*) count FROM purchase_state WHERE purchased=1').get()!.count,
    0,
  );
});

test('a deleted private note cannot be revived by an older valid backup', async (t) => {
  const f = await fixture(t);
  receipt(await f.service.execute(await f.prepared()));
  f.db.exec(
    "UPDATE recipe_note SET deleted=1,text=NULL; UPDATE state_revision SET revision=revision+1 WHERE collection='store'",
  );
  delete f.data.data.cookingHistory;
  const before = f.rows();
  const review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.includes('personal_removal_conflict'));
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('favourite tombstones survive replacement and block a stale saved favourite', async (t) => {
  const f = await fixture(t);
  receipt(await f.service.execute(await f.prepared()));
  delete f.data.data.cookingHistory;
  f.data.data.favourites = [];
  receipt(await f.service.execute(await f.prepared()));
  assert.equal(f.db.prepare("SELECT saved FROM favourite WHERE recipe_id='90001'").get()!.saved, 0);
  f.data.data.favourites = [
    { recipeId: '90001', saved: true, revision: 1, savedAt: at, updatedAt: at },
  ];
  const before = f.rows(),
    review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.includes('favourite_removal_conflict'));
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('preference deletion facts retained in an actual import archive block later stale backup revival', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID();
  delete f.data.data.cookingHistory;
  f.data.sourceRevision = 2;
  f.data.data.preferences = {
    snapshot: { revision: 2, lastRemovalRevision: 2, items: [] },
    removals: [
      { preferenceId, type: 'cuisine', value: 'Italian', savedRevision: 1, removedRevision: 2 },
    ],
  };
  receipt(await f.service.execute(await f.prepared()));
  f.data.data.preferences = {
    snapshot: {
      revision: 1,
      lastRemovalRevision: null,
      items: [{ preferenceId, type: 'cuisine', value: 'Italian', revision: 1 }],
    },
    removals: [],
  };
  const before = f.rows(),
    review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.includes('preference_removal_conflict'));
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('a direct-preference withdrawal without a message-source row still blocks old backup revival', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID();
  delete f.data.data.cookingHistory;
  f.data.data.preferences = {
    snapshot: {
      revision: 1,
      lastRemovalRevision: null,
      items: [{ preferenceId, type: 'cuisine', value: 'Italian', revision: 1 }],
    },
    removals: [],
  };
  receipt(await f.service.execute(await f.prepared()));
  const current = await f.capture();
  const removedRevision = current.sourceRevision + 1;
  await f.writer.transaction(async (session) => {
    await withdrawPreferenceVersions(
      session,
      current.data.preferences.snapshot.items,
      removedRevision,
    );
    await session.exec(
      `DELETE FROM saved_preference; UPDATE state_revision SET revision=${removedRevision} WHERE collection IN ('store','preferences')`,
    );
  });
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM source_preference_link').get()!.count, 0);
  const before = f.rows(),
    review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.includes('preference_removal_conflict'));
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('an old unselected withdrawn plan may be removed by a valid replacement without reopening its recipe body', async (t) => {
  const f = await fixture(t);
  f.data.data.shopping.scope.occurrenceIds = [];
  receipt(await f.service.execute(await f.prepared()));
  await f.activate([
    {
      recipeId: f.second.revision.ref.recipeId,
      state: 'withdrawn',
      reason: 'Private withdrawal after earlier plan',
    },
  ]);
  delete f.data.data.cookingHistory;
  f.data.data.occurrences = [];
  f.data.data.planReferences = [];
  f.data.data.favourites = [];
  f.data.data.personal.notes = [];
  const review = ready(await f.service.review(await f.serialize()));
  assert.deepEqual(review.blockers, []);
  receipt(await f.service.execute(ready(await f.service.prepare(review))));
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM plan_occurrence').get()!.count, 0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('authored favourites and private notes round trip without invented plan/history revisions', async (t) => {
  const f = await fixture(t);
  delete f.data.data.cookingHistory;
  f.data.data.occurrences = [];
  f.data.data.planReferences = [];
  f.data.data.shopping.scope.occurrenceIds = [];
  assert.equal(
    f.db.prepare("SELECT COUNT(*) count FROM recipe_identity WHERE recipe_id='90001'").get()!.count,
    0,
  );
  const review = ready(await f.service.review(await f.serialize()));
  assert.deepEqual(review.blockers, []);
  receipt(await f.service.execute(ready(await f.service.prepare(review))));
  const saved = await f.capture();
  assert.equal(saved.data.favourites[0]!.recipeId, '90001');
  assert.equal(saved.data.personal.notes[0]!.text, privateText);
  assert.deepEqual(saved.data.planReferences, []);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) count FROM recipe_content_revision WHERE recipe_id='90001'")
      .get()!.count,
    0,
    'ID-only personal data cannot invent an exact revision',
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) count FROM recipe WHERE recipe_id='90001'").get()!.count,
    0,
  );
});

test('an authenticated but not yet adopted future recipe identity cannot enter through ID-only backup records', async (t) => {
  const f = await fixture(t);
  const doc = clone(f.first.revision.document);
  doc.recipe.recipeId = '90002';
  for (const media of doc.media) media.recipeId = '90002';
  const future = await published(doc, 'restore-future');
  await f.activate(
    [
      { ...member(f.second), state: 'archived', reason: 'Private archived fixture' },
      member(future),
    ],
    [future],
  );
  delete f.data.data.cookingHistory;
  f.data.data.occurrences = [];
  f.data.data.planReferences = [];
  f.data.data.shopping.scope.occurrenceIds = [];
  f.data.data.favourites[0]!.recipeId = '90002';
  f.data.data.personal.notes[0]!.recipeId = '90002';
  const before = f.rows(),
    review = ready(await f.service.review(await f.serialize()));
  assert.ok(review.blockers.includes('unknown_recipes'));
  assert.deepEqual(review.unknownRecipeIds, ['90002']);
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  assert.equal(f.rows(), before);
});

for (const version of [7, 8] as const)
  test(`existing format2 receipts and original archive bytes recover unchanged after schema${version} migration`, async (t) => {
    const f = await fixture(t, true, version);
    assert.ok(f.legacy);
    const saved = f.legacy.saved;
    const original = f.db
      .prepare('SELECT * FROM portable_restore_operation WHERE operation_id=?')
      .get(saved.operationId);
    assert.deepEqual(ready(await f.service.readReceipt(saved.operationId)), saved);
    assert.equal(ready(await f.service.readArchive(saved.operationId, 'before')), f.legacy.before);
    assert.equal(
      ready(await f.service.readArchive(saved.operationId, 'imported')),
      f.legacy.imported,
    );
    assert.deepEqual(
      receipt(
        await f.service.execute({
          operationId: saved.operationId,
          importFingerprint: saved.importFingerprint,
          expectedRevision: saved.expectedRevision,
        }),
      ),
      saved,
    );
    assert.deepEqual(
      f.db
        .prepare('SELECT * FROM portable_restore_operation WHERE operation_id=?')
        .get(saved.operationId),
      original,
    );
  });

test('a stored but invalid account journal blocks replacement instead of hiding outstanding work', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
    .run(`account-replication:journal:${randomUUID()}`, 'null');
  const before = f.rows();
  assert.equal((await f.service.review(await f.serialize())).kind, 'failed');
  assert.equal(f.rows(), before);
});

test('physical8 restore requires explicit target admission and unknown reopened IDs never become approvals', async (t) => {
  const f = await fixture(t, false, 8),
    source = await f.serialize(),
    before = f.rows();
  const old = f.makeService(7);
  assert.equal((await old.review(source)).kind, 'failed');
  const prepared = await f.prepared();
  await f.reopen();
  assert.equal(ready(await f.service.readReceipt(prepared.operationId)), null);
  assert.equal((await f.service.execute(prepared)).kind, 'failed');
  assert.equal(f.rows(), before);
  const saved = receipt(await f.service.execute(await f.prepared()));
  assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 8);
  const committed = f.rows();
  assert.equal(
    (
      await f.service.execute({
        operationId: saved.operationId,
        importFingerprint: 'f'.repeat(64),
        expectedRevision: saved.expectedRevision,
      })
    ).kind,
    'failed',
  );
  assert.equal(f.rows(), committed);
});

test('physical8 guest rejects account namespaces without transferring their private values and holds null settings', async (t) => {
  const f = await fixture(t, false, 8),
    source = await f.serialize(),
    command = await f.prepared();
  let foreignTransfers = 0;
  for (const connection of f.connections) {
    const all = connection.all;
    connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      const rows = await all<Row>(sql, values);
      for (const row of rows)
        for (const value of Object.values(row))
          if (typeof value === 'string' && value.includes('FOREIGN PRIVATE JOURNAL'))
            foreignTransfers++;
      return rows;
    };
  }
  for (const key of [
    `account-replication:journal:${randomUUID()}`,
    `account-replication:content-journal:${randomUUID()}`,
    `account-replication:content-initial-guest:${randomUUID()}`,
    `account-replication:legacy-content-transition:${randomUUID()}`,
    ACCOUNT_GUEST_KEY,
  ]) {
    f.db
      .prepare('INSERT INTO app_metadata VALUES (?,?)')
      .run(key, 'FOREIGN PRIVATE JOURNAL'.repeat(50000));
    const changes = f.db.prepare('SELECT total_changes() n').get();
    assert.equal((await f.service.review(source)).kind, 'failed');
    assert.equal((await f.service.execute(command)).kind, 'failed');
    assert.equal(foreignTransfers, 0);
    assert.deepEqual(f.db.prepare('SELECT total_changes() n').get(), changes);
    f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(key);
  }
  f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(ACCOUNT_SETTINGS_KEY, 'null');
  const before = f.rows();
  const review = ready(await f.service.review(source));
  assert.ok(review.blockers.includes('account_operation_pending'));
  assert.equal((await f.service.prepare(review)).kind, 'failed');
  assert.equal((await f.service.execute(command)).kind, 'failed');
  assert.equal(f.rows(), before);
});

for (const mode of ['legacy', 'content', 'transition'] as const)
  test(`physical8 bound-owner restore holds an actual pending ${mode} operation and its original recovery bytes`, async (t) => {
    const f = await fixture(t, false, 8),
      ownerId = randomUUID(),
      scope = f.bind(ownerId);
    const settings: AccountSnapshotOptions = {
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    };
    const options = {
      reader: f.reader,
      writer: f.writer,
      installationId: f.installationId,
      catalogue: catalogue.identity,
      currentScope: () => scope,
      getLocalSettings: () => settings,
      now: () => at,
      sha256,
      newId: randomUUID,
    };
    const approval = createAccountContentScopeApprovalService(options);
    try {
      await approval.approve(scope, await approval.review(scope), { historyIncluded: false });
    } finally {
      approval.close();
    }
    const review = ready(await f.service.review(await f.serialize()));
    const command = ready(await f.service.prepare(review));
    const snapshot = emptyAccountSnapshot(catalogue.identity, settings);
    const remote = { ownerId, revision: 1, snapshot, updatedAt: at, deletionOperationId: null };
    const legacyKey = `account-replication:journal:${ownerId}`;
    if (mode === 'legacy') {
      f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
        legacyKey,
        JSON.stringify({
          schemaVersion: 1,
          ownerId,
          revision: 1,
          base: null,
          observed: { revision: 0, snapshotDigest: null, updatedAt: null },
          lastApply: null,
          pending: {
            operationId: randomUUID(),
            mode: 'push',
            capturedLocal: { storeRevision: 0, snapshot },
            remote: {
              ownerId,
              revision: 0,
              snapshot: null,
              updatedAt: null,
              deletionOperationId: null,
            },
            proposed: snapshot,
            proposedDigest: await sha256(canonicalAccountSnapshot(snapshot)),
            acknowledgement: null,
          },
        }),
      );
    } else if (mode === 'content') {
      const capturedLocal = await f.reader.transaction(
        (session) => captureAccountContentLocal(session, scope, options),
        { kind: 'read_only' },
      );
      const journal = createAccountContentJournalRepository(options);
      try {
        const staged = await journal.stage(scope, {
          operationId: randomUUID(),
          expectedJournalRevision: 0,
          expectedDeviceDataOwnerId: ownerId,
          initialImportReviewed: true,
          capturedLocal,
          remote: { ...remote, snapshot: capturedLocal.snapshot },
          proposed: capturedLocal.snapshot,
          mode: 'pull',
        });
        assert.ok(staged.pending);
      } finally {
        journal.close();
      }
    } else {
      f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
        legacyKey,
        JSON.stringify({
          schemaVersion: 1,
          ownerId,
          revision: 1,
          base: remote,
          observed: {
            revision: 1,
            snapshotDigest: await sha256(canonicalAccountSnapshot(snapshot)),
            updatedAt: at,
          },
          pending: null,
          lastApply: {
            ownerId,
            operationId: randomUUID(),
            storeRevision: 1,
            serverRevision: 1,
            appliedAt: at,
          },
        }),
      );
      const transition = createAccountLegacyTransitionRepository(options);
      try {
        const staged = await transition.stage(scope, await transition.review(scope, remote), {
          initialImportReviewed: true,
        });
        assert.equal(staged.lastApply, null);
      } finally {
        transition.close();
      }
    }
    const before = f.rows();
    const blocked = ready(await f.service.review(await f.serialize()));
    assert.ok(blocked.blockers.includes('account_operation_pending'));
    assert.equal((await f.service.prepare(review)).kind, 'failed');
    assert.equal((await f.service.execute(command)).kind, 'failed');
    assert.equal(f.rows(), before);
  });

test('physical8 restore rejects large workspace clocks before transfer during review, prepare, execute and recovery', async (t) => {
  const f = await fixture(t, false, 8);
  const saved = receipt(await f.service.execute(await f.prepared()));
  const source = await f.serialize(),
    review = ready(await f.service.review(source)),
    command = ready(await f.service.prepare(review));
  let oversizedTransfers = 0;
  for (const connection of f.connections) {
    const all = connection.all;
    connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      const rows = await all<Row>(sql, values);
      for (const row of rows)
        for (const value of Object.values(row))
          if ((typeof value === 'string' || value instanceof Uint8Array) && value.length >= 1048576)
            oversizedTransfers++;
      return rows;
    };
  }
  for (const [table, column, predicate] of [
    ['app_content_adoption', 'revision', 'singleton=1'],
    ['portable_restore_operation', 'committed_revision', '1'],
    ['state_revision', 'revision', "collection='store'"],
  ]) {
    const original = f.db
      .prepare(`SELECT ${column} value FROM ${table} WHERE ${predicate}`)
      .get() as { value: number };
    for (const value of ['x'.repeat(1048576), Buffer.alloc(1048576), -1, 0.5, 2 ** 53]) {
      f.db.exec('PRAGMA ignore_check_constraints=ON');
      f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${predicate}`).run(value);
      f.db.exec('PRAGMA ignore_check_constraints=OFF');
      const changes = f.db.prepare('SELECT total_changes() n').get();
      assert.equal((await f.service.review(source)).kind, 'failed');
      assert.equal((await f.service.prepare(review)).kind, 'failed');
      assert.equal((await f.service.execute(command)).kind, 'failed');
      assert.equal((await f.service.readReceipt(saved.operationId)).kind, 'failed');
      assert.equal((await f.service.readArchive(saved.operationId, 'before')).kind, 'failed');
      assert.equal(oversizedTransfers, 0, `${table}.${column} crossed the SQL bridge`);
      assert.deepEqual(f.db.prepare('SELECT total_changes() n').get(), changes);
      f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${predicate}`).run(original.value);
    }
  }
  assert.deepEqual(ready(await f.service.readReceipt(saved.operationId)), saved);
});
