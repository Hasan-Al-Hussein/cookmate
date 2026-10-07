import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { createHash } from 'node:crypto';
import {
  createTranslationJournal,
  prepareTranslationWrite,
  validateTranslationMutation,
  type TranslationWrite,
} from './translationJournal';
import {
  emptyTranslationForm,
  admitTranslationForm,
  admitTranslationLanguages,
} from './translationForm';
import type { AdminDraftInput } from '../src/contracts';
import type {
  AdminTranslationInput,
  AdminTranslationMutation,
} from '../src/translations/contracts';

const source: AdminDraftInput = {
  title: 'Original',
  description: 'Original\ntext',
  category: '',
  cuisine: '',
  rawTags: null,
  recipePage: null,
  originalSourceUrl: null,
  videoUrl: null,
  photoAssetId: null,
  ingredients: [{ rawName: 'Rice', rawMeasure: '1 1/2 cups' }],
  instructions: [{ rawText: 'Whole\npassage', presentation: 'passage' }],
  credits: [],
  changeSummary: '',
};
const input = admitTranslationForm({
  ...emptyTranslationForm(source),
  attribution: 'machine',
  title: 'Fixture translation',
});
const operationId = 'e0000000-0000-4000-8000-000000000001';
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalContentJson(value)).digest('hex');
test('translation fingerprints match each existing backend request shape and own input before hashing', async () => {
  const create: TranslationWrite = {
    kind: 'create',
    draftId: 'draft',
    sourceRevision: 4,
    originalLanguage: 'en',
    targetLanguage: 'ar',
    input: structuredClone(input),
  };
  const promise = prepareTranslationWrite(create, 'actor', operationId);
  create.input.title = 'Later mutable edit';
  const prepared = await promise;
  assert.equal(Object.isFrozen(prepared.write), true);
  assert.equal(
    prepared.write.kind === 'create' && Object.isFrozen(prepared.write.input.instructions),
    true,
  );
  assert.equal(
    prepared.pending.requestFingerprint,
    hash({
      draftId: 'draft',
      request: {
        operationId,
        sourceRevision: 4,
        originalLanguage: 'en',
        targetLanguage: 'ar',
        input,
      },
    }),
  );
  for (const action of [
    { kind: 'save', input },
    { kind: 'rebase', sourceRevision: 4, input },
    {
      kind: 'review',
      decision: 'approved',
      note: 'Operator compared originals.',
      acknowledgeHumanReview: true,
    },
  ] as const) {
    const result = await prepareTranslationWrite(
      { draftId: 'draft', id: 'translation', sourceRevision: 4, expectedRevision: 8, ...action },
      'actor',
      operationId,
    );
    assert.equal(
      result.pending.requestFingerprint,
      hash({ id: 'translation', operationId, expectedRevision: 8, action }),
    );
  }
  let invoked = false;
  await assert.rejects(
    prepareTranslationWrite(
      {
        ...create,
        get input(): AdminTranslationInput {
          invoked = true;
          throw new Error();
        },
      },
      'actor',
      operationId,
    ),
  );
  assert.equal(invoked, false);
});
test('bounded body-free journal retains exact ownership, refuses replacement and never erases foreign or malformed storage', async () => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  const journal = createTranslationJournal(storage);
  const { pending } = await prepareTranslationWrite(
    {
      kind: 'save',
      draftId: 'draft',
      id: 'translation',
      sourceRevision: 4,
      expectedRevision: 8,
      input,
    },
    'actor',
    operationId,
  );
  journal.remember(pending);
  assert.deepEqual(journal.read(), pending);
  assert.equal([...entries.values()][0]!.includes('Fixture translation'), false);
  assert.throws(() => journal.remember({ ...pending, operationId: 'different' }));
  assert.throws(() => journal.forget({ ...pending, requestFingerprint: 'a'.repeat(64) }));
  journal.forget(pending);
  assert.equal(journal.read(), null);
  entries.set('cookmate.admin.translation.pending.v1', '{bad');
  assert.throws(() => journal.read());
  assert.equal(entries.get('cookmate.admin.translation.pending.v1'), '{bad');
});
test('translation receipt identity must match exact operation, fingerprint, source and resulting revision', async () => {
  const { pending } = await prepareTranslationWrite(
    {
      kind: 'save',
      draftId: 'draft',
      id: 'translation',
      sourceRevision: 4,
      expectedRevision: 8,
      input,
    },
    'actor',
    operationId,
  );
  const result: AdminTranslationMutation = {
    operationId,
    requestFingerprint: pending.requestFingerprint,
    translation: {
      translationId: 'translation',
      revision: 9,
      source: {
        draftId: 'draft',
        revision: 4,
        recipeId: '1000000',
        inputFingerprint: '1'.repeat(64),
      },
      originalLanguage: 'en',
      targetLanguage: 'ar',
      input,
      translatedFingerprint: '2'.repeat(64),
      machineAssisted: true,
      status: 'draft',
      effectiveStatus: 'draft',
      sourceStatus: { kind: 'current' },
      review: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
      updatedBy: { userId: 'actor', username: 'Fixture', role: 'editor' },
    },
  };
  assert.deepEqual(validateTranslationMutation(pending, result), result);
  for (const wrong of [
    { ...result, operationId: 'different' },
    { ...result, requestFingerprint: '3'.repeat(64) },
    { ...result, translation: { ...result.translation, revision: 10 } },
    {
      ...result,
      translation: { ...result.translation, source: { ...result.translation.source, revision: 5 } },
    },
  ])
    assert.throws(() => validateTranslationMutation(pending, wrong));
});
test('translation form has no copied source language, translated quantities or inferred row mapping', () => {
  const form = emptyTranslationForm(source);
  assert.equal(form.title, '');
  assert.deepEqual(form.ingredients, [{ rawName: '' }]);
  assert.deepEqual(form.instructions, [{ rawText: '' }]);
  assert.throws(() => admitTranslationForm(form));
  assert.throws(() => admitTranslationLanguages('en', 'en'));
  assert.throws(() => admitTranslationLanguages('en', 'AR'));
  admitTranslationLanguages('en', 'ar');
  assert.equal(source.ingredients[0]!.rawMeasure, '1 1/2 cups');
});
