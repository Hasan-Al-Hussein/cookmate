import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogue } from '@cookmate/catalogue';
import { openAdminDatabase, type Actor, type AdminDatabase } from '../src/storage/database';
import { DraftRepository } from '../src/drafts/repository';
import { fixture } from './helpers';

function actor(db: AdminDatabase): Actor {
  const user = db.userById('fixture-admin')!;
  const row = db.get<{ session_id: string }>(
    "SELECT session_id FROM admin_session WHERE json_extract(data,'$.userId')=?",
    user.userId,
  )!;
  return {
    user: { userId: user.userId, username: user.username, role: user.role },
    authEpoch: user.authEpoch,
    sessionId: row.session_id,
  };
}
test('crash-before-dispatch resolution persists a cancellation fence across reopen and blocks old ID replay', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  assert.equal((await c.request('GET', '/admin/api/operations/never-dispatched')).statusCode, 404);
  const cancelled = await c.request('POST', '/admin/api/operations/never-dispatched/cancel', {});
  assert.equal(cancelled.statusCode, 200);
  assert.deepEqual(cancelled.json(), { operationId: 'never-dispatched', status: 'cancelled' });
  await f.reopen();
  assert.deepEqual(
    (await c.request('POST', '/admin/api/operations/never-dispatched/cancel', {})).json(),
    cancelled.json(),
  );
  const replay = await c.request('POST', '/admin/api/drafts', { operationId: 'never-dispatched' });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().error.code, 'operation_cancelled');
  assert.equal((await c.request('GET', '/admin/api/operations/never-dispatched')).statusCode, 404);
  assert.equal((await c.request('GET', '/admin/api/library?status=draft')).json().items.length, 0);
});
test('cancellation racing asynchronous baseline hashing wins before the delayed commit', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const db = openAdminDatabase(f.filename);
  try {
    const repo = new DraftRepository(db, f.options.now);
    const current = actor(db);
    const inFlight = repo.create(current, 'delayed-create', catalogue.recipes[0]!.recipeId);
    assert.deepEqual(repo.cancel(current, 'delayed-create'), {
      operationId: 'delayed-create',
      status: 'cancelled',
    });
    await assert.rejects(
      inFlight,
      (error: unknown) => (error as { code: string }).code === 'operation_cancelled',
    );
    assert.equal(db.get<{ count: number }>('SELECT COUNT(*) count FROM admin_draft')!.count, 0);
  } finally {
    db.close();
  }
});
test('a committed draft operation is returned rather than cancelled or undone', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const saved = await c.create('committed-before-cancel');
  const resolved = await c.request(
    'POST',
    '/admin/api/operations/committed-before-cancel/cancel',
    {},
  );
  assert.equal(resolved.statusCode, 200);
  assert.deepEqual(resolved.json(), {
    operationId: saved.operationId,
    status: 'committed',
    mutation: saved,
  });
  assert.deepEqual(await c.create('committed-before-cancel'), saved);
  assert.deepEqual(
    (await c.request('GET', `/admin/api/drafts/${saved.draft.draftId}`)).json(),
    saved.draft,
  );
});
test('save/restore/review IDs are fenced and another actor cannot cancel or recover them', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const saved = await c.create();
  const id = saved.draft.draftId;
  for (const operationId of ['cancel-save', 'cancel-restore', 'cancel-review'])
    assert.equal(
      (await c.request('POST', `/admin/api/operations/${operationId}/cancel`, {})).statusCode,
      200,
    );
  assert.equal(
    (
      await c.request('PUT', `/admin/api/drafts/${id}`, {
        operationId: 'cancel-save',
        expectedRevision: 1,
        input: { ...saved.draft.input, title: 'Late edit' },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await c.request('POST', `/admin/api/drafts/${id}/restore`, {
        operationId: 'cancel-restore',
        expectedRevision: 1,
        sourceRevision: 1,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await c.request('POST', `/admin/api/drafts/${id}/reviews`, {
        operationId: 'cancel-review',
        expectedRevision: 1,
        decision: 'changes_requested',
        note: 'Late review',
      })
    ).statusCode,
    409,
  );
  const other = f.client();
  await other.login('fixture-editor');
  assert.equal(
    (await other.request('POST', '/admin/api/operations/cancel-save/cancel', {})).statusCode,
    409,
  );
  assert.equal(
    (await other.request('POST', `/admin/api/operations/${saved.operationId}/cancel`, {}))
      .statusCode,
    409,
  );
  assert.equal((await c.request('GET', `/admin/api/drafts/${id}`)).json().revision, 1);
});
test('upload operations cannot be resolved as draft cancellations and cancellation rechecks live authority', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const db = openAdminDatabase(f.filename);
  try {
    db.run(
      'INSERT INTO admin_operation VALUES(?,?,?,?,?)',
      'fixture-upload',
      'fixture-admin',
      'upload',
      'fixture-hash',
      '{}',
    );
    assert.equal(
      (await c.request('POST', '/admin/api/operations/fixture-upload/cancel', {})).statusCode,
      409,
    );
    const current = actor(db);
    const repo = new DraftRepository(db, f.options.now);
    db.run('UPDATE admin_user SET auth_epoch=auth_epoch+1 WHERE user_id=?', current.user.userId);
    assert.throws(
      () => repo.cancel(current, 'revoked-cancel'),
      (error: unknown) => (error as { statusCode: number }).statusCode === 401,
    );
    assert.equal(
      db.get('SELECT 1 FROM admin_operation WHERE operation_id=?', 'revoked-cancel'),
      undefined,
    );
  } finally {
    db.close();
  }
});
