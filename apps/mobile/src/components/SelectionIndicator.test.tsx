import { useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { SelectionIndicator } from './SelectionIndicator';
import { motionTokens } from '../design/motion';

let mockReduced = false;
jest.mock('../design/MotionPolicy', () => ({ useMotionPolicy: () => mockReduced }));
beforeEach(() => {
  jest
    .spyOn(Animated, 'timing')
    .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  mockReduced = false;
});

test('initial and reduced selections settle without decorative work', () => {
  const view = render(
    <SelectionIndicator selected>
      <View />
    </SelectionIndicator>,
  );
  expect(Animated.timing).not.toHaveBeenCalled();
  mockReduced = true;
  view.rerender(
    <SelectionIndicator selected={false}>
      <View />
    </SelectionIndicator>,
  );
  expect(Animated.timing).not.toHaveBeenCalled();
  expect(
    screen.getByTestId('selection-indicator', { includeHiddenElements: true }).props.pointerEvents,
  ).toBe('none');
});

test('rapid input changes semantics immediately without waiting for decorative completion', () => {
  function Choice() {
    const [selected, setSelected] = useState(false);
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        onPress={() => setSelected(!selected)}
      >
        <Text>Choose date</Text>
        <SelectionIndicator selected={selected}>
          <View />
        </SelectionIndicator>
      </Pressable>
    );
  }
  render(<Choice />);
  const button = screen.getByRole('checkbox');
  fireEvent.press(button);
  expect(button.props.accessibilityState.checked).toBe(true);
  fireEvent.press(button);
  expect(button.props.accessibilityState.checked).toBe(false);
  fireEvent.press(button);
  expect(button.props.accessibilityState.checked).toBe(true);
  expect(jest.mocked(Animated.timing).mock.calls.map(([, config]) => config.toValue)).toEqual([
    1, 0, 1,
  ]);
  expect(Animated.timing).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ duration: motionTokens.duration.micro, isInteraction: false }),
  );
});
