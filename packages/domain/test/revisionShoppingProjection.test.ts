import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import {
  createContentReader,
  verifySignedContentOverlay,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { PlanOccurrence } from '@cookmate/contracts';
import { buildShoppingProjection, reconcilePurchaseState } from '../src/shoppingProjection';
import { buildRevisionShoppingProjection } from '../../../apps/mobile/src/data/revisionShoppingProjection';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import {
  member,
  overlayFixture,
  published,
  signed,
} from '../../catalogue/test/content-overlay-fixtures';

// These are controlled catalogue verification ports, not real signature/service/device proof.
function occurrence(recipeId: string): PlanOccurrence {
  return {
    occurrenceId: randomUUID(),
    recipeId,
    placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}
async function revisions(titleOnly = false) {
  const document = authoredFixture();
  if (document.kind !== 'authored') throw new Error('fixture');
  document.recipe.ingredients = [
    { position: 1, rawName: 'Salt', rawMeasure: '100g' },
    { position: 2, rawName: 'Oil', rawMeasure: '1 tbsp' },
  ];
  const f = await overlayFixture(document);
  const first = f.publication.revision.ref;
  f.releases.set(f.manifest.releaseId, {
    manifest: f.manifest,
    fingerprint: f.envelope.fingerprint,
  });
  f.publications.set(`${first.recipeId}|${first.revisionId}`, f.publication);
  const nextDocument = clone(document);
  nextDocument.provenance.basedOn = clone(first);
  if (titleOnly) nextDocument.recipe.title = 'A changed title, exact same ingredients';
  else nextDocument.recipe.ingredients[0]!.rawMeasure = '200g';
  const second = await published(nextDocument, 'revision-2');
  const head = {
    releaseId: f.manifest.releaseId,
    sequence: 1,
    fingerprint: f.envelope.fingerprint,
  };
  const manifest = {
    ...f.manifest,
    releaseId: 'overlay-2',
    sequence: 2,
    previous: head,
    entries: [member(second)],
  };
  const options = {
    ...f.options,
    expectedCurrent: head,
    minimumSequence: 1,
    publications: [second],
    retainedRefs: [first],
  };
  const snapshot = await verifySignedContentOverlay(await signed(manifest), options);
  return {
    f,
    first,
    second: second.revision.ref,
    reader: createContentReader(snapshot),
    manifest,
    options,
  };
}
const calculate = (
  ref: RecipeContentRef,
  selected: PlanOccurrence,
  reader: ReturnType<typeof createContentReader>,
) =>
  buildRevisionShoppingProjection([{ occurrence: selected, contentRef: ref }], {
    lookupExact: reader.lookupExact,
    sha256,
  });

test('legacy imported pins retain exact arithmetic/fingerprints and all original notices', async () => {
  const f = await overlayFixture();
  const reader = createContentReader(await verifySignedContentOverlay(f.envelope, f.options));
  const selected = occurrence(f.base.ref.recipeId);
  const old = await buildShoppingProjection([selected], {
    readRecipe: catalogue.getRecipe,
    sha256,
  });
  const next = await calculate(f.base.ref, selected, reader);
  assert.deepEqual(
    next.groups.map(({ sourceFingerprint: _hash, contributions, ...group }) => ({
      ...group,
      contributions: contributions.map(({ contentRef: _ref, ...contribution }) => contribution),
    })),
    old,
  );
  assert.deepEqual(
    next.notices[0]!.annotations,
    catalogue.getRecipe(selected.recipeId)!.annotations,
  );
  assert.equal(next.notices.length, 1);
  assert.ok(
    next.groups.every((group) =>
      group.contributions.every(
        (item) => item.contentRef.contentFingerprint === f.base.ref.contentFingerprint,
      ),
    ),
  );
});

test('two meals using different revisions of one recipe keep their own quantities and source pins', async () => {
  const { first, second, reader } = await revisions();
  const a = occurrence(first.recipeId),
    b = occurrence(second.recipeId);
  const next = await buildRevisionShoppingProjection(
    [
      { occurrence: a, contentRef: first },
      { occurrence: b, contentRef: second },
    ],
    { lookupExact: reader.lookupExact, sha256 },
  );
  assert.equal(next.groups.find((group) => group.displayName === 'Salt')!.quantityLabel, '300 g');
  assert.equal(next.groups.find((group) => group.displayName === 'Oil')!.quantityLabel, '2 tbsp');
  const salt = next.groups.find((group) => group.displayName === 'Salt')!.contributions;
  assert.deepEqual(salt.find((item) => item.occurrenceId === a.occurrenceId)!.contentRef, first);
  assert.deepEqual(salt.find((item) => item.occurrenceId === b.occurrenceId)!.contentRef, second);
  assert.ok(salt.every((item) => item.source.section === 'ingredient'));
  assert.equal(next.notices.length, 0);
});

test('reviewed revision replacement invalidates only changed demand while exact provenance always changes', async () => {
  const { first, second, reader } = await revisions();
  const selected = occurrence(first.recipeId);
  const old = await calculate(first, selected, reader),
    next = await calculate(second, selected, reader);
  for (const current of next.groups) {
    const prior = old.groups.find((group) => group.groupKey === current.groupKey)!;
    const state = reconcilePurchaseState(current, {
      ...prior,
      purchased: true,
      changed: false,
      revision: 4,
    });
    assert.notEqual(current.sourceFingerprint, prior.sourceFingerprint);
    if (current.displayName === 'Salt')
      assert.deepEqual(state, { purchased: false, changed: true, revision: 5 });
    else assert.deepEqual(state, { purchased: true, changed: false, revision: 4 });
  }
  const title = await revisions(true);
  const before = await calculate(title.first, selected, title.reader);
  const after = await calculate(title.second, selected, title.reader);
  assert.deepEqual(
    after.groups.map((group) => group.demandFingerprint),
    before.groups.map((group) => group.demandFingerprint),
  );
  assert.ok(
    after.groups.every(
      (group, index) => group.sourceFingerprint !== before.groups[index]!.sourceFingerprint,
    ),
  );
});

test('missing, mismatched or withdrawn pins fail closed; archived historical content remains exact', async () => {
  const { first, second, reader, manifest, options } = await revisions();
  const selected = occurrence(first.recipeId);
  await assert.rejects(
    calculate({ ...first, contentFingerprint: '0'.repeat(64) }, selected, reader),
    /unavailable/,
  );
  await assert.rejects(
    buildRevisionShoppingProjection([{ occurrence: selected, contentRef: first }], {
      lookupExact: () => reader.lookupExact(second),
      sha256,
    }),
    /identity changed/,
  );
  const withdrawn = createContentReader(
    await verifySignedContentOverlay(
      await signed({
        ...manifest,
        entries: [{ state: 'withdrawn', recipeId: first.recipeId, reason: 'Synthetic withdrawal' }],
      }),
      { ...options, publications: [] },
    ),
  );
  await assert.rejects(calculate(first, selected, withdrawn), /withdrawn/);
  const archived = createContentReader(
    await verifySignedContentOverlay(
      await signed({
        ...manifest,
        entries: [{ ...manifest.entries[0]!, state: 'archived', reason: 'Synthetic archive' }],
      }),
      options,
    ),
  );
  assert.equal(archived.getRecipe(first.recipeId), undefined);
  const exact = await calculate(first, selected, archived);
  assert.equal(exact.groups.find((group) => group.displayName === 'Salt')!.quantityLabel, '100 g');
});

test('authored descendants keep original warnings distinct without inventing original-source demand', async () => {
  const seed = await overlayFixture();
  const document = authoredFixture(seed.base.ref.recipeId);
  if (document.kind !== 'authored') throw new Error('fixture');
  document.provenance.basedOn = clone(seed.base.ref);
  const f = await overlayFixture(document);
  const reader = createContentReader(await verifySignedContentOverlay(f.envelope, f.options));
  const selected = occurrence(f.base.ref.recipeId);
  const next = await calculate(f.publication.revision.ref, selected, reader);
  assert.equal(next.groups.length, 1);
  assert.equal(next.groups[0]!.quantityLabel, 'Amount not supplied');
  assert.equal(next.groups[0]!.contributions[0]!.rawMeasure, null);
  assert.deepEqual(next.notices[0]!.contentRef, f.base.ref);
  assert.equal(next.notices[0]!.disposition, 'inherited_unresolved');
  if (seed.base.document.kind !== 'imported') throw new Error('fixture');
  assert.deepEqual(next.notices[0]!.annotations, seed.base.document.recipe.annotations);
  assert.equal(reader.getRecipe(selected.recipeId)!.ingredients[0]!.source, null);
});

test('large valid source fanout is rejected before building or hashing a partial shopping list', async () => {
  const document = authoredFixture();
  if (document.kind !== 'authored') throw new Error('fixture');
  document.recipe.ingredients = Array.from({ length: 100 }, (_, index) => ({
    position: index + 1,
    rawName: 'Salt',
    rawMeasure: '1g',
  }));
  const f = await overlayFixture(document);
  const reader = createContentReader(await verifySignedContentOverlay(f.envelope, f.options));
  let hashes = 0;
  await assert.rejects(
    buildRevisionShoppingProjection(
      Array.from({ length: 1000 }, () => ({
        occurrence: occurrence(f.publication.revision.ref.recipeId),
        contentRef: f.publication.revision.ref,
      })),
      {
        lookupExact: reader.lookupExact,
        sha256: async (text) => {
          hashes++;
          return sha256(text);
        },
      },
    ),
    /source demand exceeds supported bound/,
  );
  assert.equal(hashes, 0);
});

test('in-flight caller changes cannot rebind pins and repeated occurrence IDs are rejected', async () => {
  const { first, second, reader } = await revisions();
  const selected = occurrence(first.recipeId);
  const expected = await calculate(first, selected, reader);
  const input = [{ occurrence: clone(selected), contentRef: clone(first) }];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = buildRevisionShoppingProjection(input, {
    lookupExact: reader.lookupExact,
    sha256: async (text) => {
      await gate;
      return sha256(text);
    },
  });
  input[0]!.contentRef = clone(second);
  input[0]!.occurrence.recipeId = '1';
  release();
  const actual = await pending;
  assert.deepEqual(actual, expected);
  assert.ok(Object.isFrozen(actual.groups[0]!.contributions[0]!.contentRef));
  await assert.rejects(
    buildRevisionShoppingProjection(
      [
        { occurrence: selected, contentRef: first },
        { occurrence: selected, contentRef: second },
      ],
      { lookupExact: reader.lookupExact, sha256 },
    ),
    /Invalid pinned/,
  );
});
