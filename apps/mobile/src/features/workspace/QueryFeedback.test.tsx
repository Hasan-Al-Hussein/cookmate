import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { QueryFeedback } from './WorkspaceFeedback';
import type { QueryState } from './WorkspaceProvider';
import { motionTokens } from '../../design/motion';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test('initial loading has immediate accessible status but delays its visible notice', () => {
  const view = render(<QueryFeedback state={{ kind: 'loading' }} retry={jest.fn()} noun="meals" />);
  expect(screen.getByRole('progressbar', { name: 'Loading meals' })).toBeTruthy();
  expect(screen.queryByText('Loading meals…')).toBeNull();
  act(() => jest.advanceTimersByTime(motionTokens.delay.pending));
  expect(screen.getByText('Loading meals…')).toBeTruthy();
  view.rerender(
    <QueryFeedback
      state={{ kind: 'ready', value: [], revision: 1 }}
      retry={jest.fn()}
      noun="meals"
    />,
  );
  expect(screen.queryByText('Loading meals…')).toBeNull();
});

test('stale-data explanation and errors bypass the presentation delay; retry remains usable', () => {
  const retry = jest.fn();
  const view = render(
    <QueryFeedback state={{ kind: 'loading', previous: [] }} retry={retry} noun="meals" />,
  );
  expect(screen.getByText('Loading meals…')).toBeTruthy();
  expect(screen.getByText(/The previous view is shown below/)).toBeTruthy();
  const failed: QueryState<unknown[]> = {
    kind: 'failed',
    error: { code: 'storage_failure', messageKey: 'test.read_failed', retry: 'after_correction' },
  };
  view.rerender(<QueryFeedback state={failed} retry={retry} noun="meals" />);
  expect(screen.getByText('Couldn’t load meals')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Retry loading meals' }));
  expect(retry).toHaveBeenCalledTimes(1);
});
