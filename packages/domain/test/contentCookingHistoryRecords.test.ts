import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  createRecipeContentRevision,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { COOKING_NOTE_MAX_CHARACTERS, cookingContentIdentity } from '../src/cooking';
import type { ContentCookingSession } from '../../../apps/mobile/src/data/contentCookingRecords';
import {
  CONTENT_COOKING_HISTORY_RECORD_MAX_BYTES,
  matchesContentCookingHistoryRevision,
  validateContentCookedReceipt,
  validateContentCookingHistoryEntry,
  validateSaveContentCookedInput,
  type ContentCookingHistoryEntry,
  type SaveContentCookedInput,
} from '../../../apps/mobile/src/data/contentCookingHistoryRecords';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';

const at = '2026-10-01T12:00:00.000Z';
const ref: RecipeContentRef = {
  recipeId: '90001',
  revisionId: 'fixture-history-1',
  contentFingerprint: 'a'.repeat(64),
};
const entry = (contentRef = ref): ContentCookingHistoryEntry => ({
  readerVersion: 2,
  recipeId: contentRef.recipeId,
  contentRef: { ...contentRef },
  eventId: randomUUID(),
  recipeTitle: 'Exact title',
  photoAssetId: null,
  cookedOn: '2026-10-01',
  timeZone: 'Asia/Dubai',
  recordedAt: at,
  note: '  Original note\n量 🍲  ',
  historyEpoch: 0,
  revision: 1,
});
const input = (contentRef = ref): SaveContentCookedInput => ({
  eventId: randomUUID(),
  contentRef: { ...contentRef },
  expectedHistoryEpoch: 0,
  cookedOn: '2026-10-01',
  timeZone: 'Asia/Dubai',
});
const completed = (event: ContentCookingHistoryEntry): ContentCookingSession => ({
  readerVersion: 2,
  recipeId: event.recipeId,
  contentRef: { ...event.contentRef },
  sessionId: randomUUID(),
  revision: 7,
  passageSequence: 2,
  state: 'completed',
  updatedAt: event.recordedAt,
  lastOperationId: event.eventId,
});

test('private history, explicit save input and saved receipts validate without normalizing or mutating data', () => {
  const value = entry(),
    request = {
      ...input(),
      note: value.note,
      session: { sessionId: randomUUID(), expectedRevision: 1 },
    };
  const receipt = { kind: 'saved', event: value, closedSession: completed(value) };
  const before = canonicalContentJson({ value, request, receipt });
  assert.equal(validateContentCookingHistoryEntry(value), true);
  assert.equal(validateSaveContentCookedInput(request), true);
  assert.equal(validateContentCookedReceipt(receipt), true);
  assert.equal(validateContentCookedReceipt({ ...receipt, closedSession: null }), true);
  assert.equal(canonicalContentJson({ value, request, receipt }), before);
  assert.equal(value.note, '  Original note\n量 🍲  ');
});

test('actual packaged and authored revisions match exact title/media identity and preserve source evidence', async () => {
  const document = authoredFixture();
  document.recipe.title = 'Exact authored title 🍲\nwith original spacing  ';
  const revisions = [
    await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256),
    await createRecipeContentRevision(document, 'fixture-history-authored', sha256),
  ];
  for (const revision of revisions) {
    const before = canonicalContentJson(revision);
    const value = {
      ...entry(revision.ref),
      recipeTitle: revision.document.recipe.title,
      photoAssetId: revision.document.media[0]!.assetId,
    };
    assert.equal(matchesContentCookingHistoryRevision(value, revision), true);
    assert.equal(
      matchesContentCookingHistoryRevision({ ...value, photoAssetId: null }, revision),
      true,
    );
    assert.equal(matchesContentCookingHistoryRevision(input(revision.ref), revision), true);
    assert.equal(
      matchesContentCookingHistoryRevision(
        { ...value, recipeTitle: `${value.recipeTitle} changed` },
        revision,
      ),
      false,
    );
    assert.equal(
      matchesContentCookingHistoryRevision(
        { ...value, photoAssetId: `sha256:${'f'.repeat(64)}` },
        revision,
      ),
      false,
    );
    assert.equal(canonicalContentJson(revision), before);
    assert.equal(Object.hasOwn(value, 'photoKey'), false);
  }
});

test('exact revision matching rejects stale or different references even when the same recipe title remains', async () => {
  const revision = await createRecipeContentRevision(
    authoredFixture(),
    'fixture-history-authored',
    sha256,
  );
  for (const changed of [
    { ...revision.ref, recipeId: '90002' },
    { ...revision.ref, revisionId: 'another-version' },
    { ...revision.ref, contentFingerprint: '0'.repeat(64) },
  ]) {
    const value = { ...entry(changed), recipeTitle: revision.document.recipe.title };
    assert.equal(validateContentCookingHistoryEntry(value), true);
    assert.equal(matchesContentCookingHistoryRevision(value, revision), false);
    assert.equal(matchesContentCookingHistoryRevision(input(changed), revision), false);
  }
  assert.equal(
    matchesContentCookingHistoryRevision({ ...entry(revision.ref), recipeId: '90002' }, revision),
    false,
  );
});

test('history and save input validate civil dates and real zones separately from the UTC recorded instant', () => {
  for (const cookedOn of ['2028-02-29', '0001-01-01', '9999-12-31']) {
    assert.equal(validateContentCookingHistoryEntry({ ...entry(), cookedOn }), true);
    assert.equal(validateSaveContentCookedInput({ ...input(), cookedOn }), true);
  }
  for (const cookedOn of [
    '2027-02-29',
    '2026-04-31',
    '0000-01-01',
    '2026-1-01',
    '2026-10-01T00:00:00Z',
  ]) {
    assert.equal(validateContentCookingHistoryEntry({ ...entry(), cookedOn }), false);
    assert.equal(validateSaveContentCookedInput({ ...input(), cookedOn }), false);
  }
  for (const timeZone of ['', 'Mars/Olympus', 'x'.repeat(101), ' Asia/Dubai ']) {
    assert.equal(validateContentCookingHistoryEntry({ ...entry(), timeZone }), false);
    assert.equal(validateSaveContentCookedInput({ ...input(), timeZone }), false);
  }
  assert.equal(validateContentCookingHistoryEntry({ ...entry(), timeZone: 'UTC' }), true);
  for (const recordedAt of [
    '2026-10-01T16:00:00.000+04:00',
    '2026-02-30T12:00:00.000Z',
    '2026-10-01',
  ])
    assert.equal(validateContentCookingHistoryEntry({ ...entry(), recordedAt }), false);
});

test('note limits count Unicode code points and optional request fields remain deliberately absent', () => {
  for (const note of [
    null,
    '',
    '🍲'.repeat(COOKING_NOTE_MAX_CHARACTERS),
    '\u0000'.repeat(COOKING_NOTE_MAX_CHARACTERS),
  ]) {
    assert.equal(validateContentCookingHistoryEntry({ ...entry(), note }), true);
    assert.equal(validateSaveContentCookedInput({ ...input(), note }), true);
  }
  assert.equal(validateSaveContentCookedInput(input()), true);
  for (const note of [
    '🍲'.repeat(COOKING_NOTE_MAX_CHARACTERS + 1),
    'a'.repeat(COOKING_NOTE_MAX_CHARACTERS + 1),
    undefined,
    0,
  ]) {
    assert.equal(validateContentCookingHistoryEntry({ ...entry(), note }), false);
    assert.equal(validateSaveContentCookedInput({ ...input(), note }), false);
  }
  const { note: _note, ...withoutNote } = entry();
  assert.equal(validateContentCookingHistoryEntry(withoutNote), false);
  for (const session of [
    null,
    undefined,
    { sessionId: randomUUID(), expectedRevision: 0 },
    { sessionId: 'invalid', expectedRevision: 1 },
    { sessionId: randomUUID(), expectedRevision: 1, contentRef: ref },
  ])
    assert.equal(validateSaveContentCookedInput({ ...input(), session }), false);
});

test('entry and request strict fields reject malformed IDs, epochs, revisions, metadata and legacy additions', () => {
  for (const change of [
    { readerVersion: 1 },
    { recipeId: '90002' },
    { eventId: 'bad' },
    { recipeTitle: '' },
    { recipeTitle: 'x'.repeat(1001) },
    { photoAssetId: 'photos/90001.jpg' },
    { photoAssetId: `sha256:${'A'.repeat(64)}` },
    { historyEpoch: -1 },
    { historyEpoch: 0.5 },
    { revision: 0 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { contentRef: { ...ref, extra: 'invalid' } },
    { origin: 'backup' },
    { photoKey: 'photos/90001.jpg' },
  ])
    assert.equal(validateContentCookingHistoryEntry({ ...entry(), ...change }), false);
  for (const change of [
    { eventId: 'bad' },
    { expectedHistoryEpoch: -1 },
    { expectedHistoryEpoch: NaN },
    { readerVersion: 2 },
    { recipeId: ref.recipeId },
    { photoAssetId: null },
    { contentRef: { ...ref, revisionId: '' } },
    { operationId: randomUUID() },
  ])
    assert.equal(validateSaveContentCookedInput({ ...input(), ...change }), false);
  assert.equal(
    validateContentCookingHistoryEntry({
      ...entry(),
      historyEpoch: Number.MAX_SAFE_INTEGER,
      revision: Number.MAX_SAFE_INTEGER,
    }),
    true,
  );
});

test('a closed-session receipt binds the same exact content, event and atomic save instant', () => {
  const event = entry(),
    closedSession = completed(event);
  for (const change of [
    { state: 'active' },
    { state: 'dismissed' },
    { lastOperationId: randomUUID() },
    { updatedAt: '2026-10-01T12:00:01.000Z' },
    { recipeId: '90002', contentRef: { ...ref, recipeId: '90002' } },
    { contentRef: { ...ref, revisionId: 'other-version' } },
    { readerVersion: 1 },
    { passageSequence: 0 },
  ])
    assert.equal(
      validateContentCookedReceipt({
        kind: 'saved',
        event,
        closedSession: { ...closedSession, ...change },
      }),
      false,
    );
  assert.equal(validateContentCookedReceipt({ kind: 'saved', event }), false);
  assert.equal(
    validateContentCookedReceipt({ kind: 'saved', event, closedSession, readerVersion: 2 }),
    false,
  );
  assert.equal(
    validateContentCookedReceipt({ kind: 'saved', event, closedSession, eventId: event.eventId }),
    false,
  );
});

test('cleared/cancelled receipts retain their exact durable tombstone shape without masquerading as saved history', () => {
  for (const kind of ['cleared', 'cancelled']) {
    const receipt = { kind, eventId: randomUUID(), historyEpoch: 0 };
    assert.equal(validateContentCookedReceipt(receipt), true);
    assert.equal(validateContentCookingHistoryEntry(receipt), false);
    assert.equal(validateContentCookedReceipt({ ...receipt, event: entry() }), false);
    assert.equal(validateContentCookedReceipt({ ...receipt, historyEpoch: -1 }), false);
    assert.equal(validateContentCookedReceipt({ ...receipt, eventId: 'invalid' }), false);
  }
});

test('real legacy history and receipts are not reinterpreted or mutated as version two', async () => {
  const recipe = catalogue.recipes[0]!;
  const identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  const legacy = {
    ...identity,
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: null,
    historyEpoch: 0,
    revision: 1,
  };
  const before = canonicalContentJson(legacy);
  assert.equal(validateContentCookingHistoryEntry(legacy), false);
  assert.equal(
    validateContentCookedReceipt({ kind: 'saved', event: legacy, closedSession: null }),
    false,
  );
  assert.equal(
    validateContentCookingHistoryEntry({
      ...legacy,
      readerVersion: 2,
      contentRef: ref,
      photoAssetId: null,
    }),
    false,
  );
  assert.equal(canonicalContentJson(legacy), before);
});

test('bounded data-only admission rejects accessor, cyclic, hidden, deep and oversized values before property execution', () => {
  assert.equal(CONTENT_COOKING_HISTORY_RECORD_MAX_BYTES, 32768);
  let accesses = 0;
  const accessor = Object.defineProperty(entry(), 'note', {
    enumerable: true,
    get() {
      accesses++;
      throw new Error('Caller getter must not execute');
    },
  });
  const cyclic: Record<string, unknown> = { ...entry() };
  cyclic.extra = cyclic;
  let deep: unknown = null;
  for (let depth = 0; depth < 100; depth++) deep = { child: deep };
  const values = [
    accessor,
    cyclic,
    { ...entry(), extra: deep },
    { ...entry(), extra: 'x'.repeat(32769) },
    { ...entry(), recipeTitle: '🍲'.repeat(32768) },
    Object.defineProperty(entry(), 'hidden', { value: true }),
    { ...entry(), [Symbol('hidden')]: true },
    null,
    [],
    new Date(at),
    '{"readerVersion":2}',
  ];
  for (const value of values)
    for (const validate of [
      validateContentCookingHistoryEntry,
      validateSaveContentCookedInput,
      validateContentCookedReceipt,
    ])
      assert.equal(validate(value), false);
  assert.equal(
    validateContentCookedReceipt({ kind: 'saved', event: accessor, closedSession: null }),
    false,
  );
  assert.equal(accesses, 0);
});
