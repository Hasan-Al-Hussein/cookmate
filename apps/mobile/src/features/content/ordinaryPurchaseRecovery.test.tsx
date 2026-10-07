import { act, cleanupAsync, render, waitFor } from '@testing-library/react-native';
import type {
  DirectActionReview,
  DirectRecoveryPage,
  RepositoryResult,
  Immutable,
} from '@cookmate/domain';
import type { LocalCommand, OperationReceipt } from '@cookmate/contracts';
import { WorkspaceFeedback } from '../workspace/WorkspaceFeedback';
import {
  createOrdinaryContentWorkspace,
  type OrdinaryContentHost,
} from './ordinaryContentWorkspace';
let mockAdapter: ReturnType<typeof createOrdinaryContentWorkspace>;
jest.mock('./OrdinaryContentWorkspaceProvider', () => ({
  useOptionalOrdinaryContentWorkspace: () =>
    jest
      .requireActual('react')
      .useSyncExternalStore(mockAdapter.subscribe, mockAdapter.getSnapshot),
  useContentWorkspaceFocus: () => ({
    registerFocusFallback: () => () => undefined,
    restoreScreenFocus: () => undefined,
  }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('../../components/Page', () => ({ usePageStyles: () => ({ section: {} }) }));
const failed = {
  kind: 'failed',
  error: { code: 'storage_failure', messageKey: 'test', retry: 'never' },
} as const;
const input = { kind: 'setPurchased', groupKey: 'flour', purchased: true } as const;
const review: DirectActionReview = {
  guard: { kind: 'none' },
  input,
  payload: {
    ...input,
    scopeId: 'scope',
    expectedDemandFingerprint: 'a'.repeat(64),
    expectedRevision: 1,
  },
  consequences: {
    kind: 'purchase',
    groupKey: 'flour',
    displayName: 'Flour',
    quantityLabel: '300 g',
    purchased: true,
  },
};
const command: Immutable<LocalCommand> = {
  schemaVersion: 2,
  operationId: 'owned-purchase',
  userIntentId: 'owned-intent',
  intentRevision: 1,
  payloadFingerprint: 'b'.repeat(64),
  command: review.payload,
};
const receipt: OperationReceipt = {
  schemaVersion: 1,
  operationId: command.operationId,
  userIntentId: command.userIntentId,
  payloadFingerprint: command.payloadFingerprint,
  committedAt: '2026-10-01T00:00:00Z',
  outcome: 'committed',
  effects: [],
  shoppingProjection: 'unchanged',
};
afterEach(async () => {
  await cleanupAsync();
  mockAdapter.close();
});
test.each(['failed', 'earlier'] as const)(
  'owned purchase keeps rows steady during recovery check; %s result is still visible',
  async (outcome) => {
    let resolve!: (result: RepositoryResult<DirectRecoveryPage>) => void;
    const pending = new Promise<RepositoryResult<DirectRecoveryPage>>((done) => {
      resolve = done;
    });
    const readRecovery = jest.fn<Promise<RepositoryResult<DirectRecoveryPage>>, []>(async () => ({
      kind: 'ready',
      value: { entries: [], nextAfterSequence: null },
      revision: 0,
    }));
    const state = {
      status: 'ready',
      scopeKey: 'test-owner',
      pending: null,
      cleanupPending: 0,
    } as const;
    const host: OrdinaryContentHost = {
      getSnapshot: () => state,
      subscribe: () => () => undefined,
      commands: {
        reviewDirect: async () => ({ kind: 'ready', value: review, revision: 0 }),
        prepareDirect: async () => ({ kind: 'ready', value: command, revision: 0 }),
        execute: async () => ({ kind: 'receipt', receipt }),
        acknowledgeDirectRecovery: async () => ({ kind: 'ready', value: null, revision: 0 }),
        readReceipt: async () => ({ kind: 'ready', value: receipt, revision: 0 }),
        readDirectRecovery: readRecovery,
      },
      queries: {
        readPlan: async () => failed,
        readShopping: async () => failed,
        readFavourites: async () => failed,
      },
      readerStore: {
        content: {} as OrdinaryContentHost['readerStore']['content'],
        subscribe: () => () => undefined,
      },
    };
    mockAdapter = createOrdinaryContentWorkspace(host);
    const view = render(<WorkspaceFeedback checklist />);
    await waitFor(() => expect(view.toJSON()).toBeNull());
    readRecovery.mockImplementation(() => pending);
    const ready = mockAdapter.getSnapshot();
    if (ready.kind !== 'ready') throw Error('ready expected');
    await act(async () =>
      ready.actions.begin(input, { observedDemandFingerprint: 'a'.repeat(64) }),
    );
    expect(readRecovery).toHaveBeenCalledTimes(2);
    expect(view.toJSON()).toBeNull();
    expect(ready.actions.blocked).toBe(true);
    const result: RepositoryResult<DirectRecoveryPage> =
      outcome === 'failed'
        ? failed
        : {
            kind: 'ready',
            revision: 1,
            value: {
              entries: [
                {
                  sequence: 1,
                  operationId: 'earlier-operation',
                  userIntentId: 'earlier-intent',
                  commandKind: 'setPurchased',
                  phase: 'ready',
                  outcome: 'not_executed',
                  receipt: null,
                },
              ],
              nextAfterSequence: null,
            },
          };
    await act(async () => resolve(result));
    expect(
      view.getByText(
        outcome === 'failed'
          ? 'Couldn’t check earlier changes'
          : 'An earlier change was not applied',
      ),
    ).toBeTruthy();
    expect(ready.actions.blocked).toBe(true);
  },
);
