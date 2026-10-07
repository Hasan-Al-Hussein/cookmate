import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement, useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminMetadataInput, AdminUser } from '../src/contracts';
import { applyMetadataReview } from '../src/drafts/metadata';
import { AdminApi } from './api';
import { Field } from './components';
import { MetadataPanel } from './MetadataPanel';
import { metadataForm, metadataInput } from './metadataForm';
import { useOperations } from './useOperations';

const reviewer: AdminUser = { userId: 'reviewer', username: 'Fixture reviewer', role: 'reviewer' };
const draft: AdminDraft = {
  draftId: 'metadata-fixture',
  recipeId: '1000000',
  revision: 3,
  status: 'draft',
  input: {
    title: 'Fixture recipe',
    description: null,
    category: 'Test',
    cuisine: 'Test',
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
  updatedBy: reviewer,
  metadata: unknownReviewedMetadata(),
  approval: null,
  validationIssues: [],
  photoUrl: null,
};
const contents = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : contents(child))).join('');
async function fixture(t: TestContext, original = draft) {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
    removeItem(key: string) {
      entries.delete(key);
    },
  };
  const old = ['sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const submissions: {
    operationId: string;
    expectedRevision: number;
    input: AdminMetadataInput;
  }[] = [];
  const api = new AdminApi(
    () => {},
    async (url, init) => {
      if (String(url).endsWith('/session'))
        return Response.json({
          configured: true,
          user: reviewer,
          csrfToken: 'fixture-csrf',
          expiresAt: null,
        });
      assert.equal(String(url), '/admin/api/drafts/metadata-fixture/metadata');
      const body = JSON.parse(String(init?.body));
      submissions.push(body);
      return Response.json({
        operationId: body.operationId,
        draft: {
          ...original,
          revision: original.revision + 1,
          metadata: applyMetadataReview(
            original.metadata,
            body.input,
            reviewer.userId,
            '2026-10-01T01:00:00.000Z',
          ),
        },
      });
    },
  );
  await api.session();
  const dirty: boolean[] = [];
  const onDirty = (value: boolean) => {
    dirty.push(value);
  };
  function Harness({ blocked, user }: { blocked: boolean; user: AdminUser }) {
    const [current, setCurrent] = useState(original);
    const operations = useOperations(api, user, (result) => setCurrent(result.draft));
    return createElement(MetadataPanel, {
      api,
      draft: current,
      user,
      operations,
      blocked: blocked || operations.blocked,
      recipeDirty: false,
      onDirty,
      onReauthenticate() {},
    });
  }
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(Harness, { blocked: false, user: reviewer }));
  });
  t.after(async () => {
    await act(async () => view.unmount());
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    submissions,
    dirty,
    entries,
    text: () => contents(view.root),
    form: () => view.root.findByType('form'),
    value(label: string) {
      const field = view.root.findAllByType(Field).find((item) => item.props.label === label)!;
      return field.findAll((item) =>
        ['input', 'textarea', 'select'].includes(String(item.type)),
      )[0]!.props.value;
    },
    async click(label: string) {
      const button = view.root.findAllByType('button').find((item) => contents(item) === label)!;
      await act(async () => button.props.onClick());
    },
    async update(blocked: boolean, user = reviewer) {
      await act(async () => view.update(createElement(Harness, { blocked, user })));
    },
    async unknown(value: boolean) {
      await act(async () =>
        view.root
          .findAllByType('input')
          .find((item) => item.props.type === 'checkbox')!
          .props.onChange({ target: { checked: value } }),
      );
    },
    async change(label: string, value: string) {
      const field = view.root.findAllByType(Field).find((item) => item.props.label === label)!;
      const input = field.findAll((item) =>
        ['input', 'textarea', 'select'].includes(String(item.type)),
      )[0]!;
      await act(async () => input.props.onChange({ target: { value } }));
    },
    async submit() {
      await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    },
  };
}

test('metadata form preserves unknown and legitimate zero nutrition without supplying missing measures', () => {
  const form = metadataForm(unknownReviewedMetadata(), 'nutrition');
  assert.deepEqual(metadataInput(form), { field: 'nutrition', value: null, source: null });
  form.unknown = false;
  form.source = 'Fixture source';
  assert.throws(() => metadataInput(form), /at least one/);
  form.nutrition.energyKcal = '0';
  assert.deepEqual(metadataInput(form), {
    field: 'nutrition',
    value: {
      basis: 'per_serving',
      energyKcal: 0,
      proteinGrams: null,
      carbohydrateGrams: null,
      fatGrams: null,
    },
    source: 'Fixture source',
  });
  form.source = ' ';
  assert.throws(() => metadataInput(form), /source evidence/);
});

test('review form requires evidence, sends revision-safe exact values and resets only after mutation receipt', async (t) => {
  const f = await fixture(t);
  assert.match(f.text(), /operator-recorded source claims/);
  assert.match(f.text(), /Unknown/);
  await f.click('Review optional metadata');
  assert.equal(f.dirty.at(-1), true);
  await f.unknown(false);
  await f.change('Servings', '2.5');
  await f.submit();
  assert.equal(f.submissions.length, 0);
  assert.match(f.text(), /Describe the source evidence/);
  await f.change('Source evidence', 'Fixture source for exact 2.5 servings');
  await f.submit();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0]!.expectedRevision, 3);
  assert.deepEqual(f.submissions[0]!.input, {
    field: 'servings',
    value: 2.5,
    source: 'Fixture source for exact 2.5 servings',
  });
  assert.equal(f.dirty.at(-1), false);
  assert.equal(f.entries.size, 0);
  assert.match(f.text(), /Recorded by reviewer/);
});

test('captured submit is blocked after parent guard or role changes and never turns an editor into reviewer', async (t) => {
  const f = await fixture(t);
  await f.click('Review optional metadata');
  const submit = f.form().props.onSubmit;
  await f.update(true);
  await act(async () => submit({ preventDefault() {} }));
  assert.equal(f.submissions.length, 0);
  await f.update(false, { ...reviewer, role: 'editor' });
  await act(async () => submit({ preventDefault() {} }));
  assert.equal(f.submissions.length, 0);
  assert.match(f.text(), /reviewer or administrator must/);
});

test('serving review explicitly warns about dependent nutrition clearing and cancel keeps saved evidence', async (t) => {
  const original = {
    ...draft,
    metadata: applyMetadataReview(
      draft.metadata,
      {
        field: 'nutrition',
        value: {
          basis: 'per_serving',
          energyKcal: 100,
          proteinGrams: null,
          carbohydrateGrams: null,
          fatGrams: null,
        },
        source: 'Fixture source',
      },
      reviewer.userId,
      draft.updatedAt,
    ),
  };
  const f = await fixture(t, original);
  await f.click('Review optional metadata');
  assert.match(f.text(), /Changing servings clears the current per-serving nutrition/);
  await f.click('Discard metadata form');
  assert.equal(f.submissions.length, 0);
  assert.equal(f.dirty.at(-1), false);
  assert.match(f.text(), /Fixture source/);
});

test('discard resets to saved metadata and synchronously revokes a captured submit before and after reopening', async (t) => {
  const original = {
    ...draft,
    metadata: applyMetadataReview(
      draft.metadata,
      { field: 'servings', value: 2.5, source: 'Saved fixture evidence' },
      reviewer.userId,
      draft.updatedAt,
    ),
  };
  const f = await fixture(t, original);
  await f.click('Review optional metadata');
  await f.change('Servings', '9');
  await f.change('Source evidence', 'Discarded fixture evidence');
  const submit = f.form().props.onSubmit;
  const discard = f
    .form()
    .findAllByType('button')
    .find((button) => contents(button) === 'Discard metadata form')!.props.onClick;
  await act(async () => {
    discard();
    // Exercise the stale callback before React commits the closed form.
    submit({ preventDefault() {} });
  });
  assert.equal(f.submissions.length, 0);
  assert.equal(f.dirty.at(-1), false);
  await f.click('Review optional metadata');
  assert.equal(f.value('Servings'), '2.5');
  assert.equal(f.value('Source evidence'), 'Saved fixture evidence');
  await act(async () => submit({ preventDefault() {} }));
  assert.equal(f.submissions.length, 0);
  assert.equal(f.entries.size, 0);
});
