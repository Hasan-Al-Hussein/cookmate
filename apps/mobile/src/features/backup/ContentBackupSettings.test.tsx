import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { catalogue } from '@cookmate/catalogue';
import type { Immutable } from '@cookmate/domain';
import {
  createPortableContentBackup,
  type PortableContentBackupEnvelope,
} from '../../../../../packages/domain/src/portableBackupContent';
import type { PortableContentRestoreReview } from '../../data/portableContentRestore';
import type { RestoreSettingsPort } from './restoreSettingsPorts';
import { createContentRestoreReferenceStore } from './contentRestoreReferences';
import { ActionButton } from '../../components/Controls';
import type { PortableContentReferenceInspection } from '../../data/portableContentInspection';
import type { ContentWorkspaceState } from '../content/contentWorkspaceHost';
import { ContentBackupSettings, type ContentBackupHost } from './ContentBackupSettings';
import { BackupTransferError, type BackupTransfer } from './backupTransferTypes';

const { createHash } = require('node:crypto') as {
  createHash(algorithm: 'sha256'): { update(text: string): { digest(encoding: 'hex'): string } };
};
const mockFocus: { start?: () => void | (() => void); stop?: void | (() => void) } = {};
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) =>
    jest.requireActual('react').useEffect(() => {
      mockFocus.start = callback;
      mockFocus.stop = callback();
      return () => {
        mockFocus.stop?.();
        delete mockFocus.start;
        delete mockFocus.stop;
      };
    }, [callback]),
}));
jest.mock('./backupTransfer', () => ({ createBackupTransfer: jest.fn() }));
const timestamp = '2026-10-02T00:00:00.000Z',
  occurrenceId = 'a0000000-0000-4000-8000-000000000001';
const ref = {
  recipeId: '52819',
  revisionId: 'backup-exact-fixture',
  contentFingerprint: 'b'.repeat(64),
};
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const ready = <T,>(value: T) => ({ kind: 'ready' as const, value, revision: 6 });
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.unavailable',
  retry: 'never' as const,
};
function port<F extends (...args: never[]) => unknown>() {
  return jest.fn<ReturnType<F>, Parameters<F>>();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let envelope: Immutable<PortableContentBackupEnvelope>,
  historyEnvelope: Immutable<PortableContentBackupEnvelope>;
beforeAll(async () => {
  envelope = await createPortableContentBackup(
    {
      schemaVersion: 3,
      databaseSchemaVersion: 8,
      createdAt: timestamp,
      catalogue: catalogue.identity,
      sourceRevision: 6,
      data: {
        favourites: [
          {
            recipeId: ref.recipeId,
            saved: true,
            revision: 1,
            savedAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        occurrences: [
          {
            occurrenceId,
            recipeId: ref.recipeId,
            placement: { actualDate: '2026-10-02', mealKey: 'dinner' },
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        planReferences: [{ occurrenceId, contentRef: ref }],
        shopping: {
          scope: {
            scopeId: 'b0000000-0000-4000-8000-000000000001',
            revision: 1,
            occurrenceIds: [occurrenceId],
          },
          projectionRevision: 0,
          projectionStatus: 'pending',
          purchaseMarks: [],
        },
        preferences: {
          snapshot: { revision: 0, lastRemovalRevision: null, items: [] },
          removals: [],
        },
        personal: {
          notes: [
            {
              noteId: 'c0000000-0000-4000-8000-000000000001',
              recipeId: ref.recipeId,
              text: 'Private original recipe note',
              deleted: false,
              revision: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          collections: [],
          memberships: [],
          manualItems: [],
        },
      },
    },
    sha256,
  );
  const { format: _format, counts: _counts, integrity: _integrity, ...input } = envelope;
  historyEnvelope = await createPortableContentBackup(
    {
      ...input,
      data: {
        ...input.data,
        cookingHistory: {
          entries: [
            {
              kind: 'exact',
              entry: {
                readerVersion: 2,
                recipeId: ref.recipeId,
                contentRef: ref,
                eventId: 'd0000000-0000-4000-8000-000000000001',
                recipeTitle: 'Exact cooked dinner',
                photoAssetId: null,
                cookedOn: '2026-10-01',
                timeZone: 'Asia/Dubai',
                recordedAt: timestamp,
                note: 'Private original cooking note',
                historyEpoch: 1,
                revision: 2,
              },
            },
          ],
        },
      },
    },
    sha256,
  );
});
beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'web');
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
function fixture() {
  let state: Readonly<ContentWorkspaceState> = {
    status: 'ready',
    scopeKey: 'backup-owner:1',
    pending: null,
    cleanupPending: 0,
  };
  const listeners = new Set<() => void>();
  const inspection: Immutable<PortableContentReferenceInspection> = {
    backupDigest: envelope.integrity.digest,
    counts: envelope.counts,
    adoptedHead: null,
    latestHead: null,
    references: [{ ref, state: 'historical' }],
    historyIssues: [],
    archiveVerification: 'performed',
    exactReferencesAvailable: true,
    restoreAvailable: false,
    warnings: [
      'personal_data_plaintext',
      'checksum_is_not_authentication',
      'restore_review_and_apply_required',
    ],
  };
  const backup = {
    capture: port<ContentBackupHost['backup']['capture']>().mockImplementation(async (input) =>
      ready(input?.includeCookingHistory ? historyEnvelope : envelope),
    ),
    inspect: port<ContentBackupHost['backup']['inspect']>().mockResolvedValue(ready(inspection)),
  };
  const host: ContentBackupHost = {
    backup,
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const transfer: jest.Mocked<BackupTransfer> = {
    exportFile: port<BackupTransfer['exportFile']>().mockResolvedValue('download_requested'),
    pickFile: port<BackupTransfer['pickFile']>().mockResolvedValue({
      kind: 'selected',
      serialized: JSON.stringify(envelope),
    }),
    copyText: port<NonNullable<BackupTransfer['copyText']>>().mockResolvedValue(undefined),
    dispose: jest.fn(),
  };
  const createTransfer = jest.fn(() => transfer);
  return {
    host,
    backup,
    transfer,
    createTransfer,
    inspection,
    retire: () => {
      state = { ...state, status: 'revoked', scopeKey: 'backup-owner:2' };
      for (const listener of listeners) listener();
    },
  };
}
function mount(f: ReturnType<typeof fixture>) {
  return render(<ContentBackupSettings host={f.host} createTransfer={f.createTransfer} />);
}
const button = (name: string) => screen.getByRole('button', { name });
function retained(name: string) {
  return screen.UNSAFE_getAllByType(ActionButton).find((node) => node.props.label === name)!.props
    .onPress as () => void;
}
function inspectTab() {
  fireEvent.press(screen.getByRole('tab', { name: 'Inspect' }));
}

test('exports the exact captured Format 3 envelope with actual counts and source revision; history starts off', async () => {
  const f = fixture();
  mount(f);
  fireEvent.press(button('Export plain-text backup'));
  await waitFor(() => expect(f.transfer.exportFile).toHaveBeenCalledTimes(1));
  expect(f.backup.capture).toHaveBeenCalledWith({ includeCookingHistory: false });
  expect(f.transfer.exportFile).toHaveBeenCalledWith(JSON.stringify(envelope));
  expect(screen.getByText(/workspace revision 6/)).toBeTruthy();
  expect(screen.getByLabelText('Private recipe notes: 1')).toBeTruthy();
  expect(screen.getByText(/Download requested. Check/)).toBeTruthy();
  expect(screen.queryByText(/Format 2/)).toBeNull();
  expect(screen.getByText('Cooking history and its private notes are not included.')).toBeTruthy();
  expect(screen.getByText('Restoring is unavailable in this workspace')).toBeTruthy();
});
test('history opt-in applies to one attempt only, including a failed capture', async () => {
  const f = fixture();
  f.backup.capture.mockResolvedValueOnce({ kind: 'failed', error: failure });
  mount(f);
  fireEvent.press(
    screen.getByRole('checkbox', { name: 'Include cooking history in the next export' }),
  );
  fireEvent.press(button('Export plain-text backup'));
  await waitFor(() => expect(screen.getByText(/snapshot could not be captured/)).toBeTruthy());
  expect(f.backup.capture.mock.calls[0]![0]).toEqual({ includeCookingHistory: true });
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  fireEvent.press(button('Export plain-text backup'));
  await waitFor(() => expect(f.transfer.exportFile).toHaveBeenCalledTimes(1));
  expect(f.backup.capture.mock.calls[1]![0]).toEqual({ includeCookingHistory: false });
});
test('explicit history selection exports actual cooking entries and private notes without modifying the envelope', async () => {
  const f = fixture();
  mount(f);
  fireEvent.press(screen.getByRole('checkbox'));
  fireEvent.press(button('Export plain-text backup'));
  await waitFor(() =>
    expect(f.transfer.exportFile).toHaveBeenCalledWith(JSON.stringify(historyEnvelope)),
  );
  expect(screen.getByLabelText('Cooking history entries: 1')).toBeTruthy();
  expect(screen.queryByText('Private original cooking note')).toBeNull();
});
test('text fallback neither transfers nor copies until explicit action and reveals the complete unchanged JSON', async () => {
  const f = fixture();
  mount(f);
  fireEvent.press(button('Prepare backup text'));
  await waitFor(() => expect(button('Show backup JSON')).toBeTruthy());
  expect(f.transfer.exportFile).not.toHaveBeenCalled();
  expect(f.transfer.copyText).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Prepared backup JSON')).toBeNull();
  fireEvent.press(button('Show backup JSON'));
  expect(screen.getByLabelText('Prepared backup JSON').props.value).toBe(JSON.stringify(envelope));
  fireEvent.press(button('Copy backup JSON'));
  await waitFor(() => expect(f.transfer.copyText).toHaveBeenCalledWith(JSON.stringify(envelope)));
  expect(screen.getByText(/Copying alone is not a saved backup/)).toBeTruthy();
  fireEvent.press(button('Discard prepared text'));
  expect(screen.queryByLabelText('Prepared backup JSON')).toBeNull();
});
test('inspection uses the actual host inspector and distinguishes unavailable references and history issues without rendering private payload', async () => {
  const f = fixture();
  f.backup.inspect.mockResolvedValue(
    ready({
      ...f.inspection,
      references: [
        { ref, state: 'withdrawn' },
        { ref: { ...ref, revisionId: 'missing-exact' }, state: 'missing' },
        { ref: { ...ref, revisionId: 'archived-exact' }, state: 'archived' },
      ],
      historyIssues: [
        { eventId: 'opaque', reason: 'unresolved_legacy' },
        { eventId: 'opaque-two', reason: 'previously_removed' },
        { eventId: 'opaque-three', reason: 'metadata_mismatch' },
      ],
      exactReferencesAvailable: false,
    }),
  );
  mount(f);
  inspectTab();
  fireEvent.press(button('Inspect backup file'));
  await waitFor(() => expect(screen.getByText('Backup inspected')).toBeTruthy());
  expect(f.backup.inspect).toHaveBeenCalledWith(JSON.stringify(envelope));
  expect(screen.getByText('Withdrawn exact versions: 1')).toBeTruthy();
  expect(screen.getByText('Missing exact versions: 1')).toBeTruthy();
  expect(screen.getByText('Archived exact versions: 1')).toBeTruthy();
  expect(screen.getByText('Unresolved earlier history references: 1')).toBeTruthy();
  expect(screen.getByText('Previously removed history entries: 1')).toBeTruthy();
  expect(screen.getByText('History metadata mismatches: 1')).toBeTruthy();
  expect(screen.queryByText('Private original recipe note')).toBeNull();
  expect(f.backup.capture).not.toHaveBeenCalled();
  expect(f.transfer.exportFile).not.toHaveBeenCalled();
});
test.each(['checksum_mismatch', 'unsupported_version'] as const)(
  'invalid inspection %s is not presented as an authenticated or restorable file',
  async (reason) => {
    const f = fixture();
    f.backup.inspect.mockResolvedValue({ kind: 'invalid', reason });
    mount(f);
    inspectTab();
    fireEvent.press(button('Inspect backup file'));
    await waitFor(() => expect(screen.getByText('Backup needs attention')).toBeTruthy());
    expect(screen.queryByText('Backup inspected')).toBeNull();
    expect(screen.queryByText(/Current exact versions:/)).toBeNull();
  },
);
test('trusted-content inspection failure stays incomplete rather than inventing missing-reference counts', async () => {
  const f = fixture();
  f.backup.inspect.mockResolvedValue({ kind: 'failed', error: failure });
  mount(f);
  inspectTab();
  fireEvent.press(button('Inspect backup file'));
  await waitFor(() => expect(screen.getByText(/Inspection is incomplete/)).toBeTruthy());
  expect(screen.queryByText('Backup inspected')).toBeNull();
  expect(screen.queryByText(/Missing exact versions:/)).toBeNull();
});
test('owner retirement during capture suppresses transfer and prepared private text', async () => {
  const f = fixture(),
    pending = deferred<Awaited<ReturnType<ContentBackupHost['backup']['capture']>>>();
  f.backup.capture.mockReturnValue(pending.promise);
  mount(f);
  fireEvent.press(button('Export plain-text backup'));
  act(() => f.retire());
  await act(async () => pending.resolve(ready(envelope)));
  expect(f.transfer.exportFile).not.toHaveBeenCalled();
  expect(screen.queryByText('Prepared backup snapshot')).toBeNull();
  expect(screen.getByText('Backup is unavailable here')).toBeTruthy();
});
test('blur retires old callbacks and clears prepared text without allowing a stale opt-in on return', async () => {
  const f = fixture();
  mount(f);
  fireEvent.press(screen.getByRole('checkbox'));
  const oldExport = retained('Export plain-text backup');
  act(() => mockFocus.stop?.());
  act(() => {
    mockFocus.stop = mockFocus.start?.();
  });
  await act(async () => oldExport());
  expect(f.backup.capture).not.toHaveBeenCalled();
  fireEvent.press(button('Prepare backup text'));
  await waitFor(() => expect(button('Show backup JSON')).toBeTruthy());
  fireEvent.press(button('Show backup JSON'));
  act(() => mockFocus.stop?.());
  expect(screen.queryByLabelText('Prepared backup JSON')).toBeNull();
});
test.each(['resolve', 'reject'] as const)(
  'owner retirement after transfer dispatch (%s) never claims nothing was delivered',
  async (outcome) => {
    const f = fixture(),
      pending = deferred<'download_requested' | 'share_sheet_closed'>();
    f.transfer.exportFile.mockReturnValue(pending.promise);
    mount(f);
    fireEvent.press(button('Export plain-text backup'));
    await waitFor(() => expect(f.transfer.exportFile).toHaveBeenCalledTimes(1));
    act(() => f.retire());
    await act(async () => {
      if (outcome === 'resolve') pending.resolve('download_requested');
      else pending.reject(new Error('Late transfer failure'));
    });
    expect(screen.getByText(/Any transfer already started may still complete/)).toBeTruthy();
    expect(screen.queryByText(/No backup file was offered/)).toBeNull();
    expect(screen.queryByLabelText('Prepared backup JSON')).toBeNull();
    expect(f.transfer.exportFile).toHaveBeenCalledTimes(1);
  },
);
test('cleanup failure after export uses uncertain-delivery copy, and native closure never claims saving', async () => {
  const f = fixture();
  f.transfer.exportFile.mockRejectedValueOnce(new BackupTransferError('cleanup_failed'));
  mount(f);
  fireEvent.press(button('Export plain-text backup'));
  await waitFor(() => expect(screen.getByText(/transfer may have completed/)).toBeTruthy());
  expect(screen.queryByText(/No backup file was offered/)).toBeNull();
  fireEvent.press(button('Export plain-text backup'));
  f.transfer.exportFile.mockResolvedValueOnce('share_sheet_closed');
  await waitFor(() => expect(f.transfer.exportFile).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByText(/share sheet has closed/)).toBeTruthy());
});

function restoreConnection(f: ReturnType<typeof fixture>) {
  const review: Immutable<PortableContentRestoreReview> = Object.freeze({
    reviewId: 'backup-content-review',
    importFingerprint: envelope.integrity.digest,
    expectedRevision: 6,
    installationId: occurrenceId,
    ownerId: null,
    authGeneration: 1,
    adoptedHead: null,
    latestHead: null,
    adoptionRevision: 0,
    restoreEpoch: 0,
    storeRevision: 6,
    before: envelope.counts,
    after: envelope.counts,
    blockers: [],
    unknownRecipeIds: [],
    shopping: { restoredChecks: 0, uncheckedImportedChecks: 0 },
    warnings: ['cooking_history_is_not_included_and_stays_unchanged'],
    replacedScopes: ['core', 'personal'] as const,
  });
  type Service = RestoreSettingsPort<Immutable<PortableContentRestoreReview>>;
  const service: jest.Mocked<Service> = {
    review: port<Service['review']>().mockResolvedValue(ready(review)),
    prepare: port<Service['prepare']>().mockResolvedValue(
      ready({
        operationId: occurrenceId,
        importFingerprint: review.importFingerprint,
        expectedRevision: 6,
      }),
    ),
    execute: port<Service['execute']>().mockResolvedValue({
      kind: 'uncertain',
      operationId: occurrenceId,
      error: failure,
    }),
    readReceipt: port<Service['readReceipt']>().mockResolvedValue(ready(null)),
    readArchive: port<Service['readArchive']>().mockResolvedValue(ready(null)),
  };
  f.host.restore = { service, readInstallationId: async () => ready(occurrenceId) };
  const values = new Map<string, string>();
  const references = createContentRestoreReferenceStore({
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      values.set(key, value);
    },
  });
  return { service, review, references, values };
}
test('a supplied restore connection mounts the shared explicit review without changing export or inspection', async () => {
  const f = fixture(),
    r = restoreConnection(f);
  render(
    <ContentBackupSettings
      host={f.host}
      createTransfer={f.createTransfer}
      restoreReferences={r.references}
    />,
  );
  expect(screen.queryByText('Restoring is unavailable in this workspace')).toBeNull();
  expect(r.service.review).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('tab', { name: 'Restore' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('Review replacement');
  await waitFor(() => expect(button('Replace local cooking data')).not.toBeDisabled());
  expect(screen.getByText(/exact restored recipe versions/)).toBeTruthy();
  expect(r.service.execute).not.toHaveBeenCalled();
  fireEvent.press(button('Replace local cooking data'));
  await screen.findByText('Restore result is uncertain');
  expect(r.service.prepare.mock.calls[0]?.[0]).toBe(r.review);
  expect(f.backup.capture).not.toHaveBeenCalled();
  expect(f.backup.inspect).not.toHaveBeenCalled();
  expect([...r.values.keys()]).toEqual([`cookmate.content-restore-references.${occurrenceId}`]);
});
test('owner retirement after restore dispatch hides the review and retains its metadata without claiming no change', async () => {
  const f = fixture(),
    r = restoreConnection(f),
    gate = deferred<Awaited<ReturnType<typeof r.service.execute>>>();
  r.service.execute.mockReturnValue(gate.promise);
  render(
    <ContentBackupSettings
      host={f.host}
      createTransfer={f.createTransfer}
      restoreReferences={r.references}
    />,
  );
  fireEvent.press(screen.getByRole('tab', { name: 'Restore' }));
  fireEvent.press(await screen.findByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('Review replacement');
  await waitFor(() => expect(button('Replace local cooking data')).not.toBeDisabled());
  fireEvent.press(button('Replace local cooking data'));
  await waitFor(() => expect(r.service.execute).toHaveBeenCalledTimes(1));
  act(() => f.retire());
  await act(async () =>
    gate.resolve({ kind: 'uncertain', operationId: occurrenceId, error: failure }),
  );
  expect(screen.queryByText('Review replacement')).toBeNull();
  expect(screen.queryByText('Restore committed')).toBeNull();
  expect(screen.getByText('Backup is unavailable here')).toBeTruthy();
  expect(await r.references.load(occurrenceId)).toHaveLength(1);
  expect(r.service.execute).toHaveBeenCalledTimes(1);
});
