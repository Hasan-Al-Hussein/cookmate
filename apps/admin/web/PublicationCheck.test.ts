import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { AdminPublicationPreparation } from '../src/contracts';
import type { AdminTranslationSummary } from '../src/translations/contracts';
import { AdminApi } from './api';
import { PublicationCheck } from './PublicationCheck';
import { Field } from './components';

const receipt: AdminPublicationPreparation = {
  status: 'prepared_not_published',
  draftId: 'fixture',
  draftRevision: 7,
  recipeId: '52819',
  contentFingerprint: 'a'.repeat(64),
  publicationFingerprint: 'b'.repeat(64),
  documentBytes: 4034,
  permissionScopes: ['recipe_text', 'photo'],
  originalEvidenceRetained: true,
  operationId: 'prepare-fixture',
  revisionId: 'authored-fixture',
  retainedAt: '2026-09-30T15:00:00Z',
};
const contents = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : contents(child))).join('');

async function fixture(
  t: TestContext,
  send: (method: string, path: string, body: unknown) => Promise<unknown>,
  disabled = false,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  let view: ReactTestRenderer;
  let mounted = true;
  const prepared: AdminPublicationPreparation[] = [];
  t.after(async () => {
    if (view! && mounted) await act(async () => view.unmount());
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const api = new AdminApi(
    () => {},
    async (url, init) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/session')
            ? { configured: true, user: null, csrfToken: 'fixture-token', expiresAt: null }
            : await send(
                init?.method ?? 'GET',
                String(url),
                typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
              ),
        ),
      ),
  );
  await api.session();
  let props: ComponentProps<typeof PublicationCheck> = {
    api,
    draft: { draftId: 'fixture', revision: 7 },
    disabled,
    onReauthenticate() {},
    onPrepared(value) {
      prepared.push(value);
    },
  };
  await act(async () => {
    view = create(createElement(PublicationCheck, props));
  });
  return {
    api,
    root: () => view!.root,
    prepared,
    text: () => contents(view!.root),
    button: (label: string) =>
      view!.root.findAllByType('button').find((button) => contents(button) === label)!,
    async click(label: string) {
      await act(async () => {
        this.button(label).props.onClick();
      });
    },
    async update(changes: Partial<ComponentProps<typeof PublicationCheck>>) {
      props = { ...props, ...changes };
      await act(async () => view.update(createElement(PublicationCheck, props)));
    },
    async unmount() {
      await act(async () => view.unmount());
      mounted = false;
    },
  };
}

test('preparation UI reports only retained private content, with exact revision and no publication claim', async (t) => {
  const calls: string[] = [];
  const f = await fixture(t, async (method, path) => {
    calls.push(`${method} ${path}`);
    return receipt;
  });
  await f.click('Prepare publication package');
  assert.match(f.text(), /Package retained privately · Not published/);
  assert.match(f.text(), /draft revision 7/);
  assert.match(f.text(), /Original catalogue evidence is retained/);
  assert.deepEqual(calls, ['POST /admin/api/drafts/fixture/publication-preparation']);
  assert.deepEqual(f.prepared, [receipt]);
});

function translation(changes: Partial<AdminTranslationSummary> = {}): AdminTranslationSummary {
  return {
    translationId: 'translation-ar',
    revision: 3,
    source: {
      draftId: 'fixture',
      revision: 7,
      recipeId: '52819',
      inputFingerprint: 'c'.repeat(64),
    },
    originalLanguage: 'en',
    targetLanguage: 'ar',
    translatedFingerprint: 'd'.repeat(64),
    machineAssisted: true,
    status: 'reviewed',
    effectiveStatus: 'reviewed',
    sourceStatus: { kind: 'current' },
    review: {
      decision: 'approved',
      note: 'Fixture acknowledgement only',
      reviewerId: 'fixture-user',
      reviewedAt: '2026-10-02T00:00:00Z',
      inputRevision: 2,
      binding: 'e'.repeat(64),
      evidence: 'operator_acknowledgement',
    },
    updatedAt: '2026-10-02T00:00:00Z',
    updatedBy: { userId: 'fixture-user', username: 'fixture', role: 'administrator' },
    ...changes,
  };
}
const included = [
  { translationId: 'translation-ar', translationRevision: 3, targetLanguage: 'ar' },
];
const permission = 'Synthetic translation permission, not real rights clearance.';
const translatedReceipt: AdminPublicationPreparation = {
  ...receipt,
  translations: included,
  permissionScopes: ['recipe_text', 'photo', 'translated_recipe_text'],
};
type UI = Awaited<ReturnType<typeof fixture>>;
const include = (f: UI, language = 'ar') =>
  f
    .root()
    .findAllByType('label')
    .find((label) => contents(label) === ` Include ${language} translation`)!
    .findByType('input');
const field = (f: UI, label: string) =>
  f
    .root()
    .findAllByType(Field)
    .find((item) => item.props.label === label)!;
async function selectTranslation(f: UI) {
  await f.click('Choose reviewed translations');
  await act(async () => include(f).props.onChange({ target: { checked: true } }));
  await act(async () =>
    field(f, 'Translation permission statement · ar')
      .findByType('textarea')
      .props.onChange({ target: { value: permission } }),
  );
  await act(async () =>
    f
      .root()
      .findAllByType('label')
      .find(
        (label) =>
          contents(label) ===
          ' I have reviewed permission to publish this exact translated version.',
      )!
      .findByType('input')
      .props.onChange({ target: { checked: true } }),
  );
}

test('translation inclusion requires explicit separate permission and sends only exact selection metadata', async (t) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const f = await fixture(t, async (method, path, body) => {
    calls.push({ method, path, body });
    return path.endsWith('/translations') ? { items: [translation()] } : translatedReceipt;
  });
  await f.click('Choose reviewed translations');
  await act(async () => include(f).props.onChange({ target: { checked: true } }));
  assert.equal(f.button('Prepare publication package').props.disabled, true);
  await f.click('Prepare publication package');
  assert.equal(calls.length, 1);
  await act(async () =>
    field(f, 'Translation permission statement · ar')
      .findByType('textarea')
      .props.onChange({ target: { value: permission } }),
  );
  assert.equal(f.button('Prepare publication package').props.disabled, true);
  await act(async () =>
    f
      .root()
      .findAllByType('label')
      .find(
        (label) =>
          contents(label) ===
          ' I have reviewed permission to publish this exact translated version.',
      )!
      .findByType('input')
      .props.onChange({ target: { checked: true } }),
  );
  await f.click('Prepare publication package');
  assert.deepEqual(calls[1]?.body, {
    expectedRevision: 7,
    translations: [
      {
        translationId: 'translation-ar',
        translationRevision: 3,
        rights: { statement: permission, sourceUrl: null, acknowledge: true },
      },
    ],
  });
  assert.match(f.text(), /Included reviewed translations: ar · revision 3/);
  assert.deepEqual(f.prepared, [translatedReceipt]);
});

test('an unavailable source review cannot be selected even through its disabled callback', async (t) => {
  const stale = translation({
    effectiveStatus: 'stale',
    sourceStatus: { kind: 'stale', currentRevision: 8 },
  });
  const f = await fixture(t, async (_method, path) =>
    path.endsWith('/translations') ? { items: [stale] } : receipt,
  );
  await f.click('Choose reviewed translations');
  assert.equal(include(f).props.disabled, true);
  await act(async () => include(f).props.onChange({ target: { checked: true } }));
  assert.equal(f.root().findAllByType('textarea').length, 0);
  await f.click('Prepare publication package');
  assert.deepEqual(f.prepared, [receipt]);
});

test('translation acknowledgement loss fixes the original selection and recovers by the same full request', async (t) => {
  const calls: { path: string; body: unknown }[] = [];
  const f = await fixture(t, async (_method, path, body) => {
    calls.push({ path, body });
    if (path.endsWith('/translations')) return { items: [translation()] };
    if (path.endsWith('/recovery')) return translatedReceipt;
    throw Error('Lost acknowledgement');
  });
  await selectTranslation(f);
  const oldToggle = include(f).props.onChange;
  const oldStatement = field(f, 'Translation permission statement · ar').findByType('textarea')
    .props.onChange;
  const findOld = f.button('Find retained packages').props.onClick;
  await f.click('Prepare publication package');
  assert.equal(f.button('Choose reviewed translations').props.disabled, true);
  assert.equal(f.button('Find retained packages').props.disabled, true);
  await act(async () => {
    oldToggle({ target: { checked: false } });
    oldStatement({ target: { value: 'Newer unsent value' } });
    findOld();
  });
  assert.equal(
    field(f, 'Translation permission statement · ar').findByType('textarea').props.value,
    permission,
  );
  assert.equal(calls.length, 2);
  await f.click('Recover prepared package');
  assert.equal(calls[2]?.path, '/admin/api/drafts/fixture/publication-preparation/recovery');
  assert.deepEqual(calls[2]?.body, calls[1]?.body);
  assert.deepEqual(f.prepared, [translatedReceipt]);
});

test('a response missing selected translations cannot be accepted as a prepared package', async (t) => {
  const f = await fixture(t, async (_method, path) =>
    path.endsWith('/translations') ? { items: [translation()] } : receipt,
  );
  await selectTranslation(f);
  await f.click('Prepare publication package');
  assert.match(f.text(), /does not match this saved revision/);
  assert.deepEqual(f.prepared, []);
  assert.equal(f.button('Find retained packages').props.disabled, true);
});

test('retained translation packages can be found after remount without reissuing preparation', async (t) => {
  const saved = {
    operationId: translatedReceipt.operationId,
    draftRevision: 7,
    revisionId: translatedReceipt.revisionId,
    translations: included,
  };
  const calls: string[] = [];
  const f = await fixture(t, async (method, path) => {
    calls.push(`${method} ${path}`);
    return path.endsWith('?list=1') ? { items: [saved] } : translatedReceipt;
  });
  await f.click('Find retained packages');
  await f.click(`Recover package ${saved.operationId}`);
  assert.deepEqual(calls, [
    'GET /admin/api/drafts/fixture/publication-preparation?list=1',
    'GET /admin/api/drafts/fixture/publication-preparation?operationId=prepare-fixture',
  ]);
  assert.deepEqual(f.prepared, [translatedReceipt]);
});

test('recovery of an earlier source revision remains historical and never approves the current draft', async (t) => {
  const saved = {
    operationId: translatedReceipt.operationId,
    draftRevision: 7,
    revisionId: translatedReceipt.revisionId,
    translations: included,
  };
  const f = await fixture(t, async (_method, path) =>
    path.endsWith('?list=1') ? { items: [saved] } : translatedReceipt,
  );
  await f.update({ draft: { draftId: 'fixture', revision: 8 } });
  await f.click('Find retained packages');
  await f.click(`Recover package ${saved.operationId}`);
  assert.match(f.text(), /not approval of the current recipe or translations/);
  assert.deepEqual(f.prepared, []);
});

test('a delayed preparation is not shown or forwarded after its source context changes', async (t) => {
  let resolve!: (value: unknown) => void;
  const f = await fixture(
    t,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.click('Prepare publication package');
  await f.update({ draft: { draftId: 'fixture', revision: 8 } });
  await act(async () => resolve(receipt));
  assert.doesNotMatch(f.text(), /Package retained privately/);
  assert.deepEqual(f.prepared, []);
});

test('same-generation API replacement clears both selected translations and visible permission fields', async (t) => {
  const f = await fixture(t, async (_method, path) =>
    path.endsWith('/translations') ? { items: [translation()] } : translatedReceipt,
  );
  await selectTranslation(f);
  let sent: unknown;
  const next = new AdminApi(
    () => {},
    async (url, init) => {
      if (String(url).endsWith('/session'))
        return Response.json({ configured: true, user: null, csrfToken: 'next', expiresAt: null });
      sent = JSON.parse(String(init?.body));
      return Response.json(receipt);
    },
  );
  await next.session();
  assert.equal(next.sessionGeneration, f.api.sessionGeneration);
  await f.update({ api: next });
  assert.equal(f.root().findAllByType('textarea').length, 0);
  assert.doesNotMatch(f.text(), /Include ar translation/);
  await f.click('Prepare publication package');
  assert.deepEqual(sent, { expectedRevision: 7 });
  assert.deepEqual(f.prepared, [receipt]);
});

test('an uncertain preparation exposes explicit read-only recovery for that same revision', async (t) => {
  const calls: string[] = [];
  const f = await fixture(t, async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === 'POST') throw new Error('Lost fixture acknowledgement');
    return receipt;
  });
  await f.click('Prepare publication package');
  assert.match(f.text(), /outcome is unconfirmed/);
  assert.doesNotMatch(f.text(), /Package retained privately · Not published/);
  assert.deepEqual(f.prepared, []);
  await f.click('Recover prepared package');
  assert.match(f.text(), /Package retained privately · Not published/);
  assert.deepEqual(calls, [
    'POST /admin/api/drafts/fixture/publication-preparation',
    'GET /admin/api/drafts/fixture/publication-preparation?revision=7',
  ]);
});

test('a mismatched receipt never becomes a success notice', async (t) => {
  const f = await fixture(t, async () => ({ ...receipt, draftRevision: 8 }));
  await f.click('Prepare publication package');
  assert.match(f.text(), /does not match this saved revision/);
  assert.doesNotMatch(f.text(), /Package retained privately · Not published/);
});

test('blocked editing prevents preparation even if a stale event handler is invoked', async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    async () => {
      calls++;
      return receipt;
    },
    true,
  );
  assert.equal(f.button('Prepare publication package').props.disabled, true);
  await f.click('Prepare publication package');
  assert.equal(calls, 0);
});

test('an enabled preparation callback cannot send after editing becomes blocked', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return receipt;
  });
  const earlierClick = f.button('Prepare publication package').props.onClick;
  await f.update({ disabled: true });
  await act(async () => {
    earlierClick();
  });
  assert.equal(calls, 0);
  assert.deepEqual(f.prepared, []);
});

test('an enabled preparation callback cannot send after unmounting', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return receipt;
  });
  const earlierClick = f.button('Prepare publication package').props.onClick;
  await f.unmount();
  await act(async () => {
    earlierClick();
  });
  assert.equal(calls, 0);
  assert.deepEqual(f.prepared, []);
});

test('a callback for an earlier saved revision cannot prepare after that revision changes', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return receipt;
  });
  const earlierClick = f.button('Prepare publication package').props.onClick;
  await f.update({ draft: { draftId: 'fixture', revision: 8 } });
  await act(async () => {
    earlierClick();
  });
  assert.equal(calls, 0);
  assert.deepEqual(f.prepared, []);
});
