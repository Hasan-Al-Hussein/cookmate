import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type {
  CookMateQueries,
  Immutable,
  PortableRestoreReceipt,
  PreparedPortableRestore,
  RepositoryResult,
} from '@cookmate/domain';
import type { PortableContentRestoreReview } from '../../data/portableContentRestore';
import { ActionButton } from '../../components/Controls';
import { RestoreSettings } from './RestoreSettings';
import type { RestoreSettingsPort } from './restoreSettingsPorts';
import type { RestoreReference, RestoreReferenceStore } from './restoreReferences';
import type { BackupTransfer } from './backupTransferTypes';

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('./backupTransfer', () => ({ createBackupTransfer: jest.fn() }));
const installation = 'a0000000-0000-4000-8000-000000000001';
const operationId = 'b0000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-02T08:00:00.000Z';
const counts = {
  favourites: 1,
  tombstones: 0,
  plannedMeals: 2,
  selectedMeals: 2,
  purchaseMarks: 1,
  purchasedItems: 1,
  preferences: 0,
  preferenceRemovals: 0,
};
const review: Immutable<PortableContentRestoreReview> = Object.freeze({
  reviewId: 'content-review-fixture',
  importFingerprint: 'a'.repeat(64),
  expectedRevision: 4,
  installationId: installation,
  ownerId: null,
  authGeneration: 1,
  adoptedHead: null,
  latestHead: null,
  adoptionRevision: 0,
  restoreEpoch: 0,
  storeRevision: 4,
  before: counts,
  after: counts,
  blockers: [],
  unknownRecipeIds: [],
  shopping: { restoredChecks: 1, uncheckedImportedChecks: 0 },
  warnings: ['personal_data_plaintext', 'cooking_history_is_not_included_and_stays_unchanged'],
  replacedScopes: ['core', 'personal'] as const,
});
const prepared: Immutable<PreparedPortableRestore> = Object.freeze({
  operationId,
  importFingerprint: review.importFingerprint,
  expectedRevision: 4,
});
// The content reader legitimately also returns a retained legacy receipt.
const receipt: Immutable<PortableRestoreReceipt> = Object.freeze({
  ...prepared,
  kind: 'portable_restore',
  committedAt: timestamp,
  revision: 5,
  beforeFingerprint: 'b'.repeat(64),
  shopping: { restoredChecks: 1, uncheckedImportedChecks: 0 },
  importedPreferenceRemovals: 0,
  restoredCounts: counts,
});
const ready = <T,>(value: T): RepositoryResult<T> => ({ kind: 'ready', value, revision: 4 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function port<F extends (...args: never[]) => unknown>() {
  return jest.fn<ReturnType<F>, Parameters<F>>();
}
type Service = RestoreSettingsPort<Immutable<PortableContentRestoreReview>>;
function fixture() {
  let current = true;
  const service: jest.Mocked<Service> = {
    review: port<Service['review']>().mockResolvedValue(ready(review)),
    prepare: port<Service['prepare']>().mockResolvedValue(ready(prepared)),
    execute: port<Service['execute']>().mockResolvedValue({ kind: 'receipt', receipt }),
    readReceipt: port<Service['readReceipt']>().mockResolvedValue(ready(receipt)),
    readArchive: port<Service['readArchive']>().mockResolvedValue(
      ready('{"original":"private exact archive"}'),
    ),
  };
  const references: jest.Mocked<RestoreReferenceStore> = {
    load: port<RestoreReferenceStore['load']>().mockResolvedValue([]),
    remember: port<RestoreReferenceStore['remember']>().mockImplementation(async (_id, value) => [
      value,
    ]),
    forget: port<RestoreReferenceStore['forget']>().mockResolvedValue([]),
  };
  const transfer: jest.Mocked<BackupTransfer> = {
    pickFile: port<BackupTransfer['pickFile']>().mockResolvedValue({
      kind: 'selected',
      serialized: '{"original":"format3 fixture"}',
    }),
    exportFile: port<BackupTransfer['exportFile']>().mockResolvedValue('download_requested'),
    dispose: jest.fn(),
  };
  const readInstallationId = port<CookMateQueries['readInstallationId']>().mockResolvedValue(
    ready(installation),
  );
  return {
    service,
    references,
    transfer,
    readInstallationId,
    createTransfer: () => transfer,
    isCurrent: () => current,
    retire: () => {
      current = false;
    },
  };
}
function mount(f: ReturnType<typeof fixture>) {
  return render(
    <RestoreSettings
      service={f.service}
      references={f.references}
      readInstallationId={f.readInstallationId}
      createTransfer={f.createTransfer}
      isCurrent={f.isCurrent}
      contentMode
    />,
  );
}
const button = (name: string) => screen.getByRole('button', { name });
function retained(name: string) {
  const node = screen.UNSAFE_getAllByType(ActionButton).find((row) => row.props.label === name);
  if (!node) throw new Error('Missing action');
  return node.props.onPress as () => void;
}
async function choose() {
  fireEvent.press(button('Choose file to review restore'));
  await screen.findByText('Review replacement');
  await waitFor(() => expect(button('Replace local cooking data')).not.toBeDisabled());
}
afterEach(cleanup);

test('exact content review and prepared capabilities stay unchanged, and references precede dispatch', async () => {
  const f = fixture();
  mount(f);
  await choose();
  expect(screen.getByText(/exact restored recipe versions/)).toBeTruthy();
  expect(screen.getByText('Will preserve: cooking history and its private notes.')).toBeTruthy();
  fireEvent.press(button('Replace local cooking data'));
  await screen.findByText('Restore committed');
  expect(f.service.prepare.mock.calls[0]?.[0]).toBe(review);
  expect(f.service.execute.mock.calls[0]?.[0]).toBe(prepared);
  expect(f.references.remember.mock.invocationCallOrder[0]).toBeLessThan(
    f.service.execute.mock.invocationCallOrder[0]!,
  );
  expect(f.references.remember).toHaveBeenCalledWith(installation, {
    operationId,
    preparedAt: expect.any(String),
  });
});
test.each([
  'content_unavailable',
  'history_unresolved',
  'account_operation_pending',
  'favourite_removal_conflict',
  'preference_removal_conflict',
] as const)('content blocker %s is explained and cannot prepare', async (blocker) => {
  const f = fixture();
  f.service.review.mockResolvedValue(ready({ ...review, blockers: [blocker] }));
  mount(f);
  fireEvent.press(button('Choose file to review restore'));
  await screen.findByText('Restore blocked');
  expect(button('Replace local cooking data')).toBeDisabled();
  expect(screen.queryByText('This restore cannot proceed.')).toBeNull();
  expect(f.service.prepare).not.toHaveBeenCalled();
});
test('empty included history has an explicit replacement consequence before confirmation', async () => {
  const f = fixture();
  f.service.review.mockResolvedValue(
    ready({
      ...review,
      after: { ...counts, cookingHistory: 0 },
      replacedScopes: ['core', 'personal', 'cookingHistory'],
      warnings: ['replaces_visible_history_with_new_local_ids'],
    }),
  );
  mount(f);
  await choose();
  expect(screen.getByText(/An empty included history replaces it with an empty list/)).toBeTruthy();
  expect(f.service.execute).not.toHaveBeenCalled();
});
test('scope retirement during installation lookup prevents recovery metadata hydration', async () => {
  const f = fixture(),
    gate = deferred<RepositoryResult<string>>();
  f.readInstallationId.mockReturnValue(gate.promise);
  mount(f);
  f.retire();
  await act(async () => gate.resolve(ready(installation)));
  expect(f.references.load).not.toHaveBeenCalled();
});
test('scope retirement during durable remember preserves ID and blocks late dispatch or cleanup', async () => {
  const f = fixture(),
    gate = deferred<readonly RestoreReference[]>();
  f.references.remember.mockReturnValue(gate.promise);
  mount(f);
  await choose();
  fireEvent.press(button('Replace local cooking data'));
  await waitFor(() => expect(f.references.remember).toHaveBeenCalled());
  f.retire();
  await act(async () => gate.resolve([{ operationId, preparedAt: timestamp }]));
  expect(f.service.execute).not.toHaveBeenCalled();
  expect(f.references.forget).not.toHaveBeenCalled();
});
test('cancelled and owner-retired confirmation callbacks cannot prepare an old review', async () => {
  const f = fixture();
  mount(f);
  await choose();
  const confirm = retained('Replace local cooking data');
  fireEvent.press(button('Cancel restore review'));
  await act(async () => confirm());
  expect(f.service.prepare).not.toHaveBeenCalled();
  await choose();
  const next = retained('Replace local cooking data');
  f.retire();
  await act(async () => next());
  expect(f.service.prepare).not.toHaveBeenCalled();
});
test('lost acknowledgement remains metadata-only and a reopened legacy receipt is checked without replay', async () => {
  const f = fixture();
  f.service.execute.mockRejectedValue(new Error('lost acknowledgement'));
  const view = mount(f);
  await choose();
  fireEvent.press(button('Replace local cooking data'));
  await screen.findByText('Restore result is uncertain');
  view.unmount();
  f.references.load.mockResolvedValue([{ operationId, preparedAt: timestamp }]);
  mount(f);
  fireEvent.press(await screen.findByRole('button', { name: 'Check saved restore b0000000' }));
  await screen.findByText('Restore committed');
  expect(f.service.execute).toHaveBeenCalledTimes(1);
  expect(f.service.readReceipt).toHaveBeenCalledWith(operationId);
  expect(f.service.readArchive).not.toHaveBeenCalled();
});
test('archive dispatch failure makes no false non-delivery claim', async () => {
  const f = fixture();
  f.references.load.mockResolvedValue([{ operationId, preparedAt: timestamp }]);
  f.transfer.exportFile.mockRejectedValue(new Error('cleanup failed after dispatch'));
  mount(f);
  fireEvent.press(await screen.findByRole('button', { name: 'Check saved restore b0000000' }));
  await screen.findByText('Restore committed');
  fireEvent.press(button('Export original imported file'));
  await screen.findByText(/A download or share may already have been offered/);
  expect(f.transfer.exportFile).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/No archive file was offered/)).toBeNull();
});
