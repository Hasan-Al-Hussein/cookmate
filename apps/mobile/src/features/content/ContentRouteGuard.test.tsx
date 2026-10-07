import { Text } from 'react-native';
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { ContentRouteGuard } from './ContentRouteGuard';
import { OrdinaryContentRuntimeContext } from './ordinaryContentRuntimeContext';
import type { PrivateContentRuntime } from './privateContentRuntime';
import { ContentAccountContext, type ContentAccountContextValue } from './contentAccountContext';

const mockPush = jest.fn();
const mockSetParams = jest.fn();
const mockPageHeader = jest.fn((_props: { onBack?: () => void }) => null);
const mockBackup = jest.fn((_props: unknown) => null);
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, setParams: mockSetParams }),
}));
jest.mock('../backup/ContentBackupSettings', () => ({
  ContentBackupSettings: (props: unknown) => mockBackup(props),
}));
jest.mock('../../components/Page', () => ({
  Page: ({ children }: { children: React.ReactNode }) => children,
  PageHeader: (props: { onBack?: () => void }) => mockPageHeader(props),
}));
jest.mock('../settings/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
jest.mock('./ContentAccountScreen', () => ({
  ContentAccountScreen: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Configured account screen</Text>;
  },
}));
jest.mock('./ContentAccountCallback', () => ({
  ContentAccountCallback: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Configured account callback</Text>;
  },
}));
const forbidden = jest.fn(() => {
  throw new Error('Legacy route mounted');
});
const runtime = { host: {} } as PrivateContentRuntime; // Mount wiring only; host guards have separate coverage.
const account = {} as ContentAccountContextValue; // Guard presence only; no lifecycle actions invoked.
afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});
test.each([
  ['account', 'Configured account screen'],
  ['auth/callback', 'Configured account callback'],
])('configured %s mounts its account lifetime and never the legacy screen', (route, title) => {
  const Child = forbidden;
  const view = render(
    <ContentAccountContext.Provider value={account}>
      <OrdinaryContentRuntimeContext.Provider value={runtime}>
        <ContentRouteGuard route={route!} level="stack">
          <Child />
        </ContentRouteGuard>
      </OrdinaryContentRuntimeContext.Provider>
    </ContentAccountContext.Provider>,
  );
  expect(view.getByText(title!)).toBeTruthy();
  expect(forbidden).not.toHaveBeenCalled();
});
test.each(['assistant', 'account', 'auth/callback', 'proofs'])(
  'content route %s cannot invoke bundled or account-only hooks',
  (route) => {
    const Child = forbidden;
    const level = ['plan', 'assistant', 'favourites'].includes(route) ? 'tab' : 'stack';
    const view = render(
      <OrdinaryContentRuntimeContext.Provider value={runtime}>
        <ContentRouteGuard route={route} level={level}>
          <Child />
        </ContentRouteGuard>
      </OrdinaryContentRuntimeContext.Provider>,
    );
    expect(view.getByText('This content workspace is still being connected')).toBeTruthy();
    expect(forbidden).not.toHaveBeenCalled();
  },
);
test.each([
  ['index', 'tab'],
  ['plan', 'tab'],
  ['favourites', 'tab'],
  ['plan-edit', 'stack'],
  ['shopping-meals', 'stack'],
  ['cooking-history', 'stack'],
  ['recipe-personal/[id]', 'stack'],
  ['manual-shopping', 'stack'],
  ['collections', 'stack'],
  ['collection/[id]', 'stack'],
  ['(tabs)', 'stack'],
  ['recipe/[id]', 'stack'],
  ['private-content', 'stack'],
] as const)('content permits the actual %s route without replacing its screen', (route, level) => {
  const view = render(
    <OrdinaryContentRuntimeContext.Provider value={runtime}>
      <ContentRouteGuard route={route} level={level}>
        <Text>Ordinary screen</Text>
      </ContentRouteGuard>
    </OrdinaryContentRuntimeContext.Provider>,
  );
  expect(view.getByText('Ordinary screen')).toBeTruthy();
});
test('legacy paths remain unchanged; configured settings never mount legacy sections', () => {
  const view = render(
    <OrdinaryContentRuntimeContext.Provider value={null}>
      <ContentRouteGuard route="account" level="stack">
        <Text>Existing account screen</Text>
      </ContentRouteGuard>
    </OrdinaryContentRuntimeContext.Provider>,
  );
  expect(view.getByText('Existing account screen')).toBeTruthy();
  const Child = forbidden;
  view.rerender(
    <OrdinaryContentRuntimeContext.Provider value={runtime}>
      <ContentRouteGuard route="settings" level="tab">
        <Child />
      </ContentRouteGuard>
    </OrdinaryContentRuntimeContext.Provider>,
  );
  expect(view.getByText('Separate content installation')).toBeTruthy();
  fireEvent.press(view.getByRole('button', { name: 'Backup & files' }));
  expect(mockSetParams).toHaveBeenCalledWith({ section: 'backup' });
  expect(mockBackup).not.toHaveBeenCalled();
  view.rerender(
    <OrdinaryContentRuntimeContext.Provider value={runtime}>
      <ContentRouteGuard route="settings" level="tab" params={{ section: 'backup' }}>
        <Child />
      </ContentRouteGuard>
    </OrdinaryContentRuntimeContext.Provider>,
  );
  expect(mockBackup).toHaveBeenCalledWith({
    host: {
      getSnapshot: runtime.host.getSnapshot,
      subscribe: runtime.host.subscribe,
      backup: runtime.host.backup,
      restore: {
        service: runtime.host.restore,
        readInstallationId: runtime.host.readInstallationId,
      },
    },
    showTitle: false,
  });
  mockPageHeader.mock.calls.at(-1)![0].onBack?.();
  expect(mockSetParams).toHaveBeenLastCalledWith({ section: '' });
  expect(forbidden).not.toHaveBeenCalled();
});

test('configured Settings exposes planning defaults without mounting bundled settings or its data hooks', () => {
  const Child = forbidden;
  const tree = (section?: string) => (
    <OrdinaryContentRuntimeContext.Provider value={runtime}>
      <ContentRouteGuard route="settings" level="tab" {...(section ? { params: { section } } : {})}>
        <Child />
      </ContentRouteGuard>
    </OrdinaryContentRuntimeContext.Provider>
  );
  const view = render(tree());
  fireEvent.press(view.getByRole('button', { name: 'Planning defaults' }));
  expect(mockSetParams).toHaveBeenCalledWith({ section: 'planning' });
  view.rerender(tree('planning'));
  expect(view.getByText('Week starts on')).toBeTruthy();
  expect(view.getByRole('tab', { name: 'Monday' })).toBeSelected();
  expect(view.getByRole('tab', { name: 'Dinner' })).toBeSelected();
  expect(forbidden).not.toHaveBeenCalled();
});

test('configured recent-history privacy controls do not mount legacy settings', () => {
  const Child = forbidden;
  const view = render(
    <OrdinaryContentRuntimeContext.Provider value={runtime}>
      <ContentRouteGuard route="settings" level="tab" params={{ section: 'recently-viewed' }}>
        <Child />
      </ContentRouteGuard>
    </OrdinaryContentRuntimeContext.Provider>,
  );
  expect(view.getByText(/Remember recipes you open/)).toBeTruthy();
  expect(view.getByRole('tab', { name: 'Off' })).toBeSelected();
  expect(forbidden).not.toHaveBeenCalled();
});
