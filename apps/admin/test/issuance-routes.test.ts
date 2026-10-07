import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { CONTENT_LIMITS, contentOverlaySignaturePayload } from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import type {
  AdminDraft,
  AdminPublicationIssueReceipt,
  AdminPublicationIssueRequest,
  AdminPublicationPreparation,
  AdminPublicationReleaseState,
} from '../src/contracts';
import { openAdminDatabase } from '../src/storage/database';
import { fingerprintIssuanceRequest } from '../src/publishing/issuedStore';
import { fixture } from './helpers';

const path = '/admin/api/publication/releases';
const recovery = (receipt: AdminPublicationIssueReceipt) =>
  `${path}/operations/${receipt.operationId}?requestFingerprint=${receipt.requestFingerprint}`;
async function prepared(t: TestContext) {
  const pair = generateKeyPairSync('ed25519');
  const exported = pair.publicKey.export({ format: 'jwk' });
  const trust = [
    {
      keyId: 'fixture-release-key',
      publicKeyHex: Buffer.from(exported.x!, 'base64url').toString('hex'),
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
  const client = f.client();
  await client.login();
  let draft = (await client.create('issue-create', catalogue.recipes[0]!.recipeId)).draft;
  const saved = await client.request('PUT', `/admin/api/drafts/${draft.draftId}`, {
    operationId: 'issue-save',
    expectedRevision: draft.revision,
    input: {
      ...draft.input,
      changeSummary: 'Synthetic HTTP issuance fixture; no real operator approval.',
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  draft = saved.json().draft as AdminDraft;
  for (const scope of ['recipe_text', 'photo', ...(draft.input.videoUrl ? ['video_embed'] : [])]) {
    const reviewed = await client.request('POST', `/admin/api/drafts/${draft.draftId}/rights`, {
      operationId: `issue-rights-${scope}`,
      expectedRevision: draft.revision,
      scope,
      status: 'permitted',
      statement: 'Synthetic fixture assertion, not actual rights permission.',
      sourceUrl: null,
    });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    draft = reviewed.json().draft as AdminDraft;
  }
  const reviewed = await client.request('POST', `/admin/api/drafts/${draft.draftId}/reviews`, {
    operationId: 'issue-review',
    expectedRevision: draft.revision,
    decision: 'approved',
    note: 'Synthetic fixture only.',
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  draft = reviewed.json().draft as AdminDraft;
  const result = await client.request(
    'POST',
    `/admin/api/drafts/${draft.draftId}/publication-preparation`,
    { expectedRevision: draft.revision },
  );
  assert.equal(result.statusCode, 200, result.body);
  const retained = result.json() as AdminPublicationPreparation;
  const input: AdminPublicationIssueRequest = {
    operationId: 'issue-http',
    expectedHead: null,
    entries: [
      {
        state: 'current',
        ref: {
          recipeId: retained.recipeId,
          revisionId: retained.revisionId,
          contentFingerprint: retained.contentFingerprint,
        },
        publicationFingerprint: retained.publicationFingerprint,
      },
    ],
  };
  return { f, client, input, trust, retained };
}

test('publication is disabled by default and does not create an issuance database', async (t) => {
  const f = await fixture(t);
  const client = f.client();
  await client.login();
  assert.deepEqual((await client.request('GET', `${path}/current`)).json(), {
    status: 'not_configured',
  });
  const issue = await client.request('POST', path, {
    operationId: 'disabled',
    expectedHead: null,
    entries: [],
  });
  assert.equal(issue.statusCode, 503);
  assert.equal(issue.json().error.code, 'publication_not_configured');
  const missing = await client.request(
    'GET',
    `${path}/operations/disabled?requestFingerprint=${'a'.repeat(64)}`,
  );
  assert.equal(missing.statusCode, 503);
  await assert.rejects(access(join(f.directory, 'issued-content.sqlite')), { code: 'ENOENT' });
});

test('authenticated prepared-to-signed HTTP issuance replays and recovers across server reopen with exact head and signature', async (t) => {
  const { f, client, input, trust } = await prepared(t);
  assert.deepEqual((await client.request('GET', `${path}/current`)).json(), {
    status: 'ready',
    head: null,
    manifest: null,
  });
  const issued = await client.request('POST', path, input);
  assert.equal(issued.statusCode, 200, issued.body);
  const receipt = issued.json() as AdminPublicationIssueReceipt;
  assert.equal(receipt.status, 'issued_not_activated');
  assert.equal(receipt.actorId, 'fixture-admin');
  assert.deepEqual(receipt.envelope.manifest.entries, input.entries);
  assert.equal(
    await createContentTrustVerifier(trust).verify({
      keyId: receipt.envelope.signature.keyId,
      scheme: receipt.envelope.signature.scheme,
      signature: receipt.envelope.signature.value,
      canonicalPayload: contentOverlaySignaturePayload(
        receipt.envelope.manifest,
        receipt.envelope.fingerprint,
      ),
    }),
    true,
  );
  assert.equal(issued.body.includes('PRIVATE KEY'), false);
  assert.equal(issued.body.includes('signingPrivateKey'), false);
  assert.deepEqual((await client.request('POST', path, input)).json(), receipt);
  assert.deepEqual((await client.request('GET', recovery(receipt))).json(), receipt);
  await f.reopen();
  const current = (
    await client.request('GET', `${path}/current`)
  ).json() as AdminPublicationReleaseState;
  assert.equal(current.status, 'ready');
  if (current.status !== 'ready') assert.fail();
  assert.deepEqual(current.manifest, receipt.envelope.manifest);
  assert.deepEqual(current.head, {
    releaseId: receipt.envelope.manifest.releaseId,
    sequence: 1,
    fingerprint: receipt.envelope.fingerprint,
  });
  assert.deepEqual((await client.request('GET', recovery(receipt))).json(), receipt);
  const changed = await client.request('POST', path, { ...input, entries: [] });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, 'operation_conflict');
});

test('issuance routes require live administrator authority and CSRF; recovery is actor and fingerprint scoped', async (t) => {
  const { f, client, input } = await prepared(t);
  assert.equal((await f.client().request('GET', `${path}/current`)).statusCode, 401);
  const badCsrf = await client.request('POST', path, input, { 'x-csrf-token': 'invalid' });
  assert.equal(badCsrf.statusCode, 403);
  assert.equal(badCsrf.json().error.code, 'csrf_required');
  assert.deepEqual((await client.request('GET', `${path}/current`)).json(), {
    status: 'ready',
    head: null,
    manifest: null,
  });
  for (const username of ['fixture-editor', 'fixture-reviewer']) {
    const lowerRole = f.client();
    await lowerRole.login(username);
    for (const result of [
      await lowerRole.request('GET', `${path}/current`),
      await lowerRole.request('POST', path, input),
      await lowerRole.request(
        'GET',
        `${path}/operations/issue-http?requestFingerprint=${'a'.repeat(64)}`,
      ),
    ]) {
      assert.equal(result.statusCode, 403);
      assert.equal(result.json().error.code, 'role_required');
    }
  }
  const receipt = (
    await client.request('POST', path, input)
  ).json() as AdminPublicationIssueReceipt;
  const wrongFingerprint = await client.request(
    'GET',
    `${path}/operations/${receipt.operationId}?requestFingerprint=${'0'.repeat(64)}`,
  );
  assert.equal(wrongFingerprint.statusCode, 409);
  assert.equal(wrongFingerprint.json().error.code, 'operation_conflict');
  const db = openAdminDatabase(f.filename);
  db.run(
    "UPDATE admin_user SET role='administrator',auth_epoch=auth_epoch+1 WHERE user_id='fixture-reviewer'",
  );
  db.close();
  const otherAdministrator = f.client();
  await otherAdministrator.login('fixture-reviewer');
  const notOwned = await otherAdministrator.request('GET', recovery(receipt));
  assert.equal(notOwned.statusCode, 404);
  assert.equal(notOwned.json().error.code, 'issuance_unknown');
  const revoke = openAdminDatabase(f.filename);
  revoke.run("UPDATE admin_user SET auth_epoch=auth_epoch+1 WHERE user_id='fixture-admin'");
  revoke.close();
  assert.equal((await client.request('GET', recovery(receipt))).statusCode, 401);
});

test('expired recent authentication permits committed recovery but cannot authorize a new release', async (t) => {
  const { f, client, input } = await prepared(t);
  const receipt = (
    await client.request('POST', path, input)
  ).json() as AdminPublicationIssueReceipt;
  f.advance(16 * 60 * 1000);
  assert.deepEqual((await client.request('GET', recovery(receipt))).json(), receipt);
  assert.deepEqual((await client.request('POST', path, input)).json(), receipt);
  const blocked = await client.request('POST', path, {
    ...input,
    operationId: 'new-after-expiry',
    expectedHead: {
      releaseId: receipt.envelope.manifest.releaseId,
      sequence: 1,
      fingerprint: receipt.envelope.fingerprint,
    },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, 'reauth_required');
});

test('competing HTTP issuances preserve head CAS while identical operation retries converge', async (t) => {
  const { client, input } = await prepared(t);
  const results = await Promise.all([
    client.request('POST', path, input),
    client.request('POST', path, { ...input, operationId: 'competing' }),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  assert.equal(
    results.find((result) => result.statusCode === 409)!.json().error.code,
    'release_head_changed',
  );
  const winner = results
    .find((result) => result.statusCode === 200)!
    .json() as AdminPublicationIssueReceipt;
  const retries = await Promise.all([
    client.request('POST', path, { ...input, operationId: winner.operationId }),
    client.request('POST', path, { ...input, operationId: winner.operationId }),
  ]);
  for (const result of retries) {
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), winner);
  }
  const current = (await client.request('GET', `${path}/current`)).json() as Extract<
    AdminPublicationReleaseState,
    { status: 'ready' }
  >;
  assert.equal(current.head!.sequence, 1);
});

test('strict request and recovery bounds reject malformed fields before issuing any release', async (t) => {
  const { client, input } = await prepared(t);
  for (const body of [
    {},
    { ...input, publish: true },
    { ...input, operationId: 'ends-with-newline\n' },
    { ...input, expectedHead: {} },
    {
      ...input,
      expectedHead: { releaseId: 'unknown', sequence: '1', fingerprint: 'a'.repeat(64) },
    },
    { ...input, entries: {} },
    { ...input, entries: Array(10001).fill({}) },
  ]) {
    const result = await client.request('POST', path, body);
    assert.equal(result.statusCode, 400, result.body);
  }
  assert.equal((await client.request('POST', `${path}?extra=1`, input)).statusCode, 400);
  assert.equal((await client.request('GET', `${path}/current?extra=1`)).statusCode, 400);
  for (const query of [
    '',
    '?requestFingerprint=bad',
    `?requestFingerprint=${'a'.repeat(64)}%0A`,
    `?requestFingerprint=${'a'.repeat(64)}&requestFingerprint=${'a'.repeat(64)}`,
    `?requestFingerprint=${'a'.repeat(64)}&extra=1`,
  ])
    assert.equal(
      (await client.request('GET', `${path}/operations/unknown${query}`)).statusCode,
      400,
    );
  const oversized = await client.request(
    'POST',
    path,
    JSON.stringify({ ...input, padding: 'x'.repeat(CONTENT_LIMITS.releaseBytes) }),
    { 'content-type': 'application/json' },
  );
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual((await client.request('GET', `${path}/current`)).json(), {
    status: 'ready',
    head: null,
    manifest: null,
  });
});

test('explicit resolve commits a durable exact cancellation and prevents delayed requests after reopen', async (t) => {
  const { f, client, input } = await prepared(t);
  const requestFingerprint = fingerprintIssuanceRequest(input.expectedHead, input.entries);
  const url = `${path}/operations/${input.operationId}/resolve`;
  assert.equal(
    (await client.request('POST', url, { requestFingerprint }, { 'x-csrf-token': 'bad' }))
      .statusCode,
    403,
  );
  for (const body of [
    {},
    { requestFingerprint, extra: true },
    { requestFingerprint: 'a'.repeat(65) },
  ])
    assert.equal((await client.request('POST', url, body)).statusCode, 400);
  const lower = f.client();
  await lower.login('fixture-editor');
  assert.equal((await lower.request('POST', url, { requestFingerprint })).statusCode, 403);
  f.advance(16 * 60 * 1000);
  const cancelled = {
    status: 'cancelled',
    actorId: 'fixture-admin',
    operationId: input.operationId,
    requestFingerprint,
  };
  assert.deepEqual((await client.request('POST', url, { requestFingerprint })).json(), cancelled);
  await f.reopen();
  assert.deepEqual((await client.request('POST', url, { requestFingerprint })).json(), cancelled);
  const mismatch = await client.request('POST', url, { requestFingerprint: '0'.repeat(64) });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().error.code, 'operation_conflict');
  const delayed = await client.request('POST', path, input);
  assert.equal(delayed.statusCode, 409);
  assert.equal(delayed.json().error.code, 'operation_cancelled');
  assert.deepEqual((await client.request('GET', `${path}/current`)).json(), {
    status: 'ready',
    head: null,
    manifest: null,
  });
});

test('resolve returns the verified committed receipt instead of cancelling an issued operation', async (t) => {
  const { f, client, input } = await prepared(t);
  const result = await client.request('POST', path, input);
  assert.equal(result.statusCode, 200, result.body);
  const receipt = result.json() as AdminPublicationIssueReceipt;
  f.advance(16 * 60 * 1000);
  const url = `${path}/operations/${input.operationId}/resolve`;
  const resolved = await client.request('POST', url, {
    requestFingerprint: receipt.requestFingerprint,
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.deepEqual(resolved.json(), { status: 'committed', receipt });
  assert.deepEqual((await client.request('POST', path, input)).json(), receipt);
});
