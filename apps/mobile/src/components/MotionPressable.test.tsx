import { Animated, StyleSheet, Text } from 'react-native';
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { MotionPressable } from './MotionPressable';

let mockReducedMotion = true;
jest.mock('../design/MotionPolicy', () => ({ useMotionPolicy: () => mockReducedMotion }));

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  mockReducedMotion = true;
});

test('reduced motion keeps press feedback and executes the command immediately exactly once', () => {
  const command = jest.fn();
  const pressIn = jest.fn();
  const pressOut = jest.fn();
  const animate = jest.spyOn(Animated, 'timing');
  const view = render(
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel="Save recipe"
      onPress={command}
      onPressIn={pressIn}
      onPressOut={pressOut}
    >
      {({ pressed }) => <Text>{pressed ? 'Pressed' : 'Ready'}</Text>}
    </MotionPressable>,
  );
  const button = view.getByRole('button', { name: 'Save recipe' });
  fireEvent(button, 'pressIn');
  expect(view.getByText('Pressed')).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
  fireEvent.press(button);
  expect(command).toHaveBeenCalledTimes(1);
  fireEvent(button, 'pressOut');
  expect(view.getByText('Ready')).toBeTruthy();
  expect(command).toHaveBeenCalledTimes(1);
  expect(pressIn).toHaveBeenCalledTimes(1);
  expect(pressOut).toHaveBeenCalledTimes(1);
  expect(animate).not.toHaveBeenCalled();
});

test('an unfinished decorative animation cannot delay or repeat the actual command', () => {
  mockReducedMotion = false;
  const command = jest.fn();
  const start = jest.fn();
  // Deliberately never complete the animation: command execution must not depend on it.
  jest.spyOn(Animated, 'timing').mockReturnValue({ start, stop: jest.fn(), reset: jest.fn() });
  const view = render(
    <MotionPressable accessibilityRole="button" accessibilityLabel="Open recipe" onPress={command}>
      <Text>Open recipe</Text>
    </MotionPressable>,
  );
  const button = view.getByRole('button', { name: 'Open recipe' });
  fireEvent(button, 'pressIn');
  expect(start).toHaveBeenCalledTimes(1);
  fireEvent.press(button);
  expect(command).toHaveBeenCalledTimes(1);
  fireEvent(button, 'pressOut');
  expect(command).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(command).toHaveBeenCalledTimes(1);
});

test('a disabled control cannot execute its command with motion reduced', () => {
  const command = jest.fn();
  const view = render(
    <MotionPressable
      disabled
      accessibilityRole="button"
      accessibilityLabel="Save unavailable"
      onPress={command}
    >
      <Text>Save unavailable</Text>
    </MotionPressable>,
  );
  fireEvent.press(view.getByRole('button', { name: 'Save unavailable' }));
  expect(command).not.toHaveBeenCalled();
});

test.each(['disabled', 'reduced motion'] as const)(
  '%s interruption clears pressed visuals without waiting for a missing release event',
  (interruption) => {
    mockReducedMotion = false;
    const command = jest.fn();
    const animate = jest
      .spyOn(Animated, 'timing')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
    const content = (disabled = false) => (
      <MotionPressable disabled={disabled} accessibilityRole="button" onPress={command}>
        {({ pressed }) => <Text>{pressed ? 'Held' : 'Ready'}</Text>}
      </MotionPressable>
    );
    const view = render(content());
    fireEvent(view.getByRole('button'), 'pressIn');
    expect(view.getByText('Held')).toBeTruthy();
    const stop = jest.spyOn(Animated.Value.prototype, 'stopAnimation');
    const reset = jest.spyOn(Animated.Value.prototype, 'setValue');
    if (interruption === 'reduced motion') mockReducedMotion = true;
    view.rerender(content(interruption === 'disabled'));
    expect(view.getByText('Ready')).toBeTruthy();
    expect(stop).toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith(1);
    expect(command).not.toHaveBeenCalled();
    mockReducedMotion = false;
    view.rerender(content());
    expect(view.getByText('Ready')).toBeTruthy();
    expect(animate).toHaveBeenCalledTimes(1);
    fireEvent.press(view.getByRole('button'));
    expect(command).toHaveBeenCalledTimes(1);
  },
);

test('press scale preserves caller transforms once and keeps functional styles live', () => {
  const view = render(
    <MotionPressable
      accessibilityRole="button"
      style={({ pressed }) => [
        { transform: [{ rotate: '90deg' }, { scale: 0.9 }] },
        { backgroundColor: pressed ? '#214B3C' : '#FFFCF8' },
      ]}
    >
      <Text>Turn</Text>
    </MotionPressable>,
  );
  const button = view.getByRole('button');
  fireEvent(button, 'pressIn');
  const style = StyleSheet.flatten(view.getByRole('button').props.style);
  expect(style.transform).toHaveLength(3);
  expect(style.transform.slice(0, 2)).toEqual([{ rotate: '90deg' }, { scale: 0.9 }]);
  expect(style.backgroundColor).toBe('#214B3C');
  fireEvent(button, 'pressOut');
  expect(view.getByRole('button')).toHaveStyle({ backgroundColor: '#FFFCF8' });
});

test('string transforms retain their geometry and immediate press response without a competing scale', () => {
  mockReducedMotion = false;
  const animate = jest.spyOn(Animated, 'timing');
  const command = jest.fn();
  const view = render(
    <MotionPressable
      accessibilityRole="button"
      style={{ transform: 'translateX(4px) rotate(90deg)' }}
      onPress={command}
    >
      {({ pressed }) => <Text>{pressed ? 'Held' : 'Ready'}</Text>}
    </MotionPressable>,
  );
  const button = view.getByRole('button');
  fireEvent(button, 'pressIn');
  expect(view.getByText('Held')).toBeTruthy();
  expect(StyleSheet.flatten(button.props.style).transform).toBe('translateX(4px) rotate(90deg)');
  fireEvent.press(button);
  expect(command).toHaveBeenCalledTimes(1);
  expect(animate).not.toHaveBeenCalled();
});
