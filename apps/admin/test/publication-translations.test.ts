import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { canonicalContentJson, type OverlayEntry } from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import type {
  AdminDraft,
  AdminPublicationPreparation,
  AdminPublicationTranslationSelection,
} from '../src/contracts';
import { AdminFault } from '../src/auth/errors';
import { openAdminDatabase, type Actor } from '../src/storage/database';
import { DraftRepository, sha256 } from '../src/drafts/repository';
import { AdminMedia } from '../src/media/service';
import { TranslationRepository } from '../src/translations/repository';
import type { AdminTranslation, AdminTranslationInput } from '../src/translations/contracts';
import { PreparedPublicationArchive } from '../src/publishing/archive';
import { createContentOverlaySigner } from '../src/publishing/signer';
import { ContentOverlayIssuer } from '../src/publishing/issuance';
import { IssuedOverlayStore } from '../src/publishing/issuedStore';
import { captureIssuedDelivery, verifyIssuedDelivery } from '../src/publishing/delivery';
import { ownTranslationSelections } from '../src/publishing/translationSelection';
import { fixture as serverFixture } from './helpers';

const fault = (code: string) => (error: unknown) =>
  error instanceof AdminFault && error.code === code;
const translated = (draft: AdminDraft): AdminTranslationInput => ({
  title: 'وصفة عربية تجريبية',
  description: 'نص مترجم\n\nمحفوظ كما هو',
  category: 'طبق',
  cuisine: 'مطبخ',
  rawTags: null,
  ingredients: draft.input.ingredients.map((_, index) => ({ rawName: `مكوّن ${index + 1}` })),
  instructions: draft.input.instructions.map((_, index) => ({
    rawText: `مقطع ${index + 1}\nسطر آخر`,
  })),
  changeSummary: 'Synthetic translation fixture; no independent linguistic or rights claim.',
  attribution: 'machine',
});
const selection = (record: AdminTranslation): AdminPublicationTranslationSelection => ({
  translationId: record.translationId,
  translationRevision: record.revision,
  rights: {
    statement: 'Synthetic explicit translated-text rights assertion only.',
    sourceUrl: 'https://example.test/translation-rights',
    acknowledge: true,
  },
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-translated-publication-'));
  const filename = join(directory, 'admin.sqlite'),
    issuedFile = join(directory, 'issued.sqlite');
  let db = openAdminDatabase(filename),
    time = Date.parse('2026-10-02T00:00:00.000Z');
  const now = () => new Date(time);
  db.createFirstAdministrator({
    userId: 'fixture-admin',
    username: 'fixture.admin',
    passwordHash: '$argon2id$fixture-unused',
  });
  const actor: Actor = {
    user: { userId: 'fixture-admin', username: 'fixture.admin', role: 'administrator' },
    authEpoch: 1,
    sessionId: 'fixture-session',
  };
  db.run(
    'INSERT INTO admin_session VALUES(?,?,?)',
    actor.sessionId,
    JSON.stringify({
      userId: actor.user.userId,
      authEpoch: 1,
      recentAuthAt: time,
      absoluteExpiresAt: time + 86_400_000,
    }),
    time + 86_400_000,
  );
  let drafts = new DraftRepository(db, now),
    translations = new TranslationRepository(db, now);
  let draft = (await drafts.create(actor, 'fixture-create', catalogue.recipes[0]!.recipeId)).draft;
  draft = drafts.mutate(actor, draft.draftId, 'fixture-save', draft.revision, {
    kind: 'save',
    input: { ...draft.input, changeSummary: 'Synthetic approved original.' },
  }).draft;
  for (const scope of [
    'recipe_text',
    'photo',
    ...(draft.input.videoUrl ? (['video_embed'] as const) : []),
  ] as const) {
    draft = drafts.mutate(actor, draft.draftId, `rights-${scope}`, draft.revision, {
      kind: 'rights',
      input: {
        scope,
        status: 'permitted',
        statement: 'Synthetic original rights assertion.',
        sourceUrl: null,
      },
    }).draft;
  }
  draft = drafts.mutate(actor, draft.draftId, 'fixture-review', draft.revision, {
    kind: 'review',
    decision: 'approved',
    note: 'Synthetic original approval.',
  }).draft;
  let record = translations.create(actor, draft.draftId, {
    operationId: 'translation-create',
    sourceRevision: draft.revision,
    originalLanguage: 'en',
    targetLanguage: 'ar',
    input: translated(draft),
  }).translation;
  record = translations.mutate(actor, record.translationId, 'translation-review', record.revision, {
    kind: 'review',
    decision: 'approved',
    note: 'Synthetic human-review acknowledgement.',
    acknowledgeHumanReview: true,
  }).translation;
  const originalDraft = canonicalContentJson(draft);
  const signer = createContentOverlaySigner({
    keyId: 'fixture-key',
    privateKey: generateKeyPairSync('ed25519').privateKey,
  });
  const trust = createContentTrustVerifier([signer.trustKey]);
  let issued = new IssuedOverlayStore(issuedFile, trust);
  const media = () =>
    new AdminMedia(
      db,
      drafts,
      join(directory, 'media'),
      fileURLToPath(new URL('../../../packages/catalogue/assets/photos/', import.meta.url)),
      now,
    );
  const archive = (port: Pick<AdminMedia, 'asset' | 'baseline'> = media()) =>
    new PreparedPublicationArchive(db, port, now);
  const request = () => ({
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    revisionId: 'translated-fixture-v1',
    translations: [selection(record)],
  });
  const issuer = (overrides: Partial<ConstructorParameters<typeof ContentOverlayIssuer>[0]> = {}) =>
    new ContentOverlayIssuer({
      db,
      prepared: archive(),
      issued,
      media: media(),
      signer,
      trustVerifier: trust,
      now,
      ...overrides,
    });
  const mutate = (patch: Partial<AdminTranslationInput> = { title: 'تعديل جديد' }) => {
    record = translations.mutate(
      actor,
      record.translationId,
      `translation-edit-${record.revision}`,
      record.revision,
      { kind: 'save', input: { ...record.input, ...patch } },
    ).translation;
  };
  t.after(async () => {
    issued.close();
    db.close();
    const target = resolve(directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('cookmate-translated-publication-')
    )
      throw new Error('Fixture cleanup escaped boundary.');
    await rm(target, { recursive: true, force: true });
  });
  return {
    actor,
    now,
    request,
    media,
    archive,
    issuer,
    signer,
    trust,
    originalDraft,
    mutate,
    issuedFile,
    get db() {
      return db;
    },
    get draft() {
      return draft;
    },
    get record() {
      return record;
    },
    get issued() {
      return issued;
    },
    approveTranslation() {
      record = translations.mutate(
        actor,
        record.translationId,
        `translation-approve-${record.revision}`,
        record.revision,
        {
          kind: 'review',
          decision: 'approved',
          note: 'Synthetic renewed acknowledgement.',
          acknowledgeHumanReview: true,
        },
      ).translation;
    },
    approveOriginal() {
      for (const scope of [
        'recipe_text',
        'photo',
        ...(draft.input.videoUrl ? (['video_embed'] as const) : []),
      ] as const) {
        draft = drafts.mutate(
          actor,
          draft.draftId,
          `renewed-rights-${scope}-${draft.revision}`,
          draft.revision,
          {
            kind: 'rights',
            input: {
              scope,
              status: 'permitted',
              statement: 'Synthetic renewed original rights.',
              sourceUrl: null,
            },
          },
        ).draft;
      }
      draft = drafts.mutate(
        actor,
        draft.draftId,
        `renewed-review-${draft.revision}`,
        draft.revision,
        { kind: 'review', decision: 'approved', note: 'Synthetic renewed original approval.' },
      ).draft;
    },
    anotherTranslation() {
      const value = translations.create(actor, draft.draftId, {
        operationId: 'translation-create-fr',
        sourceRevision: draft.revision,
        originalLanguage: 'en',
        targetLanguage: 'fr',
        input: { ...translated(draft), title: 'Traduction de test' },
      }).translation;
      return translations.mutate(
        actor,
        value.translationId,
        'translation-review-fr',
        value.revision,
        {
          kind: 'review',
          decision: 'approved',
          note: 'Synthetic second language acknowledgement.',
          acknowledgeHumanReview: true,
        },
      ).translation;
    },
    editOriginal() {
      draft = drafts.mutate(
        actor,
        draft.draftId,
        `original-edit-${draft.revision}`,
        draft.revision,
        { kind: 'save', input: { ...draft.input, title: 'Changed original' } },
      ).draft;
    },
    advance(ms: number) {
      time += ms;
    },
    reopen() {
      issued.close();
      db.close();
      db = openAdminDatabase(filename);
      drafts = new DraftRepository(db, now);
      translations = new TranslationRepository(db, now);
      issued = new IssuedOverlayStore(issuedFile, trust);
    },
    count() {
      return db.get<{ count: number }>(
        "SELECT COUNT(*) count FROM admin_operation WHERE kind='prepare_publication'",
      )!.count;
    },
  };
}
function member(receipt: Awaited<ReturnType<PreparedPublicationArchive['prepare']>>): OverlayEntry {
  return {
    state: 'current',
    ref: { ...receipt.publication.revision.ref },
    publicationFingerprint: receipt.publication.publicationFingerprint,
  };
}

test('V3 preparation retains exact translations, explicit rights and unchanged original content across reopen', async (t) => {
  const f = await fixture(t),
    request = f.request();
  const result = await f.archive().prepare(f.actor, 'translated-prepare', request);
  assert.equal(result.archiveVersion, 2);
  assert.equal(result.publication.formatVersion, 3);
  if (result.publication.formatVersion !== 3) assert.fail('Expected translated publication');
  const copy = result.publication.translations[0]!;
  assert.equal(copy.content.title, f.record.input.title);
  assert.equal(copy.content.instructions[0]!.rawText, f.record.input.instructions[0]!.rawText);
  assert.equal(copy.machineAssisted, true);
  assert.equal(copy.review.evidence, 'operator_acknowledgement');
  assert.equal(copy.permission.subject.scope, 'translated_recipe_text');
  assert.equal(copy.permission.statement, request.translations[0]!.rights.statement);
  assert.equal(copy.permission.review.reviewerId, f.actor.user.userId);
  assert.deepEqual(copy.sourceRef, result.publication.revision.ref);
  assert.deepEqual(
    result.publication.revision.document.recipe.ingredients.map(({ rawName, rawMeasure }) => ({
      rawName,
      rawMeasure,
    })),
    f.draft.input.ingredients,
  );
  assert.equal(canonicalContentJson(f.draft), f.originalDraft);
  assert.ok(Object.isFrozen(copy.content.instructions));
  f.reopen();
  assert.deepEqual(await f.archive().receipt(f.actor, 'translated-prepare'), result);
});

test('old receipt grammar is unchanged; translated retry recovers its original operation after edits and recent-auth expiry', async (t) => {
  const f = await fixture(t),
    { translations: _translations, ...original } = f.request();
  const old = await f
    .archive()
    .prepare(f.actor, 'old-prepare', { ...original, revisionId: 'old-fixture' });
  assert.equal(old.archiveVersion, 1);
  assert.equal(old.publication.formatVersion, 2);
  assert.equal('translationEvidence' in old, false);
  const request = f.request(),
    result = await f.archive().prepare(f.actor, 'translated-prepare', request);
  f.mutate();
  f.editOriginal();
  f.advance(16 * 60 * 1000);
  assert.deepEqual(await f.archive().prepare(f.actor, 'translated-prepare', request), result);
  assert.deepEqual(await f.archive().receipt(f.actor, 'old-prepare'), old);
  assert.deepEqual(await f.archive().retainedPreparations(f.actor, request.draftId), [
    {
      operationId: 'old-prepare',
      draftRevision: original.expectedRevision,
      revisionId: 'old-fixture',
      translations: [],
    },
    {
      operationId: 'translated-prepare',
      draftRevision: request.expectedRevision,
      revisionId: request.revisionId,
      translations: [
        {
          translationId: request.translations[0]!.translationId,
          translationRevision: request.translations[0]!.translationRevision,
          targetLanguage: 'ar',
        },
      ],
    },
  ]);
  await assert.rejects(
    f.archive().prepare(f.actor, 'fresh-expired', { ...request, revisionId: 'fresh-expired' }),
    fault('reauth_required'),
  );
});

test('selection owns data without getters and rejects missing rights, duplicates and changed requests', async (t) => {
  const f = await fixture(t),
    request = f.request();
  let getter = false;
  assert.throws(() =>
    ownTranslationSelections([
      {
        get translationId() {
          getter = true;
          return f.record.translationId;
        },
        translationRevision: f.record.revision,
        rights: request.translations[0]!.rights,
      },
    ]),
  );
  assert.equal(getter, false);
  for (const value of [
    [],
    [request.translations[0], request.translations[0]],
    [
      {
        ...request.translations[0],
        rights: { ...request.translations[0]!.rights, acknowledge: false },
      },
    ],
    [
      {
        ...request.translations[0],
        rights: { ...request.translations[0]!.rights, sourceUrl: 'https://secret@example.test/' },
      },
    ],
  ])
    assert.throws(() => ownTranslationSelections(value));
  await f.archive().prepare(f.actor, 'exact-request', request);
  await assert.rejects(
    f.archive().prepare(f.actor, 'exact-request', {
      ...request,
      translations: [
        {
          ...request.translations[0]!,
          rights: {
            ...request.translations[0]!.rights,
            statement: 'Different explicit assertion',
          },
        },
      ],
    }),
    fault('operation_conflict'),
  );
  assert.equal(f.count(), 1);
});

test('old reviewed selection, unreviewed edits and an approved translation on another original revision cannot prepare', async (t) => {
  const f = await fixture(t),
    old = f.request();
  f.mutate();
  await assert.rejects(
    f.archive().prepare(f.actor, 'old-selection', old),
    fault('translation_revision_conflict'),
  );
  await assert.rejects(
    f.archive().prepare(f.actor, 'unreviewed', f.request()),
    fault('translation_approval_required'),
  );
  f.approveTranslation();
  // Keep the original request revision: a source edit is not an implicit rebase.
  f.editOriginal();
  await assert.rejects(
    f
      .archive()
      .prepare(f.actor, 'stale-source', { ...f.request(), expectedRevision: old.expectedRevision }),
    fault('revision_conflict'),
  );
  f.approveOriginal();
  await assert.rejects(
    f.archive().prepare(f.actor, 'stale-translation-source', f.request()),
    fault('translation_source_stale'),
  );
  assert.equal(f.count(), 0);
});

test('selected order and rights are owned before asynchronous work, without reordering exact translations', async (t) => {
  const f = await fixture(t),
    other = f.anotherTranslation();
  const request = { ...f.request(), translations: [selection(other), selection(f.record)] };
  const selected = canonicalContentJson(request.translations);
  const pending = f.archive().prepare(f.actor, 'two-translations', request);
  request.translations.reverse();
  request.translations[0]!.rights.statement =
    'Mutation after dispatch is not the reviewed request.';
  const receipt = await pending;
  assert.equal(canonicalContentJson(receipt.request.translations), selected);
  assert.equal(receipt.publication.formatVersion, 3);
  if (receipt.publication.formatVersion !== 3) assert.fail('Expected translated publication');
  assert.deepEqual(
    receipt.publication.translations.map((value) => value.targetLanguage),
    ['fr', 'ar'],
  );
  assert.equal(
    receipt.publication.translations[1]!.permission.statement,
    selection(f.record).rights.statement,
  );
});

for (const change of ['translation', 'source'] as const)
  test(`preparation rechecks ${change} after asynchronous media inspection`, async (t) => {
    const f = await fixture(t),
      media = f.media(),
      request = f.request();
    const archive = f.archive({
      asset: media.asset.bind(media),
      async baseline(id) {
        const result = await media.baseline(id);
        if (change === 'translation') f.mutate();
        else f.editOriginal();
        return result;
      },
    });
    await assert.rejects(
      archive.prepare(f.actor, 'changed-during-media', request),
      fault(change === 'translation' ? 'translation_revision_conflict' : 'revision_conflict'),
    );
    assert.equal(f.count(), 0);
  });

test('archive commit rechecks selection after successful preparation without leaving either operation row', async (t) => {
  const f = await fixture(t),
    request = f.request(),
    transaction = f.db.transaction.bind(f.db);
  let count = 0,
    armed = true;
  f.db.transaction = function <Value>(work: () => Value): Value {
    if (armed && ++count === 3) {
      armed = false;
      f.mutate();
    }
    return transaction(work);
  };
  await assert.rejects(
    f.archive().prepare(f.actor, 'changed-at-commit', request),
    fault('translation_revision_conflict'),
  );
  assert.equal(armed, false);
  assert.equal(f.count(), 0);
  assert.equal(
    f.db.get<{ count: number }>(
      "SELECT COUNT(*) count FROM admin_operation WHERE kind='prepare_publication_identity'",
    )!.count,
    0,
  );
});

test('publication bounds reject larger editor text without truncating saved translation', async (t) => {
  const f = await fixture(t);
  f.mutate({ description: 'x'.repeat(4001) });
  f.approveTranslation();
  await assert.rejects(
    f.archive().prepare(f.actor, 'too-large-translation', f.request()),
    fault('translation_publication_blocked'),
  );
  assert.equal(f.record.input.description?.length, 4001);
  assert.equal(f.count(), 0);
});

test('signed V2→V3→archived→withdrawn release chain retains reader minimum and original recovery', async (t) => {
  const f = await fixture(t),
    request = f.request(),
    { translations: _translations, ...oldRequest } = request;
  const old = await f
    .archive()
    .prepare(f.actor, 'prepare-original', { ...oldRequest, revisionId: 'original-no-translation' });
  const first = await f
    .issuer()
    .issue(f.actor, 'issue-original', { expectedHead: null, entries: [member(old)] });
  assert.equal(first.envelope.manifest.minimumReaderVersion, 1);
  const translated = await f.archive().prepare(f.actor, 'prepare-translated', request);
  const secondRequest = { expectedHead: f.issued.head(), entries: [member(translated)] };
  const second = await f.issuer().issue(f.actor, 'issue-translated', secondRequest);
  assert.equal(second.envelope.manifest.minimumReaderVersion, 2);
  const translatedPackage = await f
    .issuer()
    .exportPackage(f.actor, second.envelope.manifest.releaseId);
  assert.equal(translatedPackage.publications[0]!.formatVersion, 3);
  f.mutate(); // Existing signed history remains usable after later editorial work.
  assert.deepEqual(await f.issuer().issue(f.actor, 'issue-translated', secondRequest), second);
  const archived = await f.issuer().issue(f.actor, 'archive-translated', {
    expectedHead: f.issued.head(),
    entries: [
      {
        state: 'archived',
        ref: translated.publication.revision.ref,
        publicationFingerprint: translated.publication.publicationFingerprint,
        reason: 'Synthetic archival review.',
      },
    ],
  });
  assert.equal(archived.envelope.manifest.minimumReaderVersion, 2);
  const exported = await f.issuer().exportPackage(f.actor, archived.envelope.manifest.releaseId);
  assert.deepEqual(exported.publications, []);
  assert.equal(exported.envelope.manifest.minimumReaderVersion, 2);
  const withdrawn = await f.issuer().issue(f.actor, 'withdraw-translated', {
    expectedHead: f.issued.head(),
    entries: [{ state: 'withdrawn', recipeId: f.draft.recipeId, reason: 'Synthetic withdrawal.' }],
  });
  assert.equal(withdrawn.envelope.manifest.minimumReaderVersion, 2);
  f.reopen();
  assert.deepEqual(
    await f.issuer().recover(f.actor, 'issue-original', first.requestFingerprint),
    first,
  );
  assert.deepEqual(
    await f.issuer().exportPackage(f.actor, archived.envelope.manifest.releaseId),
    exported,
  );
  assert.deepEqual(
    await f.issuer().exportPackage(f.actor, second.envelope.manifest.releaseId),
    translatedPackage,
  );
});

test('issuer rechecks selected translation after signing and leaves no signed result on loss of approval', async (t) => {
  const f = await fixture(t),
    prepared = await f.archive().prepare(f.actor, 'prepare-translated', f.request());
  const signer = {
    ...f.signer,
    async signManifest(input: Parameters<typeof f.signer.signManifest>[0]) {
      const value = await f.signer.signManifest(input);
      f.mutate();
      return value;
    },
  };
  await assert.rejects(
    f
      .issuer({ signer })
      .issue(f.actor, 'issue-stale', { expectedHead: null, entries: [member(prepared)] }),
    fault('translation_revision_conflict'),
  );
  assert.equal(f.issued.head(), null);
  assert.deepEqual(await f.archive().receipt(f.actor, 'prepare-translated'), prepared);
});

test('retained delivery and publication reads reject a valid signature with an invalid translation reader minimum', async (t) => {
  const f = await fixture(t),
    prepared = await f.archive().prepare(f.actor, 'prepare-translated', f.request());
  const receipt = await f
    .issuer()
    .issue(f.actor, 'issue-translated', { expectedHead: null, entries: [member(prepared)] });
  const lowered = await f.signer.signManifest({
    ...receipt.envelope.manifest,
    minimumReaderVersion: 1,
  });
  const sql = new DatabaseSync(f.issuedFile);
  try {
    const captured = captureIssuedDelivery(sql, receipt.envelope.manifest.releaseId);
    await assert.rejects(
      verifyIssuedDelivery({ ...captured, document: canonicalContentJson(lowered) }, f.trust),
      fault('issued_integrity'),
    );
    sql
      .prepare('UPDATE issued_release SET document=? WHERE id=?')
      .run(canonicalContentJson(lowered), lowered.manifest.releaseId);
    await assert.rejects(
      f.issued.readPublication(
        prepared.publication.revision.ref.recipeId,
        prepared.publication.revision.ref.revisionId,
      ),
      fault('issued_integrity'),
    );
  } finally {
    sql.close();
  }
});

test('retained package listing rejects oversized bodies before transfer and suppresses revoked-actor results', async (t) => {
  const f = await fixture(t);
  await f.archive().prepare(f.actor, 'prepare-translated', f.request());
  const pending = f.archive().retainedPreparations(f.actor, f.draft.draftId);
  queueMicrotask(() => f.db.run('DELETE FROM admin_session WHERE session_id=?', f.actor.sessionId));
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AdminFault && error.statusCode === 401,
  );
  // Restore only this synthetic fixture session, then corrupt the declared retained body.
  const at = f.now().getTime();
  f.db.run(
    'INSERT INTO admin_session VALUES(?,?,?)',
    f.actor.sessionId,
    JSON.stringify({
      userId: f.actor.user.userId,
      authEpoch: 1,
      recentAuthAt: at,
      absoluteExpiresAt: at + 86_400_000,
    }),
    at + 86_400_000,
  );
  f.db.run(
    "UPDATE admin_operation SET result=CAST(zeroblob(?) AS TEXT) WHERE operation_id='prepare-translated'",
    3 * 1024 * 1024 + 1,
  );
  const get = f.db.get.bind(f.db);
  let transferred = false;
  f.db.get = function <Row>(sql: string, ...values: SQLInputValue[]): Row | undefined {
    if (sql.includes('AS result')) transferred = true;
    return get<Row>(sql, ...values);
  };
  await assert.rejects(
    f.archive().retainedPreparations(f.actor, f.draft.draftId),
    fault('preparation_integrity'),
  );
  assert.equal(transferred, false);
});

test('HTTP exact-request recovery, actor-owned reload listing and legacy revision recovery stay separate', async (t) => {
  const f = await serverFixture(t),
    client = f.client();
  await client.login();
  let draft = (await client.create('http-translation-original', catalogue.recipes[0]!.recipeId))
    .draft;
  let seq = 0;
  const mutate = async (path: string, body: unknown) => {
    const response = await client.request(
      'POST',
      `/admin/api/drafts/${draft.draftId}/${path}`,
      body,
    );
    assert.equal(response.statusCode, 200, response.body);
    draft = response.json().draft as AdminDraft;
  };
  const saved = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
    operationId: 'http-save',
    expectedRevision: draft.revision,
    input: { ...draft.input, changeSummary: 'Synthetic HTTP translation fixture.' },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  draft = saved.json().draft as AdminDraft;
  for (const scope of ['recipe_text', 'photo', ...(draft.input.videoUrl ? ['video_embed'] : [])])
    await mutate('rights', {
      operationId: `http-rights-${++seq}`,
      expectedRevision: draft.revision,
      scope,
      status: 'permitted',
      statement: 'Synthetic original rights.',
      sourceUrl: null,
    });
  await mutate('reviews', {
    operationId: 'http-original-review',
    expectedRevision: draft.revision,
    decision: 'approved',
    note: 'Synthetic exact review.',
  });
  const creation = await client.request('POST', `/admin/api/drafts/${draft.draftId}/translations`, {
    operationId: 'http-translation-create',
    sourceRevision: draft.revision,
    originalLanguage: 'en',
    targetLanguage: 'ar',
    input: translated(draft),
  });
  assert.equal(creation.statusCode, 200, creation.body);
  let record = creation.json().translation as AdminTranslation;
  const approved = await client.request(
    'POST',
    `/admin/api/translations/${record.translationId}/reviews`,
    {
      operationId: 'http-translation-review',
      expectedRevision: record.revision,
      decision: 'approved',
      note: 'Synthetic operator acknowledgement.',
      acknowledgeHumanReview: true,
    },
  );
  assert.equal(approved.statusCode, 200, approved.body);
  record = approved.json().translation as AdminTranslation;
  const path = `/admin/api/drafts/${draft.draftId}/publication-preparation`,
    body = { expectedRevision: draft.revision, translations: [selection(record)] };
  const absent = await client.request('POST', `${path}/recovery`, body);
  assert.equal(absent.statusCode, 404);
  assert.deepEqual((await client.request('GET', `${path}?list=1`)).json(), { items: [] });
  const old = (
    await client.request('POST', path, { expectedRevision: draft.revision })
  ).json() as AdminPublicationPreparation;
  const legacyDigest = sha256(
    canonicalContentJson([
      'cookmate-admin-preparation-request-v1',
      ['fixture-admin', draft.draftId, draft.revision],
    ]),
  );
  assert.equal(old.operationId, `prepare-${legacyDigest}`);
  const result = await client.request('POST', path, body);
  assert.equal(result.statusCode, 200, result.body);
  const receipt = result.json() as AdminPublicationPreparation;
  assert.match(receipt.operationId, /^prepare-v2-[a-f0-9]{64}$/);
  assert.match(receipt.revisionId, /^authored-v2-/);
  assert.deepEqual((await client.request('POST', `${path}/recovery`, body)).json(), receipt);
  const changed = {
    ...body,
    translations: [
      {
        ...body.translations[0]!,
        rights: {
          ...body.translations[0]!.rights,
          statement: 'Another explicit permission statement.',
        },
      },
    ],
  };
  assert.equal((await client.request('POST', `${path}/recovery`, changed)).statusCode, 404);
  assert.deepEqual((await client.request('GET', `${path}?revision=${draft.revision}`)).json(), old);
  await f.reopen();
  assert.equal((await client.request('GET', `${path}?list=1`)).json().items.length, 2);
  assert.deepEqual(
    (await client.request('GET', `${path}?operationId=${receipt.operationId}`)).json(),
    receipt,
  );
  assert.equal(
    (
      await client.request(
        'GET',
        `${path}?operationId=${receipt.operationId}&revision=${draft.revision}`,
      )
    ).statusCode,
    400,
  );
  const reviewer = f.client();
  await reviewer.login('fixture-reviewer');
  assert.deepEqual((await reviewer.request('GET', `${path}?list=1`)).json(), { items: [] });
  assert.equal(
    (await reviewer.request('GET', `${path}?operationId=${receipt.operationId}`)).statusCode,
    404,
  );
  const editor = f.client();
  await editor.login('fixture-editor');
  assert.equal((await editor.request('GET', `${path}?list=1`)).statusCode, 403);
  assert.equal(
    (await client.request('POST', `${path}/recovery`, body, { 'x-csrf-token': 'wrong' }))
      .statusCode,
    403,
  );
});
