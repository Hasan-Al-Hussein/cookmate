import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminDraftInput } from '../src/contracts';
import App from './App';

const recoveryKey = 'cookmate.admin.pending.v1';
const pending = JSON.stringify({
  version: 1,
  pending: {
    operationId: 'a0000000-0000-4000-8000-000000000001',
    userId: 'operator',
    kind: 'save',
    draftId: 'fixture-draft',
    createdAt: '2026-09-30T12:00:00Z',
  },
});
const operator = {
  userId: 'operator',
  username: 'Fixture operator',
  role: 'administrator',
} as const;
const draft: AdminDraft = {
  draftId: 'fixture-draft',
  recipeId: '1000000',
  revision: 1,
  status: 'draft',
  input: {
    title: 'Fixture recipe',
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
  updatedBy: operator,
  metadata: unknownReviewedMetadata(),
  approval: null,
  validationIssues: [],
  photoUrl: null,
};

function contents(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : contents(child)))
    .join('');
}
async function fixture(t: TestContext, reference: string | null, saveGate?: Promise<void>) {
  const entries = new Map<string, string>();
  if (reference !== null) entries.set(recoveryKey, reference);
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
  const globals = ['window', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  let signedIn = true;
  const calls: { url: string; method: string }[] = [];
  const saves: { operationId: string; expectedRevision: number; input: AdminDraftInput }[] = [];
  let unauthorizedLibraryReads = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: path, method });
    if (path === '/admin/api/session' && method === 'DELETE') {
      signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (path === '/admin/api/session' && method === 'POST') signedIn = true;
    if (path === '/admin/api/session')
      return new Response(
        JSON.stringify({
          configured: true,
          user: signedIn ? operator : null,
          csrfToken: 'fixture-csrf',
          expiresAt: null,
        }),
      );
    if (path.startsWith('/admin/api/library')) {
      if (!signedIn) {
        unauthorizedLibraryReads++;
        return new Response(
          JSON.stringify({ error: { code: 'sign_in_required', message: 'Please sign in.' } }),
          { status: 401 },
        );
      }
      return new Response(
        JSON.stringify({
          items: [],
          nextCursor: null,
          publicationStatus: { status: 'not_configured' },
        }),
      );
    }
    if (path === '/admin/api/drafts' && method === 'POST')
      return new Response(
        JSON.stringify({
          operationId: JSON.parse(String(init?.body)).operationId,
          draft,
        }),
      );
    if (path === '/admin/api/drafts/fixture-draft' && method === 'PUT') {
      const save = JSON.parse(String(init?.body));
      saves.push(save);
      if (saveGate) await saveGate;
      return new Response(
        JSON.stringify({
          operationId: save.operationId,
          draft: { ...draft, revision: 2, input: save.input },
        }),
      );
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  };
  t.mock.method(globalThis, 'fetch', fetcher);
  let renderer!: ReactTestRenderer;
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    globals.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  });
  await act(async () => {
    renderer = create(createElement(App), {
      createNodeMock: (element) =>
        element.type === 'dialog' ? { showModal() {}, close() {} } : null,
    });
  });
  const button = (label: string) => {
    const found = renderer.root
      .findAllByType('button')
      .find((node) => contents(node).trim() === label);
    assert.ok(found, `Button missing: ${label}`);
    return found;
  };
  const click = async (label: string) => {
    const target = button(label);
    assert.equal(Boolean(target.props.disabled), false, `Button disabled: ${label}`);
    await act(async () => {
      target.props.onClick();
    });
  };
  return {
    renderer,
    calls,
    storage,
    button,
    click,
    saves,
    get unauthorizedLibraryReads() {
      return unauthorizedLibraryReads;
    },
  };
}

for (const [name, reference] of [
  ['pending operation', pending],
  ['unreadable future journal', '{"version":99,"opaque":"keep"}'],
] as const) {
  test(`sign-out remains usable with ${name}, preserving references without cancellation or replay`, async (t) => {
    const f = await fixture(t, reference);
    await f.click('Sign out');
    assert.match(contents(f.renderer.root), /Signing out does not cancel or replay it/);
    assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 0);
    await f.click('Sign out and keep recovery references');
    assert.deepEqual(
      f.calls.filter((call) => call.method !== 'GET'),
      [{ url: '/admin/api/session', method: 'DELETE' }],
    );
    assert.equal(f.storage.getItem(recoveryKey), reference);
    assert.match(contents(f.renderer.root), /Sign in to your kitchen/);
  });
}

test('dirty edits require explicit discard and remain intact when sign-out is dismissed', async (t) => {
  const f = await fixture(t, null);
  await f.click('＋ New recipe');
  const title = f.renderer.root
    .findAllByType('input')
    .find((node) => node.props.value === 'Fixture recipe');
  assert.ok(title);
  await act(async () => {
    title.props.onChange({ target: { value: 'Unsaved title' } });
  });
  await f.click('Sign out');
  assert.ok(f.button('Discard unsaved edits and sign out'));
  await f.click('Stay signed in');
  assert.ok(
    f.renderer.root.findAllByType('input').some((node) => node.props.value === 'Unsaved title'),
  );
  assert.equal(
    f.calls.some((call) => call.method === 'DELETE'),
    false,
  );
  await f.click('Sign out');
  await f.click('Discard unsaved edits and sign out');
  assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 1);
  assert.equal(
    f.calls.some((call) => call.method === 'PUT' || call.url.includes('/cancel')),
    false,
  );
});

test('library suspends during logout and reloads automatically after signing back in', async (t) => {
  const f = await fixture(t, null);
  assert.equal(f.calls.filter((call) => call.url.startsWith('/admin/api/library')).length, 1);
  await f.click('Sign out');
  await f.click('Sign out and keep recovery references');
  assert.equal(f.unauthorizedLibraryReads, 0);
  assert.equal(f.calls.filter((call) => call.url.startsWith('/admin/api/library')).length, 1);
  const username = f.renderer.root.findByProps({ autoComplete: 'username' });
  const password = f.renderer.root.findByProps({ autoComplete: 'current-password' });
  await act(async () => {
    username.props.onChange({ target: { value: 'Fixture operator' } });
    password.props.onChange({ target: { value: 'Fixture-only password' } });
  });
  await act(async () => {
    f.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  assert.equal(f.unauthorizedLibraryReads, 0);
  assert.equal(f.calls.filter((call) => call.url.startsWith('/admin/api/library')).length, 2);
  assert.doesNotMatch(contents(f.renderer.root), /Library needs a refresh/);
  assert.match(contents(f.renderer.root), /0 recipes shown/);
});

test('compact save submits the same exact draft and disables both controls until acknowledgement', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, null, gate);
  await f.click('＋ New recipe');
  const compact = () =>
    f.renderer.root.findByProps({ className: 'editor-compact-save' }).findByType('button');
  const full = () =>
    f.renderer.root.findByProps({ className: 'save-panel' }).findAllByType('button')[0]!;
  assert.equal(compact().props.disabled, true);
  assert.equal(full().props.disabled, true);
  const title = f.renderer.root
    .findAllByType('input')
    .find((node) => node.props.value === 'Fixture recipe');
  assert.ok(title);
  await act(async () => {
    title.props.onChange({ target: { value: 'Exact edited title' } });
  });
  assert.equal(compact().props.disabled, false);
  assert.equal(full().props.disabled, false);
  await act(async () => {
    compact().props.onClick();
  });
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0]!.expectedRevision, 1);
  assert.deepEqual(f.saves[0]!.input, { ...draft.input, title: 'Exact edited title' });
  assert.equal(compact().props.disabled, true);
  assert.equal(full().props.disabled, true);
  await act(async () => release());
  assert.equal(compact().props.disabled, true);
  assert.equal(full().props.disabled, true);
  assert.equal(f.storage.getItem(recoveryKey), null);
  assert.match(contents(f.renderer.root), /Local revision 2 is confirmed/);
});

test('permission review remains editable in the main column while recipe fields are locked', async (t) => {
  const f = await fixture(t, null);
  await f.click('＋ New recipe');
  const main = f.renderer.root.findByProps({ className: 'editor-main' });
  const rights = main.findByProps({ id: 'recipe-rights' });
  assert.equal(
    f.renderer.root
      .findByProps({ className: 'editor-aside' })
      .findAllByProps({ id: 'recipe-rights' }).length,
    0,
  );
  await f.click('Record permission evidence');
  assert.equal(main.findByProps({ className: 'editor-fields' }).props.disabled, true);
  assert.equal(rights.findByType('fieldset').props.disabled, false);
  const statement = rights.findByType('textarea');
  await act(async () => {
    statement.props.onChange({ target: { value: 'Evidence for this exact recipe text.' } });
  });
  assert.equal(rights.findByType('textarea').props.value, 'Evidence for this exact recipe text.');
  await f.click('Discard permission form');
  assert.equal(main.findByProps({ className: 'editor-fields' }).props.disabled, false);
  assert.equal(
    f.calls.some((call) => call.url.endsWith('/rights')),
    false,
  );
});
