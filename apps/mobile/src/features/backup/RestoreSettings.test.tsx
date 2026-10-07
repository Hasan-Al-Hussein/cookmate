import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { portableRestoreWarnings } from '@cookmate/domain';
import type {
  CookMateQueries,
  Immutable,
  PortableRestoreReceipt,
  PortableRestoreReview,
  PortableRestoreService,
  PreparedPortableRestore,
  RepositoryResult,
} from '@cookmate/domain';
import { RestoreSettings } from './RestoreSettings';
import type { BackupTransfer } from './backupTransferTypes';
import {
  createRestoreReferenceStore,
  type RestoreReference,
  type RestoreReferenceStore,
} from './restoreReferences';

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('./backupTransfer', () => ({ createBackupTransfer: jest.fn() }));

const installation = 'a0000000-0000-4000-8000-000000000001';
const operationId = 'b0000000-0000-4000-8000-000000000001';
const timestamp = '2026-09-30T08:00:00.000Z';
const source = '{"fixture":"original private input"}';
const before = {
  favourites: 1,
  tombstones: 2,
  plannedMeals: 3,
  selectedMeals: 2,
  purchaseMarks: 2,
  purchasedItems: 1,
  preferences: 1,
  preferenceRemovals: 1,
};
const after = {
  favourites: 5,
  tombstones: 2,
  plannedMeals: 6,
  selectedMeals: 4,
  purchaseMarks: 5,
  purchasedItems: 3,
  preferences: 2,
  preferenceRemovals: 2,
};
const review: Immutable<PortableRestoreReview> = Object.freeze({
  reviewId: 'review-fixture',
  importFingerprint: 'a'.repeat(64),
  expectedRevision: 4,
  before,
  after,
  blockers: [],
  unknownRecipeIds: [],
  shopping: { restoredChecks: 2, uncheckedImportedChecks: 1 },
  warnings: portableRestoreWarnings,
});
const prepared: Immutable<PreparedPortableRestore> = Object.freeze({
  operationId,
  importFingerprint: review.importFingerprint,
  expectedRevision: 4,
});
const receipt: Immutable<PortableRestoreReceipt> = Object.freeze({
  ...prepared,
  kind: 'portable_restore',
  committedAt: timestamp,
  revision: 5,
  beforeFingerprint: 'b'.repeat(64),
  shopping: { restoredChecks: 2, uncheckedImportedChecks: 1 },
  importedPreferenceRemovals: 2,
  restoredCounts: { ...after, purchasedItems: 2, preferenceRemovals: 0 },
});
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'restore.unavailable',
  retry: 'never' as const,
};
const ready = <T,>(value: T): RepositoryResult<T> => ({ kind: 'ready', value, revision: 4 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mockPort<T extends (...args: never[]) => unknown>() {
  return jest.fn<ReturnType<T>, Parameters<T>>();
}
let service: jest.Mocked<PortableRestoreService>;
let references: jest.Mocked<RestoreReferenceStore>;
let transfer: jest.Mocked<BackupTransfer>;
let readInstallationId: jest.MockedFunction<CookMateQueries['readInstallationId']>;
beforeEach(() => {
  service = {
    review: mockPort<PortableRestoreService['review']>().mockResolvedValue(ready(review)),
    prepare: mockPort<PortableRestoreService['prepare']>().mockResolvedValue(ready(prepared)),
    execute: mockPort<PortableRestoreService['execute']>().mockResolvedValue({
      kind: 'receipt',
      receipt,
    }),
    readReceipt: mockPort<PortableRestoreService['readReceipt']>().mockResolvedValue(
      ready(receipt),
    ),
    readArchive: mockPort<PortableRestoreService['readArchive']>().mockResolvedValue(
      ready('{"verified":"archive"}'),
    ),
  };
  references = {
    load: mockPort<RestoreReferenceStore['load']>().mockResolvedValue([]),
    remember: mockPort<RestoreReferenceStore['remember']>().mockImplementation(
      async (_installation, reference) => [reference],
    ),
    forget: mockPort<RestoreReferenceStore['forget']>().mockResolvedValue([]),
  };
  transfer = {
    pickFile: mockPort<BackupTransfer['pickFile']>().mockResolvedValue({
      kind: 'selected',
      serialized: source,
    }),
    exportFile: mockPort<BackupTransfer['exportFile']>().mockResolvedValue('download_requested'),
    dispose: mockPort<BackupTransfer['dispose']>(),
  };
  readInstallationId = mockPort<CookMateQueries['readInstallationId']>().mockResolvedValue(
    ready(installation),
  );
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
function mount() {
  return render(
    <RestoreSettings
      service={service}
      readInstallationId={readInstallationId}
      createTransfer={() => transfer}
      references={references}
    />,
  );
}
async function choose() {
  fireEvent.press(screen.getByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('Review replacement');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Replace local cooking data' })).not.toBeDisabled(),
  );
}

test('only local reference metadata loads until deliberate file selection; cancel never prepares or writes', async () => {
  mount();
  await waitFor(() => expect(references.load).toHaveBeenCalledWith(installation));
  expect(transfer.pickFile).not.toHaveBeenCalled();
  expect(service.review).not.toHaveBeenCalled();
  expect(service.readReceipt).not.toHaveBeenCalled();
  await choose();
  expect(service.review).toHaveBeenCalledWith(source);
  expect(screen.getByLabelText('Planned meals: current 3, backup 6')).toBeTruthy();
  expect(screen.getByText(/2 purchased checks match/)).toBeTruthy();
  expect(screen.getByText(/Messages, unsent drafts, display settings/)).toBeTruthy();
  expect(
    screen.getByText(
      'Will preserve: private recipe notes, personal collections and memberships, and manual shopping items.',
    ),
  ).toBeTruthy();
  expect(screen.getByText('Will preserve: cooking history and its private notes.')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel restore review' }));
  expect(screen.queryByText('Review replacement')).toBeNull();
  expect(service.prepare).not.toHaveBeenCalled();
  expect(service.execute).not.toHaveBeenCalled();
  expect(references.remember).not.toHaveBeenCalled();
});

test('reference explanation retains unresolved exact IDs without granting restore authority', async () => {
  service.review.mockResolvedValue(
    ready({
      ...review,
      blockers: ['history_content_mismatch'],
      referenceSummary: {
        schemaVersion: 1,
        totalRecipeIds: 1,
        knownExactRecipeIds: [],
        trustedArchivedRecipeIds: [],
        archiveResolution: 'unavailable',
        unresolved: [{ recipeId: '52835', reasons: ['history_content_mismatch'] }],
        historyEntries: 1,
        historyContentVerification: 'mismatch',
        restoreAuthorized: false,
      },
    }),
  );
  mount();
  fireEvent.press(screen.getByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('Review replacement');
  expect(screen.getByText('Recipe ID 52835')).toBeTruthy();
  expect(screen.getByText('Exact trusted archive references: unavailable')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Replace local cooking data' })).toBeDisabled();
  expect(service.prepare).not.toHaveBeenCalled();
  expect(service.execute).not.toHaveBeenCalled();
});

const personalCounts = {
  notes: 2,
  noteTombstones: 1,
  collections: 1,
  collectionTombstones: 0,
  memberships: 3,
  removedMemberships: 1,
  manualItems: 2,
  manualTombstones: 1,
  purchasedManualItems: 1,
};
function expandedReview(historyCount?: number): Immutable<PortableRestoreReview> {
  const historyIncluded = historyCount !== undefined;
  return {
    ...review,
    before: {
      ...before,
      personal: personalCounts,
      ...(historyIncluded ? { cookingHistory: 7 } : {}),
    },
    after: {
      ...after,
      personal: { ...personalCounts, notes: 4 },
      ...(historyIncluded ? { cookingHistory: historyCount } : {}),
    },
    replacedScopes: historyIncluded ? ['core', 'personal', 'cookingHistory'] : ['core', 'personal'],
    warnings: [
      ...portableRestoreWarnings.filter(
        (item) => item !== 'automatic_before_snapshot_is_cooking_data_only',
      ),
      'replaces_personal_notes_collections_and_manual_items',
      'automatic_before_snapshot_covers_every_replaced_scope',
      ...(historyIncluded
        ? [
            'replaces_visible_history_with_new_local_ids',
            'old_operation_receipts_are_not_imported_or_replayed',
            'history_clear_does_not_remove_retained_backup_archives',
          ]
        : ['cooking_history_is_not_included_and_stays_unchanged']),
    ],
  };
}
test('expanded restore distinguishes replaced personal data from omitted preserved history', async () => {
  const expanded = expandedReview();
  service.review.mockResolvedValue(ready(expanded));
  mount();
  await choose();
  expect(screen.getByLabelText('Private recipe notes: current 2, backup 4')).toBeTruthy();
  expect(
    screen.getByText(
      'Will replace: private recipe notes, personal collections and memberships, and manual shopping items.',
    ),
  ).toBeTruthy();
  expect(screen.getByText('Will preserve: cooking history and its private notes.')).toBeTruthy();
  expect(screen.queryByText('Cooking history entries')).toBeNull();
  expect(service.prepare).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel restore review' }));
  expect(service.execute).not.toHaveBeenCalled();
});

test('an included empty history is an explicit replacement and committed counts are authoritative', async () => {
  const expanded = expandedReview(0);
  service.review.mockResolvedValue(ready(expanded));
  service.execute.mockResolvedValue({
    kind: 'receipt',
    receipt: {
      ...receipt,
      replacedScopes: ['core', 'personal', 'cookingHistory'],
      restoredCounts: {
        ...receipt.restoredCounts,
        personal: { ...personalCounts, notes: 4 },
        cookingHistory: 0,
      },
    },
  });
  mount();
  await choose();
  expect(screen.getByLabelText('Cooking history entries: current 7, backup 0')).toBeTruthy();
  expect(screen.getByText('Will replace: cooking history and its private notes.')).toBeTruthy();
  expect(screen.getByText(/An empty included history replaces it with an empty list/)).toBeTruthy();
  expect(screen.getByText(/Imported history receives new local IDs/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await screen.findByText('Restore committed');
  expect(service.prepare.mock.calls[0]?.[0]).toBe(expanded);
  expect(screen.getByLabelText('Recorded Cooking history entries: 0')).toBeTruthy();
  expect(screen.getByLabelText('Recorded Private recipe notes: 4')).toBeTruthy();
  expect(screen.getByText('Replaced: cooking history and its private notes.')).toBeTruthy();
  expect(
    screen.getByText(
      /Clearing visible notes, collections, manual items or cooking history does not erase either retained archive/,
    ),
  ).toBeTruthy();
});

test('expanded files remain inspectable but cannot restore into an unsupported workspace', async () => {
  service.review.mockResolvedValue(
    ready({ ...expandedReview(), blockers: ['expanded_storage_unavailable'] }),
  );
  mount();
  fireEvent.press(screen.getByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('Review replacement');
  expect(
    screen.getByText(/does not support the file’s expanded personal-data format/),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Replace local cooking data' })).toBeDisabled();
  expect(service.prepare).not.toHaveBeenCalled();
});

test('cancelled file picker starts no review or mutation', async () => {
  transfer.pickFile.mockResolvedValue({ kind: 'cancelled' });
  mount();
  fireEvent.press(screen.getByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('No restore file selected. Nothing was replaced.');
  expect(service.review).not.toHaveBeenCalled();
  expect(service.execute).not.toHaveBeenCalled();
});

test('invalid file review gives no confirmation or prepare', async () => {
  service.review.mockResolvedValue({
    kind: 'failed',
    error: { code: 'invalid_input', messageKey: 'restore.checksum_mismatch', retry: 'never' },
  });
  mount();
  fireEvent.press(screen.getByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText(/does not match its integrity check/);
  expect(screen.queryByRole('button', { name: 'Replace local cooking data' })).toBeNull();
  expect(service.prepare).not.toHaveBeenCalled();
});

test('confirms exact issued objects only after the operation reference is durably retained', async () => {
  const remembered = deferred<readonly RestoreReference[]>();
  references.remember.mockReturnValue(remembered.promise);
  mount();
  await choose();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await waitFor(() => expect(references.remember).toHaveBeenCalled());
  expect(service.prepare.mock.calls[0]?.[0]).toBe(review);
  expect(references.remember).toHaveBeenCalledWith(installation, {
    operationId,
    preparedAt: expect.any(String),
  });
  expect(service.execute).not.toHaveBeenCalled();
  await act(async () => remembered.resolve([{ operationId, preparedAt: timestamp }]));
  await screen.findByText('Restore committed');
  expect(service.execute.mock.calls[0]?.[0]).toBe(prepared);
  expect(service.execute).toHaveBeenCalledTimes(1);
  expect(references.forget).not.toHaveBeenCalled();
  expect(
    screen.getByText('2 purchased checks restored; 1 imported checks left unchecked.'),
  ).toBeTruthy();
  expect(screen.getByLabelText('Recorded Purchased checks: 2')).toBeTruthy();
  expect(screen.getByLabelText('Recorded Preference removal records: 0')).toBeTruthy();
  expect(screen.queryByLabelText('Recorded Purchased checks: 3')).toBeNull();
  expect(service.readArchive).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Export pre-restore snapshot' }));
  await screen.findByText(/Archive download requested/);
  expect(service.readArchive).toHaveBeenCalledWith(operationId, 'before');
  expect(transfer.exportFile).toHaveBeenCalledWith('{"verified":"archive"}');
});

test('failed reference persistence prevents execution without deleting old recovery records', async () => {
  references.remember.mockRejectedValue(new Error('Storage unavailable'));
  mount();
  await choose();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await screen.findByText(/operation ID could not be retained/);
  expect(service.execute).not.toHaveBeenCalled();
  expect(screen.queryByText('Restore committed')).toBeNull();
});

test.each([
  { ...review, blockers: ['catalogue_mismatch' as const], shopping: null },
  { ...review, warnings: [...portableRestoreWarnings, 'future_unknown_consequence'] },
])('unresolved blockers or unknown consequences cannot be confirmed', async (blockedReview) => {
  service.review.mockResolvedValue(ready(blockedReview));
  mount();
  fireEvent.press(screen.getByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('Review replacement');
  expect(screen.getByRole('button', { name: 'Replace local cooking data' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  expect(service.prepare).not.toHaveBeenCalled();
});

test('stale approval needs another explicit review and confirmation, not a retry', async () => {
  service.prepare.mockResolvedValueOnce({
    kind: 'failed',
    error: { code: 'stale_context', messageKey: 'restore.workspace_changed', retry: 'never' },
  });
  mount();
  await choose();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await screen.findByText(/workspace or action state changed/);
  expect(service.execute).not.toHaveBeenCalled();
  expect(service.review).toHaveBeenCalledTimes(1);
  const freshReview = { ...review, reviewId: 'fresh', expectedRevision: 8 };
  service.review.mockResolvedValueOnce(ready(freshReview));
  fireEvent.press(screen.getByRole('button', { name: 'Refresh restore review' }));
  await screen.findByText('Review replacement');
  expect(service.prepare).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await screen.findByText('Restore committed');
  expect(service.prepare.mock.calls[1]?.[0]).toBe(freshReview);
});

test('uncertain result queries proof and never replays an absent receipt or offers unproved archives', async () => {
  service.execute.mockResolvedValue({ kind: 'uncertain', operationId, error: failure });
  service.readReceipt.mockResolvedValueOnce(ready(null));
  mount();
  await choose();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await screen.findByText('Restore result is uncertain');
  expect(screen.getByRole('button', { name: 'Choose file to review restore' })).toBeDisabled();
  expect(service.readReceipt).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Check restore receipt' }));
  await screen.findByText('No committed receipt found');
  expect(references.forget).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Export pre-restore snapshot' })).toBeNull();
  expect(service.execute).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'Check restore receipt again' }));
  await screen.findByText('Restore committed');
  expect(service.execute).toHaveBeenCalledTimes(1);
  expect(service.readArchive).not.toHaveBeenCalled();
});

test('reopening discovers retained references without automatically executing or reading private archives', async () => {
  references.load.mockResolvedValue([{ operationId, preparedAt: timestamp }]);
  mount();
  const button = await screen.findByRole('button', { name: 'Check saved restore b0000000' });
  expect(service.readReceipt).not.toHaveBeenCalled();
  expect(service.execute).not.toHaveBeenCalled();
  fireEvent.press(button);
  await screen.findByText('Restore committed');
  expect(service.readReceipt).toHaveBeenCalledWith(operationId);
  expect(transfer.pickFile).not.toHaveBeenCalled();
  expect(service.readArchive).not.toHaveBeenCalled();
});

test('a receipt for another operation never grants archive access', async () => {
  references.load.mockResolvedValue([{ operationId, preparedAt: timestamp }]);
  service.readReceipt.mockResolvedValue(
    ready({ ...receipt, operationId: 'b0000000-0000-4000-8000-000000000002' }),
  );
  mount();
  fireEvent.press(await screen.findByRole('button', { name: 'Check saved restore b0000000' }));
  await screen.findByText(/returned receipt does not identify this operation/);
  expect(screen.queryByText('Restore committed')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Export pre-restore snapshot' })).toBeNull();
});

test('reference hydration can finish while file review is underway', async () => {
  const identity = deferred<RepositoryResult<string>>();
  readInstallationId.mockReturnValue(identity.promise);
  mount();
  fireEvent.press(screen.getByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('Review replacement');
  expect(screen.getByRole('button', { name: 'Replace local cooking data' })).toBeDisabled();
  await act(async () => identity.resolve(ready(installation)));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Replace local cooking data' })).not.toBeDisabled(),
  );
});

test('leaving during reference persistence cannot later start the replacement', async () => {
  const remembered = deferred<readonly RestoreReference[]>();
  references.remember.mockReturnValue(remembered.promise);
  const view = mount();
  await choose();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await waitFor(() => expect(references.remember).toHaveBeenCalled());
  view.unmount();
  await act(async () => remembered.resolve([{ operationId, preparedAt: timestamp }]));
  expect(service.execute).not.toHaveBeenCalled();
  expect(references.forget).toHaveBeenCalledWith(installation, operationId, 'not_dispatched');
  expect(transfer.dispose).toHaveBeenCalledTimes(1);
});

test('leaving after execute starts retains the operation reference for later proof lookup', async () => {
  const execution = deferred<Awaited<ReturnType<PortableRestoreService['execute']>>>();
  service.execute.mockReturnValue(execution.promise);
  const view = mount();
  await choose();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await waitFor(() => expect(service.execute).toHaveBeenCalledTimes(1));
  expect(references.remember).toHaveBeenCalledWith(installation, {
    operationId,
    preparedAt: expect.any(String),
  });
  view.unmount();
  await act(async () => execution.resolve({ kind: 'receipt', receipt }));
  expect(service.execute).toHaveBeenCalledTimes(1);
  expect(references.forget).not.toHaveBeenCalled();
  expect(service.readArchive).not.toHaveBeenCalled();
});

test('unavailable recovery storage blocks confirmation but does not start a replacement', async () => {
  references.load.mockRejectedValue(new Error('Future storage version'));
  mount();
  await screen.findByText('Recovery references unavailable');
  fireEvent.press(screen.getByRole('button', { name: 'Choose file to review restore' }));
  await screen.findByText('Review replacement');
  expect(screen.getByRole('button', { name: 'Replace local cooking data' })).toBeDisabled();
  expect(service.prepare).not.toHaveBeenCalled();
  expect(references.remember).not.toHaveBeenCalled();
});

test('a thrown execution is uncertain and retains its operation ID for proof checking', async () => {
  service.execute.mockRejectedValue(new Error('Acknowledgement lost'));
  mount();
  await choose();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await screen.findByText('Restore result is uncertain');
  expect(screen.getByText(`Operation ID: ${operationId}`)).toBeTruthy();
  expect(service.execute).toHaveBeenCalledTimes(1);
  expect(service.readReceipt).not.toHaveBeenCalled();
  expect(references.forget).not.toHaveBeenCalled();
});

test('failed archive verification never offers a file', async () => {
  references.load.mockResolvedValue([{ operationId, preparedAt: timestamp }]);
  service.readArchive.mockResolvedValue({ kind: 'failed', error: failure });
  mount();
  fireEvent.press(await screen.findByRole('button', { name: 'Check saved restore b0000000' }));
  await screen.findByText('Restore committed');
  fireEvent.press(screen.getByRole('button', { name: 'Export original imported file' }));
  await screen.findByText(/retained archive could not be verified/);
  expect(service.readArchive).toHaveBeenCalledWith(operationId, 'imported');
  expect(transfer.exportFile).not.toHaveBeenCalled();
});

test('browser archive fallback reveals exact verified bytes only on request and awaits clipboard confirmation', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const copied = deferred<void>();
  references.load.mockResolvedValue([{ operationId, preparedAt: timestamp }]);
  transfer.exportFile.mockRejectedValue(new Error('Embedded download unavailable'));
  const copyText = mockPort<NonNullable<BackupTransfer['copyText']>>().mockReturnValue(
    copied.promise,
  );
  transfer.copyText = copyText;
  mount();
  fireEvent.press(await screen.findByRole('button', { name: 'Check saved restore b0000000' }));
  await screen.findByText('Restore committed');
  fireEvent.press(screen.getByRole('button', { name: 'Export original imported file' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Show archive JSON' })).not.toBeDisabled(),
  );
  expect(screen.queryByLabelText('Retained archive JSON')).toBeNull();
  expect(copyText).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Show archive JSON' }));
  expect(screen.getByLabelText('Retained archive JSON').props.value).toBe('{"verified":"archive"}');
  expect(screen.getByLabelText('Retained archive JSON').props.editable).toBe(false);
  fireEvent.press(screen.getByRole('button', { name: 'Copy archive JSON' }));
  expect(copyText).toHaveBeenCalledWith('{"verified":"archive"}');
  expect(screen.queryByText(/Archive copied to the clipboard/)).toBeNull();
  await act(async () => copied.resolve());
  await screen.findByText(/copying alone is not a saved backup/);
});

test('repeated definite failures release their own references without exhausting the twenty-slot journal', async () => {
  let stored: string | null = null;
  const actualReferences = createRestoreReferenceStore({
    read: async () => stored,
    write: async (_key, value) => {
      stored = value;
    },
  });
  references.load.mockImplementation(actualReferences.load);
  references.remember.mockImplementation(actualReferences.remember);
  references.forget.mockImplementation(actualReferences.forget);
  let nextId = 0;
  service.prepare.mockImplementation(async () =>
    ready({
      ...prepared,
      operationId: `b0000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    }),
  );
  service.execute.mockResolvedValue({ kind: 'failed', error: failure });
  mount();
  for (let attempt = 0; attempt < 22; attempt++) {
    await choose();
    fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
    await screen.findByText(/Restore failed\./);
  }
  expect(service.execute).toHaveBeenCalledTimes(22);
  expect(references.forget).toHaveBeenCalledTimes(22);
  expect(await actualReferences.load(installation)).toEqual([]);
  expect(screen.queryByText('Recovery references unavailable')).toBeNull();
});

test('cleanup failure retains a readable reference and blocks new confirmation without claiming uncertainty about a known failure', async () => {
  service.execute.mockResolvedValue({ kind: 'failed', error: failure });
  references.forget.mockRejectedValue(new Error('Storage cleanup blocked'));
  mount();
  await choose();
  fireEvent.press(screen.getByRole('button', { name: 'Replace local cooking data' }));
  await screen.findByText(/This attempt did not replace your workspace/);
  expect(references.forget).toHaveBeenCalledWith(installation, operationId, 'definite_failure');
  expect(screen.getByRole('button', { name: 'Check retained recovery reference' })).toBeTruthy();
  expect(screen.queryByText('Restore result is uncertain')).toBeNull();
  expect(screen.getByRole('button', { name: 'Check saved restore b0000000' })).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Refresh restore review' }));
  await screen.findByText('Review replacement');
  expect(screen.getByRole('button', { name: 'Replace local cooking data' })).toBeDisabled();
  expect(service.execute).toHaveBeenCalledTimes(1);
});
