import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { CONTENT_SIGNATURE_SCHEME } from '@cookmate/catalogue/content-trust';
import {
  canonicalContentJson,
  fingerprintContentOverlay,
  type ContentOverlayManifest,
} from '@cookmate/catalogue/content';
import type {
  AdminLibraryItem,
  AdminPublicationIssueRequest,
  AdminPublicationIssueReceipt,
  AdminPublicationReleaseState,
} from '../src/contracts';
import { AdminApi } from './api';
import { archiveSelection, type ArchiveSelection } from './archiveSelection';
import { prepareArchiveIssuanceProposal, issuanceRequestFingerprint } from './issuanceProposal';
import { createIssuanceJournal } from './issuanceJournal';
import { IssuanceReview, type IssuanceReviewProps } from './IssuanceReview';

const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const actor = {
  userId: 'admin-fixture',
  username: 'Test operator',
  role: 'administrator',
} as const;
const ref = {
  recipeId: '52819',
  revisionId: 'published-seven',
  contentFingerprint: 'a'.repeat(64),
};
const item: AdminLibraryItem = {
  recipeId: ref.recipeId,
  draftId: 'draft-one',
  title: 'Newer draft name',
  category: 'Pasta',
  cuisine: 'Italian',
  status: 'draft',
  revision: 8,
  photoUrl: null,
  updatedAt: null,
  preparation: null,
  publication: { state: 'current', releaseId: 'current-one', ref, matchingDraftRevision: 7 },
};
async function release() {
  const manifest: ContentOverlayManifest = {
    formatVersion: 2,
    releaseId: 'current-one',
    sequence: 1,
    previous: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    minimumReaderVersion: 1,
    baseline: { version: 'fixture', fingerprint: 'b'.repeat(64) },
    entries: [
      { state: 'current', ref, publicationFingerprint: 'c'.repeat(64) },
      {
        state: 'archived',
        ref: { recipeId: '52820', revisionId: 'old', contentFingerprint: 'd'.repeat(64) },
        publicationFingerprint: null,
        reason: 'Prior archive',
      },
      { state: 'withdrawn', recipeId: '52821', reason: 'Prior withdrawal' },
    ],
  };
  const head = {
    releaseId: manifest.releaseId,
    sequence: manifest.sequence,
    fingerprint: await fingerprintContentOverlay(manifest, hash),
  };
  return { status: 'ready', head, manifest } as const;
}
async function selected(): Promise<ArchiveSelection> {
  const selection = archiveSelection(item, await release());
  assert.ok(selection);
  return selection;
}
async function receipt(
  request: AdminPublicationIssueRequest,
): Promise<AdminPublicationIssueReceipt> {
  const manifest: ContentOverlayManifest = {
    ...(await release()).manifest,
    releaseId: 'issued-two',
    sequence: request.expectedHead!.sequence + 1,
    previous: request.expectedHead,
    entries: structuredClone(request.entries),
  };
  return {
    status: 'issued_not_activated',
    operationId: request.operationId,
    actorId: actor.userId,
    requestFingerprint: await issuanceRequestFingerprint(request),
    envelope: {
      manifest,
      fingerprint: await fingerprintContentOverlay(manifest, hash),
      signature: { scheme: CONTENT_SIGNATURE_SCHEME, keyId: 'test-key', value: 'e'.repeat(128) },
    },
  };
}

test('archive uses exact published version while latest draft differs, preserving all cumulative members and publication proof', async () => {
  const state = await release(),
    selection = await selected();
  assert.equal(selection.ref.revisionId, 'published-seven');
  assert.equal(selection.matchingDraftRevision, 7);
  assert.equal(selection.latestDraftRevision, 8);
  const request = await prepareArchiveIssuanceProposal(
    state,
    selection,
    'Seasonal menu change',
    'archive-one',
  );
  assert.deepEqual(request.expectedHead, state.head);
  assert.deepEqual(request.entries[0], {
    ...state.manifest.entries[0],
    state: 'archived',
    reason: 'Seasonal menu change',
  });
  assert.deepEqual(request.entries.slice(1), state.manifest.entries.slice(1));
  assert.equal(item.preparation, null, 'draft preparation is not an archive prerequisite');
  assert.equal(Object.isFrozen(selection.ref), true);
});

test('archive rejects stale signed heads, missing/current-ref changes, archived/withdrawn selections and unsupported reasons', async () => {
  const state = await release(),
    selection = await selected();
  await assert.rejects(
    prepareArchiveIssuanceProposal(
      state,
      { ...selection, head: { ...selection.head, fingerprint: 'f'.repeat(64) } },
      'Reason',
      'id',
    ),
    /release changed/,
  );
  await assert.rejects(
    prepareArchiveIssuanceProposal(
      state,
      { ...selection, ref: { ...selection.ref, revisionId: 'new-draft-eight' } },
      'Reason',
      'id',
    ),
    /no longer current/,
  );
  for (const member of state.manifest.entries.slice(1)) {
    const id = member.state === 'withdrawn' ? member.recipeId : member.ref.recipeId;
    await assert.rejects(
      prepareArchiveIssuanceProposal(
        state,
        { ...selection, ref: { ...selection.ref, recipeId: id } },
        'Reason',
        'id',
      ),
      /no longer current/,
    );
  }
  for (const reason of ['', '  ', 'x'.repeat(2001)])
    await assert.rejects(
      prepareArchiveIssuanceProposal(state, selection, reason, 'id'),
      /reason for archiving/,
    );
  await assert.rejects(
    prepareArchiveIssuanceProposal({ status: 'not_configured' }, selection, 'Reason', 'id'),
    /not configured/,
  );
  assert.equal(
    archiveSelection({ ...item, publication: { ...item.publication!, state: 'archived' } }, state),
    null,
  );
  assert.equal(archiveSelection(item, { status: 'not_configured' }), null);
});

test('archive owns exact inputs before asynchronous head hashing', async () => {
  const state = structuredClone(await release()),
    initial = await selected(),
    selection = { ...initial, ref: { ...initial.ref } };
  let start!: () => void, releaseHash!: () => void;
  const started = new Promise<void>((r) => {
      start = r;
    }),
    gate = new Promise<void>((r) => {
      releaseHash = r;
    });
  const result = prepareArchiveIssuanceProposal(
    state,
    selection,
    'Exact reason',
    'owned-id',
    async (text) => {
      start();
      await gate;
      return hash(text);
    },
  );
  await started;
  selection.ref.revisionId = 'caller-mutated';
  state.manifest.entries.splice(1);
  releaseHash();
  const request = await result;
  assert.equal(request.entries.length, 3);
  assert.equal(
    request.entries[0]?.state === 'archived' && request.entries[0].ref.revisionId,
    'published-seven',
  );
});

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
async function uiFixture(
  t: TestContext,
  send: (url: string, init?: RequestInit) => Promise<Response>,
  changes: Partial<IssuanceReviewProps> = {},
  retained = storage(),
) {
  const descriptors = ['sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: retained });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const api = new AdminApi(
    () => {},
    async (url, init) =>
      String(url).endsWith('/session')
        ? Response.json({ configured: true, user: actor, csrfToken: 'test', expiresAt: null })
        : send(String(url), init),
  );
  await api.session();
  let issued = 0,
    focusCount = 0;
  let props: IssuanceReviewProps = {
    api,
    user: actor,
    active: true,
    prepared: null,
    archive: await selected(),
    disabled: false,
    onReauthenticate() {},
    onProtectionChange() {},
    onIssued() {
      issued++;
    },
    ...changes,
  };
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(IssuanceReview, props), {
      createNodeMock: (element) =>
        element.type === 'h2'
          ? {
              focus() {
                focusCount++;
              },
            }
          : null,
    });
  });
  t.after(async () => {
    await act(async () => view.unmount());
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  async function settle() {
    for (let i = 0; i < 1000; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 1));
      });
      const section = view.root.findAllByType('section')[0];
      if (
        !section ||
        (!section.props['aria-busy'] && !text(section).includes('Checking release recovery…'))
      )
        return;
    }
    assert.fail('Archive UI did not settle');
  }
  await settle();
  const button = (label: string) =>
    view.root.findAllByType('button').find((node) => text(node) === label);
  return {
    api,
    retained,
    view,
    button,
    text: () => text(view.root),
    issued: () => issued,
    focused: () => focusCount,
    async click(label: string) {
      const control = button(label);
      assert.ok(control, label);
      await act(async () => control.props.onClick());
      await settle();
    },
    async reason(value: string) {
      await act(async () => view.root.findByType('textarea').props.onChange({ target: { value } }));
    },
    async update(next: Partial<IssuanceReviewProps>) {
      props = { ...props, ...next };
      await act(async () => view.update(createElement(IssuanceReview, props)));
      await settle();
    },
  };
}

test('archive UI reviews then issues exact cumulative request and reports only signed issuance', async (t) => {
  let reads = 0,
    writes = 0;
  const state = await release();
  const f = await uiFixture(t, async (url, init) => {
    if (url.endsWith('/current')) {
      reads++;
      return Response.json(state);
    }
    writes++;
    const pending = await createIssuanceJournal(f.retained).read();
    assert.ok(pending);
    assert.deepEqual(JSON.parse(String(init?.body)), pending.request);
    assert.equal(pending.request.entries[0]?.state, 'archived');
    return Response.json(await receipt(pending.request));
  });
  assert.equal(f.button('Review archive release')?.props.disabled, true);
  assert.match(f.text(), /published draft revision 7/);
  assert.match(f.text(), /latest draft revision 8/);
  await f.reason('Out of the seasonal menu');
  await f.click('Review archive release');
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.match(f.text(), /Release sequence 2/);
  await f.click('Issue signed release');
  assert.equal(writes, 1);
  assert.equal(f.issued(), 1);
  assert.equal(await createIssuanceJournal(f.retained).read(), null);
  assert.match(f.text(), /Not activated/);
});

test('archive selection handoff focuses heading; stale library head fails without a write', async (t) => {
  let writes = 0;
  const state = await release();
  const next: ContentOverlayManifest = {
    ...state.manifest,
    releaseId: 'changed-two',
    sequence: 2,
    previous: state.head,
  };
  const current: AdminPublicationReleaseState = {
    status: 'ready',
    manifest: next,
    head: {
      releaseId: next.releaseId,
      sequence: 2,
      fingerprint: await fingerprintContentOverlay(next, hash),
    },
  };
  const f = await uiFixture(
    t,
    async (_url, init) => {
      if (init?.method === 'POST') writes++;
      return Response.json(current);
    },
    { archive: null },
  );
  await f.update({ archive: await selected() });
  assert.equal(f.focused(), 1);
  await f.reason('Reason');
  await f.click('Review archive release');
  assert.match(f.text(), /Refresh the library/);
  assert.equal(f.button('Issue signed release'), undefined);
  assert.equal(writes, 0);
});

test('archive roles, blocked state and retained issue callbacks cannot bypass current selection or session', async (t) => {
  let calls = 0;
  const state = await release();
  const f = await uiFixture(
    t,
    async () => {
      calls++;
      return Response.json(state);
    },
    { user: { ...actor, role: 'reviewer' } },
  );
  assert.equal(f.text(), '');
  assert.equal(calls, 0);
  await f.update({ user: actor });
  await f.reason('Reason');
  await f.click('Review archive release');
  const send = f.button('Issue signed release')!.props.onClick;
  await f.update({ archive: { ...(await selected()), ref: { ...ref, revisionId: 'different' } } });
  await act(async () => send());
  assert.equal(calls, 1);
  await f.update({ active: false });
  await act(async () => send());
  assert.equal(calls, 1);
});

test('archive head-race stays journalled; exact cancellation releases it without changing membership', async (t) => {
  const state = await release();
  const f = await uiFixture(t, async (url, init) => {
    if (url.endsWith('/current')) return Response.json(state);
    const pending = await createIssuanceJournal(f.retained).read();
    assert.ok(pending);
    if (url.endsWith('/resolve')) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        requestFingerprint: pending.requestFingerprint,
      });
      return Response.json({
        status: 'cancelled',
        operationId: pending.request.operationId,
        actorId: actor.userId,
        requestFingerprint: pending.requestFingerprint,
      });
    }
    return Response.json(
      { error: { code: 'release_head_changed', message: 'Review current release.' } },
      { status: 409 },
    );
  });
  await f.reason('Reason');
  await f.click('Review archive release');
  await f.click('Issue signed release');
  assert.ok(await createIssuanceJournal(f.retained).read());
  await f.click('Resolve unconfirmed release');
  await f.click('Confirm release resolution');
  assert.equal(await createIssuanceJournal(f.retained).read(), null);
  assert.equal(f.issued(), 0);
  assert.match(f.text(), /Release request cancelled/);
});

test('reload recovers an uncertain archive request with same operation, exact reason and payload without selected draft', async (t) => {
  const state = await release(),
    request = await prepareArchiveIssuanceProposal(
      state,
      await selected(),
      'Exact saved archive reason',
      'retained-archive',
    );
  const retained = storage();
  const pending = {
    version: 1 as const,
    actorId: actor.userId,
    recipeTitle: item.title,
    request,
    requestFingerprint: await issuanceRequestFingerprint(request),
  };
  await createIssuanceJournal(retained).remember(pending);
  const f = await uiFixture(
    t,
    async (_url, init) => {
      if (init?.method !== 'POST')
        return Response.json(
          { error: { code: 'issuance_unknown', message: 'No receipt yet.' } },
          { status: 404 },
        );
      assert.equal(
        canonicalContentJson(JSON.parse(String(init.body))),
        canonicalContentJson(request),
      );
      return Response.json(await receipt(request));
    },
    { archive: null },
    retained,
  );
  await f.click('Check release receipt');
  assert.deepEqual(await createIssuanceJournal(retained).read(), pending);
  await f.click('Retry exact release request');
  assert.equal(await createIssuanceJournal(retained).read(), null);
  assert.equal(f.issued(), 1);
});
