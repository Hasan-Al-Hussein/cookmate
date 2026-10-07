import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '../src/index';
import {
  CONTENT_LIMITS, canonicalContentJson, createRecipeContentRevision, readRecipeContentRevision,
  createBundledContentSnapshot, createBundledRecipeRevision, validateRecipeContentDocument,
  validateMediaReference, validateRecipeContentRef, validateReviewedMetadata, mediaPublicationBlockers,
} from '../src/content/index';
import { authoredFixture, clone, evidence, sha256 } from './content-fixtures';
import { copyContent } from '../src/content/canonical';

test('canonical encoding sorts keys without reordering arrays or normalizing source text', () => {
  assert.equal(canonicalContentJson({ z: [2, 1], a: '½ tsp\nSalt' }), '{"a":"½ tsp\\nSalt","z":[2,1]}');
  assert.equal(canonicalContentJson({ a: 1, b: { d: 3, c: 2 } }), canonicalContentJson({ b: { c: 2, d: 3 }, a: 1 }));
  assert.notEqual(canonicalContentJson(['a', 'b']), canonicalContentJson(['b', 'a']));
  assert.notEqual(canonicalContentJson('é'), canonicalContentJson('e\u0301'));
});
test('canonical encoding rejects ambiguous or executable object shapes before reading getters', () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterCalls++; return 1; } });
  const cycle: unknown[] = []; cycle.push(cycle);
  const extra = [1]; Object.defineProperty(extra, 'hidden', { value: 1 });
  for (const value of [undefined, NaN, Infinity, -0, 1n, new Date(), () => 1, [undefined], new Array(1), cycle, getter, extra, { [Symbol('x')]: 1 }])
    assert.throws(() => canonicalContentJson(value));
  assert.equal(getterCalls, 0);
});
test('byte budgets apply before copying oversized strings or sorting oversized keys', () => {
  assert.throws(() => copyContent('x'.repeat(65_536), 128), /json_size/);
  let getterCalls = 0;
  const largeKey = Object.defineProperty({}, 'k'.repeat(4096), {
    enumerable: true, get() { getterCalls++; throw new Error('must not read'); },
  });
  assert.throws(() => copyContent(largeKey, 128), /json_size/);
  assert.equal(getterCalls, 0);
  assert.throws(() => canonicalContentJson({ a: 'a'.repeat(80), b: 'b'.repeat(80) }, 128), /json_size/);
});
test('array cardinality is bounded before key enumeration or traversal; excessive nesting fails closed', () => {
  let enumerations = 0;
  const tooMany = new Proxy(new Array(500_001), {
    ownKeys() { enumerations++; throw new Error('must not enumerate'); },
  });
  assert.throws(() => copyContent(tooMany, 8 * 1024 * 1024), /json_bound/);
  assert.equal(enumerations, 0);
  let nested: unknown = null;
  for (let index = 0; index < 34; index++) nested = { child: nested };
  assert.throws(() => canonicalContentJson(nested), /json_bound/);
});
test('exact JSON escaping and UTF-8 boundary checks include controls, surrogate pairs and lone surrogates', () => {
  for (const value of ['abc', 'é', '🌿', '\u0000', '\b\t\n\r\f', '\ud800', '\udfff', 'quote"slash\\']) {
    const expected = JSON.stringify(value);
    const bytes = Buffer.byteLength(expected, 'utf8');
    assert.equal(canonicalContentJson(value, bytes), expected);
    assert.throws(() => canonicalContentJson(value, bytes - 1), /json_size/);
    assert.deepEqual(copyContent({ value }, Buffer.byteLength(JSON.stringify({ value }), 'utf8')), { value });
  }
});
test('content and revision identity are separate, canonical and privately immutable', async () => {
  const input = authoredFixture();
  const first = await createRecipeContentRevision(input, 'revision-1', sha256);
  const next = await createRecipeContentRevision(input, 'revision-2', sha256);
  assert.equal(first.ref.contentFingerprint, next.ref.contentFingerprint);
  assert.notEqual(first.revisionFingerprint, next.revisionFingerprint);
  input.recipe.title = 'Caller mutation';
  assert.equal(first.document.recipe.title, 'Fixture soup');
  assert.ok(Object.isFrozen(first.document.recipe.instructions[0]));
  assert.deepEqual(await readRecipeContentRevision(first, sha256), first);
});
test('all content is copied before asynchronous fingerprint adapters execute', async () => {
  const input = authoredFixture();
  let calls = 0;
  const revision = await createRecipeContentRevision(input, 'revision-1', async (value) => {
    calls++; input.recipe.title = 'Changed while hashing'; return sha256(value);
  });
  assert.equal(calls, 2);
  assert.equal(revision.document.recipe.title, 'Fixture soup');
  assert.deepEqual(await readRecipeContentRevision(revision, sha256), revision);
});
test('modified recipe, revision, owner or fingerprint cannot pass revision integrity', async () => {
  const revision = await createRecipeContentRevision(authoredFixture(), 'revision-1', sha256);
  for (const modify of [
    (value: typeof revision) => { (value.ref as { revisionId: string }).revisionId = 'revision-2'; },
    (value: typeof revision) => { (value.ref as { recipeId: string }).recipeId = '90002'; },
    (value: typeof revision) => { (value.document.recipe as { title: string }).title = 'Unrelated title'; },
    (value: typeof revision) => { (value as { revisionFingerprint: string }).revisionFingerprint = '0'.repeat(64); },
  ]) {
    const changed = clone(revision); modify(changed);
    await assert.rejects(readRecipeContentRevision(changed, sha256));
  }
});
test('strict document bounds and associations reject invented source rows and malformed ownership', () => {
  const valid = authoredFixture();
  assert.ok(validateRecipeContentDocument(valid));
  const variants: unknown[] = [
    { ...clone(valid), privateNotes: 'not content' },
    { ...clone(valid), kind: 'imported' },
    { ...clone(valid), recipe: { ...valid.recipe, recipeId: 'recipe-1' } },
    { ...clone(valid), recipe: { ...valid.recipe, title: 'x'.repeat(513) } },
    { ...clone(valid), recipe: { ...valid.recipe, videoUrl: 'https://youtube.com.evil.test/watch?v=C5n1fN8TGHs' } },
    { ...clone(valid), recipe: { ...valid.recipe, ingredients: [{ position: 1, rawName: 'Salt', rawMeasure: null, source: { sheet: 'Ingredients', row: 6 } }] } },
    { ...clone(valid), recipe: { ...valid.recipe, instructions: [{ sequence: 2, rawText: 'Stir', presentation: 'passage' }] } },
    { ...clone(valid), media: [{ ...valid.media[0], recipeId: '90002' }] },
    { ...clone(valid), media: [{ ...valid.media[0], photoKey: 'photos/other.jpg' }] },
    { ...clone(valid), media: [valid.media[0], valid.media[0]] },
  ];
  for (const value of variants) assert.equal(validateRecipeContentDocument(value), false);
  assert.equal(validateRecipeContentRef({ recipeId: '90001', revisionId: 'r', contentFingerprint: 'F'.repeat(64) }), false);
  assert.equal(validateRecipeContentRef({ recipeId: '90001', revisionId: 'r', contentFingerprint: 'f'.repeat(64), extra: 1 }), false);
});
test('unknown metadata stays null; zero and non-null claims require actual review fields', () => {
  const metadata = authoredFixture().metadata;
  assert.ok(validateReviewedMetadata(metadata));
  assert.equal(metadata.cookMinutes.value, null);
  metadata.cookMinutes = { value: 0, review: null };
  assert.equal(validateReviewedMetadata(metadata), false);
  metadata.cookMinutes.review = clone(evidence);
  assert.ok(validateReviewedMetadata(metadata));
  metadata.servings = { value: null, review: clone(evidence) };
  assert.equal(validateReviewedMetadata(metadata), false);
  metadata.servings = { value: 0, review: clone(evidence) };
  assert.equal(validateReviewedMetadata(metadata), false);
});
test('media metadata has exact hash identity, bounded dimensions and separate publication blockers', () => {
  const media = authoredFixture().media[0]!;
  assert.ok(validateMediaReference(media));
  assert.deepEqual(mediaPublicationBlockers(media), []);
  for (const change of [
    { assetId: 'asset-arbitrary' }, { bytes: 0 }, { bytes: CONTENT_LIMITS.mediaBytes + 1 },
    { photoKey: '../photo.jpg' }, { mimeType: 'image/svg+xml' }, { mimeType: 'image/png' },
    { dimensions: { width: 800, height: 600 } },
    { dimensions: { width: 0, height: 600, review: evidence } },
    { dimensions: { width: CONTENT_LIMITS.imageDimension + 1, height: 600, review: evidence } },
    { rights: { status: 'permitted', statement: 'Someone said yes', review: null } },
    { attribution: { text: null, url: 'javascript:alert(1)' } },
  ]) assert.equal(validateMediaReference({ ...media, ...change }), false);
  const unknown = { ...media, dimensions: null, rights: { status: 'unreviewed', statement: null, review: null } };
  assert.ok(validateMediaReference(unknown));
  assert.deepEqual(mediaPublicationBlockers(unknown), ['dimensions_unverified', 'rights_not_permitted']);
});
test('basedOn has the same stable recipe identity but structural acceptance does not establish trust', () => {
  const input = authoredFixture();
  assert.equal(input.kind, 'authored');
  if (input.kind !== 'authored') throw new Error('fixture');
  input.provenance.basedOn = { recipeId: input.recipe.recipeId, revisionId: 'unresolved-old-revision', contentFingerprint: 'a'.repeat(64) };
  assert.ok(validateRecipeContentDocument(input));
  input.provenance.basedOn.recipeId = '90002';
  assert.equal(validateRecipeContentDocument(input), false);
});
test('all bundled records, original photos, provenance, warnings and null values survive the adapter', async () => {
  const snapshot = await createBundledContentSnapshot(sha256);
  assert.equal(snapshot.trust, 'packaged_baseline');
  assert.deepEqual(snapshot.catalogue, catalogue.identity);
  assert.equal(snapshot.revisions.length, 100);
  for (const revision of snapshot.revisions) {
    const recipe = catalogue.getRecipe(revision.ref.recipeId)!;
    assert.deepEqual(revision.document.recipe, recipe);
    assert.equal(revision.document.kind, 'imported');
    if (revision.document.kind !== 'imported') throw new Error('fixture');
    assert.deepEqual(revision.document.provenance.recipeSource, catalogueProvenance.recipeSources.find((item) => item.recipeId === recipe.recipeId));
    assert.deepEqual(revision.document.provenance.photoTreatment, catalogueProvenance.photoTreatments.find((item) => item.recipeId === recipe.recipeId));
    const asset = catalogueProvenance.assets.find((item) => item.recipeId === recipe.recipeId)!;
    assert.equal(revision.document.media[0]!.sha256, asset.sha256);
    assert.equal(revision.document.media[0]!.bytes, asset.bytes);
    assert.equal(revision.document.media[0]!.photoKey, recipe.photoKey);
    assert.equal(revision.document.media[0]!.rights.status, 'unreviewed');
    assert.equal(revision.document.media[0]!.dimensions, null);
    assert.equal(revision.document.metadata.servings.value, null);
  }
  await assert.rejects(createBundledRecipeRevision('unknown', sha256));
});
test('import provenance cannot point at a different recipe, missing annotation or unrelated source row', async () => {
  const revision = await createBundledRecipeRevision('53262', sha256);
  const doc = clone(revision.document);
  assert.equal(doc.kind, 'imported');
  if (doc.kind !== 'imported') throw new Error('fixture');
  assert.equal(validateRecipeContentDocument({ ...doc, provenance: { ...doc.provenance, recipeSource: { ...doc.provenance.recipeSource, recipeId: '90001' } } }), false);
  assert.equal(validateRecipeContentDocument({ ...doc, provenance: { ...doc.provenance, photoTreatment: { ...doc.provenance.photoTreatment, warningAnnotationId: 'invented' } } }), false);
  const bad = clone(doc) as unknown as { recipe: { ingredients: { source: { row: number } }[] } };
  bad.recipe.ingredients[0]!.source.row = 1;
  assert.equal(validateRecipeContentDocument(bad), false);
});
test('oversized input and invalid hash outputs fail closed', async () => {
  await assert.rejects(createRecipeContentRevision({ padding: 'x'.repeat(CONTENT_LIMITS.documentBytes) }, 'revision-1', sha256));
  await assert.rejects(createRecipeContentRevision(authoredFixture(), 'revision-1', async () => 'not-a-digest'));
});
