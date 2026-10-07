import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminDraft } from '../src/contracts';
import { RecipePreview } from './RecipePreview';
import { RecipePreviewPanel } from './RecipePreviewPanel';

function fixture() {
  const draft: AdminDraft = {
    draftId: 'historical-fixture',
    recipeId: '1000000',
    revision: 7,
    status: 'draft',
    input: {
      title: 'Historical fixture',
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
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: { userId: 'fixture-reviewer', username: 'Fixture reviewer', role: 'reviewer' },
    metadata: {
      ...unknownReviewedMetadata(),
      servings: {
        value: 2.5,
        review: {
          reviewerId: 'fixture-reviewer',
          reviewedAt: '2026-10-01T00:00:00.000Z',
          source: 'Historical fixture source evidence',
        },
      },
      nutrition: {
        value: {
          basis: 'per_recipe',
          energyKcal: 0,
          proteinGrams: null,
          carbohydrateGrams: null,
          fatGrams: null,
        },
        review: {
          reviewerId: 'fixture-reviewer',
          reviewedAt: '2026-10-01T00:00:00.000Z',
          source: 'Fixture nutrition evidence',
        },
      },
    },
    approval: null,
    validationIssues: [],
    photoUrl: null,
  };
  return draft;
}
test('historical preview exposes saved optional values and operator evidence without editable controls', () => {
  const draft = fixture();
  const html = renderToStaticMarkup(createElement(RecipePreview, { draft, showMetadata: true }));
  assert.match(html, /Optional reviewed details · revision 7/);
  assert.match(html, /2\.5/);
  assert.match(html, /Historical fixture source evidence/);
  assert.match(html, /Recorded by fixture-reviewer/);
  assert.match(html, /Preparation time · Unknown/);
  assert.match(html, /Energy · kcal: 0/);
  assert.match(html, /Protein · grams: Unknown/);
  assert.doesNotMatch(html, /<(?:input|textarea|select|button)\b/);
  // The ordinary unsaved-input preview must not present saved metadata as evidence for new text.
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(RecipePreview, { draft })),
    /Saved optional metadata/,
  );
});

test('unsaved working copies cannot inherit saved approval, rights or metadata evidence', () => {
  const draft = fixture();
  draft.status = 'reviewed';
  draft.review = {
    decision: 'approved',
    note: 'Saved approval evidence',
    reviewerId: 'original-reviewer',
    reviewedAt: '2026-10-01T00:00:00Z',
    inputRevision: 7,
  };
  draft.rights = [
    {
      scope: 'recipe_text',
      status: 'permitted',
      statement: 'Saved text permission evidence',
      sourceUrl: null,
      reviewerId: 'rights-reviewer',
      reviewedAt: '2026-10-01T00:00:00Z',
      inputRevision: 7,
      contentBinding: 'a'.repeat(64),
    },
  ];
  draft.input.title = 'Changed working copy';
  const html = renderToStaticMarkup(
    createElement(RecipePreview, { draft, unsaved: true, showMetadata: true }),
  );
  assert.match(html, /Unsaved working copy/);
  assert.match(html, /Changed working copy/);
  assert.doesNotMatch(
    html,
    /Reviewed draft|Saved approval evidence|Saved text permission evidence|Historical fixture source evidence/,
  );
  const saved = renderToStaticMarkup(createElement(RecipePreview, { draft, showMetadata: true }));
  assert.match(saved, /Reviewed draft/);
  assert.match(saved, /Saved approval evidence/);
  assert.match(saved, /Saved text permission evidence/);
});

test('preview preserves exact quantities, source newlines and long titles without executing external content', () => {
  const draft = fixture();
  draft.input.title = 'A complete long recipe title with every original word retained '.repeat(4);
  draft.input.description = 'First description line\nSecond description line';
  draft.input.ingredients = [
    { rawName: 'salt', rawMeasure: '  1 / 2  tsp\nlevel  ' },
    { rawName: 'water', rawMeasure: null },
  ];
  draft.input.instructions = [
    { rawText: 'First heading\nSecond heading', presentation: 'heading' },
    { rawText: 'Exact first passage.\nDo not rewrite this.', presentation: 'passage' },
  ];
  draft.input.videoUrl = 'https://www.youtube.com/watch?v=fixture';
  const html = renderToStaticMarkup(createElement(RecipePreview, { draft }));
  assert.ok(html.includes(draft.input.title));
  assert.ok(html.includes('class="original-text">First description line\nSecond description line'));
  assert.ok(html.includes('class="original-text">First heading\nSecond heading'));
  assert.ok(html.includes('  1 / 2  tsp\nlevel  '));
  assert.match(html, /Amount not supplied/);
  assert.doesNotMatch(html, /<iframe|<video|<script/);
});

test('phone size selection changes only unscaled preview dimensions and keeps raw draft content', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  let view!: ReactTestRenderer;
  t.after(async () => {
    await act(async () => {
      view?.unmount();
    });
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const draft = fixture(),
    before = JSON.stringify(draft);
  await act(async () => {
    view = create(createElement(RecipePreviewPanel, { draft, unsaved: true }));
  });
  const viewport = () => view.root.findByProps({ className: 'preview-viewport' });
  assert.deepEqual(viewport().props.style, { width: 428, height: 926 });
  const buttons = () => view.root.findAllByType('button');
  assert.deepEqual(
    buttons().map((item) => item.props['aria-pressed']),
    [true, false, false],
  );
  await act(async () => {
    buttons()[1]!.props.onClick();
  });
  assert.deepEqual(viewport().props.style, { width: 390, height: 844 });
  assert.equal(view.root.findByType(RecipePreview).props.unsaved, true);
  await act(async () => {
    buttons()[2]!.props.onClick();
  });
  assert.deepEqual(viewport().props.style, { width: '100%', height: 'auto' });
  assert.equal(view.root.findByType(RecipePreview).props.draft, draft);
  assert.equal(viewport().props.tabIndex, 0);
  assert.equal(JSON.stringify(draft), before);
});
