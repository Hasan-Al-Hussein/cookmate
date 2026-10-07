import { useState } from 'react';
import { Animated, Keyboard, Modal, Platform, StyleSheet, Text, TextInput } from 'react-native';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { ActionButton } from './Controls';
import { FocusedSheet } from './FocusedSheet';
import { useSheetPresence } from './useSheetPresence';
import { motionTokens } from '../design/motion';
import { MealDateSelector } from '../features/workspace/MealDateSelector';
import { SelectionIndicator } from './SelectionIndicator';
import { PresenceModal, useModalAction } from './PresenceModal';

let mockReduced = false;
const mockFocusOrder: string[] = [];
type Completion = (result: { finished: boolean }) => void;
type Transition = { finish: Completion; stop: jest.Mock };
let transitions: Transition[] = [];
jest.mock('../design/MotionPolicy', () => ({ useMotionPolicy: () => mockReduced }));
jest.mock('./focusTarget', () => ({
  focusTarget: () => {
    mockFocusOrder.push('focus');
    return true;
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

beforeEach(() => {
  jest.useFakeTimers();
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockReduced = false;
  mockFocusOrder.length = 0;
  transitions = [];
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  jest.spyOn(Animated, 'timing').mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
  }));
  jest.spyOn(Animated, 'parallel').mockImplementation(() => {
    let completion: Completion | undefined;
    const transition = {
      finish: (result: { finished: boolean }) => completion?.(result),
      stop: jest.fn(() => completion?.({ finished: false })),
    };
    transitions.push(transition);
    return {
      start: jest.fn((callback?: Completion) => {
        completion = callback;
      }),
      stop: transition.stop,
      reset: jest.fn(),
    };
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function setup(visible = true) {
  const onShow = jest.fn();
  const onDismiss = jest.fn();
  const view = renderHook(
    ({ requested }: { requested: boolean }) =>
      useSheetPresence({
        visible: requested,
        onShow,
        onDismiss,
      }),
    { initialProps: { requested: visible } },
  );
  return { ...view, onShow, onDismiss };
}
function finish(index: number, finished = true) {
  act(() => transitions[index]!.finish({ finished }));
}

test('entry starts on actual show and dismissal waits for exit plus physical removal exactly once', () => {
  const view = setup();
  expect(view.result.current.phase).toBe('entering');
  expect(Animated.timing).not.toHaveBeenCalled();
  act(() => view.result.current.onShow());
  expect(view.onShow).toHaveBeenCalledTimes(1);
  expect(Animated.timing).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      duration: motionTokens.duration.sheet,
      useNativeDriver: true,
      isInteraction: false,
    }),
  );
  finish(0);
  expect(view.result.current.phase).toBe('open');
  act(() => view.result.current.onShow());
  expect(view.onShow).toHaveBeenCalledTimes(1);
  view.rerender({ requested: false });
  expect(view.result.current.phase).toBe('closing');
  expect(view.result.current.present).toBe(true);
  expect(Animated.timing).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      duration: motionTokens.duration.content,
      toValue: motionTokens.distance.contentEnter,
    }),
  );
  view.rerender({ requested: false });
  expect(transitions).toHaveLength(2);
  expect(view.onDismiss).not.toHaveBeenCalled();
  finish(1);
  expect(view.result.current.phase).toBe('closed');
  expect(view.result.current.present).toBe(false);
  expect(view.onDismiss).not.toHaveBeenCalled();
  act(() => {
    view.result.current.onDismiss();
    view.result.current.onDismiss();
  });
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
});

test('rapid reopen reverses exit and stale completion cannot close the active sheet', () => {
  const view = setup();
  act(() => view.result.current.onShow());
  finish(0);
  view.rerender({ requested: false });
  view.rerender({ requested: true });
  expect(transitions[1]!.stop).toHaveBeenCalledTimes(1);
  expect(view.result.current.phase).toBe('entering');
  finish(1);
  expect(view.result.current.present).toBe(true);
  expect(view.result.current.phase).toBe('entering');
  finish(2);
  expect(view.result.current.phase).toBe('open');
  expect(view.onDismiss).not.toHaveBeenCalled();
  expect(view.onShow).toHaveBeenCalledTimes(1);
  view.rerender({ requested: false });
  finish(3);
  act(() => view.result.current.onDismiss());
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
});

test('reopen after hiding waits for old native removal without delivering stale caller cleanup', () => {
  const view = setup();
  act(() => view.result.current.onShow());
  finish(0);
  view.rerender({ requested: false });
  finish(1);
  const oldDismiss = view.result.current.onDismiss;
  view.rerender({ requested: true });
  expect(view.result.current.present).toBe(false);
  act(() => oldDismiss());
  expect(view.result.current.phase).toBe('entering');
  expect(view.result.current.present).toBe(true);
  expect(view.onDismiss).not.toHaveBeenCalled();
  act(() => {
    oldDismiss();
    view.result.current.onShow();
  });
  expect(view.onShow).toHaveBeenCalledTimes(2);
  expect(view.onDismiss).not.toHaveBeenCalled();
});

test('reduced motion closes immediately but still waits for actual removal before callback', () => {
  mockReduced = true;
  const view = setup();
  act(() => view.result.current.onShow());
  expect(view.result.current.phase).toBe('open');
  expect(Animated.timing).not.toHaveBeenCalled();
  view.rerender({ requested: false });
  expect(view.result.current.present).toBe(false);
  expect(view.onDismiss).not.toHaveBeenCalled();
  act(() => view.result.current.onDismiss());
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
});

test('background/reduced policy settles exit, delivers deferred dismissal and never replays on resume', () => {
  const view = setup();
  act(() => view.result.current.onShow());
  finish(0);
  view.rerender({ requested: false });
  mockReduced = true;
  view.rerender({ requested: false });
  expect(view.result.current.present).toBe(false);
  expect(transitions[1]!.stop).toHaveBeenCalled();
  finish(1);
  act(() => view.result.current.onDismiss());
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
  mockReduced = false;
  view.rerender({ requested: false });
  expect(transitions).toHaveLength(2);
  expect(view.result.current.present).toBe(false);
});

test('an externally interrupted exit settles closed instead of retaining an invisible modal', () => {
  const view = setup();
  act(() => view.result.current.onShow());
  finish(0);
  view.rerender({ requested: false });
  finish(1, false);
  expect(view.result.current.present).toBe(false);
  act(() => view.result.current.onDismiss());
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
});

test('Android post-commit fallback delivers one dismissal even if a native callback also arrives', () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  const view = setup();
  act(() => view.result.current.onShow());
  finish(0);
  view.rerender({ requested: false });
  finish(1);
  expect(view.onDismiss).not.toHaveBeenCalled();
  act(() => jest.runOnlyPendingTimers());
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
  act(() => view.result.current.onDismiss());
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
});

test('close before show needs no animation and resolves after the hidden commit', () => {
  const view = setup();
  view.rerender({ requested: false });
  expect(view.result.current.present).toBe(false);
  expect(view.onDismiss).not.toHaveBeenCalled();
  act(() => jest.runOnlyPendingTimers());
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
  act(() => view.result.current.onShow());
  expect(view.onShow).not.toHaveBeenCalled();
  expect(Animated.timing).not.toHaveBeenCalled();
});

test('unmount cancels visual work and pending frame callbacks without invoking a stale caller', () => {
  const view = setup();
  act(() => view.result.current.onShow());
  view.rerender({ requested: false });
  view.unmount();
  finish(1);
  act(() => jest.runOnlyPendingTimers());
  expect(view.onDismiss).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('closed initialization never shows or dismisses a surface', () => {
  const view = setup(false);
  act(() => jest.runOnlyPendingTimers());
  expect(view.result.current.present).toBe(false);
  expect(view.onShow).not.toHaveBeenCalled();
  expect(view.onDismiss).not.toHaveBeenCalled();
});

test('sheet keeps the committed content inert through exit, then removes it before restoring focus', () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const onDismiss = jest.fn();
  const onClose = jest.fn();
  const content = (visible: boolean) => (
    <FocusedSheet
      visible={visible}
      title={visible ? 'Original source' : 'Cleared parent state'}
      onClose={onClose}
      onDismiss={onDismiss}
      onShow={() => mockFocusOrder.push('show')}
    >
      {visible ? <Text>Exact original source content</Text> : null}
    </FocusedSheet>
  );
  const view = render(content(true));
  const modal = screen.UNSAFE_getByType(Modal);
  const underlay = screen.getByTestId('focused-sheet-underlay');
  const underlayStyle = StyleSheet.flatten(underlay.props.style);
  expect(underlayStyle.backgroundColor).toBeTruthy();
  expect(underlayStyle.opacity).toBeUndefined();
  expect(underlayStyle.transform).toBeUndefined();
  fireEvent(modal, 'show');
  expect(mockFocusOrder).toEqual(['focus', 'show']);
  finish(0);
  view.rerender(content(false));
  expect(modal.props.visible).toBe(true);
  expect(modal.props.accessibilityLabel).toBe('Original source');
  expect(
    screen.getByText('Exact original source content', { includeHiddenElements: true }),
  ).toBeTruthy();
  expect(screen.queryByText('Exact original source content')).toBeNull();
  const surface = screen.UNSAFE_getAllByType(Animated.View).find((node) => node.props.inert);
  expect(surface?.props['aria-hidden']).toBe(true);
  expect(StyleSheet.flatten(underlay.props.style)).toEqual(underlayStyle);
  fireEvent(modal, 'requestClose');
  expect(onClose).not.toHaveBeenCalled();
  expect(Keyboard.dismiss).toHaveBeenCalledTimes(1);
  finish(1);
  expect(modal.props.visible).toBe(false);
  expect(
    screen.queryByText('Exact original source content', { includeHiddenElements: true }),
  ).toBeNull();
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent(modal, 'dismiss');
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('dirty close remains caller-guarded and a save happens before the decorative exit finishes', () => {
  const confirmClose = jest.fn(() => false);
  const save = jest.fn();
  const onDismiss = jest.fn();
  function Editor() {
    const [visible, setVisible] = useState(true);
    const [draft, setDraft] = useState('Keep this draft');
    return (
      <FocusedSheet
        visible={visible}
        title="Private note"
        onDismiss={onDismiss}
        onClose={() => {
          if (confirmClose()) setVisible(false);
        }}
      >
        <TextInput accessibilityLabel="Draft" value={draft} onChangeText={setDraft} />
        <ActionButton
          label="Save draft"
          onPress={() => {
            save(draft);
            setVisible(false);
          }}
        />
      </FocusedSheet>
    );
  }
  render(<Editor />);
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent(modal, 'show');
  finish(0);
  fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(confirmClose).toHaveBeenCalledTimes(1);
  expect(modal.props.visible).toBe(true);
  expect(screen.getByLabelText('Draft').props.value).toBe('Keep this draft');
  expect(Keyboard.dismiss).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Save draft' }));
  expect(save).toHaveBeenCalledWith('Keep this draft');
  expect(modal.props.visible).toBe(true);
  expect(onDismiss).not.toHaveBeenCalled();
  finish(1);
  fireEvent(modal, 'dismiss');
  expect(save).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('choosing a calendar day updates the date and visible selection before its exit completes', () => {
  const onChange = jest.fn();
  function Calendar() {
    const [value, setValue] = useState('2026-12-30');
    return (
      <MealDateSelector
        value={value}
        today="2026-09-30"
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Calendar />);
  fireEvent.press(screen.getByRole('button', { name: 'Choose from calendar' }));
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent(modal, 'show');
  finish(0);
  fireEvent.press(screen.getByRole('button', { name: 'Thursday 31 December 2026' }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('2026-12-31');
  expect(screen.getByText('Thursday 31 December 2026')).toBeTruthy();
  expect(modal.props.visible).toBe(true);
  const chosen = screen.getByLabelText('Thursday 31 December 2026', {
    includeHiddenElements: true,
  });
  const previous = screen.getByLabelText('Wednesday 30 December 2026', {
    includeHiddenElements: true,
  });
  expect(chosen).toBeSelected();
  expect(previous).not.toBeSelected();
  expect(chosen.findByType(SelectionIndicator).props.selected).toBe(true);
  expect(previous.findByType(SelectionIndicator).props.selected).toBe(false);
  expect(Animated.timing).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ duration: motionTokens.duration.micro, toValue: 1 }),
  );
  finish(1);
  expect(modal.props.visible).toBe(false);
  fireEvent(modal, 'dismiss');
  expect(onChange).toHaveBeenCalledTimes(1);
});

test('a retained modal keeps only inert visuals after approval and restores focus after physical dismissal', () => {
  const save = jest.fn();
  const onDismiss = jest.fn();
  function Review() {
    const [visible, setVisible] = useState(true);
    const approve = useModalAction(visible, () => {
      save();
      setVisible(false);
    });
    return (
      <PresenceModal
        visible={visible}
        accessibilityLabel={visible ? 'Review exact change' : 'No active review'}
        onRequestClose={() => setVisible(false)}
        onDismiss={onDismiss}
      >
        {visible && <Text>Current reviewed consequences</Text>}
        <ActionButton label="Apply reviewed change" onPress={approve} />
      </PresenceModal>
    );
  }
  render(<Review />);
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent(modal, 'show');
  finish(0);
  const stalePress = screen.UNSAFE_getByType(ActionButton).props.onPress as () => void;
  fireEvent.press(screen.getByRole('button', { name: 'Apply reviewed change' }));
  expect(save).toHaveBeenCalledTimes(1);
  expect(modal.props.visible).toBe(true);
  expect(modal.props.accessibilityLabel).toBe('Review exact change');
  expect(screen.queryByRole('button', { name: 'Apply reviewed change' })).toBeNull();
  expect(
    screen.getByText('Current reviewed consequences', { includeHiddenElements: true }),
  ).toBeTruthy();
  act(stalePress);
  expect(save).toHaveBeenCalledTimes(1);
  const underlay = StyleSheet.flatten(screen.getByTestId('presence-modal-underlay').props.style);
  expect(underlay.backgroundColor).toBeTruthy();
  expect(underlay.opacity).toBeUndefined();
  finish(1);
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent(modal, 'dismiss');
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('modal handlers use current authority and become inert after unmount', () => {
  const first = jest.fn();
  const latest = jest.fn();
  const view = renderHook(
    ({ active, action }: { active: boolean; action: () => void }) => useModalAction(active, action),
    {
      initialProps: { active: true, action: first },
    },
  );
  const oldHandler = view.result.current;
  view.rerender({ active: true, action: latest });
  act(oldHandler);
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
  view.rerender({ active: false, action: latest });
  act(oldHandler);
  expect(latest).toHaveBeenCalledTimes(1);
  view.unmount();
  act(oldHandler);
  expect(latest).toHaveBeenCalledTimes(1);
});
