import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import type {
  AdminDraft,
  AdminLibrary,
  AdminPublicationPreparation,
  AdminPublicationIssueReceipt,
  AdminPublicationReleaseState,
} from '../src/contracts';
import { openAdminDatabase, type Actor } from '../src/storage/database';
import { PreparedPublicationArchive } from '../src/publishing/archive';
import {
  readLibraryLifecycle,
  libraryItemStatus,
  type LibraryLifecycle,
} from '../src/drafts/libraryStatus';
import { DraftRepository } from '../src/drafts/repository';
import { fixture, type Client } from './helpers';
import { archiveSelection } from '../web/archiveSelection';
import { prepareArchiveIssuanceProposal } from '../web/issuanceProposal';

async function reviewed(t: TestContext) {
  const pair = generateKeyPairSync('ed25519');
  const key = pair.publicKey.export({ format: 'jwk' });
  const f = await fixture(t, (directory) => ({
    publication: {
      issuedDatabaseFile: join(directory, 'issued.sqlite'),
      signingKeyId: 'library-fixture',
      signingPrivateKey: pair.privateKey,
      trustedKeys: [
        {
          keyId: 'library-fixture',
          publicKeyHex: Buffer.from(key.x!, 'base64url').toString('hex'),
        },
      ],
    },
  }));
  const client = f.client();
  await client.login();
  const recipeId = catalogue.recipes
    .map((recipe) => recipe.recipeId)
    .sort()
    .at(-1)!;
  let draft = (await client.create('library-create', recipeId)).draft;
  for (const scope of ['recipe_text', 'photo', ...(draft.input.videoUrl ? ['video_embed'] : [])]) {
    const response = await client.request('POST', `/admin/api/drafts/${draft.draftId}/rights`, {
      operationId: `library-rights-${scope}`,
      expectedRevision: draft.revision,
      scope,
      status: 'permitted',
      statement: 'Synthetic fixture only; not actual permission.',
      sourceUrl: null,
    });
    assert.equal(response.statusCode, 200, response.body);
    draft = response.json().draft;
  }
  const saved = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
    operationId: 'library-summary',
    expectedRevision: draft.revision,
    input: { ...draft.input, changeSummary: 'Synthetic library fixture only.' },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  draft = saved.json().draft;
  const approval = await client.request('POST', `/admin/api/drafts/${draft.draftId}/reviews`, {
    operationId: 'library-review',
    expectedRevision: draft.revision,
    decision: 'approved',
    note: 'Synthetic fixture only.',
  });
  assert.equal(approval.statusCode, 200, approval.body);
  draft = approval.json().draft;
  return { f, client, draft };
}
async function prepare(client: Client, draft: AdminDraft): Promise<AdminPublicationPreparation> {
  const response = await client.request(
    'POST',
    `/admin/api/drafts/${draft.draftId}/publication-preparation`,
    { expectedRevision: draft.revision },
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function library(client: Client, status = 'all', cursor?: string): Promise<AdminLibrary> {
  const response = await client.request(
    'GET',
    `/admin/api/library?status=${status}${cursor ? `&cursor=${cursor}` : ''}`,
  );
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test('exact prepared revision and every authorized package drive signed facets before paging; roles stay read-only', async (t) => {
  const { f, client, draft } = await reviewed(t);
  const before = await library(client, 'bundled');
  assert.ok(before.nextCursor);
  const prepared = await prepare(client, draft);
  assert.equal(
    (await client.request('GET', `/admin/api/library?status=bundled&cursor=${before.nextCursor}`))
      .statusCode,
    409,
  );
  const reviewer = f.client();
  await reviewer.login('fixture-reviewer');
  const second = await prepare(reviewer, draft);
  assert.notEqual(second.revisionId, prepared.revisionId);
  const preparedRows = await library(client, 'prepared');
  assert.equal(preparedRows.items.length, 1); // 100 lower/unrelated catalogue rows do not consume page slots.
  assert.deepEqual(preparedRows.items[0]!.preparation, {
    draftRevision: draft.revision,
    packageCount: 2,
  });
  const cursor = (await library(client, 'bundled')).nextCursor!;
  const entries = [
    {
      state: 'current' as const,
      ref: {
        recipeId: prepared.recipeId,
        revisionId: prepared.revisionId,
        contentFingerprint: prepared.contentFingerprint,
      },
      publicationFingerprint: prepared.publicationFingerprint,
    },
  ];
  const issued = await client.request('POST', '/admin/api/publication/releases', {
    operationId: 'library-issue',
    expectedHead: null,
    entries,
  });
  assert.equal(issued.statusCode, 200, issued.body);
  const receipt = issued.json() as AdminPublicationIssueReceipt;
  assert.equal(
    (await client.request('GET', `/admin/api/library?status=bundled&cursor=${cursor}`)).statusCode,
    409,
  );
  const published = await library(client, 'published');
  assert.equal(published.items.length, 1);
  assert.equal(published.items[0]!.draftId, draft.draftId);
  assert.equal(published.items[0]!.publication!.matchingDraftRevision, draft.revision);
  const editor = f.client();
  await editor.login('fixture-editor');
  assert.deepEqual((await library(editor, 'published')).items, published.items);
  assert.deepEqual((await library(reviewer, 'published')).items, published.items);
  assert.equal(
    (await editor.request('GET', '/admin/api/publication/releases/current')).statusCode,
    403,
  );
  assert.equal(
    (
      await editor.request('POST', '/admin/api/publication/releases', {
        operationId: 'forbidden',
        expectedHead: null,
        entries,
      })
    ).statusCode,
    403,
  );
  await client.create('unrelated-same-recipe', draft.recipeId);
  const changed = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
    operationId: 'newer-draft',
    expectedRevision: draft.revision,
    input: {
      ...draft.input,
      title: `${draft.input.title} revised`,
      changeSummary: 'Synthetic newer draft.',
    },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await library(client, 'prepared')).items.length, 0);
  const olderPage = await library(client, 'published');
  const olderPublication = olderPage.items;
  assert.equal(olderPublication.length, 1);
  assert.equal(olderPublication[0]!.revision, draft.revision + 1);
  assert.equal(olderPublication[0]!.publication!.matchingDraftRevision, draft.revision);
  const selected = archiveSelection(olderPublication[0]!, olderPage.publicationStatus);
  assert.ok(selected);
  const currentRelease = await client.request('GET', '/admin/api/publication/releases/current');
  assert.equal(currentRelease.statusCode, 200);
  const archiveRequest = await prepareArchiveIssuanceProposal(
    currentRelease.json() as AdminPublicationReleaseState,
    selected,
    'Synthetic archive fixture.',
    'library-archive',
  );
  assert.equal(archiveRequest.expectedHead?.fingerprint, receipt.envelope.fingerprint);
  const archived = await client.request('POST', '/admin/api/publication/releases', archiveRequest);
  assert.equal(archived.statusCode, 200, archived.body);
  assert.equal((await library(client, 'published')).items.length, 0);
  assert.equal(
    (await library(client, 'archived')).items[0]!.publication!.matchingDraftRevision,
    draft.revision,
  );
  await f.reopen();
  assert.equal((await library(client, 'archived')).items.length, 1);
});

test('unconfigured status remains explicit while ordinary draft reads work', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  await client.login();
  await client.create();
  assert.deepEqual((await library(client, 'draft')).publicationStatus, {
    status: 'not_configured',
  });
  for (const status of ['published', 'archived']) {
    const response = await client.request('GET', `/admin/api/library?status=${status}`);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'publication_not_configured');
  }
});

function actorFrom(db: ReturnType<typeof openAdminDatabase>): Actor {
  const user = db.userById('fixture-admin')!;
  const session = db.get<{ session_id: string }>(
    "SELECT session_id FROM admin_session WHERE json_extract(data,'$.userId')=?",
    user.userId,
  )!;
  return {
    user: { userId: user.userId, username: user.username, role: user.role },
    authEpoch: user.authEpoch,
    sessionId: session.session_id,
  };
}
test('library awaits reject concurrent library edits and revoked read authority', async (t) => {
  let db: ReturnType<typeof openAdminDatabase> | undefined;
  t.after(() => db?.close());
  const f = await fixture(t);
  const client = f.client();
  await client.login();
  db = openAdminDatabase(f.filename);
  const actor = actorFrom(db);
  const archive = {
    async librarySummaries() {
      return [];
    },
  } as unknown as PreparedPublicationArchive;
  const options = { db, actor, now: () => new Date(), archive, issuer: null };
  const reading = readLibraryLifecycle(options);
  db.run('UPDATE admin_meta SET library_revision=library_revision+1');
  await assert.rejects(reading, { code: 'library_changed' });
  const revoked = readLibraryLifecycle(options);
  db.run('UPDATE admin_user SET enabled=0 WHERE user_id=?', actor.user.userId);
  await assert.rejects(revoked, { statusCode: 401 });
});

test('preparation summary admission rejects excessive count, bytes and wrong SQLite type before loading bodies', async (t) => {
  let db: ReturnType<typeof openAdminDatabase> | undefined;
  t.after(() => db?.close());
  const f = await fixture(t);
  const client = f.client();
  await client.login();
  db = openAdminDatabase(f.filename);
  const archive = new PreparedPublicationArchive(db, {} as never, () => new Date());
  const actor = actorFrom(db);
  const get = db.get.bind(db);
  let bodyReads = 0;
  t.mock.method(db, 'get', (sql: string, ...values: SQLInputValue[]) => {
    if (sql.includes('AS result_bytes')) bodyReads++;
    return get(sql, ...values);
  });
  db.transaction(() => {
    for (let index = 0; index < 1001; index++)
      db!.run(
        'INSERT INTO admin_operation VALUES(?,?,?,?,?)',
        `cap-${index}`,
        actor.user.userId,
        'prepare_publication',
        'a'.repeat(64),
        '{}',
      );
  });
  await assert.rejects(archive.librarySummaries(actor), { code: 'library_preparation_limit' });
  db.run("DELETE FROM admin_operation WHERE kind='prepare_publication'");
  db.run(
    'INSERT INTO admin_operation VALUES(?,?,?,?,?)',
    'blob',
    actor.user.userId,
    'prepare_publication',
    'a'.repeat(64),
    Buffer.from('{}'),
  );
  await assert.rejects(archive.librarySummaries(actor), { code: 'preparation_integrity' });
  db.run("DELETE FROM admin_operation WHERE kind='prepare_publication'");
  db.run(
    'INSERT INTO admin_operation VALUES(?,?,?,?,?)',
    'large',
    actor.user.userId,
    'prepare_publication',
    'a'.repeat(64),
    ' '.repeat(3 * 1024 * 1024 + 1),
  );
  await assert.rejects(archive.librarySummaries(actor), { code: 'preparation_integrity' });
  db.run("DELETE FROM admin_operation WHERE kind='prepare_publication'");
  db.run(
    'INSERT INTO admin_operation VALUES(?,?,?,?,?)',
    'scalar',
    actor.user.userId,
    'prepare_publication',
    'a'.repeat(1024 * 1024),
    '{}',
  );
  await assert.rejects(archive.librarySummaries(actor), { code: 'preparation_integrity' });
  assert.equal(bodyReads, 0);
});

test('identity-pointer scalar bounds apply before SQLite returns an oversized stored fingerprint', async (t) => {
  let db: ReturnType<typeof openAdminDatabase> | undefined;
  t.after(() => db?.close());
  const { f, client, draft } = await reviewed(t);
  await prepare(client, draft);
  db = openAdminDatabase(f.filename);
  db.run(
    "UPDATE admin_operation SET fingerprint=? WHERE kind='prepare_publication_identity'",
    'b'.repeat(1024 * 1024),
  );
  const get = db.get.bind(db);
  const pointerFields: unknown[] = [];
  t.mock.method(db, 'get', (sql: string, ...values: SQLInputValue[]) => {
    const result = get(sql, ...values);
    if (
      sql.includes('AS result_bytes') &&
      String(values.at(-1)).startsWith('prepare-publication:identity:')
    ) {
      pointerFields.push((result as { fingerprint?: unknown })?.fingerprint);
    }
    return result;
  });
  const archive = new PreparedPublicationArchive(db, {} as never, () => new Date());
  await assert.rejects(archive.librarySummaries(actorFrom(db)), { code: 'preparation_integrity' });
  assert.deepEqual(pointerFields, [null]); // The megabyte scalar never crosses the SQL/JS boundary.
});

test('full immutable references must match; status filtering precedes bounded pagination', async (t) => {
  let db: ReturnType<typeof openAdminDatabase> | undefined;
  t.after(() => db?.close());
  const f = await fixture(t);
  const client = f.client();
  await client.login();
  db = openAdminDatabase(f.filename);
  const draft = (await client.create()).draft;
  const ref = {
    recipeId: draft.recipeId,
    revisionId: 'fixture-ref',
    contentFingerprint: 'a'.repeat(64),
  };
  const lifecycle: LibraryLifecycle = {
    revision: 1,
    publicationStatus: {
      status: 'ready',
      head: { releaseId: 'fixture-head', sequence: 1, fingerprint: 'b'.repeat(64) },
    },
    preparationByDraft: new Map([
      [
        draft.draftId,
        [{ draftId: draft.draftId, draftRevision: 1, ref, publicationFingerprint: 'c'.repeat(64) }],
      ],
    ]),
    entryByRecipe: new Map([
      [
        draft.recipeId,
        {
          state: 'current',
          ref: { ...ref, contentFingerprint: 'd'.repeat(64) },
          publicationFingerprint: 'c'.repeat(64),
        },
      ],
    ]),
    bundledMatches: new Set(),
    assertCurrent() {},
  };
  const repo = new DraftRepository(db, () => new Date());
  assert.equal(repo.library('', 'published', null, lifecycle).items.length, 0);
  lifecycle.entryByRecipe.set(draft.recipeId, {
    state: 'current',
    ref,
    publicationFingerprint: 'c'.repeat(64),
  });
  assert.equal(repo.library('', 'published', null, lifecycle).items.length, 1);
  assert.equal(repo.library('', 'prepared', null, lifecycle).items.length, 1);
  const item = repo.library('', 'prepared', null, lifecycle).items[0]!;
  lifecycle.entryByRecipe.set(draft.recipeId, {
    state: 'withdrawn',
    recipeId: draft.recipeId,
    reason: 'Synthetic withdrawal fixture.',
  });
  assert.equal(libraryItemStatus(item, lifecycle).publication!.state, 'withdrawn');
});
