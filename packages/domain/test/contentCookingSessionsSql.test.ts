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
import { cookingContentIdentity, type CookingSession, type RepositoryResult } from '../src';
import { createContentCookingSessions } from '../../../apps/mobile/src/data/contentCookingSessions';
import type { SaveContentCookingSessionInput } from '../../../apps/mobile/src/data/contentCookingRecords';
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
  authoredId = '900000092';
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: { kind: string; error?: { messageKey: string } }, message?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (message) assert.equal(result.error?.messageKey, message);
}
// Controlled core-verifier ports; real signatures/media/reservations are tested by the admin bridge.
async function contentFixture() {
  const baseline = await createBundledContentSnapshot(sha256),
    document = authoredFixture(authoredId);
  if (document.kind !== 'authored') assert.fail();
  const first = await published(document, 'session-first');
  document.provenance.basedOn = clone(first.revision.ref);
  document.recipe.title = 'A deliberately newer revision';
  const second = await published(document, 'session-second');
  const releases = new Map<string, { manifest: ContentOverlayManifest; fingerprint: string }>(),
    publications = new Map<string, PublishedRecipeRevision>();
  let head: OverlayHead | null = null,
    snapshot: EffectiveContentSnapshot;
  async function issue(mode: 'first' | 'second' | 'archive' | 'withdraw') {
    const publication = mode === 'first' ? first : second,
      sequence = (head?.sequence ?? 0) + 1;
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `session-release-${sequence}`,
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

async function fixture(t: TestContext, legacy = false, cookingSchemaVersion: 7 | 8 = 7) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-session-')),
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
  const bundled = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256);
  let old: CookingSession | undefined;
  if (legacy) {
    old = {
      ...(await cookingContentIdentity(catalogue.recipes[0]!, catalogue.identity, sha256)),
      sessionId: randomUUID(),
      revision: 1,
      passageSequence: bundled.document.recipe.instructions[0]!.sequence,
      state: 'active',
      updatedAt: at,
      lastOperationId: randomUUID(),
    };
    write.database
      .prepare('INSERT INTO cooking_session VALUES (?,?,?,?,?,?,?,?)')
      .run(
        old.recipeId,
        old.sessionId,
        old.revision,
        old.state,
        old.updatedAt,
        old.lastOperationId,
        'a'.repeat(64),
        JSON.stringify(old),
      );
    write.database.exec(
      "UPDATE cooking_state SET session_revision=1; UPDATE state_revision SET revision=1 WHERE collection='store'",
    );
  }
  await migrateCookingContentDatabase(writer, { sha256 });
  if (cookingSchemaVersion === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 0 },
    content: Awaited<ReturnType<typeof contentFixture>> | null = null;
  const faults = {
    calls: 0,
    active: false,
    unavailable: false,
    afterContent: false,
    statement: '',
    ackLost: false,
    onCommitted: undefined as (() => void) | undefined,
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
  const contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReading'
  > = {
    async withVerifiedReading(expected, refs, work) {
      faults.calls++;
      if (faults.unavailable) throw new Error('Fixture unavailable delivery');
      assert.deepEqual(expected, content?.head ?? null);
      if (content)
        for (const ref of refs)
          assert.equal(
            content.snapshot.lookupExact(ref).kind,
            'readable',
            'Exact body unavailable',
          );
      const hook = faults.beforeContent;
      faults.beforeContent = undefined;
      await hook?.();
      let active = true;
      faults.active = true;
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
        const result = await work(view);
        if (faults.afterContent) throw new Error('Fixture reservation acknowledgement lost');
        return result;
      } finally {
        active = false;
        faults.active = false;
      }
    },
  };
  const changes: unknown[] = [];
  const create = (version?: 7 | 8) =>
    createContentCookingSessions({
      ...(version === undefined ? {} : { cookingSchemaVersion: version }),
      reader,
      writer,
      contentStore,
      installationId: ids.installationId,
      sha256,
      now: () => at,
      getAccess: () => access,
      assertAccess(scope) {
        assert.deepEqual(access, scope);
        return undefined;
      },
      onCommitted(change) {
        changes.push(change);
        faults.onCommitted?.();
      },
    });
  const host = create(cookingSchemaVersion);
  function input(
    overrides: Partial<SaveContentCookingSessionInput> = {},
  ): SaveContentCookingSessionInput {
    return {
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: clone(bundled.ref),
      expectedRevision: null,
      passageSequence: bundled.document.recipe.instructions[0]!.sequence,
      ...overrides,
    };
  }
  const rows = () => ({
    parent: write.database.prepare('SELECT * FROM cooking_session').all(),
    pin: write.database.prepare('SELECT * FROM cooking_session_content_pin').all(),
    state: write.database.prepare('SELECT * FROM cooking_state').all(),
    revisions: write.database.prepare('SELECT * FROM state_revision').all(),
    operations: write.database.prepare('SELECT * FROM content_cooking_session_operation').all(),
  });
  const count = (table: string) =>
    write.database.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
  async function adopt(mode: 'first' | 'second' | 'archive' | 'withdraw') {
    if (!content) content = await contentFixture();
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
    input,
    rows,
    count,
    adopt,
    bind,
    old,
    bundled,
    faults,
    write,
    read,
    writer,
    changes,
    ids,
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
  };
}

test('session observers closing the host after save or body-free dismiss cannot expose ready success', async (t) => {
  for (const action of ['save', 'dismiss'] as const) {
    const f = await fixture(t, false, 8),
      input = f.input();
    const saved = action === 'dismiss' ? ready(await f.host.saveSession(input)) : null;
    const dismiss = {
      operationId: randomUUID(),
      recipeId: input.contentRef.recipeId,
      sessionId: input.sessionId,
      expectedRevision: saved?.session.revision ?? 1,
    };
    const notifications = f.changes.length;
    f.faults.onCommitted = () => f.host.close();
    const result =
      action === 'save' ? await f.host.saveSession(input) : await f.host.dismissSession(dismiss);
    assert.equal(result.kind, 'uncertain');
    assert.equal(f.changes.length, notifications + 1);
    const before = f.rows();
    const recovered = ready(
      await f
        .create(8)
        .recover(action === 'save' ? { kind: 'save', input } : { kind: 'dismiss', input: dismiss }),
    );
    assert.equal(recovered?.kind, action === 'save' ? 'saved' : 'dismissed');
    assert.deepEqual(f.rows(), before);
  }
});

test('session lost-ACK recovery returns uncertainty when its notification revokes the owner', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input();
  f.faults.ackLost = true;
  f.faults.onCommitted = () => f.setAccess(null);
  const result = await f.host.saveSession(input);
  assert.equal(result.kind, 'uncertain');
  if (result.kind !== 'uncertain') assert.fail();
  assert.equal(result.operationId, input.operationId);
  assert.equal(f.writer.requiresRecovery(), true);
  assert.equal(f.count('content_cooking_session_operation'), 1);
  assert.equal(f.changes.length, 1);
  f.bind(null, 1);
  assert.equal(ready(await f.create(8).recover({ kind: 'save', input }))?.kind, 'saved');
});

test('explicit schema8 sessions retain exact authored progress through newer content and withdrawal dismissal', async (t) => {
  const f = await fixture(t, false, 8),
    content = await f.adopt('first');
  assert.equal(f.write.database.prepare('PRAGMA user_version').get()!.user_version, 8);
  const input = f.input({ contentRef: clone(content.first.revision.ref), passageSequence: 1 });
  const saved = ready(await f.host.saveSession(input));
  await f.adopt('second');
  const reopened = f.create(8),
    view = ready(await reopened.readSession(authoredId));
  assert.equal(view.resume, 'exact');
  assert.deepEqual(view.recipe?.contentRef, content.first.revision.ref);
  const progressInput = {
    ...input,
    operationId: randomUUID(),
    expectedRevision: saved.session.revision,
    passageSequence: 2,
  };
  const progress = ready(await reopened.saveSession(progressInput));
  assert.equal(progress.session.passageSequence, 2);
  assert.deepEqual(progress.session.contentRef, content.first.revision.ref);
  const pin = f.write.database
    .prepare(
      'SELECT recipe_id recipeId,revision_id revisionId,content_fingerprint contentFingerprint FROM cooking_session_content_pin',
    )
    .get();
  assert.deepEqual({ ...pin }, content.first.revision.ref);
  await f.adopt('withdraw');
  assert.equal(ready(await reopened.readSession(authoredId)).resume, 'unavailable');
  const dismiss = {
    operationId: randomUUID(),
    recipeId: authoredId,
    sessionId: input.sessionId,
    expectedRevision: progress.session.revision,
  };
  const dismissed = ready(await reopened.dismissSession(dismiss));
  assert.equal(dismissed.session.state, 'dismissed');
  assert.deepEqual(ready(await f.create(8).recover({ kind: 'save', input })), saved);
  assert.deepEqual(
    ready(await f.create(8).recover({ kind: 'dismiss', input: dismiss })),
    dismissed,
  );
  assert.equal(f.count('cooking_event'), 0);
  assert.deepEqual(f.write.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('session schema opt-in is exact and migration between capture and write cannot authorize an old host', async (t) => {
  const f = await fixture(t),
    input = f.input();
  failed(await f.create(8).readSession(input.contentRef.recipeId));
  failed(await f.create(8).saveSession(input));
  const saved = ready(await f.host.saveSession(input));
  const originalReceipt = f.write.database
    .prepare('SELECT receipt_json FROM content_cooking_session_operation')
    .get()!.receipt_json;
  const progress = {
    ...input,
    operationId: randomUUID(),
    expectedRevision: saved.session.revision,
  };
  f.faults.beforeContent = () => migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  assert.notEqual((await f.host.saveSession(progress)).kind, 'ready');
  assert.equal(f.write.database.prepare('PRAGMA user_version').get()!.user_version, 8);
  assert.equal(f.count('content_cooking_session_operation'), 1);
  assert.equal(f.rows().parent[0]!.revision, saved.session.revision);
  failed(await f.create().readSession(input.contentRef.recipeId));
  failed(await f.create().recover({ kind: 'save', input }));
  failed(await f.create().saveSession(progress));
  const upgraded = f.create(8);
  assert.deepEqual(ready(await upgraded.recover({ kind: 'save', input })), saved);
  assert.equal(
    f.write.database.prepare('SELECT receipt_json FROM content_cooking_session_operation').get()!
      .receipt_json,
    originalReceipt,
  );
  assert.ok(ready(await upgraded.saveSession(progress)).session.revision > saved.session.revision);
});

test('schema8 preserves v1 session bytes until an explicit exact restart', async (t) => {
  const f = await fixture(t, true, 8),
    original = f.rows().parent[0]!.session_json;
  assert.ok(f.old);
  const view = ready(await f.host.readSession(f.old.recipeId));
  assert.equal(view.resume, 'legacy_requires_restart');
  assert.equal(f.rows().parent[0]!.session_json, original);
  const restarted = ready(await f.host.saveSession(f.input({ expectedRevision: f.old.revision })));
  assert.equal(restarted.session.readerVersion, 2);
  assert.deepEqual(restarted.session.contentRef, f.bundled.ref);
  assert.equal(f.count('cooking_event'), 0);
});

test('schema8 session SQL and late owner failures roll back progress, exact pins and receipt authority', async (t) => {
  const f = await fixture(t, false, 8),
    content = await f.adopt('first');
  const input = f.input({ contentRef: clone(content.first.revision.ref), passageSequence: 1 }),
    before = f.rows();
  const retainedBefore = f.count('recipe_content_revision');
  f.faults.statement = 'INSERT INTO content_cooking_session_operation';
  failed(await f.host.saveSession(input));
  assert.deepEqual(f.rows(), before);
  assert.equal(f.count('recipe_content_revision'), retainedBefore);
  f.faults.statement = '';
  f.faults.beforeCommit = () => f.setAccess(null);
  assert.equal((await f.host.saveSession(input)).kind, 'uncertain');
  assert.deepEqual(f.rows(), before);
  f.bind(null, 0);
  ready(await f.host.saveSession(input));
  assert.equal(f.count('content_cooking_session_operation'), 1);
});

test('schema8 session lost ACK recovers one exact receipt while stale owner and adoption cannot expose or write progress', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input();
  f.faults.beforeContent = () =>
    f.write.database.exec('UPDATE app_content_adoption SET revision=1');
  failed(await f.host.saveSession(input), 'content.cooking_workspace_changed');
  f.write.database.exec('UPDATE app_content_adoption SET revision=0');
  f.faults.ackLost = true;
  const saved = ready(await f.host.saveSession(input));
  assert.equal(f.writer.requiresRecovery(), true);
  f.host.close();
  f.faults.unavailable = true;
  assert.deepEqual(ready(await f.create(8).recover({ kind: 'save', input })), saved);
  assert.deepEqual(ready(await f.create(8).saveSession(input)), saved);
  f.bind(randomUUID(), 1);
  failed(await f.create(8).recover({ kind: 'save', input }), 'content.cooking_access_changed');
  assert.equal(f.count('content_cooking_session_operation'), 1);
  assert.equal(f.count('cooking_session_content_pin'), 1);
});

test('v2 saves use existing session/pin rows; retries recover original receipts after later progress and dismiss', async (t) => {
  const f = await fixture(t),
    first = f.input(),
    initial = ready(await f.host.saveSession(first));
  assert.equal(initial.session.readerVersion, 2);
  assert.equal(f.count('cooking_session'), 1);
  assert.equal(f.count('cooking_session_content_pin'), 1);
  const second = {
    ...first,
    operationId: randomUUID(),
    expectedRevision: initial.session.revision,
  };
  const progress = ready(await f.create().saveSession(second));
  assert.ok(progress.session.revision > initial.session.revision);
  const dismiss = {
    operationId: randomUUID(),
    recipeId: first.contentRef.recipeId,
    sessionId: first.sessionId,
    expectedRevision: progress.session.revision,
  };
  const dismissed = ready(await f.host.dismissSession(dismiss));
  assert.equal(dismissed.session.state, 'dismissed');
  assert.equal(ready(await f.host.readSession(first.contentRef.recipeId)).resume, 'none');
  const before = f.rows();
  assert.deepEqual(ready(await f.create().saveSession(first)), initial);
  assert.deepEqual(ready(await f.host.recover({ kind: 'save', input: second })), progress);
  assert.deepEqual(ready(await f.create().dismissSession(dismiss)), dismissed);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.count('cooking_event'), 0);
  assert.equal(f.count('shopping_contribution'), 0);
  assert.deepEqual(f.write.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('session receipts reject future revisions while older receipts survive later progress and restore fencing', async (t) => {
  const f = await fixture(t),
    input = f.input(),
    saved = ready(await f.host.saveSession(input));
  const later = ready(
    await f.host.saveSession({
      ...input,
      operationId: randomUUID(),
      expectedRevision: saved.session.revision,
    }),
  );
  assert.ok(later.session.revision > saved.session.revision);
  f.write.database
    .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','1')")
    .run();
  const request = { kind: 'save' as const, input };
  assert.deepEqual(ready(await f.create().recover(request)), saved);
  const original = f.write.database
    .prepare('SELECT receipt_json FROM content_cooking_session_operation WHERE operation_id=?')
    .get(input.operationId)!.receipt_json as string;
  const corrupted = {
    ...saved,
    session: { ...saved.session, revision: later.session.revision + 1 },
  };
  f.write.database
    .prepare('UPDATE content_cooking_session_operation SET receipt_json=? WHERE operation_id=?')
    .run(canonicalContentJson(corrupted, 8192), input.operationId);
  const before = f.rows();
  failed(await f.create().recover(request), 'content.cooking_stored_evidence_invalid');
  failed(await f.host.saveSession(input), 'content.cooking_stored_evidence_invalid');
  assert.deepEqual(f.rows(), before);
  f.write.database
    .prepare('UPDATE content_cooking_session_operation SET receipt_json=? WHERE operation_id=?')
    .run(original, input.operationId);
  assert.deepEqual(ready(await f.create().recover(request)), saved);
});

test('legacy session bytes stay unchanged until explicit new-session restart', async (t) => {
  const f = await fixture(t, true),
    before = f.rows(),
    legacy = f.old!;
  const view = ready(await f.host.readSession(legacy.recipeId));
  assert.equal(view.resume, 'legacy_requires_restart');
  assert.deepEqual(view.session, legacy);
  const matching = f.input({ sessionId: legacy.sessionId, expectedRevision: legacy.revision });
  failed(await f.host.saveSession(matching), 'content.cooking_legacy_restart_required');
  failed(
    await f.host.dismissSession({
      operationId: randomUUID(),
      recipeId: legacy.recipeId,
      sessionId: legacy.sessionId,
      expectedRevision: legacy.revision,
    }),
    'content.cooking_legacy_restart_required',
  );
  assert.deepEqual(f.rows(), before);
  const restarted = ready(
    await f.host.saveSession({ ...matching, operationId: randomUUID(), sessionId: randomUUID() }),
  );
  assert.equal(restarted.session.readerVersion, 2);
  assert.notEqual(restarted.session.sessionId, legacy.sessionId);
});

test('saved exact authored session resumes and progresses after newer current content; restart is explicit and current-only', async (t) => {
  const f = await fixture(t),
    content = await f.adopt('first');
  const first = f.input({
    contentRef: clone(content.first.revision.ref),
    passageSequence: content.first.revision.document.recipe.instructions[0]!.sequence,
  });
  const initial = ready(await f.host.saveSession(first));
  await f.adopt('second');
  const view = ready(await f.host.readSession(authoredId));
  assert.equal(view.resume, 'exact');
  assert.deepEqual(view.recipe?.contentRef, content.first.revision.ref);
  assert.notEqual(view.recipe?.title, content.second.revision.document.recipe.title);
  const progress = ready(
    await f.host.saveSession({
      ...first,
      operationId: randomUUID(),
      expectedRevision: initial.session.revision,
    }),
  );
  failed(
    await f.host.saveSession({
      ...first,
      operationId: randomUUID(),
      expectedRevision: progress.session.revision,
      contentRef: clone(content.second.revision.ref),
    }),
    'content.cooking_session_content_changed',
  );
  failed(
    await f.host.saveSession({
      ...first,
      operationId: randomUUID(),
      sessionId: randomUUID(),
      expectedRevision: progress.session.revision,
    }),
    'content.cooking_content_unavailable',
  );
  const restarted = ready(
    await f.host.saveSession({
      ...first,
      operationId: randomUUID(),
      sessionId: randomUUID(),
      expectedRevision: progress.session.revision,
      contentRef: clone(content.second.revision.ref),
    }),
  );
  assert.deepEqual(restarted.session.contentRef, content.second.revision.ref);
  failed(
    await f.host.saveSession({
      ...first,
      operationId: randomUUID(),
      expectedRevision: restarted.session.revision,
      contentRef: clone(content.second.revision.ref),
    }),
    'content.cooking_session_id_reused',
  );
  assert.deepEqual(ready(await f.host.recover({ kind: 'save', input: first })), initial);
});

test('archive progress remains exact; withdrawal returns metadata without body and still permits dismissal/recovery', async (t) => {
  const f = await fixture(t),
    content = await f.adopt('first');
  await f.adopt('second');
  const input = f.input({
    contentRef: clone(content.second.revision.ref),
    passageSequence: content.second.revision.document.recipe.instructions[0]!.sequence,
  });
  const initial = ready(await f.host.saveSession(input));
  await f.adopt('archive');
  assert.equal(ready(await f.host.readSession(authoredId)).resume, 'exact');
  const progress = ready(
    await f.host.saveSession({
      ...input,
      operationId: randomUUID(),
      expectedRevision: initial.session.revision,
    }),
  );
  await f.adopt('withdraw');
  const unavailable = ready(await f.host.readSession(authoredId));
  assert.equal(unavailable.recipe, null);
  assert.equal(unavailable.resume, 'unavailable');
  assert.deepEqual(unavailable.session, progress.session);
  const calls = f.faults.calls;
  const dismissed = ready(
    await f.host.dismissSession({
      operationId: randomUUID(),
      recipeId: authoredId,
      sessionId: input.sessionId,
      expectedRevision: progress.session.revision,
    }),
  );
  assert.equal(dismissed.session.state, 'dismissed');
  assert.deepEqual(ready(await f.host.recover({ kind: 'save', input })), initial);
  assert.equal(f.faults.calls, calls, 'dismiss and recovery must not open content');
});

test('owner/installation/restore/adoption drift fences mutations and stale read results', async (t) => {
  const f = await fixture(t),
    input = f.input();
  f.faults.beforeContent = () =>
    f.write.database
      .prepare("INSERT INTO app_metadata VALUES ('account-replication:apply-epoch','1')")
      .run();
  failed(await f.host.saveSession(input), 'content.cooking_workspace_changed');
  assert.equal(f.count('cooking_session'), 0);
  f.faults.beforeContent = () =>
    f.write.database.exec('UPDATE app_content_adoption SET revision=revision+1');
  failed(await f.host.saveSession(input), 'content.cooking_workspace_changed');
  f.write.database.exec('UPDATE app_content_adoption SET revision=0');
  f.faults.beforeContent = () => f.setAccess(null);
  failed(await f.host.saveSession(input), 'content.cooking_access_changed');
  assert.throws(f.create);
  f.bind(null, 1);
  const active = f.create(),
    saved = ready(await active.saveSession(input));
  f.bind(randomUUID(), 2);
  failed(await f.create().recover({ kind: 'save', input }), 'content.cooking_access_changed');
  f.bind(null, 3);
  assert.deepEqual(ready(await f.create().recover({ kind: 'save', input })), saved);
  f.write.database
    .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
    .run(randomUUID());
  failed(await f.create().readSession(input.contentRef.recipeId), 'content.cooking_access_changed');
});

test('invalid passage, stale revisions, operation reuse and reused session IDs do not rewrite progress', async (t) => {
  const f = await fixture(t),
    input = f.input(),
    initial = ready(await f.host.saveSession(input)),
    before = f.rows();
  failed(
    await f.host.saveSession({ ...input, passageSequence: 9999 }),
    'content.cooking_operation_conflict',
  );
  failed(
    await f.host.saveSession({ ...input, operationId: randomUUID() }),
    'content.cooking_session_changed',
  );
  failed(
    await f.host.saveSession({
      ...input,
      operationId: randomUUID(),
      expectedRevision: initial.session.revision,
      passageSequence: 9999,
    }),
    'content.cooking_invalid_passage',
  );
  assert.deepEqual(f.rows(), before);
});

test('mid-write fault rolls back the old session, pin, revisions and journal atomically', async (t) => {
  const f = await fixture(t),
    input = f.input(),
    initial = ready(await f.host.saveSession(input)),
    before = f.rows();
  f.faults.statement = 'INSERT INTO content_cooking_session_operation';
  const update = {
    ...input,
    operationId: randomUUID(),
    expectedRevision: initial.session.revision,
  };
  failed(await f.host.saveSession(update));
  assert.deepEqual(f.rows(), before);
  assert.equal(ready(await f.host.recover({ kind: 'save', input: update })), null);
  f.faults.statement = '';
  ready(await f.host.saveSession(update));
});

test('lost COMMIT acknowledgement recovers durable original result without replay', async (t) => {
  const f = await fixture(t),
    input = f.input();
  f.faults.ackLost = true;
  const saved = ready(await f.host.saveSession(input));
  assert.equal(f.count('content_cooking_session_operation'), 1);
  assert.deepEqual(ready(await f.create().recover({ kind: 'save', input })), saved);
  assert.deepEqual(ready(await f.create().saveSession(input)), saved);
  assert.equal(f.changes.length, 1);
});

test('final admission rolls back; owner drift during COMMIT is uncertain and reveals no stale receipt', async (t) => {
  const f = await fixture(t),
    input = f.input();
  f.faults.beforeCommit = () => f.setAccess(null);
  assert.equal((await f.host.saveSession(input)).kind, 'uncertain');
  assert.equal(f.count('cooking_session'), 0);
  f.bind(null, 0);
  f.faults.afterCommit = () => f.setAccess(null);
  assert.equal((await f.host.saveSession(input)).kind, 'uncertain');
  assert.equal(f.count('cooking_session'), 1);
  assert.equal(f.changes.length, 0);
  f.bind(null, 1);
  assert.ok(ready(await f.create().recover({ kind: 'save', input })));
});

test('reservation failure after commit returns only independently proven receipt and never duplicates notifications', async (t) => {
  const f = await fixture(t),
    input = f.input();
  f.faults.afterContent = true;
  const saved = ready(await f.host.saveSession(input));
  assert.deepEqual(ready(await f.host.recover({ kind: 'save', input })), saved);
  assert.equal(f.changes.length, 1);
});

test('oversized journal corruption is rejected before raw materialization', async (t) => {
  const f = await fixture(t),
    input = f.input();
  ready(await f.host.saveSession(input));
  f.write.database.exec('PRAGMA ignore_check_constraints=ON');
  f.write.database
    .prepare('UPDATE content_cooking_session_operation SET authority_json=?')
    .run(JSON.stringify({ private: 'x'.repeat(2 * 1024 * 1024) }));
  let materialized = false;
  const all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, values);
    if (
      rows.some((row) =>
        Object.values(row).some(
          (value: unknown) => typeof value === 'string' && value.length > 8192,
        ),
      )
    )
      materialized = true;
    return rows;
  };
  failed(await f.host.recover({ kind: 'save', input }), 'content.cooking_stored_evidence_invalid');
  assert.equal(materialized, false);
});

test('operation capacity fails whole save before any session changes and retains the journal', async (t) => {
  const f = await fixture(t),
    input = f.input();
  // Synthetic bounded SQL records exercise cardinality admission without loading
  // private payloads. This fixture does not claim these rows are recoverable proofs.
  f.write.database
    .exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000)
    INSERT INTO content_cooking_session_operation SELECT printf('00000000-0000-4000-8000-%012x',x),printf('%064x',x),'{}','{}' FROM n`);
  failed(await f.host.saveSession(input), 'content.cooking_journal_limit');
  assert.equal(f.count('cooking_session'), 0);
  assert.equal(f.count('content_cooking_session_operation'), 20000);
});

test('final session snapshot proof stays inside the content reservation before exposing a readable body', async (t) => {
  const f = await fixture(t),
    input = f.input();
  ready(await f.host.saveSession(input));
  const activeAtSessionRead: boolean[] = [],
    all = f.read.connection.all;
  f.read.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    if (sql.includes('FROM cooking_session p LEFT JOIN cooking_session_content_pin'))
      activeAtSessionRead.push(f.faults.active);
    return all<Row>(sql, values);
  };
  const view = ready(await f.host.readSession(input.contentRef.recipeId));
  assert.equal(view.resume, 'exact');
  assert.ok(view.recipe);
  assert.deepEqual(activeAtSessionRead, [false, true]);
});

test('resume selects newest active exact session, persists across hosts and excludes dismissed sessions', async (t) => {
  const f = await fixture(t, false, 8);
  assert.equal(ready(await f.host.readResumeSession()), null);
  const first = ready(await f.host.saveSession(f.input()));
  const other = await createBundledRecipeRevision(catalogue.recipes[1]!.recipeId, sha256);
  const second = ready(
    await f.host.saveSession(
      f.input({
        contentRef: clone(other.ref),
        passageSequence: other.document.recipe.instructions[0]!.sequence,
      }),
    ),
  );
  const resumed = ready(await f.create(8).readResumeSession());
  assert.equal(resumed?.resume, 'exact');
  assert.deepEqual(resumed?.session, second.session);
  assert.deepEqual(resumed?.recipe?.contentRef, other.ref);
  ready(
    await f.host.dismissSession({
      operationId: randomUUID(),
      recipeId: second.session.recipeId,
      sessionId: second.session.sessionId,
      expectedRevision: second.session.revision,
    }),
  );
  assert.deepEqual(ready(await f.host.readResumeSession())?.session, first.session);
  ready(
    await f.host.dismissSession({
      operationId: randomUUID(),
      recipeId: first.session.recipeId,
      sessionId: first.session.sessionId,
      expectedRevision: first.session.revision,
    }),
  );
  assert.equal(ready(await f.host.readResumeSession()), null);
  failed(await f.create().readResumeSession());
});

test('authoritative absent session recovery preserves a deliberate retry of the same original request', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input();
  const request = { kind: 'save' as const, input };
  assert.equal(ready(await f.host.recover(request)), null);
  f.host.close();
  const reopened = f.create(8);
  assert.equal(ready(await reopened.recover(clone(request))), null);
  assert.equal(f.count('content_cooking_session_operation'), 0);
  const saved = ready(await reopened.saveSession(clone(input)));
  assert.deepEqual(ready(await reopened.recover(clone(request))), saved);
  assert.deepEqual(ready(await reopened.saveSession(clone(input))), saved);
  assert.equal(f.count('content_cooking_session_operation'), 1);
  f.setAccess(null);
  failed(await reopened.recover(request));
});

test('resume retains the exact authored version after adoption and yields metadata only after withdrawal', async (t) => {
  const f = await fixture(t, false, 8),
    content = await f.adopt('first');
  const input = f.input({ contentRef: clone(content.first.revision.ref), passageSequence: 1 });
  const saved = ready(await f.host.saveSession(input));
  await f.adopt('second');
  assert.deepEqual(
    ready(await f.host.readResumeSession())?.recipe?.contentRef,
    content.first.revision.ref,
  );
  await f.adopt('withdraw');
  const withdrawn = ready(await f.create(8).readResumeSession());
  assert.equal(withdrawn?.resume, 'unavailable');
  assert.equal(withdrawn?.recipe, null);
  assert.deepEqual(withdrawn?.session, saved.session);
  const before = f.rows();
  f.faults.unavailable = true;
  assert.deepEqual(ready(await f.host.readResumeSession()), withdrawn);
  assert.deepEqual(f.rows(), before);
});

test('resume preserves legacy bytes and requires explicit restart', async (t) => {
  const f = await fixture(t, true, 8),
    before = f.rows();
  const resumed = ready(await f.host.readResumeSession());
  assert.equal(resumed?.resume, 'legacy_requires_restart');
  assert.deepEqual(resumed?.session, f.old);
  assert.deepEqual(f.rows(), before);
});

test('resume rejects a changed latest selection, owner retirement and close during verification', async (t) => {
  for (const change of ['newest', 'owner', 'close', 'adoption'] as const) {
    await t.test(change, async (t) => {
      const f = await fixture(t, false, 8);
      ready(await f.host.saveSession(f.input()));
      f.faults.beforeContent = async () => {
        if (change === 'newest') {
          const other = await createBundledRecipeRevision(catalogue.recipes[1]!.recipeId, sha256);
          ready(
            await f.create(8).saveSession(
              f.input({
                contentRef: clone(other.ref),
                passageSequence: other.document.recipe.instructions[0]!.sequence,
              }),
            ),
          );
        } else if (change === 'owner') f.setAccess(null);
        else if (change === 'close') f.host.close();
        else await f.adopt('first');
      };
      failed(await f.host.readResumeSession());
    });
  }
});

test('future session clocks cannot be exposed by direct or resume reads', async (t) => {
  const f = await fixture(t, false, 8),
    input = f.input();
  ready(await f.host.saveSession(input));
  f.write.database.exec('UPDATE cooking_state SET session_revision=0');
  failed(await f.host.readSession(input.contentRef.recipeId));
  failed(await f.host.readResumeSession());
});

test('session clock admission rejects oversized TEXT and BLOB before bridge transfer across every port', async (t) => {
  for (const field of ['history_revision', 'history_epoch', 'session_revision', 'store'] as const) {
    for (const kind of ['text', 'blob'] as const) {
      await t.test(`${field} ${kind}`, async (t) => {
        const f = await fixture(t, false, 8),
          input = f.input();
        const saved = ready(await f.host.saveSession(input));
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
                  value.length > 8192
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
          await f.host.readResumeSession(),
          await f.host.readSession(input.contentRef.recipeId),
          await f.host.saveSession(input),
          await f.host.recover({ kind: 'save', input }),
          await f.host.dismissSession({
            operationId: randomUUID(),
            recipeId: input.contentRef.recipeId,
            sessionId: saved.session.sessionId,
            expectedRevision: saved.session.revision,
          }),
        ])
          failed(result);
        assert.equal(oversizedTransfers, 0);
        assert.equal(f.count('content_cooking_session_operation'), 1);
      });
    }
  }
});

test('session workspace clocks reject large SQL values before direct or resume reads and new changes', async (t) => {
  for (const field of ['adoption', 'restore'] as const)
    for (const kind of ['text', 'blob'] as const) {
      await t.test(`${field} ${kind}`, async (t) => {
        const f = await fixture(t, false, 8),
          input = f.input();
        const saved = ready(await f.host.saveSession(input));
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
                  value.length > 8192
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
          await f.host.readSession(input.contentRef.recipeId),
          await f.host.readResumeSession(),
          await f.host.saveSession(f.input({ expectedRevision: saved.session.revision })),
          await f.host.dismissSession({
            operationId: randomUUID(),
            recipeId: input.contentRef.recipeId,
            sessionId: saved.session.sessionId,
            expectedRevision: saved.session.revision,
          }),
        ])
          failed(result);
        assert.deepEqual(ready(await f.host.recover({ kind: 'save', input })), saved);
        assert.deepEqual(ready(await f.host.saveSession(input)), saved);
        assert.equal(oversizedTransfers, 0);
        assert.equal(f.count('content_cooking_session_operation'), 1);
      });
    }
});
