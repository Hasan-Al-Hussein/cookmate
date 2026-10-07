import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '../src/index';
import {
  OVERLAY_LIMITS,
  canonicalContentJson,
  contentOverlaySignaturePayload,
  createBundledRecipeRevision,
  validateContentOverlayManifest,
  verifySignedContentOverlay,
} from '../src/content/index';
import type { ContentOverlayManifest, PublishedRecipeRevision } from '../src/content/overlay-types';
import type { RecipeContentDocument } from '../src/content/types';
import { authoredFixture, clone, evidence, sha256 } from './content-fixtures';
import { member, overlayFixture, published, signed } from './content-overlay-fixtures';

test('effective snapshot distinguishes packaged source from approved additions without rewriting baseline rights', async () => {
  const f = await overlayFixture();
  const result = await verifySignedContentOverlay(f.envelope, f.options);
  assert.equal(result.identity.version, 'overlay-v2:1');
  assert.equal(result.trust, 'signature_verified');
  assert.equal(result.mediaBytes, 'verified_by_host');
  assert.equal(result.ancestry, 'resolved_by_host');
  assert.deepEqual(
    result.discoverable.map((view) => view.revision.ref.recipeId),
    [f.base.ref.recipeId, '90001'],
  );
  const base = result.lookupExact(clone(f.base.ref));
  assert.equal(base.kind, 'readable');
  if (base.kind !== 'readable') throw new Error('fixture');
  assert.equal(base.value.origin, 'packaged_baseline');
  assert.equal(base.value.revision.document.media[0]!.rights.status, 'unreviewed');
  assert.equal(base.value.retainedSources[0]!.disposition, 'original');
  assert.ok(Object.isFrozen(result.discoverable[1]!.publication!.permissions));
  assert.ok(Object.isFrozen(base.value.retainedSources[0]!.document));
  assert.equal(
    result.lookupExact({ ...f.publication.revision.ref, contentFingerprint: '0'.repeat(64) }).kind,
    'missing',
  );
});
test('signature scope is canonical and checksums do not establish configured trust', async () => {
  const f = await overlayFixture();
  let payload = '';
  await verifySignedContentOverlay(f.envelope, {
    ...f.options,
    trustVerifier: {
      async verify(input) {
        payload = input.canonicalPayload;
        return true;
      },
    },
  });
  assert.equal(payload, contentOverlaySignaturePayload(f.manifest, f.envelope.fingerprint));
  assert.match(payload, /cookmate-signed-overlay-v2/);
  await assert.rejects(
    verifySignedContentOverlay(f.envelope, {
      ...f.options,
      trustVerifier: {
        async verify() {
          return false;
        },
      },
    }),
    /overlay_untrusted/,
  );
  const changed = clone(f.envelope);
  changed.manifest.createdAt = '2026-09-30T12:01:00.000Z';
  await assert.rejects(verifySignedContentOverlay(changed, f.options), /overlay_integrity/);
  await assert.rejects(
    verifySignedContentOverlay(
      { ...f.envelope, signature: { ...f.envelope.signature, publicKey: 'downloaded-key' } },
      f.options,
    ),
    /overlay_signature/,
  );
});
test('manifest exact grammar prevents ambiguous current members and unsupported fields', async () => {
  const f = await overlayFixture();
  for (const value of [
    { ...f.manifest, formatVersion: 1 },
    { ...f.manifest, autoActivate: true },
    { ...f.manifest, entries: [...f.manifest.entries, ...f.manifest.entries] },
    { ...f.manifest, sequence: 2 },
    { ...f.manifest, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...f.manifest, baseline: { ...f.manifest.baseline, publicKey: 'downloaded-key' } },
    { ...f.manifest, entries: [{ ...f.manifest.entries[0], state: 'hidden' }] },
    { ...f.manifest, entries: [{ state: 'withdrawn', recipeId: '90001', reason: '  ' }] },
    {
      ...f.manifest,
      entries: Array.from({ length: OVERLAY_LIMITS.overrides + 1 }, (_, index) => ({
        state: 'withdrawn',
        recipeId: String(index),
        reason: 'Fixture.',
      })),
    },
  ])
    assert.equal(validateContentOverlayManifest(value), false);
});
test('packaged identity must independently match and its exception cannot admit an unreviewed published revision', async () => {
  const f = await overlayFixture();
  const wrong = clone(f.manifest);
  wrong.baseline.fingerprint = '0'.repeat(64);
  await assert.rejects(
    verifySignedContentOverlay(await signed(wrong), f.options),
    /overlay_baseline/,
  );
  const fakeException = clone(f.manifest);
  fakeException.entries = [
    { state: 'current', ref: f.publication.revision.ref, publicationFingerprint: null },
  ];
  await assert.rejects(
    verifySignedContentOverlay(await signed(fakeException), f.options),
    /overlay_packaged_exception/,
  );
  const baseOnly = { ...f.manifest, entries: [] };
  assert.equal(
    (await verifySignedContentOverlay(await signed(baseOnly), { ...f.options, publications: [] }))
      .discoverable.length,
    1,
  );
});
test('actual media verification is required for packaged and published bytes, including port failures', async () => {
  const f = await overlayFixture();
  for (const rejectedId of [f.base.ref.recipeId, '90001']) {
    await assert.rejects(
      verifySignedContentOverlay(f.envelope, {
        ...f.options,
        mediaVerifier: {
          async verify(media) {
            return media.recipeId !== rejectedId;
          },
        },
      }),
      /overlay_media_unverified/,
    );
  }
  await assert.rejects(
    verifySignedContentOverlay(f.envelope, {
      ...f.options,
      mediaVerifier: {
        async verify() {
          throw new Error('media unavailable');
        },
      },
    }),
    /media unavailable/,
  );
});
test('wrong publication digest, unused candidates and immutable identity rebinding are rejected', async () => {
  const f = await overlayFixture();
  const wrong = clone(f.manifest);
  if (wrong.entries[0]!.state === 'withdrawn') throw new Error('fixture');
  wrong.entries[0]!.publicationFingerprint = '0'.repeat(64);
  await assert.rejects(
    verifySignedContentOverlay(await signed(wrong), f.options),
    /overlay_publication_reference/,
  );
  await assert.rejects(
    verifySignedContentOverlay(f.envelope, {
      ...f.options,
      publications: [...f.options.publications, await published(authoredFixture('90002'))],
    }),
    /overlay_unused_publication/,
  );
  const different = authoredFixture();
  different.recipe.title = 'Rebound immutable ID';
  f.publications.set('90001|revision-1', await published(different));
  await assert.rejects(
    verifySignedContentOverlay(f.envelope, f.options),
    /overlay_revision_rebound/,
  );
});
test('all data inputs are copied before async trust/hash ports can mutate callers', async () => {
  const f = await overlayFixture();
  const sources = clone(f.options.baseline);
  const input = clone(f.publication);
  const pins = [{ ...f.base.ref }];
  const result = await verifySignedContentOverlay(f.envelope, {
    ...f.options,
    publications: [input],
    baseline: sources,
    retainedRefs: pins,
    trustVerifier: {
      async verify() {
        input.revision.document.recipe.title = 'Injected';
        (sources.revisions[0]!.document.recipe as { title: string }).title = 'Injected baseline';
        pins[0]!.revisionId = 'Injected pin';
        f.envelope.manifest.releaseId = 'Injected release';
        return true;
      },
    },
  });
  assert.equal(result.envelope.manifest.releaseId, 'overlay-1');
  assert.equal(result.discoverable[1]!.revision.document.recipe.title, 'Fixture soup');
  assert.notEqual(result.discoverable[0]!.revision.document.recipe.title, 'Injected baseline');
});

async function nextFixture() {
  const f = await overlayFixture();
  f.releases.set(f.manifest.releaseId, {
    manifest: f.manifest,
    fingerprint: f.envelope.fingerprint,
  });
  f.publications.set('90001|revision-1', f.publication);
  const head = {
    releaseId: f.manifest.releaseId,
    sequence: 1,
    fingerprint: f.envelope.fingerprint,
  };
  const manifest: ContentOverlayManifest = {
    ...f.manifest,
    releaseId: 'overlay-2',
    sequence: 2,
    previous: head,
  };
  return {
    ...f,
    next: manifest,
    nextOptions: { ...f.options, expectedCurrent: head, minimumSequence: 1, publications: [] },
  };
}
test('expected current head and high-water reject replay, old branch and future gaps', async () => {
  const f = await nextFixture();
  await assert.rejects(verifySignedContentOverlay(f.envelope, f.nextOptions), /overlay_stale_head/);
  await assert.rejects(
    verifySignedContentOverlay(await signed(f.next), { ...f.nextOptions, minimumSequence: 2 }),
    /overlay_stale_head/,
  );
  await assert.rejects(
    verifySignedContentOverlay(await signed(f.next), {
      ...f.nextOptions,
      expectedCurrent: { ...f.nextOptions.expectedCurrent, fingerprint: '0'.repeat(64) },
    }),
    /overlay_stale_head/,
  );
  const gap = { ...f.next, sequence: 3 };
  assert.equal(validateContentOverlayManifest(gap), false);
  f.releases.delete('overlay-1');
  await assert.rejects(
    verifySignedContentOverlay(await signed(f.next), f.nextOptions),
    /overlay_previous_untrusted/,
  );
});
test('release IDs are immutable and a supplied predecessor cannot replace host archive evidence', async () => {
  const f = await nextFixture();
  f.releases.set('overlay-2', {
    manifest: f.next,
    fingerprint: (await signed(f.next)).fingerprint,
  });
  await assert.rejects(
    verifySignedContentOverlay(await signed(f.next), f.nextOptions),
    /overlay_release_rebound/,
  );
  f.releases.delete('overlay-2');
  f.releases.set('overlay-1', { manifest: f.manifest, fingerprint: '0'.repeat(64) });
  await assert.rejects(
    verifySignedContentOverlay(await signed(f.next), f.nextOptions),
    /overlay_previous_untrusted/,
  );
});
test('cumulative membership cannot silently omit an added identity', async () => {
  const f = await nextFixture();
  await assert.rejects(
    verifySignedContentOverlay(await signed({ ...f.next, entries: [] }), f.nextOptions),
    /overlay_not_cumulative/,
  );
  const unknownWithdrawal = {
    ...f.next,
    entries: [
      ...f.next.entries,
      { state: 'withdrawn' as const, recipeId: '99999', reason: 'Unknown.' },
    ],
  };
  await assert.rejects(
    verifySignedContentOverlay(await signed(unknownWithdrawal), f.nextOptions),
    /overlay_unknown_withdrawal/,
  );
});
test('archive preserves exact reading while suppressing discovery, and rollback requires new monotonic release', async () => {
  const f = await nextFixture();
  f.next.entries = [{ ...member(f.publication), state: 'archived', reason: 'Editorial archive.' }];
  const archivedEnvelope = await signed(f.next);
  const archived = await verifySignedContentOverlay(archivedEnvelope, f.nextOptions);
  assert.equal(archived.lookupCurrent('90001').kind, 'readable');
  const exact = archived.lookupExact(f.publication.revision.ref);
  assert.equal(exact.kind === 'readable' && exact.state, 'archived');
  assert.equal(archived.lookupDiscoverable('90001').kind, 'missing');
  f.releases.set('overlay-2', { manifest: f.next, fingerprint: archivedEnvelope.fingerprint });
  const previous = {
    releaseId: 'overlay-2',
    sequence: 2,
    fingerprint: archivedEnvelope.fingerprint,
  };
  const rollback = {
    ...f.next,
    releaseId: 'overlay-3',
    sequence: 3,
    previous,
    entries: [member(f.publication)],
  };
  const result = await verifySignedContentOverlay(await signed(rollback), {
    ...f.nextOptions,
    expectedCurrent: previous,
    minimumSequence: 2,
  });
  assert.equal(result.lookupDiscoverable('90001').kind, 'readable');
  assert.equal(result.identity.version, 'overlay-v2:3');
});
test('withdrawal denies all historic/current reads and cannot be undone by ordinary rollback', async () => {
  const f = await nextFixture();
  f.next.entries = [{ state: 'withdrawn', recipeId: '90001', reason: 'Permission withdrawn.' }];
  const withdrawnEnvelope = await signed(f.next);
  const result = await verifySignedContentOverlay(withdrawnEnvelope, {
    ...f.nextOptions,
    retainedRefs: [f.publication.revision.ref],
  });
  assert.equal(result.lookupExact(f.publication.revision.ref).kind, 'withdrawn');
  assert.equal(result.lookupCurrent('90001').kind, 'withdrawn');
  assert.equal(result.lookupDiscoverable('90001').kind, 'withdrawn');
  f.releases.set('overlay-2', { manifest: f.next, fingerprint: withdrawnEnvelope.fingerprint });
  const previous = {
    releaseId: 'overlay-2',
    sequence: 2,
    fingerprint: withdrawnEnvelope.fingerprint,
  };
  const undo = {
    ...f.next,
    releaseId: 'overlay-3',
    sequence: 3,
    previous,
    entries: [member(f.publication)],
  };
  await assert.rejects(
    verifySignedContentOverlay(await signed(undo), {
      ...f.nextOptions,
      expectedCurrent: previous,
      minimumSequence: 2,
    }),
    /overlay_not_cumulative/,
  );
});
test('trusted ancestry and retained pins expose historical bodies separately from current additions', async () => {
  const f = await nextFixture();
  const doc = authoredFixture();
  if (doc.kind !== 'authored') throw new Error('fixture');
  doc.provenance.basedOn = f.publication.revision.ref;
  doc.recipe.title = 'Updated soup';
  const next = await published(doc, 'revision-2');
  f.next.entries = [member(next)];
  const result = await verifySignedContentOverlay(await signed(f.next), {
    ...f.nextOptions,
    publications: [next],
    retainedRefs: [f.publication.revision.ref],
  });
  const historic = result.lookupExact(f.publication.revision.ref);
  assert.equal(historic.kind === 'readable' && historic.state, 'historical');
  assert.equal(
    result.discoverable.find((view) => view.revision.ref.recipeId === '90001')!.revision.document
      .recipe.title,
    'Updated soup',
  );
});
test('unknown ancestry, candidate-only ancestry and identity cycles fail closed', async () => {
  const f = await overlayFixture();
  const doc = authoredFixture();
  if (doc.kind !== 'authored') throw new Error('fixture');
  doc.provenance.basedOn = f.publication.revision.ref;
  const descendant = await published(doc, 'revision-2');
  const envelope = await signed({ ...f.manifest, entries: [member(descendant)] });
  await assert.rejects(
    verifySignedContentOverlay(envelope, {
      ...f.options,
      publications: [descendant, f.publication],
    }),
    /overlay_dependency_missing/,
  );
  const cycleDoc = authoredFixture();
  if (cycleDoc.kind !== 'authored') throw new Error('fixture');
  cycleDoc.provenance.basedOn = {
    ...f.publication.revision.ref,
    contentFingerprint: '0'.repeat(64),
  };
  const cyclic = await published(cycleDoc, 'revision-1');
  await assert.rejects(
    verifySignedContentOverlay(await signed({ ...f.manifest, entries: [member(cyclic)] }), {
      ...f.options,
      publications: [cyclic],
    }),
    /overlay_ancestry_bound/,
  );
});
test('known identities cannot discard lineage by submitting a fresh authored root', async () => {
  const f = await nextFixture();
  const next = await published(authoredFixture(), 'revision-2');
  await assert.rejects(
    verifySignedContentOverlay(await signed({ ...f.next, entries: [member(next)] }), {
      ...f.nextOptions,
      publications: [next],
    }),
    /overlay_lineage_required/,
  );
  const baselineReplacement = await published(authoredFixture(f.base.ref.recipeId));
  await assert.rejects(
    verifySignedContentOverlay(
      await signed({ ...f.next, entries: [...f.next.entries, member(baselineReplacement)] }),
      { ...f.nextOptions, publications: [baselineReplacement] },
    ),
    /overlay_lineage_required/,
  );
});
test('authored descendants retain exact contextual source annotations and photo treatment without claiming resolution', async () => {
  const f = await overlayFixture();
  const sourceId = catalogueProvenance.photoTreatments.find(
    (item) => item.warningAnnotationId !== null,
  )!.recipeId;
  const base = await createBundledRecipeRevision(sourceId, sha256);
  assert.equal(base.document.kind, 'imported');
  if (base.document.kind !== 'imported') throw new Error('fixture');
  assert.ok(base.document.recipe.annotations.length > 0);
  const doc = authoredFixture(sourceId);
  if (doc.kind !== 'authored') throw new Error('fixture');
  doc.provenance.basedOn = clone(base.ref);
  const revision = await published(doc);
  const result = await verifySignedContentOverlay(
    await signed({ ...f.manifest, entries: [member(revision)] }),
    {
      ...f.options,
      baseline: { identity: { ...catalogue.identity }, revisions: [base] },
      publications: [revision],
    },
  );
  const current = result.lookupCurrent(sourceId);
  if (current.kind !== 'readable') throw new Error('fixture');
  const retained = current.value.retainedSources[0]!;
  assert.equal(retained.disposition, 'inherited_unresolved');
  assert.deepEqual(retained.document.recipe.annotations, base.document.recipe.annotations);
  assert.deepEqual(
    retained.document.provenance.photoTreatment,
    base.document.provenance.photoTreatment,
  );
  assert.equal(current.value.revision.document.kind, 'authored');
});
test('imported revisions cannot borrow trusted source hashes while changing original quantities or passages', async () => {
  const f = await overlayFixture();
  const doc: RecipeContentDocument = JSON.parse(JSON.stringify(f.base.document));
  doc.media[0]!.dimensions = { width: 800, height: 600, review: clone(evidence) };
  doc.media[0]!.rights = {
    status: 'permitted',
    statement: 'Synthetic fixture permission.',
    review: clone(evidence),
  };
  for (const change of [
    (value: RecipeContentDocument) => {
      value.recipe.ingredients[0]!.rawMeasure = '999 kg';
    },
    (value: RecipeContentDocument) => {
      value.recipe.instructions[0]!.rawText = 'Unrelated source';
    },
  ]) {
    const bad = clone(doc);
    change(bad);
    const revision = await published(bad, 'reviewed-import');
    await assert.rejects(
      verifySignedContentOverlay(await signed({ ...f.manifest, entries: [member(revision)] }), {
        ...f.options,
        publications: [revision],
      }),
      /overlay_imported_source_mismatch/,
    );
  }
  const valid = await published(doc, 'reviewed-import');
  const result = await verifySignedContentOverlay(
    await signed({ ...f.manifest, entries: [member(valid)] }),
    { ...f.options, publications: [valid] },
  );
  assert.equal(result.lookupCurrent(f.base.ref.recipeId).kind, 'readable');
});
test('conflicting facts for a shared immutable media hash cannot pass even with permissive test ports', async () => {
  const f = await overlayFixture();
  const doc = authoredFixture('90002');
  doc.media[0]!.bytes++;
  const other = await published(doc);
  await assert.rejects(
    verifySignedContentOverlay(
      await signed({ ...f.manifest, entries: [...f.manifest.entries, member(other)] }),
      { ...f.options, publications: [f.publication, other] },
    ),
    /overlay_media_contradiction/,
  );
});
test('ancestry depth and candidate counts are finite even for a correctly hashed trusted archive', async () => {
  const f = await overlayFixture();
  let parent: PublishedRecipeRevision = f.publication;
  f.publications.set(`90001|${parent.revision.ref.revisionId}`, parent);
  for (let index = 2; index <= OVERLAY_LIMITS.ancestryDepth + 1; index++) {
    const doc = authoredFixture();
    if (doc.kind !== 'authored') throw new Error('fixture');
    doc.provenance.basedOn = clone(parent.revision.ref);
    parent = await published(doc, `revision-${index}`);
    f.publications.set(`90001|${parent.revision.ref.revisionId}`, parent);
  }
  await assert.rejects(
    verifySignedContentOverlay(await signed({ ...f.manifest, entries: [member(parent)] }), {
      ...f.options,
      publications: [parent],
    }),
    /overlay_ancestry_bound/,
  );
  await assert.rejects(
    verifySignedContentOverlay(f.envelope, {
      ...f.options,
      publications: Array(OVERLAY_LIMITS.publications + 1).fill(f.publication),
    }),
    /overlay_publication_count/,
  );
});
test('manifest object-key order is canonical while editorial addition ordering remains meaningful', async () => {
  const f = await overlayFixture();
  const other = await published(authoredFixture('90002'));
  const manifest = { ...f.manifest, entries: [member(other), member(f.publication)] };
  const envelope = await signed(manifest);
  const result = await verifySignedContentOverlay(JSON.parse(canonicalContentJson(envelope)), {
    ...f.options,
    publications: [f.publication, other],
  });
  assert.deepEqual(
    result.discoverable.slice(1).map((view) => view.revision.ref.recipeId),
    ['90002', '90001'],
  );
  assert.notEqual(
    envelope.fingerprint,
    (await signed({ ...manifest, entries: [...manifest.entries].reverse() })).fingerprint,
  );
});
