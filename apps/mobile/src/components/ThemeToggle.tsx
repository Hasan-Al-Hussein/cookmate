import { useRef, useState } from 'react';
import { useThemeMode } from '../design/ThemeProvider';
import { useAppPreferences } from '../features/app-preferences/AppPreferencesProvider';
import { IconButton } from './Icon';

/** A shortcut to the same persisted preference used by Appearance settings. */
export function ThemeToggle({ onError }: { onError: (message: string | null) => void }) {
  const mode = useThemeMode();
  const { hydrated, setPreference } = useAppPreferences();
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const next = mode === 'dark' ? 'light' : 'dark';

  const toggle = async () => {
    if (!hydrated || pending.current) return;
    pending.current = true;
    setSaving(true);
    onError(null);
    try {
      if (!(await setPreference('theme', next))) {
        onError('Theme could not be saved. Please try again.');
      }
    } catch {
      onError('Theme could not be saved. Please try again.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <IconButton
      name={next === 'dark' ? 'moon' : 'sun'}
      label={`Switch to ${next} mode`}
      tone="quiet"
      disabled={!hydrated || saving}
      accessibilityState={{ busy: saving }}
      onPress={() => void toggle()}
    />
  );
}
