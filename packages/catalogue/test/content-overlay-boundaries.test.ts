import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySignedContentOverlay } from '../src/content/index';
import type { ContentOverlayManifest, PublishedRecipeRevision } from '../src/content/overlay-types';
import { authoredFixture, clone, sha256 } from './content-fixtures';
import { overlayFixture, published, signed } from './content-overlay-fixtures';

test('malformed and repeated historical pins reject before consulting trust ports', async () => {
  const fixture = await overlayFixture();
  let trustCalls = 0;
  for (const retainedRefs of [
    [fixture.base.ref, fixture.base.ref],
    [{ ...fixture.base.ref, autoFetch: true }],
  ]) {
    await assert.rejects(
      verifySignedContentOverlay(fixture.envelope, {
        ...fixture.options,
        retainedRefs,
        trustVerifier: {
          async verify() {
            trustCalls++;
            return true;
          },
        },
      }),
      /overlay_retained_refs/,
    );
  }
  assert.equal(trustCalls, 0);
});

test('a historical pin must resolve exactly from retained host evidence, never an attached candidate', async () => {
  const fixture = await overlayFixture();
  const historical = await published(authoredFixture(), 'historical-revision');
  await assert.rejects(
    verifySignedContentOverlay(fixture.envelope, {
      ...fixture.options,
      publications: [fixture.publication, historical],
      retainedRefs: [historical.revision.ref],
    }),
    /overlay_dependency_missing/,
  );
  await assert.rejects(
    verifySignedContentOverlay(fixture.envelope, {
      ...fixture.options,
      retainedRefs: [{ ...fixture.base.ref, contentFingerprint: '0'.repeat(64) }],
    }),
    /overlay_baseline_reference/,
  );

  fixture.publications.set('90001|historical-revision', historical);
  const snapshot = await verifySignedContentOverlay(fixture.envelope, {
    ...fixture.options,
    retainedRefs: [historical.revision.ref],
  });
  const exact = snapshot.lookupExact(historical.revision.ref);
  assert.equal(exact.kind === 'readable' && exact.state, 'historical');
  assert.equal(snapshot.lookupCurrent('90001').kind, 'readable');
  assert.deepEqual(
    snapshot.discoverable.map((item) => item.revision.ref.revisionId),
    [fixture.base.ref.revisionId, 'revision-1'],
  );
});

test('archive publications are copied before a later hash port can mutate returned records', async () => {
  const fixture = await overlayFixture();
  let returned: PublishedRecipeRevision | null = null;
  const snapshot = await verifySignedContentOverlay(fixture.envelope, {
    ...fixture.options,
    publications: [],
    archive: {
      ...fixture.options.archive,
      async readPublication() {
        returned = clone(fixture.publication);
        return returned;
      },
    },
    async sha256(input) {
      if (returned) returned.revision.document.recipe.title = 'Changed after archive return';
      return sha256(input);
    },
  });
  const current = snapshot.lookupCurrent('90001');
  assert.equal(
    current.kind === 'readable' && current.value.revision.document.recipe.title,
    'Fixture soup',
  );
});

test('an archive response for another immutable identity cannot satisfy an exact reference', async () => {
  const fixture = await overlayFixture();
  const wrong = await published(authoredFixture('90002'));
  await assert.rejects(
    verifySignedContentOverlay(fixture.envelope, {
      ...fixture.options,
      publications: [],
      archive: {
        ...fixture.options.archive,
        async readPublication() {
          return wrong;
        },
      },
    }),
    /archive_identity/,
  );
});

test('withdrawn pinned content is denied without asking the archive for its former body', async () => {
  const fixture = await overlayFixture();
  fixture.releases.set(fixture.manifest.releaseId, {
    manifest: fixture.manifest,
    fingerprint: fixture.envelope.fingerprint,
  });
  const previous = {
    releaseId: fixture.manifest.releaseId,
    sequence: 1,
    fingerprint: fixture.envelope.fingerprint,
  };
  const manifest: ContentOverlayManifest = {
    ...fixture.manifest,
    releaseId: 'overlay-2',
    sequence: 2,
    previous,
    entries: [{ state: 'withdrawn', recipeId: '90001', reason: 'Permission withdrawn.' }],
  };
  const snapshot = await verifySignedContentOverlay(await signed(manifest), {
    ...fixture.options,
    publications: [],
    expectedCurrent: previous,
    minimumSequence: 1,
    retainedRefs: [fixture.publication.revision.ref],
    archive: {
      ...fixture.options.archive,
      async readPublication() {
        throw new Error('A withdrawn body must not be requested');
      },
    },
  });
  assert.deepEqual(snapshot.lookupExact(fixture.publication.revision.ref), {
    kind: 'withdrawn',
    recipeId: '90001',
    reason: 'Permission withdrawn.',
  });
  assert.deepEqual(
    snapshot.discoverable.map((item) => item.revision.ref.recipeId),
    [fixture.base.ref.recipeId],
  );
});
