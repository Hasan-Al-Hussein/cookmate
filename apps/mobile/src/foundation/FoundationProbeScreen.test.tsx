import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import FoundationProbeScreen from './FoundationProbeScreen';
import { runNativeAdapterProbe } from './nativeProbe';

jest.mock('./nativeProbe', () => ({ runNativeAdapterProbe: jest.fn(), runHttpsProbe: jest.fn() }));

test('probe screen begins untested, prevents duplicate dispatch and shows the actual result', async () => {
  let complete: ((value: unknown) => void) | undefined;
  jest.mocked(runNativeAdapterProbe).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve as (value: unknown) => void;
      }),
  );
  render(<FoundationProbeScreen />);
  expect(screen.getByText('No checks have run on this device.')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Run native adapter checks' }));
  expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  complete?.({ checks: [{ name: 'fixture failure', passed: false }] });
  await waitFor(() => expect(screen.getByText(/fixture failure/)).toBeTruthy());
  expect(runNativeAdapterProbe).toHaveBeenCalledTimes(1);
});
