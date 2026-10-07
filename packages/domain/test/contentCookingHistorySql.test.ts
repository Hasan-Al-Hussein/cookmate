import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledContentSnapshot,
  createBundledRecipeRevision,
  verifySignedContentOverlay,
  type ContentOverlayManifest,
  type EffectiveContentSnapshot,
  type OverlayHead,
  type PublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import { cookingContentIdentity, type RepositoryResult } from '../src';
import { createContentCookingHistory } from '../../../apps/mobile/src/data/contentCookingHistory';
import { createContentCookingSessions } from '../../../apps/mobile/src/data/contentCookingSessions';
import {
  validateContentCookedRecoveryReference,
  type ContentCookedRecoveryReference,
  type SaveContentCookedInput,
} from '../../../apps/mobile/src/data/contentCookingHistoryRecords';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import type {
  ContentReadingView,
  openContentReleaseStore,
} from '../../../apps/mobile/src/data/contentReleaseStore';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { member, published, signed } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z',
  authoredId = '900000093';
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: { kind: string; error?: { messageKey: string } }, message?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (message) assert.equal(result.error?.messageKey, message);
}
async function contentFixture(secondaryPhotoFirst = false) {
  const baseline = await createBundledContentSnapshot(sha256),
    document = authoredFixture(authoredId);
  if (document.kind !== 'authored') assert.fail();
  if (secondaryPhotoFirst) {
    const secondary = clone(document.media[0]!);
    secondary.photoKey = `photos/${authoredId}-secondary.jpg`;
    secondary.sha256 = '2'.repeat(64);
    secondary.assetId = `sha256:${secondary.sha256}`;
    document.media.unshift(secondary);
  }
  const first = await published(document, 'history-first');
  document.provenance.basedOn = clone(first.revision.ref);
  document.recipe.title = 'A newer cooking revision';
  const second = await published(document, 'history-second');
  const releases = new Map<string, { manifest: ContentOverlayManifest; fingerprint: string }>(),
    publications = new Map<string, PublishedRecipeRevision>();
  let head: OverlayHead | null = null,
    snapshot: EffectiveContentSnapshot;
  async function issue(mode: 'first' | 'second' | 'archive' | 'withdraw') {
    const publication = mode === 'first' ? first : second,
      sequence = (head?.sequence ?? 0) + 1;
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `history-release-${sequence}`,
      sequence,
      previous: head,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: { ...catalogue.identity },
      entries: [
        mode === 'withdraw'
          ? { state: 'withdrawn', recipeId: authoredId, reason: 'Fixture withdrawal' }
          : mode === 'archive'
            ? {
                state: 'archived',
                ref: clone(second.revision.ref),
                publicationFingerprint: second.publicationFingerprint,
                reason: 'Fixture archive',
              }
            : member(publication),
      ],
    };
    const envelope = await signed(manifest);
    snapshot = await verifySignedContentOverlay(envelope, {
      sha256,
      baseline: { identity: { ...catalogue.identity }, revisions: baseline.revisions },
      expectedCurrent: head,
      minimumSequence: head?.sequence ?? 0,
      readerVersion: 1,
      publications: mode === 'first' || mode === 'second' ? [publication] : [],
      retainedRefs: [...publications.values()].map((value) => value.revision.ref),
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
        async readRelease(id) {
          return releases.get(id) ?? null;
        },
        async readPublication(id, revision) {
          return publications.get(`${id}|${revision}`) ?? null;
        },
      },
    });
    head = { releaseId: manifest.releaseId, sequence, fingerprint: envelope.fingerprint };
    releases.set(manifest.releaseId, { manifest, fingerprint: envelope.fingerprint });
    if (mode === 'first' || mode === 'second')
      publications.set(`${authoredId}|${publication.revision.ref.revisionId}`, publication);
  }
  await issue('first');
  return {
    first,
    second,
    issue,
    get head() {
      return head!;
    },
    get snapshot() {
      return snapshot;
    },
  };
}

async function fixture(
  t: TestContext,
  legacy = false,
  cookingSchemaVersion: 7 | 8 = 7,
  secondaryPhotoFirst = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-history-')),
    path = join(directory, 'cooking.db'),
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
  const bundled = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256),
    legacyId = randomUUID();
  if (legacy) {
    const recipe = catalogue.recipes[0]!,
      identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
    const receipt = {
      kind: 'saved',
      event: {
        ...identity,
        eventId: legacyId,
        recipeTitle: recipe.title,
        photoKey: recipe.photoKey,
        cookedOn: '2026-09-30',
        timeZone: 'Asia/Dubai',
        recordedAt: at,
        note: 'Original private legacy note',
        historyEpoch: 0,
        revision: 1,
      },
      closedSession: null,
    };
    write.database
      .prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)")
      .run(legacyId, '2026-09-30', at, 'a'.repeat(64), JSON.stringify(receipt));
    write.database.exec(
      "UPDATE cooking_state SET history_revision=1; UPDATE state_revision SET revision=1 WHERE collection='store'",
    );
  }
  await migrateCookingContentDatabase(writer, { sha256 });
  if (cookingSchemaVersion === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 0 },
    content: Awaited<ReturnType<typeof contentFixture>> | null = null,
    today = '2026-10-01';
  const faults = {
    calls: 0,
    unavailable: false,
    afterContent: false,
    statement: '',
    ackLost: false,
    onCommitted: undefined as (() => void) | undefined,
    pause: null as Promise<void> | null,
    entered: undefined as (() => void) | undefined,
    beforeContent: undefined as (() => unknown) | undefined,
    beforeCommit: undefined as (() => void) | undefined,
    afterCommit: undefined as (() => void) | undefined,
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
        throw new Error('Fixture lost commit acknowledgement');
      }
    }
  };
  write.connection.prepare = async (sql) => {
    const statement = await prepare(sql);
    return {
      ...statement,
      async run(values) {
        if (faults.statement && sql.startsWith(faults.statement))
          throw new Error('Fixture write failure');
        await statement.run(values);
      },
    };
  };
  // Controlled verified content port; no signature/native-lock claim is made by this fixture.
  const contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReading'
  > = {
    async withVerifiedReading(expected, refs, work) {
      faults.calls++;
      if (faults.unavailable) throw new Error('Fixture unavailable content');
      assert.deepEqual(expected, content?.head ?? null);
      if (content)
        for (const ref of refs) assert.equal(content.snapshot.lookupExact(ref).kind, 'readable');
      faults.entered?.();
      await faults.pause;
      const hook = faults.beforeContent;
      faults.beforeContent = undefined;
      await hook?.();
      let active = true;
      const view: ContentReadingView = {
        head: content?.head ?? null,
        latestHead: content?.head ?? null,
        snapshot: content?.snapshot ?? null,
        hasWithdrawal:
          content?.snapshot.entries.some((entry) => entry.state === 'withdrawn') ?? false,
        assertActive() {
          assert.ok(active);
          return undefined;
        },
        async readPhoto() {
          throw new Error('Unused photo port');
        },
      };
      try {
        const value = await work(view);
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
    sha256,
    now: () => at,
    dateContext: () => ({ localDate: today, timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    getAccess: () => access,
    assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
      assert.deepEqual(access, scope);
      return undefined;
    },
    onCommitted(change: unknown) {
      changes.push(change);
      faults.onCommitted?.();
    },
  };
  const create = (version?: 7 | 8) =>
      createContentCookingHistory({
        ...options,
        ...(version === undefined ? {} : { cookingSchemaVersion: version }),
      }),
    host = create(cookingSchemaVersion),
    sessions = createContentCookingSessions({ ...options, cookingSchemaVersion });
  const input = (overrides: Partial<SaveContentCookedInput> = {}): SaveContentCookedInput => ({
    eventId: randomUUID(),
    contentRef: clone(bundled.ref),
    expectedHistoryEpoch: 0,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    ...overrides,
  });
  const rows = () => ({
    events: write.database.prepare('SELECT * FROM cooking_event').all(),
    pins: write.database.prepare('SELECT * FROM local_history_content_pin').all(),
    sessions: write.database.prepare('SELECT * FROM cooking_session').all(),
    sessionPins: write.database.prepare('SELECT * FROM cooking_session_content_pin').all(),
    state: write.database.prepare('SELECT * FROM cooking_state').all(),
    revisions: write.database.prepare('SELECT * FROM state_revision').all(),
    authority: write.database.prepare('SELECT * FROM content_cooking_event_authority').all(),
  });
  const count = (table: string) =>
    write.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
  async function adopt(mode: 'first' | 'second' | 'archive' | 'withdraw') {
    if (!content) content = await contentFixture(secondaryPhotoFirst);
    else await content.issue(mode);
    write.database
      .prepare('UPDATE app_content_adoption SET revision=revision+1,head_json=?')
      .run(JSON.stringify(content.head));
    return content;
  }
  function bind(ownerId: string | null, generation: number) {
    access = { ownerId, authGeneration: generation };
    if (ownerId === null)
      write.database.exec("DELETE FROM app_metadata WHERE key='account-replication:owner'");
    else
      write.database
        .prepare("INSERT OR REPLACE INTO app_metadata VALUES ('account-replication:owner',?)")
        .run(JSON.stringify({ schemaVersion: 1, ownerId }));
  }
  return {
    host,
    create,
    sessions,
    input,
    rows,
    count,
    adopt,
    bind,
    bundled,
    faults,
    write,
    read,
    writer,
    changes,
    legacyId,
    ids,
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    setDate(value: string) {
      today = value;
    },
  };
}

test('cooked observers closing the host after save or body-free cancel cannot expose ready success', async (t) => {
  for (const action of ['save', 'cancel'] as const) {
    const f = await fixture(t, false, 8),
      input = f.input();
    f.faults.onCommitted = () => f.host.close();
    const result =
      action === 'save'
        ? await f.host.saveCooked(input)
        : await f.host.resolveCookedOperation(input);
    assert.equal(result.kind, 'uncertain');
    assert.equal(f.count('cooking_event'), 1);
    assert.equal(f.changes.length, 1);
    const before = f.rows();
    assert.equal(
      ready(await f.create(8).recover(input))?.kind,
      action === 'save' ? 'saved' : 'cancelled',
    );
    assert.deepEqual(f.rows(), before);
  }
});

test('cooked lost-ACK recovery cannot return a receipt after its observer revokes access', async (t) => {
  for (const action of ['save', 'cancel'] as const) {
    const f = await fixture(t, false, 8),
      input = f.input();
    f.faults.ackLost = true;
    f.faults.onCommitted = () => f.setAccess(null);
    const result =
      action === 'save'
        ? await f.host.saveCooked(input)
        : await f.host.resolveCookedOperation(input);
    assert.equal(result.kind, 'uncertain');
    if (result.kind !== 'uncertain') assert.fail();
    assert.equal(result.operationId, input.eventId);
    assert.equal(f.writer.requiresRecovery(), true);
    assert.equal(f.count('content_cooking_event_authority'), 1);
    assert.equal(f.changes.length, 1);
    f.bind(null, 1);
    assert.equal(
      ready(await f.create(8).recover(input))?.kind,
      action === 'save' ? 'saved' : 'cancelled',
    );
  }
});

test('schema8 exact cooked events retain distinct authored versions and close only the matching session', async (t) => {
  const f = await fixture(t, true, 8),
    content = await f.adopt('first');
  assert.equal(f.write.database.prepare('PRAGMA user_version').get()!.user_version, 8);
  const legacy = f.write.database
    .prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?')
    .get(f.legacyId)!.receipt_json;
  const active = ready(
    await f.sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: clone(content.first.revision.ref),
      expectedRevision: null,
      passageSequence: 2,
    }),
  );
  await f.adopt('second');
  const older = f.input({
    contentRef: clone(content.first.revision.ref),
    session: { sessionId: active.session.sessionId, expectedRevision: active.session.revision },
    note: '  Exact original note\n2 tsp  ',
  });
  const first = ready(await f.host.saveCooked(older));
  assert.equal(first.kind, 'saved');
  if (first.kind !== 'saved') assert.fail();
  assert.deepEqual(first.event.contentRef, content.first.revision.ref);
  assert.equal(first.event.recipeTitle, content.first.revision.document.recipe.title);
  assert.equal(first.event.note, older.note);
  assert.equal(first.closedSession?.state, 'completed');
  assert.equal(first.closedSession?.passageSequence, 2);
  assert.deepEqual(first.closedSession?.contentRef, content.first.revision.ref);
  const newer = f.input({ contentRef: clone(content.second.revision.ref) });
  const second = ready(await f.host.saveCooked(newer));
  if (second.kind !== 'saved') assert.fail();
  assert.deepEqual(second.event.contentRef, content.second.revision.ref);
  assert.equal(second.event.recipeTitle, content.second.revision.document.recipe.title);
  assert.equal(second.closedSession, null);
  for (const event of [first.event, second.event]) {
    const pin = f.write.database
      .prepare(
        'SELECT recipe_id recipeId,revision_id revisionId,content_fingerprint contentFingerprint FROM local_history_content_pin WHERE event_id=?',
      )
      .get(event.eventId);
    assert.deepEqual({ ...pin }, event.contentRef);
  }
  assert.equal(
    f.write.database
      .prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?')
      .get(f.legacyId)!.receipt_json,
    legacy,
  );
  await f.adopt('withdraw');
  failed(await f.host.saveCooked(f.input({ contentRef: clone(content.second.revision.ref) })));
  assert.deepEqual(ready(await f.create(8).recover(older)), first);
  assert.deepEqual(ready(await f.create(8).recover(newer)), second);
  const cancelledInput = f.input({ contentRef: clone(content.second.revision.ref) });
  const cancelled = ready(await f.host.resolveCookedOperation(cancelledInput));
  assert.equal(cancelled.kind, 'cancelled');
  assert.deepEqual(ready(await f.create(8).saveCooked(cancelledInput)), cancelled);
  assert.equal(f.count('local_history_content_pin'), 3);
  assert.deepEqual(f.write.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('cooked history exact schema admission rejects defaults on8 and recovers original7 receipts only through explicit8', async (t) => {
  const f = await fixture(t),
    input = f.input();
  failed(await f.create(8).saveCooked(input));
  failed(await f.create(8).recover(input));
  const saved = ready(await f.host.saveCooked(input));
  const original = f.write.database
    .prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?')
    .get(input.eventId)!.receipt_json;
  const pending = f.input();
  f.faults.beforeContent = () => migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  assert.notEqual((await f.host.saveCooked(pending)).kind, 'ready');
  assert.equal(f.write.database.prepare('PRAGMA user_version').get()!.user_version, 8);
  assert.equal(f.count('cooking_event'), 1);
  assert.equal(f.count('content_cooking_event_authority'), 1);
  failed(await f.create().recover(input));
  failed(await f.create().saveCooked(pending));
  failed(await f.create().resolveCookedOperation(pending));
  const upgraded = f.create(8);
  assert.deepEqual(ready(await upgraded.recover(input)), saved);
  assert.equal(
    f.write.database
      .prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?')
      .get(input.eventId)!.receipt_json,
    original,
  );
  ready(await upgraded.saveCooked(pending));
  assert.equal(f.count('cooking_event'), 2);
});

test('schema8 cooked save rolls back closure, event, exact pins and clocks after SQL or final owner failure', async (t) => {
  const f = await fixture(t, false, 8),
    content = await f.adopt('first');
  const active = ready(
    await f.sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: clone(content.first.revision.ref),
      expectedRevision: null,
      passageSequence: 2,
    }),
  );
  const input = f.input({
    contentRef: clone(content.first.revision.ref),
    session: { sessionId: active.session.sessionId, expectedRevision: active.session.revision },
  });
  const before = f.rows();
  f.faults.statement = 'INSERT INTO content_cooking_event_authority';
  failed(await f.host.saveCooked(input));
  assert.deepEqual(f.rows(), before);
  assert.equal(ready(await f.host.recover(input)), null);
  f.faults.statement = '';
  f.faults.beforeCommit = () => f.setAccess(null);
  assert.equal((await f.host.saveCooked(input)).kind, 'uncertain');
  assert.deepEqual(f.rows(), before);
  f.bind(null, 0);
  const saved = ready(await f.host.saveCooked(input));
  assert.equal(saved.kind, 'saved');
  assert.equal(f.count('cooking_event'), 1);
  assert.equal(f.count('content_cooking_event_authority'), 1);
});

test('schema8 history rejects adoption and restore drift then recovers one durable save after lost ACK', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input();
  f.faults.beforeContent = () => f.adopt('first');
  failed(await f.host.saveCooked(input));
  assert.equal(f.count('cooking_event'), 0);
  f.faults.beforeContent = () =>
    f.write.database
      .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','1')")
      .run();
  failed(await f.host.saveCooked(input), 'content.cooked_workspace_changed');
  f.faults.ackLost = true;
  const saved = ready(await f.host.saveCooked(input));
  assert.equal(f.writer.requiresRecovery(), true);
  f.host.close();
  f.faults.unavailable = true;
  assert.deepEqual(ready(await f.create(8).recover(input)), saved);
  assert.deepEqual(ready(await f.create(8).saveCooked(input)), saved);
  f.bind(randomUUID(), 1);
  failed(await f.create(8).recover(input), 'content.cooked_access_changed');
  assert.equal(f.count('cooking_event'), 1);
  assert.equal(f.count('content_cooking_event_authority'), 1);
});

test('schema8 lost cancellation ACK preserves a permanent exact fence without a cooked event pin', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input();
  f.faults.ackLost = true;
  const cancelled = ready(await f.host.resolveCookedOperation(input));
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(f.writer.requiresRecovery(), true);
  const before = f.rows();
  assert.deepEqual(ready(await f.create(8).saveCooked(input)), cancelled);
  assert.deepEqual(ready(await f.create(8).recover(input)), cancelled);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.count('local_history_content_pin'), 0);
});

test('exact cooked save uses existing event/pin rows and recovery never repeats effects', async (t) => {
  const f = await fixture(t),
    input = f.input({ note: 'A private note' }),
    saved = ready(await f.host.saveCooked(input));
  assert.equal(saved.kind, 'saved');
  if (saved.kind !== 'saved') assert.fail();
  assert.equal(saved.event.readerVersion, 2);
  assert.deepEqual(saved.event.contentRef, f.bundled.ref);
  assert.equal(saved.event.note, input.note);
  assert.equal(saved.event.recipeTitle, f.bundled.document.recipe.title);
  assert.equal(saved.closedSession, null);
  const before = f.rows();
  assert.deepEqual(ready(await f.create().recover(input)), saved);
  assert.deepEqual(ready(await f.create().saveCooked(input)), saved);
  assert.deepEqual(ready(await f.host.resolveCookedOperation(input)), saved);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.changes.length, 1);
  assert.equal(f.count('shopping_contribution'), 0);
  assert.equal(f.count('plan_occurrence'), 0);
  assert.deepEqual(f.write.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('matching active exact session closes atomically using archived content while independent new saves require current', async (t) => {
  const f = await fixture(t),
    content = await f.adopt('first');
  const active = ready(
    await f.sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: clone(content.first.revision.ref),
      expectedRevision: null,
      passageSequence: content.first.revision.document.recipe.instructions[0]!.sequence,
    }),
  );
  await f.adopt('second');
  await f.adopt('archive');
  const input = f.input({
    contentRef: clone(content.first.revision.ref),
    session: { sessionId: active.session.sessionId, expectedRevision: active.session.revision },
  });
  failed(
    await f.host.saveCooked({
      ...input,
      eventId: randomUUID(),
      session: { ...input.session!, expectedRevision: active.session.revision + 1 },
    }),
    'content.cooked_session_changed',
  );
  const { session: _session, ...withoutSession } = input;
  failed(
    await f.host.saveCooked({ ...withoutSession, eventId: randomUUID() }),
    'content.cooked_content_unavailable',
  );
  const saved = ready(await f.host.saveCooked(input));
  if (saved.kind !== 'saved') assert.fail();
  assert.equal(saved.event.recipeTitle, content.first.revision.document.recipe.title);
  assert.equal(saved.closedSession?.state, 'completed');
  assert.deepEqual(saved.closedSession?.contentRef, content.first.revision.ref);
  assert.equal(saved.closedSession?.passageSequence, active.session.passageSequence);
  assert.equal(ready(await f.sessions.readSession(authoredId)).resume, 'none');
  await migrateCookingContentDatabase(f.writer, { sha256 });
  assert.deepEqual(ready(await f.create().recover(input)), saved);
});

test('closed history receipts reject future session revisions without losing older proof after later sessions', async (t) => {
  const f = await fixture(t);
  const active = ready(
    await f.sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: clone(f.bundled.ref),
      expectedRevision: null,
      passageSequence: f.bundled.document.recipe.instructions[0]!.sequence,
    }),
  );
  const input = f.input({
    session: { sessionId: active.session.sessionId, expectedRevision: active.session.revision },
  });
  const saved = ready(await f.host.saveCooked(input));
  if (saved.kind !== 'saved' || !saved.closedSession) assert.fail();
  const later = ready(
    await f.sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: clone(f.bundled.ref),
      expectedRevision: saved.closedSession.revision,
      passageSequence: active.session.passageSequence,
    }),
  );
  assert.ok(later.session.revision > saved.closedSession.revision);
  f.write.database
    .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','1')")
    .run();
  assert.deepEqual(ready(await f.create().recover(input)), saved);
  const original = f.write.database
    .prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?')
    .get(input.eventId)!.receipt_json as string;
  const corrupted = {
    ...saved,
    closedSession: { ...saved.closedSession, revision: later.session.revision + 1 },
  };
  f.write.database
    .prepare('UPDATE cooking_event SET receipt_json=? WHERE event_id=?')
    .run(canonicalContentJson(corrupted, 32768), input.eventId);
  const before = f.rows();
  failed(await f.create().recover(input), 'content.cooked_stored_evidence_invalid');
  failed(await f.host.saveCooked(input), 'content.cooked_stored_evidence_invalid');
  failed(await f.host.resolveCookedOperation(input), 'content.cooked_stored_evidence_invalid');
  assert.deepEqual(f.rows(), before);
  f.write.database
    .prepare('UPDATE cooking_event SET receipt_json=? WHERE event_id=?')
    .run(original, input.eventId);
  assert.deepEqual(ready(await f.create().recover(input)), saved);
});

test('withdrawal blocks new writes while saved receipts and exact cancellation remain body-free', async (t) => {
  const f = await fixture(t),
    content = await f.adopt('first'),
    input = f.input({ contentRef: clone(content.first.revision.ref) });
  const saved = ready(await f.host.saveCooked(input));
  await f.adopt('withdraw');
  const calls = f.faults.calls;
  assert.deepEqual(ready(await f.create().recover(input)), saved);
  assert.deepEqual(ready(await f.host.saveCooked(input)), saved);
  assert.equal(f.faults.calls, calls);
  const pending = { ...input, eventId: randomUUID() };
  failed(await f.host.saveCooked(pending));
  const afterDenied = f.faults.calls;
  const cancellation = ready(await f.host.resolveCookedOperation(pending));
  assert.equal(cancellation.kind, 'cancelled');
  assert.deepEqual(ready(await f.create().saveCooked(pending)), cancellation);
  assert.equal(f.faults.calls, afterDenied);
});

test('history epoch hiding and clear redact event payload without hidden authority note/title copies', async (t) => {
  const f = await fixture(t),
    input = f.input({ note: 'UNIQUE private text that must disappear' }),
    saved = ready(await f.host.saveCooked(input));
  if (saved.kind !== 'saved') assert.fail();
  f.write.database.exec(
    'UPDATE cooking_state SET history_epoch=1,history_revision=history_revision+1',
  );
  assert.deepEqual(ready(await f.host.recover(input)), {
    kind: 'cleared',
    eventId: input.eventId,
    historyEpoch: 0,
  });
  f.write.database.exec(
    "DELETE FROM local_history_content_pin; UPDATE cooking_event SET state='cleared',cooked_on=NULL,recorded_at=NULL,request_fingerprint=NULL,receipt_json=NULL",
  );
  const authority = f.write.database
    .prepare('SELECT authority_json FROM content_cooking_event_authority')
    .get()!.authority_json as string;
  assert.equal(authority.includes(input.note!), false);
  assert.equal(authority.includes(saved.event.recipeTitle), false);
  assert.equal(authority.includes(input.cookedOn), false);
  assert.equal(authority.includes(input.timeZone), false);
  const keys = Object.keys(JSON.parse(authority) as object).sort();
  assert.deepEqual(
    keys,
    [
      'adoptionRevision',
      'authGeneration',
      'contentRef',
      'expectedHistoryEpoch',
      'formatVersion',
      'head',
      'installationId',
      'ownerId',
      'restoreEpoch',
      'session',
    ].sort(),
  );
  f.faults.unavailable = true;
  assert.deepEqual(ready(await f.create().saveCooked(input)), {
    kind: 'cleared',
    eventId: input.eventId,
    historyEpoch: 0,
  });
});

test('resolve wins against a delayed save and durably prevents that same request from dispatching', async (t) => {
  const f = await fixture(t),
    input = f.input();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.faults.pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.faults.entered = entered;
  const save = f.host.saveCooked(input);
  await gate;
  const cancelled = ready(await f.create().resolveCookedOperation(input));
  assert.equal(cancelled.kind, 'cancelled');
  release();
  assert.deepEqual(ready(await save), cancelled);
  assert.equal(f.count('local_history_content_pin'), 0);
  assert.equal(
    f.write.database.prepare('SELECT history_revision n FROM cooking_state').get()!.n,
    0,
  );
  assert.equal(f.count('cooking_event'), 1);
});

test('future dates fail only new saves; exact same-ID recovery remains valid after clock changes', async (t) => {
  const f = await fixture(t),
    input = f.input();
  failed(
    await f.host.saveCooked({ ...input, cookedOn: '2026-10-02' }),
    'content.cooked_future_date',
  );
  const saved = ready(await f.host.saveCooked(input));
  f.setDate('2026-09-30');
  assert.deepEqual(ready(await f.host.saveCooked(input)), saved);
  failed(
    await f.host.saveCooked({ ...input, note: 'changed' }),
    'content.cooked_operation_conflict',
  );
  failed(
    await f.host.resolveCookedOperation({ ...input, note: 'changed' }),
    'content.cooked_operation_conflict',
  );
});

test('legacy event IDs remain unchanged and never acquire new exact action authority', async (t) => {
  const f = await fixture(t, true),
    before = f.rows(),
    input = f.input({ eventId: f.legacyId });
  failed(await f.host.saveCooked(input), 'content.cooked_operation_conflict');
  failed(await f.host.resolveCookedOperation(input), 'content.cooked_operation_conflict');
  failed(await f.host.recover(input), 'content.cooked_operation_conflict');
  assert.deepEqual(f.rows(), before);
});

test('imported event/source IDs and schema7 account/removal/guest-withdrawal IDs cannot become local operations', async (t) => {
  const f = await fixture(t),
    restoreId = randomUUID(),
    importedId = randomUUID(),
    sourceId = randomUUID();
  f.write.database
    .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
    .run(restoreId, 'a'.repeat(64), '{}', '{}', '{}');
  f.write.database
    .prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)')
    .run(importedId, sourceId, restoreId, '2026-10-01', at, '{}');
  for (const eventId of [importedId, sourceId]) {
    const reference = ready(await f.host.prepareCookedRecovery(f.input({ eventId })));
    failed(await f.host.readCookedRecovery(reference), 'content.cooked_imported_id_conflict');
    failed(await f.host.resolveCookedRecovery(reference), 'content.cooked_imported_id_conflict');
    failed(await f.host.saveCooked(f.input({ eventId })), 'content.cooked_imported_id_conflict');
    failed(
      await f.host.resolveCookedOperation(f.input({ eventId })),
      'content.cooked_imported_id_conflict',
    );
  }
  const withdrawn = randomUUID();
  f.write.database.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(withdrawn);
  failed(
    await f.host.saveCooked(f.input({ eventId: withdrawn })),
    'content.cooked_account_id_conflict',
  );
  const owner = randomUUID();
  f.bind(owner, 1);
  const active = f.create(),
    projected = randomUUID(),
    removed = randomUUID(),
    recipe = catalogue.recipes[0]!;
  const identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  f.write.database.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
    owner,
    projected,
    JSON.stringify({
      ...identity,
      eventId: projected,
      recipeTitle: recipe.title,
      photoKey: recipe.photoKey,
      cookedOn: '2026-10-01',
      timeZone: 'Asia/Dubai',
      recordedAt: at,
      note: null,
    }),
  );
  f.write.database
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(owner, removed);
  for (const eventId of [projected, removed, withdrawn]) {
    failed(await active.saveCooked(f.input({ eventId })), 'content.cooked_account_id_conflict');
    const reference = ready(await active.prepareCookedRecovery(f.input({ eventId })));
    failed(await active.readCookedRecovery(reference), 'content.cooked_account_id_conflict');
    failed(await active.resolveCookedRecovery(reference), 'content.cooked_account_id_conflict');
  }
  assert.equal(f.count('cooking_event'), 0);
  assert.equal(f.count('content_cooking_event_authority'), 0);
  f.write.database
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(randomUUID(), randomUUID());
  failed(await active.resolveCookedOperation(f.input()));
});

test('session closure and event authority roll back together after an injected journal failure', async (t) => {
  const f = await fixture(t),
    session = ready(
      await f.sessions.saveSession({
        operationId: randomUUID(),
        sessionId: randomUUID(),
        contentRef: clone(f.bundled.ref),
        expectedRevision: null,
        passageSequence: f.bundled.document.recipe.instructions[0]!.sequence,
      }),
    );
  const input = f.input({
      session: { sessionId: session.session.sessionId, expectedRevision: session.session.revision },
    }),
    before = f.rows();
  f.faults.statement = 'INSERT INTO content_cooking_event_authority';
  failed(await f.host.saveCooked(input));
  assert.deepEqual(f.rows(), before);
  assert.equal(ready(await f.host.recover(input)), null);
  f.faults.statement = '';
  ready(await f.host.saveCooked(input));
});

test('restore/adoption drift rejects new effects and account changes prevent stale receipt exposure', async (t) => {
  const f = await fixture(t),
    input = f.input();
  f.faults.beforeContent = () =>
    f.write.database
      .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','1')")
      .run();
  failed(await f.host.saveCooked(input), 'content.cooked_workspace_changed');
  f.faults.beforeContent = () =>
    f.write.database.exec('UPDATE app_content_adoption SET revision=1');
  failed(await f.host.saveCooked(input), 'content.cooked_workspace_changed');
  f.write.database.exec('UPDATE app_content_adoption SET revision=0');
  const saved = ready(await f.host.saveCooked(input));
  f.bind(randomUUID(), 1);
  failed(await f.create().recover(input), 'content.cooked_access_changed');
  f.bind(null, 2);
  assert.deepEqual(ready(await f.create().recover(input)), saved);
  f.setAccess(null);
  assert.throws(f.create);
});

test('lost save acknowledgement recovers durable proof and owner drift during COMMIT stays uncertain', async (t) => {
  const f = await fixture(t),
    input = f.input();
  f.faults.ackLost = true;
  const saved = ready(await f.host.saveCooked(input));
  assert.deepEqual(ready(await f.create().recover(input)), saved);
  assert.equal(f.changes.length, 1);
  const g = await fixture(t),
    pending = g.input();
  g.faults.afterCommit = () => g.setAccess(null);
  assert.equal((await g.host.saveCooked(pending)).kind, 'uncertain');
  assert.equal(g.count('cooking_event'), 1);
  assert.equal(g.changes.length, 0);
  g.bind(null, 1);
  assert.ok(ready(await g.create().recover(pending)));
});

test('lost cancellation acknowledgement retains the durable fence and cannot later save', async (t) => {
  const f = await fixture(t),
    input = f.input();
  f.faults.ackLost = true;
  const cancelled = ready(await f.host.resolveCookedOperation(input));
  assert.equal(cancelled.kind, 'cancelled');
  assert.deepEqual(ready(await f.create().saveCooked(input)), cancelled);
  assert.equal(f.count('local_history_content_pin'), 0);
});

test('oversized or NUL-suffixed authority is rejected without materializing private raw bytes', async (t) => {
  const f = await fixture(t),
    input = f.input();
  ready(await f.host.saveCooked(input));
  f.write.database.exec('PRAGMA ignore_check_constraints=ON');
  f.write.database
    .prepare('UPDATE content_cooking_event_authority SET request_fingerprint=?')
    .run('a'.repeat(64) + '\0' + 'x'.repeat(2 * 1024 * 1024));
  let materialized = false;
  const all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, values);
    if (
      rows.some((row) =>
        Object.values(row).some(
          (value: unknown) => typeof value === 'string' && value.length > 32768,
        ),
      )
    )
      materialized = true;
    return rows;
  };
  failed(await f.host.recover(input), 'content.cooked_stored_evidence_invalid');
  assert.equal(materialized, false);
});

test('final admission and date recheck prevent committing after a late owner or day change', async (t) => {
  const f = await fixture(t),
    input = f.input();
  f.faults.beforeCommit = () => f.setAccess(null);
  assert.equal((await f.host.saveCooked(input)).kind, 'uncertain');
  assert.equal(f.count('cooking_event'), 0);
  f.bind(null, 0);
  f.faults.beforeCommit = () => f.setDate('2026-09-30');
  failed(await f.host.saveCooked(input), 'content.cooked_future_date');
  assert.equal(f.count('cooking_event'), 0);
});

test('prepared recovery is body-free and read-only; reopened receipts prove omitted, null and private notes', async (t) => {
  const f = await fixture(t, false, 8);
  for (const note of [undefined, null, '', 'Private completion note']) {
    const input = f.input(note === undefined ? {} : { note }),
      before = f.rows();
    const reference = ready(await f.host.prepareCookedRecovery(input));
    assert.ok(validateContentCookedRecoveryReference(reference));
    assert.deepEqual(Object.keys(reference).sort(), [
      'contentRef',
      'eventId',
      'expectedHistoryEpoch',
      'formatVersion',
      'requestFingerprint',
      'session',
    ]);
    assert.equal(Object.isFrozen(reference.contentRef), true);
    assert.equal(reference.session, null);
    assert.deepEqual(f.rows(), before);
    assert.equal(ready(await f.host.readCookedRecovery(reference)), null);
    const saved = ready(await f.host.saveCooked(input));
    const reopened = f.create(8);
    assert.deepEqual(ready(await reopened.readCookedRecovery(clone(reference))), saved);
    assert.deepEqual(ready(await reopened.resolveCookedRecovery(clone(reference))), saved);
    assert.deepEqual(ready(await reopened.recover(input)), saved);
    reopened.close();
  }
  assert.equal(f.count('cooking_event'), 4);
  assert.equal(f.changes.length, 4);
});

test('prepared exact cooked recovery survives lost ACK, newer content and withdrawal without body access', async (t) => {
  const f = await fixture(t, false, 8),
    content = await f.adopt('first');
  const progress = ready(
    await f.sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: clone(content.first.revision.ref),
      expectedRevision: null,
      passageSequence: content.first.revision.document.recipe.instructions[0]!.sequence,
    }),
  );
  const input = f.input({
    contentRef: clone(content.first.revision.ref),
    note: 'Private archived completion',
    session: { sessionId: progress.session.sessionId, expectedRevision: progress.session.revision },
  });
  const reference = ready(await f.host.prepareCookedRecovery(input));
  await f.adopt('second');
  f.faults.ackLost = true;
  const saved = ready(await f.host.saveCooked(input));
  assert.equal(saved.kind, 'saved');
  if (saved.kind !== 'saved') assert.fail();
  assert.equal(saved.closedSession?.state, 'completed');
  assert.deepEqual(saved.closedSession?.contentRef, content.first.revision.ref);
  await f.adopt('withdraw');
  f.faults.unavailable = true;
  const calls = f.faults.calls;
  f.host.close();
  assert.deepEqual(ready(await f.create(8).readCookedRecovery(reference)), saved);
  assert.deepEqual(ready(await f.create(8).resolveCookedRecovery(reference)), saved);
  assert.equal(f.faults.calls, calls);
  assert.equal(f.count('cooking_event'), 1);
  assert.equal(f.count('local_history_content_pin'), 1);
});

test('metadata resolution wins against a delayed original save and retains exact cancellation after lost ACK', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input({ note: 'Never persisted draft' });
  const reference = ready(await f.host.prepareCookedRecovery(input));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.faults.pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.faults.entered = entered;
  const pending = f.host.saveCooked(input);
  await gate;
  f.faults.ackLost = true;
  const cancelled = ready(await f.create(8).resolveCookedRecovery(reference));
  release();
  assert.equal(cancelled.kind, 'cancelled');
  assert.deepEqual(ready(await pending), cancelled);
  assert.deepEqual(ready(await f.create(8).readCookedRecovery(reference)), cancelled);
  assert.deepEqual(ready(await f.create(8).resolveCookedOperation(input)), cancelled);
  failed(
    await f.host.saveCooked({ ...input, note: 'Different request' }),
    'content.cooked_operation_conflict',
  );
  assert.equal(f.count('cooking_event'), 1);
  assert.equal(f.count('local_history_content_pin'), 0);
  assert.equal(JSON.stringify(f.rows()).includes(input.note!), false);
});

test('metadata recovery respects history hiding and physical clear without hidden private copies', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input({ note: 'ERASE_THIS_PRIVATE_NOTE' });
  const reference = ready(await f.host.prepareCookedRecovery(input));
  ready(await f.host.saveCooked(input));
  const cleared = { kind: 'cleared', eventId: input.eventId, historyEpoch: 0 };
  f.write.database.exec(
    'UPDATE cooking_state SET history_epoch=1,history_revision=history_revision+1',
  );
  assert.deepEqual(ready(await f.host.readCookedRecovery(reference)), cleared);
  f.write.database.exec(
    "DELETE FROM local_history_content_pin; UPDATE cooking_event SET state='cleared',cooked_on=NULL,recorded_at=NULL,request_fingerprint=NULL,receipt_json=NULL",
  );
  f.faults.unavailable = true;
  assert.deepEqual(ready(await f.create(8).readCookedRecovery(reference)), cleared);
  assert.deepEqual(ready(await f.create(8).resolveCookedRecovery(reference)), cleared);
  assert.equal(JSON.stringify([reference, f.rows()]).includes(input.note!), false);
  assert.equal(JSON.stringify(f.rows().authority).includes(input.cookedOn), false);
});

test('recovery rejects changed identity, extra private fields, invalid bytes and corrupted private receipt', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input({ note: 'Original note' });
  const reference = ready(await f.host.prepareCookedRecovery(input));
  ready(await f.host.saveCooked(input));
  const before = f.rows();
  const invalid: unknown[] = [
    { ...reference, requestFingerprint: 'f'.repeat(64) },
    { ...reference, contentRef: { ...reference.contentRef, revisionId: 'another-revision' } },
    { ...reference, expectedHistoryEpoch: 1 },
    { ...reference, session: { sessionId: randomUUID(), expectedRevision: 1 } },
    { ...reference, note: 'must not be accepted' },
    { ...reference, requestFingerprint: 'a'.repeat(2097152) },
    { ...reference, expectedHistoryEpoch: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of invalid) {
    const candidate = value as ContentCookedRecoveryReference;
    failed(await f.host.readCookedRecovery(candidate));
    failed(await f.host.resolveCookedRecovery(candidate));
  }
  assert.deepEqual(f.rows(), before);
  const row = f.write.database.prepare('SELECT receipt_json FROM cooking_event').get()!;
  const receipt = JSON.parse(row.receipt_json as string);
  receipt.event.note = 'Tampered note';
  f.write.database.prepare('UPDATE cooking_event SET receipt_json=?').run(JSON.stringify(receipt));
  failed(await f.host.readCookedRecovery(reference), 'content.cooked_stored_evidence_invalid');
  failed(await f.host.resolveCookedRecovery(reference), 'content.cooked_stored_evidence_invalid');
});

test('metadata recovery cannot adopt a legacy event ID and default schema7 cannot enter8', async (t) => {
  const f = await fixture(t, true, 8),
    input = f.input({ eventId: f.legacyId });
  const reference = ready(await f.host.prepareCookedRecovery(input)),
    before = f.rows();
  failed(await f.host.readCookedRecovery(reference), 'content.cooked_operation_conflict');
  failed(await f.host.resolveCookedRecovery(reference), 'content.cooked_operation_conflict');
  const legacy = f.create();
  failed(await legacy.prepareCookedRecovery(f.input()));
  failed(await legacy.readCookedRecovery(reference));
  failed(await legacy.resolveCookedRecovery(reference));
  assert.deepEqual(f.rows(), before);
});

test('metadata preparation and reading revoke in-flight results; cancellation close never exposes success', async (t) => {
  for (const method of ['prepare', 'read', 'resolve'] as const) {
    await t.test(method, async (t) => {
      const f = await fixture(t, false, 8),
        input = f.input({ note: 'Revoked private receipt' });
      const reference = ready(await f.host.prepareCookedRecovery(input));
      if (method === 'read') ready(await f.host.saveCooked(input));
      if (method === 'resolve') f.faults.onCommitted = () => f.host.close();
      else {
        const all = f.read.connection.all;
        f.read.connection.all = async <Row extends object>(
          sql: string,
          values?: readonly SqlValue[],
        ) => {
          const rows = await all<Row>(sql, values);
          if (sql.includes("WHERE collection='store'")) f.host.close();
          return rows;
        };
      }
      const result =
        method === 'prepare'
          ? await f.host.prepareCookedRecovery(input)
          : method === 'read'
            ? await f.host.readCookedRecovery(reference)
            : await f.host.resolveCookedRecovery(reference);
      assert.notEqual(result.kind, 'ready');
      assert.equal('value' in result, false);
    });
  }
  const f = await fixture(t, false, 8),
    input = f.input();
  const reference = ready(await f.host.prepareCookedRecovery(input));
  f.setAccess(null);
  failed(await f.host.prepareCookedRecovery(input));
  failed(await f.host.readCookedRecovery(reference));
  failed(await f.host.resolveCookedRecovery(reference));
  assert.equal(f.count('cooking_event'), 0);
});

test('cooked clock admission rejects oversized TEXT and BLOB before bridge materialization across every port', async (t) => {
  for (const field of ['history_revision', 'history_epoch', 'session_revision', 'store'] as const) {
    for (const kind of ['text', 'blob'] as const) {
      await t.test(`${field} ${kind}`, async (t) => {
        const f = await fixture(t, false, 8),
          input = f.input();
        const reference = ready(await f.host.prepareCookedRecovery(input));
        let oversizedTransfers = 0;
        for (const connection of [f.read.connection, f.write.connection]) {
          const all = connection.all;
          connection.all = async <Row extends object>(
            sql: string,
            values?: readonly SqlValue[],
          ) => {
            const rows = await all<Row>(sql, values);
            for (const row of rows)
              for (const value of Object.values(row))
                if (
                  (typeof value === 'string' || value instanceof Uint8Array) &&
                  value.length > 32768
                )
                  oversizedTransfers++;
            return rows;
          };
        }
        f.write.database.exec('PRAGMA ignore_check_constraints=ON');
        f.write.database
          .prepare(
            field === 'store'
              ? "UPDATE state_revision SET revision=? WHERE collection='store'"
              : `UPDATE cooking_state SET ${field}=?`,
          )
          .run(kind === 'text' ? 'x'.repeat(1048576) : Buffer.alloc(1048576));
        for (const result of [
          await f.host.prepareCookedRecovery(input),
          await f.host.readCookedRecovery(reference),
          await f.host.resolveCookedRecovery(reference),
          await f.host.saveCooked(input),
          await f.host.recover(input),
          await f.host.resolveCookedOperation(input),
        ])
          failed(result);
        assert.equal(oversizedTransfers, 0);
        assert.equal(f.count('cooking_event'), 0);
      });
    }
  }
});

test('new cooked events select exact primary photoKey even when secondary media comes first', async (t) => {
  const f = await fixture(t, false, 8, true),
    content = await f.adopt('first');
  const revision = content.first.revision;
  assert.notEqual(revision.document.media[0]!.photoKey, revision.document.recipe.photoKey);
  const primary = revision.document.media.find(
    (media) => media.photoKey === revision.document.recipe.photoKey,
  )!;
  const input = f.input({ contentRef: clone(revision.ref) });
  const reference = ready(await f.host.prepareCookedRecovery(input));
  const saved = ready(await f.host.saveCooked(input));
  assert.equal(saved.kind, 'saved');
  if (saved.kind !== 'saved') assert.fail();
  assert.equal(saved.event.photoAssetId, primary.assetId);
  assert.notEqual(saved.event.photoAssetId, revision.document.media[0]!.assetId);
  assert.deepEqual(ready(await f.create(8).readCookedRecovery(reference)), saved);
  assert.deepEqual(ready(await f.create(8).recover(input)), saved);
  // Existing valid historical receipt media remains unchanged on recovery; this is
  // a synthetic receipt from the previously accepted first-media selection rule.
  const historical = {
    ...saved,
    event: { ...saved.event, photoAssetId: revision.document.media[0]!.assetId },
  };
  f.write.database
    .prepare('UPDATE cooking_event SET receipt_json=? WHERE event_id=?')
    .run(canonicalContentJson(historical), input.eventId);
  const before = f.rows();
  assert.deepEqual(ready(await f.create(8).readCookedRecovery(reference)), historical);
  assert.deepEqual(ready(await f.host.saveCooked(input)), historical);
  assert.deepEqual(f.rows(), before);
});

test('cooked workspace clocks reject large SQL values while historical receipts remain readable', async (t) => {
  for (const field of ['adoption', 'restore'] as const)
    for (const kind of ['text', 'blob'] as const) {
      await t.test(`${field} ${kind}`, async (t) => {
        const f = await fixture(t, false, 8),
          input = f.input({ note: 'Existing private receipt' });
        const reference = ready(await f.host.prepareCookedRecovery(input));
        const saved = ready(await f.host.saveCooked(input));
        const pending = f.input(),
          pendingReference = ready(await f.host.prepareCookedRecovery(pending));
        let oversizedTransfers = 0;
        for (const connection of [f.read.connection, f.write.connection]) {
          const all = connection.all;
          connection.all = async <Row extends object>(
            sql: string,
            values?: readonly SqlValue[],
          ) => {
            const rows = await all<Row>(sql, values);
            for (const row of rows)
              for (const value of Object.values(row))
                if (
                  (typeof value === 'string' || value instanceof Uint8Array) &&
                  value.length > 32768
                )
                  oversizedTransfers++;
            return rows;
          };
        }
        const oversized = kind === 'text' ? 'x'.repeat(1048576) : Buffer.alloc(1048576);
        f.write.database.exec('PRAGMA ignore_check_constraints=ON');
        if (field === 'adoption')
          f.write.database.prepare('UPDATE app_content_adoption SET revision=?').run(oversized);
        else
          f.write.database
            .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,?,?,?,?)')
            .run(randomUUID(), 'a'.repeat(64), oversized, '{}', '{}', '{}');
        for (const result of [
          await f.host.saveCooked(pending),
          await f.host.resolveCookedOperation(pending),
          await f.host.resolveCookedRecovery(pendingReference),
        ])
          failed(result);
        assert.deepEqual(ready(await f.host.readCookedRecovery(reference)), saved);
        assert.deepEqual(ready(await f.host.recover(input)), saved);
        assert.deepEqual(ready(await f.host.resolveCookedRecovery(reference)), saved);
        assert.deepEqual(ready(await f.host.saveCooked(input)), saved);
        assert.equal(oversizedTransfers, 0);
        assert.equal(f.count('cooking_event'), 1);
      });
    }
});
