import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement, useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminRightsInput, AdminUser } from '../src/contracts';
import { AdminApi } from './api';
import { RightsPanel } from './RightsPanel';
import { useOperations } from './useOperations';

const reviewer: AdminUser = { userId: 'reviewer', username: 'Fixture reviewer', role: 'reviewer' };
const original: AdminDraft = {
  draftId: 'rights-draft',
  recipeId: '1000000',
  revision: 3,
  status: 'draft',
  input: {
    title: 'Actual draft title',
    description: null,
    category: 'Pasta',
    cuisine: 'Italian',
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
  updatedBy: reviewer,
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
async function setup(t: TestContext, draft = original, user = reviewer) {
  const entries = new Map<string, string>();
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
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const oldAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  let recent = false;
  const submissions: (AdminRightsInput & { operationId: string; expectedRevision: number })[] = [];
  const api = new AdminApi(
    () => {},
    async (url, init) => {
      if (String(url).endsWith('/session'))
        return new Response(
          JSON.stringify({ configured: true, user, csrfToken: 'fixture-csrf', expiresAt: null }),
        );
      if (String(url).endsWith('/reauth')) {
        recent = true;
        return new Response(
          JSON.stringify({ configured: true, user, csrfToken: 'new-csrf', expiresAt: null }),
        );
      }
      if (String(url).endsWith('/rights')) {
        const body: AdminRightsInput & { operationId: string; expectedRevision: number } =
          JSON.parse(String(init?.body));
        submissions.push(body);
        if (!recent)
          return new Response(
            JSON.stringify({
              error: {
                code: 'reauth_required',
                message: 'Confirm your identity before recording this review.',
              },
            }),
            { status: 403 },
          );
        return new Response(
          JSON.stringify({
            operationId: body.operationId,
            draft: {
              ...draft,
              revision: draft.revision + 1,
              rights: [
                {
                  scope: body.scope,
                  status: body.status,
                  statement: body.statement,
                  sourceUrl: body.sourceUrl,
                  reviewerId: user.userId,
                  reviewedAt: '2026-09-30T13:00:00Z',
                  inputRevision: draft.revision,
                  contentBinding: 'a'.repeat(64),
                },
              ],
            },
          }),
        );
      }
      throw new Error('Unexpected request');
    },
  );
  await api.session();
  const dirtyValues: boolean[] = [];
  const reportDirty = (dirty: boolean) => {
    dirtyValues.push(dirty);
  };
  function Harness() {
    const [current, setCurrent] = useState(draft);
    const [authenticatedUser, setAuthenticatedUser] = useState(user);
    const operations = useOperations(api, authenticatedUser, (result) => setCurrent(result.draft));
    return createElement(RightsPanel, {
      api,
      draft: current,
      user: authenticatedUser,
      operations,
      blocked: operations.blocked,
      recipeDirty: false,
      onDirty: reportDirty,
      onReauthenticate: async () => {
        const session = await api.reauth('Fixture-only typed password');
        // App.confirmIdentity replaces authenticated state after the API generation changes.
        if (session.user) setAuthenticatedUser(session.user);
      },
    });
  }
  let view!: ReactTestRenderer;
  t.after(async () => {
    if (view) await act(async () => view.unmount());
    if (oldStorage) Object.defineProperty(globalThis, 'sessionStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
    if (oldAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', oldAct);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  await act(async () => {
    view = create(createElement(Harness));
  });
  const button = (label: string) => {
    const match = view.root.findAllByType('button').find((item) => contents(item) === label);
    assert.ok(match, `Missing button: ${label}`);
    return match;
  };
  const click = async (label: string) => {
    await act(async () => button(label).props.onClick());
  };
  const submit = async () => {
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  };
  return { view, storage, submissions, dirtyValues, button, click, submit };
}

test('only applicable scopes are editable and editor role cannot record evidence', async (t) => {
  const f = await setup(t);
  await f.click('Record permission evidence');
  const scope = f.view.root.findAllByType('select')[0]!;
  assert.deepEqual(
    scope.findAllByType('option').map((option) => option.props.value),
    ['recipe_text'],
  );
  assert.equal(f.button('Record permission review').props.disabled, true);
  assert.match(contents(f.view.root), /does not itself grant legal permission/);
});

test('actual photo and video make their own scopes available without inferring permission', async (t) => {
  const f = await setup(t, {
    ...original,
    photoUrl: '/admin/api/baseline/53262/photo',
    input: { ...original.input, videoUrl: 'https://youtu.be/abcdefghijk' },
  });
  await f.click('Record permission evidence');
  assert.deepEqual(
    f.view.root
      .findAllByType('select')[0]!
      .findAllByType('option')
      .map((option) => option.props.value),
    ['recipe_text', 'photo', 'video_embed'],
  );
  assert.match(contents(f.view.root), /No permission evidence recorded/);
  assert.equal(f.view.root.findAllByType('select')[1]!.props.value, 'unreviewed');
});

test('editor role sees records but no permission-writing control', async (t) => {
  const f = await setup(t, original, { ...reviewer, role: 'editor' });
  assert.equal(f.view.root.findAllByType('form').length, 0);
  assert.equal(f.view.root.findAllByType('button').length, 0);
  assert.match(contents(f.view.root), /reviewer or administrator/);
});

test('expired identity preserves evidence, reauthentication never resubmits, and explicit submit records the exact review', async (t) => {
  const f = await setup(t);
  await f.click('Record permission evidence');
  const statement =
    'Permission from the author covers this recipe text only.\nKeep the original measurements.';
  await act(async () => {
    f.view.root.findAllByType('select')[1]!.props.onChange({ target: { value: 'permitted' } });
    f.view.root.findByType('textarea').props.onChange({ target: { value: statement } });
    f.view.root
      .findByType('input')
      .props.onChange({ target: { value: 'https://example.test/permission' } });
  });
  await f.submit();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.view.root.findByType('textarea').props.value, statement);
  assert.equal(f.storage.getItem('cookmate.admin.pending.v1'), null);
  assert.equal(f.dirtyValues.at(-1), true);
  await f.click('Confirm identity to continue');
  assert.equal(f.submissions.length, 1);
  assert.equal(f.view.root.findByType('textarea').props.value, statement);
  await f.submit();
  assert.equal(f.submissions.length, 2);
  assert.notEqual(f.submissions[0]!.operationId, f.submissions[1]!.operationId);
  assert.deepEqual(
    { ...f.submissions[1], operationId: 'normalized' },
    {
      operationId: 'normalized',
      expectedRevision: 3,
      scope: 'recipe_text',
      status: 'permitted',
      statement,
      sourceUrl: 'https://example.test/permission',
    },
  );
  assert.equal(f.view.root.findAllByType('form').length, 0);
  assert.match(contents(f.view.root), /Permission recorded/);
  assert.match(contents(f.view.root), /Reviewed revision 3/);
  assert.equal(f.dirtyValues.at(-1), false);
});
