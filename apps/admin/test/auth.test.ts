import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAdminDatabase } from '../src/storage/database';
import { buildAdminServer } from '../src/server';
import { hashPassword } from '../src/auth/passwords';
import { ABSOLUTE_MS, IDLE_MS, createSessionStore } from '../src/auth/sessions';
import type { Session } from 'fastify';
import { fixture, fixturePassword } from './helpers';

test('construction permits root static registration before ready and rejects unsafe transport', async (t) => {
  const f = await fixture(t);
  f.app.get('/admin/fixture', async () => ({ ready: true }));
  assert.equal((await f.client().request('GET', '/admin/fixture')).statusCode, 200);
  assert.throws(() => buildAdminServer({ ...f.options, origin: 'http://localhost:3444' }));
  assert.throws(() => buildAdminServer({ ...f.options, allowInsecureLoopback: false }));
  assert.throws(() => buildAdminServer({ ...f.options, origin: 'https://127.0.0.1:3444' }));
});
test('real password verification, session rotation, cookie flags and CSRF are enforced', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const initial = await c.request('GET', '/admin/api/session');
  const oldCookie = c.cookie;
  assert.equal(initial.json().user, null);
  assert.equal(initial.json().configured, true);
  assert.equal(initial.headers['cache-control'], 'no-store');
  const csrf = initial.json().csrfToken as string;
  assert.equal(
    (
      await c.request('POST', '/admin/api/session', {
        username: 'fixture.admin',
        password: fixturePassword,
      })
    ).statusCode,
    403,
  );
  c.csrf = csrf;
  assert.equal(
    (
      await c.request('POST', '/admin/api/session', {
        username: 'fixture.admin',
        password: 'wrong-password-123',
      })
    ).statusCode,
    401,
  );
  const signed = await c.request('POST', '/admin/api/session', {
    username: 'fixture.admin',
    password: fixturePassword,
  });
  assert.equal(signed.statusCode, 200);
  assert.notEqual(c.cookie, oldCookie);
  c.csrf = signed.json().csrfToken;
  assert.equal(signed.json().user.role, 'administrator');
  assert.equal(JSON.stringify(signed.json()).includes('password'), false);
  assert.equal((await c.request('GET', '/admin/api/library')).statusCode, 200);
  assert.equal(
    (await c.request('POST', '/admin/api/drafts', { operationId: 'positive-signed-in-write' }))
      .statusCode,
    200,
  );
  const header = String(signed.headers['set-cookie']);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/i);
  assert.doesNotMatch(header, /Domain=/i);
  assert.equal(
    (await c.request('GET', '/admin/api/library', undefined, { host: 'evil.test' })).statusCode,
    403,
  );
  assert.equal(
    (
      await c.request(
        'POST',
        '/admin/api/drafts',
        { operationId: 'bad-origin' },
        { origin: 'http://evil.test' },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await c.request('POST', '/admin/api/drafts', { operationId: 'no-origin' }, { origin: '' }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await c.request(
        'POST',
        '/admin/api/drafts',
        { operationId: 'bad-csrf' },
        { 'x-csrf-token': 'invalid' },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await c.request('GET', '/admin/api/library', undefined, { cookie: oldCookie })).statusCode,
    401,
  );
});
test('protected endpoints reject anonymous requests before upload decoding', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  assert.equal((await c.request('GET', '/admin/api/library')).statusCode, 401);
  const s = await c.request('GET', '/admin/api/session');
  c.csrf = s.json().csrfToken;
  const denied = await c.request(
    'POST',
    '/admin/api/drafts/unknown/media',
    Buffer.from('not multipart'),
    {
      'content-type': 'multipart/form-data; boundary=x',
      'x-operation-id': 'upload',
      'x-draft-revision': '1',
    },
  );
  assert.equal(denied.statusCode, 401);
});
test('logout, enabled state and authentication epoch are durable gates', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const oldCookie = c.cookie;
  assert.equal((await c.request('DELETE', '/admin/api/session')).statusCode, 204);
  assert.equal(
    (await c.request('GET', '/admin/api/library', undefined, { cookie: oldCookie })).statusCode,
    401,
  );
  await c.login();
  const db = openAdminDatabase(f.filename);
  db.run('UPDATE admin_user SET auth_epoch=auth_epoch+1 WHERE user_id=?', 'fixture-admin');
  db.close();
  assert.equal((await c.request('GET', '/admin/api/library')).statusCode, 401);
  await c.login();
  const d = openAdminDatabase(f.filename);
  d.run('UPDATE admin_user SET enabled=0 WHERE user_id=?', 'fixture-admin');
  d.close();
  assert.equal((await c.request('GET', '/admin/api/library')).statusCode, 401);
});
test('idle and absolute expiry cannot be extended by page visits', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  f.advance(IDLE_MS + 1);
  assert.equal((await c.request('GET', '/admin/api/library')).statusCode, 401);
  await c.login();
  for (let elapsed = 0; elapsed < ABSOLUTE_MS; elapsed += 10 * 60 * 1000) {
    f.advance(10 * 60 * 1000);
    const response = await c.request('GET', '/admin/api/library');
    if (elapsed + 10 * 60 * 1000 < ABSOLUTE_MS) assert.equal(response.statusCode, 200);
    else assert.equal(response.statusCode, 401);
  }
});
test('session persistence survives reopening and revoked session cannot be resurrected by a late save', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  await f.reopen();
  assert.equal((await c.request('GET', '/admin/api/library')).statusCode, 200);
  const db = openAdminDatabase(f.filename);
  const clock = () => new Date();
  const store = createSessionStore(db, clock);
  const value = {
    cookie: { originalMaxAge: IDLE_MS },
    absoluteExpiresAt: Date.now() + ABSOLUTE_MS,
  } as Session;
  const set = () =>
    new Promise<void>((resolve, reject) =>
      store.set('fixture-late-id', value, (e) => (e ? reject(e) : resolve())),
    );
  await set();
  await new Promise<void>((resolve, reject) =>
    store.destroy('fixture-late-id', (e) => (e ? reject(e) : resolve())),
  );
  await assert.rejects(set(), (error: unknown) => (error as { statusCode: number }).statusCode === 401);
  assert.equal(
    db.get('SELECT 1 FROM admin_session WHERE session_id=?', 'fixture-late-id'),
    undefined,
  );
  db.close();
});
test('bootstrap is first-user-only and password bounds match operator setup', async () => {
  const db = openAdminDatabase(':memory:');
  try {
    db.createFirstAdministrator({
      userId: 'first',
      username: 'first',
      passwordHash: await hashPassword('A valid fixture password!'),
    });
    assert.equal(db.countUsers(), 1);
    assert.throws(() =>
      db.createFirstAdministrator({
        userId: 'second',
        username: 'second',
        passwordHash: '$argon2id$fixture',
      }),
    );
  } finally {
    db.close();
  }
  await assert.rejects(hashPassword('short'));
  await assert.rejects(hashPassword('x'.repeat(129)));
});
test('sign-in attempts have an actual rate boundary', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  const initial = await c.request('GET', '/admin/api/session');
  c.csrf = initial.json().csrfToken;
  let response;
  for (let i = 0; i < 9; i++)
    response = await c.request('POST', '/admin/api/session', {
      username: 'missing.operator',
      password: 'wrong-password-123',
    });
  assert.equal(response!.statusCode, 429);
});
test('late authenticated responses and stale cookies cannot overwrite a newer login', async t => {
  const f=await fixture(t); let entered!:()=>void; let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.app.addHook('preHandler',async request=>{if(request.headers['x-fixture-delay']==='yes'){entered();await gate;}});
  const c=f.client(); await c.login(); const originalCookie=c.cookie;
  const delayed=c.request('GET','/admin/api/library',undefined,{'x-fixture-delay':'yes'}); await waiting;
  await c.login('fixture-editor'); const currentCookie=c.cookie; assert.notEqual(currentCookie,originalCookie);
  release(); const response=await delayed;
  assert.equal(response.statusCode,401); assert.equal(response.headers['set-cookie'],undefined); assert.equal(c.cookie,currentCookie);
  const stale=await c.request('GET','/admin/api/library',undefined,{cookie:originalCookie});
  assert.equal(stale.statusCode,401); assert.equal(stale.headers['set-cookie'],undefined); assert.equal(c.cookie,currentCookie);
  assert.equal((await c.request('GET','/admin/api/library')).statusCode,200);
});
