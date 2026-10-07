import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  createRecipeContentRevision,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { catalogue } from '@cookmate/catalogue';
import { cookingContentIdentity } from '../src/cooking';
import {
  CONTENT_COOKING_RECORD_MAX_BYTES,
  matchesContentCookingRevision,
  validateContentCookingSession,
  validateDismissContentCookingSessionInput,
  validateSaveContentCookingSessionInput,
  type ContentCookingSession,
  type DismissContentCookingSessionInput,
  type SaveContentCookingSessionInput,
} from '../../../apps/mobile/src/data/contentCookingRecords';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';

const at = '2026-10-01T12:00:00.000Z';
const ref: RecipeContentRef = {
  recipeId: '90001',
  revisionId: 'fixture-exact-1',
  contentFingerprint: 'a'.repeat(64),
};
const session = (contentRef = ref): ContentCookingSession => ({
  readerVersion: 2,
  recipeId: contentRef.recipeId,
  contentRef: { ...contentRef },
  sessionId: randomUUID(),
  revision: 1,
  passageSequence: 1,
  state: 'active',
  updatedAt: at,
  lastOperationId: randomUUID(),
});
const save = (contentRef = ref): SaveContentCookingSessionInput => ({
  operationId: randomUUID(),
  sessionId: randomUUID(),
  contentRef: { ...contentRef },
  expectedRevision: null,
  passageSequence: 1,
});
const dismiss = (): DismissContentCookingSessionInput => ({
  operationId: randomUUID(),
  recipeId: ref.recipeId,
  sessionId: randomUUID(),
  expectedRevision: 1,
});

test('strict version-two sessions and inputs accept deliberate lifecycle states without mutating their values', () => {
  for (const state of ['active', 'dismissed', 'completed'] as const) {
    const value = { ...session(), state };
    const before = canonicalContentJson(value);
    assert.equal(validateContentCookingSession(value), true);
    assert.equal(canonicalContentJson(value), before);
  }
  assert.equal(validateSaveContentCookingSessionInput(save()), true);
  assert.equal(validateSaveContentCookingSessionInput({ ...save(), expectedRevision: 17 }), true);
  assert.equal(validateDismissContentCookingSessionInput(dismiss()), true);
});

test('exact imported and authored revisions use original instruction sequences and preserve every source field', async () => {
  const revisions = [
    await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256),
    await createRecipeContentRevision(authoredFixture(), 'fixture-authored-1', sha256),
  ];
  for (const revision of revisions) {
    const before = canonicalContentJson(revision);
    for (const passage of revision.document.recipe.instructions) {
      assert.equal(
        matchesContentCookingRevision(
          { ...session(revision.ref), passageSequence: passage.sequence },
          revision,
        ),
        true,
      );
      assert.equal(
        matchesContentCookingRevision(
          { ...save(revision.ref), passageSequence: passage.sequence },
          revision,
        ),
        true,
      );
    }
    assert.equal(
      matchesContentCookingRevision({ ...session(revision.ref), passageSequence: 0 }, revision),
      false,
    );
    assert.equal(
      matchesContentCookingRevision(
        {
          ...save(revision.ref),
          passageSequence: revision.document.recipe.instructions.length + 1,
        },
        revision,
      ),
      false,
    );
    assert.equal(canonicalContentJson(revision), before);
    if (revision.document.kind === 'authored') {
      assert.equal(Object.hasOwn(revision.document.recipe.instructions[0]!, 'source'), false);
      assert.equal(revision.document.recipe.instructions[1]!.rawText, 'Stir gently.\nServe.');
      assert.equal(revision.document.recipe.ingredients[0]!.rawMeasure, null);
    }
  }
});

test('matching rejects another publisher revision or body even when the recipe ID and passage coincide', async () => {
  const revision = await createRecipeContentRevision(
    authoredFixture(),
    'fixture-authored-1',
    sha256,
  );
  for (const changed of [
    { ...revision.ref, revisionId: 'fixture-authored-2' },
    { ...revision.ref, contentFingerprint: '0'.repeat(64) },
    { ...revision.ref, recipeId: '90002' },
  ]) {
    assert.equal(validateContentCookingSession(session(changed)), true);
    assert.equal(matchesContentCookingRevision(session(changed), revision), false);
    assert.equal(matchesContentCookingRevision(save(changed), revision), false);
  }
  assert.equal(
    validateContentCookingSession({ ...session(revision.ref), recipeId: '90002' }),
    false,
  );
  assert.equal(matchesContentCookingRevision(dismiss(), revision), false);
});

test('session validation refuses malformed IDs, dates, numbers, states and reference fields', () => {
  const valid = session();
  for (const change of [
    { readerVersion: 1 },
    { readerVersion: '2' },
    { recipeId: '' },
    { sessionId: 'not-a-uuid' },
    { lastOperationId: '00000000-0000-4000-8000-00000000000A' },
    { revision: 0 },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { passageSequence: 1.5 },
    { passageSequence: 0 },
    { state: 'paused' },
    { updatedAt: '2026-02-30T12:00:00.000Z' },
    { updatedAt: '2026-10-01T16:00:00.000+04:00' },
    { contentRef: { ...ref, revisionId: '' } },
    { contentRef: { ...ref, recipeId: 'abc' } },
    { contentRef: { ...ref, contentFingerprint: 'A'.repeat(64) } },
    { contentRef: { ...ref, source: 'invented' } },
  ])
    assert.equal(
      validateContentCookingSession({ ...valid, ...change }),
      false,
      JSON.stringify(change),
    );
  assert.equal(
    validateContentCookingSession({ ...valid, revision: Number.MAX_SAFE_INTEGER }),
    true,
  );
});

test('save and dismiss requests require exact keys and positive revision guards', () => {
  const saving = save(),
    closing = dismiss();
  for (const change of [
    { operationId: 'bad' },
    { sessionId: 'bad' },
    { expectedRevision: 0 },
    { expectedRevision: -1 },
    { expectedRevision: 1.1 },
    { expectedRevision: undefined },
  ]) {
    assert.equal(validateSaveContentCookingSessionInput({ ...saving, ...change }), false);
    assert.equal(validateDismissContentCookingSessionInput({ ...closing, ...change }), false);
  }
  assert.equal(
    validateDismissContentCookingSessionInput({ ...closing, expectedRevision: null }),
    false,
  );
  assert.equal(
    validateDismissContentCookingSessionInput({ ...closing, recipeId: '9'.repeat(21) }),
    false,
  );
  assert.equal(
    validateSaveContentCookingSessionInput({ ...saving, recipeId: ref.recipeId }),
    false,
  );
  assert.equal(validateSaveContentCookingSessionInput({ ...saving, readerVersion: 2 }), false);
  assert.equal(validateSaveContentCookingSessionInput({ ...saving, passageSequence: NaN }), false);
  assert.equal(validateDismissContentCookingSessionInput({ ...closing, contentRef: ref }), false);
});

test('version-one session and save payloads are rejected rather than reinterpreted as exact references', async () => {
  const recipe = catalogue.recipes[0]!;
  const legacy = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  const legacySession = {
    ...legacy,
    sessionId: randomUUID(),
    revision: 1,
    passageSequence: 1,
    state: 'active',
    updatedAt: at,
    lastOperationId: randomUUID(),
  };
  assert.equal(validateContentCookingSession(legacySession), false);
  assert.equal(
    validateContentCookingSession({ ...legacySession, readerVersion: 2, contentRef: ref }),
    false,
  );
  assert.equal(
    validateSaveContentCookingSessionInput({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      recipeId: recipe.recipeId,
      expectedRevision: null,
      contentFingerprint: legacy.contentFingerprint,
      readerVersion: 1,
      passageSequence: 1,
    }),
    false,
  );
});

test('bounded data-only admission rejects oversized, cyclic and accessor-bearing input before clone or property execution', () => {
  assert.equal(CONTENT_COOKING_RECORD_MAX_BYTES, 8192);
  const validators = [
    validateContentCookingSession,
    validateSaveContentCookingSessionInput,
    validateDismissContentCookingSessionInput,
  ];
  let accesses = 0;
  const accessor = Object.defineProperty(session(), 'contentRef', {
    enumerable: true,
    get() {
      accesses++;
      throw new Error('Must never execute caller getter');
    },
  });
  const cyclic: Record<string, unknown> = { ...session() };
  cyclic.extra = cyclic;
  const nonEnumerable = Object.defineProperty(session(), 'hidden', {
    value: 'not JSON',
    enumerable: false,
  });
  for (const value of [
    accessor,
    cyclic,
    nonEnumerable,
    { ...session(), [Symbol('hidden')]: true },
    { ...session(), contentRef: { ...ref, revisionId: 'x'.repeat(8193) } },
    { ...session(), extra: '🍲'.repeat(8192) },
    { ...session(), extra: Array.from({ length: 8192 }, () => null) },
    null,
    [],
    new Date(at),
    '{"readerVersion":2}',
  ])
    for (const validate of validators) assert.equal(validate(value), false);
  assert.equal(accesses, 0);
});
