import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { catalogue } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  CONTENT_LIMITS,
  OVERLAY_LIMITS,
  PUBLICATION_MAX_BYTES,
  type OverlayHead,
  type ReleaseTrustVerifier,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { authoredFixture } from '../../../packages/catalogue/test/content-fixtures';
import { published } from '../../../packages/catalogue/test/content-overlay-fixtures';
import { sha256, DraftRepository } from '../src/drafts/repository';
import { openAdminDatabase, type Actor } from '../src/storage/database';
import { AdminMedia } from '../src/media/service';
import { PreparedPublicationArchive } from '../src/publishing/archive';
import { ContentOverlayIssuer } from '../src/publishing/issuance';
import { createContentOverlaySigner } from '../src/publishing/signer';
import { IssuedOverlayStore, fingerprintIssuanceRequest } from '../src/publishing/issuedStore';
import {
  captureIssuedDelivery,
  ISSUED_DELIVERY_LIMITS,
  type IssuedReleasePackage,
} from '../src/publishing/delivery';
import { fixture } from './helpers';

const path = '/admin/api/publication/releases';
async function deliveryFixture(t: TestContext) {
  const pair = generateKeyPairSync('ed25519');
  const signer = createContentOverlaySigner({
    keyId: 'private-delivery-fixture',
    privateKey: pair.privateKey,
  });
  const trust = [
    {
      keyId: signer.trustKey.keyId,
      publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
        'hex',
      ),
    },
  ];
  const f = await fixture(t, (directory) => ({
    publication: {
      issuedDatabaseFile: join(directory, 'issued.sqlite'),
      signingKeyId: trust[0]!.keyId,
      signingPrivateKey: pair.privateKey,
      trustedKeys: trust,
    },
  }));
  const issuedFile = join(f.directory, 'issued.sqlite');
  const verifier = createContentTrustVerifier(trust);
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#2d5035' } })
    .png()
    .toBuffer();
  const mediaHash = sha256(bytes);
  const document = authoredFixture('90001');
  document.recipe.photoKey = `photos/${mediaHash}.png`;
  document.media[0] = {
    ...document.media[0]!,
    assetId: `sha256:${mediaHash}`,
    sha256: mediaHash,
    bytes: bytes.length,
    mimeType: 'image/png',
    photoKey: document.recipe.photoKey,
    dimensions: { ...document.media[0]!.dimensions!, width: 2, height: 2 },
  };
  const publication = await published(document);
  const entry = {
    state: 'current' as const,
    ref: publication.revision.ref,
    publicationFingerprint: publication.publicationFingerprint,
  };
  async function seed(
    previous: OverlayHead | null = null,
    withdrawn = false,
    replacement?: typeof publication,
  ) {
    const replacementEntry = replacement
      ? {
          state: 'current' as const,
          ref: replacement.revision.ref,
          publicationFingerprint: replacement.publicationFingerprint,
        }
      : entry;
    const envelope = await signer.signManifest({
      formatVersion: 2,
      releaseId: `delivery-${(previous?.sequence ?? 0) + 1}`,
      sequence: (previous?.sequence ?? 0) + 1,
      previous,
      createdAt: '2026-10-01T12:00:00.000Z',
      minimumReaderVersion: 1,
      baseline: { ...catalogue.identity },
      entries: withdrawn
        ? [{ state: 'withdrawn', recipeId: '90001', reason: 'Synthetic withdrawal.' }]
        : replacement && replacement.revision.ref.recipeId !== entry.ref.recipeId
          ? [entry, replacementEntry]
          : [replacementEntry],
    });
    const issued = new IssuedOverlayStore(issuedFile, verifier);
    try {
      issued.commit({
        expectedHead: previous,
        receipt: {
          status: 'issued_not_activated',
          actorId: 'fixture-admin',
          operationId: `issue-${envelope.manifest.sequence}`,
          requestFingerprint: fingerprintIssuanceRequest(previous, envelope.manifest.entries),
          envelope,
        },
        publications: replacement ? [replacement] : previous ? [] : [publication],
        media: previous ? [] : [{ hash: mediaHash, bytes }],
        assertActor() {},
        assertAuthority() {},
      });
    } finally {
      issued.close();
    }
    return {
      releaseId: envelope.manifest.releaseId,
      sequence: envelope.manifest.sequence,
      fingerprint: envelope.fingerprint,
    };
  }
  const first = await seed();
  const client = f.client();
  await client.login();
  const sql = <Value>(body: (database: DatabaseSync) => Value) => {
    const database = new DatabaseSync(issuedFile);
    try {
      return body(database);
    } finally {
      database.close();
    }
  };
  async function withIssuer<Value>(
    trustVerifier: ReleaseTrustVerifier,
    body: (
      issuer: ContentOverlayIssuer,
      actor: Actor,
      db: ReturnType<typeof openAdminDatabase>,
    ) => Promise<Value>,
  ) {
    const db = openAdminDatabase(f.filename),
      issued = new IssuedOverlayStore(issuedFile, trustVerifier);
    const actor: Actor = {
      user: { userId: 'fixture-admin', username: 'fixture.admin', role: 'administrator' },
      authEpoch: 1,
      sessionId: 'delivery-direct-session',
    };
    db.run(
      'INSERT OR REPLACE INTO admin_session VALUES(?,?,?)',
      actor.sessionId,
      JSON.stringify({
        userId: actor.user.userId,
        authEpoch: 1,
        recentAuthAt: f.options.now().getTime() - 3_600_000,
        absoluteExpiresAt: f.options.now().getTime() + 86_400_000,
      }),
      f.options.now().getTime() + 86_400_000,
    );
    const media = new AdminMedia(
      db,
      new DraftRepository(db, f.options.now),
      f.options.mediaDirectory,
      f.options.bundledPhotoDirectory,
      f.options.now,
    );
    const issuer = new ContentOverlayIssuer({
      db,
      issued,
      media,
      prepared: new PreparedPublicationArchive(db, media, f.options.now),
      signer,
      trustVerifier,
      now: f.options.now,
    });
    try {
      return await body(issuer, actor, db);
    } finally {
      issued.close();
      db.close();
    }
  }
  return {
    ...f,
    newClient: f.client,
    client,
    first,
    seed,
    sql,
    withIssuer,
    verifier,
    signer,
    publication,
    bytes,
    mediaHash,
    issuedFile,
  };
}

test('private package and exact member media export survive later withdrawal and reopen, without claiming adoption', async (t) => {
  const f = await deliveryFixture(t);
  const response = await f.client.request('GET', `${path}/${f.first.releaseId}/package`);
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json() as IssuedReleasePackage;
  assert.equal(result.formatVersion, 1);
  assert.equal(result.status, 'issued_export_not_adopted');
  assert.deepEqual(result.publications, [f.publication]);
  assert.deepEqual(result.media, [
    { sha256: f.mediaHash, bytes: f.bytes.length, mimeType: 'image/png' },
  ]);
  assert.deepEqual(Object.keys(result).sort(), [
    'envelope',
    'formatVersion',
    'media',
    'publications',
    'status',
  ]);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.includes('PRIVATE KEY'), false);
  assert.equal(response.body.includes('publicKeyHex'), false);
  const image = await f.client.request('GET', `${path}/${f.first.releaseId}/media/${f.mediaHash}`);
  assert.equal(image.statusCode, 200, image.body);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(image.rawPayload, f.bytes);
  const second = await f.seed(f.first);
  const next = (
    await f.client.request('GET', `${path}/${second.releaseId}/package`)
  ).json() as IssuedReleasePackage;
  assert.deepEqual(next.envelope.manifest.previous, f.first);
  assert.deepEqual(next.publications, []);
  assert.deepEqual(next.media, []);
  const denied = await f.client.request('GET', `${path}/${second.releaseId}/media/${f.mediaHash}`);
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.json().error.code, 'issued_media_unknown');
  await f.seed(second, true);
  await f.reopen();
  assert.equal(
    (await f.client.request('GET', `${path}/${f.first.releaseId}/package`)).body,
    response.body,
    'historical administrator export remains exact; consumers must enforce the newest withdrawal',
  );
  assert.equal(
    (await f.client.request('GET', `${path}/${f.first.releaseId}/media/${'a'.repeat(64)}`))
      .statusCode,
    404,
  );
  assert.equal((await f.client.request('GET', `${path}/unknown/package`)).statusCode, 404);
  assert.equal(
    (await f.client.request('GET', `${path}/${f.first.releaseId}/package?unrecognized=1`))
      .statusCode,
    400,
  );
  assert.equal(
    (await f.client.request('GET', `${path}/${f.first.releaseId}/media/not-a-sha256`)).statusCode,
    400,
  );
});

test('private delivery requires current administrator authority and stays unavailable without explicit configuration', async (t) => {
  const disabled = await fixture(t);
  const operator = disabled.client();
  await operator.login();
  assert.equal((await operator.request('GET', `${path}/release-fixture/package`)).statusCode, 503);
  const f = await deliveryFixture(t);
  for (const suffix of ['package', `media/${f.mediaHash}`]) {
    const url = `${path}/${f.first.releaseId}/${suffix}`;
    assert.equal((await f.newClient().request('GET', url)).statusCode, 401);
    for (const role of ['fixture-editor', 'fixture-reviewer']) {
      const client = f.newClient();
      await client.login(role);
      assert.equal((await client.request('GET', url)).statusCode, 403);
    }
  }
});

test(
  'both exports reauthorize after awaited cryptographic verification, but recent authentication may be old',
  { timeout: 15_000 },
  async (t) => {
    const f = await deliveryFixture(t);
    await f.withIssuer(f.verifier, async (issuer, actor) => {
      assert.equal(
        (await issuer.exportPackage(actor, f.first.releaseId)).status,
        'issued_export_not_adopted',
      );
    });
    for (const media of [false, true]) {
      let entered!: () => void, finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const verifier: ReleaseTrustVerifier = {
        async verify(input) {
          entered();
          await blocked;
          return f.verifier.verify(input);
        },
      };
      await f.withIssuer(verifier, async (issuer, actor, db) => {
        const pending = media
          ? issuer.exportMedia(actor, f.first.releaseId, f.mediaHash)
          : issuer.exportPackage(actor, f.first.releaseId);
        await waiting;
        db.run('DELETE FROM admin_session WHERE session_id=?', actor.sessionId);
        finish();
        await assert.rejects(pending, { statusCode: 401 });
      });
    }
  },
);

test(
  'captured package is immutable and independent of a later issue while verification is awaiting',
  { timeout: 15_000 },
  async (t) => {
    const f = await deliveryFixture(t);
    let entered!: () => void, finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const verifier: ReleaseTrustVerifier = {
      async verify(input) {
        entered();
        await blocked;
        return f.verifier.verify(input);
      },
    };
    await f.withIssuer(verifier, async (issuer, actor) => {
      const pending = issuer.exportPackage(actor, f.first.releaseId);
      await waiting;
      const latest = await f.seed(f.first);
      finish();
      const value = await pending;
      assert.equal(value.envelope.manifest.releaseId, f.first.releaseId);
      assert.deepEqual(value.publications, [f.publication]);
      assert.equal(Object.isFrozen(value.publications[0]!.revision.document), true);
      assert.equal(
        f.sql(
          (sql) =>
            sql.prepare('SELECT sequence FROM issued_release WHERE id=?').get(latest.releaseId)!
              .sequence,
        ),
        2,
      );
    });
  },
);

test('signed release members cannot disappear or be rebound to a later or missing retaining release', async (t) => {
  const f = await deliveryFixture(t);
  const second = await f.seed(f.first);
  const expectIncomplete = async (releaseId: string) => {
    const response = await f.client.request('GET', `${path}/${releaseId}/package`);
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(response.json().error.code, 'issued_integrity');
    assert.equal(Object.hasOwn(response.json(), 'publications'), false);
  };
  f.sql((sql) => sql.prepare('DELETE FROM issued_publication').run());
  await expectIncomplete(f.first.releaseId);
  await expectIncomplete(second.releaseId);
  f.sql((sql) =>
    sql
      .prepare('INSERT INTO issued_publication VALUES(?,?,?,?)')
      .run(
        f.publication.revision.ref.recipeId,
        f.publication.revision.ref.revisionId,
        second.releaseId,
        canonicalContentJson(f.publication),
      ),
  );
  await expectIncomplete(f.first.releaseId);
  f.sql((sql) => {
    // Deliberately model corrupted stored evidence on this disposable connection only.
    sql.exec('PRAGMA foreign_keys=OFF');
    sql.prepare('UPDATE issued_publication SET release_id=?').run('missing-retaining-release');
  });
  await expectIncomplete(f.first.releaseId);
  await expectIncomplete(second.releaseId);
  f.sql((sql) => sql.prepare('UPDATE issued_publication SET release_id=?').run(f.first.releaseId));
  assert.equal(
    (await f.client.request('GET', `${path}/${f.first.releaseId}/package`)).statusCode,
    200,
  );
  assert.deepEqual(
    (await f.client.request('GET', `${path}/${second.releaseId}/package`)).json().publications,
    [],
  );
});

test('prior retention needs a verified envelope that signed the exact reference and publication fingerprint', async (t) => {
  const f = await deliveryFixture(t);
  const document = structuredClone(f.publication.revision.document);
  document.recipe.recipeId = '90002';
  document.media.forEach((media) => {
    media.recipeId = '90002';
  });
  const replacement = await published(document, 'second-recipe-revision');
  const second = await f.seed(f.first, false, replacement);
  f.sql((sql) =>
    sql
      .prepare('UPDATE issued_publication SET release_id=? WHERE recipe=?')
      .run(f.first.releaseId, '90002'),
  );
  const misbound = await f.client.request('GET', `${path}/${second.releaseId}/package`);
  assert.equal(misbound.statusCode, 500, misbound.body);
  assert.equal(misbound.json().error.code, 'issued_integrity');
  f.sql((sql) =>
    sql
      .prepare('UPDATE issued_publication SET release_id=? WHERE recipe=?')
      .run(second.releaseId, '90002'),
  );
  const original = f.sql(
    (sql) =>
      sql.prepare('SELECT document FROM issued_release WHERE id=?').get(f.first.releaseId)!
        .document as string,
  );
  for (const field of ['contentFingerprint', 'publicationFingerprint', 'signature'] as const) {
    const envelope = JSON.parse(original);
    if (field === 'contentFingerprint')
      envelope.manifest.entries[0].ref.contentFingerprint = 'a'.repeat(64);
    if (field === 'publicationFingerprint')
      envelope.manifest.entries[0].publicationFingerprint = 'a'.repeat(64);
    const changed =
      field === 'signature' ? envelope : await f.signer.signManifest(envelope.manifest);
    if (field === 'signature') changed.signature.value = '0'.repeat(128);
    f.sql((sql) =>
      sql
        .prepare('UPDATE issued_release SET document=? WHERE id=?')
        .run(canonicalContentJson(changed), f.first.releaseId),
    );
    const response = await f.client.request('GET', `${path}/${second.releaseId}/package`);
    assert.equal(response.statusCode, 500, `${field}: ${response.body}`);
    assert.equal(response.json().error.code, 'issued_integrity');
  }
  f.sql((sql) =>
    sql.prepare('UPDATE issued_release SET document=? WHERE id=?').run(original, f.first.releaseId),
  );
  const restored = await f.client.request('GET', `${path}/${second.releaseId}/package`);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().publications, [replacement]);
});

test('prior envelope byte admission happens before historical bodies are materialized', async (t) => {
  const f = await deliveryFixture(t);
  const second = await f.seed(f.first);
  f.sql((sql) => {
    let historicalBodies = 0;
    const instrumented = {
      exec: sql.exec.bind(sql),
      prepare(query: string) {
        if (query.startsWith('SELECT id,sequence,document')) historicalBodies++;
        return sql.prepare(query);
      },
    } as unknown as DatabaseSync;
    sql
      .prepare('UPDATE issued_release SET document=CAST(zeroblob(?) AS TEXT) WHERE id=?')
      .run(CONTENT_LIMITS.releaseBytes + 1, f.first.releaseId);
    assert.throws(() => captureIssuedDelivery(instrumented, second.releaseId), {
      code: 'release_delivery_limit',
    });
    assert.equal(historicalBodies, 0);
  });
});

test('signature, publication and requested image tampering fail closed with no private payload', async (t) => {
  const f = await deliveryFixture(t);
  const original = f.sql(
    (sql) =>
      sql.prepare('SELECT document FROM issued_release WHERE id=?').get(f.first.releaseId)!
        .document as string,
  );
  const envelope = JSON.parse(original);
  envelope.signature.value = '0'.repeat(128);
  f.sql((sql) =>
    sql
      .prepare('UPDATE issued_release SET document=? WHERE id=?')
      .run(canonicalContentJson(envelope), f.first.releaseId),
  );
  const failedSignature = await f.client.request('GET', `${path}/${f.first.releaseId}/package`);
  assert.equal(failedSignature.statusCode, 500);
  assert.equal(failedSignature.json().error.code, 'issued_integrity');
  f.sql((sql) =>
    sql.prepare('UPDATE issued_release SET document=? WHERE id=?').run(original, f.first.releaseId),
  );
  const publication = structuredClone(f.publication);
  publication.revision.document.recipe.title = 'Tampered private fixture text';
  f.sql((sql) =>
    sql.prepare('UPDATE issued_publication SET document=?').run(JSON.stringify(publication)),
  );
  const failedPublication = await f.client.request('GET', `${path}/${f.first.releaseId}/package`);
  assert.equal(failedPublication.statusCode, 500);
  assert.equal(failedPublication.body.includes('Tampered private'), false);
  f.sql((sql) =>
    sql
      .prepare('UPDATE issued_publication SET document=?')
      .run(canonicalContentJson(f.publication)),
  );
  f.sql((sql) => sql.prepare('UPDATE issued_media SET bytes=?').run(Buffer.alloc(f.bytes.length)));
  const failedMedia = await f.client.request(
    'GET',
    `${path}/${f.first.releaseId}/media/${f.mediaHash}`,
  );
  assert.equal(failedMedia.statusCode, 500);
  assert.equal(failedMedia.json().error.code, 'issued_integrity');
});

test('SQL count and byte preflight reject oversized stored publications before selecting their bodies', async (t) => {
  const f = await deliveryFixture(t);
  f.sql((sql) => {
    let bodies = 0;
    const instrumented = {
      exec: sql.exec.bind(sql),
      prepare(query: string) {
        if (query.startsWith('SELECT recipe,revision,document')) bodies++;
        return sql.prepare(query);
      },
    } as unknown as DatabaseSync;
    const insert = sql.prepare('INSERT INTO issued_publication VALUES(?,?,?,?)');
    for (let index = 0; index < OVERLAY_LIMITS.publications; index++)
      insert.run(`fixture-${index}`, 'revision', f.first.releaseId, '{}');
    assert.throws(() => captureIssuedDelivery(instrumented, f.first.releaseId), {
      code: 'release_delivery_limit',
    });
    assert.equal(bodies, 0);
    sql.prepare("DELETE FROM issued_publication WHERE recipe LIKE 'fixture-%'").run();
    sql
      .prepare('UPDATE issued_publication SET document=CAST(zeroblob(?) AS TEXT)')
      .run(PUBLICATION_MAX_BYTES + 1);
    assert.throws(() => captureIssuedDelivery(instrumented, f.first.releaseId), {
      code: 'release_delivery_limit',
    });
    assert.equal(bodies, 0);
    sql.prepare('DELETE FROM issued_publication').run();
    const large = sql.prepare(
      'INSERT INTO issued_publication VALUES(?,?,?,CAST(zeroblob(?) AS TEXT))',
    );
    for (let index = 0; index < 9; index++)
      large.run(`fixture-${index}`, 'revision', f.first.releaseId, 1024 * 1024);
    assert.throws(() => captureIssuedDelivery(instrumented, f.first.releaseId), {
      code: 'release_delivery_limit',
    });
    assert.equal(bodies, 0);
    sql.prepare('DELETE FROM issued_publication').run();
    insert.run(
      f.publication.revision.ref.recipeId,
      f.publication.revision.ref.revisionId,
      f.first.releaseId,
      canonicalContentJson(f.publication),
    );
    assert.equal(
      captureIssuedDelivery(instrumented, f.first.releaseId).publications.length,
      1,
      'failed admission releases its read transaction',
    );
  });
});

test('aggregate media admission and member checks precede BLOB materialization, and invalid IDs never enter SQL', async (t) => {
  const f = await deliveryFixture(t);
  f.sql((sql) => {
    let blobs = 0,
      queries = 0;
    const instrumented = {
      exec: sql.exec.bind(sql),
      prepare(query: string) {
        queries++;
        if (query.includes("SELECT CASE WHEN typeof(bytes)='blob'")) blobs++;
        return sql.prepare(query);
      },
    } as unknown as DatabaseSync;
    assert.throws(() => captureIssuedDelivery(instrumented, '../private-file'), {
      code: 'invalid_delivery_request',
    });
    assert.throws(() => captureIssuedDelivery(instrumented, f.first.releaseId, 'not-a-hash'), {
      code: 'invalid_delivery_request',
    });
    assert.equal(queries, 0);
    assert.throws(() => captureIssuedDelivery(instrumented, f.first.releaseId, 'a'.repeat(64)), {
      code: 'issued_media_unknown',
    });
    assert.equal(blobs, 0);
    const publication = structuredClone(f.publication);
    publication.revision.document.media = ['a', 'b'].map((letter) => ({
      ...publication.revision.document.media[0]!,
      assetId: `sha256:${letter.repeat(64)}`,
      sha256: letter.repeat(64),
      bytes: ISSUED_DELIVERY_LIMITS.mediaBytes / 2 + 1,
    }));
    sql.prepare('UPDATE issued_publication SET document=?').run(JSON.stringify(publication));
    assert.throws(() => captureIssuedDelivery(instrumented, f.first.releaseId, 'a'.repeat(64)), {
      code: 'release_delivery_limit',
    });
    assert.equal(blobs, 0);
    sql
      .prepare('UPDATE issued_publication SET document=?')
      .run(canonicalContentJson(f.publication));
    sql.prepare('UPDATE issued_media SET bytes=zeroblob(?)').run(CONTENT_LIMITS.mediaBytes + 1);
    assert.throws(() => captureIssuedDelivery(instrumented, f.first.releaseId, f.mediaHash), {
      code: 'issued_integrity',
    });
    assert.equal(blobs, 0);
  });
});
