import { createHash } from 'node:crypto';
import { unknownReviewedMetadata } from '../src/content/validation';
import type { RecipeContentDocument, ReviewEvidence } from '../src/content/types';

export const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
export const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
export const evidence: ReviewEvidence = {
  reviewerId: 'fixture-reviewer',
  reviewedAt: '2026-09-30T12:00:00.000Z',
  source: 'Synthetic fixture evidence only; no real upload or rights inspection.',
};
export function authoredFixture(id = '90001'): RecipeContentDocument {
  const digest = '1'.repeat(64);
  return {
    formatVersion: 1,
    kind: 'authored',
    recipe: {
      recipeId: id,
      title: 'Fixture soup',
      description: 'Synthetic content for tests.',
      category: 'Soup',
      cuisine: 'Fixture',
      rawTags: null,
      photoKey: `photos/${id}.jpg`,
      recipePage: null,
      originalSourceUrl: null,
      videoUrl: 'https://www.youtube.com/watch?v=C5n1fN8TGHs',
      ingredients: [{ position: 1, rawName: 'Salt', rawMeasure: null }],
      instructions: [
        { sequence: 1, rawText: 'Preparation', presentation: 'heading' },
        { sequence: 2, rawText: 'Stir gently.\nServe.', presentation: 'passage' },
      ],
    },
    provenance: {
      kind: 'authored', authorId: 'fixture-author', createdAt: '2026-09-30T11:00:00.000Z',
      changeSummary: 'Create test recipe.', basedOn: null, credits: [],
    },
    metadata: unknownReviewedMetadata(),
    media: [{
      assetId: `sha256:${digest}`, recipeId: id, photoKey: `photos/${id}.jpg`, sha256: digest,
      bytes: 1234, mimeType: 'image/jpeg', dimensions: { width: 800, height: 600, review: clone(evidence) },
      rights: { status: 'permitted', statement: 'Synthetic fixture permission.', review: clone(evidence) },
      attribution: { text: 'Fixture creator', url: 'https://example.test/credit' },
    }],
  };
}
