import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import {
  canonicalContentJson,
  fingerprintContentOverlay,
  type ContentOverlayManifest,
} from '@cookmate/catalogue/content';
import { CONTENT_SIGNATURE_SCHEME } from '@cookmate/catalogue/content-trust';
import type {
  AdminPublicationPreparation,
  AdminPublicationIssueRequest,
  AdminPublicationIssueReceipt,
} from '../src/contracts';
import { AdminApi } from './api';
import { createIssuanceJournal, type PendingIssuance } from './issuanceJournal';
import {
  issuanceRequestFingerprint,
  prepareIssuanceProposal,
  validateIssuanceReceipt,
} from './issuanceProposal';
import { IssuanceReview, type IssuanceReviewProps } from './IssuanceReview';

const preparation: AdminPublicationPreparation = {
  status: 'prepared_not_published',
  draftId: 'draft-fixture',
  draftRevision: 7,
  recipeId: '52819',
  revisionId: 'authored-fixture',
  contentFingerprint: 'a'.repeat(64),
  publicationFingerprint: 'b'.repeat(64),
  documentBytes: 4034,
  permissionScopes: ['recipe_text', 'photo'],
  originalEvidenceRetained: true,
  operationId: 'prepare-fixture',
  retainedAt: '2026-10-01T00:00:00.000Z',
};
const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const ready = { status: 'ready', head: null, manifest: null } as const;
const actor = {
  userId: 'admin-fixture',
  username: 'Test operator',
  role: 'administrator',
} as const;
const prepared = { preparation, title: 'Example recipe' };
async function request() {
  return prepareIssuanceProposal(ready, preparation, 'test-operation');
}
async function pending(): Promise<PendingIssuance> {
  const value = await request();
  return {
    version: 1,
    actorId: actor.userId,
    recipeTitle: prepared.title,
    request: value,
    requestFingerprint: await issuanceRequestFingerprint(value),
  };
}
async function receipt(input: AdminPublicationIssueRequest): Promise<AdminPublicationIssueReceipt> {
  const manifest: ContentOverlayManifest = {
    formatVersion: 2,
    releaseId: 'issued-fixture',
    sequence: (input.expectedHead?.sequence ?? 0) + 1,
    previous: input.expectedHead,
    createdAt: '2026-10-01T00:00:00.000Z',
    minimumReaderVersion: 1,
    baseline: { version: 'fixture', fingerprint: 'c'.repeat(64) },
    entries: structuredClone(input.entries),
  };
  return {
    status: 'issued_not_activated',
    operationId: input.operationId,
    actorId: actor.userId,
    requestFingerprint: await issuanceRequestFingerprint(input),
    envelope: {
      manifest,
      fingerprint: await fingerprintContentOverlay(manifest, hash),
      // Structural receipt fixture. Cryptographic signature verification belongs to the server/client tests.
      signature: { keyId: 'fixture.key', scheme: CONTENT_SIGNATURE_SCHEME, value: 'd'.repeat(128) },
    },
  };
}
function memoryStorage() {
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
test('proposal preserves cumulative current, archived and withdrawn entries and replaces only its recipe', async () => {
  const initial = await receipt(await request());
  const manifest = initial.envelope.manifest;
  manifest.entries.push(
    {
      state: 'archived',
      ref: { recipeId: '52820', revisionId: 'known', contentFingerprint: 'e'.repeat(64) },
      publicationFingerprint: null,
      reason: 'Prior archive',
    },
    { state: 'withdrawn', recipeId: '52821', reason: 'Prior withdrawal' },
  );
  const state = {
    status: 'ready' as const,
    manifest,
    head: {
      releaseId: manifest.releaseId,
      sequence: 1,
      fingerprint: await fingerprintContentOverlay(manifest, hash),
    },
  };
  const next = await prepareIssuanceProposal(
    state,
    { ...preparation, revisionId: 'new-revision' },
    'new-operation',
  );
  assert.deepEqual(next.entries.slice(1), manifest.entries.slice(1));
  assert.equal(next.entries.length, 3);
  assert.equal(
    next.entries[0]?.state === 'current' && next.entries[0].ref.revisionId,
    'new-revision',
  );
  await assert.rejects(
    prepareIssuanceProposal(state, { ...preparation, recipeId: '52821' }, 'other-operation'),
    /withdrawn/,
  );
  await assert.rejects(
    prepareIssuanceProposal(
      { ...state, head: { ...state.head, fingerprint: 'f'.repeat(64) } },
      preparation,
      'other-operation',
    ),
    /could not be verified/,
  );
});
test('browser request digest matches the exact server domain and rejects altered receipt membership', async () => {
  const input = await request();
  const digest = await issuanceRequestFingerprint(input);
  assert.equal(
    digest,
    await hash(
      canonicalContentJson([
        'cookmate-issue-overlay-v2',
        { expectedHead: input.expectedHead, entries: input.entries },
      ]),
    ),
  );
  const result = await receipt(input);
  assert.equal(
    (await validateIssuanceReceipt(result, actor.userId, input, digest)).status,
    'issued_not_activated',
  );
  await assert.rejects(validateIssuanceReceipt(result, 'other-admin', input, digest));
  const wrong = structuredClone(result);
  wrong.envelope.manifest.entries = [];
  wrong.envelope.fingerprint = await fingerprintContentOverlay(wrong.envelope.manifest, hash);
  await assert.rejects(
    validateIssuanceReceipt(wrong, actor.userId, input, digest),
    /does not match/,
  );
});
test('journal preserves exact request across reload, refuses replacement and detects tampering/storage failure', async () => {
  const storage = memoryStorage();
  const first = await pending();
  await createIssuanceJournal(storage).remember(first);
  assert.deepEqual(await createIssuanceJournal(storage).read(), first);
  await assert.rejects(
    createIssuanceJournal(storage).remember({ ...first, actorId: 'other' }),
    /earlier release/,
  );
  const key = [...storage.values.keys()][0]!;
  storage.values.set(key, JSON.stringify({ ...first, requestFingerprint: 'e'.repeat(64) }));
  await assert.rejects(createIssuanceJournal(storage).read(), /invalid/);
  const unavailable = {
    ...memoryStorage(),
    setItem() {
      throw new Error('storage full');
    },
  };
  await assert.rejects(createIssuanceJournal(unavailable).remember(first), /storage full/);
});

const contents = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : contents(child))).join('');
async function fixture(
  t: TestContext,
  send: (url: string, init?: RequestInit) => Promise<Response>,
  storage = memoryStorage(),
  changes: Partial<IssuanceReviewProps> = {},
) {
  const descriptors = ['sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  const api = new AdminApi(
    () => {},
    async (url, init) =>
      String(url).endsWith('/session')
        ? Response.json({ configured: true, user: actor, csrfToken: 'test-token', expiresAt: null })
        : send(String(url), init),
  );
  await api.session();
  let props: IssuanceReviewProps = {
    api,
    user: actor,
    active: true,
    prepared,
    disabled: false,
    onReauthenticate() {},
    onProtectionChange() {},
    ...changes,
  };
  let view: ReactTestRenderer;
  const focusedHeadings: string[] = [];
  await act(async () => {
    view = create(createElement(IssuanceReview, props), {
      createNodeMock: (element) =>
        element.type === 'h2'
          ? {
              focus: () =>
                focusedHeadings.push(String((element.props as { children?: unknown }).children)),
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
    for (let count = 0; count < 1000; count++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
      const section = view.root.findAllByType('section')[0];
      if (
        !section ||
        (!section.props['aria-busy'] && !contents(section).includes('Checking release recovery…'))
      )
        return;
    }
    assert.fail('Issuance UI did not settle');
  }
  await settle();
  return {
    api,
    storage,
    focusedHeadings,
    text: () => contents(view.root),
    button: (label: string) =>
      view.root.findAllByType('button').find((item) => contents(item) === label),
    async click(label: string, wait = true) {
      const button = this.button(label);
      assert.ok(button, `Missing ${label}`);
      await act(async () => {
        button.props.onClick();
      });
      if (wait) await settle();
    },
    async update(next: Partial<IssuanceReviewProps>) {
      props = { ...props, ...next };
      await act(async () => {
        view.update(createElement(IssuanceReview, props));
      });
    },
    settle,
  };
}

test('only administrator can check configured issuance; unavailable configuration never exposes issue', async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    async () => {
      calls++;
      return Response.json({ status: 'not_configured' });
    },
    memoryStorage(),
    { user: { ...actor, role: 'reviewer' } },
  );
  assert.equal(f.text(), '');
  assert.equal(calls, 0);
  await f.update({ user: actor });
  await f.settle();
  await f.click('Review signed release');
  assert.match(f.text(), /Issuance is not configured/);
  assert.equal(f.button('Issue signed release'), undefined);
  assert.equal(calls, 1);
});
test('explicit review sends only after exact durable journal; success means issued, not activated', async (t) => {
  const storage = memoryStorage();
  let posts = 0;
  const f = await fixture(
    t,
    async (url, init) => {
      if (url.endsWith('/current')) return Response.json(ready);
      assert.equal(init?.method, 'POST');
      posts++;
      const retained = await createIssuanceJournal(storage).read();
      assert.ok(retained);
      assert.equal(String(init.body), JSON.stringify(retained.request));
      return Response.json(await receipt(retained.request));
    },
    storage,
  );
  await f.click('Review signed release');
  assert.equal(posts, 0);
  await f.click('Issue signed release');
  assert.equal(posts, 1);
  assert.equal(await createIssuanceJournal(storage).read(), null);
  assert.match(f.text(), /Signed release issued · Not activated/);
  assert.match(f.text(), /No device adoption is confirmed/);
});
test('lost response and absent receipt retain exact retry identity; remount needs no preparation', async (t) => {
  const storage = memoryStorage();
  const retained = await pending();
  await createIssuanceJournal(storage).remember(retained);
  const calls: string[] = [];
  const f = await fixture(
    t,
    async (url, init) => {
      calls.push(url);
      if (init?.method !== 'POST')
        return Response.json(
          { error: { code: 'issuance_unknown', message: 'No confirmed receipt yet.' } },
          { status: 404 },
        );
      assert.deepEqual(JSON.parse(String(init.body)), retained.request);
      return Response.json(await receipt(retained.request));
    },
    storage,
    { prepared: null },
  );
  await f.click('Check release receipt');
  assert.deepEqual(await createIssuanceJournal(storage).read(), retained);
  assert.equal(f.button('Review signed release'), undefined);
  await f.click('Retry exact release request');
  assert.equal(
    calls[0],
    `/admin/api/publication/releases/operations/test-operation?requestFingerprint=${retained.requestFingerprint}`,
  );
  assert.equal(await createIssuanceJournal(storage).read(), null);
  assert.match(f.text(), /Not activated/);
});
test('head-race rejection stays recoverable until exact durable cancellation permits a fresh review', async (t) => {
  let resolution = false;
  const f = await fixture(t, async (url, init) => {
    if (url.endsWith('/current')) return Response.json(ready);
    if (url.endsWith('/resolve')) {
      resolution = true;
      const stored = await createIssuanceJournal(f.storage).read();
      assert.ok(stored);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        requestFingerprint: stored.requestFingerprint,
      });
      return Response.json({
        status: 'cancelled',
        operationId: stored.request.operationId,
        actorId: stored.actorId,
        requestFingerprint: stored.requestFingerprint,
      });
    }
    return Response.json(
      { error: { code: 'release_head_changed', message: 'Review the current release.' } },
      { status: 409 },
    );
  });
  await f.click('Review signed release');
  await f.click('Issue signed release');
  assert.ok(await createIssuanceJournal(f.storage).read());
  await f.click('Resolve unconfirmed release');
  assert.equal(resolution, false);
  await f.click('Confirm release resolution');
  assert.equal(await createIssuanceJournal(f.storage).read(), null);
  assert.match(f.text(), /Release request cancelled/);
  assert.ok(f.button('Review signed release'));
});
test('storage failure blocks sending and retained callbacks cannot issue for a hidden prior actor', async (t) => {
  let posts = 0;
  const storage = memoryStorage();
  storage.setItem = () => {
    throw new Error('Storage unavailable');
  };
  const f = await fixture(
    t,
    async (url) => {
      if (url.endsWith('/current')) return Response.json(ready);
      posts++;
      throw new Error('Must not send');
    },
    storage,
  );
  await f.click('Review signed release');
  const savedClick = f.button('Issue signed release')!.props.onClick;
  await f.click('Issue signed release');
  assert.equal(posts, 0);
  assert.match(f.text(), /Storage unavailable/);
  await f.update({ active: false });
  await act(async () => {
    savedClick();
  });
  await f.settle();
  assert.equal(posts, 0);
});
test('a late head read after owner change never becomes an issuance review', async (t) => {
  let release: (response: Response) => void = () => {};
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  await f.click('Review signed release', false);
  await f.update({ user: { ...actor, userId: 'other-admin' } });
  await act(async () => {
    release(Response.json(ready));
  });
  await f.settle();
  assert.equal(f.button('Issue signed release'), undefined);
  assert.equal(calls, 1);
});
test('reauthentication invalidates an earlier saved issue callback', async (t) => {
  let posts = 0;
  const f = await fixture(t, async (url) => {
    if (url.endsWith('/current')) return Response.json(ready);
    posts++;
    throw new Error('Must not issue stale review');
  });
  await f.click('Review signed release');
  const oldIssue = f.button('Issue signed release')!.props.onClick;
  await f.api.session();
  await f.update({});
  await act(async () => {
    oldIssue();
  });
  await f.settle();
  assert.equal(posts, 0);
  assert.equal(f.button('Issue signed release'), undefined);
});
test('lost post acknowledgement remains pending; dirty editor does not trap exact receipt recovery', async (t) => {
  let issued: AdminPublicationIssueRequest | null = null;
  const f = await fixture(t, async (url, init) => {
    if (url.endsWith('/current')) return Response.json(ready);
    if (init?.method === 'POST') {
      issued = JSON.parse(String(init.body));
      throw new Error('Lost acknowledgement');
    }
    assert.ok(issued);
    return Response.json(await receipt(issued));
  });
  await f.click('Review signed release');
  await f.click('Issue signed release');
  assert.ok(await createIssuanceJournal(f.storage).read());
  await f.update({ disabled: true });
  assert.equal(f.button('Check release receipt')!.props.disabled, false);
  await f.click('Check release receipt');
  assert.match(f.text(), /Signed release issued · Not activated/);
});
test('journal completion after authority changes is retained for recovery but never sends', async (t) => {
  let sends = 0;
  const f = await fixture(t, async (url) => {
    if (url.endsWith('/current')) return Response.json(ready);
    sends++;
    throw new Error('Must not send after authority changes');
  });
  await f.click('Review signed release');
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let resume: () => void = () => {};
  let first = true;
  t.mock.method(crypto.subtle, 'digest', (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    if (!first) return digest(algorithm, data);
    first = false;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      resume = () => {
        void digest(algorithm, data).then(resolve, reject);
      };
    });
  });
  await f.click('Issue signed release', false);
  await f.update({ active: false });
  resume();
  await f.settle();
  assert.ok(await createIssuanceJournal(f.storage).read());
  assert.equal(sends, 0);
  await f.update({ active: true });
  await f.settle();
  assert.ok(f.button('Check release receipt'));
  assert.equal(f.button('Review signed release'), undefined);
});
test('write followed by unreadable storage fails closed and recovers without the original prepared selection', async (t) => {
  const storage = memoryStorage();
  const read = storage.getItem;
  const write = storage.setItem;
  let unreadable = false;
  storage.getItem = (key) => {
    if (unreadable) throw new Error('Read failed');
    return read(key);
  };
  storage.setItem = (key, value) => {
    write(key, value);
    unreadable = true;
  };
  let sends = 0;
  const protections: { pending: boolean; busy: boolean }[] = [];
  const f = await fixture(
    t,
    async (url) => {
      if (url.endsWith('/current')) return Response.json(ready);
      sends++;
      throw new Error('Must not send without read-back');
    },
    storage,
    {
      onProtectionChange(value) {
        protections.push(value);
      },
    },
  );
  await f.click('Review signed release');
  await f.click('Issue signed release');
  assert.equal(sends, 0);
  assert.equal(storage.values.size, 1);
  assert.match(f.text(), /recovery record could not be confirmed/);
  assert.equal(protections.at(-1)?.pending, true);
  unreadable = false;
  await f.update({ active: false, prepared: null });
  await f.settle();
  await f.update({ active: true });
  await f.settle();
  assert.ok(f.button('Check release receipt'));
  assert.equal(sends, 0);
});
test('idle administrator library has no issuance panel after its recovery check', async (t) => {
  const f = await fixture(
    t,
    async () => {
      throw new Error('No request expected');
    },
    memoryStorage(),
    { prepared: null },
  );
  assert.equal(f.text(), '');
});

test('a newly prepared selection reveals the release heading without fetching or issuing automatically', async (t) => {
  let requests = 0;
  const f = await fixture(
    t,
    async () => {
      requests++;
      throw new Error('Explicit review required');
    },
    memoryStorage(),
    { prepared: null },
  );
  assert.deepEqual(f.focusedHeadings, []);
  await f.update({ prepared });
  assert.deepEqual(f.focusedHeadings, ['Issue a signed recipe release']);
  assert.ok(f.button('Review signed release'));
  assert.equal(requests, 0);
  await f.update({ disabled: true });
  assert.equal(f.focusedHeadings.length, 1);
  await f.update({ active: false, prepared: { ...prepared, title: 'Hidden selection' } });
  await f.update({ active: true });
  assert.equal(f.focusedHeadings.length, 1);
  assert.equal(requests, 0);
});
