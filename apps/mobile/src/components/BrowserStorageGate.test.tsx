import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { BrowserStorageGate } from './BrowserStorageGate.web';
import { createWebStorageLease } from '../data/webStorageLease';

jest.mock('./BrandMark', () => ({ BrandMark: () => null }));
const owner = window as Window & {
  __cookmateWebStorageLeaseV1?: ReturnType<typeof createWebStorageLease>;
};
afterEach(() => {
  delete owner.__cookmateWebStorageLeaseV1;
});
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

test('a competing preview cannot mount the account/workspace tree; explicit retry can acquire it', async () => {
  let available = false;
  const request = jest.fn(async (_name, _options, callback) => callback(available ? {} : null));
  owner.__cookmateWebStorageLeaseV1 = createWebStorageLease({ request });
  const mounted = jest.fn();
  function AccountTree() {
    mounted();
    return <Text>Saved cooking</Text>;
  }
  render(
    <BrowserStorageGate>
      <AccountTree />
    </BrowserStorageGate>,
  );
  await settle();
  expect(mounted).not.toHaveBeenCalled();
  expect(screen.getByText('CookMate is open in another tab')).toBeTruthy();
  available = true;
  fireEvent.press(screen.getByRole('button', { name: 'Try this tab again' }));
  await settle();
  expect(screen.getByText('Saved cooking')).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(2);
});

test('unmount/remount keeps the document lease instead of admitting another SQLite owner', async () => {
  const request = jest.fn(async (_name, _options, callback) => callback({}));
  const lease = createWebStorageLease({ request });
  owner.__cookmateWebStorageLeaseV1 = lease;
  const first = render(
    <BrowserStorageGate>
      <Text>First app</Text>
    </BrowserStorageGate>,
  );
  await settle();
  first.unmount();
  expect(lease.getSnapshot().status).toBe('owned');
  render(
    <BrowserStorageGate>
      <Text>Remounted app</Text>
    </BrowserStorageGate>,
  );
  await settle();
  expect(screen.getByText('Remounted app')).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
});

test('an unsuccessful retry retains the same disabled control while checking', async () => {
  let next!: (value: object | null) => void;
  let calls = 0;
  const lease = createWebStorageLease({
    request: async (_name, _options, callback) => {
      calls++;
      if (calls === 1) return callback(null);
      const lock = await new Promise<object | null>((resolve) => {
        next = resolve;
      });
      return callback(lock);
    },
  });
  owner.__cookmateWebStorageLeaseV1 = lease;
  render(
    <BrowserStorageGate>
      <Text>Saved cooking</Text>
    </BrowserStorageGate>,
  );
  await settle();
  const before = screen.getByRole('button', { name: 'Try this tab again' });
  fireEvent.press(before);
  await settle();
  expect(screen.getByRole('button', { name: 'Checking this tab…' })).toBe(before);
  expect(before.props.accessibilityState.disabled).toBe(true);
  await act(async () => {
    next(null);
  });
  expect(screen.getByRole('button', { name: 'Try this tab again' })).toBe(before);
  expect(screen.queryByText('Saved cooking')).toBeNull();
});

test('unsupported coordination leaves the database tree unmounted and gives a reload action', async () => {
  owner.__cookmateWebStorageLeaseV1 = createWebStorageLease(undefined);
  render(
    <BrowserStorageGate>
      <Text>Saved cooking</Text>
    </BrowserStorageGate>,
  );
  await settle();
  expect(screen.queryByText('Saved cooking')).toBeNull();
  expect(screen.getByRole('button', { name: 'Reload preview' })).toBeTruthy();
  expect(screen.getByText('Your saved data has not been cleared or replaced.')).toBeTruthy();
});
