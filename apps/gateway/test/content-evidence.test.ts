import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createContentReader, verifySignedContentOverlay } from '@cookmate/catalogue/content';
import {
  authoredFixture,
  clone,
  evidence as reviewEvidence,
} from '../../../packages/catalogue/test/content-fixtures';
import { overlayFixture, signed } from '../../../packages/catalogue/test/content-overlay-fixtures';
import { createContentEvidenceBuilder } from '../src/evidence';
import { createOrchestrator } from '../src/orchestrator';
import type { ModelProvider, ProviderInput } from '../src/provider-contract';
import { nonMemoryUpdate, request } from './helpers';

// Controlled catalogue contracts, not actual signing/media/provider or service acceptance.
test('one reader preserves imported source rows and authored rows without invented workbook locators', async () => {
  const f = await overlayFixture();
  const snapshot = await verifySignedContentOverlay(f.envelope, f.options);
  const reader = createContentReader(snapshot);
  const baseline = reader.getRecipe(f.base.ref.recipeId)!;
  assert.deepEqual(baseline.ingredients, catalogue.getRecipe(f.base.ref.recipeId)!.ingredients);
  assert.deepEqual(baseline.instructions, catalogue.getRecipe(f.base.ref.recipeId)!.instructions);
  assert.deepEqual(baseline.annotations, catalogue.getRecipe(f.base.ref.recipeId)!.annotations);
  const authored = reader.getRecipe('90001')!;
  assert.equal(authored.contentKind, 'authored');
  assert.equal(authored.ingredients[0]!.source, null);
  assert.equal(authored.ingredients[0]!.rawMeasure, null);
  assert.equal(authored.instructions[1]!.rawText, 'Stir gently.\nServe.');
  assert.equal(authored.instructions[1]!.source, null);
  assert.ok(Object.isFrozen(authored.contentRef));
  assert.equal(
    reader.lookupExact({ ...authored.contentRef, contentFingerprint: '0'.repeat(64) }).kind,
    'missing',
  );
  const gateway = createContentEvidenceBuilder(snapshot);
  assert.deepEqual(
    gateway.retrieve({ query: 'Fixture soup' }).matches.map((match) => match.recipeId),
    ['90001'],
  );
  assert.deepEqual(gateway.identity, reader.identity);
  assert.deepEqual(gateway.packet(['90001'])[0]!.contentRef, authored.contentRef);
  assert.equal(gateway.packet(['90001'])[0]!.ingredients[0]!.locator, null);
  assert.equal(
    reader.boundary.hasSource({ recipeId: '90001', section: 'instruction', position: 2 }),
    true,
  );
  assert.equal(
    reader.boundary.hasSource({ recipeId: '90001', section: 'instruction', position: 3 }),
    false,
  );
  assert.equal(Reflect.get(reader.boundary.recipeIds, 'add'), undefined);
});

async function descendant() {
  const seed = await overlayFixture();
  const document = authoredFixture(seed.base.ref.recipeId);
  assert.equal(document.kind, 'authored');
  if (document.kind !== 'authored') throw new Error('fixture');
  document.provenance.basedOn = clone(seed.base.ref);
  document.metadata.servings = { value: 2, review: clone(reviewEvidence) };
  document.metadata.prepMinutes = { value: 0, review: clone(reviewEvidence) };
  document.metadata.nutrition = {
    value: {
      basis: 'per_serving',
      energyKcal: 10,
      proteinGrams: null,
      carbohydrateGrams: null,
      fatGrams: null,
    },
    review: clone(reviewEvidence),
  };
  const f = await overlayFixture(document);
  return { f, snapshot: await verifySignedContentOverlay(f.envelope, f.options) };
}

test('original warnings and exact historical rows stay separate from authored passages and reviewed metadata', async () => {
  const { f, snapshot } = await descendant();
  const reader = createContentReader(snapshot);
  const current = reader.getRecipe(f.base.ref.recipeId)!;
  assert.equal(current.annotations.length, 0);
  assert.equal(current.retainedSources[0]!.disposition, 'inherited_unresolved');
  const historical = reader.lookupExact(clone(f.base.ref));
  assert.equal(historical.kind, 'readable');
  if (historical.kind !== 'readable') throw new Error('fixture');
  assert.equal(historical.state, 'historical');
  assert.deepEqual(historical.recipe.contentRef, f.base.ref);
  const packet = createContentEvidenceBuilder(snapshot).packet([current.recipeId])[0]!;
  assert.deepEqual(
    packet.retainedOriginalWarnings.map((note) => note.note),
    catalogue.getRecipe(current.recipeId)!.annotations.map((note) => note.note),
  );
  assert.deepEqual(packet.retainedOriginalWarnings[0]!.originalContentRef, f.base.ref);
  assert.equal(packet.annotations.length, 0);
  assert.equal(
    reader.boundary.hasSource({
      recipeId: current.recipeId,
      section: 'annotation',
      annotationId: packet.retainedOriginalWarnings[0]!.originalAnnotationId,
    }),
    false,
  );
  assert.equal(packet.reviewedMetadata!.prepMinutes.value, 0);
  assert.equal(packet.unavailableMetadata.includes('servings'), false);
  assert.equal(packet.unavailableMetadata.includes('nutrition'), false);
  assert.equal(packet.unavailableMetadata.includes('verified_total_duration'), true);
});

test('gateway forces retained warning disclosure and rejects a different catalogue before any model call', async () => {
  const { f, snapshot } = await descendant();
  const builder = createContentEvidenceBuilder(snapshot);
  const calls: ProviderInput[] = [];
  const provider: ModelProvider = {
    async complete(input) {
      calls.push(input);
      return {
        value: {
          kind: 'respond',
          sufficiency: 'sufficient',
          missingFacts: [],
          memoryUpdate: nonMemoryUpdate(input.request),
          response: {
            kind: 'answer',
            text: 'The recipe includes salt with no supplied quantity.',
            sources: [{ recipeId: f.base.ref.recipeId, section: 'ingredient', position: 1 }],
            recipeIds: [f.base.ref.recipeId],
          },
        },
        usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 },
      };
    },
  };
  const run = createOrchestrator(provider, builder);
  const execution = () => ({ signal: new AbortController().signal, deadline: Date.now() + 45000 });
  await assert.rejects(run(request(), execution()), /incompatible_version/);
  assert.equal(calls.length, 0);
  const input = request();
  input.catalogue = { ...builder.identity };
  const result = await run(input, execution());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.evidence[0]!.contentRef, f.publication.revision.ref);
  assert.equal(result.kind, 'answer');
  if (result.kind !== 'answer') throw new Error('fixture');
  assert.match(result.text, /original revision; not yet resolved for this version/);
  for (const note of builder.packet([f.base.ref.recipeId])[0]!.retainedOriginalWarnings)
    assert.ok(result.text.includes(note.note));
  assert.ok(result.sources.some((source) => source.section === 'recipe'));
  assert.equal(
    result.sources.some((source) => source.section === 'annotation'),
    false,
  );
});

test('archived and withdrawn recipes cannot enter discovery, explicit or selected gateway packets', async () => {
  const f = await overlayFixture();
  const entry = f.manifest.entries[0]!;
  if (entry.state !== 'current') throw new Error('fixture');
  f.manifest.entries = [{ ...entry, state: 'archived', reason: 'Synthetic archive test.' }];
  const envelope = await signed(f.manifest);
  const archived = await verifySignedContentOverlay(envelope, f.options);
  const reader = createContentReader(archived);
  const exact = reader.lookupExact(clone(f.publication.revision.ref));
  assert.equal(exact.kind, 'readable');
  if (exact.kind !== 'readable') throw new Error('fixture');
  assert.equal(exact.state, 'archived');
  assert.equal(reader.getRecipe('90001'), undefined);
  const gateway = createContentEvidenceBuilder(archived);
  assert.equal(gateway.retrieve({ query: 'Fixture soup' }).matches.length, 0);
  assert.throws(() => gateway.packet(['90001']), /unknown_recipe/);
  const selected = request();
  selected.catalogue = { ...gateway.identity };
  selected.context.selectedRecipeId = '90001';
  assert.throws(() => gateway.initial(selected), /unknown_recipe/);
  f.releases.set(f.manifest.releaseId, { manifest: f.manifest, fingerprint: envelope.fingerprint });
  f.publications.set('90001|revision-1', f.publication);
  const previous = {
    releaseId: f.manifest.releaseId,
    sequence: 1,
    fingerprint: envelope.fingerprint,
  };
  const next = {
    ...f.manifest,
    releaseId: 'overlay-2',
    sequence: 2,
    previous,
    entries: [
      { state: 'withdrawn' as const, recipeId: '90001', reason: 'Synthetic withdrawal test.' },
    ],
  };
  const withdrawn = await verifySignedContentOverlay(await signed(next), {
    ...f.options,
    expectedCurrent: previous,
    minimumSequence: 1,
    publications: [],
    retainedRefs: [clone(f.publication.revision.ref)],
  });
  assert.equal(
    createContentReader(withdrawn).lookupExact(clone(f.publication.revision.ref)).kind,
    'withdrawn',
  );
  assert.throws(() => createContentEvidenceBuilder(withdrawn).packet(['90001']), /unknown_recipe/);
});
