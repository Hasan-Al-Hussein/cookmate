import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import type { Session } from 'fastify';
import { catalogue } from '@cookmate/catalogue';
import type {
  AdminDraft,
  AdminDraftInput,
  AdminRightsScope,
  AdminRightsStatus,
  AdminSession,
} from '../src/contracts';
import { openAdminDatabase } from '../src/storage/database';
import { RIGHTS_RECENT_AUTH_MS, scopedRightsContent } from '../src/drafts/rights';
import { createSessionStore } from '../src/auth/sessions';
import { fixture, fixturePassword, multipartPhoto, type Client } from './helpers';

async function setup(t: TestContext) {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  let draft = (await c.create('rights-start', catalogue.recipes[0]!.recipeId)).draft;
  let sequence = 0;
  const save = async (patch: Partial<AdminDraftInput>) => {
    const result = await c.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
      operationId: `save-${++sequence}`,
      expectedRevision: draft.revision,
      input: { ...draft.input, ...patch },
    });
    assert.equal(result.statusCode, 200, result.body);
    draft = result.json().draft as AdminDraft;
    return draft;
  };
  await save({
    changeSummary: 'Synthetic fixture review of retained source.',
    videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
  });
  const rightsBody = (scope: AdminRightsScope, status: AdminRightsStatus = 'permitted') => ({
    operationId: `rights-${++sequence}`,
    expectedRevision: draft.revision,
    scope,
    status,
    statement: `Synthetic fixture evidence for ${scope}.`,
    sourceUrl: 'https://example.test/fixture-permission',
  });
  const record = async (
    scope: AdminRightsScope,
    status: AdminRightsStatus = 'permitted',
    client = c,
  ) => {
    const body = rightsBody(scope, status);
    const result = await client.request('POST', `/admin/api/drafts/${draft.draftId}/rights`, body);
    assert.equal(result.statusCode, 200, result.body);
    draft = result.json().draft as AdminDraft;
    return { body, mutation: result.json() };
  };
  const approveBody = () => ({
    operationId: `approve-${++sequence}`,
    expectedRevision: draft.revision,
    decision: 'approved',
    note: 'Synthetic fixture approval.',
  });
  const approve = async () => {
    const body = approveBody();
    const result = await c.request('POST', `/admin/api/drafts/${draft.draftId}/reviews`, body);
    if (result.statusCode === 200) draft = result.json().draft as AdminDraft;
    return { body, result };
  };
  const grantAll = async () => {
    for (const scope of ['recipe_text', 'photo', 'video_embed'] as const) await record(scope);
  };
  return {
    f,
    c,
    save,
    record,
    rightsBody,
    approveBody,
    approve,
    grantAll,
    get draft() {
      return draft;
    },
  };
}
async function upload(c: Client, draft: AdminDraft, operationId: string, colour: string) {
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: colour } })
    .png()
    .toBuffer();
  const form = multipartPhoto(bytes);
  const result = await c.request('POST', `/admin/api/drafts/${draft.draftId}/media`, form.payload, {
    ...form.headers,
    'x-operation-id': operationId,
    'x-draft-revision': String(draft.revision),
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}

test('each applicable permission is required before final approval, with exact server evidence and immutable history', async (t) => {
  const s = await setup(t);
  const before = s.draft;
  assert.deepEqual(before.rights, []);
  const db = openAdminDatabase(s.f.filename);
  const original = db.get<{ original_evidence: string }>(
    'SELECT original_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=1',
    before.draftId,
  )!.original_evidence;
  for (const scope of ['recipe_text', 'photo', 'video_embed'] as const) {
    assert.equal((await s.approve()).result.statusCode, 409);
    const inputRevision = s.draft.revision;
    const { mutation } = await s.record(scope);
    const record = (mutation.draft as AdminDraft).rights!.find((item) => item.scope === scope)!;
    assert.equal(record.reviewerId, 'fixture-admin');
    assert.equal(record.reviewedAt, mutation.draft.updatedAt);
    assert.equal(record.inputRevision, inputRevision);
    assert.match(record.contentBinding, /^[0-9a-f]{64}$/);
    assert.equal(mutation.draft.approval, null);
  }
  assert.deepEqual(s.draft.validationIssues, []);
  const approved = await s.approve();
  assert.equal(approved.result.statusCode, 200, approved.result.body);
  assert.equal(s.draft.status, 'reviewed');
  assert.equal(s.draft.approval?.revision, s.draft.revision);
  assert.equal(s.draft.review?.inputRevision, s.draft.revision - 1);
  const retained = db.all<{ original_evidence: string }>(
    'SELECT original_evidence FROM admin_draft_revision WHERE draft_id=?',
    before.draftId,
  );
  assert.ok(retained.every((row) => row.original_evidence === original));
  db.close();
  await s.f.reopen();
  const reopened = await s.c.request('GET', `/admin/api/drafts/${before.draftId}`);
  assert.deepEqual(reopened.json(), s.draft);
  const history = (await s.c.request('GET', `/admin/api/drafts/${before.draftId}/history`)).json()
    .items;
  assert.equal(history[0].rights.length, 3);
  assert.deepEqual(history.at(-1).rights, []);
  assert.deepEqual(
    (await s.c.request('GET', `/admin/api/operations/${approved.body.operationId}`)).json(),
    approved.result.json(),
  );
});

test('reviewer and administrator can record evidence; editor and client-supplied server fields cannot', async (t) => {
  const s = await setup(t);
  const editor = s.f.client();
  const reviewer = s.f.client();
  await editor.login('fixture-editor');
  await reviewer.login('fixture-reviewer');
  const body = s.rightsBody('recipe_text');
  const path = `/admin/api/drafts/${s.draft.draftId}/rights`;
  assert.equal((await editor.request('POST', path, body)).statusCode, 403);
  for (const extra of [
    { reviewerId: 'fixture-admin' },
    { reviewedAt: new Date().toISOString() },
    { inputRevision: 1 },
    { contentBinding: 'a'.repeat(64) },
  ])
    assert.equal((await s.c.request('POST', path, { ...body, ...extra })).statusCode, 400);
  const recorded = await s.record('recipe_text', 'permitted', reviewer);
  assert.equal(recorded.mutation.draft.rights[0].reviewerId, 'fixture-reviewer');
  assert.equal(
    (await s.c.request('GET', `/admin/api/operations/${recorded.body.operationId}`)).statusCode,
    404,
  );
  const db = openAdminDatabase(s.f.filename);
  db.run("UPDATE admin_user SET role='editor' WHERE user_id='fixture-reviewer'");
  db.close();
  assert.equal(
    (await reviewer.request('GET', `/admin/api/operations/${recorded.body.operationId}`))
      .statusCode,
    403,
  );
  assert.equal((await reviewer.request('POST', path, recorded.body)).statusCode, 403);
});

test('evidence fields reject invalid status, scope, empty or excessive statements and unsafe URLs without writes', async (t) => {
  const s = await setup(t);
  const body = s.rightsBody('recipe_text');
  for (const patch of [
    { scope: 'all' },
    { status: 'approved' },
    { statement: ' \n ' },
    { statement: 'x'.repeat(2001) },
    { statement: 'bad\0text' },
    { sourceUrl: '' },
    { sourceUrl: 'javascript:alert(1)' },
    { sourceUrl: 'https://name:password@example.test/' },
    { sourceUrl: 'https://example.test/' + 'x'.repeat(2048) },
  ]) {
    const result = await s.c.request('POST', `/admin/api/drafts/${s.draft.draftId}/rights`, {
      ...body,
      ...patch,
    });
    assert.equal(result.statusCode, 400, result.body);
  }
  assert.equal(
    (await s.c.request('GET', `/admin/api/drafts/${s.draft.draftId}`)).json().revision,
    s.draft.revision,
  );
  const accepted = await s.c.request('POST', `/admin/api/drafts/${s.draft.draftId}/rights`, {
    ...body,
    statement: 'x'.repeat(2000),
    sourceUrl: null,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
});

test('permission scope is unavailable for absent photo or video and no authorship implies permission', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const draft = (await c.create()).draft;
  assert.deepEqual(draft.rights, []);
  for (const scope of ['photo', 'video_embed']) {
    const result = await c.request('POST', `/admin/api/drafts/${draft.draftId}/rights`, {
      operationId: `missing-${scope}`,
      expectedRevision: 1,
      scope,
      status: 'permitted',
      statement: 'Fixture evidence.',
      sourceUrl: null,
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().error.code, 'rights_scope_unavailable');
  }
});

test('text edits invalidate only text permission, video edits only video, and source credits invalidate their dependent evidence', async (t) => {
  const s = await setup(t);
  await s.grantAll();
  const reviewed = s.draft;
  const originalTextBinding = reviewed.rights!.find(
    (r) => r.scope === 'recipe_text',
  )!.contentBinding;
  await s.save({ changeSummary: 'Summary-only change preserves scope permissions.' });
  assert.deepEqual(s.draft.rights, reviewed.rights);
  await s.save({
    ingredients: s.draft.input.ingredients.map((row, index) =>
      index ? row : { ...row, rawMeasure: 'A different fixture measure' },
    ),
  });
  assert.deepEqual(
    s.draft.rights!.map((r) => r.scope),
    ['photo', 'video_embed'],
  );
  const historical = (
    await s.c.request('GET', `/admin/api/drafts/${s.draft.draftId}/revisions/${reviewed.revision}`)
  ).json() as AdminDraft;
  assert.equal(
    historical.rights!.find((r) => r.scope === 'recipe_text')!.contentBinding,
    originalTextBinding,
  );
  await s.record('recipe_text');
  assert.notEqual(
    s.draft.rights!.find((r) => r.scope === 'recipe_text')!.contentBinding,
    originalTextBinding,
  );
  await s.save({ videoUrl: 'https://youtu.be/12345678901' });
  assert.deepEqual(
    s.draft.rights!.map((r) => r.scope),
    ['recipe_text', 'photo'],
  );
  await s.record('video_embed');
  await s.save({ credits: [{ label: 'Different fixture credit', url: null }] });
  assert.deepEqual(s.draft.rights, []);
});

test('text bindings cover exact ordered source fields while photo and video retain independent identities', async (t) => {
  const s = await setup(t);
  const db = openAdminDatabase(s.f.filename);
  const original = scopedRightsContent(db, s.draft).bindings;
  const ingredient = { rawName: 'Fixture ingredient', rawMeasure: null };
  const instruction = { rawText: 'Fixture passage', presentation: 'passage' as const };
  const inputs: Partial<AdminDraftInput>[] = [
    { title: `${s.draft.input.title} changed` },
    { description: 'Changed description' },
    { category: 'Changed category' },
    { cuisine: 'Changed cuisine' },
    { rawTags: 'Changed tags' },
    { ingredients: [ingredient, ...s.draft.input.ingredients] },
    { instructions: [instruction, ...s.draft.input.instructions] },
    {
      instructions: s.draft.input.instructions.map((row, index) =>
        index
          ? row
          : { ...row, presentation: row.presentation === 'passage' ? 'heading' : 'passage' },
      ),
    },
  ];
  for (const patch of inputs) {
    const changed = scopedRightsContent(db, {
      ...s.draft,
      input: { ...s.draft.input, ...patch },
    }).bindings;
    assert.notEqual(changed.recipe_text, original.recipe_text);
    assert.equal(changed.photo, original.photo);
    assert.equal(changed.video_embed, original.video_embed);
  }
  const ordered = {
    ...s.draft,
    input: {
      ...s.draft.input,
      ingredients: [ingredient, { rawName: 'Other', rawMeasure: '1' }],
      instructions: [instruction, { rawText: 'Other passage', presentation: 'passage' as const }],
    },
  };
  const orderedBinding = scopedRightsContent(db, ordered).bindings.recipe_text;
  for (const patch of [
    { ingredients: [...ordered.input.ingredients].reverse() },
    { instructions: [...ordered.input.instructions].reverse() },
    { ingredients: [{ ...ingredient, rawMeasure: '' }, ordered.input.ingredients[1]!] },
  ])
    assert.notEqual(
      scopedRightsContent(db, { ...ordered, input: { ...ordered.input, ...patch } }).bindings
        .recipe_text,
      orderedBinding,
    );
  for (const patch of [
    { originalSourceUrl: 'https://example.test/different-source' },
    { recipePage: 'https://example.test/different-collection' },
    { credits: [{ label: 'Changed credit', url: null }] },
  ]) {
    const changed = scopedRightsContent(db, {
      ...s.draft,
      input: { ...s.draft.input, ...patch },
    }).bindings;
    for (const scope of ['recipe_text', 'photo', 'video_embed'] as const)
      assert.notEqual(changed[scope], original[scope]);
  }
  db.close();
});

test('photo permission binds the selected immutable asset and does not change global rights or another draft', async (t) => {
  const s = await setup(t);
  const red = await upload(s.c, s.draft, 'red-photo', 'red');
  await s.save({ photoAssetId: red.assetId });
  await s.grantAll();
  const previous = s.draft;
  const green = await upload(s.c, s.draft, 'green-photo', 'green');
  await s.save({ photoAssetId: green.assetId });
  assert.deepEqual(
    s.draft.rights!.map((r) => r.scope),
    ['recipe_text', 'video_embed'],
  );
  await s.record('photo');
  assert.notEqual(
    previous.rights!.find((r) => r.scope === 'photo')!.contentBinding,
    s.draft.rights!.find((r) => r.scope === 'photo')!.contentBinding,
  );
  const db = openAdminDatabase(s.f.filename);
  const assets = db.all<{ document: string }>('SELECT document FROM admin_asset');
  assert.ok(assets.every((row) => JSON.parse(row.document).rightsStatus === 'unreviewed'));
  db.close();
  const sibling = (await s.c.create('sibling', s.draft.recipeId)).draft;
  const saved = await s.c.request('PUT', `/admin/api/drafts/${sibling.draftId}`, {
    operationId: 'sibling-asset',
    expectedRevision: 1,
    input: { ...sibling.input, photoAssetId: green.assetId },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().draft.rights, []);
});

test('restricted and explicitly unreviewed evidence blocks approval; removing video needs no video permission', async (t) => {
  const s = await setup(t);
  await s.grantAll();
  for (const status of ['restricted', 'unreviewed'] as const) {
    await s.record('recipe_text', status);
    assert.ok(
      s.draft.validationIssues.some((issue) =>
        issue.includes(`Recipe text permission is ${status}`),
      ),
    );
    assert.equal((await s.approve()).result.statusCode, 409);
  }
  await s.record('recipe_text');
  await s.save({ videoUrl: null });
  assert.deepEqual(
    s.draft.rights!.map((r) => r.scope),
    ['recipe_text', 'photo'],
  );
  assert.equal((await s.approve()).result.statusCode, 200);
});

test('restore clears permissions and approval even when restoring an approved revision', async (t) => {
  const s = await setup(t);
  await s.grantAll();
  assert.equal((await s.approve()).result.statusCode, 200);
  const approved = s.draft;
  await s.save({ title: 'Fixture edited title' });
  assert.equal(s.draft.approval, null);
  const restored = await s.c.request('POST', `/admin/api/drafts/${s.draft.draftId}/restore`, {
    operationId: 'restore-reviewed',
    expectedRevision: s.draft.revision,
    sourceRevision: approved.revision,
  });
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(restored.json().draft.rights, []);
  assert.equal(restored.json().draft.approval, null);
  assert.equal(restored.json().draft.status, 'draft');
  assert.deepEqual(
    (
      await s.c.request(
        'GET',
        `/admin/api/drafts/${s.draft.draftId}/revisions/${approved.revision}`,
      )
    ).json().rights,
    approved.rights,
  );
});

test('CAS, exact retries and cancellation fences cover rights operations across reopen', async (t) => {
  const s = await setup(t);
  const first = await s.record('recipe_text');
  const path = `/admin/api/drafts/${s.draft.draftId}/rights`;
  assert.deepEqual((await s.c.request('POST', path, first.body)).json(), first.mutation);
  assert.equal(
    (await s.c.request('POST', path, { ...first.body, statement: 'Different request.' })).json()
      .error.code,
    'operation_conflict',
  );
  assert.equal(
    (await s.c.request('POST', path, { ...first.body, operationId: 'stale-rights' })).json().error
      .code,
    'revision_conflict',
  );
  const pending = s.rightsBody('photo');
  assert.equal(
    (await s.c.request('POST', `/admin/api/operations/${pending.operationId}/cancel`, {})).json()
      .status,
    'cancelled',
  );
  await s.f.reopen();
  assert.equal((await s.c.request('POST', path, pending)).json().error.code, 'operation_cancelled');
  assert.deepEqual(
    (await s.c.request('POST', `/admin/api/operations/${first.body.operationId}/cancel`, {})).json()
      .mutation,
    first.mutation,
  );
  const db = openAdminDatabase(s.f.filename);
  db.run(
    'INSERT INTO admin_operation VALUES(?,?,?,?,?)',
    'future-kind',
    'fixture-admin',
    'future-workflow',
    '',
    '{}',
  );
  db.close();
  assert.equal(
    (await s.c.request('POST', '/admin/api/operations/future-kind/cancel', {})).json().error.code,
    'operation_type',
  );
});

test('new decisions require recent persisted identity but committed evidence and approval receipts remain recoverable after expiry', async (t) => {
  const s = await setup(t);
  await s.grantAll();
  const committedApproval = await s.approve();
  assert.equal(committedApproval.result.statusCode, 200);
  const pending = s.rightsBody('photo');
  s.f.advance(RIGHTS_RECENT_AUTH_MS + 1);
  const path = `/admin/api/drafts/${s.draft.draftId}`;
  assert.equal(
    (await s.c.request('POST', `${path}/rights`, pending)).json().error.code,
    'reauth_required',
  );
  assert.equal(
    (await s.c.request('POST', `${path}/reviews`, s.approveBody())).json().error.code,
    'reauth_required',
  );
  assert.deepEqual(
    (await s.c.request('POST', `${path}/reviews`, committedApproval.body)).json(),
    committedApproval.result.json(),
  );
  const reauth = await s.c.request('POST', '/admin/api/reauth', { password: fixturePassword });
  assert.equal(reauth.statusCode, 200, reauth.body);
  s.c.csrf = (reauth.json() as AdminSession).csrfToken!;
  const saved = await s.c.request('POST', `${path}/rights`, pending);
  assert.equal(saved.statusCode, 200, saved.body);
  s.f.advance(RIGHTS_RECENT_AUTH_MS + 1);
  assert.deepEqual((await s.c.request('POST', `${path}/rights`, pending)).json(), saved.json());
  assert.deepEqual(
    (await s.c.request('GET', `/admin/api/operations/${pending.operationId}`)).json(),
    saved.json(),
  );
});

test('a delayed rolling session save cannot undo successful reauthentication or prevent a fresh approval', async (t) => {
  const s = await setup(t);
  await s.grantAll();
  const db = openAdminDatabase(s.f.filename);
  const before = db.get<{ session_id: string; data: string }>(
    "SELECT session_id,data FROM admin_session WHERE json_extract(data,'$.userId')='fixture-admin'",
  )!;
  const store = createSessionStore(db, s.f.options.now);
  s.f.advance(RIGHTS_RECENT_AUTH_MS + 1);
  const reauth = await s.c.request('POST', '/admin/api/reauth', { password: fixturePassword });
  assert.equal(reauth.statusCode, 200, reauth.body);
  s.c.csrf = (reauth.json() as AdminSession).csrfToken!;
  const confirmedAt = s.f.options.now().getTime();
  for (const withoutRecent of [false, true]) {
    const stale = JSON.parse(before.data) as Session;
    if (withoutRecent) delete stale.recentAuthAt;
    await new Promise<void>((resolve, reject) =>
      store.set(before.session_id, stale, (error) => (error ? reject(error) : resolve())),
    );
    const retained = JSON.parse(
      db.get<{ data: string }>(
        'SELECT data FROM admin_session WHERE session_id=?',
        before.session_id,
      )!.data,
    ) as Session;
    assert.equal(retained.recentAuthAt, confirmedAt);
    assert.equal(
      retained.absoluteExpiresAt,
      (JSON.parse(before.data) as Session).absoluteExpiresAt,
    );
  }
  db.close();
  const approval = await s.approve();
  assert.equal(approval.result.statusCode, 200, approval.result.body);
  assert.equal(s.draft.status, 'reviewed');
});

test('missing and future recent identity fail closed without mutating a draft', async (t) => {
  const s = await setup(t);
  const db = openAdminDatabase(s.f.filename);
  for (const recent of [null, s.f.options.now().getTime() + 1_000_000]) {
    db.run(
      "UPDATE admin_session SET data=json_set(data,'$.recentAuthAt',?) WHERE json_extract(data,'$.userId')='fixture-admin'",
      recent,
    );
    const result = await s.c.request(
      'POST',
      `/admin/api/drafts/${s.draft.draftId}/rights`,
      s.rightsBody('recipe_text'),
    );
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().error.code, 'reauth_required');
  }
  db.close();
  assert.equal(
    (await s.c.request('GET', `/admin/api/drafts/${s.draft.draftId}`)).json().revision,
    s.draft.revision,
  );
});

test('legacy documents acquire no inferred permissions and current readiness explains missing evidence', async (t) => {
  const s = await setup(t);
  const db = openAdminDatabase(s.f.filename);
  db.run(
    "UPDATE admin_draft_revision SET document=json_remove(document,'$.rights') WHERE draft_id=?",
    s.draft.draftId,
  );
  db.close();
  await s.f.reopen();
  const current = (
    await s.c.request('GET', `/admin/api/drafts/${s.draft.draftId}`)
  ).json() as AdminDraft;
  assert.deepEqual(current.rights, []);
  assert.ok(
    current.validationIssues.some((issue) =>
      issue.includes('Recipe text permission is unreviewed'),
    ),
  );
  const history = (await s.c.request('GET', `/admin/api/drafts/${s.draft.draftId}/history`)).json()
    .items;
  assert.ok(history.every((row: { rights: unknown[] }) => row.rights.length === 0));
});

test('a changed packaged baseline association fails closed for previews, permissions and receipts without rewriting retained evidence', async (t) => {
  const s = await setup(t);
  const granted = await s.record('photo');
  const db = openAdminDatabase(s.f.filename);
  const row = db.get<{ original_evidence: string }>(
    'SELECT original_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=1',
    s.draft.draftId,
  )!;
  const retained = JSON.parse(row.original_evidence);
  const pending = s.rightsBody('photo');
  for (const patch of [
    { photoKey: 'photos/999999.jpg' },
    { sha256: '0'.repeat(64) },
    { bytes: retained.document.media[0].bytes + 1 },
    { assetId: `sha256:${'0'.repeat(64)}` },
  ]) {
    const changed = JSON.stringify({
      ...retained,
      document: { ...retained.document, media: [{ ...retained.document.media[0], ...patch }] },
    });
    db.run(
      'UPDATE admin_draft_revision SET original_evidence=? WHERE draft_id=? AND revision=1',
      changed,
      s.draft.draftId,
    );
    for (const path of [
      `/admin/api/drafts/${s.draft.draftId}`,
      `/admin/api/drafts/${s.draft.draftId}/revisions/${granted.mutation.draft.revision}`,
      `/admin/api/operations/${granted.body.operationId}`,
    ]) {
      const response = await s.c.request('GET', path);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, 'baseline_photo_unavailable');
      assert.equal(response.body.includes('photoUrl'), false);
    }
    const refused = await s.c.request(
      'POST',
      `/admin/api/drafts/${s.draft.draftId}/rights`,
      pending,
    );
    assert.equal(refused.json().error.code, 'baseline_photo_unavailable');
    assert.equal(
      db.get<{ revision: number }>(
        'SELECT revision FROM admin_draft WHERE draft_id=?',
        s.draft.draftId,
      )!.revision,
      s.draft.revision,
    );
    assert.equal(
      db.get<{ original_evidence: string }>(
        'SELECT original_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=1',
        s.draft.draftId,
      )!.original_evidence,
      changed,
    );
  }
  db.run(
    'UPDATE admin_draft_revision SET original_evidence=? WHERE draft_id=? AND revision=1',
    row.original_evidence,
    s.draft.draftId,
  );
  db.close();
  assert.deepEqual(
    (await s.c.request('GET', `/admin/api/operations/${granted.body.operationId}`)).json(),
    granted.mutation,
  );
});

test('failed receipt persistence rolls back permission evidence and revision; explicit same-ID retry is safe', async (t) => {
  const s = await setup(t);
  const body = { ...s.rightsBody('recipe_text'), operationId: 'rights-sql-failure' };
  const db = openAdminDatabase(s.f.filename);
  db.run(
    "CREATE TRIGGER fixture_fail_rights BEFORE INSERT ON admin_operation WHEN NEW.operation_id='rights-sql-failure' BEGIN SELECT RAISE(ABORT,'fixture SQL failure'); END",
  );
  const path = `/admin/api/drafts/${s.draft.draftId}/rights`;
  const failed = await s.c.request('POST', path, body);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.includes('fixture SQL failure'), false);
  const current = (await s.c.request('GET', `/admin/api/drafts/${s.draft.draftId}`)).json();
  assert.equal(current.revision, s.draft.revision);
  assert.deepEqual(current.rights, []);
  db.run('DROP TRIGGER fixture_fail_rights');
  db.close();
  assert.equal((await s.c.request('POST', path, body)).statusCode, 200);
});
