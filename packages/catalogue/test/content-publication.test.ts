import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTENT_AUTHORING_LIMITS,
  CONTENT_LIMITS,
  canonicalContentJson,
  createPublishedRecipeRevision,
  createRecipeContentRevision,
  readPublishedRecipeRevision,
  publicationPermissionBinding,
  validateAuthoredRecipe,
  validateRecipeVideoUrl,
} from '../src/content/index';
import { PUBLICATION_MAX_BYTES } from '../src/content/publication';
import type { PublicationPermission } from '../src/content/overlay-types';
import type { RecipeContentRef } from '../src/content/types';
import { authoredFixture, clone, evidence, sha256 } from './content-fixtures';
import { published } from './content-overlay-fixtures';

test('publication binds exact text, every photo and optional video to immutable revision evidence', async () => {
  const value = await published();
  const result = await readPublishedRecipeRevision(value, sha256);
  assert.deepEqual(result, value);
  assert.deepEqual(
    result.permissions.map((record) => record.subject.scope),
    ['recipe_text', 'photo', 'video_embed'],
  );
  assert.ok(Object.isFrozen(result.permissions[0]!.review));
  const noVideo = authoredFixture();
  noVideo.recipe.videoUrl = null;
  assert.equal((await published(noVideo)).permissions.length, 2);
});
test('missing, repeated, extra, restricted or unreviewed permission fails closed', async () => {
  const value = await published();
  for (const permissions of [
    value.permissions.slice(1),
    [...value.permissions, value.permissions[0]],
    value.permissions.map((record, index) =>
      index ? record : { ...record, status: 'unreviewed' },
    ),
    value.permissions.map((record, index) =>
      index ? record : { ...record, status: 'restricted' },
    ),
    value.permissions.map((record, index) => (index ? record : { ...record, statement: '  ' })),
    value.permissions.map((record, index) =>
      index ? record : { ...record, sourceUrl: 'javascript:alert(1)' },
    ),
    value.permissions.map((record, index) => (index ? record : { ...record, fakeVerified: true })),
  ])
    await assert.rejects(createPublishedRecipeRevision(value.revision, permissions, sha256));
});
test('photo scope evidence cannot contradict scoped media evidence or point at another association', async () => {
  const value = await published();
  const changed = clone(value.permissions);
  changed[1]!.statement = 'Unrelated permission.';
  await assert.rejects(
    createPublishedRecipeRevision(value.revision, changed, sha256),
    /permission_contradiction/,
  );
  const swapped = clone(value.permissions);
  if (swapped[1]!.subject.scope !== 'photo') throw new Error('fixture');
  swapped[1]!.subject.photoKey = 'photos/unrelated.jpg';
  swapped[1]!.contentBinding = await publicationPermissionBinding(
    value.revision.ref,
    swapped[1]!.subject,
    sha256,
  );
  await assert.rejects(
    createPublishedRecipeRevision(value.revision, swapped, sha256),
    /permission_missing/,
  );
});
test('correct content digest does not permit copying evidence across revision identities', async () => {
  const first = await published();
  const second = await published(authoredFixture(), 'revision-2');
  assert.equal(first.revision.ref.contentFingerprint, second.revision.ref.contentFingerprint);
  await assert.rejects(
    createPublishedRecipeRevision(second.revision, first.permissions, sha256),
    /permission_binding/,
  );
  const changed = clone(first);
  changed.permissions[0]!.review.source = 'Altered evidence';
  await assert.rejects(readPublishedRecipeRevision(changed, sha256), /publication_integrity/);
});
test('input evidence is owned before asynchronous hashing and canonical key order is stable', async () => {
  const first = await published();
  const result = await createPublishedRecipeRevision(
    first.revision,
    first.permissions,
    async (input) => {
      first.permissions[0]!.statement = 'Caller mutated this';
      return sha256(input);
    },
  );
  assert.equal(result.permissions[0]!.statement, 'Fixture text permission.');
  const shuffled = JSON.parse(canonicalContentJson(result));
  assert.equal(
    (await readPublishedRecipeRevision(shuffled, sha256)).publicationFingerprint,
    result.publicationFingerprint,
  );
});
test('authoring exports preserve existing v1 limits, unknown amounts, passage order and URL grammar', () => {
  const doc = authoredFixture();
  assert.equal(CONTENT_AUTHORING_LIMITS.description, 4000);
  assert.equal(CONTENT_AUTHORING_LIMITS.ingredients, 100);
  assert.ok(validateAuthoredRecipe(doc.recipe));
  assert.equal(doc.recipe.ingredients[0]!.rawMeasure, null);
  assert.equal(validateAuthoredRecipe({ ...doc.recipe, description: 'x'.repeat(4001) }), false);
  assert.equal(
    validateAuthoredRecipe({ ...doc.recipe, instructions: [...doc.recipe.instructions].reverse() }),
    false,
  );
  assert.equal(validateRecipeVideoUrl(null), true);
  assert.equal(validateRecipeVideoUrl('https://youtube.com.evil.test/watch?v=C5n1fN8TGHs'), false);
  assert.equal(validateRecipeVideoUrl('https://youtu.be/C5n1fN8TGHs'), true);
});

test('publication creation rejects a combined envelope its reader cannot accept, without truncation', async () => {
  const document = authoredFixture();
  document.media = Array.from({ length: 8 }, (_, index) => {
    const digest = String(index + 1).repeat(64);
    return {
      ...clone(document.media[0]!),
      assetId: `sha256:${digest}`,
      sha256: digest,
      photoKey: index === 0 ? document.recipe.photoKey : `photos/90001-${index}.jpg`,
      rights: {
        status: 'permitted' as const,
        statement: 's'.repeat(4000),
        review: { ...clone(evidence), source: 'r'.repeat(2048) },
      },
    };
  });
  document.recipe.instructions = Array.from({ length: 100 }, (_, index) => ({
    sequence: index + 1,
    rawText: 'x',
    presentation: 'passage' as const,
  }));
  let remaining = CONTENT_LIMITS.documentBytes - Buffer.byteLength(canonicalContentJson(document));
  for (const passage of document.recipe.instructions) {
    const added = Math.min(remaining, CONTENT_AUTHORING_LIMITS.passage - passage.rawText.length);
    passage.rawText += 'x'.repeat(added);
    remaining -= added;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(canonicalContentJson(document)), CONTENT_LIMITS.documentBytes);

  async function permissions(ref: RecipeContentRef): Promise<PublicationPermission[]> {
    const subjects: PublicationPermission['subject'][] = [
      { scope: 'recipe_text' },
      ...document.media.map(({ assetId, photoKey }) => ({
        scope: 'photo' as const,
        assetId,
        photoKey,
      })),
      { scope: 'video_embed', url: document.recipe.videoUrl! },
    ];
    const records: PublicationPermission[] = [];
    for (const subject of subjects)
      records.push({
        subject,
        status: 'permitted',
        statement: 's'.repeat(4000),
        sourceUrl: null,
        review: { ...clone(evidence), source: 'r'.repeat(2048) },
        contentBinding: await publicationPermissionBinding(ref, subject, sha256),
      });
    let available = 64 * 1024 - Buffer.byteLength(canonicalContentJson(records));
    assert.ok(available > 0);
    for (const record of records) {
      if (available === 0) break;
      const extra = Math.min(available, CONTENT_AUTHORING_LIMITS.url - 2);
      const prefix = 'https://example.test/';
      assert.ok(extra + 2 >= prefix.length);
      record.sourceUrl = prefix + 'x'.repeat(extra + 2 - prefix.length);
      available -= extra;
    }
    assert.equal(available, 0);
    assert.equal(Buffer.byteLength(canonicalContentJson(records)), 64 * 1024);
    return records;
  }

  const revision = await createRecipeContentRevision(document, 'large-revision', sha256);
  await assert.rejects(
    createPublishedRecipeRevision(revision, await permissions(revision.ref), sha256),
    /json_size/,
  );
  assert.equal(document.recipe.ingredients[0]!.rawMeasure, null);
  assert.equal(Buffer.byteLength(canonicalContentJson(document)), CONTENT_LIMITS.documentBytes);

  // Reducing only the synthetic text makes room for the envelope; accepted output round-trips.
  document.recipe.instructions[0]!.rawText = document.recipe.instructions[0]!.rawText.slice(1024);
  const smaller = await createRecipeContentRevision(document, 'large-revision', sha256);
  const accepted = await createPublishedRecipeRevision(
    smaller,
    await permissions(smaller.ref),
    sha256,
  );
  assert.ok(Buffer.byteLength(canonicalContentJson(accepted)) <= PUBLICATION_MAX_BYTES);
  assert.deepEqual(
    (await readPublishedRecipeRevision(accepted, sha256)).revision.document,
    document,
  );
});
