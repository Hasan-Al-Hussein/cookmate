import assert from 'node:assert/strict';
import test from 'node:test';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminMutation } from '../src/contracts';
import { ApiError } from './api';
import { validateOperationResolution } from './operationResolution';

const mutation: AdminMutation = {
  operationId: 'expected-operation',
  draft: {
    draftId: 'actual-draft',
    recipeId: '1000000',
    revision: 2,
    status: 'draft',
    input: {
      title: 'Saved recipe',
      description: null,
      category: '',
      cuisine: '',
      rawTags: null,
      recipePage: null,
      originalSourceUrl: null,
      videoUrl: null,
      photoAssetId: null,
      ingredients: [],
      instructions: [],
      credits: [],
      changeSummary: '',
    },
    basedOn: null,
    updatedAt: '2026-09-30T12:00:00Z',
    updatedBy: { userId: 'operator', username: 'Operator', role: 'administrator' },
    metadata: unknownReviewedMetadata(),
    approval: null,
    validationIssues: [],
    photoUrl: null,
  },
};

test('resolution preserves the actual committed mutation or exact cancellation proof', () => {
  const committed = { operationId: mutation.operationId, status: 'committed', mutation } as const;
  assert.equal(validateOperationResolution(mutation.operationId, committed), committed);
  const cancelled = { operationId: mutation.operationId, status: 'cancelled' } as const;
  assert.equal(validateOperationResolution(mutation.operationId, cancelled), cancelled);
});

test('mismatched, missing or unknown terminal proof remains uncertain', () => {
  for (const result of [
    { operationId: 'other-operation', status: 'cancelled' },
    { operationId: mutation.operationId, status: 'missing' },
    { operationId: mutation.operationId, status: 'committed' },
    {
      operationId: mutation.operationId,
      status: 'committed',
      mutation: { ...mutation, operationId: 'other-operation' },
    },
    null,
  ]) {
    // JSON boundary deliberately exercises malformed server responses, not an asserted typed fixture.
    assert.throws(
      () => validateOperationResolution(mutation.operationId, JSON.parse(JSON.stringify(result))),
      (error: unknown) => error instanceof ApiError && error.uncertain,
    );
  }
});
