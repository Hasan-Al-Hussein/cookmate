import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogue, catalogueBoundary } from '../src';
import {
  createBundledContentReader,
  createBundledRecipeRevision,
  createContentReader,
  verifySignedContentOverlay,
  type RecipeContentRef,
} from '../src/content';
import { sha256 } from './content-fixtures';
import { overlayFixture, signed } from './content-overlay-fixtures';

test('packaged reader preserves all original recipe fields, sources, quantities and known identity', async () => {
  const reader = await createBundledContentReader(sha256);
  assert.deepEqual(reader.identity, catalogue.identity);
  assert.equal(reader.recipes.length, 100);
  assert.deepEqual([...reader.boundary.recipeIds].sort(), [...catalogueBoundary.recipeIds].sort());
  for (const original of catalogue.recipes) {
    const projected = reader.getRecipe(original.recipeId)!;
    for (const [field, value] of Object.entries(original))
      assert.deepEqual(
        projected[field as keyof typeof projected],
        value,
        `${original.recipeId}.${field}`,
      );
    assert.equal(projected.contentKind, 'imported');
    assert.equal(projected.description, null);
    assert.equal(projected.retainedSources.length, 1);
    assert.equal(projected.retainedSources[0]!.disposition, 'original');
    assert.deepEqual(projected.retainedSources[0]!.document.recipe, original);
    assert.deepEqual(
      projected.contentRef,
      (await createBundledRecipeRevision(original.recipeId, sha256)).ref,
    );
    const current = reader.lookupCurrent(original.recipeId),
      exact = reader.lookupExact(projected.contentRef);
    assert.equal(current.kind, 'readable');
    assert.equal(exact.kind, 'readable');
    if (current.kind !== 'readable' || exact.kind !== 'readable') assert.fail();
    assert.equal(current.recipe, projected);
    assert.equal(exact.recipe, projected);
    assert.equal(exact.state, 'current');
    for (const source of [
      { recipeId: original.recipeId, section: 'recipe' as const },
      ...original.ingredients.map((row) => ({
        recipeId: original.recipeId,
        section: 'ingredient' as const,
        position: row.position,
      })),
      ...original.instructions.map((row) => ({
        recipeId: original.recipeId,
        section: 'instruction' as const,
        position: row.sequence,
      })),
      ...original.annotations.map((row) => ({
        recipeId: original.recipeId,
        section: 'annotation' as const,
        annotationId: row.annotationId,
      })),
    ])
      assert.equal(reader.boundary.hasSource(source), catalogueBoundary.hasSource(source));
  }
  assert.equal('trust' in reader, false);
  assert.equal('envelope' in reader, false);
});

test('exact packaged references reject changed identity or shape without falling back to current content', async () => {
  const reader = await createBundledContentReader(sha256);
  const recipe = reader.recipes[0]!,
    other = reader.recipes[1]!;
  for (const ref of [
    { ...recipe.contentRef, contentFingerprint: '0'.repeat(64) },
    { ...recipe.contentRef, revisionId: 'unretained-revision' },
    { ...recipe.contentRef, recipeId: other.recipeId },
    { ...recipe.contentRef, newest: true },
    null,
  ])
    assert.deepEqual(reader.lookupExact(ref as RecipeContentRef), { kind: 'missing' });
  assert.deepEqual(reader.lookupCurrent('missing'), { kind: 'missing' });
  assert.equal(reader.getRecipe('missing'), undefined);
  assert.equal(
    reader.boundary.hasSource({
      recipeId: recipe.recipeId,
      section: 'ingredient',
      position: 999999,
    }),
    false,
  );
  assert.equal(
    reader.boundary.hasSource({
      recipeId: recipe.recipeId,
      section: 'recipe',
      extra: true,
    } as never),
    false,
  );
  assert.equal(reader.getRecipe(recipe.recipeId), recipe);
});

test('bundled and signed-baseline reading projections agree, without exposing mutable originals', async () => {
  const reader = await createBundledContentReader(sha256);
  const fixture = await overlayFixture();
  const snapshot = await verifySignedContentOverlay(
    await signed({ ...fixture.manifest, entries: [] }),
    { ...fixture.options, publications: [] },
  );
  const signedReader = createContentReader(snapshot);
  const recipe = reader.getRecipe(fixture.base.ref.recipeId)!;
  assert.deepEqual(recipe, signedReader.getRecipe(fixture.base.ref.recipeId));
  assert.ok(
    Object.isFrozen(reader) && Object.isFrozen(reader.recipes) && Object.isFrozen(reader.identity),
  );
  assert.ok(Object.isFrozen(recipe) && Object.isFrozen(recipe.contentRef));
  assert.ok(Object.isFrozen(recipe.ingredients) && Object.isFrozen(recipe.ingredients[0]!.source));
  assert.ok(Object.isFrozen(recipe.retainedSources[0]!.document.recipe.instructions));
  assert.equal(Reflect.set(recipe.ingredients[0]!, 'rawMeasure', 'invented'), false);
  assert.equal(reader.boundary.recipeIds.has(recipe.recipeId), true);
  assert.equal('add' in reader.boundary.recipeIds, false);
  assert.deepEqual(
    reader.lookupExact(recipe.contentRef),
    signedReader.lookupExact(recipe.contentRef),
  );
});
