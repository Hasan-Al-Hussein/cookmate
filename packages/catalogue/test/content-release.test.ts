import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalContentJson, createRecipeContentRevision, createBundledRecipeRevision,
  fingerprintReleaseManifest, releaseSignaturePayload, verifySignedContentRelease,
  validateContentReleaseManifest, releasePublicationBlockers,
  bundledImportedSourceVerifier, validateRecipeContentDocument,
} from '../src/content/index';
import type { ContentReleaseManifest, RecipeContentDocument, ReleaseTrustVerifier, SignedReleaseEnvelope } from '../src/content/types';
import { authoredFixture, clone, sha256 } from './content-fixtures';

async function fixture() {
  const revision = await createRecipeContentRevision(authoredFixture(), 'recipe-revision-1', sha256);
  const manifest: ContentReleaseManifest = {
    formatVersion: 1, releaseId: 'release-1', sequence: 1, previousReleaseId: null,
    createdAt: '2026-09-30T12:00:00.000Z', minimumReaderVersion: 1,
    recipes: [clone(revision.ref)], media: JSON.parse(JSON.stringify(revision.document.media)),
  };
  const fingerprint = await fingerprintReleaseManifest(manifest, sha256);
  const envelope: SignedReleaseEnvelope = {
    manifest, fingerprint, signature: { keyId: 'fixture-key', scheme: 'fixture-only', value: 'synthetic_signature_no_crypto' },
  };
  const calls: Parameters<ReleaseTrustVerifier['verify']>[0][] = [];
  // Deliberate test double; no native or real signature-verification evidence is claimed.
  const trustVerifier: ReleaseTrustVerifier = { async verify(input) {
    calls.push(input);
    return input.keyId === 'fixture-key' && input.scheme === 'fixture-only' && input.signature === 'synthetic_signature_no_crypto';
  } };
  return { revision, envelope, calls, options: { sha256, trustVerifier, readerVersion: 1, revisions: [revision] } };
}
test('verified manifest reports signature scope, immutable revisions and unverified media/dependencies honestly', async () => {
  const { envelope, revision, calls, options } = await fixture();
  const result = await verifySignedContentRelease(envelope, options);
  assert.equal(result.trust, 'signature_verified');
  assert.equal(result.mediaBytes, 'not_verified');
  assert.equal(result.historicalDependencies, 'not_verified');
  assert.equal(result.importedSourceEvidence, 'not_applicable');
  assert.deepEqual(result.revisions[0], revision);
  assert.ok(Object.isFrozen(result.envelope.manifest.media[0]!.rights));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.canonicalPayload, releaseSignaturePayload(envelope.manifest, envelope.fingerprint));
  assert.match(calls[0]!.canonicalPayload, /cookmate-signed-release-v1/);
});
test('a correct checksum cannot replace configured key/scheme trust', async () => {
  const { envelope, options } = await fixture();
  const rejected = { ...options, trustVerifier: { async verify() { return false; } } };
  await assert.rejects(verifySignedContentRelease(envelope, rejected), /release_untrusted/);
  await assert.rejects(verifySignedContentRelease({ ...envelope, signature: { ...envelope.signature, keyId: 'attacker-key' } }, options), /release_untrusted/);
  await assert.rejects(verifySignedContentRelease({ ...envelope, signature: { ...envelope.signature, scheme: 'attacker-scheme' } }, options), /release_untrusted/);
  await assert.rejects(verifySignedContentRelease(envelope, { ...options, trustVerifier: { async verify() { throw new Error('verifier unavailable'); } } }), /verifier unavailable/);
});
test('modified manifest is rejected before invoking the trust adapter', async () => {
  const { envelope, calls, options } = await fixture();
  envelope.manifest.releaseId = 'changed-release';
  await assert.rejects(verifySignedContentRelease(envelope, options), /release_integrity/);
  assert.equal(calls.length, 0);
});
test('signed manifest refs must match the exact supplied recipe content and revision', async () => {
  const { envelope, options } = await fixture();
  const changed = clone(envelope);
  changed.manifest.recipes[0]!.revisionId = 'invented-revision';
  changed.fingerprint = await fingerprintReleaseManifest(changed.manifest, sha256);
  await assert.rejects(verifySignedContentRelease(changed, options), /release_recipe_reference/);
  const other = await createRecipeContentRevision(authoredFixture('90002'), 'recipe-revision-1', sha256);
  await assert.rejects(verifySignedContentRelease(envelope, { ...options, revisions: [other] }), /release_recipe_reference/);
  await assert.rejects(verifySignedContentRelease(envelope, { ...options, revisions: [] }), /release_revision_count/);
});
test('release media association cannot be swapped even with a recomputed manifest digest', async () => {
  const { envelope, options } = await fixture();
  envelope.manifest.media[0]!.attribution.text = 'Unrelated credit';
  envelope.fingerprint = await fingerprintReleaseManifest(envelope.manifest, sha256);
  await assert.rejects(verifySignedContentRelease(envelope, options), /release_media_reference/);
});
test('release shape rejects unknown fields, duplicate IDs, orphan media and conflicting content-addressed asset facts', async () => {
  const { envelope } = await fixture();
  const manifest = envelope.manifest;
  for (const candidate of [
    { ...manifest, executableCode: 'not content' },
    { ...manifest, recipes: [...manifest.recipes, ...manifest.recipes] },
    { ...manifest, media: [] },
    { ...manifest, media: [...manifest.media, ...manifest.media] },
    { ...manifest, media: [{ ...manifest.media[0], recipeId: '90002' }] },
    { ...manifest, previousReleaseId: manifest.releaseId },
    { ...manifest, sequence: 0 },
    { ...manifest, createdAt: '2026-02-30T12:00:00.000Z' },
  ]) assert.equal(validateContentReleaseManifest(candidate), false);
  const second = { ...manifest.recipes[0]!, recipeId: '90002' };
  assert.equal(validateContentReleaseManifest({ ...manifest, recipes: [...manifest.recipes, second], media: [...manifest.media, { ...manifest.media[0], recipeId: '90002', bytes: 999 }] }), false);
});
test('packaged baseline is readable without inventing publication permission or image measurements', async () => {
  const { envelope, options } = await fixture();
  const baseline = await createBundledRecipeRevision('53262', sha256);
  const manifest: ContentReleaseManifest = { ...envelope.manifest, recipes: [clone(baseline.ref)], media: JSON.parse(JSON.stringify(baseline.document.media)) };
  assert.ok(validateContentReleaseManifest(manifest));
  assert.deepEqual(releasePublicationBlockers(manifest), ['dimensions_unverified', 'rights_not_permitted']);
  await assert.rejects(verifySignedContentRelease({ ...envelope, manifest, fingerprint: await fingerprintReleaseManifest(manifest, sha256) }, { ...options, revisions: [baseline] }), /release_not_eligible/);
});
test('caller mutation during async trust verification cannot replace copied manifest or dependencies', async () => {
  const { envelope, revision, options } = await fixture();
  const dependencies = [clone(revision)];
  const result = await verifySignedContentRelease(envelope, {
    ...options, revisions: dependencies,
    trustVerifier: { async verify() {
      envelope.manifest.releaseId = 'attacker';
      (dependencies[0]!.document.recipe as { title: string }).title = 'Attacker replacement';
      return true;
    } },
  });
  assert.equal(result.envelope.manifest.releaseId, 'release-1');
  assert.equal(result.revisions[0]!.document.recipe.title, 'Fixture soup');
});
test('reader compatibility and private signature fields are checked before trust', async () => {
  const { envelope, options, calls } = await fixture();
  await assert.rejects(verifySignedContentRelease(envelope, { ...options, readerVersion: 0 }), /reader_incompatible/);
  await assert.rejects(verifySignedContentRelease({ ...envelope, signature: { ...envelope.signature, publicKey: 'self-nominated key' } }, options), /release_signature/);
  const future = clone(envelope); future.manifest.minimumReaderVersion = 2;
  await assert.rejects(verifySignedContentRelease(future, options), /reader_incompatible/);
  assert.equal(calls.length, 0);
});
test('manifest ordering is signed and returned even when dependency inputs arrive in another order', async () => {
  const { envelope, revision, options } = await fixture();
  const otherDocument = authoredFixture('90002');
  const other = await createRecipeContentRevision(otherDocument, 'recipe-revision-2', sha256);
  envelope.manifest.recipes.push(clone(other.ref));
  envelope.manifest.media.push(...JSON.parse(JSON.stringify(other.document.media)));
  envelope.fingerprint = await fingerprintReleaseManifest(envelope.manifest, sha256);
  const result = await verifySignedContentRelease(envelope, { ...options, revisions: [other, revision] });
  assert.deepEqual(result.revisions.map((item) => item.ref.recipeId), ['90001', '90002']);
  const reversed = clone(envelope.manifest); reversed.recipes.reverse();
  assert.notEqual(await fingerprintReleaseManifest(reversed, sha256), envelope.fingerprint);
  assert.notEqual(canonicalContentJson(result.envelope.manifest.recipes), canonicalContentJson(reversed.recipes));
});

async function reviewedImportedFixture() {
  const base = await fixture();
  const baseline = await createBundledRecipeRevision('53262', sha256);
  const document: RecipeContentDocument = JSON.parse(JSON.stringify(baseline.document));
  const syntheticEvidence = authoredFixture().media[0]!;
  document.media[0]!.dimensions = clone(syntheticEvidence.dimensions);
  document.media[0]!.rights = clone(syntheticEvidence.rights);
  const revision = await createRecipeContentRevision(document, 'reviewed-baseline-1', sha256);
  const manifest: ContentReleaseManifest = {
    ...base.envelope.manifest,
    recipes: [clone(revision.ref)], media: clone(document.media),
  };
  const envelope = { ...base.envelope, manifest, fingerprint: await fingerprintReleaseManifest(manifest, sha256) };
  return { document, envelope, options: { ...base.options, revisions: [revision] } };
}
test('imported content requires a separately configured retained-source verifier even when signatures and checksums pass', async () => {
  const { envelope, options } = await reviewedImportedFixture();
  await assert.rejects(verifySignedContentRelease(envelope, options), /imported_source_unverified/);
  await assert.rejects(verifySignedContentRelease(envelope, { ...options, importedSourceVerifier: { async verify() { return false; } } }), /imported_source_mismatch/);
  const accepted = await verifySignedContentRelease(envelope, { ...options, importedSourceVerifier: bundledImportedSourceVerifier });
  assert.equal(accepted.importedSourceEvidence, 'verified');
  assert.equal(accepted.mediaBytes, 'not_verified');
  const selfClaimed = { ...envelope, importedSourceVerifier: 'trust-me' };
  await assert.rejects(verifySignedContentRelease(selfClaimed, options), /release_envelope/);
});
test('modified imported quantities, passages, source identity or photo bytes cannot borrow retained baseline hashes', async () => {
  const { document, envelope, options } = await reviewedImportedFixture();
  assert.equal(document.kind, 'imported');
  for (const modify of [
    (value: RecipeContentDocument) => { value.recipe.ingredients[0]!.rawMeasure = '999 kg'; },
    (value: RecipeContentDocument) => { value.recipe.instructions[0]!.rawText = 'Invented cooking directions.'; },
    (value: RecipeContentDocument) => { if (value.kind === 'imported') value.provenance.catalogue.version = 'untrusted-source'; },
    (value: RecipeContentDocument) => { value.media[0]!.sha256 = '9'.repeat(64); value.media[0]!.assetId = `sha256:${'9'.repeat(64)}`; },
  ]) {
    const changed = clone(document); modify(changed);
    assert.ok(validateRecipeContentDocument(changed), 'shape validity intentionally does not prove source fidelity');
    const revision = await createRecipeContentRevision(changed, 'fabricated-revision', sha256);
    const manifest: ContentReleaseManifest = { ...envelope.manifest, recipes: [clone(revision.ref)], media: clone(changed.media) };
    const signed = { ...envelope, manifest, fingerprint: await fingerprintReleaseManifest(manifest, sha256) };
    await assert.rejects(verifySignedContentRelease(signed, { ...options, revisions: [revision], importedSourceVerifier: bundledImportedSourceVerifier }), /imported_source_mismatch/);
  }
});
