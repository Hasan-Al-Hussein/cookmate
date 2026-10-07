import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Notice } from '../../components/Controls';
import { AppIcon } from '../../components/Icon';
import { AppText } from '../../components/Typography';
import { controlStateProps } from '../../components/controlStateProps';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useAppPreferences } from '../app-preferences/AppPreferencesProvider';

export function AppearanceSettings({ showTitle = true }: { showTitle?: boolean }) {
  const { preferences, hydrated, error, setPreference } = useAppPreferences();
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const styles = useThemedStyles(createStyles);
  async function update(save: () => Promise<boolean>) {
    if (!hydrated || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const saved = await save();
      setSaveFailed(!saved);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <View style={styles.section}>
      {showTitle && (
        <AppText role="section" accessibilityRole="header">
          Appearance & accessibility
        </AppText>
      )}
      <AppText color="inkSecondary">Make CookMate comfortable to read and use.</AppText>
      {!hydrated && <Notice title="Loading your app preferences…" />}
      {(error || saveFailed) && (
        <Notice title="App preferences could not be saved or restored" tone="error">
          {error ?? 'Your setting was not saved. The previous value is still active. Try again.'}
        </Notice>
      )}
      <View style={styles.section}>
        <AppText role="bodyStrong" accessibilityRole="header">
          Theme
        </AppText>
        <ChoiceGroup
          label="Theme"
          selected={preferences.theme}
          disabled={!hydrated || saving}
          options={[
            { value: 'system', label: 'System', detail: 'Follow your device appearance.' },
            { value: 'light', label: 'Light', detail: 'Warm ivory surfaces.' },
            { value: 'dark', label: 'Dark', detail: 'Comfortable dark surfaces.' },
          ]}
          onChange={(value) => void update(() => setPreference('theme', value))}
        />
      </View>
      <View style={styles.section}>
        <AppText role="bodyStrong" accessibilityRole="header">
          Motion
        </AppText>
        <ChoiceGroup
          label="Motion"
          selected={preferences.motion}
          disabled={!hydrated || saving}
          options={[
            {
              value: 'system',
              label: 'Follow system',
              detail: 'Respect your device’s Reduce Motion setting.',
            },
            {
              value: 'reduced',
              label: 'Reduced',
              detail: 'Use less decorative movement in CookMate.',
            },
          ]}
          onChange={(value) => void update(() => setPreference('motion', value))}
        />
        <AppText role="support" color="inkSecondary">
          Your system text size is respected. Motion never changes your meals, shopping selections
          or saved results.
        </AppText>
      </View>
      {saving && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Saving app preference…
        </AppText>
      )}
    </View>
  );
}

function ChoiceGroup<T extends string>({
  label,
  selected,
  options,
  disabled,
  onChange,
}: {
  label: string;
  selected: T;
  options: readonly { value: T; label: string; detail: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choices}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="radio"
          accessibilityLabel={option.label}
          accessibilityHint={option.detail}
          disabled={disabled}
          {...controlStateProps({ checked: selected === option.value, disabled }, 'radio')}
          onPress={() => onChange(option.value)}
          style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
        >
          <View style={styles.choiceText}>
            <AppText role="bodyStrong">{option.label}</AppText>
            <AppText role="support" color="inkSecondary">
              {option.detail}
            </AppText>
          </View>
          <View style={[styles.indicator, selected === option.value && styles.selected]}>
            {selected === option.value && (
              <AppIcon name="check" size={16} color={t.color.onBrand} />
            )}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
    choices: { borderRadius: t.radius.card, overflow: 'hidden', backgroundColor: t.color.surface },
    choice: {
      padding: t.space.md,
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    choiceText: { flex: 1, gap: t.space.xxs },
    indicator: {
      width: 24,
      height: 24,
      borderRadius: t.radius.pill,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      justifyContent: 'center',
      alignItems: 'center',
    },
    selected: { backgroundColor: t.color.brand, borderColor: t.color.brand },
    pressed: { backgroundColor: t.color.selection },
  });
