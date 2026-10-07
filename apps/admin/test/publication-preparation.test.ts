import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import { catalogue } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  CONTENT_AUTHORING_LIMITS,
  readPublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import type { AdminAsset, AdminDraftInput } from '../src/contracts';
import { DraftRepository, sha256 } from '../src/drafts/repository';
import { AdminMedia } from '../src/media/service';
import { prepareReviewedPublication } from '../src/publishing/prepare';
import { ADMIN_PUBLICATION_INPUT_BYTES, publicationInputIssues } from '../src/publishing/readiness';
import { openAdminDatabase, type Actor, type AdminDatabase } from '../src/storage/database';
import { fixture, multipartPhoto } from './helpers';

async function preparedFixture(t: TestContext, baseline = false, separateAuthor = false) {
  let db: AdminDatabase | undefined;
  // Node runs these cleanup hooks in registration order; release our reader before fixture removal.
  t.after(() => db?.close());
  const f = await fixture(t);
  const client = f.client();
  await client.login(separateAuthor ? 'fixture-editor' : 'fixture.admin');
  let draft = (await client.create('start', baseline ? catalogue.recipes[0]!.recipeId : undefined))
    .draft;
  let operation = 0;
  async function save(patch: Partial<AdminDraftInput>) {
    const response = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
      operationId: `save-${++operation}`,
      expectedRevision: draft.revision,
      input: { ...draft.input, ...patch },
    });
    assert.equal(response.statusCode, 200, response.body);
    draft = response.json().draft;
  }
  if (baseline) await save({ changeSummary: 'Synthetic retained-source test only.' });
  else {
    const form = multipartPhoto(
      await sharp({ create: { width: 40, height: 30, channels: 3, background: '#214b3c' } })
        .png()
        .toBuffer(),
    );
    const uploaded = await client.request(
      'POST',
      `/admin/api/drafts/${draft.draftId}/media`,
      form.payload,
      { ...form.headers, 'x-operation-id': 'upload', 'x-draft-revision': String(draft.revision) },
    );
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    await save({
      title: 'Synthetic recipe fixture',
      description: null,
      category: 'Test category',
      cuisine: 'Test cuisine',
      photoAssetId: (uploaded.json() as AdminAsset).assetId,
      ingredients: [
        { rawName: 'Unknown fixture amount', rawMeasure: null },
        { rawName: 'Exact fixture amount', rawMeasure: '1 / 2' },
      ],
      instructions: [
        { rawText: 'Fixture heading', presentation: 'heading' },
        { rawText: 'Original fixture passage. Do not rewrite.', presentation: 'passage' },
      ],
      credits: [{ label: 'Synthetic test author', url: null }],
      changeSummary: 'Synthetic content, not a cooking recommendation.',
    });
  }
  const reviewer = separateAuthor ? f.client() : client;
  if (separateAuthor) await reviewer.login();
  for (const scope of ['recipe_text', 'photo', ...(draft.input.videoUrl ? ['video_embed'] : [])]) {
    const response = await reviewer.request('POST', `/admin/api/drafts/${draft.draftId}/rights`, {
      operationId: `rights-${scope}`,
      expectedRevision: draft.revision,
      scope,
      status: 'permitted',
      statement: `Synthetic fixture assertion only: ${scope}`,
      sourceUrl: null,
    });
    assert.equal(response.statusCode, 200, response.body);
    draft = response.json().draft;
  }
  const review = await reviewer.request('POST', `/admin/api/drafts/${draft.draftId}/reviews`, {
    operationId: 'approve',
    expectedRevision: draft.revision,
    decision: 'approved',
    note: 'Synthetic fixture approval only.',
  });
  assert.equal(review.statusCode, 200, review.body);
  draft = review.json().draft;
  db = openAdminDatabase(f.filename);
  const session = db
    .all<{ session_id: string; data: string }>('SELECT session_id,data FROM admin_session')
    .find((row) => JSON.parse(row.data).userId === 'fixture-admin')!;
  const user = db.userById('fixture-admin')!;
  const actor: Actor = {
    user: { userId: user.userId, username: user.username, role: user.role },
    authEpoch: user.authEpoch,
    sessionId: session.session_id,
  };
  const media = new AdminMedia(
    db,
    new DraftRepository(db, f.options.now),
    f.options.mediaDirectory,
    f.options.bundledPhotoDirectory,
    f.options.now,
  );
  const options = () => ({
    db,
    actor,
    media,
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    revisionId: 'fixture-publication-1',
    now: f.options.now,
  });
  return {
    f,
    db,
    client,
    actor,
    media,
    options,
    save,
    get draft() {
      return draft;
    },
  };
}

test('approved new recipe becomes an immutable publication candidate with exact unknowns and scoped evidence', async (t) => {
  const s = await preparedFixture(t);
  const before = canonicalContentJson(s.draft);
  const result = await prepareReviewedPublication(s.options());
  assert.equal(result.status, 'prepared_not_published');
  assert.equal(result.originalEvidence, null);
  assert.equal(result.publication.revision.document.kind, 'authored');
  assert.deepEqual(
    result.publication.revision.document.recipe.ingredients,
    s.draft.input.ingredients.map((row, index) => ({ position: index + 1, ...row })),
  );
  assert.deepEqual(
    result.publication.revision.document.recipe.instructions,
    s.draft.input.instructions.map((row, index) => ({ sequence: index + 1, ...row })),
  );
  assert.equal(result.publication.revision.document.metadata.servings.value, null);
  assert.equal(result.publication.revision.document.media[0]!.dimensions!.width, 40);
  assert.equal(result.publication.permissions.length, 2);
  assert.equal(canonicalContentJson(s.draft), before);
  assert.equal(
    s.db.get<{ count: number }>("SELECT COUNT(*) count FROM admin_operation WHERE kind='publish'")!
      .count,
    0,
  );
  assert.deepEqual(
    await readPublishedRecipeRevision(result.publication, async (text) => sha256(text)),
    result.publication,
  );
  const asset = JSON.parse(
    s.db.get<{ document: string }>(
      'SELECT document FROM admin_asset WHERE hash=?',
      s.draft.input.photoAssetId!.slice(7),
    )!.document,
  ) as AdminAsset;
  assert.equal(
    asset.rightsStatus,
    'unreviewed',
    'per-draft permission must not become global asset permission',
  );
});

test('derived candidate retains exact trusted original evidence without inventing worksheet locators', async (t) => {
  const s = await preparedFixture(t, true);
  const result = await prepareReviewedPublication(s.options());
  assert.deepEqual(result.originalEvidence?.ref, s.draft.basedOn);
  assert.deepEqual(result.originalEvidence?.document.recipe, catalogue.getRecipe(s.draft.recipeId));
  assert.equal(result.publication.revision.document.kind, 'authored');
  assert.equal('source' in result.publication.revision.document.recipe.ingredients[0]!, false);
  assert.equal(
    result.publication.revision.document.media[0]!.sha256,
    result.originalEvidence!.document.media[0]!.sha256,
  );
});

test('editor remains the author when a different reviewer records permissions and approves', async (t) => {
  const s = await preparedFixture(t, false, true);
  const result = await prepareReviewedPublication(s.options());
  assert.equal(result.publication.revision.document.provenance.kind, 'authored');
  if (result.publication.revision.document.provenance.kind !== 'authored')
    assert.fail('Expected authored content');
  assert.equal(result.publication.revision.document.provenance.authorId, 'fixture-editor');
  assert.equal(result.approval.reviewerId, 'fixture-admin');
  assert.ok(
    result.publication.permissions.every(
      (permission) => permission.review.reviewerId === 'fixture-admin',
    ),
  );
});

test('draft bounds and unsupported video links cannot pass publication readiness', () => {
  const input: AdminDraftInput = {
    title: 'Fixture',
    description: null,
    category: 'Fixture',
    cuisine: 'Fixture',
    rawTags: null,
    recipePage: null,
    originalSourceUrl: null,
    videoUrl: null,
    photoAssetId: null,
    ingredients: [{ rawName: 'Fixture', rawMeasure: null }],
    instructions: [{ rawText: 'Fixture', presentation: 'passage' }],
    credits: [{ label: 'Fixture', url: null }],
    changeSummary: 'Fixture',
  };
  assert.deepEqual(publicationInputIssues(input), []);
  for (const key of ['description', 'category', 'cuisine'] as const) {
    assert.ok(
      publicationInputIssues({ ...input, [key]: 'x'.repeat(CONTENT_AUTHORING_LIMITS[key] + 1) })
        .length,
    );
    assert.deepEqual(
      publicationInputIssues({ ...input, [key]: 'x'.repeat(CONTENT_AUTHORING_LIMITS[key]) }),
      [],
    );
  }
  for (const videoUrl of [
    'http://youtu.be/abcdefghijk',
    'https://www.youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv',
    'https://youtu.be/abcdefghijk#fragment',
    'https://youtube.com:444/watch?v=abcdefghijk',
  ])
    assert.ok(publicationInputIssues({ ...input, videoUrl }).length);
  assert.deepEqual(
    publicationInputIssues({ ...input, videoUrl: 'https://youtu.be/abcdefghijk' }),
    [],
  );
});

test('oversized content can save intact but cannot be approved', async (t) => {
  const s = await preparedFixture(t);
  const description = 'x'.repeat(CONTENT_AUTHORING_LIMITS.description + 1);
  await s.save({ description });
  assert.equal(s.draft.input.description, description);
  assert.ok(s.draft.validationIssues.some((issue) => issue.startsWith('description:')));
  const reviewed = await s.client.request('POST', `/admin/api/drafts/${s.draft.draftId}/reviews`, {
    operationId: 'oversized-approval',
    expectedRevision: s.draft.revision,
    decision: 'approved',
    note: 'Must not pass.',
  });
  assert.equal(reviewed.statusCode, 409);
  assert.equal(reviewed.json().error.code, 'review_blocked');
  await assert.rejects(prepareReviewedPublication(s.options()), { code: 'approval_required' });
});

test('tampered bytes never become a publication candidate', async (t) => {
  const s = await preparedFixture(t);
  await assert.rejects(
    prepareReviewedPublication({
      ...s.options(),
      media: {
        baseline: (id) => s.media.baseline(id),
        asset: async (id) => ({ ...(await s.media.asset(id)), bytes: Buffer.from('tampered') }),
      },
    }),
    { code: 'photo_integrity' },
  );
});

test('individually valid passages near the document byte limit remain saved but block approval', async (t) => {
  const s = await preparedFixture(t);
  const instructions = Array.from({ length: 86 }, () => ({
    rawText: 'x'.repeat(12_000),
    presentation: 'passage' as const,
  }));
  const input = { ...s.draft.input, instructions };
  assert.ok(Buffer.byteLength(canonicalContentJson(input)) > ADMIN_PUBLICATION_INPUT_BYTES);
  await s.save({ instructions });
  assert.deepEqual(s.draft.input.instructions, instructions);
  assert.ok(s.draft.validationIssues.some((issue) => issue.includes('KiB')));
  const result = await s.client.request('POST', `/admin/api/drafts/${s.draft.draftId}/reviews`, {
    operationId: 'aggregate-approval',
    expectedRevision: s.draft.revision,
    decision: 'approved',
    note: 'Must remain blocked.',
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error.code, 'review_blocked');
});

test('publication admission measures Unicode bytes without shortening exact passages', () => {
  const input: AdminDraftInput = {
    title: 'Unicode fixture',
    description: null,
    category: 'Fixture',
    cuisine: 'Fixture',
    rawTags: null,
    recipePage: null,
    originalSourceUrl: null,
    videoUrl: null,
    photoAssetId: null,
    ingredients: [{ rawName: 'Exact amount', rawMeasure: '1 / 2' }],
    instructions: Array.from({ length: 83 }, () => ({
      rawText: 'ل'.repeat(6000),
      presentation: 'passage',
    })),
    credits: [{ label: 'Fixture', url: null }],
    changeSummary: 'Fixture',
  };
  const original = canonicalContentJson(input);
  assert.ok(original.length < ADMIN_PUBLICATION_INPUT_BYTES);
  assert.ok(Buffer.byteLength(original, 'utf8') > ADMIN_PUBLICATION_INPUT_BYTES);
  assert.ok(publicationInputIssues(input).some((issue) => issue.includes('KiB')));
  assert.equal(canonicalContentJson(input), original);
  assert.deepEqual(
    publicationInputIssues({ ...input, instructions: input.instructions.slice(0, 80) }),
    [],
  );
});

test('edits during asynchronous photo inspection invalidate the prepared approval', async (t) => {
  const s = await preparedFixture(t);
  const options = s.options();
  await assert.rejects(
    prepareReviewedPublication({
      ...options,
      media: {
        baseline: (id) => s.media.baseline(id),
        asset: async (id) => {
          const result = await s.media.asset(id);
          await s.save({ title: 'A newer exact revision' });
          return result;
        },
      },
    }),
    { code: 'revision_conflict' },
  );
});

test('authenticated HTTP preflight checks exact approved content without a publication or draft mutation', async (t) => {
  const s = await preparedFixture(t);
  const before = s.db.all('SELECT * FROM admin_operation');
  const storedDraft = s.db.all('SELECT * FROM admin_draft');
  const response = await s.client.request(
    'POST',
    `/admin/api/drafts/${s.draft.draftId}/publication-preview`,
    { expectedRevision: s.draft.revision },
  );
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.status, 'prepared_not_published');
  assert.equal(result.draftRevision, s.draft.revision);
  assert.equal(result.recipeId, s.draft.recipeId);
  assert.deepEqual(result.permissionScopes, ['recipe_text', 'photo']);
  assert.ok(result.documentBytes > 0);
  assert.equal(result.originalEvidenceRetained, false);
  assert.equal(typeof result.contentFingerprint, 'string');
  assert.equal(typeof result.publicationFingerprint, 'string');
  assert.deepEqual(s.db.all('SELECT * FROM admin_operation'), before);
  assert.deepEqual(s.db.all('SELECT * FROM admin_draft'), storedDraft);
});

test('HTTP preflight rejects stale revisions, extra fields, missing CSRF and editor authority', async (t) => {
  const s = await preparedFixture(t);
  const path = `/admin/api/drafts/${s.draft.draftId}/publication-preview`;
  const stale = await s.client.request('POST', path, { expectedRevision: s.draft.revision - 1 });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, 'revision_conflict');
  const extra = await s.client.request('POST', path, {
    expectedRevision: s.draft.revision,
    publish: true,
  });
  assert.equal(extra.statusCode, 400);
  const csrf = s.client.csrf;
  s.client.csrf = '';
  assert.equal(
    (await s.client.request('POST', path, { expectedRevision: s.draft.revision })).statusCode,
    403,
  );
  s.client.csrf = csrf;
  const editor = s.f.client();
  await editor.login('fixture-editor');
  const denied = await editor.request('POST', path, { expectedRevision: s.draft.revision });
  assert.equal(denied.statusCode, 403, denied.body);
});

test('HTTP preflight repeats recent-auth checks rather than trusting the saved approval', async (t) => {
  const s = await preparedFixture(t);
  s.f.advance(16 * 60 * 1000);
  const response = await s.client.request(
    'POST',
    `/admin/api/drafts/${s.draft.draftId}/publication-preview`,
    { expectedRevision: s.draft.revision },
  );
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, 'reauth_required');
});

test('revoked identity and expired recent authentication block preparation', async (t) => {
  const s = await preparedFixture(t);
  s.f.advance(15 * 60 * 1000 + 1);
  await assert.rejects(prepareReviewedPublication(s.options()), { code: 'reauth_required' });
  s.db.run('UPDATE admin_user SET auth_epoch=auth_epoch+1 WHERE user_id=?', s.actor.user.userId);
  await assert.rejects(prepareReviewedPublication(s.options()), { code: 'session_expired' });
});

for (const failure of ['revoked', 'expired'] as const) {
  test(`${failure} authority during media inspection blocks the final prepared result`, async (t) => {
    const s = await preparedFixture(t);
    await assert.rejects(
      prepareReviewedPublication({
        ...s.options(),
        media: {
          baseline: (id) => s.media.baseline(id),
          asset: async (id) => {
            const result = await s.media.asset(id);
            if (failure === 'revoked')
              s.db.run(
                'UPDATE admin_user SET auth_epoch=auth_epoch+1 WHERE user_id=?',
                s.actor.user.userId,
              );
            else s.f.advance(15 * 60 * 1000 + 1);
            return result;
          },
        },
      }),
      { code: failure === 'revoked' ? 'session_expired' : 'reauth_required' },
    );
  });
}
