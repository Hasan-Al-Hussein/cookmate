import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { AdminLibrary, AdminLibraryItem } from '../src/contracts';
import { AdminApi, ApiError, type LibraryStatus } from './api';
import { Library } from './Library';
import type { ArchiveSelection } from './archiveSelection';

const item: AdminLibraryItem = {
  recipeId: '1000000',
  draftId: 'fixture-draft',
  title: 'Fixture recipe',
  category: 'Pasta',
  cuisine: 'Italian',
  status: 'draft',
  revision: 8,
  photoUrl: null,
  updatedAt: null,
  preparation: null,
  publication: {
    state: 'current',
    releaseId: 'fixture-release',
    matchingDraftRevision: 7,
    ref: { recipeId: '1000000', revisionId: 'fixture-seven', contentFingerprint: 'a'.repeat(64) },
  },
};
const text = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(text).join('');
async function render(
  t: TestContext,
  pages: (AdminLibrary | Error)[],
  changes: Partial<ComponentProps<typeof Library>> = {},
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  let ui!: ReactTestRenderer;
  t.after(async () => {
    await act(async () => ui?.unmount());
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const api = new AdminApi(() => {});
  const calls: { status: LibraryStatus; cursor: string | undefined }[] = [];
  t.mock.method(api, 'library', async (_query: string, status: LibraryStatus, cursor?: string) => {
    calls.push({ status, cursor });
    const page = pages[calls.length - 1]!;
    if (page instanceof Error) throw page;
    return page;
  });
  const opened: AdminLibraryItem[] = [];
  const statuses: LibraryStatus[] = [];
  const archived: ArchiveSelection[] = [];
  let props: ComponentProps<typeof Library> = {
    api,
    status: 'published',
    refresh: 0,
    blocked: false,
    active: true,
    onStatus(value) {
      statuses.push(value);
    },
    onOpen(value) {
      opened.push(value);
    },
    onCreate() {},
    onArchive(value) {
      archived.push(value);
    },
    ...changes,
  };
  await act(async () => {
    ui = create(createElement(Library, props));
  });
  return {
    ui,
    calls,
    opened,
    statuses,
    archived,
    async update(next: Partial<ComponentProps<typeof Library>>) {
      props = { ...props, ...next };
      await act(async () => ui.update(createElement(Library, props)));
    },
  };
}
test('library distinguishes the released revision from the latest draft and keeps release availability across paging', async (t) => {
  const publicationStatus = {
    status: 'ready' as const,
    head: { releaseId: 'fixture-release', sequence: 1, fingerprint: 'b'.repeat(64) },
  };
  const second = {
    ...item,
    recipeId: '1000001',
    draftId: 'fixture-two',
    publication: null,
    preparation: { draftRevision: 8, packageCount: 2 },
  };
  const { ui, calls, opened } = await render(t, [
    { items: [item], nextCursor: 'fixture-cursor', publicationStatus },
    { items: [second], nextCursor: null, publicationStatus },
  ]);
  assert.match(
    text(ui.root),
    /Published revision 7 in signed release; latest draft revision 8 is not published/,
  );
  assert.match(text(ui.root), /do not confirm that any device has adopted it/);
  const row = ui.root
    .findAllByType('button')
    .find((button) => button.props.className === 'library-row')!;
  await act(async () => row.props.onClick());
  assert.equal(opened[0], item); // Row opens the exact latest-draft item, not a fabricated release editor.
  const load = ui.root
    .findAllByType('button')
    .find((button) => text(button) === 'Load more recipes')!;
  await act(async () => load.props.onClick());
  assert.deepEqual(calls, [
    { status: 'published', cursor: undefined },
    { status: 'published', cursor: 'fixture-cursor' },
  ]);
  assert.match(text(ui.root), /Prepared revision 8 · 2 verified packages/);
  assert.match(text(ui.root), /do not confirm that any device has adopted it/);
  assert.equal(
    ui.root.findAllByType('option').some((option) => option.props.value === 'archived'),
    true,
  );
});
test('library shows unavailable signed status without falsely labelling drafts published', async (t) => {
  const { ui } = await render(t, [
    {
      items: [{ ...item, publication: null }],
      nextCursor: null,
      publicationStatus: { status: 'not_configured' },
    },
  ]);
  assert.match(
    text(ui.root),
    /Signed release status is unavailable: release signing is not configured/,
  );
  assert.equal(text(ui.root).includes('Published revision'), false);
  assert.match(text(ui.root), /Open latest draft/);
});

test('unconfigured publication directs to drafts instead of suggesting refresh can configure signing', async (t) => {
  const { ui, statuses, calls } = await render(t, [
    new ApiError(503, 'publication_not_configured', 'Signing is not configured.'),
  ]);
  assert.match(text(ui.root), /Signed releases not configured/);
  assert.equal(text(ui.root).includes('Refresh library'), false);
  const drafts = ui.root.findAllByType('button').find((button) => text(button) === 'View drafts')!;
  await act(async () => drafts.props.onClick());
  assert.deepEqual(statuses, ['draft']);
  assert.equal(calls.length, 1);
});

test('administrator archive action selects published ref and head independently of newer unprepared draft', async (t) => {
  const publicationStatus = {
    status: 'ready' as const,
    head: { releaseId: 'fixture-release', sequence: 1, fingerprint: 'b'.repeat(64) },
  };
  const f = await render(t, [{ items: [item], nextCursor: null, publicationStatus }], {
    user: { userId: 'admin-one', username: 'Operator', role: 'administrator' },
  });
  const action = f.ui.root
    .findAllByType('button')
    .find((button) => text(button) === 'Archive published version')!;
  assert.ok(action);
  const invokeArchive = action.props.onClick;
  for (let parent = action.parent; parent; parent = parent.parent)
    assert.notEqual(parent.type, 'button', 'archive is not nested in the draft row control');
  await act(async () => invokeArchive());
  assert.equal(f.opened.length, 0);
  assert.deepEqual(f.archived[0], {
    title: item.title,
    ref: item.publication!.ref,
    head: publicationStatus.head,
    matchingDraftRevision: 7,
    latestDraftRevision: 8,
  });
  assert.equal(f.calls.length, 1, 'selection never prepares a draft or issues a release');
  await f.update({ blocked: true });
  await act(async () => invokeArchive());
  assert.equal(f.archived.length, 1);
  await f.update({
    blocked: false,
    user: { userId: 'reviewer-one', username: 'Reviewer', role: 'reviewer' },
  });
  await act(async () => invokeArchive());
  assert.equal(f.archived.length, 1);
  assert.equal(
    f.ui.root
      .findAllByType('button')
      .some((button) => text(button) === 'Archive published version'),
    false,
  );
});

test('archived and withdrawn library rows never offer archive action', async (t) => {
  const archived = { ...item, publication: { ...item.publication!, state: 'archived' as const } };
  const withdrawn = {
    ...item,
    recipeId: '1000001',
    draftId: 'second',
    publication: { ...item.publication!, state: 'withdrawn' as const, ref: null },
  };
  const f = await render(
    t,
    [
      {
        items: [archived, withdrawn],
        nextCursor: null,
        publicationStatus: {
          status: 'ready',
          head: { releaseId: 'fixture-release', sequence: 1, fingerprint: 'b'.repeat(64) },
        },
      },
    ],
    { user: { userId: 'admin-one', username: 'Operator', role: 'administrator' } },
  );
  assert.equal(
    f.ui.root
      .findAllByType('button')
      .some((button) => text(button) === 'Archive published version'),
    false,
  );
});
