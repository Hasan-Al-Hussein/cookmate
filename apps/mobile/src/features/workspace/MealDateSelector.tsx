import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useId, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import {
  getPlanWeekdayOffset,
  isSupportedPlanDate,
  shiftPlanDate,
  type PlanWeekStart,
} from '@cookmate/domain';
import { ActionButton, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { IconButton } from '../../components/Icon';
import { controlStateProps } from '../../components/controlStateProps';
import { focusTarget } from '../../components/focusTarget';
import { fieldHelpProps } from '../../components/fieldHelpProps';
import { FocusedSheet } from '../../components/FocusedSheet';
import { SelectionIndicator } from '../../components/SelectionIndicator';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { formatPlanDate } from './runtimeClock';
import { usePlanningPreferences } from '../planning-preferences/PlanningPreferencesProvider';

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Month cells reuse the domain's bounded Gregorian arithmetic; no timestamp parsing. */
export function buildCalendarMonth(value: string, weekStart: PlanWeekStart = 'monday') {
  if (!isSupportedPlanDate(value)) throw new RangeError('Unsupported calendar date');
  const firstDate = `${value.slice(0, 7)}-01`;
  const dates: string[] = [];
  let current: string | null = firstDate;
  while (current && current.slice(0, 7) === firstDate.slice(0, 7)) {
    dates.push(current);
    current = shiftPlanDate(current, 1);
  }
  const leading = getPlanWeekdayOffset(firstDate, weekStart);
  const cells: (string | null)[] = [...Array<string | null>(leading).fill(null), ...dates];
  while (cells.length % 7) cells.push(null);
  const previousDate = shiftPlanDate(firstDate, -1);
  return {
    // formatPlanDate is the existing English date-only presenter: weekday, day, month, year.
    label: formatPlanDate(firstDate).split(' ').slice(2).join(' '),
    cells,
    previousMonth: previousDate ? `${previousDate.slice(0, 7)}-01` : null,
    nextMonth: current,
  };
}

/** A date-only draft stays with its owner, including invalid manual input. */
export function MealDateSelector({
  value,
  today,
  getToday,
  onChange,
}: {
  value: string;
  today: string;
  getToday?: () => string;
  onChange: (value: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const controlStyles = useControlStyles();
  const { preferences } = usePlanningPreferences();
  const orderedWeekdays =
    preferences.weekStart === 'sunday' ? [weekdays[6]!, ...weekdays.slice(0, 6)] : weekdays;

  const helpId = useId();
  const valid = isSupportedPlanDate(value);
  const { enlarged } = useNativeLayout();
  const [manualOpen, setManualOpen] = useState(!valid);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [monthDate, setMonthDate] = useState(valid ? value : today);
  const lastValidDate = useRef(valid ? value : today);
  useEffect(() => {
    if (valid) lastValidDate.current = value;
  }, [valid, value]);
  const [availableWidth, setAvailableWidth] = useState(0);
  const calendarToggle = useRef<View>(null);
  const showManual = manualOpen || !valid;
  const month = buildCalendarMonth(monthDate, preferences.weekStart);
  const gridWidth = Math.max(availableWidth, 7 * (enlarged ? 64 : 44));
  const calendarScrolls = availableWidth > 0 && gridWidth > availableWidth;
  const tomorrow = shiftPlanDate(today, 1);
  const chooseDate = (next: string) => {
    onChange(next);
    setCalendarOpen(false);
  };
  const help = valid
    ? 'Use YYYY-MM-DD. Dates from 1900 to 2100 are supported.'
    : 'Enter a valid date between 1900-01-01 and 2100-12-31.';
  return (
    <View style={styles.section}>
      <AppText role="label" color="inkSecondary">
        When?
      </AppText>
      <AppText role="section">{valid ? formatPlanDate(value) : 'Choose a valid date'}</AppText>
      <View style={styles.shortcuts}>
        <ActionButton
          label="Today"
          variant={value === today ? 'secondary' : 'quiet'}
          accessibilityState={{ selected: value === today }}
          onPress={() => chooseDate(getToday?.() ?? today)}
        />
        <ActionButton
          label="Tomorrow"
          variant={value === tomorrow ? 'secondary' : 'quiet'}
          accessibilityState={{ selected: value === tomorrow }}
          disabled={!tomorrow}
          onPress={() => {
            const next = shiftPlanDate(getToday?.() ?? today, 1);
            if (next) chooseDate(next);
          }}
        />
      </View>
      <View style={styles.shortcuts}>
        <ActionButton
          ref={calendarToggle}
          label="Calendar"
          accessibilityLabel="Choose from calendar"
          variant="secondary"
          accessibilityState={{ expanded: calendarOpen }}
          onPress={() => {
            Keyboard.dismiss();
            setMonthDate(lastValidDate.current);
            setCalendarOpen(true);
          }}
        />
        <ActionButton
          label={showManual ? 'Hide manual date' : 'Enter date manually'}
          variant="quiet"
          accessibilityState={{ expanded: showManual }}
          disabled={!valid}
          onPress={() => setManualOpen((open) => !open)}
        />
      </View>
      <FocusedSheet
        visible={calendarOpen}
        retainClosingContent={false}
        title="Choose a date"
        closeLabel="Cancel"
        onClose={() => setCalendarOpen(false)}
        onDismiss={() => focusTarget(calendarToggle.current)}
      >
        <View style={styles.calendar}>
          <View style={styles.monthNavigation}>
            <IconButton
              name="chevronLeft"
              label="Previous month"
              disabled={!month.previousMonth}
              onPress={() => {
                if (month.previousMonth) setMonthDate(month.previousMonth);
              }}
            />
            <AppText
              role="bodyStrong"
              accessibilityRole="header"
              accessibilityLiveRegion="polite"
              style={styles.monthTitle}
            >
              {month.label}
            </AppText>
            <IconButton
              name="chevronRight"
              label="Next month"
              disabled={!month.nextMonth}
              onPress={() => {
                if (month.nextMonth) setMonthDate(month.nextMonth);
              }}
            />
          </View>
          <View
            testID="calendar-grid-viewport"
            style={styles.calendarGrid}
            onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={calendarScrolls}>
              <View style={{ width: gridWidth }}>
                <View style={styles.calendarRow}>
                  {orderedWeekdays.map((day) => (
                    <View key={day} style={styles.calendarCell}>
                      <AppText role="support" accessibilityLabel={day} color="inkSecondary">
                        {day.slice(0, 3)}
                      </AppText>
                    </View>
                  ))}
                </View>
                {Array.from({ length: month.cells.length / 7 }, (_, row) => (
                  <View key={row} style={styles.calendarRow}>
                    {month.cells.slice(row * 7, row * 7 + 7).map((day, column) => {
                      const selected = day === value;
                      return day ? (
                        <Pressable
                          key={day}
                          accessibilityRole="button"
                          accessibilityLabel={`${formatPlanDate(day)}${day === today ? ', today' : ''}`}
                          {...controlStateProps({ selected }, 'button')}
                          onPress={() => chooseDate(day)}
                          style={({ pressed }) => [
                            styles.calendarCell,
                            styles.calendarDay,
                            day === today && styles.today,
                            selected && styles.selectedDay,
                            pressed && styles.pressed,
                          ]}
                        >
                          <AppText role="bodyStrong" color={selected ? 'onBrand' : 'ink'}>
                            {Number(day.slice(8))}
                          </AppText>
                          <SelectionIndicator selected={selected} style={styles.selectionMark}>
                            <View style={styles.selectionLine} />
                          </SelectionIndicator>
                        </Pressable>
                      ) : (
                        <View key={`empty-${column}`} style={styles.calendarCell} />
                      );
                    })}
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
          {calendarScrolls && (
            <AppText role="support" color="inkSecondary">
              Scroll the calendar sideways to reach every weekday. You can also enter a date
              manually.
            </AppText>
          )}
          <AppText role="support" color="inkSecondary">
            Today is outlined. The selected date is filled and underlined.
          </AppText>
        </View>
      </FocusedSheet>
      {showManual && (
        <View style={styles.section}>
          <TextInput
            value={value}
            onChangeText={onChange}
            accessibilityLabel="Meal date in YYYY-MM-DD format"
            {...fieldHelpProps({ id: helpId, text: help, invalid: !valid })}
            placeholder="YYYY-MM-DD"
            autoCorrect={false}
            autoCapitalize="none"
            inputMode="text"
            style={controlStyles.field}
          />
          <AppText role="support" nativeID={helpId} color={valid ? 'inkSecondary' : 'error'}>
            {help}
          </AppText>
          <View style={styles.shortcuts}>
            <ActionButton
              label="Previous day"
              variant="quiet"
              disabled={!valid || !shiftPlanDate(value, -1)}
              onPress={() => {
                if (valid) {
                  const date = shiftPlanDate(value, -1);
                  if (date) chooseDate(date);
                }
              }}
            />
            <ActionButton
              label="Next day"
              variant="quiet"
              disabled={!valid || !shiftPlanDate(value, 1)}
              onPress={() => {
                if (valid) {
                  const date = shiftPlanDate(value, 1);
                  if (date) chooseDate(date);
                }
              }}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.xs },
    shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    calendar: { gap: t.space.sm },
    monthNavigation: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
    monthTitle: { flex: 1, textAlign: 'center' },
    // Use the sheet's full safe-area width for seven touch targets; keep other copy inset.
    calendarGrid: { marginHorizontal: -t.space.gutter },
    calendarRow: { flexDirection: 'row' },
    calendarCell: {
      width: `${100 / 7}%`,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    calendarDay: {
      borderRadius: t.radius.small,
      borderWidth: 2,
      borderColor: 'transparent',
      paddingVertical: t.space.xs,
    },
    today: { borderColor: t.color.brand },
    selectedDay: { backgroundColor: t.color.brand },
    selectionMark: { position: 'absolute', bottom: 4, alignSelf: 'center' },
    selectionLine: { width: 14, height: 2, borderRadius: 1, backgroundColor: t.color.onBrand },
    pressed: { opacity: 0.7 },
  });
