import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as nodeVerify } from 'node:crypto';
import { test } from 'node:test';
import {
  contentOverlaySignaturePayload,
  fingerprintContentOverlay,
  verifySignedContentOverlay,
} from '@cookmate/catalogue/content';
import {
  createContentTrustVerifier,
  CONTENT_SIGNATURE_SCHEME,
} from '@cookmate/catalogue/content-trust';
import { createContentOverlaySigner } from '../src/publishing/signer';
import { overlayFixture } from '../../../packages/catalogue/test/content-overlay-fixtures';
import { sha256 } from '../../../packages/catalogue/test/content-fixtures';

function keys() {
  const keyPair = generateKeyPairSync('ed25519');
  const signer = createContentOverlaySigner({
    keyId: 'test-only-ed25519',
    privateKey: keyPair.privateKey,
  });
  return { ...keyPair, signer, trustVerifier: createContentTrustVerifier([signer.trustKey]) };
}

test('real Node signature passes portable strict verification and the existing overlay validator', async () => {
  const fixture = await overlayFixture();
  const { signer, trustVerifier, publicKey } = keys();
  const envelope = await signer.signManifest(fixture.manifest);
  assert.equal(envelope.signature.scheme, CONTENT_SIGNATURE_SCHEME);
  assert.equal(envelope.signature.value.length, 128);
  assert.equal(
    nodeVerify(
      null,
      Buffer.from(contentOverlaySignaturePayload(envelope.manifest, envelope.fingerprint)),
      publicKey,
      Buffer.from(envelope.signature.value, 'hex'),
    ),
    true,
  );
  const snapshot = await verifySignedContentOverlay(envelope, {
    ...fixture.options,
    trustVerifier,
  });
  assert.equal(snapshot.trust, 'signature_verified');
  assert.equal(snapshot.lookupCurrent(fixture.publication.revision.ref.recipeId).kind, 'readable');
  // Media/rights are deliberately synthetic fixture ports here, not publication acceptance.
});

test('recomputing a changed manifest digest cannot forge its signature', async () => {
  const fixture = await overlayFixture();
  const { signer, trustVerifier } = keys();
  const envelope = await signer.signManifest(fixture.manifest);
  envelope.manifest.createdAt = '2026-10-01T12:00:00.000Z';
  envelope.fingerprint = await fingerprintContentOverlay(envelope.manifest, sha256);
  await assert.rejects(
    verifySignedContentOverlay(envelope, { ...fixture.options, trustVerifier }),
    /overlay_untrusted/,
  );
});

test('keys are independently owned and malformed, alternate-key or alternate-scheme signatures fail closed', async () => {
  const fixture = await overlayFixture();
  const { signer } = keys();
  const independent = keys();
  const configuration = [{ ...signer.trustKey }];
  const verifier = createContentTrustVerifier(configuration);
  configuration[0]!.publicKeyHex = independent.signer.trustKey.publicKeyHex;
  const envelope = await signer.signManifest(fixture.manifest);
  const proof = {
    keyId: envelope.signature.keyId,
    scheme: envelope.signature.scheme,
    signature: envelope.signature.value,
    canonicalPayload: contentOverlaySignaturePayload(envelope.manifest, envelope.fingerprint),
  };
  assert.equal(await verifier.verify(proof), true);
  for (const change of [
    { keyId: 'unknown' },
    { scheme: 'fixture-only' },
    { signature: '00'.repeat(64) },
    { signature: proof.signature.toUpperCase() },
    { signature: `${proof.signature}00` },
    { canonicalPayload: proof.canonicalPayload + ' ' },
  ])
    assert.equal(await verifier.verify({ ...proof, ...change }), false);
  assert.equal(await independent.trustVerifier.verify(proof), false);
});

test('RFC8032 published empty-message vector verifies without Node crypto in the verifier', async () => {
  const verifier = createContentTrustVerifier([
    {
      keyId: 'rfc8032-test-1',
      publicKeyHex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    },
  ]);
  assert.equal(
    await verifier.verify({
      keyId: 'rfc8032-test-1',
      scheme: CONTENT_SIGNATURE_SCHEME,
      canonicalPayload: '',
      signature:
        'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    }),
    true,
  );
});

test('trust and signer configuration reject ambiguity without echoing secret material', () => {
  const { signer } = keys();
  assert.throws(() => createContentTrustVerifier([]), /Invalid content trust/);
  assert.throws(
    () => createContentTrustVerifier([signer.trustKey, signer.trustKey]),
    /Invalid content trust/,
  );
  assert.throws(
    () => createContentTrustVerifier([{ keyId: 'bad', publicKeyHex: 'ab' }]),
    /Invalid content trust/,
  );
  assert.throws(
    () => createContentOverlaySigner({ keyId: 'bad', privateKey: 'secret-test-string' }),
    { message: 'Invalid content signing configuration.' },
  );
  assert.throws(
    () =>
      createContentOverlaySigner({
        keyId: 'rsa',
        privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
      }),
    /Invalid content signing/,
  );
});
