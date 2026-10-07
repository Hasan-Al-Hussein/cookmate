import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { AdminDraft, AdminUser } from '../src/contracts';
import { fixture as serverFixture } from '../test/helpers';
import { AdminApi } from './api';
import { Field } from './components';
import { TranslationPanel } from './TranslationPanel';
import { TranslationRecovery } from './TranslationRecovery';
import { useTranslationOperations, type TranslationOperations } from './useTranslationOperations';
import type { TranslationWrite } from './translationJournal';

const operator: AdminUser = {
  userId: 'fixture-admin',
  username: 'fixture.admin',
  role: 'administrator',
};
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
async function setup(t: TestContext) {
  const f = await serverFixture(t);
  const client = f.client();
  await client.login();
  const created = (await client.create('translation-ui-source')).draft;
  const response = await client.request('PUT', `/admin/api/drafts/${created.draftId}`, {
    operationId: 'translation-ui-source-text',
    expectedRevision: 1,
    input: {
      ...created.input,
      title: 'Whole original title',
      description: 'Original description\nsecond line',
      category: 'Original category',
      cuisine: 'Original cuisine',
      ingredients: [{ rawName: 'Rice', rawMeasure: '1 1/2 cups' }],
      instructions: [
        { rawText: 'About this recipe', presentation: 'heading' },
        { rawText: 'Preserve whole\n\noriginal passage.', presentation: 'passage' },
      ],
      originalSourceUrl: 'https://example.com/original',
      changeSummary: 'Synthetic fixture source',
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  let draft: AdminDraft = response.json().draft;
  const entries = new Map<string, string>();
  let denyStorage = false;
  const globals = ['sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (denyStorage) throw new Error('Fixture full storage');
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        entries.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const calls: { path: string; method: string; body: unknown }[] = [];
  let loseNext = false,
    mismatchNext = false;
  let delay: { gate: Promise<void>; release(): void } | null = null;
  const makeApi = () =>
    new AdminApi(
      () => {},
      async (url, init) => {
        const path = String(url),
          method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT';
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ path, method, body });
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const result = await client.request(method, path, body, headers);
        const mutation =
          method !== 'GET' &&
          (path.includes('/translations') || path.includes('/translation-operations'));
        if (mutation && delay) {
          const own = delay;
          delay = null;
          await own.gate;
        }
        if (mutation && loseNext) {
          loseNext = false;
          throw new Error('Fixture acknowledgement lost after actual commit');
        }
        if (mutation && mismatchNext && result.statusCode === 200) {
          mismatchNext = false;
          return Response.json({ ...result.json(), operationId: 'wrong-operation' });
        }
        return new Response(result.body, {
          status: result.statusCode,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
  let api = makeApi();
  await api.session();
  let operations!: TranslationOperations;
  let user = operator,
    blocked = false,
    recipeDirty = false;
  const dirty: boolean[] = [],
    commits: unknown[] = [];
  const onDirty = (value: boolean) => {
    dirty.push(value);
  };
  function Harness() {
    operations = useTranslationOperations(api, user, (result) => {
      commits.push(result);
    });
    return createElement(
      'div',
      null,
      createElement(TranslationRecovery, { operations, onReauthenticate() {} }),
      createElement(TranslationPanel, {
        api,
        draft,
        user,
        operations,
        blocked,
        recipeDirty,
        onDirty,
      }),
    );
  }
  let view!: ReactTestRenderer;
  const mount = async () => {
    await act(async () => {
      view = create(createElement(Harness));
    });
  };
  await mount();
  async function settle() {
    for (let index = 0; index < 100; index++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      if (!operations.busy && !text(view.root).includes('Reading exact translation revisions…'))
        return;
    }
    throw new Error('Fixture did not settle');
  }
  await settle();
  t.after(async () => {
    await act(async () => view.unmount());
    globals.forEach((key, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  });
  const button = (label: string) =>
    view.root.findAllByType('button').find((node) => text(node) === label)!;
  const field = (label: string) =>
    view.root
      .findAllByType(Field)
      .find((node) => node.props.label === label)!
      .findAll((node) => ['input', 'textarea', 'select'].includes(String(node.type)))[0]!;
  async function click(label: string) {
    const node = button(label);
    assert.ok(node, `Missing button: ${label}`);
    assert.equal(!!node.props.disabled, false, `Disabled button: ${label}`);
    await act(async () => node.props.onClick());
    await settle();
  }
  async function change(label: string, value: string) {
    await act(async () => field(label).props.onChange({ target: { value } }));
  }
  async function submit(label: string) {
    await act(async () =>
      view.root
        .findAllByType('form')
        .find((node) => node.props['aria-label'] === label)!
        .props.onSubmit({ preventDefault() {} }),
    );
    await settle();
  }
  async function fill() {
    await change('Original language', 'en');
    await change('Target language', 'ar');
    await change('Translation input attribution', 'machine');
    await change('Translated title', 'عنوان كامل');
    await change('Translated ingredient 1', 'أرز');
    await change('Translated heading 1', 'عن الوصفة');
    await change('Translated passage 2', 'نص كامل\n\nسطر آخر');
  }
  return {
    f,
    get api() {
      return api;
    },
    client,
    calls,
    entries,
    dirty,
    commits,
    button,
    field,
    click,
    change,
    submit,
    fill,
    settle,
    get view() {
      return view;
    },
    get operations() {
      return operations;
    },
    get draft() {
      return draft;
    },
    text: () => text(view.root),
    loseNext() {
      loseNext = true;
    },
    mismatchNext() {
      mismatchNext = true;
    },
    denyStorage() {
      denyStorage = true;
    },
    async update(patch: {
      user?: AdminUser;
      blocked?: boolean;
      recipeDirty?: boolean;
      draft?: AdminDraft;
    }) {
      user = patch.user ?? user;
      blocked = patch.blocked ?? blocked;
      recipeDirty = patch.recipeDirty ?? recipeDirty;
      draft = patch.draft ?? draft;
      await act(async () => view.update(createElement(Harness)));
      await settle();
    },
    async remount() {
      await act(async () => view.unmount());
      await mount();
      await settle();
    },
    async replaceApi() {
      const next = makeApi();
      await act(async () => {
        await next.session();
        api = next;
        view.update(createElement(Harness));
      });
      await settle();
    },
    holdNext() {
      let release!: () => void;
      delay = {
        gate: new Promise<void>((done) => {
          release = done;
        }),
        release: () => release(),
      };
      return delay;
    },
  };
}

test('mounted editor panel saves a real revision-bound translation without quantity/media/source controls', async (t) => {
  const f = await setup(t);
  const original = structuredClone(f.draft.input);
  await f.click('New translation');
  assert.equal(f.dirty.at(-1), true);
  assert.equal(f.field('Original language').props.value, '');
  assert.equal(f.field('Target language').props.value, '');
  await f.fill();
  await f.submit('Translation editing');
  assert.equal(f.operations.pending, null);
  assert.equal(f.entries.size, 0);
  assert.match(f.text(), /Translation draft · human review pending/);
  assert.match(f.text(), /Machine input is retained/);
  assert.match(f.text(), /View original · source revision 2/);
  assert.match(f.text(), /1 1\/2 cups/);
  assert.match(f.text(), /Preserve whole\n\noriginal passage\./);
  const mutation = f.calls.find(
    (call) => call.method === 'POST' && call.path.endsWith('/translations'),
  )!;
  const body = mutation.body as {
    sourceRevision: number;
    input: { ingredients: unknown[]; instructions: unknown[] };
  };
  assert.equal(body.sourceRevision, 2);
  assert.deepEqual(body.input.ingredients, [{ rawName: 'أرز' }]);
  assert.deepEqual(body.input.instructions, [
    { rawText: 'عن الوصفة' },
    { rawText: 'نص كامل\n\nسطر آخر' },
  ]);
  assert.deepEqual(
    (await f.client.request('GET', `/admin/api/drafts/${f.draft.draftId}`)).json().input,
    original,
  );
  assert.equal(f.dirty.at(-1), false);
});

test('review is deliberate, actor-bound and old retained review callback cannot approve a restarted review', async (t) => {
  const f = await setup(t);
  await f.click('New translation');
  await f.fill();
  await f.submit('Translation editing');
  await f.click('Review saved translation');
  await f.change('Translation review decision', 'approved');
  assert.equal(f.button('Record translation review decision').props.disabled, true);
  await act(async () =>
    f.view.root
      .findAllByType('input')
      .find((node) => node.props.type === 'checkbox')!
      .props.onChange({ target: { checked: true } }),
  );
  const retained = f.view.root
    .findAllByType('form')
    .find((node) => node.props['aria-label'] === 'Translation review')!.props.onSubmit;
  await act(async () =>
    f.view.root
      .findAllByType('input')
      .find((node) => node.props.type === 'checkbox')!
      .props.onChange({ target: { checked: false } }),
  );
  await act(async () => retained({ preventDefault() {} }));
  await f.settle();
  assert.equal(f.calls.filter((call) => call.path.endsWith('/reviews')).length, 0);
  await f.click('Cancel translation review');
  await f.click('Review saved translation');
  await act(async () => retained({ preventDefault() {} }));
  await f.settle();
  assert.equal(f.calls.filter((call) => call.path.endsWith('/reviews')).length, 0);
  await f.change('Translation review decision', 'approved');
  await act(async () =>
    f.view.root
      .findAllByType('input')
      .find((node) => node.props.type === 'checkbox')!
      .props.onChange({ target: { checked: true } }),
  );
  await f.submit('Translation review');
  assert.match(f.text(), /Operator review recorded/);
  assert.match(f.text(), /Machine input is retained/);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/reviews')).length, 1);
});

test('stale source keeps original access and rebases onto new rows without silently carrying old translation', async (t) => {
  const f = await setup(t);
  await f.click('New translation');
  await f.fill();
  await f.submit('Translation editing');
  const response = await f.client.request('PUT', `/admin/api/drafts/${f.draft.draftId}`, {
    operationId: 'source-changed-during-translation',
    expectedRevision: 2,
    input: {
      ...f.draft.input,
      instructions: [
        ...f.draft.input.instructions,
        { rawText: 'New passage', presentation: 'passage' },
      ],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  await f.update({ draft: response.json().draft });
  const row = f.view.root.findAllByType('button').find((node) => text(node).includes('en → ar'))!;
  await act(async () => row.props.onClick());
  await f.settle();
  assert.match(f.text(), /Stale · original revision changed/);
  assert.equal(f.button('Review saved translation').props.disabled, true);
  await f.click('Rebase onto source revision 3');
  assert.equal(f.field('Translated ingredient 1').props.value, '');
  assert.equal(f.field('Translated passage 3').props.value, '');
  assert.match(f.text(), /previous saved translation and its original remain in history/);
  await f.change('Translation input attribution', 'human');
  await f.change('Translated title', 'Rebased fixture');
  await f.submit('Translation editing');
  assert.match(f.text(), /exact source revision 3/);
  assert.match(f.text(), /human review pending/);
  assert.match(f.text(), /Machine input is retained/);
  await f.click('Translation history');
  const historical = f.view.root
    .findAllByType('button')
    .find((node) => text(node).startsWith('Translation revision 1 · source 2'))!;
  await act(async () => historical.props.onClick());
  await f.settle();
  assert.match(f.text(), /نص كامل/);
  assert.match(f.text(), /View original · source revision 2/);
});

test('lost acknowledgement survives remount and recovers without resending original mutation', async (t) => {
  const f = await setup(t);
  await f.click('New translation');
  await f.fill();
  f.loseNext();
  await f.submit('Translation editing');
  assert.ok(f.operations.pending);
  assert.match(f.text(), /Translation change is unconfirmed/);
  assert.equal(
    [...f.entries.values()].some((value) => value.includes('عنوان كامل')),
    false,
  );
  const writes = f.calls.filter(
    (call) => call.method === 'POST' && call.path.endsWith('/translations'),
  ).length;
  await f.remount();
  assert.equal(f.operations.canRetry, false);
  await f.click('Check translation receipt');
  assert.equal(f.operations.pending, null);
  assert.equal(
    f.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/translations')).length,
    writes,
  );
  assert.match(f.text(), /عنوان كامل/);
});

test('mismatched receipt stays recoverable and storage failure sends no translation mutation', async (t) => {
  const f = await setup(t);
  await f.click('New translation');
  await f.fill();
  f.mismatchNext();
  await f.submit('Translation editing');
  assert.ok(f.operations.pending);
  assert.match(f.text(), /does not match this request/);
  await f.click('Check translation receipt');
  assert.equal(f.operations.pending, null);
  await f.click('Edit translated text');
  await f.change('Translated title', 'New edits remain');
  f.denyStorage();
  const before = f.calls.length;
  await f.submit('Translation editing');
  assert.match(f.text(), /Nothing was sent/);
  assert.equal(f.calls.slice(before).filter((call) => call.method !== 'GET').length, 0);
  assert.equal(f.field('Translated title').props.value, 'New edits remain');
});

test('dirty recipe, blocked state, role change and auth generation invalidate retained edit/review callbacks', async (t) => {
  const f = await setup(t);
  await f.update({ recipeDirty: true });
  assert.equal(f.button('New translation').props.disabled, true);
  await f.update({ recipeDirty: false });
  await f.click('New translation');
  await f.fill();
  const submit = f.view.root
    .findAllByType('form')
    .find((node) => node.props['aria-label'] === 'Translation editing')!.props.onSubmit;
  await f.update({ blocked: true });
  await act(async () => submit({ preventDefault() {} }));
  await f.settle();
  assert.equal(
    f.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/translations')).length,
    0,
  );
  await f.update({ blocked: false });
  await act(async () => {
    await f.api.session();
  });
  await act(async () => submit({ preventDefault() {} }));
  await f.settle();
  assert.equal(
    f.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/translations')).length,
    0,
  );
  await f.update({ user: { ...operator, role: 'editor' } });
  assert.equal(
    f.view.root.findAllByType('button').some((node) => text(node) === 'Review saved translation'),
    false,
  );
});

test('owner drift after actual commit suppresses callback and keeps durable operation for same-owner recovery', async (t) => {
  const f = await setup(t);
  const hold = f.holdNext();
  const write: TranslationWrite = {
    kind: 'create',
    draftId: f.draft.draftId,
    sourceRevision: 2,
    originalLanguage: 'en',
    targetLanguage: 'ar',
    input: {
      title: 'Delayed translation',
      description: null,
      category: '',
      cuisine: '',
      rawTags: null,
      ingredients: [{ rawName: 'Rice' }],
      instructions: [{ rawText: 'About' }, { rawText: 'Whole' }],
      changeSummary: '',
      attribution: 'machine',
    },
  };
  let pending!: Promise<void>;
  await act(async () => {
    pending = f.operations.run(write);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(f.operations.pending);
  // Update does not settle while the request is held; render the harness through an auth refresh instead.
  await act(async () => {
    await f.api.session();
  });
  await act(async () => {
    hold.release();
    await pending;
  });
  assert.equal(f.commits.length, 0);
  assert.ok(f.operations.pending);
  await f.remount();
  await f.click('Check translation receipt');
  assert.equal(f.commits.length, 1);
  assert.equal(f.operations.pending, null);
});

test('same-owner session refresh preserves unsaved translation data and invalidates the old submit', async (t) => {
  const f = await setup(t);
  await f.click('New translation');
  await f.fill();
  await f.change('Translated description', 'Unsaved description\nsecond line');
  const retainedSubmit = f.view.root
    .findAllByType('form')
    .find((node) => node.props['aria-label'] === 'Translation editing')!.props.onSubmit;
  const fields = [
    'Original language',
    'Target language',
    'Translation input attribution',
    'Translated title',
    'Translated description',
    'Translated ingredient 1',
    'Translated heading 1',
    'Translated passage 2',
  ];
  const values = fields.map((label) => f.field(label).props.value);
  const generation = f.api.sessionGeneration;
  await act(async () => {
    await f.api.session();
  });
  assert.notEqual(f.api.sessionGeneration, generation);
  await f.update({});
  assert.deepEqual(
    fields.map((label) => f.field(label).props.value),
    values,
  );
  assert.equal(f.dirty.at(-1), true);
  assert.match(f.text(), /Exact source revision 2/);
  await act(async () => retainedSubmit({ preventDefault() {} }));
  await f.settle();
  assert.equal(f.calls.filter((call) => call.method !== 'GET').length, 0);
  await f.submit('Translation editing');
  assert.equal(f.commits.length, 1);
  assert.equal(f.operations.pending, null);
});

test('same-owner API replacement cannot retry a retired sender and can check its exact receipt', async (t) => {
  const f = await setup(t);
  await f.click('New translation');
  await f.fill();
  f.loseNext();
  await f.submit('Translation editing');
  const pending = f.operations.pending;
  assert.ok(pending);
  assert.equal(f.operations.canRetry, true);
  const oldRetry = f.operations.retry;
  const oldApi = f.api;
  const writes = f.calls.filter((call) => call.method !== 'GET').length;
  const retainedJournal = [...f.entries.entries()];
  await f.replaceApi();
  assert.notEqual(f.api, oldApi);
  assert.equal(f.operations.canRetry, false);
  assert.equal(f.operations.canRecover, true);
  await act(async () => {
    await oldRetry();
    await f.operations.retry();
  });
  await f.settle();
  assert.equal(f.calls.filter((call) => call.method !== 'GET').length, writes);
  assert.deepEqual([...f.entries.entries()], retainedJournal);
  assert.equal(f.operations.pending, pending);
  await f.click('Check translation receipt');
  assert.equal(f.commits.length, 1);
  assert.equal(f.operations.pending, null);
  assert.equal(f.calls.filter((call) => call.method !== 'GET').length, writes);
  assert.ok(
    f.calls.some(
      (call) =>
        call.method === 'GET' &&
        call.path.includes(`/translation-operations/${pending.operationId}`) &&
        call.path.includes(pending.requestFingerprint),
    ),
  );
});
