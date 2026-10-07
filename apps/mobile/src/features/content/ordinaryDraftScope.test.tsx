import { Platform, Text } from 'react-native';
import { act, cleanupAsync, render } from '@testing-library/react-native';
import { AssistantEntryProvider, useAssistantEntry } from '../assistant/AssistantEntryState';

let entry: ReturnType<typeof useAssistantEntry>;
function Probe() {
  entry = useAssistantEntry();
  return <Text>{entry.previewDraft}</Text>;
}

test('content questions persist only in their installation scope, retaining the existing guest draft', async () => {
  const initialWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const guestKey = 'cookmate.preview.assistant-draft.v1';
  const scope = 'content:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const scopedKey = `${guestKey}.${encodeURIComponent(scope)}`;
  const stored = new Map([
    [guestKey, 'Existing guest question'],
    [scopedKey, 'Prepared content question'],
  ]);
  jest.replaceProperty(Platform, 'OS', 'web');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          stored.set(key, value);
        },
      },
    },
  });
  try {
    const view = render(
      <AssistantEntryProvider scopeKey={scope}>
        <Probe />
      </AssistantEntryProvider>,
    );
    expect(view.getByText('Prepared content question')).toBeTruthy();
    await act(async () => entry.setPreviewDraft('Updated content question'));
    expect(stored.get(scopedKey)).toBe('Updated content question');
    expect(stored.get(guestKey)).toBe('Existing guest question');
    await view.unmountAsync();
    const guest = render(
      <AssistantEntryProvider>
        <Probe />
      </AssistantEntryProvider>,
    );
    expect(guest.getByText('Existing guest question')).toBeTruthy();
    expect(stored.get(scopedKey)).toBe('Updated content question');
  } finally {
    await cleanupAsync();
    jest.restoreAllMocks();
    if (initialWindow) Object.defineProperty(globalThis, 'window', initialWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
