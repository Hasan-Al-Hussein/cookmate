import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogue } from '@cookmate/catalogue';
import type { AdminMutation } from '../src/contracts';
import { openAdminDatabase, type Actor } from '../src/storage/database';
import { DraftRepository } from '../src/drafts/repository';
import { fixture } from './helpers';

test('partial authored draft saves, exact operation recovery, CAS and immutable history', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const original = await c.create();
  assert.match(original.draft.recipeId, /^\d+$/);
  assert.equal(original.draft.basedOn, null);
  assert.equal(original.draft.input.title, '');
  assert.ok(original.draft.validationIssues.length > 0);
  assert.deepEqual(await c.create(), original);
  const body = {
    operationId: 'edit-one',
    expectedRevision: 1,
    input: {
      ...original.draft.input,
      title: 'Actual draft name',
      ingredients: [{ rawName: 'Salt', rawMeasure: null }],
      changeSummary: 'First text edit',
    },
  };
  const saved = await c.request('PUT', `/admin/api/drafts/${original.draft.draftId}`, body);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().draft.revision, 2);
  assert.deepEqual(
    (await c.request('PUT', `/admin/api/drafts/${original.draft.draftId}`, body)).json(),
    saved.json(),
  );
  assert.equal(
    (
      await c.request('PUT', `/admin/api/drafts/${original.draft.draftId}`, {
        ...body,
        input: { ...body.input, title: 'Different' },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await c.request('PUT', `/admin/api/drafts/${original.draft.draftId}`, {
        ...body,
        operationId: 'stale-edit',
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await c.request('GET', `/admin/api/drafts/${original.draft.draftId}/revisions/1`)).json().input
      .title,
    '',
  );
  const history = await c.request('GET', `/admin/api/drafts/${original.draft.draftId}/history`);
  assert.deepEqual(
    history.json().items.map((row: { revision: number }) => row.revision),
    [2, 1],
  );
  const receipt = await c.request('GET', '/admin/api/operations/edit-one');
  assert.deepEqual(receipt.json(), saved.json());
});
test('starting from bundled content preserves ordered source text, quantities, identity and original evidence', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const recipe = catalogue.recipes[0]!;
  const result = await c.create('bundled-start', recipe.recipeId);
  assert.equal(result.draft.recipeId, recipe.recipeId);
  assert.equal(result.draft.basedOn?.recipeId, recipe.recipeId);
  assert.deepEqual(
    result.draft.input.ingredients,
    recipe.ingredients.map((row) => ({ rawName: row.rawName, rawMeasure: row.rawMeasure })),
  );
  assert.deepEqual(
    result.draft.input.instructions,
    recipe.instructions.map((row) => ({ rawText: row.rawText, presentation: row.presentation })),
  );
  assert.equal(result.draft.photoUrl, `/admin/api/baseline/${recipe.recipeId}/photo`);
  assert.equal(result.draft.metadata.servings.value, null);
  const db = openAdminDatabase(f.filename);
  const row = db.get<{ original_evidence: string }>(
    'SELECT original_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=1',
    result.draft.draftId,
  )!;
  db.close();
  assert.deepEqual(JSON.parse(row.original_evidence).document.recipe, recipe);
  assert.equal(
    (
      await c.request('POST', '/admin/api/drafts', {
        operationId: 'unknown-source',
        fromRecipeId: '999999',
      })
    ).statusCode,
    404,
  );
});
test('restore creates a fresh draft revision and changes-requested review retains its real actor/note', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const start = await c.create();
  const id = start.draft.draftId;
  const edited = await c.request('PUT', `/admin/api/drafts/${id}`, {
    operationId: 'edit',
    expectedRevision: 1,
    input: { ...start.draft.input, title: 'New title' },
  });
  assert.equal(edited.statusCode, 200);
  const restored = await c.request('POST', `/admin/api/drafts/${id}/restore`, {
    operationId: 'restore',
    expectedRevision: 2,
    sourceRevision: 1,
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().draft.revision, 3);
  assert.equal(restored.json().draft.input.title, '');
  assert.equal(restored.json().draft.approval, null);
  const reviewed = await c.request('POST', `/admin/api/drafts/${id}/reviews`, {
    operationId: 'review',
    expectedRevision: 3,
    decision: 'changes_requested',
    note: 'Keep the exact source measures.',
  });
  assert.equal(reviewed.statusCode, 200);
  assert.equal(reviewed.json().draft.revision, 4);
  assert.equal(reviewed.json().draft.status, 'draft');
  const db = openAdminDatabase(f.filename);
  const evidence = db.get<{ review_evidence: string }>(
    'SELECT review_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=4',
    id,
  )!;
  db.close();
  assert.deepEqual(JSON.parse(evidence.review_evidence), {
    decision: 'changes_requested',
    note: 'Keep the exact source measures.',
    reviewerId: 'fixture-admin',
    reviewedAt: reviewed.json().draft.updatedAt,
    inputRevision: 3,
  });
  await f.reopen();
  for (const path of [`/admin/api/drafts/${id}`, `/admin/api/drafts/${id}/revisions/4`])
    assert.equal(
      (await c.request('GET', path)).json().review.note,
      'Keep the exact source measures.',
    );
  assert.equal(
    (await c.request('GET', `/admin/api/drafts/${id}/history`)).json().items[0].review.decision,
    'changes_requested',
  );
  assert.equal(
    (await c.request('GET', '/admin/api/operations/review')).json().draft.review.inputRevision,
    3,
  );
  assert.deepEqual(
    (
      await c.request('POST', `/admin/api/drafts/${id}/reviews`, {
        operationId: 'review',
        expectedRevision: 3,
        decision: 'changes_requested',
        note: 'Keep the exact source measures.',
      })
    ).json(),
    reviewed.json(),
  );
});
test('API roles, blocked approval and actor-scoped operation receipts are enforced', async (t) => {
  const f = await fixture(t);
  const admin = f.client();
  await admin.login();
  const original = await admin.create('private-operation', catalogue.recipes[0]!.recipeId);
  const id = original.draft.draftId;
  const approval = {
    operationId: 'review-blocked',
    expectedRevision: 1,
    decision: 'approved',
    note: 'Reviewed',
  };
  assert.equal(
    (await admin.request('POST', `/admin/api/drafts/${id}/reviews`, approval)).statusCode,
    409,
  );
  const editor = f.client();
  await editor.login('fixture-editor');
  assert.equal(
    (
      await editor.request('POST', `/admin/api/drafts/${id}/reviews`, {
        ...approval,
        operationId: 'editor-review',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await editor.request('GET', '/admin/api/operations/private-operation')).statusCode,
    404,
  );
  assert.equal(
    (
      await editor.request('POST', '/admin/api/drafts', {
        operationId: 'private-operation',
        fromRecipeId: catalogue.recipes[0]!.recipeId,
      })
    ).statusCode,
    409,
  );
  assert.equal((await admin.request('GET', `/admin/api/drafts/${id}`)).json().revision, 1);
});
test('all draft fields are bounded and unknown fields/unsafe links do not save', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const start = await c.create();
  const id = start.draft.draftId;
  for (const [index, input] of [
    { ...start.draft.input, secret: 'unexpected' },
    { ...start.draft.input, title: 'x'.repeat(501) },
    { ...start.draft.input, videoUrl: 'javascript:alert(1)' },
    { ...start.draft.input, originalSourceUrl: 'https://username:password@example.test/' },
    { ...start.draft.input, ingredients: [{ rawName: 'Salt', rawMeasure: null, quantity: 10 }] },
    {
      ...start.draft.input,
      instructions: Array.from({ length: 501 }, () => ({
        rawText: 'Read',
        presentation: 'passage',
      })),
    },
  ].entries())
    assert.equal(
      (
        await c.request('PUT', `/admin/api/drafts/${id}`, {
          operationId: `invalid-${index}`,
          expectedRevision: 1,
          input,
        })
      ).statusCode,
      400,
    );
  const tooLarge = {
    ...start.draft.input,
    instructions: Array.from({ length: 100 }, () => ({
      rawText: 'x'.repeat(20_000),
      presentation: 'passage',
    })),
  };
  assert.equal(
    (
      await c.request('PUT', `/admin/api/drafts/${id}`, {
        operationId: 'too-large',
        expectedRevision: 1,
        input: tooLarge,
      })
    ).statusCode,
    413,
  );
  assert.equal((await c.request('GET', `/admin/api/drafts/${id}`)).json().revision, 1);
});
test('library has actual bundled recipes, bounded paging and stale cursor rejection', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const first = await c.request('GET', '/admin/api/library?status=bundled');
  assert.equal(first.json().items.length, 50);
  assert.ok(first.json().nextCursor);
  const second = await c.request(
    'GET',
    `/admin/api/library?status=bundled&cursor=${first.json().nextCursor}`,
  );
  assert.equal(second.json().items.length, 50);
  assert.equal(second.json().nextCursor, null);
  assert.equal(
    new Set(
      [...first.json().items, ...second.json().items].map(
        (row: { recipeId: string }) => row.recipeId,
      ),
    ).size,
    100,
  );
  assert.equal(
    (
      await c.request(
        'GET',
        `/admin/api/library?status=bundled&query=chicken&cursor=${first.json().nextCursor}`,
      )
    ).statusCode,
    400,
  );
  await c.create();
  assert.equal(
    (await c.request('GET', `/admin/api/library?status=bundled&cursor=${first.json().nextCursor}`))
      .statusCode,
    409,
  );
  assert.equal((await c.request('GET', '/admin/api/library?status=published')).statusCode, 503);
});
test('role/epoch is rechecked after asynchronous baseline hashing and before any commit', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const db = openAdminDatabase(f.filename);
  const user = db.userById('fixture-admin')!;
  const row = db.get<{ session_id: string }>(
    "SELECT session_id FROM admin_session WHERE json_extract(data,'$.userId')=?",
    user.userId,
  )!;
  const actor: Actor = {
    user: { userId: user.userId, username: user.username, role: user.role },
    authEpoch: user.authEpoch,
    sessionId: row.session_id,
  };
  const repo = new DraftRepository(db, () => new Date());
  const creating = repo.create(actor, 'raced-auth', catalogue.recipes[0]!.recipeId);
  db.run('UPDATE admin_user SET enabled=0 WHERE user_id=?', user.userId);
  await assert.rejects(
    creating,
    (error: unknown) => (error as { statusCode: number }).statusCode === 401,
  );
  assert.equal(db.get<{ count: number }>('SELECT COUNT(*) count FROM admin_draft')!.count, 0);
  db.close();
});
test('SQL failure rolls back revision and receipt together; explicit retry retains operation identity', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const start = await c.create();
  const id = start.draft.draftId;
  const db = openAdminDatabase(f.filename);
  db.run(
    "CREATE TRIGGER fixture_fail_receipt BEFORE INSERT ON admin_operation WHEN NEW.operation_id='retry-save' BEGIN SELECT RAISE(ABORT,'fixture SQL failure'); END",
  );
  const body = {
    operationId: 'retry-save',
    expectedRevision: 1,
    input: { ...start.draft.input, title: 'Preserved local edit' },
  };
  const failed = await c.request('PUT', `/admin/api/drafts/${id}`, body);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.includes('fixture SQL failure'), false);
  assert.equal((await c.request('GET', `/admin/api/drafts/${id}`)).json().revision, 1);
  assert.equal((await c.request('GET', '/admin/api/operations/retry-save')).statusCode, 404);
  db.run('DROP TRIGGER fixture_fail_receipt');
  db.close();
  const saved = await c.request('PUT', `/admin/api/drafts/${id}`, body);
  assert.equal(saved.statusCode, 200);
  await f.reopen();
  const recovered = await c.request('GET', '/admin/api/operations/retry-save');
  assert.deepEqual(recovered.json() as AdminMutation, saved.json());
});
