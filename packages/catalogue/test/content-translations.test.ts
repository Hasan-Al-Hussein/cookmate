import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTENT_AUTHORING_LIMITS,
  MAX_PUBLICATION_TRANSLATIONS,
  TRANSLATED_PUBLICATION_READER_VERSION,
  canonicalContentJson,
  createContentReader,
  createPublishedRecipeRevision,
  createTranslatedPublishedRecipeRevision,
  publicationPermissionBinding,
  readPublishedRecipeRevision,
  validateTranslationLanguage,
  verifySignedContentOverlay,
  type ContentOverlayManifest,
  type PublishedRecipeRevision,
  type PublishedRecipeRevisionV3,
  type PublishedRecipeTranslation,
  type RecipeContentDocument,
} from '../src/content';
import { PUBLICATION_MAX_BYTES } from '../src/content/publication';
import { authoredFixture, clone, evidence, sha256 } from './content-fixtures';
import { member, overlayFixture, published, signed } from './content-overlay-fixtures';

// Synthetic operator/permission assertions and controlled verifier ports only.
// These cases do not certify language quality, actual rights or operational signing.
function ownPublication(
  value: Awaited<ReturnType<typeof createTranslatedPublishedRecipeRevision>>,
): PublishedRecipeRevisionV3 {
  return JSON.parse(canonicalContentJson(value)) as PublishedRecipeRevisionV3;
}
async function translation(
  base: PublishedRecipeRevision,
  targetLanguage = 'ar',
): Promise<PublishedRecipeTranslation> {
  const subject = {
    scope: 'translated_recipe_text' as const,
    translationId: `translation-${targetLanguage}`,
    translationRevision: 2,
    language: targetLanguage,
  };
  return {
    translationId: subject.translationId,
    translationRevision: subject.translationRevision,
    sourceRef: clone(base.revision.ref),
    originalLanguage: 'en',
    targetLanguage,
    content: {
      title: 'عنوان تجريبي',
      description: null,
      category: 'حساء',
      cuisine: 'تجريبي',
      rawTags: null,
      ingredients: base.revision.document.recipe.ingredients.map((row) => ({
        position: row.position,
        rawName: 'ملح',
      })),
      instructions: base.revision.document.recipe.instructions.map((row) => ({
        sequence: row.sequence,
        rawText: 'نص تجريبي\nمحفوظ.',
      })),
    },
    attribution: 'mixed',
    machineAssisted: true,
    review: { ...clone(evidence), evidence: 'operator_acknowledgement' },
    permission: {
      subject,
      status: 'permitted',
      statement: 'Synthetic translated text permission, not a real licence.',
      sourceUrl: null,
      review: clone(evidence),
      contentBinding: await publicationPermissionBinding(base.revision.ref, subject, sha256),
    },
  };
}
async function fixture() {
  const base = await published(),
    item = await translation(base);
  return {
    base,
    item,
    create: (items: unknown = [item]) =>
      createTranslatedPublishedRecipeRevision(base.revision, base.permissions, items, sha256),
  };
}
async function translatedOverlay() {
  const f = await overlayFixture();
  const item = await translation(f.publication);
  const publication = ownPublication(
    await createTranslatedPublishedRecipeRevision(
      f.publication.revision,
      f.publication.permissions,
      [item],
      sha256,
    ),
  );
  const manifest = {
    ...f.manifest,
    minimumReaderVersion: TRANSLATED_PUBLICATION_READER_VERSION,
    entries: [member(publication)],
  };
  const envelope = await signed(manifest);
  const options = {
    ...f.options,
    readerVersion: TRANSLATED_PUBLICATION_READER_VERSION,
    publications: [publication],
  };
  return { ...f, publication, manifest, envelope, options };
}
async function retainedOverlay() {
  const f = await translatedOverlay();
  await verifySignedContentOverlay(f.envelope, f.options);
  f.releases.set(f.manifest.releaseId, {
    manifest: f.manifest,
    fingerprint: f.envelope.fingerprint,
  });
  f.publications.set(
    `${f.publication.revision.ref.recipeId}|${f.publication.revision.ref.revisionId}`,
    f.publication,
  );
  const head = {
    releaseId: f.manifest.releaseId,
    sequence: f.manifest.sequence,
    fingerprint: f.envelope.fingerprint,
  };
  const next: ContentOverlayManifest = {
    ...f.manifest,
    releaseId: 'overlay-2',
    sequence: 2,
    previous: head,
  };
  return {
    ...f,
    next,
    nextOptions: {
      ...f.options,
      expectedCurrent: head,
      minimumSequence: 1,
      publications: [] as PublishedRecipeRevision[],
    },
  };
}

test('publication3 retains original bytes, exact review and separate translated permission in its fingerprint', async () => {
  const f = await fixture(),
    value = await f.create();
  assert.equal(value.formatVersion, 3);
  assert.deepEqual(value.revision, f.base.revision);
  assert.deepEqual(value.permissions, f.base.permissions);
  assert.deepEqual(value.translations, [f.item]);
  assert.equal(
    value.publicationFingerprint,
    await sha256(
      canonicalContentJson([
        'cookmate-published-recipe-v3',
        {
          formatVersion: 3,
          revision: f.base.revision,
          permissions: f.base.permissions,
          translations: [f.item],
        },
      ]),
    ),
  );
  assert.deepEqual(await readPublishedRecipeRevision(value, sha256), value);
  assert.ok(
    Object.isFrozen(value.translations[0]!.content.instructions[0]) &&
      Object.isFrozen(value.translations[0]!.permission),
  );
});

test('publication2 keeps its exact shape and fingerprint domain and rejects translated subjects or extra text', async () => {
  const f = await fixture();
  const v2 = await createPublishedRecipeRevision(f.base.revision, f.base.permissions, sha256);
  assert.deepEqual(v2, f.base);
  assert.deepEqual(Object.keys(v2).sort(), [
    'formatVersion',
    'permissions',
    'publicationFingerprint',
    'revision',
  ]);
  assert.equal(
    v2.publicationFingerprint,
    await sha256(
      canonicalContentJson([
        'cookmate-published-recipe-v2',
        {
          formatVersion: 2,
          revision: f.base.revision,
          permissions: f.base.permissions,
        },
      ]),
    ),
  );
  await assert.rejects(
    createPublishedRecipeRevision(
      v2.revision,
      [f.item.permission, ...v2.permissions.slice(1)],
      sha256,
    ),
  );
  await assert.rejects(
    createPublishedRecipeRevision(v2.revision, [...v2.permissions, f.item.permission], sha256),
  );
  await assert.rejects(
    readPublishedRecipeRevision({ ...v2, translations: [f.item] }, sha256),
    /published_revision/,
  );
  await assert.rejects(
    readPublishedRecipeRevision({ ...(await f.create()), formatVersion: 2 }, sha256),
    /published_revision/,
  );
});

test('exact source identity and positive safe translation revision are required', async () => {
  const f = await fixture();
  for (const patch of [
    { sourceRef: { ...f.item.sourceRef, revisionId: 'another-source' } },
    { sourceRef: { ...f.item.sourceRef, contentFingerprint: '0'.repeat(64) } },
    { sourceRef: { ...f.item.sourceRef, recipeId: '90002' } },
    { translationRevision: 0 },
    { translationRevision: Number.MAX_SAFE_INTEGER + 1 },
    { translationId: '../other' },
  ])
    await assert.rejects(f.create([{ ...f.item, ...patch }]), /publication_translation/);
});

test('languages are canonical, different and unambiguous for one exact original', async () => {
  const f = await fixture();
  for (const targetLanguage of ['en', 'AR', 'en-us', 'und', 'ar\n', 'a'.repeat(36), 'x-private'])
    await assert.rejects(f.create([{ ...f.item, targetLanguage }]), /publication_translation/);
  assert.equal(validateTranslationLanguage('pt-BR'), true);
  assert.equal(validateTranslationLanguage('zh-Hant'), true);
  const other = await translation(f.base, 'fr');
  await assert.rejects(
    f.create([f.item, { ...other, targetLanguage: 'ar' }]),
    /translation_languages/,
  );
  await assert.rejects(
    f.create([f.item, { ...other, translationId: f.item.translationId }]),
    /translation_languages/,
  );
  await assert.rejects(
    f.create([f.item, { ...other, originalLanguage: 'de' }]),
    /translation_languages/,
  );
});

test('row counts, positions and sequences follow the original and cannot carry quantities, media or roles', async () => {
  const f = await fixture(),
    content = f.item.content;
  for (const patch of [
    { ingredients: [] },
    { ingredients: [...content.ingredients, ...content.ingredients] },
    { ingredients: [{ ...content.ingredients[0], position: 2 }] },
    { ingredients: [{ ...content.ingredients[0], rawMeasure: '1 g' }] },
    { instructions: [...content.instructions].reverse() },
    { instructions: content.instructions.map((row) => ({ ...row, sequence: 1 })) },
    { instructions: content.instructions.map((row) => ({ ...row, presentation: 'passage' })) },
    { photoKey: 'photos/other.jpg' },
  ])
    await assert.rejects(
      f.create([{ ...f.item, content: { ...content, ...patch } }]),
      /publication_translation/,
    );
});

test('translated permission is explicit, exact, permitted and cannot borrow base text approval', async () => {
  const f = await fixture();
  for (const permission of [
    null,
    f.base.permissions[0],
    { ...f.item.permission, status: 'unreviewed' },
    { ...f.item.permission, status: 'restricted' },
    { ...f.item.permission, statement: '  ' },
    { ...f.item.permission, sourceUrl: 'javascript:bad' },
    { ...f.item.permission, subject: { ...f.item.permission.subject, language: 'fr' } },
    { ...f.item.permission, subject: { ...f.item.permission.subject, translationRevision: 3 } },
    { ...f.item.permission, contentBinding: '0'.repeat(64) },
  ])
    await assert.rejects(
      f.create([{ ...f.item, permission }]),
      /publication_(translation_permission|permission_binding)/,
    );
  const second = await published(authoredFixture(), 'another-revision');
  const carried = { ...f.item, sourceRef: second.revision.ref };
  await assert.rejects(
    createTranslatedPublishedRecipeRevision(second.revision, second.permissions, [carried], sha256),
    /permission_binding/,
  );
});

test('review evidence and machine assistance remain explicit assertions', async () => {
  const f = await fixture();
  for (const patch of [
    { review: null },
    { review: { ...f.item.review, evidence: 'certified' } },
    { review: { ...f.item.review, reviewedAt: 'not-a-date' } },
    { review: { ...f.item.review, source: '  ' } },
    { review: { ...f.item.review, extra: true } },
    { machineAssisted: false },
    { attribution: 'unknown' },
  ])
    await assert.rejects(f.create([{ ...f.item, ...patch }]), /publication_translation/);
  assert.equal(
    (await f.create([{ ...f.item, attribution: 'human' }])).translations[0]!.machineAssisted,
    true,
  );
  assert.equal(
    (await f.create([{ ...f.item, attribution: 'human', machineAssisted: false }])).translations[0]!
      .machineAssisted,
    false,
  );
});

test('complete translation strings obey the original authoring bounds without trimming or truncation', async () => {
  const f = await fixture();
  for (const patch of [
    { title: '  ' },
    { title: 'x'.repeat(CONTENT_AUTHORING_LIMITS.title + 1) },
    { description: '' },
    { description: 'x'.repeat(CONTENT_AUTHORING_LIMITS.description + 1) },
    { category: 'x'.repeat(CONTENT_AUTHORING_LIMITS.category + 1) },
    { cuisine: ' ' },
    { rawTags: '' },
    {
      ingredients: [
        { position: 1, rawName: 'x'.repeat(CONTENT_AUTHORING_LIMITS.ingredientName + 1) },
      ],
    },
    {
      instructions: f.item.content.instructions.map((row) => ({
        ...row,
        rawText: 'x'.repeat(CONTENT_AUTHORING_LIMITS.passage + 1),
      })),
    },
  ])
    await assert.rejects(
      f.create([{ ...f.item, content: { ...f.item.content, ...patch } }]),
      /publication_translation/,
    );
  const exact = { ...f.item, content: { ...f.item.content, title: '  محفوظ كما هو  ' } };
  assert.equal((await f.create([exact])).translations[0]!.content.title, exact.content.title);
});

test('one to eight translations fit the count budget; empty and ninth entries are rejected', async () => {
  const f = await fixture();
  const items = await Promise.all(
    ['ar', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt'].map((language) =>
      translation(f.base, language),
    ),
  );
  assert.equal(items.length, MAX_PUBLICATION_TRANSLATIONS);
  assert.equal((await f.create(items)).translations.length, 8);
  await assert.rejects(f.create([]), /publication_translations/);
  await assert.rejects(
    f.create([...items, await translation(f.base, 'nl')]),
    /publication_translations/,
  );
});

test('combined publication byte budget stays unchanged and never shortens valid source or translation text', async () => {
  const document = authoredFixture();
  document.recipe.instructions = Array.from({ length: 60 }, (_, index) => ({
    sequence: index + 1,
    rawText: 'x'.repeat(11000),
    presentation: 'passage' as const,
  }));
  const base = await published(document),
    item = await translation(base);
  item.content.instructions = item.content.instructions.map((row) => ({
    ...row,
    rawText: 'ع'.repeat(4000),
  }));
  assert.ok(Buffer.byteLength(canonicalContentJson([item]), 'utf8') < PUBLICATION_MAX_BYTES);
  const before = canonicalContentJson({ base, item });
  await assert.rejects(
    createTranslatedPublishedRecipeRevision(base.revision, base.permissions, [item], sha256),
    /json_size/,
  );
  assert.equal(canonicalContentJson({ base, item }), before);
});

test('all input data is owned before hashing, including translated rows, permissions and review', async () => {
  const f = await fixture(),
    original = clone(f.item),
    originalBase = clone(f.base);
  const result = await createTranslatedPublishedRecipeRevision(
    f.base.revision,
    f.base.permissions,
    [f.item],
    async (text) => {
      f.item.content.instructions[0]!.rawText = 'mutated';
      f.item.review.source = 'mutated';
      f.item.permission.statement = 'mutated';
      f.base.permissions[0]!.statement = 'mutated';
      f.base.revision.document.recipe.title = 'mutated';
      return sha256(text);
    },
  );
  assert.deepEqual(result.translations, [original]);
  assert.deepEqual(result.revision, originalBase.revision);
  assert.deepEqual(result.permissions, originalBase.permissions);
});

test('accessor-bearing translated input is rejected before getters or hash callbacks execute', async () => {
  const f = await fixture();
  let getters = 0,
    hashes = 0;
  const hostile = {
    ...f.item,
    get content() {
      getters++;
      return f.item.content;
    },
  };
  await assert.rejects(
    createTranslatedPublishedRecipeRevision(
      f.base.revision,
      f.base.permissions,
      [hostile],
      async (text) => {
        hashes++;
        return sha256(text);
      },
    ),
    /json_accessor/,
  );
  assert.equal(getters, 0);
  assert.equal(hashes, 0);
});

test('tampering translated text, review or valid permission metadata invalidates the retained publication digest', async () => {
  const f = await fixture(),
    value = ownPublication(await f.create());
  for (const mutate of [
    (item: PublishedRecipeTranslation) => {
      item.content.title += '!';
    },
    (item: PublishedRecipeTranslation) => {
      item.review.source += '!';
    },
    (item: PublishedRecipeTranslation) => {
      item.permission.statement += '!';
    },
    (item: PublishedRecipeTranslation) => {
      item.machineAssisted = false;
      item.attribution = 'human';
    },
  ]) {
    const altered = clone(value);
    mutate(altered.translations[0]!);
    await assert.rejects(readPublishedRecipeRevision(altered, sha256), /publication_integrity/);
  }
});

test('reader exposes translations beside unchanged original text, quantities and heading roles', async () => {
  const f = await translatedOverlay();
  const reader = createContentReader(await verifySignedContentOverlay(f.envelope, f.options));
  const value = reader.lookupExact(f.publication.revision.ref);
  assert.equal(value.kind, 'readable');
  if (value.kind !== 'readable') assert.fail();
  const original = f.publication.revision.document.recipe;
  assert.equal(value.recipe.title, original.title);
  assert.equal(value.recipe.ingredients[0]!.rawName, original.ingredients[0]!.rawName);
  assert.equal(value.recipe.ingredients[0]!.rawMeasure, original.ingredients[0]!.rawMeasure);
  assert.equal(value.recipe.instructions[0]!.presentation, original.instructions[0]!.presentation);
  assert.deepEqual(value.recipe.translations, f.publication.translations);
  assert.deepEqual(reader.getRecipe(f.base.ref.recipeId)!.translations, []);
});

test('imported annotations, source locators, media and retained warnings stay intact alongside translations', async () => {
  const f = await overlayFixture(),
    original = f.base.document;
  const document: RecipeContentDocument = JSON.parse(canonicalContentJson(original));
  for (const media of document.media) {
    media.dimensions = { width: 800, height: 600, review: clone(evidence) };
    media.rights = {
      status: 'permitted',
      statement: 'Fixture imported media permission.',
      review: clone(evidence),
    };
  }
  const base = await published(document, 'reviewed-imported-source');
  const publication = ownPublication(
    await createTranslatedPublishedRecipeRevision(
      base.revision,
      base.permissions,
      [await translation(base)],
      sha256,
    ),
  );
  const manifest = { ...f.manifest, minimumReaderVersion: 2, entries: [member(publication)] };
  const reader = createContentReader(
    await verifySignedContentOverlay(await signed(manifest), {
      ...f.options,
      readerVersion: 2,
      publications: [publication],
    }),
  );
  const value = reader.getRecipe(f.base.ref.recipeId)!;
  assert.ok(original.kind === 'imported');
  assert.deepEqual(value.annotations, original.recipe.annotations);
  assert.deepEqual(value.ingredients, original.recipe.ingredients);
  assert.deepEqual(value.instructions, original.recipe.instructions);
  assert.deepEqual(value.media, document.media);
  assert.deepEqual(value.retainedSources[0]!.document, original);
  assert.equal(value.translations?.length, 1);
});

test('both client and declared release reader versions gate new translated publications', async () => {
  const f = await translatedOverlay();
  for (const [readerVersion, minimumReaderVersion] of [
    [1, 1],
    [1, 2],
    [2, 1],
  ]) {
    await assert.rejects(
      verifySignedContentOverlay(
        await signed({ ...f.manifest, minimumReaderVersion: minimumReaderVersion! }),
        { ...f.options, readerVersion: readerVersion! },
      ),
      /reader_incompatible/,
    );
  }
  await verifySignedContentOverlay(f.envelope, f.options);
  const old = await overlayFixture();
  await verifySignedContentOverlay(old.envelope, old.options);
});

test('archived translation bodies and trusted translated ancestors cannot evade either reader-version gate', async () => {
  const f = await retainedOverlay();
  const archived = {
    ...f.next,
    entries: [{ ...member(f.publication), state: 'archived' as const, reason: 'Fixture archive.' }],
  };
  for (const [readerVersion, minimumReaderVersion] of [
    [1, 1],
    [2, 1],
  ]) {
    await assert.rejects(
      verifySignedContentOverlay(
        await signed({ ...archived, minimumReaderVersion: minimumReaderVersion! }),
        { ...f.nextOptions, readerVersion: readerVersion! },
      ),
      /reader_incompatible/,
    );
  }
  const document = authoredFixture();
  assert.ok(document.kind === 'authored');
  document.provenance.basedOn = f.publication.revision.ref;
  const child = await published(document, 'untranslated-child');
  await assert.rejects(
    verifySignedContentOverlay(
      await signed({ ...f.next, minimumReaderVersion: 1, entries: [member(child)] }),
      { ...f.nextOptions, publications: [child] },
    ),
    /reader_incompatible/,
  );
  const snapshot = await verifySignedContentOverlay(
    await signed({ ...f.next, entries: [member(child)] }),
    { ...f.nextOptions, publications: [child] },
  );
  const old = createContentReader(snapshot).lookupExact(f.publication.revision.ref);
  assert.equal(old.kind, 'readable');
  assert.deepEqual(old.kind === 'readable' && old.recipe.translations, f.publication.translations);
});

test('withdrawal denies translated historical bodies without fetching their archived publication', async () => {
  const f = await retainedOverlay();
  let reads = 0;
  const manifest = {
    ...f.next,
    minimumReaderVersion: 1,
    entries: [
      { state: 'withdrawn' as const, recipeId: '90001', reason: 'Fixture permission withdrawal.' },
    ],
  };
  const snapshot = await verifySignedContentOverlay(await signed(manifest), {
    ...f.nextOptions,
    readerVersion: 1,
    retainedRefs: [f.publication.revision.ref],
    archive: {
      ...f.nextOptions.archive,
      async readPublication() {
        reads++;
        throw new Error('Withdrawn body must not be read');
      },
    },
  });
  const reader = createContentReader(snapshot);
  assert.equal(reader.lookupExact(f.publication.revision.ref).kind, 'withdrawn');
  assert.equal(reader.lookupCurrent('90001').kind, 'withdrawn');
  assert.equal(reads, 0);
});

test('changing a translation cannot rebind an already retained source revision identity', async () => {
  const f = await retainedOverlay(),
    item = clone(f.publication.translations[0]!);
  item.content.title += ' new';
  const changed = ownPublication(
    await createTranslatedPublishedRecipeRevision(
      f.publication.revision,
      f.publication.permissions,
      [item],
      sha256,
    ),
  );
  await assert.rejects(
    verifySignedContentOverlay(await signed({ ...f.next, entries: [member(changed)] }), {
      ...f.nextOptions,
      publications: [changed],
    }),
    /overlay_revision_rebound/,
  );
});
