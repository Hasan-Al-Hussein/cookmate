import { useState } from 'react';
import { Animated, I18nManager, StyleSheet, TextInput } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { TabSelection } from './TabSelection';
import { ThemeTransition } from './ThemeTransition';

let mockReduced = false;
let mockLayout = { width: 428, fontScale: 1 };
jest.mock('../hooks/useNativeLayout', () => ({ useNativeLayout: () => mockLayout }));
let mockTheme = { color: { canvas: '#fff' } };
jest.mock('../design/MotionPolicy', () => ({ useMotionPolicy: () => mockReduced }));
jest.mock('../design/ThemeProvider', () => ({ useTheme: () => mockTheme }));

beforeEach(() => {
  mockReduced = false;
  mockLayout = { width: 428, fontScale: 1 };
  mockTheme = { color: { canvas: '#fff' } };
  jest
    .spyOn(Animated, 'timing')
    .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
});
afterEach(() => jest.restoreAllMocks());

test('tab selection starts in place, glides on selection, and settles under reduced motion', () => {
  const view = render(<TabSelection position={{ x: 20, y: 10 }} selectionKey="discover" />);
  expect(Animated.timing).not.toHaveBeenCalled();
  view.rerender(<TabSelection position={{ x: 100, y: 10 }} selectionKey="plan" />);
  expect(Animated.timing).toHaveBeenCalledTimes(2);
  const position = jest.mocked(Animated.timing).mock.calls[0]![0] as Animated.Value;
  const stop = jest.spyOn(position, 'stopAnimation');
  const set = jest.spyOn(position, 'setValue');
  mockReduced = true;
  view.rerender(<TabSelection position={{ x: 180, y: 10 }} selectionKey="settings" />);
  expect(stop).toHaveBeenCalled();
  expect(set).toHaveBeenLastCalledWith(180);
  expect(Animated.timing).toHaveBeenCalledTimes(2);
});

test('wrapped tab rows and initial measurement never sweep across other controls', () => {
  const view = render(<TabSelection position={undefined} selectionKey="discover" />);
  view.rerender(<TabSelection position={{ x: 20, y: 10 }} selectionKey="discover" />);
  view.rerender(<TabSelection position={{ x: 100, y: 80 }} selectionKey="plan" />);
  expect(Animated.timing).not.toHaveBeenCalled();
});

test('RTL positions retain a physical-left origin instead of mirroring measured coordinates', () => {
  const original = I18nManager.isRTL;
  I18nManager.isRTL = true;
  try {
    const view = render(<TabSelection position={{ x: 180, y: 10 }} selectionKey="settings" />);
    const style = StyleSheet.flatten(
      view.getByTestId('tab-selection', { includeHiddenElements: true }).props.style,
    );
    expect(style.end).toBe(0);
    expect(style.left).toBeUndefined();
    expect(style.start).toBeUndefined();
  } finally {
    I18nManager.isRTL = original;
  }
});

function Draft() {
  const [value, setValue] = useState('');
  return <TextInput accessibilityLabel="Question draft" value={value} onChangeText={setValue} />;
}
test('theme motion preserves the mounted draft and stops when motion is reduced', () => {
  const view = render(
    <ThemeTransition>
      <Draft />
    </ThemeTransition>,
  );
  fireEvent.changeText(view.getByLabelText('Question draft'), 'Keep this question');
  mockTheme = { color: { canvas: '#151918' } };
  view.rerender(
    <ThemeTransition>
      <Draft />
    </ThemeTransition>,
  );
  expect(view.getByDisplayValue('Keep this question')).toBeTruthy();
  expect(Animated.timing).toHaveBeenCalledTimes(1);
  const opacity = jest.mocked(Animated.timing).mock.calls[0]![0] as Animated.Value;
  const stop = jest.spyOn(opacity, 'stopAnimation');
  const set = jest.spyOn(opacity, 'setValue');
  mockReduced = true;
  view.rerender(
    <ThemeTransition>
      <Draft />
    </ThemeTransition>,
  );
  expect(stop).toHaveBeenCalled();
  expect(set).toHaveBeenLastCalledWith(1);
  expect(view.getByDisplayValue('Keep this question')).toBeTruthy();
  expect(Animated.timing).toHaveBeenCalledTimes(1);
});

test('resize retires an offscreen capsule during selection motion, then snaps to fresh measurements', () => {
  const view = render(<TabSelection position={{ x: 200, y: 16 }} selectionKey="plan" />);
  view.rerender(<TabSelection position={{ x: 350, y: 16 }} selectionKey="settings" />);
  expect(Animated.timing).toHaveBeenCalledTimes(2);
  const x = jest.mocked(Animated.timing).mock.calls[0]![0] as Animated.Value;
  const stop = jest.spyOn(x, 'stopAnimation');
  const set = jest.spyOn(x, 'setValue');
  mockLayout = { width: 320, fontScale: 1 };
  view.rerender(<TabSelection position={{ x: 350, y: 16 }} selectionKey="settings" />);
  expect(view.queryByTestId('tab-selection', { includeHiddenElements: true })).toBeNull();
  expect(stop).toHaveBeenCalled();
  view.rerender(<TabSelection position={{ x: 270, y: 16 }} selectionKey="settings" />);
  expect(view.getByTestId('tab-selection', { includeHiddenElements: true })).toBeTruthy();
  expect(set).toHaveBeenLastCalledWith(270);
  expect(Animated.timing).toHaveBeenCalledTimes(2);
});

test('same selected tab layout changes and enlarged text snap without suppressing later tab motion', () => {
  const view = render(<TabSelection position={{ x: 20, y: 10 }} selectionKey="discover" />);
  view.rerender(<TabSelection position={{ x: 25, y: 10 }} selectionKey="discover" />);
  expect(Animated.timing).not.toHaveBeenCalled();
  mockLayout = { width: 320, fontScale: 1.5 };
  view.rerender(<TabSelection position={{ x: 25, y: 10 }} selectionKey="discover" />);
  view.rerender(<TabSelection position={{ x: 35, y: 10 }} selectionKey="discover" />);
  expect(Animated.timing).not.toHaveBeenCalled();
  view.rerender(<TabSelection position={{ x: 135, y: 10 }} selectionKey="plan" />);
  expect(Animated.timing).toHaveBeenCalledTimes(2);
});
