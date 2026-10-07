import { StrictMode } from 'react';
import { Text } from 'react-native';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { createBundledContentReader, type ReadingLookup } from '@cookmate/catalogue/content';
import {
  BundledOrdinaryCatalogueProvider,
  ContentOrdinaryCatalogueProvider,
  OrdinaryCatalogueProvider,
  useOptionalOrdinaryCatalogue,
} from './OrdinaryCatalogue';
import { createBundledOrdinaryCatalogue } from './ordinaryCatalogueState';
import type { ContentWorkspaceState } from './contentWorkspaceHost';

jest.mock('../../domain/commandPlatform', () => ({
  nativeCommandPlatform: {
    sha256: async (text: string) =>
      require('node:crypto').createHash('sha256').update(text).digest('hex'),
  },
}));
const sha256 = async (text: string) =>
  require('node:crypto').createHash('sha256').update(text).digest('hex') as string;
afterEach(cleanup);

function Consumer() {
  const context = useOptionalOrdinaryCatalogue();
  if (!context) return <Text>No mounted catalogue; retain legacy caller</Text>;
  const { state } = context;
  return (
    <Text>
      {state.kind === 'ready'
        ? `${state.mode}:${state.recipes.length}:${state.scopeKey}:${state.photoMode}`
        : state.kind}
    </Text>
  );
}

test('ordinary callers can remain unchanged without a provider', () => {
  expect(render(<Consumer />).getByText('No mounted catalogue; retain legacy caller')).toBeTruthy();
});

test('default provider owns the real bundled reader and survives effect replay without a content opt-in', async () => {
  const view = render(
    <StrictMode>
      <BundledOrdinaryCatalogueProvider>
        <Consumer />
      </BundledOrdinaryCatalogueProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(view.getByText('bundled:100:bundled:bundled')).toBeTruthy());
  view.rerender(
    <StrictMode>
      <BundledOrdinaryCatalogueProvider scopeKey="other-owner">
        <Consumer />
      </BundledOrdinaryCatalogueProvider>
    </StrictMode>,
  );
  expect(view.queryByText('bundled:100:bundled:bundled')).toBeNull();
  await waitFor(() => expect(view.getByText('bundled:100:other-owner:bundled')).toBeTruthy());
});

test('borrowed provider leaves controller lifetime to its workspace owner', async () => {
  const controller = createBundledOrdinaryCatalogue({ scopeKey: 'borrowed', sha256 });
  const view = render(
    <OrdinaryCatalogueProvider controller={controller}>
      <Consumer />
    </OrdinaryCatalogueProvider>,
  );
  await waitFor(() => expect(view.getByText('bundled:100:borrowed:bundled')).toBeTruthy());
  view.unmount();
  expect(controller.getSnapshot().kind).toBe('ready');
  controller.close();
});

test('content provider responds to host revocation and detaches its adapter without closing host resources', async () => {
  const reading = await createBundledContentReader(sha256);
  let state: Readonly<ContentWorkspaceState> = {
    status: 'ready',
    scopeKey: 'host:1',
    pending: null,
    cleanupPending: 0,
  };
  const listeners = new Set<() => void>();
  const envelope = <Value,>(value: Value) => ({
    installationId: '10000000-0000-4000-8000-000000000001',
    ownerId: null,
    head: null,
    adoptionRevision: 0,
    identity: reading.identity,
    value,
  });
  const host = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    content: {
      discover: async () => envelope(reading.recipes),
      readCurrent: async (id: string) => envelope<ReadingLookup>(reading.lookupCurrent(id)),
      readExact: async (ref: Parameters<typeof reading.lookupExact>[0]) =>
        envelope<ReadingLookup>(reading.lookupExact(ref)),
      readPhoto: async () => {
        throw new Error('No photo read in this presentation test');
      },
      readPhotos: async () => {
        throw new Error('No photo batch read in this presentation test');
      },
    },
    onPhotoCleanupFailure: jest.fn(),
    close: jest.fn(),
  };
  const view = render(
    <ContentOrdinaryCatalogueProvider host={host}>
      <Consumer />
    </ContentOrdinaryCatalogueProvider>,
  );
  await waitFor(() => expect(view.getByText('content:100:host:1:verified')).toBeTruthy());
  act(() => {
    state = { ...state, status: 'revoked', scopeKey: 'host:2' };
    for (const listener of listeners) listener();
  });
  expect(view.getByText('unavailable')).toBeTruthy();
  expect(view.queryByText('content:100:host:1:verified')).toBeNull();
  view.unmount();
  expect(listeners.size).toBe(0);
  expect(host.close).not.toHaveBeenCalled();
});
