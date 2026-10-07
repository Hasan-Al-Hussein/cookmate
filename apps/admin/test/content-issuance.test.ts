import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catalogue } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  OVERLAY_LIMITS,
  type OverlayEntry,
  type PublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import { authoredFixture } from '../../../packages/catalogue/test/content-fixtures';
import { published } from '../../../packages/catalogue/test/content-overlay-fixtures';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { openAdminDatabase, type Actor } from '../src/storage/database';
import { DraftRepository, sha256 } from '../src/drafts/repository';
import { AdminMedia } from '../src/media/service';
import { PreparedPublicationArchive } from '../src/publishing/archive';
import { createContentOverlaySigner } from '../src/publishing/signer';
import { IssuedOverlayStore, fingerprintIssuanceRequest } from '../src/publishing/issuedStore';
import { ContentOverlayIssuer, type IssueOverlayRequest } from '../src/publishing/issuance';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-issuance-test-'));
  const adminFile = join(directory, 'admin.sqlite');
  const issuedFile = join(directory, 'issued.sqlite');
  let db = openAdminDatabase(adminFile);
  let clock = Date.parse('2026-10-01T06:00:00.000Z');
  const now = () => new Date(clock);
  db.createFirstAdministrator({
    userId: 'fixture-admin',
    username: 'fixture.admin',
    passwordHash: '$argon2id$synthetic-unused-test-hash',
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
      recentAuthAt: clock,
      absoluteExpiresAt: clock + 86_400_000,
    }),
    clock + 86_400_000,
  );
  let drafts = new DraftRepository(db, now);
  let draft = (await drafts.create(actor, 'fixture-create', catalogue.recipes[0]!.recipeId)).draft;
  draft = drafts.mutate(actor, draft.draftId, 'fixture-edit', draft.revision, {
    kind: 'save',
    input: { ...draft.input, changeSummary: 'Synthetic issuance test only.' },
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
        statement: `Synthetic ${scope} assertion, not actual permission.`,
        sourceUrl: null,
      },
    }).draft;
  }
  draft = drafts.mutate(actor, draft.draftId, 'fixture-review', draft.revision, {
    kind: 'review',
    decision: 'approved',
    note: 'Test fixture; no real content approval.',
  }).draft;
  const media = () =>
    new AdminMedia(
      db,
      drafts,
      join(directory, 'media'),
      fileURLToPath(new URL('../../../packages/catalogue/assets/photos/', import.meta.url)),
      now,
    );
  const prepared = () => new PreparedPublicationArchive(db, media(), now);
  const preparation = await prepared().prepare(actor, 'prepare-fixture', {
    draftId: draft.draftId,
    expectedRevision: draft.revision,
    revisionId: 'fixture-revision-1',
  });
  const signer = createContentOverlaySigner({
    keyId: 'test-key',
    privateKey: generateKeyPairSync('ed25519').privateKey,
  });
  const trustVerifier = createContentTrustVerifier([signer.trustKey]);
  let issued = new IssuedOverlayStore(issuedFile, trustVerifier);
  const member: OverlayEntry = {
    state: 'current',
    ref: { ...preparation.publication.revision.ref },
    publicationFingerprint: preparation.publication.publicationFingerprint,
  };
  const request = (): IssueOverlayRequest => ({
    expectedHead: issued.head(),
    entries: [{ ...member }],
  });
  const service = (
    overrides: Partial<ConstructorParameters<typeof ContentOverlayIssuer>[0]> = {},
  ) =>
    new ContentOverlayIssuer({
      db,
      prepared: prepared(),
      issued,
      media: media(),
      signer,
      trustVerifier,
      now,
      ...overrides,
    });
  const sql = <T>(body: (connection: DatabaseSync) => T): T => {
    const connection = new DatabaseSync(issuedFile);
    try {
      return body(connection);
    } finally {
      connection.close();
    }
  };
  t.after(async () => {
    issued.close();
    db.close();
    const target = resolve(directory);
    const inside = relative(resolve(tmpdir()), target);
    if (
      inside.startsWith('..') ||
      isAbsolute(inside) ||
      !inside.startsWith('cookmate-issuance-test-')
    )
      throw new Error('Fixture cleanup escaped temporary workspace');
    await rm(target, { recursive: true, force: true });
  });
  return {
    actor,
    preparation,
    member,
    request,
    service,
    sql,
    signer,
    trustVerifier,
    media,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
    get issued() {
      return issued;
    },
    get db() {
      return db;
    },
    edit() {
      draft = drafts.mutate(actor, draft.draftId, `edit-${draft.revision}`, draft.revision, {
        kind: 'save',
        input: { ...draft.input, changeSummary: 'Changed after retained preparation.' },
      }).draft;
    },
    reopen() {
      issued.close();
      db.close();
      db = openAdminDatabase(adminFile);
      drafts = new DraftRepository(db, now);
      issued = new IssuedOverlayStore(issuedFile, trustVerifier);
    },
    rows() {
      return sql((connection) =>
        ['issued_release', 'issued_publication', 'issued_media', 'issued_operation'].map((table) =>
          Number(connection.prepare(`SELECT COUNT(*) count FROM ${table}`).get()!.count),
        ),
      );
    },
  };
}

test('real signed issuance retains exact reviewed content/media and survives independent store restart', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const first = await f.service().issue(f.actor, 'issue-one', request);
  assert.equal(first.status, 'issued_not_activated');
  assert.equal(first.envelope.manifest.sequence, 1);
  assert.deepEqual(first.envelope.manifest.entries, request.entries);
  assert.equal(first.actorId, f.actor.user.userId);
  assert.equal(first.envelope.signature.keyId, f.signer.trustKey.keyId);
  const photo = f.preparation.publication.revision.document.media[0]!;
  assert.equal(sha256(f.issued.media(photo.sha256)!), photo.sha256);
  assert.deepEqual(
    await f.issued.readPublication(f.member.ref.recipeId, f.member.ref.revisionId),
    f.preparation.publication,
  );
  f.reopen();
  assert.equal(f.issued.head()!.releaseId, first.envelope.manifest.releaseId);
  assert.deepEqual(await f.service().issue(f.actor, 'issue-one', request), first);
  assert.deepEqual(await f.issued.readRelease(first.envelope.manifest.releaseId), {
    manifest: first.envelope.manifest,
    fingerprint: first.envelope.fingerprint,
  });
  assert.equal(
    await f.issued.receipt('another-actor', 'issue-one', first.requestFingerprint),
    null,
  );
  assert.equal(f.rows()[0], 1);
});

test('operation replay recovers the original release after later issuance; changed requests cannot reuse it', async (t) => {
  const f = await fixture(t);
  const firstRequest = f.request();
  const first = await f.service().issue(f.actor, 'one', firstRequest);
  const second = await f.service().issue(f.actor, 'two', f.request());
  assert.equal(second.envelope.manifest.sequence, 2);
  assert.deepEqual(await f.service().issue(f.actor, 'one', firstRequest), first);
  await assert.rejects(f.service().issue(f.actor, 'one', f.request()), {
    code: 'operation_conflict',
  });
  await assert.rejects(f.service().issue(f.actor, 'three', firstRequest), {
    code: 'release_head_changed',
  });
  assert.equal(f.rows()[0], 2);
});

test('committed response recovery needs live authorization but does not repeat recent-review authentication', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const first = await f.service().issue(f.actor, 'recover-later', request);
  f.advance(16 * 60 * 1000);
  assert.deepEqual(await f.service().issue(f.actor, 'recover-later', request), first);
  await assert.rejects(f.service().issue(f.actor, 'new-operation', f.request()), {
    code: 'reauth_required',
  });
  f.db.run('UPDATE admin_user SET enabled=0 WHERE user_id=?', f.actor.user.userId);
  await assert.rejects(f.service().issue(f.actor, 'recover-later', request), {
    code: 'session_expired',
  });
});

test('concurrent identical requests converge to one receipt; different operations race through head CAS', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const [a, b] = await Promise.all([
    f.service().issue(f.actor, 'same', request),
    f.service().issue(f.actor, 'same', request),
  ]);
  assert.deepEqual(a, b);
  assert.equal(f.rows()[0], 1);
  const next = f.request();
  const races = await Promise.allSettled([
    f.service().issue(f.actor, 'race-a', next),
    f.service().issue(f.actor, 'race-b', next),
  ]);
  assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = races.find((result) => result.status === 'rejected');
  assert.equal(failed?.status === 'rejected' && failed.reason.code, 'release_head_changed');
  assert.equal(f.rows()[0], 2);
});

test('permission review changes during media staging prevent committing any release', async (t) => {
  const f = await fixture(t);
  const media = f.media();
  let changed = false;
  await assert.rejects(
    f
      .service({
        media: {
          asset: (hash) => media.asset(hash),
          async baseline(id) {
            if (!changed) {
              changed = true;
              f.edit();
            }
            return media.baseline(id);
          },
        },
      })
      .issue(f.actor, 'change-review', f.request()),
    { code: 'approval_changed' },
  );
  assert.deepEqual(f.rows(), [0, 0, 0, 0]);
  assert.equal(f.issued.head(), null);
});

test('revocation during asynchronous verification cannot cross the final authority guard', async (t) => {
  const f = await fixture(t);
  const media = f.media();
  let changed = false;
  await assert.rejects(
    f
      .service({
        media: {
          asset: (hash) => media.asset(hash),
          async baseline(id) {
            if (!changed) {
              changed = true;
              f.db.run('UPDATE admin_user SET enabled=0 WHERE user_id=?', f.actor.user.userId);
            }
            return media.baseline(id);
          },
        },
      })
      .issue(f.actor, 'revoked', f.request()),
  );
  assert.equal(changed, true);
  assert.deepEqual(f.rows(), [0, 0, 0, 0]);
  assert.equal(f.issued.head(), null);
});

test('untrusted signing key and corrupt media cannot issue content', async (t) => {
  const f = await fixture(t);
  const alien = createContentOverlaySigner({
    keyId: 'test-key',
    privateKey: generateKeyPairSync('ed25519').privateKey,
  });
  await assert.rejects(
    f.service({ signer: alien }).issue(f.actor, 'wrong-key', f.request()),
    /overlay_untrusted/,
  );
  const media = f.media();
  await assert.rejects(
    f
      .service({
        media: {
          asset: (hash) => media.asset(hash),
          async baseline(id) {
            const asset = await media.baseline(id);
            return { ...asset, bytes: Buffer.from('corrupted') };
          },
        },
      })
      .issue(f.actor, 'bad-media', f.request()),
    /overlay_media_unverified/,
  );
  assert.deepEqual(f.rows(), [0, 0, 0, 0]);
});

test('database interruption rolls back release, publication, media, head and receipt together', async (t) => {
  const f = await fixture(t);
  f.sql((db) =>
    db.exec(
      "CREATE TRIGGER fixture_fail BEFORE INSERT ON issued_operation BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
    ),
  );
  const request = f.request();
  await assert.rejects(
    f.service().issue(f.actor, 'retry-after-fault', request),
    /injected write failure/,
  );
  assert.deepEqual(f.rows(), [0, 0, 0, 0]);
  assert.equal(f.issued.head(), null);
  f.sql((db) => db.exec('DROP TRIGGER fixture_fail'));
  f.reopen();
  assert.equal(
    (await f.service().issue(f.actor, 'retry-after-fault', request)).envelope.manifest.sequence,
    1,
  );
});

test('archive and rollback advance sequence; withdrawals remain sticky and omissions cannot resurrect content', async (t) => {
  const f = await fixture(t);
  await f.service().issue(f.actor, 'initial', f.request());
  await assert.rejects(
    f.service().issue(f.actor, 'omission', { expectedHead: f.issued.head(), entries: [] }),
  );
  const archive = await f.service().issue(f.actor, 'archive', {
    expectedHead: f.issued.head(),
    entries: [{ ...f.member, state: 'archived', reason: 'Synthetic archive.' }],
  });
  assert.equal(archive.envelope.manifest.sequence, 2);
  const baseline = await createBundledRecipeRevision(f.member.ref.recipeId, async (value) =>
    sha256(value),
  );
  const rollback = await f.service().issue(f.actor, 'rollback', {
    expectedHead: f.issued.head(),
    entries: [{ state: 'current', ref: { ...baseline.ref }, publicationFingerprint: null }],
  });
  assert.equal(rollback.envelope.manifest.sequence, 3);
  const withdrawn = await f.service().issue(f.actor, 'withdraw', {
    expectedHead: f.issued.head(),
    entries: [
      { state: 'withdrawn', recipeId: f.member.ref.recipeId, reason: 'Synthetic withdrawal.' },
    ],
  });
  assert.equal(withdrawn.envelope.manifest.sequence, 4);
  await assert.rejects(
    f.service().issue(f.actor, 'resurrect', f.request()),
    /overlay_not_cumulative/,
  );
  assert.equal(f.issued.head()!.sequence, 4);
});

test('previously issued exact publication can be reissued after later draft edits without restoring draft authority', async (t) => {
  const f = await fixture(t);
  const initial = await f.service().issue(f.actor, 'historical-initial', f.request());
  f.edit();
  const archived = await f.service().issue(f.actor, 'historical-archive', {
    expectedHead: f.issued.head(),
    entries: [{ ...f.member, state: 'archived', reason: 'Synthetic archive before rollback.' }],
  });
  assert.equal(archived.envelope.manifest.sequence, 2);
  const draftBefore = new DraftRepository(f.db, () => new Date('2026-10-01T06:00:00.000Z')).read(
    f.preparation.draftId,
  );
  assert.equal(draftBefore.status, 'draft');
  const request = f.request();
  const rollback = await f.service().issue(f.actor, 'historical-rollback', request);
  assert.equal(rollback.envelope.manifest.sequence, 3);
  assert.deepEqual(rollback.envelope.manifest.entries, initial.envelope.manifest.entries);
  assert.deepEqual(
    new DraftRepository(f.db, () => new Date('2026-10-01T06:00:00.000Z')).read(
      f.preparation.draftId,
    ),
    draftBefore,
  );
  f.reopen();
  assert.deepEqual(await f.service().issue(f.actor, 'historical-rollback', request), rollback);
  assert.deepEqual(
    (await f.service().exportPackage(f.actor, initial.envelope.manifest.releaseId)).envelope,
    initial.envelope,
  );
});

test('a stale never-issued preparation cannot gain historical reissue authority', async (t) => {
  const f = await fixture(t);
  f.edit();
  await assert.rejects(f.service().issue(f.actor, 'not-issued-rollback', f.request()), {
    code: 'approval_changed',
  });
  assert.equal(f.issued.head(), null);
  assert.deepEqual(f.rows(), [0, 0, 0, 0]);
});

test('new publication references require their exact durable preparation and exact request fields', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service().issue(f.actor, 'extra', { ...f.request(), activate: true } as IssueOverlayRequest),
    { code: 'invalid_release_request' },
  );
  await assert.rejects(
    f.service().issue(f.actor, 'wrong-ref', {
      expectedHead: null,
      entries: [{ ...f.member, publicationFingerprint: '0'.repeat(64) }],
    }),
    { code: 'preparation_required' },
  );
  await assert.rejects(
    f.service().issue(f.actor, 'unknown-revision', {
      expectedHead: null,
      entries: [{ ...f.member, ref: { ...f.member.ref, revisionId: 'not-prepared' } }],
    }),
    { code: 'preparation_required' },
  );
  assert.deepEqual(f.rows(), [0, 0, 0, 0]);
});

test('retained release signature, publication and media corruption fail closed on read', async (t) => {
  const f = await fixture(t);
  const receipt = await f.service().issue(f.actor, 'issued', f.request());
  const id = receipt.envelope.manifest.releaseId;
  const document = JSON.stringify(receipt.envelope);
  f.sql((db) =>
    db.prepare('UPDATE issued_release SET document=? WHERE id=?').run(
      JSON.stringify({
        ...receipt.envelope,
        signature: { ...receipt.envelope.signature, value: '0'.repeat(128) },
      }),
      id,
    ),
  );
  await assert.rejects(f.issued.readRelease(id), { code: 'issued_integrity' });
  f.sql((db) => db.prepare('UPDATE issued_release SET document=? WHERE id=?').run(document, id));
  f.sql((db) =>
    db
      .prepare('UPDATE issued_publication SET document=?')
      .run(
        JSON.stringify({ ...f.preparation.publication, publicationFingerprint: '0'.repeat(64) }),
      ),
  );
  await assert.rejects(f.issued.readPublication(f.member.ref.recipeId, f.member.ref.revisionId));
  const photo = f.preparation.publication.revision.document.media[0]!;
  f.sql((db) =>
    db
      .prepare('UPDATE issued_media SET bytes=? WHERE hash=?')
      .run(Buffer.from('corrupt'), photo.sha256),
  );
  assert.throws(() => f.issued.media(photo.sha256), { code: 'issued_integrity' });
});

test('a receipt cannot point to a different genuine signed release and redundant sequence must agree', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const first = await f.service().issue(f.actor, 'first', request);
  const second = await f.service().issue(f.actor, 'second', f.request());
  f.sql((db) =>
    db
      .prepare('UPDATE issued_operation SET release_id=? WHERE operation=?')
      .run(second.envelope.manifest.releaseId, 'first'),
  );
  await assert.rejects(f.service().issue(f.actor, 'first', request), { code: 'issued_integrity' });
  f.sql((db) =>
    db
      .prepare('UPDATE issued_release SET sequence=99 WHERE id=?')
      .run(first.envelope.manifest.releaseId),
  );
  await assert.rejects(f.issued.readRelease(first.envelope.manifest.releaseId), {
    code: 'issued_integrity',
  });
});

test('oversized retained values are rejected by bounded SQL reads before JS materialization', async (t) => {
  const f = await fixture(t);
  const receipt = await f.service().issue(f.actor, 'bounded-read', f.request());
  const id = receipt.envelope.manifest.releaseId;
  f.sql((db) =>
    db
      .prepare('UPDATE issued_release SET document=zeroblob(?) WHERE id=?')
      .run(8 * 1024 * 1024 + 1, id),
  );
  await assert.rejects(f.issued.readRelease(id), { code: 'issued_integrity' });
  f.sql((db) =>
    db
      .prepare('UPDATE issued_release SET document=? WHERE id=?')
      .run(JSON.stringify(receipt.envelope), id),
  );
  f.sql((db) =>
    db.prepare('UPDATE issued_publication SET document=zeroblob(?)').run(8 * 1024 * 1024 + 1),
  );
  await assert.rejects(f.issued.readPublication(f.member.ref.recipeId, f.member.ref.revisionId), {
    code: 'issued_integrity',
  });
  const photo = f.preparation.publication.revision.document.media[0]!;
  f.sql((db) =>
    db
      .prepare('UPDATE issued_media SET bytes=zeroblob(?) WHERE hash=?')
      .run(20 * 1024 * 1024 + 1, photo.sha256),
  );
  assert.throws(() => f.issued.media(photo.sha256), { code: 'issued_integrity' });
  f.sql((db) => db.prepare('UPDATE issued_meta SET head=zeroblob(1025)').run());
  assert.throws(() => f.issued.head(), { code: 'issued_integrity' });
});

test('caller mutation after admission cannot change the signed request or actor identity', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const original = structuredClone(request);
  const actor = structuredClone(f.actor);
  const media = f.media();
  const receipt = await f
    .service({
      media: {
        asset: (hash) => media.asset(hash),
        async baseline(id) {
          request.entries.length = 0;
          actor.user.userId = 'caller-mutation';
          return media.baseline(id);
        },
      },
    })
    .issue(actor, 'immutable-admission', request);
  assert.deepEqual(receipt.envelope.manifest.entries, original.entries);
  assert.equal(receipt.actorId, f.actor.user.userId);
});

test('wrong SQLite storage classes and embedded NUL cannot bypass retained byte bounds', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const receipt = await f.service().issue(f.actor, 'wrong-storage-class', request);
  const photo = f.preparation.publication.revision.document.media[0]!;
  f.sql((db) =>
    db
      .prepare("UPDATE issued_media SET bytes=char(0)||printf('%*s',1048576,'x') WHERE hash=?")
      .run(photo.sha256),
  );
  assert.throws(() => f.issued.media(photo.sha256), { code: 'issued_integrity' });
  f.sql((db) => {
    // Simulate a damaged on-disk row in this disposable fixture only.
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare(
      "UPDATE issued_operation SET release_id=?||char(0)||printf('%*s',1048576,'x') WHERE operation=?",
    ).run(receipt.envelope.manifest.releaseId, 'wrong-storage-class');
  });
  await assert.rejects(f.service().issue(f.actor, 'wrong-storage-class', request), {
    code: 'issued_integrity',
  });
  f.sql((db) =>
    db
      .prepare('UPDATE issued_release SET document=? WHERE id=?')
      .run(Buffer.from(JSON.stringify(receipt.envelope)), receipt.envelope.manifest.releaseId),
  );
  await assert.rejects(f.issued.readRelease(receipt.envelope.manifest.releaseId), {
    code: 'issued_integrity',
  });
});

test('resolve cancels an in-flight issuer before final commit, preserving the exact cancellation across reopen', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const fingerprint = fingerprintIssuanceRequest(request.expectedHead, request.entries);
  const media = f.media();
  let cancelled = false;
  await assert.rejects(
    f
      .service({
        media: {
          asset: (hash) => media.asset(hash),
          async baseline(id) {
            if (!cancelled) {
              cancelled = true;
              assert.deepEqual(
                await f.service().resolve(f.actor, 'cancel-in-flight', fingerprint),
                {
                  status: 'cancelled',
                  actorId: f.actor.user.userId,
                  operationId: 'cancel-in-flight',
                  requestFingerprint: fingerprint,
                },
              );
            }
            return media.baseline(id);
          },
        },
      })
      .issue(f.actor, 'cancel-in-flight', request),
    { code: 'operation_cancelled' },
  );
  assert.equal(cancelled, true);
  assert.deepEqual(f.rows(), [0, 0, 0, 0]);
  f.reopen();
  await assert.rejects(f.service().issue(f.actor, 'cancel-in-flight', request), {
    code: 'operation_cancelled',
  });
  await assert.rejects(f.service().resolve(f.actor, 'cancel-in-flight', '0'.repeat(64)), {
    code: 'operation_conflict',
  });
  assert.equal(
    (await f.service().issue(f.actor, 'fresh-reviewed-operation', request)).status,
    'issued_not_activated',
  );
});

test('committed resolution never creates a cancellation; revoked identity after awaited verification cannot recover', async (t) => {
  const f = await fixture(t);
  const receipt = await f.service().issue(f.actor, 'committed-resolve', f.request());
  assert.deepEqual(
    await f.service().resolve(f.actor, receipt.operationId, receipt.requestFingerprint),
    { status: 'committed', receipt },
  );
  assert.equal(
    f.sql((sql) => sql.prepare('SELECT COUNT(*) n FROM issued_cancelled').get()!.n),
    0,
  );
  const original = f.issued.receipt.bind(f.issued);
  f.issued.receipt = async (...args) => {
    const result = await original(...args);
    f.db.run('UPDATE admin_user SET enabled=0 WHERE user_id=?', f.actor.user.userId);
    return result;
  };
  await assert.rejects(
    f.service().resolve(f.actor, receipt.operationId, receipt.requestFingerprint),
    { code: 'session_expired' },
  );
  assert.equal(
    f.sql((sql) => sql.prepare('SELECT COUNT(*) n FROM issued_cancelled').get()!.n),
    0,
  );
});

test('failed cancellation transaction does not consume its operation or mutate the issuance head', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const fingerprint = fingerprintIssuanceRequest(request.expectedHead, request.entries);
  f.sql((sql) =>
    sql.exec(
      "CREATE TRIGGER fixture_cancel_fail BEFORE INSERT ON issued_cancelled BEGIN SELECT RAISE(ABORT,'fixture cancellation failure'); END;",
    ),
  );
  await assert.rejects(
    f.service().resolve(f.actor, 'cancel-rollback', fingerprint),
    /fixture cancellation failure/,
  );
  assert.equal(
    f.sql((sql) => sql.prepare('SELECT COUNT(*) n FROM issued_cancelled').get()!.n),
    0,
  );
  assert.equal(f.issued.head(), null);
  f.sql((sql) => sql.exec('DROP TRIGGER fixture_cancel_fail'));
  const receipt = await f.service().issue(f.actor, 'cancel-rollback', request);
  assert.deepEqual(await f.service().resolve(f.actor, 'cancel-rollback', fingerprint), {
    status: 'committed',
    receipt,
  });
});

test('version-one journal migration preserves committed release, media and operation bytes exactly', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const receipt = await f.service().issue(f.actor, 'before-version-two', request);
  const before = f.sql((sql) => ({
    releases: sql.prepare('SELECT * FROM issued_release ORDER BY sequence').all(),
    operations: sql.prepare('SELECT * FROM issued_operation ORDER BY actor,operation').all(),
    media: sql.prepare('SELECT hash,hex(bytes) bytes FROM issued_media ORDER BY hash').all(),
  }));
  f.sql((sql) => sql.exec('DROP TABLE issued_cancelled; UPDATE issued_meta SET version=1'));
  f.reopen();
  assert.deepEqual(
    await f.service().resolve(f.actor, receipt.operationId, receipt.requestFingerprint),
    { status: 'committed', receipt },
  );
  assert.deepEqual(
    f.sql((sql) => ({
      releases: sql.prepare('SELECT * FROM issued_release ORDER BY sequence').all(),
      operations: sql.prepare('SELECT * FROM issued_operation ORDER BY actor,operation').all(),
      media: sql.prepare('SELECT hash,hex(bytes) bytes FROM issued_media ORDER BY hash').all(),
    })),
    before,
  );
});

test('preparation admission stops at the first count or byte limit before signing and commit', async (t) => {
  const f = await fixture(t);
  for (const kind of ['count', 'bytes'] as const) {
    const candidates: PublishedRecipeRevision[] = [];
    for (
      let index = 0;
      index < (kind === 'count' ? OVERLAY_LIMITS.publications + 1 : 10);
      index++
    ) {
      const document = authoredFixture(String(900000 + index));
      if (kind === 'bytes') {
        assert.equal(document.kind, 'authored');
        if (document.kind !== 'authored') assert.fail();
        document.recipe.instructions = Array.from({ length: 80 }, (_, passage) => ({
          sequence: passage + 1,
          rawText: 'Synthetic bounded preparation passage. '.padEnd(12000, 'x'),
          presentation: 'passage' as const,
        }));
      }
      candidates.push(await published(document));
    }
    let expectedReads = 0;
    let bytes = 0;
    for (const candidate of candidates) {
      if (expectedReads === OVERLAY_LIMITS.publications) break;
      expectedReads++;
      bytes += Buffer.byteLength(canonicalContentJson(candidate));
      if (bytes > OVERLAY_LIMITS.aggregateContentBytes) break;
    }
    let reads = 0,
      signs = 0,
      commits = 0;
    const prepared = new PreparedPublicationArchive(
      f.db,
      f.media(),
      () => new Date('2026-10-01T06:00:00.000Z'),
    );
    // Exercise the admission boundary with structurally valid, hashed publications and bounded
    // synthetic preparation receipts. Actual preparation authority is covered by the fixture above.
    prepared.readRevision = async (_actor, recipeId) => {
      reads++;
      const publication = candidates.find(
        (candidate) => candidate.revision.ref.recipeId === recipeId,
      )!;
      return { ...f.preparation, publication };
    };
    const originalCommit = f.issued.commit.bind(f.issued);
    f.issued.commit = (input) => {
      commits++;
      return originalCommit(input);
    };
    await assert.rejects(
      f
        .service({
          prepared,
          signer: {
            ...f.signer,
            async signManifest(manifest) {
              signs++;
              return f.signer.signManifest(manifest);
            },
          },
        })
        .issue(f.actor, `budget-${kind}`, {
          expectedHead: null,
          entries: candidates.map((publication) => ({
            state: 'current',
            ref: publication.revision.ref,
            publicationFingerprint: publication.publicationFingerprint,
          })),
        }),
      { code: 'release_content_limit' },
    );
    assert.equal(reads, expectedReads);
    assert.equal(reads < candidates.length, true);
    assert.equal(signs, 0);
    assert.equal(commits, 0);
    assert.equal(f.issued.head(), null);
    f.issued.commit = originalCommit;
  }
});
