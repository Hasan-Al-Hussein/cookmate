import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { CONTENT_SIGNATURE_SCHEME } from '@cookmate/catalogue/content-trust';
import {
  fingerprintContentOverlay,
  type ContentOverlayManifest,
  type OverlayEntry,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import type {
  AdminPublicationIssueRequest,
  AdminPublicationReleaseState,
  AdminUser,
  AdminLibrary,
} from '../src/contracts';
import { AdminApi } from './api';
import { Library } from './Library';
import { IssuanceReview, type IssuanceReviewProps } from './IssuanceReview';
import { issuanceHash, issuanceRequestFingerprint } from './issuanceProposal';
import { createIssuanceJournal } from './issuanceJournal';
import {
  prepareRollbackIssuanceProposal,
  readIssuedRollbackPage,
  rollbackReleaseState,
  type RollbackSelection,
} from './rollbackIssuance';

const actor: AdminUser = { userId: 'operator', username: 'operator', role: 'administrator' };
const oldRef = { recipeId: '53262', revisionId: 'issued-old', contentFingerprint: 'a'.repeat(64) };
const newRef = { ...oldRef, revisionId: 'issued-new', contentFingerprint: 'b'.repeat(64) };
const oldEntry: OverlayEntry = {
  state: 'current',
  ref: oldRef,
  publicationFingerprint: 'c'.repeat(64),
};
const newEntry: OverlayEntry = {
  state: 'current',
  ref: newRef,
  publicationFingerprint: 'd'.repeat(64),
};
const others: OverlayEntry[] = [
  {
    state: 'archived',
    ref: { ...oldRef, recipeId: '52821' },
    publicationFingerprint: 'e'.repeat(64),
    reason: 'Keep archived',
  },
  { state: 'withdrawn', recipeId: '52771', reason: 'Keep withdrawn' },
];
// UI fixtures use a controlled authenticated response, not a real signature proof.
async function envelope(sequence: number, previous: OverlayHead | null, entries: OverlayEntry[]) {
  const manifest: ContentOverlayManifest = {
    formatVersion: 2,
    releaseId: `release-${sequence}`,
    sequence,
    previous,
    createdAt: '2026-10-02T00:00:00.000Z',
    minimumReaderVersion: 1,
    baseline: { version: 'test', fingerprint: '0'.repeat(64) },
    entries,
  };
  const fingerprint = await fingerprintContentOverlay(manifest, issuanceHash);
  return {
    manifest,
    fingerprint,
    signature: { keyId: 'test', scheme: CONTENT_SIGNATURE_SCHEME, value: '1'.repeat(128) },
  };
}
async function history() {
  const prior = await envelope(1, null, [oldEntry, ...others]);
  const priorHead = {
    releaseId: prior.manifest.releaseId,
    sequence: 1,
    fingerprint: prior.fingerprint,
  };
  const current = await envelope(2, priorHead, [newEntry, ...others]);
  const head = {
    releaseId: current.manifest.releaseId,
    sequence: 2,
    fingerprint: current.fingerprint,
  };
  const state: AdminPublicationReleaseState = { status: 'ready', head, manifest: current.manifest };
  const selection: RollbackSelection = {
    title: 'Library label',
    ref: newRef,
    head,
    latestDraftRevision: 9,
    matchingDraftRevision: 7,
  };
  const pkg = {
    formatVersion: 1,
    status: 'issued_export_not_adopted',
    envelope: prior,
    publications: [],
    media: [],
  };
  return { prior, priorHead, current, head, state, selection, pkg };
}
async function receipt(request: AdminPublicationIssueRequest) {
  return {
    status: 'issued_not_activated',
    actorId: actor.userId,
    operationId: request.operationId,
    requestFingerprint: await issuanceRequestFingerprint(request),
    envelope: await envelope(
      (request.expectedHead?.sequence ?? 0) + 1,
      request.expectedHead,
      request.entries,
    ),
  };
}
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
async function ui(
  t: TestContext,
  send: (path: string, init?: RequestInit) => Promise<Response>,
  changes: Partial<IssuanceReviewProps> = {},
  retained = storage(),
) {
  const h = await history();
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
  let props: IssuanceReviewProps = {
    api,
    user: actor,
    active: true,
    prepared: null,
    rollback: h.selection,
    disabled: false,
    onReauthenticate() {},
    onProtectionChange() {},
    ...changes,
  };
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(IssuanceReview, props));
  });
  t.after(async () => {
    await act(async () => view.unmount());
    for (const [key, value] of descriptors) {
      if (value) Object.defineProperty(globalThis, key, value);
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
    assert.fail('Rollback UI did not settle');
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
    settle,
    async click(label: string) {
      const control = button(label);
      assert.ok(control, label);
      await act(async () => control.props.onClick());
      await settle();
    },
    async update(next: Partial<IssuanceReviewProps>) {
      props = { ...props, ...next };
      await act(async () => view.update(createElement(IssuanceReview, props)));
    },
    async reload(next: Partial<IssuanceReviewProps>) {
      props = { ...props, ...next };
      await act(async () => {
        view.unmount();
      });
      await act(async () => {
        view = create(createElement(IssuanceReview, props));
      });
      await settle();
    },
  };
}

test('rollback selects only an exact issued ancestor and preserves every unrelated cumulative entry', async () => {
  const h = await history();
  const page = await readIssuedRollbackPage(h.pkg, h.priorHead, h.selection);
  assert.ok(page.choice);
  assert.equal(Object.isFrozen(page.choice.entry.ref), true);
  assert.equal(page.previous, null);
  assert.deepEqual(Object.keys(page.choice).sort(), ['entry', 'selection', 'sourceHead']);
  const request = await prepareRollbackIssuanceProposal(h.state, page.choice, 'rollback-operation');
  assert.deepEqual(request, {
    operationId: 'rollback-operation',
    expectedHead: h.head,
    entries: [oldEntry, ...others],
  });
  await assert.rejects(
    prepareRollbackIssuanceProposal(h.state, { ...page.choice }, 'forged'),
    /verified earlier/,
  );
});

test('wrong release identity, fingerprint, malformed response and current-head package fail closed', async () => {
  const h = await history();
  for (const pkg of [
    { ...h.pkg, status: 'prepared_not_published' },
    { ...h.pkg, envelope: h.current },
    { ...h.pkg, envelope: { ...h.prior, fingerprint: 'f'.repeat(64) } },
    { ...h.pkg, envelope: { ...h.prior, manifest: { ...h.prior.manifest, entries: [newEntry] } } },
  ])
    await assert.rejects(readIssuedRollbackPage(pkg, h.priorHead, h.selection));
  await assert.rejects(readIssuedRollbackPage(h.pkg, h.head, h.selection));
});

test('changed latest head or withdrawal rejects rollback; same current version is not a new choice', async () => {
  const h = await history();
  const page = await readIssuedRollbackPage(h.pkg, h.priorHead, h.selection);
  assert.ok(page.choice);
  const changed = await envelope(3, h.head, [newEntry, ...others]);
  await assert.rejects(
    prepareRollbackIssuanceProposal(
      {
        status: 'ready',
        head: {
          releaseId: changed.manifest.releaseId,
          sequence: 3,
          fingerprint: changed.fingerprint,
        },
        manifest: changed.manifest,
      },
      page.choice,
      'stale',
    ),
    /changed/,
  );
  const withdrawal = await envelope(2, h.priorHead, [
    { state: 'withdrawn', recipeId: oldRef.recipeId, reason: 'Withdrawn' },
    ...others,
  ]);
  await assert.rejects(
    rollbackReleaseState(
      {
        status: 'ready',
        head: { ...h.head, fingerprint: withdrawal.fingerprint },
        manifest: withdrawal.manifest,
      },
      h.selection,
    ),
    /changed/,
  );
  const same = await envelope(1, null, [newEntry, ...others]);
  const sameHead = {
    releaseId: same.manifest.releaseId,
    sequence: 1,
    fingerprint: same.fingerprint,
  };
  const samePage = await readIssuedRollbackPage(
    { ...h.pkg, envelope: same },
    sameHead,
    h.selection,
  );
  assert.ok(samePage.choice);
  await assert.rejects(
    prepareRollbackIssuanceProposal(h.state, samePage.choice, 'same'),
    /already current/,
  );
});

test('a withdrawn historical member has no choice; input mutation during hashing cannot change selected version', async () => {
  const h = await history();
  const withdrawal = await envelope(1, null, [
    { state: 'withdrawn', recipeId: oldRef.recipeId, reason: 'Old withdrawal' },
  ]);
  const head = {
    releaseId: withdrawal.manifest.releaseId,
    sequence: 1,
    fingerprint: withdrawal.fingerprint,
  };
  assert.equal(
    (await readIssuedRollbackPage({ ...h.pkg, envelope: withdrawal }, head, h.selection)).choice,
    null,
  );
  const mutable = structuredClone(h.pkg);
  const selected = { ...h.selection, ref: { ...h.selection.ref } };
  const page = await readIssuedRollbackPage(mutable, h.priorHead, selected, async (value) => {
    mutable.envelope.manifest.entries = [newEntry];
    selected.ref = oldRef;
    return issuanceHash(value);
  });
  assert.deepEqual(page.choice?.entry, oldEntry);
  assert.deepEqual(page.choice?.selection.ref, newRef);
});

test('rollback UI fetches one ancestor, reviews explicitly, cancels without write, then journals exact issuance', async (t) => {
  const h = await history();
  let packages = 0,
    writes = 0;
  const f = await ui(t, async (path, init) => {
    if (path.endsWith('/current')) return Response.json(h.state);
    if (path.endsWith('/package')) {
      packages++;
      assert.ok(path.endsWith('/release-1/package'));
      return Response.json(h.pkg);
    }
    writes++;
    const pending = await createIssuanceJournal(f.retained).read();
    assert.ok(pending);
    assert.equal(init?.body, JSON.stringify(pending.request));
    assert.deepEqual(pending.request.entries, [oldEntry, ...others]);
    return Response.json(await receipt(pending.request));
  });
  assert.equal(packages, 0);
  await f.click('Check earlier release');
  assert.equal(packages, 1);
  assert.equal(writes, 0);
  assert.match(f.text(), /issued-old/);
  assert.equal(f.button('Check earlier release'), undefined);
  await f.click('Review rollback release');
  assert.match(f.text(), /Saved drafts, rights reviews and approvals are not restored/);
  await f.click('Cancel release review');
  assert.equal(writes, 0);
  await f.click('Review rollback release');
  await f.click('Issue signed release');
  assert.equal(writes, 1);
  assert.match(f.text(), /Signed release issued · Not activated/);
  assert.equal(await createIssuanceJournal(f.retained).read(), null);
});

test('a latest-head race during historical read prevents presenting a rollback choice', async (t) => {
  const h = await history();
  let reads = 0,
    writes = 0;
  const next = await envelope(3, h.head, [newEntry, ...others]);
  const f = await ui(t, async (path) => {
    if (path.endsWith('/current'))
      return Response.json(
        ++reads === 1
          ? h.state
          : {
              status: 'ready',
              head: {
                releaseId: next.manifest.releaseId,
                sequence: 3,
                fingerprint: next.fingerprint,
              },
              manifest: next.manifest,
            },
      );
    if (path.endsWith('/package')) return Response.json(h.pkg);
    writes++;
    throw new Error('Unexpected write');
  });
  await f.click('Check earlier release');
  assert.match(f.text(), /signed recipe or release changed/);
  assert.equal(f.button('Review rollback release'), undefined);
  assert.equal(writes, 0);
});

test('owner/session replacement and retained review callbacks cannot dispatch earlier selected rollback', async (t) => {
  const h = await history();
  let writes = 0;
  const f = await ui(t, async (path) => {
    if (path.endsWith('/current')) return Response.json(h.state);
    if (path.endsWith('/package')) return Response.json(h.pkg);
    writes++;
    throw new Error('Unexpected write');
  });
  await f.click('Check earlier release');
  await f.click('Review rollback release');
  const old = f.button('Issue signed release')!.props.onClick;
  await f.update({ rollback: { ...h.selection } });
  await act(async () => old());
  await f.settle();
  assert.equal(writes, 0);
  await f.click('Check earlier release');
  await f.click('Review rollback release');
  const expired = f.button('Issue signed release')!.props.onClick;
  await f.api.session();
  await act(async () => expired());
  await f.settle();
  assert.equal(writes, 0);
  await f.update({ user: { ...actor, userId: 'other' } });
  assert.equal(f.button('Issue signed release'), undefined);
});

test('lost rollback acknowledgement retains original request and reload recovers without a selected package', async (t) => {
  const h = await history();
  const retained = storage();
  let sent: AdminPublicationIssueRequest | null = null;
  const f = await ui(
    t,
    async (path, init) => {
      if (path.endsWith('/current')) return Response.json(h.state);
      if (path.endsWith('/package')) return Response.json(h.pkg);
      if (path.includes('/operations/')) {
        const pending = await createIssuanceJournal(retained).read();
        assert.ok(pending);
        assert.ok(
          path.includes(
            `/operations/${pending.request.operationId}?requestFingerprint=${pending.requestFingerprint}`,
          ),
        );
        return Response.json(await receipt(pending.request));
      }
      sent = JSON.parse(String(init?.body)) as AdminPublicationIssueRequest;
      throw new Error('Controlled lost acknowledgement');
    },
    {},
    retained,
  );
  await f.click('Check earlier release');
  await f.click('Review rollback release');
  await f.click('Issue signed release');
  const pending = await createIssuanceJournal(retained).read();
  assert.ok(pending);
  assert.deepEqual(pending.request, sent);
  await f.reload({ rollback: null });
  await f.click('Check release receipt');
  assert.equal(await createIssuanceJournal(retained).read(), null);
  assert.match(f.text(), /Signed release issued · Not activated/);
});

test('reauthentication invalidates a retained historical-choice review callback before another read', async (t) => {
  const h = await history();
  let reads = 0;
  const f = await ui(t, async (path) => {
    reads++;
    return Response.json(path.endsWith('/current') ? h.state : h.pkg);
  });
  await f.click('Check earlier release');
  const review = f.button('Review rollback release')!.props.onClick;
  const before = reads;
  await f.api.session();
  await act(async () => review());
  await f.settle();
  assert.equal(reads, before);
  assert.equal(f.button('Issue signed release'), undefined);
});

test('the first signed release has no historical choice and does not request a package', async (t) => {
  const h = await history();
  let calls = 0;
  const f = await ui(
    t,
    async (path) => {
      calls++;
      assert.ok(path.endsWith('/current'));
      return Response.json({ status: 'ready', head: h.priorHead, manifest: h.prior.manifest });
    },
    { rollback: { ...h.selection, ref: oldRef, head: h.priorHead } },
  );
  await f.click('Check earlier release');
  assert.equal(calls, 1);
  assert.match(f.text(), /No earlier signed releases remain/);
  assert.equal(f.button('Check earlier release'), undefined);
});

test('library offers rollback for published and archived identities, not withdrawn, and revokes retained role callbacks', async (t) => {
  const h = await history();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const api = new AdminApi(() => {});
  const page: AdminLibrary = {
    nextCursor: null,
    publicationStatus: { status: 'ready', head: h.head },
    items: ['current', 'archived', 'withdrawn'].map((state, index) => ({
      recipeId: String(53262 + index),
      draftId: null,
      title: state,
      category: '',
      cuisine: '',
      status: 'bundled',
      revision: null,
      photoUrl: null,
      updatedAt: null,
      preparation: null,
      publication: {
        state: state as 'current' | 'archived' | 'withdrawn',
        releaseId: h.head.releaseId,
        matchingDraftRevision: null,
        ref: state === 'withdrawn' ? null : { ...newRef, recipeId: String(53262 + index) },
      },
    })),
  };
  t.mock.method(api, 'library', async () => page);
  const selected: RollbackSelection[] = [];
  let props: ComponentProps<typeof Library> = {
    api,
    active: true,
    blocked: false,
    refresh: 0,
    status: 'all',
    user: actor,
    onStatus() {},
    onOpen() {},
    onCreate() {},
    onRollback: (value) => selected.push(value),
  };
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(Library, props));
  });
  t.after(async () => {
    await act(async () => view.unmount());
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  });
  const controls = view.root
    .findAllByType('button')
    .filter((node) => text(node) === 'Review earlier issued version');
  assert.equal(controls.length, 2);
  await act(async () => controls[1]!.props.onClick());
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.title, 'archived');
  const retained = controls[0]!.props.onClick;
  props = { ...props, user: { ...actor, role: 'editor' } };
  await act(async () => view.update(createElement(Library, props)));
  await act(async () => retained());
  assert.equal(selected.length, 1);
});
