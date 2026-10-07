import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminPublicationPreparation } from '../src/contracts';
import type { AdminTranslationSummary } from '../src/translations/contracts';
import App from './App';
import { Field } from './components';

const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
test('ordinary admin shell revokes an earlier package when translation selection changes and reviews exact inclusion', async (t) => {
  const user = { userId: 'operator', username: 'Fixture operator', role: 'administrator' } as const;
  const draft: AdminDraft = {
    draftId: 'draft-fixture',
    recipeId: '1000000',
    revision: 7,
    status: 'reviewed',
    input: {
      title: 'Original fixture recipe',
      description: null,
      category: 'Pasta',
      cuisine: 'Italian',
      rawTags: null,
      recipePage: null,
      originalSourceUrl: null,
      videoUrl: null,
      photoAssetId: null,
      ingredients: [{ rawName: 'Rice', rawMeasure: '1 1/2 cups' }],
      instructions: [{ rawText: 'Original instructions', presentation: 'passage' }],
      credits: [],
      changeSummary: 'Test',
    },
    basedOn: null,
    updatedAt: '2026-10-02T00:00:00Z',
    updatedBy: user,
    metadata: unknownReviewedMetadata(),
    approval: null,
    validationIssues: [],
    photoUrl: null,
  };
  const translation: AdminTranslationSummary = {
    translationId: 'fixture-ar',
    revision: 3,
    source: {
      draftId: draft.draftId,
      revision: 7,
      recipeId: draft.recipeId,
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
      note: 'Fixture',
      reviewerId: user.userId,
      reviewedAt: draft.updatedAt,
      inputRevision: 2,
      binding: 'e'.repeat(64),
      evidence: 'operator_acknowledgement',
    },
    updatedAt: draft.updatedAt,
    updatedBy: user,
  };
  const preparation: AdminPublicationPreparation = {
    status: 'prepared_not_published',
    draftId: draft.draftId,
    draftRevision: 7,
    recipeId: draft.recipeId,
    revisionId: 'authored-fixture',
    contentFingerprint: 'a'.repeat(64),
    publicationFingerprint: 'b'.repeat(64),
    documentBytes: 900,
    permissionScopes: ['recipe_text', 'photo'],
    originalEvidenceRetained: false,
    operationId: 'prepare-fixture',
    retainedAt: draft.updatedAt,
  };
  const saved = new Map<string, string>();
  const keys = ['window', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const old = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: new EventTarget() },
    sessionStorage: {
      configurable: true,
      value: {
        getItem: (k: string) => saved.get(k) ?? null,
        setItem: (k: string, v: string) => saved.set(k, v),
        removeItem: (k: string) => saved.delete(k),
      },
    },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  let view: ReactTestRenderer | undefined;
  t.after(async () => {
    if (view) await act(async () => view!.unmount());
    keys.forEach((k, i) => {
      const descriptor = old[i];
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else Reflect.deleteProperty(globalThis, k);
    });
  });
  const calls: { path: string; method: string }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url),
      method = init?.method ?? 'GET';
    calls.push({ path, method });
    if (path === '/admin/api/session')
      return Response.json({ configured: true, user, csrfToken: 'fixture', expiresAt: null });
    if (path.startsWith('/admin/api/library'))
      return Response.json({
        items: [
          {
            recipeId: draft.recipeId,
            draftId: draft.draftId,
            title: draft.input.title,
            category: 'Pasta',
            cuisine: 'Italian',
            status: 'reviewed',
            revision: 7,
            photoUrl: null,
            updatedAt: null,
            preparation: null,
            publication: null,
          },
        ],
        nextCursor: null,
        publicationStatus: { status: 'ready', head: null },
      });
    if (path === `/admin/api/drafts/${draft.draftId}`) return Response.json(draft);
    if (path === `/admin/api/drafts/${draft.draftId}/translations`)
      return Response.json({ items: [translation] });
    if (path === `/admin/api/drafts/${draft.draftId}/publication-preparation`) {
      const body = JSON.parse(String(init?.body));
      return Response.json(
        body.translations
          ? {
              ...preparation,
              revisionId: 'authored-translated',
              publicationFingerprint: 'f'.repeat(64),
              translations: [
                {
                  translationId: translation.translationId,
                  translationRevision: 3,
                  targetLanguage: 'ar',
                },
              ],
            }
          : preparation,
      );
    }
    if (path === '/admin/api/publication/releases/current')
      return Response.json({ status: 'ready', head: null, manifest: null });
    throw Error(`Unexpected controlled request: ${method} ${path}`);
  };
  t.mock.method(globalThis, 'fetch', fetcher);
  await act(async () => {
    view = create(createElement(App), {
      createNodeMock: (element) =>
        element.type === 'dialog' ? { showModal() {}, close() {} } : null,
    });
  });
  const root = () => view!.root;
  const button = (label: string) =>
    root()
      .findAllByType('button')
      .find((node) => text(node).trim() === label);
  async function click(label: string) {
    const found = button(label);
    assert.ok(found, `Missing ${label}`);
    assert.ok(!found.props.disabled, `Disabled ${label}`);
    await act(async () => found.props.onClick());
  }
  async function settle() {
    for (let i = 0; i < 30; i++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
  }
  await settle();
  await act(async () =>
    root()
      .findAllByType('button')
      .find((node) => node.props.className === 'library-row')!
      .props.onClick(),
  );
  await settle();
  await click('Prepare publication package');
  await click('Review signed release');
  await settle();
  assert.match(text(root()), /Original text only\. No translations/);
  const oldIssue = button('Issue signed release')!.props.onClick;
  await click('Cancel release review');
  await click('Choose reviewed translations');
  await act(async () =>
    root()
      .findAllByType('label')
      .find((node) => text(node) === ' Include ar translation')!
      .findByType('input')
      .props.onChange({ target: { checked: true } }),
  );
  assert.equal(button('Review signed release'), undefined);
  await act(async () => oldIssue());
  assert.equal(calls.filter((c) => c.path === '/admin/api/publication/releases').length, 0);
  await act(async () =>
    root()
      .findAllByType(Field)
      .find((node) => node.props.label === 'Translation permission statement · ar')!
      .findByType('textarea')
      .props.onChange({ target: { value: 'Synthetic test permission only' } }),
  );
  await act(async () =>
    root()
      .findAllByType('label')
      .find(
        (node) =>
          text(node) === ' I have reviewed permission to publish this exact translated version.',
      )!
      .findByType('input')
      .props.onChange({ target: { checked: true } }),
  );
  await click('Prepare publication package');
  await click('Review signed release');
  await settle();
  assert.match(text(root()), /Reviewed translations included: ar · translation revision 3/);
  assert.equal(calls.filter((c) => c.path === '/admin/api/publication/releases').length, 0);
});
