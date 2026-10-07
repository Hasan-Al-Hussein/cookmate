import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminDraftInput, AdminMetadataInput } from '../src/contracts';
import { openAdminDatabase } from '../src/storage/database';
import { fixture } from './helpers';

async function setup(t: TestContext) {
  const f = await fixture(t);
  const client = f.client();
  await client.login();
  let draft = (await client.create('metadata-start', catalogue.recipes[0]!.recipeId)).draft;
  let sequence = 0;
  const body = (input: unknown) => ({
    operationId: `metadata-${++sequence}`,
    expectedRevision: draft.revision,
    input,
  });
  const record = async (input: AdminMetadataInput) => {
    const request = body(input);
    const result = await client.request(
      'POST',
      `/admin/api/drafts/${draft.draftId}/metadata`,
      request,
    );
    assert.equal(result.statusCode, 200, result.body);
    draft = result.json().draft;
    return { request, result };
  };
  const save = async (patch: Partial<AdminDraftInput>) => {
    const result = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
      operationId: `save-${++sequence}`,
      expectedRevision: draft.revision,
      input: { ...draft.input, ...patch },
    });
    assert.equal(result.statusCode, 200, result.body);
    draft = result.json().draft;
    return draft;
  };
  return {
    f,
    client,
    body,
    record,
    save,
    get draft() {
      return draft;
    },
    setDraft(value: AdminDraft) {
      draft = value;
    },
  };
}
const evidence = 'Synthetic fixture source evidence; not a real nutrition or dietary claim.';

test('metadata stores server review evidence for every supported field, zero nutrition and nulls without rewriting recipe text', async (t) => {
  const s = await setup(t);
  const original = structuredClone(s.draft.input);
  for (const input of [
    { field: 'servings', value: 2.5, source: evidence },
    { field: 'prepMinutes', value: 0, source: evidence },
    { field: 'cookMinutes', value: 12.5, source: evidence },
    { field: 'dietaryTags', value: ['Fixture tag'], source: evidence },
    {
      field: 'nutrition',
      value: {
        basis: 'per_serving',
        energyKcal: 0,
        proteinGrams: null,
        carbohydrateGrams: 2.5,
        fatGrams: null,
      },
      source: evidence,
    },
  ] satisfies AdminMetadataInput[]) {
    const { request, result } = await s.record(input);
    assert.deepEqual(s.draft.metadata[input.field].value, input.value);
    assert.deepEqual(s.draft.metadata[input.field].review, {
      reviewerId: 'fixture-admin',
      reviewedAt: s.draft.updatedAt,
      source: evidence,
    });
    assert.deepEqual(s.draft.input, original);
    const retry = await s.client.request(
      'POST',
      `/admin/api/drafts/${s.draft.draftId}/metadata`,
      request,
    );
    assert.deepEqual(retry.json(), result.json());
  }
  await s.record({ field: 'prepMinutes', value: null, source: null });
  assert.deepEqual(s.draft.metadata.prepMinutes, { value: null, review: null });
  const prior = structuredClone(s.draft);
  await s.f.reopen();
  assert.deepEqual(
    (await s.client.request('GET', `/admin/api/drafts/${s.draft.draftId}`)).json(),
    prior,
  );
});

test('metadata authority, freshness, expected revision, strict input and receipt recovery remain server enforced', async (t) => {
  const s = await setup(t);
  const editor = s.f.client();
  await editor.login('fixture-editor');
  const reviewer = s.f.client();
  await reviewer.login('fixture-reviewer');
  const path = `/admin/api/drafts/${s.draft.draftId}/metadata`;
  const input = { field: 'servings', value: 4, source: evidence } as const;
  assert.equal((await editor.request('POST', path, s.body(input))).statusCode, 403);
  for (const invalid of [
    { ...input, reviewerId: 'invented' },
    { ...input, reviewedAt: '2026-10-01T00:00:00Z' },
    { ...input, value: 0 },
    { ...input, value: 1001 },
    { ...input, source: '  ' },
    { ...input, source: 'x'.repeat(2049) },
    { ...input, value: null },
    { field: 'prepMinutes', value: -1, source: evidence },
    { field: 'cookMinutes', value: 43201, source: evidence },
    { field: 'dietaryTags', value: ['same', 'same'], source: evidence },
    {
      field: 'nutrition',
      value: {
        basis: 'per_recipe',
        energyKcal: null,
        proteinGrams: null,
        carbohydrateGrams: null,
        fatGrams: null,
      },
      source: evidence,
    },
    {
      field: 'nutrition',
      value: {
        basis: 'per_100g',
        energyKcal: 1,
        proteinGrams: null,
        carbohydrateGrams: null,
        fatGrams: null,
      },
      source: evidence,
    },
  ])
    assert.equal((await s.client.request('POST', path, s.body(invalid))).statusCode, 400);
  const request = s.body(input);
  const accepted = await reviewer.request('POST', path, request);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().draft.metadata.servings.review.reviewerId, 'fixture-reviewer');
  assert.equal(
    (await s.client.request('POST', path, { ...request, operationId: 'stale-metadata' }))
      .statusCode,
    409,
  );
  assert.deepEqual(
    (await reviewer.request('GET', `/admin/api/operations/${request.operationId}`)).json(),
    accepted.json(),
  );
  const db = openAdminDatabase(s.f.filename);
  try {
    db.run("UPDATE admin_user SET role='editor' WHERE user_id='fixture-reviewer'");
  } finally {
    db.close();
  }
  assert.equal((await reviewer.request('POST', path, request)).statusCode, 403);
  assert.equal(
    (await reviewer.request('GET', `/admin/api/operations/${request.operationId}`)).statusCode,
    403,
  );
  s.f.advance(16 * 60 * 1000);
  const expired = await s.client.request('POST', path, {
    ...s.body(input),
    expectedRevision: accepted.json().draft.revision,
  });
  assert.equal(expired.statusCode, 403);
  assert.equal(expired.json().error.code, 'reauth_required');
});

test('summary-only saves preserve metadata; servings change, substantive saves and restore clear only specified dependencies', async (t) => {
  const s = await setup(t);
  await s.record({ field: 'servings', value: 2, source: evidence });
  await s.record({
    field: 'nutrition',
    value: {
      basis: 'per_serving',
      energyKcal: 100,
      proteinGrams: null,
      carbohydrateGrams: null,
      fatGrams: null,
    },
    source: evidence,
  });
  const reviewed = structuredClone(s.draft);
  await s.save({ changeSummary: 'Only this summary changed.' });
  assert.deepEqual(s.draft.metadata, reviewed.metadata);
  await s.record({ field: 'servings', value: 3, source: evidence });
  assert.deepEqual(s.draft.metadata.nutrition, { value: null, review: null });
  await s.save({ description: 'A substantive recipe change.' });
  assert.deepEqual(s.draft.metadata, unknownReviewedMetadata());
  await s.record({ field: 'cookMinutes', value: 20, source: evidence });
  const restored = await s.client.request('POST', `/admin/api/drafts/${s.draft.draftId}/restore`, {
    operationId: 'restore-metadata',
    expectedRevision: s.draft.revision,
    sourceRevision: reviewed.revision,
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().draft.metadata, unknownReviewedMetadata());
  assert.deepEqual(
    (
      await s.client.request(
        'GET',
        `/admin/api/drafts/${s.draft.draftId}/revisions/${reviewed.revision}`,
      )
    ).json().metadata,
    reviewed.metadata,
  );
});

test('metadata invalidates approval and flows unchanged into retained publication after a new review', async (t) => {
  const s = await setup(t);
  await s.save({ changeSummary: 'Synthetic publication fixture.', videoUrl: null });
  for (const scope of ['recipe_text', 'photo']) {
    const result = await s.client.request('POST', `/admin/api/drafts/${s.draft.draftId}/rights`, {
      operationId: `rights-${scope}`,
      expectedRevision: s.draft.revision,
      scope,
      status: 'permitted',
      statement: evidence,
      sourceUrl: null,
    });
    assert.equal(result.statusCode, 200, result.body);
    s.setDraft(result.json().draft);
  }
  const approve = async (operationId: string) => {
    const response = await s.client.request(
      'POST',
      `/admin/api/drafts/${s.draft.draftId}/reviews`,
      {
        operationId,
        expectedRevision: s.draft.revision,
        decision: 'approved',
        note: evidence,
      },
    );
    assert.equal(response.statusCode, 200, response.body);
    s.setDraft(response.json().draft);
  };
  await approve('first-approval');
  await s.record({ field: 'prepMinutes', value: 0, source: evidence });
  assert.equal(s.draft.approval, null);
  assert.equal(s.draft.status, 'draft');
  await approve('metadata-approval');
  const prepared = await s.client.request(
    'POST',
    `/admin/api/drafts/${s.draft.draftId}/publication-preparation`,
    { expectedRevision: s.draft.revision },
  );
  assert.equal(prepared.statusCode, 200, prepared.body);
  const db = openAdminDatabase(s.f.filename);
  try {
    const row = db.get<{ result: string }>(
      'SELECT result FROM admin_operation WHERE operation_id=?',
      prepared.json().operationId,
    )!;
    assert.deepEqual(
      JSON.parse(row.result).publication.revision.document.metadata,
      s.draft.metadata,
    );
  } finally {
    db.close();
  }
});

test('metadata cancellation is durable and exact changed-payload replay cannot reuse an operation', async (t) => {
  const s = await setup(t);
  const input = { field: 'servings', value: 4, source: evidence } as const;
  const request = s.body(input);
  assert.equal(
    (
      await s.client.request('POST', `/admin/api/operations/${request.operationId}/cancel`, {})
    ).json().status,
    'cancelled',
  );
  assert.equal(
    (
      await s.client.request('POST', `/admin/api/drafts/${s.draft.draftId}/metadata`, request)
    ).json().error.code,
    'operation_cancelled',
  );
  const { request: committed } = await s.record(input);
  const conflict = await s.client.request('POST', `/admin/api/drafts/${s.draft.draftId}/metadata`, {
    ...committed,
    input: { ...input, value: 5 },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'operation_conflict');
  assert.equal(
    (
      await s.client.request('POST', `/admin/api/operations/${committed.operationId}/cancel`, {})
    ).json().status,
    'committed',
  );
});
