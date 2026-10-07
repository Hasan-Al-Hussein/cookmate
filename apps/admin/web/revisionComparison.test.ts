import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminUser } from '../src/contracts';
import { AdminApi } from './api';
import { Field } from './components';
import { Editor } from './Editor';
import { RecipePreview } from './RecipePreview';
import { RevisionComparison } from './RevisionComparison';
import { compareSavedRevisions } from './revisionComparisonData';
import type { useOperations } from './useOperations';

const user: AdminUser = {
  userId: 'fixture-reviewer',
  username: 'Fixture reviewer',
  role: 'reviewer',
};
function saved(revision = 3): AdminDraft {
  return {
    draftId: 'fixture-draft',
    recipeId: '1000000',
    revision,
    status: 'draft',
    input: {
      title: 'Saved fixture title',
      description: null,
      category: 'Pasta',
      cuisine: 'Italian',
      rawTags: '',
      recipePage: null,
      originalSourceUrl: 'https://example.test/source',
      videoUrl: null,
      photoAssetId: null,
      ingredients: [
        { rawName: 'Flour', rawMeasure: '1/2 cup\npacked' },
        { rawName: 'Salt', rawMeasure: null },
      ],
      instructions: [
        { rawText: 'Original heading', presentation: 'heading' },
        { rawText: 'Exact original text.\nKeep this paragraph.', presentation: 'passage' },
      ],
      credits: [{ label: 'Fixture source', url: null }],
      changeSummary: 'Synthetic fixture revision',
    },
    basedOn: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: user,
    metadata: unknownReviewedMetadata(),
    rights: [],
    review: null,
    approval: null,
    validationIssues: [],
    photoUrl: null,
  };
}
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');

test('identical saved values remain unchanged and unrelated draft identities cannot be compared', () => {
  const before = saved(1);
  const after = saved(3);
  const snapshot = JSON.stringify([before, after]);
  assert.ok(compareSavedRevisions(before, after)!.every((group) => !group.changed));
  assert.equal(compareSavedRevisions(before, { ...after, draftId: 'other' }), null);
  assert.equal(compareSavedRevisions(before, { ...after, recipeId: 'other' }), null);
  assert.equal(JSON.stringify([before, after]), snapshot);
});

test('comparison covers every editable field including exact amounts, paragraph types, order and null versus empty', () => {
  const before = saved(1);
  const after = saved(3);
  after.input = {
    ...after.input,
    title: 'Changed title',
    description: '',
    category: 'Changed category',
    cuisine: 'Changed cuisine',
    rawTags: 'Changed tags',
    recipePage: 'https://example.test/collection',
    originalSourceUrl: null,
    videoUrl: 'https://youtu.be/fixture',
    photoAssetId: 'fixture-photo',
    changeSummary: 'Changed summary',
    ingredients: [...after.input.ingredients].reverse(),
    instructions: [...after.input.instructions].reverse(),
    credits: [{ label: 'Changed credit', url: 'https://example.test/credit' }],
  };
  const groups = compareSavedRevisions(before, after)!;
  for (const key of Object.keys(after.input))
    assert.equal(groups.find((group) => group.key === key)?.changed, true, key);
  const ingredients = groups.find((group) => group.key === 'ingredients')!;
  assert.equal(
    ingredients.before.find((row) => row.label === '1 · Amount')!.value,
    '1/2 cup\npacked',
  );
  assert.equal(ingredients.after.find((row) => row.label === '1 · Amount')!.value, null);
  const instructions = groups.find((group) => group.key === 'instructions')!;
  assert.equal(instructions.after[1]!.value, 'passage');
  assert.equal(instructions.after[2]!.value, 'Exact original text.\nKeep this paragraph.');
  assert.equal(groups.find((group) => group.key === 'description')!.before[0]!.value, null);
  assert.equal(groups.find((group) => group.key === 'description')!.after[0]!.value, '');
});

test('metadata provenance, rights binding and review changes are compared even when title and recipe text match', () => {
  const before = saved(1);
  const after = saved(3);
  const evidence = {
    reviewerId: user.userId,
    reviewedAt: before.updatedAt,
    source: 'Synthetic fixture evidence',
  };
  before.metadata.prepMinutes = { value: 0, review: evidence };
  after.metadata.prepMinutes = {
    value: 0,
    review: { ...evidence, source: 'Changed exact evidence' },
  };
  after.metadata.nutrition = {
    value: {
      basis: 'per_recipe',
      energyKcal: 0,
      proteinGrams: null,
      carbohydrateGrams: null,
      fatGrams: null,
    },
    review: evidence,
  };
  before.rights = [
    {
      scope: 'recipe_text',
      status: 'permitted',
      statement: 'Fixture permission',
      sourceUrl: null,
      reviewerId: user.userId,
      reviewedAt: before.updatedAt,
      inputRevision: 1,
      contentBinding: 'a'.repeat(64),
    },
  ];
  after.rights = [{ ...before.rights[0]!, contentBinding: 'b'.repeat(64) }];
  after.review = {
    decision: 'changes_requested',
    note: 'Exact\nreview note',
    reviewerId: user.userId,
    reviewedAt: after.updatedAt,
    inputRevision: 2,
  };
  after.approval = {
    reviewerId: user.userId,
    reviewedAt: after.updatedAt,
    revision: 3,
    note: 'Historical fixture approval',
  };
  const groups = compareSavedRevisions(before, after)!;
  assert.deepEqual(
    groups.filter((group) => group.changed).map((group) => group.key),
    ['metadata.prepMinutes', 'metadata.nutrition', 'rights.recipe_text', 'review', 'approval'],
  );
  assert.equal(groups.find((group) => group.key === 'metadata.prepMinutes')!.after[0]!.value, '0');
  assert.equal(
    groups.find((group) => group.key === 'rights.recipe_text')!.after.at(-1)!.value,
    'b'.repeat(64),
  );
});

function delayed<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function editorFixture(t: TestContext) {
  const old = ['sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: () => null },
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const draft = saved();
  const reads: number[] = [];
  const focus: string[] = [];
  let writes = 0;
  const responses = new Map<number, Promise<AdminDraft>>();
  const api = new AdminApi(
    () => {},
    async (url) => {
      assert.equal(String(url), '/admin/api/session');
      return Response.json({ configured: true, user, csrfToken: 'fixture-token', expiresAt: null });
    },
  );
  await api.session();
  t.mock.method(api, 'history', async () => ({
    items: [1, 2, 3].map((revision) => ({
      revision,
      createdAt: draft.updatedAt,
      author: user,
      changeSummary: `Fixture revision ${revision}`,
      status: 'draft' as const,
    })),
  }));
  t.mock.method(api, 'revision', async (_id: string, revision: number) => {
    reads.push(revision);
    return responses.get(revision) ?? saved(revision);
  });
  const operations: ReturnType<typeof useOperations> = {
    pending: null,
    storageError: null,
    error: null,
    errorCode: null,
    busy: false,
    resolutionNotice: null,
    blocked: false,
    canRetry: false,
    run: async () => {
      writes++;
    },
    check: async () => {},
    resolve: async () => {},
    retry: async () => {},
    clearError() {},
  };
  const props = {
    api,
    draft,
    user,
    operations,
    onDirty() {},
    onLocalBusy() {},
    onLoad() {},
    onBack() {},
    onReauthenticate() {},
  };
  let view: ReactTestRenderer;
  let mounted = true;
  await act(async () => {
    view = create(createElement(Editor, props), {
      createNodeMock(element) {
        return element.type === 'h3'
          ? {
              focus() {
                focus.push('comparison heading');
              },
            }
          : null;
      },
    });
  });
  async function unmount() {
    if (mounted) {
      mounted = false;
      await act(async () => view.unmount());
    }
  }
  t.after(async () => {
    await unmount();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    api,
    reads,
    focus,
    responses,
    unmount,
    get view() {
      return view;
    },
    get writes() {
      return writes;
    },
    text: () => text(view.root),
    button(label: string) {
      return view.root.findAllByType('button').find((item) => text(item) === label)!;
    },
    revisionButton(revision: number) {
      return view.root
        .findAllByProps({ className: 'history-row' })
        .find((item) => text(item).includes(`Fixture revision ${revision}`))!;
    },
    async click(label: string) {
      await act(async () => this.button(label).props.onClick());
    },
    async update(nextUser = user) {
      await act(async () => view.update(createElement(Editor, { ...props, user: nextUser })));
    },
  };
}

test('history comparison remains saved-only, exposes unchanged sections and never calls a mutation', async (t) => {
  const f = await editorFixture(t);
  const field = f.view.root
    .findAllByType(Field)
    .find((item) => item.props.label === 'Recipe title')!;
  await act(async () =>
    field.findByType('input').props.onChange({ target: { value: 'UNSAVED fixture title' } }),
  );
  await f.click('Version history');
  assert.match(f.text(), /Translation drafts and their exact originals are available/);
  assert.match(f.text(), /review status is separate from recipe review/);
  await act(async () => f.revisionButton(1).props.onClick());
  await f.click('Compare with saved revision 3');
  const comparison = f.view.root.findByType(RevisionComparison);
  assert.equal(comparison.props.current.input.title, 'Saved fixture title');
  assert.match(text(comparison), /Unsaved edits are excluded/);
  assert.match(text(comparison), /No differences in saved content or review evidence/);
  assert.deepEqual(f.focus, ['comparison heading']);
  await f.click('Include unchanged sections');
  assert.match(text(comparison), /1\/2 cup\npacked/);
  assert.match(text(comparison), /Current saved version/);
  assert.equal(f.writes, 0);
  await f.click('Show selected revision preview');
  assert.equal(f.view.root.findByType(RecipePreview).props.showMetadata, true);
});

test('a later selected revision wins and an earlier failed read cannot replace it or show a stale error', async (t) => {
  const f = await editorFixture(t);
  await f.click('Version history');
  const first = delayed<AdminDraft>();
  const second = delayed<AdminDraft>();
  f.responses.set(1, first.promise);
  f.responses.set(2, second.promise);
  const selectFirst = f.revisionButton(1).props.onClick;
  const selectSecond = f.revisionButton(2).props.onClick;
  await act(async () => {
    selectFirst();
    selectSecond();
  });
  await act(async () => second.resolve(saved(2)));
  await act(async () => first.reject(new Error('Stale fixture failure')));
  assert.equal(f.view.root.findByType(RecipePreview).props.draft.revision, 2);
  assert.doesNotMatch(f.text(), /Stale fixture failure|request could not be completed/);
  assert.equal(f.writes, 0);
});

test('history owner and session changes suppress late reads and retained callbacks without trapping the next read', async (t) => {
  const f = await editorFixture(t);
  await f.click('Version history');
  const response = delayed<AdminDraft>();
  f.responses.set(1, response.promise);
  const selected = f.revisionButton(1).props.onClick;
  await act(async () => selected());
  await f.update({ ...user, userId: 'another-owner' });
  await act(async () => {
    response.resolve(saved(1));
    selected();
  });
  assert.deepEqual(f.reads, [1]);
  assert.equal(f.view.root.findAllByType(RecipePreview).length, 0);
  await f.update();
  await f.click('Refresh history');
  const priorSession = f.revisionButton(2).props.onClick;
  await f.api.session();
  await act(async () => priorSession());
  assert.deepEqual(f.reads, [1]);
  await f.update();
  await f.click('Refresh history');
  await act(async () => f.revisionButton(2).props.onClick());
  assert.deepEqual(f.reads, [1, 2]);
  const stale = f.revisionButton(3).props.onClick;
  await f.unmount();
  await act(async () => stale());
  assert.deepEqual(f.reads, [1, 2]);
  assert.equal(f.writes, 0);
});
