import { Animated, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { AnimatedDisclosure } from './AnimatedDisclosure';
import { motionTokens } from '../design/motion';

let mockReduced = false;
jest.mock('../design/MotionPolicy', () => ({ useMotionPolicy: () => mockReduced }));

beforeEach(() => {
  jest.spyOn(Animated, 'timing').mockReturnValue({
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  mockReduced = false;
});

test('opening exposes full natural-height content and actions without waiting for motion', () => {
  const openSource = jest.fn();
  const fullNote = 'Original source note: 320g spaghetti, 6 egg yolks and 150g bacon. '
    .repeat(20)
    .trim();
  const content = (expanded: boolean) => (
    <AnimatedDisclosure expanded={expanded} testID="source-details" style={{ gap: 8 }}>
      <Text>{fullNote}</Text>
      <Pressable accessibilityRole="button" onPress={openSource}>
        <Text>Open source</Text>
      </Pressable>
    </AnimatedDisclosure>
  );
  const view = render(content(false));
  expect(screen.queryByText(fullNote)).toBeNull();
  expect(Animated.timing).not.toHaveBeenCalled();
  view.rerender(content(true));
  expect(screen.getByText(fullNote).props.numberOfLines).toBeUndefined();
  const style = StyleSheet.flatten(screen.getByTestId('source-details').props.style);
  expect(style.height).toBeUndefined();
  expect(style.maxHeight).toBeUndefined();
  expect(style.overflow).toBeUndefined();
  expect(Animated.timing).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ duration: motionTokens.duration.disclosure, isInteraction: false }),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Open source' }));
  expect(openSource).toHaveBeenCalledTimes(1);
});

test('collapse removes content and actions immediately even while entry has not finished', () => {
  const content = (expanded: boolean) => (
    <AnimatedDisclosure expanded={expanded}>
      <Pressable accessibilityRole="button">
        <Text>Review source</Text>
      </Pressable>
    </AnimatedDisclosure>
  );
  const view = render(content(false));
  view.rerender(content(true));
  const animate = jest.mocked(Animated.timing);
  const progress = animate.mock.calls[0]![0] as Animated.Value;
  const stop = jest.spyOn(progress, 'stopAnimation');
  view.rerender(content(false));
  expect(screen.queryByRole('button', { name: 'Review source' })).toBeNull();
  expect(stop).toHaveBeenCalled();
  expect(animate).toHaveBeenCalledTimes(1);
  view.rerender(content(true));
  expect(animate).toHaveBeenCalledTimes(2);
  stop.mockClear();
  view.unmount();
  expect(stop).toHaveBeenCalled();
});

test('reduced or background policy settles entry immediately and never replays on resume', () => {
  const content = (expanded: boolean) => (
    <AnimatedDisclosure expanded={expanded}>
      <Text>Readable source note</Text>
    </AnimatedDisclosure>
  );
  const view = render(content(false));
  view.rerender(content(true));
  const animate = jest.mocked(Animated.timing);
  const progress = animate.mock.calls[0]![0] as Animated.Value;
  const stop = jest.spyOn(progress, 'stopAnimation');
  const set = jest.spyOn(progress, 'setValue');
  mockReduced = true;
  view.rerender(content(true));
  expect(stop).toHaveBeenCalled();
  expect(set).toHaveBeenLastCalledWith(1);
  expect(screen.getByText('Readable source note')).toBeTruthy();
  view.rerender(content(false));
  view.rerender(content(true));
  expect(animate).toHaveBeenCalledTimes(1);
  mockReduced = false;
  view.rerender(content(true));
  expect(animate).toHaveBeenCalledTimes(1);
});

function RetainedDraft() {
  const [draft, setDraft] = useState('');
  return <TextInput accessibilityLabel="Source draft" value={draft} onChangeText={setDraft} />;
}

test('initially expanded content is immediate and ordinary content updates preserve child state', () => {
  const content = (heading: string) => (
    <AnimatedDisclosure expanded>
      <Text>{heading}</Text>
      <RetainedDraft />
    </AnimatedDisclosure>
  );
  const view = render(content('Initial note'));
  expect(Animated.timing).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Source draft'), 'Keep this text');
  view.rerender(content('Updated note'));
  expect(screen.getByText('Updated note')).toBeTruthy();
  expect(screen.getByLabelText('Source draft').props.value).toBe('Keep this text');
  expect(Animated.timing).not.toHaveBeenCalled();
});
