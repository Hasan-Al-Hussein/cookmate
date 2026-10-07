import { Text } from 'react-native';
import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import type { ContentWorkspaceHost, ContentWorkspaceState } from './contentWorkspaceHost';
import {
  OrdinaryContentWorkspaceProvider,
  useOptionalOrdinaryContentWorkspace,
} from './OrdinaryContentWorkspaceProvider';

jest.mock('../../domain/commandPlatform', () => ({ nativeCommandPlatform: { sha256: jest.fn() } }));
afterEach(cleanup);
function Consumer() {
  const state = useOptionalOrdinaryContentWorkspace();
  return (
    <Text>
      {state
        ? state.kind === 'ready'
          ? `ready:${state.scopeKey}`
          : `unavailable:${state.status}`
        : 'No content workspace'}
    </Text>
  );
}
function retiredHost(status: 'closed' | 'revoked') {
  const listeners = new Set<() => void>();
  const detach = jest.fn();
  const getSnapshot = jest.fn(
    (): ContentWorkspaceState => ({
      status,
      scopeKey: 'retired',
      pending: null,
      cleanupPending: 0,
    }),
  );
  const subscribe = jest.fn((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      detach();
    };
  });
  const cookingSubscribe = jest.fn(() => {
    throw new Error('Closed cooking store');
  });
  // Other capabilities intentionally absent: an already-retired host must not
  // reach any of them, nor acquire a new storage owner.
  const unavailable = jest.fn(async () => {
    throw new Error('Retired host cannot read recipes');
  });
  const host = {
    getSnapshot,
    subscribe,
    readerStore: { subscribe: cookingSubscribe },
    content: {
      discover: unavailable,
      readCurrent: unavailable,
      readExact: unavailable,
      readPhoto: unavailable,
      readPhotos: unavailable,
    },
    onPhotoCleanupFailure: jest.fn(),
    close: jest.fn(),
  } as unknown as ContentWorkspaceHost;
  return { host, listeners, detach, getSnapshot, subscribe, cookingSubscribe };
}
test('legacy callers have no content-workspace substitution', () => {
  expect(render(<Consumer />).getByText('No content workspace')).toBeTruthy();
});
test.each(['closed', 'revoked'] as const)(
  'mounting an already %s host renders unavailable without touching storage',
  async (status) => {
    const f = retiredHost(status);
    const view = render(
      <OrdinaryContentWorkspaceProvider host={f.host}>
        <Consumer />
      </OrdinaryContentWorkspaceProvider>,
    );
    await waitFor(() => expect(view.getByText(`unavailable:${status}`)).toBeTruthy());
    expect(f.cookingSubscribe).not.toHaveBeenCalled();
    view.unmount();
    expect(f.listeners.size).toBe(0);
    expect(f.host.close).not.toHaveBeenCalled();
  },
);
test('an opening subscription failure is displayed and cannot fall through to another host', async () => {
  const f = retiredHost('closed');
  f.subscribe.mockImplementation(() => {
    throw new Error('Unable to attach');
  });
  const next = retiredHost('closed');
  const view = render(
    <OrdinaryContentWorkspaceProvider host={f.host}>
      <Consumer />
    </OrdinaryContentWorkspaceProvider>,
  );
  await waitFor(() => expect(view.getByText('unavailable:failed')).toBeTruthy());
  view.rerender(
    <OrdinaryContentWorkspaceProvider host={next.host}>
      <Consumer />
    </OrdinaryContentWorkspaceProvider>,
  );
  await waitFor(() => expect(view.getByText('unavailable:failed')).toBeTruthy());
  expect(next.subscribe).not.toHaveBeenCalled();
});
test('callback-triggered cleanup failure remains a barrier on provider host replacement', async () => {
  const f = retiredHost('closed'),
    next = retiredHost('closed');
  const view = render(
    <OrdinaryContentWorkspaceProvider host={f.host}>
      <Consumer />
    </OrdinaryContentWorkspaceProvider>,
  );
  await waitFor(() => expect(view.getByText('unavailable:closed')).toBeTruthy());
  f.detach.mockImplementationOnce(() => {
    throw new Error('Detach unconfirmed');
  });
  f.getSnapshot.mockImplementation(() => {
    throw new Error('Owner read failed');
  });
  act(() => {
    for (const notify of [...f.listeners]) notify();
  });
  expect(view.getByText('unavailable:failed')).toBeTruthy();
  view.rerender(
    <OrdinaryContentWorkspaceProvider host={next.host}>
      <Consumer />
    </OrdinaryContentWorkspaceProvider>,
  );
  await waitFor(() => expect(view.getByText('unavailable:failed')).toBeTruthy());
  expect(next.subscribe).not.toHaveBeenCalled();
  expect(f.host.close).not.toHaveBeenCalled();
});
