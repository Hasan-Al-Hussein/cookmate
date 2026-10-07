import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { catalogue } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminDraftInput } from '../src/contracts';
import type {
  AdminTranslation,
  AdminTranslationInput,
  AdminTranslationMutation,
} from '../src/translations/contracts';
import { TranslationRepository } from '../src/translations/repository';
import { openAdminDatabase, type Actor } from '../src/storage/database';
import { sha256 } from '../src/drafts/repository';
import { fixture } from './helpers';

function translated(
  input: AdminDraftInput,
  attribution: AdminTranslationInput['attribution'] = 'machine',
): AdminTranslationInput {
  return {
    title: 'عنوان تجريبي',
    description: 'نص تجريبي\n\nمع فاصل أصلي',
    category: 'طبق',
    cuisine: 'مطبخ',
    rawTags: null,
    ingredients: input.ingredients.map((_, index) => ({ rawName: `مكوّن ${index + 1}` })),
    instructions: input.instructions.map((_, index) => ({
      rawText: `مقطع ${index + 1}\nسطر ثانٍ`,
    })),
    changeSummary: 'Synthetic language workflow fixture; no human quality claim.',
    attribution,
  };
}
async function setup(t: TestContext) {
  const f = await fixture(t);
  const client = f.client();
  await client.login();
  let draft = (await client.create('translation-source', catalogue.recipes[0]!.recipeId)).draft;
  let sequence = 0;
  const path = () => `/admin/api/drafts/${draft.draftId}/translations`;
  const request = () => ({
    operationId: `translation-${++sequence}`,
    sourceRevision: draft.revision,
    originalLanguage: 'en',
    targetLanguage: 'ar',
    input: translated(draft.input),
  });
  const create = async () => {
    const body = request();
    const response = await client.request('POST', path(), body);
    assert.equal(response.statusCode, 200, response.body);
    return { body, mutation: response.json() as AdminTranslationMutation };
  };
  const saveSource = async (patch: Partial<AdminDraftInput> = {}) => {
    const response = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
      operationId: `source-save-${++sequence}`,
      expectedRevision: draft.revision,
      input: { ...draft.input, title: `${draft.input.title} changed`, ...patch },
    });
    assert.equal(response.statusCode, 200, response.body);
    draft = response.json().draft as AdminDraft;
  };
  const review = (record: AdminTranslation, operationId = `translation-review-${++sequence}`) =>
    client.request('POST', `/admin/api/translations/${record.translationId}/reviews`, {
      operationId,
      expectedRevision: record.revision,
      decision: 'approved',
      note: 'Fixture operator acknowledgement only.',
      acknowledgeHumanReview: true,
    });
  return {
    f,
    client,
    path,
    request,
    create,
    saveSource,
    review,
    get draft() {
      return draft;
    },
  };
}
function sourceBytes(filename: string) {
  const db = new DatabaseSync(filename);
  try {
    return db
      .prepare(
        'SELECT draft_id,revision,document,original_evidence,review_evidence FROM admin_draft_revision ORDER BY draft_id,revision',
      )
      .all();
  } finally {
    db.close();
  }
}

test('separate persisted translation keeps original text, quantities, evidence and source locators byte-identical across reopen', async (t) => {
  const s = await setup(t);
  const bytes = sourceBytes(s.f.filename);
  const { body, mutation } = await s.create();
  const record = mutation.translation;
  assert.equal(record.status, 'draft');
  assert.equal(record.effectiveStatus, 'draft');
  assert.equal(record.review, null);
  assert.equal(record.machineAssisted, true);
  assert.equal(record.source.revision, 1);
  assert.equal(record.source.inputFingerprint, sha256(canonicalContentJson(s.draft.input)));
  assert.deepEqual(record.input, body.input);
  const original = await s.client.request(
    'GET',
    `/admin/api/translations/${record.translationId}/original`,
  );
  assert.equal(original.statusCode, 200);
  assert.deepEqual(original.json().input, s.draft.input);
  assert.deepEqual(sourceBytes(s.f.filename), bytes);
  const listing = (await s.client.request('GET', s.path())).json();
  assert.equal(listing.items.length, 1);
  assert.equal('input' in listing.items[0], false);
  await s.f.reopen();
  assert.deepEqual(
    (await s.client.request('GET', `/admin/api/translations/${record.translationId}`)).json(),
    record,
  );
  assert.deepEqual(sourceBytes(s.f.filename), bytes);
});

test('existing authentication, origin, CSRF and reviewer roles guard the mounted routes', async (t) => {
  const s = await setup(t);
  const request = s.request();
  const anonymous = s.f.client();
  assert.equal((await anonymous.request('GET', s.path())).statusCode, 401);
  assert.equal(
    (await s.client.request('POST', s.path(), request, { 'x-csrf-token': '' })).statusCode,
    403,
  );
  assert.equal(
    (await s.client.request('POST', s.path(), request, { origin: 'https://foreign.invalid' }))
      .statusCode,
    403,
  );
  const editor = s.f.client();
  await editor.login('fixture-editor');
  const created = await editor.request('POST', s.path(), request);
  assert.equal(created.statusCode, 200, created.body);
  const record: AdminTranslation = created.json().translation;
  const reviewBody = {
    operationId: 'editor-review',
    expectedRevision: 1,
    decision: 'approved',
    note: 'Attempt',
    acknowledgeHumanReview: true,
  };
  assert.equal(
    (
      await editor.request(
        'POST',
        `/admin/api/translations/${record.translationId}/reviews`,
        reviewBody,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await s.client.request('POST', `/admin/api/translations/${record.translationId}/reviews`, {
        ...reviewBody,
        reviewerId: 'forged',
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await s.client.request('POST', `/admin/api/translations/${record.translationId}/reviews`, {
        ...reviewBody,
        acknowledgeHumanReview: false,
      })
    ).statusCode,
    400,
  );
  const db = openAdminDatabase(s.f.filename);
  db.run("UPDATE admin_user SET enabled=0 WHERE user_id='fixture-editor'");
  db.close();
  assert.equal(
    (await editor.request('GET', `/admin/api/translations/${record.translationId}`)).statusCode,
    401,
  );
});

test('operator approval binds languages, exact original and translated revision; expired recent auth still permits exact recovery', async (t) => {
  const s = await setup(t);
  const { mutation } = await s.create();
  const response = await s.review(mutation.translation, 'review-exact');
  assert.equal(response.statusCode, 200, response.body);
  const approved: AdminTranslation = response.json().translation;
  assert.equal(approved.status, 'reviewed');
  assert.equal(approved.machineAssisted, true);
  assert.equal(approved.review?.evidence, 'operator_acknowledgement');
  assert.equal(approved.review?.reviewerId, 'fixture-admin');
  assert.equal(
    approved.review?.binding,
    sha256(
      canonicalContentJson({
        translationId: approved.translationId,
        inputRevision: 1,
        source: approved.source,
        originalLanguage: 'en',
        targetLanguage: 'ar',
        translatedFingerprint: approved.translatedFingerprint,
      }),
    ),
  );
  s.f.advance(16 * 60 * 1000);
  assert.deepEqual((await s.review(mutation.translation, 'review-exact')).json(), response.json());
  const rejected = await s.review(approved, 'review-after-expiry');
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().error.code, 'reauth_required');
  const recovery = await s.client.request('GET', '/admin/api/translation-operations/review-exact');
  assert.deepEqual(recovery.json(), response.json());
});

test('source change invalidates effective approval, preserves View original and requires explicit unreviewed rebase', async (t) => {
  const s = await setup(t);
  const { mutation } = await s.create();
  const approved: AdminTranslation = (await s.review(mutation.translation)).json().translation;
  const originalInput = structuredClone(s.draft.input);
  await s.saveSource({
    ingredients: [
      ...s.draft.input.ingredients,
      { rawName: 'New original', rawMeasure: '1 1/2 cups' },
    ],
  });
  const path = `/admin/api/translations/${approved.translationId}`;
  const stale: AdminTranslation = (await s.client.request('GET', path)).json();
  assert.equal(stale.status, 'reviewed');
  assert.equal(stale.effectiveStatus, 'stale');
  assert.deepEqual(stale.sourceStatus, { kind: 'stale', currentRevision: 2 });
  assert.deepEqual((await s.client.request('GET', `${path}/original`)).json().input, originalInput);
  assert.equal((await s.review(stale)).json().error.code, 'translation_source_stale');
  const rebase = await s.client.request('POST', `${path}/rebase`, {
    operationId: 'deliberate-rebase',
    expectedRevision: stale.revision,
    sourceRevision: 2,
    input: translated(s.draft.input, 'human'),
  });
  assert.equal(rebase.statusCode, 200, rebase.body);
  const next: AdminTranslation = rebase.json().translation;
  assert.equal(next.status, 'draft');
  assert.equal(next.review, null);
  assert.equal(next.source.revision, 2);
  assert.equal(next.machineAssisted, true);
  assert.deepEqual(
    (await s.client.request('GET', `${path}/original?revision=2`)).json().input,
    originalInput,
  );
  assert.deepEqual((await s.client.request('GET', `${path}/original`)).json().input, s.draft.input);
  assert.deepEqual(
    (await s.client.request('GET', `${path}/history`))
      .json()
      .items.map((row: AdminTranslation) => [row.revision, row.effectiveStatus]),
    [
      [3, 'draft'],
      [2, 'stale'],
      [1, 'stale'],
    ],
  );
  assert.equal((await s.review(next)).statusCode, 200);
});

test('save CAS and exact idempotence retain immutable prior revisions and clear operator review', async (t) => {
  const s = await setup(t);
  const { body, mutation } = await s.create();
  assert.deepEqual((await s.client.request('POST', s.path(), body)).json(), mutation);
  assert.equal(
    (await s.client.request('POST', s.path(), { ...body, targetLanguage: 'fr' })).statusCode,
    409,
  );
  const approved: AdminTranslation = (await s.review(mutation.translation)).json().translation;
  const path = `/admin/api/translations/${approved.translationId}`;
  const save = {
    operationId: 'translated-edit',
    expectedRevision: approved.revision,
    input: { ...approved.input, title: 'عنوان محفوظ جديد', attribution: 'human' },
  };
  const saved = await s.client.request('PUT', path, save);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().translation.review, null);
  assert.equal(saved.json().translation.machineAssisted, true);
  assert.deepEqual((await s.client.request('PUT', path, save)).json(), saved.json());
  assert.equal(
    (await s.client.request('PUT', path, { ...save, operationId: 'stale-edit' })).statusCode,
    409,
  );
  assert.deepEqual((await s.client.request('GET', `${path}?revision=2`)).json(), approved);
  assert.equal(
    (
      await s.client.request('PUT', path, {
        ...save,
        input: { ...save.input, title: 'Conflicting retry' },
      })
    ).statusCode,
    409,
  );
});

test('actor-scoped durable resolve fences late mutation and returns committed receipt after acknowledgement loss', async (t) => {
  const s = await setup(t);
  const request = s.request();
  const requestFingerprint = sha256(canonicalContentJson({ draftId: s.draft.draftId, request }));
  const path = `/admin/api/translation-operations/${request.operationId}/resolve`;
  const cancelled = await s.client.request('POST', path, { requestFingerprint });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().status, 'cancelled');
  await s.f.reopen();
  assert.deepEqual(
    (await s.client.request('POST', path, { requestFingerprint })).json(),
    cancelled.json(),
  );
  assert.equal(
    (await s.client.request('POST', s.path(), request)).json().error.code,
    'operation_cancelled',
  );
  assert.equal(
    (await s.client.request('POST', path, { requestFingerprint: 'a'.repeat(64) })).statusCode,
    409,
  );
  const { mutation } = await s.create();
  const resolved = await s.client.request(
    'POST',
    `/admin/api/translation-operations/${mutation.operationId}/resolve`,
    { requestFingerprint: mutation.requestFingerprint },
  );
  assert.deepEqual(resolved.json(), { status: 'committed', mutation });
  const other = s.f.client();
  await other.login('fixture-reviewer');
  assert.equal(
    (await other.request('GET', `/admin/api/translation-operations/${mutation.operationId}`))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await other.request(
        'POST',
        `/admin/api/translation-operations/${mutation.operationId}/resolve`,
        { requestFingerprint: mutation.requestFingerprint },
      )
    ).statusCode,
    409,
  );
});

test('corrupt operation pointer cannot return another committed identity through read, resolve or exact retry', async (t) => {
  const s = await setup(t);
  const first = await s.create();
  const second = await s.create();
  const db = openAdminDatabase(s.f.filename);
  try {
    const saved = db.get<{ result: string }>(
      'SELECT result FROM admin_operation WHERE operation_id=?',
      first.mutation.operationId,
    )!.result;
    db.run(
      'UPDATE admin_operation SET result=? WHERE operation_id=?',
      JSON.stringify({
        operationId: second.mutation.operationId,
        translationId: second.mutation.translation.translationId,
        revision: second.mutation.translation.revision,
      }),
      first.mutation.operationId,
    );
    const before = db.all('SELECT * FROM admin_operation ORDER BY operation_id');
    const revisions = db.all(
      'SELECT * FROM admin_translation_revision ORDER BY translation_id,revision',
    );
    const path = `/admin/api/translation-operations/${first.mutation.operationId}`;
    for (const response of [
      await s.client.request('GET', path),
      await s.client.request('POST', `${path}/resolve`, {
        requestFingerprint: first.mutation.requestFingerprint,
      }),
      await s.client.request('POST', s.path(), first.body),
    ]) {
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(response.json().error.code, 'translation_storage');
      assert.equal('mutation' in response.json(), false);
    }
    assert.deepEqual(db.all('SELECT * FROM admin_operation ORDER BY operation_id'), before);
    assert.deepEqual(
      db.all('SELECT * FROM admin_translation_revision ORDER BY translation_id,revision'),
      revisions,
    );
    db.run(
      'UPDATE admin_operation SET result=? WHERE operation_id=?',
      saved,
      first.mutation.operationId,
    );
    assert.deepEqual((await s.client.request('GET', path)).json(), first.mutation);
  } finally {
    db.close();
  }
});

test('strict language, row alignment, raw-quantity protection and forged status are rejected before persistence', async (t) => {
  const s = await setup(t);
  const base = s.request();
  for (const patch of [
    { originalLanguage: 'ar' },
    { originalLanguage: 'not a language' },
    { targetLanguage: 'AR' },
    { targetLanguage: 'und' },
    { status: 'reviewed' },
    { review: { reviewerId: 'invented' } },
    { input: { ...base.input, title: 'x'.repeat(501) } },
    { input: { ...base.input, ingredients: [] } },
    {
      input: {
        ...base.input,
        ingredients: base.input.ingredients.map((row) => ({
          ...row,
          rawMeasure: 'edited 100 cups',
        })),
      },
    },
    {
      input: {
        ...base.input,
        instructions: base.input.instructions.map((row) => ({ ...row, presentation: 'heading' })),
      },
    },
    { input: { ...base.input, attribution: 'human_reviewed' } },
  ]) {
    const response = await s.client.request('POST', s.path(), { ...base, ...patch });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual((await s.client.request('GET', s.path())).json().items, []);
});

test('incomplete translation cannot be approved; changes-requested remains distinct from human approval', async (t) => {
  const s = await setup(t);
  const request = s.request();
  request.input.title = '';
  const created = await s.client.request('POST', s.path(), request);
  assert.equal(created.statusCode, 200);
  const record: AdminTranslation = created.json().translation;
  assert.equal((await s.review(record)).json().error.code, 'translation_incomplete');
  const changes = await s.client.request(
    'POST',
    `/admin/api/translations/${record.translationId}/reviews`,
    {
      operationId: 'changes-requested',
      expectedRevision: 1,
      decision: 'changes_requested',
      note: 'Complete missing title.',
      acknowledgeHumanReview: false,
    },
  );
  assert.equal(changes.statusCode, 200);
  assert.equal(changes.json().translation.effectiveStatus, 'changes_requested');
  assert.equal(changes.json().translation.review.decision, 'changes_requested');
});

test('repository owns descriptor-safe input and refuses changed original bytes or oversized saved payloads', async (t) => {
  const s = await setup(t);
  const { mutation } = await s.create();
  const db = openAdminDatabase(s.f.filename);
  try {
    const row = db.get<{ session_id: string }>(
      "SELECT session_id FROM admin_session WHERE json_extract(data,'$.userId')='fixture-admin'",
    )!;
    const actor: Actor = {
      user: { userId: 'fixture-admin', username: 'fixture.admin', role: 'administrator' },
      authEpoch: 1,
      sessionId: row.session_id,
    };
    const repository = new TranslationRepository(db, s.f.options.now);
    let invoked = false;
    assert.throws(
      () =>
        repository.create(actor, s.draft.draftId, {
          ...s.request(),
          get input() {
            invoked = true;
            throw new Error('must not run');
          },
        }),
      /Translation data/,
    );
    assert.equal(invoked, false);
    const saved = db.get<{ document: string }>(
      'SELECT document FROM admin_draft_revision WHERE draft_id=? AND revision=1',
      s.draft.draftId,
    )!;
    const parsed = JSON.parse(saved.document) as AdminDraft;
    parsed.input.title = 'Corrupted original';
    db.run(
      'UPDATE admin_draft_revision SET document=? WHERE draft_id=? AND revision=1',
      JSON.stringify(parsed),
      s.draft.draftId,
    );
    assert.throws(() => repository.read(mutation.translation.translationId), /binding changed/);
    db.run(
      'UPDATE admin_draft_revision SET document=? WHERE draft_id=? AND revision=1',
      ' '.repeat(2 * 1024 * 1024 + 1),
      s.draft.draftId,
    );
    assert.throws(
      () => repository.original(mutation.translation.translationId),
      /exceeds supported bounds/,
    );
  } finally {
    db.close();
  }
});

test('schema1 to2 adds only translation storage and preserves existing source and operation bytes', async (t) => {
  const s = await setup(t);
  await s.f.app.close();
  const raw = new DatabaseSync(s.f.filename);
  raw.exec(
    'PRAGMA foreign_keys=ON; DROP TABLE admin_translation_revision; DROP TABLE admin_translation; UPDATE admin_meta SET schema_version=1 WHERE id=1;',
  );
  const originals = raw.prepare('SELECT * FROM admin_draft_revision').all();
  const operations = raw.prepare('SELECT * FROM admin_operation').all();
  raw.close();
  const reopened = openAdminDatabase(s.f.filename);
  assert.equal(
    reopened.get<{ schema_version: number }>('SELECT schema_version FROM admin_meta')!
      .schema_version,
    2,
  );
  assert.deepEqual(reopened.all('SELECT * FROM admin_draft_revision'), originals);
  assert.deepEqual(reopened.all('SELECT * FROM admin_operation'), operations);
  assert.deepEqual(reopened.all('PRAGMA foreign_key_check'), []);
  reopened.close();
  await s.f.reopen();
  const { mutation } = await s.create();
  assert.equal(mutation.translation.revision, 1);
});

test('failed additive migration rolls back all new tables and incompatible versions/layout are refused', async (t) => {
  const s = await setup(t);
  await s.f.app.close();
  const raw = new DatabaseSync(s.f.filename);
  try {
    raw.exec(
      'DROP TABLE admin_translation_revision; DROP TABLE admin_translation; UPDATE admin_meta SET schema_version=1; CREATE TABLE admin_translation_revision(conflict TEXT);',
    );
    assert.throws(() => openAdminDatabase(s.f.filename));
    assert.equal(raw.prepare('SELECT schema_version FROM admin_meta').get()!.schema_version, 1);
    assert.equal(
      raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='admin_translation'").get()!.n,
      0,
    );
    raw.exec('DROP TABLE admin_translation_revision; UPDATE admin_meta SET schema_version=99;');
    assert.throws(() => openAdminDatabase(s.f.filename), /version is not supported/);
    raw.exec('UPDATE admin_meta SET schema_version=1;');
    const valid = openAdminDatabase(s.f.filename);
    valid.close();
    raw.exec(
      'DROP INDEX admin_translation_source; CREATE INDEX admin_translation_source ON admin_translation(revision);',
    );
    assert.throws(() => openAdminDatabase(s.f.filename), /schema is incompatible/);
  } finally {
    raw.close();
  }
});

test('stale source create/rebase conflicts never rewrite saved translation or draft evidence', async (t) => {
  const s = await setup(t);
  const oldRequest = s.request();
  const { mutation } = await s.create();
  await s.saveSource();
  const before = sourceBytes(s.f.filename);
  assert.equal(
    (await s.client.request('POST', s.path(), oldRequest)).json().error.code,
    'translation_source_stale',
  );
  const path = `/admin/api/translations/${mutation.translation.translationId}`;
  const rebase = {
    operationId: 'invalid-rebase',
    expectedRevision: 1,
    sourceRevision: 1,
    input: mutation.translation.input,
  };
  assert.equal((await s.client.request('POST', `${path}/rebase`, rebase)).statusCode, 409);
  assert.equal(
    (await s.client.request('POST', `${path}/rebase`, { ...rebase, sourceRevision: 999 }))
      .statusCode,
    404,
  );
  assert.equal((await s.client.request('GET', path)).json().revision, 1);
  assert.deepEqual(sourceBytes(s.f.filename), before);
});
