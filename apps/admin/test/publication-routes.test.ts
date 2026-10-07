import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminDraftInput, AdminPublicationPreparation } from '../src/contracts';
import { openAdminDatabase } from '../src/storage/database';
import { sha256 } from '../src/drafts/repository';
import { PREPARATION_REQUEST_BYTES } from '../src/publishing/translationSelection';
import { fixture, multipartPhoto } from './helpers';

async function approvedFixture(t: TestContext) {
  const f = await fixture(t);
  const client = f.client();
  await client.login();
  let draft = (await client.create('preparation-route-create', catalogue.recipes[0]!.recipeId))
    .draft;
  let operation = 0;
  async function save(patch: Partial<AdminDraftInput>) {
    const result = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
      operationId: `route-save-${++operation}`,
      expectedRevision: draft.revision,
      input: { ...draft.input, ...patch },
    });
    assert.equal(result.statusCode, 200, result.body);
    draft = result.json().draft as AdminDraft;
  }
  async function approve() {
    for (const scope of [
      'recipe_text',
      'photo',
      ...(draft.input.videoUrl ? ['video_embed'] : []),
    ]) {
      const result = await client.request('POST', `/admin/api/drafts/${draft.draftId}/rights`, {
        operationId: `route-rights-${++operation}`,
        expectedRevision: draft.revision,
        scope,
        status: 'permitted',
        statement: `Synthetic HTTP fixture assertion: ${scope}`,
        sourceUrl: null,
      });
      assert.equal(result.statusCode, 200, result.body);
      draft = result.json().draft as AdminDraft;
    }
    const result = await client.request('POST', `/admin/api/drafts/${draft.draftId}/reviews`, {
      operationId: `route-review-${++operation}`,
      expectedRevision: draft.revision,
      decision: 'approved',
      note: 'Synthetic review for route tests only.',
    });
    assert.equal(result.statusCode, 200, result.body);
    draft = result.json().draft as AdminDraft;
  }
  function counts() {
    const db = openAdminDatabase(f.filename);
    try {
      return {
        retained: db.get<{ count: number }>(
          "SELECT COUNT(*) count FROM admin_operation WHERE kind='prepare_publication'",
        )!.count,
        identities: db.get<{ count: number }>(
          "SELECT COUNT(*) count FROM admin_operation WHERE kind='prepare_publication_identity'",
        )!.count,
        published: db.get<{ count: number }>(
          "SELECT COUNT(*) count FROM admin_operation WHERE kind='publish'",
        )!.count,
      };
    } finally {
      db.close();
    }
  }
  await save({ changeSummary: 'Synthetic route fixture; not published.' });
  await approve();
  return {
    f,
    client,
    save,
    approve,
    counts,
    get draft() {
      return draft;
    },
    get path() {
      return `/admin/api/drafts/${draft.draftId}/publication-preparation`;
    },
    async prepare() {
      return client.request('POST', this.path, { expectedRevision: draft.revision });
    },
  };
}

test('durable preparation HTTP retries and restart recover the exact actor-scoped package', async (t) => {
  const s = await approvedFixture(t);
  const missing = await s.client.request('GET', `${s.path}?revision=${s.draft.revision}`);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'preparation_unknown');
  assert.deepEqual(s.counts(), { retained: 0, identities: 0, published: 0 });
  const result = await s.prepare();
  assert.equal(result.statusCode, 200, result.body);
  const first = result.json() as AdminPublicationPreparation;
  assert.equal(first.status, 'prepared_not_published');
  assert.equal(first.draftRevision, s.draft.revision);
  assert.equal(first.recipeId, s.draft.recipeId);
  assert.match(first.operationId, /^prepare-[0-9a-f]{64}$/);
  assert.match(first.revisionId, /^authored-[0-9a-f]{64}$/);
  assert.equal(first.originalEvidenceRetained, true);
  assert.ok(first.documentBytes > 0);
  assert.equal(
    'publication' in first,
    false,
    'The API returns a bounded summary, not the private package.',
  );
  assert.equal('approval' in first, false);
  assert.deepEqual((await s.prepare()).json(), first);
  s.f.advance(1000);
  await s.f.reopen();
  assert.deepEqual(
    (await s.client.request('GET', `${s.path}?revision=${s.draft.revision}`)).json(),
    first,
  );
  assert.deepEqual((await s.prepare()).json(), first);
  assert.deepEqual(s.counts(), { retained: 1, identities: 1, published: 0 });
});

test('editing invalidates fresh preparation but preserves exact historical recovery and allows a new approved revision', async (t) => {
  const s = await approvedFixture(t);
  const first = (await s.prepare()).json() as AdminPublicationPreparation;
  await s.save({ title: 'Changed draft requiring a fresh review' });
  const blocked = await s.prepare();
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error.code, 'approval_required');
  assert.equal(
    (await s.client.request('GET', `${s.path}?revision=${s.draft.revision}`)).statusCode,
    404,
  );
  assert.deepEqual(
    (await s.client.request('GET', `${s.path}?revision=${first.draftRevision}`)).json(),
    first,
  );
  const retried = await s.client.request('POST', s.path, { expectedRevision: first.draftRevision });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.deepEqual(retried.json(), first);
  assert.deepEqual(s.counts(), { retained: 1, identities: 1, published: 0 });
  await s.approve();
  const nextResult = await s.prepare();
  assert.equal(nextResult.statusCode, 200, nextResult.body);
  const next = nextResult.json() as AdminPublicationPreparation;
  assert.notEqual(next.operationId, first.operationId);
  assert.notEqual(next.revisionId, first.revisionId);
  assert.notEqual(next.contentFingerprint, first.contentFingerprint);
  assert.deepEqual(s.counts(), { retained: 2, identities: 2, published: 0 });
});

test('authentication, actor isolation, review roles and CSRF remain enforced', async (t) => {
  const s = await approvedFixture(t);
  assert.equal(
    (await s.f.client().request('GET', `${s.path}?revision=${s.draft.revision}`)).statusCode,
    401,
  );
  const csrf = await s.client.request(
    'POST',
    s.path,
    { expectedRevision: s.draft.revision },
    { 'x-csrf-token': 'invalid-token' },
  );
  assert.equal(csrf.statusCode, 403);
  assert.equal(csrf.json().error.code, 'csrf_required');
  assert.deepEqual(s.counts(), { retained: 0, identities: 0, published: 0 });
  const first = (await s.prepare()).json() as AdminPublicationPreparation;
  const reviewer = s.f.client();
  await reviewer.login('fixture-reviewer');
  const notOwned = await reviewer.request('GET', `${s.path}?revision=${s.draft.revision}`);
  assert.equal(notOwned.statusCode, 404);
  assert.equal(notOwned.json().error.code, 'preparation_unknown');
  const second = await reviewer.request('POST', s.path, { expectedRevision: s.draft.revision });
  assert.equal(second.statusCode, 200, second.body);
  assert.notEqual(second.json().operationId, first.operationId);
  assert.notEqual(second.json().revisionId, first.revisionId);
  const editor = s.f.client();
  await editor.login('fixture-editor');
  for (const result of [
    await editor.request('POST', s.path, { expectedRevision: s.draft.revision }),
    await editor.request('GET', `${s.path}?revision=${s.draft.revision}`),
  ]) {
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().error.code, 'role_required');
  }
  assert.deepEqual(s.counts(), { retained: 2, identities: 2, published: 0 });
});

test('recent authentication can expire without breaking committed recovery, but cannot authorize a new preparation', async (t) => {
  const s = await approvedFixture(t);
  const first = (await s.prepare()).json() as AdminPublicationPreparation;
  await s.save({ title: 'Separately approved next draft' });
  await s.approve();
  s.f.advance(16 * 60 * 1000);
  const blocked = await s.prepare();
  assert.equal(blocked.statusCode, 403, blocked.body);
  assert.equal(blocked.json().error.code, 'reauth_required');
  assert.deepEqual(
    (await s.client.request('GET', `${s.path}?revision=${first.draftRevision}`)).json(),
    first,
  );
  assert.deepEqual(
    (await s.client.request('POST', s.path, { expectedRevision: first.draftRevision })).json(),
    first,
  );
  await s.client.login();
  assert.equal((await s.prepare()).statusCode, 200);
  assert.deepEqual(s.counts(), { retained: 2, identities: 2, published: 0 });
});

test('preparation accepts only its bounded exact request and canonical recovery query', async (t) => {
  const s = await approvedFixture(t);
  for (const body of [
    {},
    { expectedRevision: '1' },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedRevision: s.draft.revision, publish: true },
    { expectedRevision: s.draft.revision, operationId: 'caller-selected' },
  ])
    assert.equal((await s.client.request('POST', s.path, body)).statusCode, 400);
  assert.equal(
    (
      await s.client.request('POST', `${s.path}?revision=${s.draft.revision}`, {
        expectedRevision: s.draft.revision,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await s.client.request('POST', s.path, {
        expectedRevision: s.draft.revision,
        extra: 'x'.repeat(PREPARATION_REQUEST_BYTES),
      })
    ).statusCode,
    413,
  );
  for (const query of [
    '',
    '?revision=0',
    '?revision=-1',
    '?revision=01',
    '?revision=1.0',
    '?revision=9007199254740992',
    '?revision=1&revision=1',
    '?revision=1&publish=true',
  ]) {
    assert.equal((await s.client.request('GET', s.path + query)).statusCode, 400, query);
  }
  assert.deepEqual(s.counts(), { retained: 0, identities: 0, published: 0 });
});

test('generic mutation routes cannot claim or cancel a deterministic preparation operation ID', async (t) => {
  const s = await approvedFixture(t);
  const operationId = `prepare-${sha256(
    canonicalContentJson([
      'cookmate-admin-preparation-request-v1',
      ['fixture-admin', s.draft.draftId, s.draft.revision],
    ]),
  )}`;
  const base = `/admin/api/drafts/${s.draft.draftId}`;
  const expectedRevision = s.draft.revision;
  const form = multipartPhoto(Buffer.from('No image decode should occur for a reserved operation'));
  const attempts = [
    await s.client.request('POST', '/admin/api/drafts', { operationId }),
    await s.client.request('PUT', base, { operationId, expectedRevision, input: s.draft.input }),
    await s.client.request('POST', `${base}/restore`, {
      operationId,
      expectedRevision,
      sourceRevision: 1,
    }),
    await s.client.request('POST', `${base}/rights`, {
      operationId,
      expectedRevision,
      scope: 'photo',
      status: 'permitted',
      statement: 'Synthetic fixture.',
      sourceUrl: null,
    }),
    await s.client.request('POST', `${base}/reviews`, {
      operationId,
      expectedRevision,
      decision: 'approved',
      note: 'Synthetic fixture.',
    }),
    await s.client.request('POST', `/admin/api/operations/${operationId}/cancel`, {}),
    await s.client.request('POST', `${base}/media`, form.payload, {
      ...form.headers,
      'x-operation-id': operationId,
      'x-draft-revision': String(expectedRevision),
    }),
  ];
  for (const result of attempts) {
    assert.equal(result.statusCode, 400, result.body);
    assert.match(result.json().error.message, /reserved|preparation/i);
  }
  assert.deepEqual(s.counts(), { retained: 0, identities: 0, published: 0 });
  const actual = await s.prepare();
  assert.equal(actual.statusCode, 200, actual.body);
  assert.equal(actual.json().operationId, operationId);
  assert.deepEqual(s.counts(), { retained: 1, identities: 1, published: 0 });
});
