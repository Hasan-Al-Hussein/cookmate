import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { getPlanWeek } from '@cookmate/domain';
import { Notice, SegmentControl } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useTheme } from '../../design/ThemeProvider';
import { usePlanningPreferences } from '../planning-preferences/PlanningPreferencesProvider';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';

/** Device-local defaults affect presentation and new drafts, never saved placements. */
export function PlanningSettings({ showTitle = true }: { showTitle?: boolean }) {
  const t = useTheme();
  const { preferences, hydrated, saving, error, setPreference } = usePlanningPreferences();
  const [failed, setFailed] = useState(false);
  const active = useRef(true),
    working = useRef(false);
  const latest = useRef({ hydrated, saving, setPreference });
  latest.current = { hydrated, saving, setPreference };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function update(save: () => Promise<boolean>) {
    if (
      !active.current ||
      working.current ||
      !latest.current.hydrated ||
      latest.current.saving ||
      latest.current.setPreference !== setPreference
    )
      return;
    working.current = true;
    setFailed(false);
    try {
      const saved = await save();
      if (active.current && latest.current.setPreference === setPreference) setFailed(!saved);
    } catch {
      if (active.current && latest.current.setPreference === setPreference) setFailed(true);
    } finally {
      working.current = false;
    }
  }
  const example = getPlanWeek('2027-01-01', preferences.weekStart);
  const disabled = !hydrated || saving;
  return (
    <View style={{ gap: t.space.md }}>
      {showTitle && (
        <AppText role="section" accessibilityRole="header">
          Planning defaults
        </AppText>
      )}
      <AppText color="inkSecondary">
        Choose how your week is displayed and the starting slot for a new meal.
      </AppText>
      {!hydrated && <Notice title="Loading planning defaults…" />}
      {(error || failed) && (
        <Notice title="Planning defaults need another check" tone="error">
          {error ??
            'The change could not be confirmed. Check the displayed setting before trying again.'}
        </Notice>
      )}
      <View style={{ gap: t.space.sm }}>
        <AppText role="bodyStrong" accessibilityRole="header">
          Week starts on
        </AppText>
        <SegmentControl
          value={preferences.weekStart}
          options={[
            { value: 'monday', label: 'Monday' },
            { value: 'sunday', label: 'Sunday' },
          ]}
          disabled={disabled}
          onChange={(value) => void update(() => setPreference('weekStart', value))}
        />
        <AppText role="support">
          Example for Friday 1 January 2027: {formatPlanDate(example.startDate, true)} –{' '}
          {formatPlanDate(example.endDate)}.
        </AppText>
      </View>
      <View style={{ gap: t.space.sm }}>
        <AppText role="bodyStrong" accessibilityRole="header">
          Default meal slot
        </AppText>
        <SegmentControl
          value={preferences.defaultMealSlot}
          options={(['breakfast', 'lunch', 'dinner'] as const).map((value) => ({
            value,
            label: mealLabel(value),
          }))}
          disabled={disabled}
          onChange={(value) => void update(() => setPreference('defaultMealSlot', value))}
        />
        <AppText role="support">
          New meals without a chosen slot start at {mealLabel(preferences.defaultMealSlot)}. A slot
          you choose or an existing meal always keeps its selection.
        </AppText>
      </View>
      <AppText role="support" color="inkSecondary">
        These defaults stay in this workspace on this device. Changing them does not move saved
        meals or alter Shopping selections.
      </AppText>
      {saving && (
        <AppText role="support" accessibilityLiveRegion="polite">
          Saving planning default…
        </AppText>
      )}
    </View>
  );
}
