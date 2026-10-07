import { useState } from 'react';
import { Modal, ScrollView, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { buildCalendarMonth, MealDateSelector } from './MealDateSelector';
import { PlanningPreferencesProvider } from '../planning-preferences/PlanningPreferencesProvider';
import { createPlanningPreferencesController } from '../planning-preferences/planningPreferences';

let mockEnlarged = false;
jest.mock('../../hooks/useNativeLayout', () => ({
  useNativeLayout: () => ({ enlarged: mockEnlarged }),
}));
beforeEach(() => {
  mockEnlarged = false;
});

function DateDraft({ initial, today }: { initial: string; today: string }) {
  const [value, setValue] = useState(initial);
  return <MealDateSelector value={value} today={today} onChange={setValue} />;
}

function openCalendar() {
  fireEvent.press(screen.getByRole('button', { name: 'Choose from calendar' }));
  fireEvent(screen.UNSAFE_getByType(Modal), 'show');
}

function finishCalendarDismissal() {
  fireEvent(screen.UNSAFE_getByType(Modal), 'dismiss');
}

test('date shortcuts cross the year boundary without changing date-only identity', () => {
  render(<DateDraft initial="2026-12-30" today="2026-12-31" />);
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  fireEvent.press(screen.getByRole('button', { name: 'Tomorrow' }));
  expect(screen.getByDisplayValue('2027-01-01')).toBeTruthy();
  expect(screen.getByText('Friday 1 January 2027')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Today' }));
  expect(screen.getByDisplayValue('2026-12-31')).toBeTruthy();
});

test('invalid manual dates remain visible until deliberately corrected', () => {
  render(<DateDraft initial="2028-02-29" today="2028-02-28" />);
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  const field = screen.getByLabelText('Meal date in YYYY-MM-DD format');
  fireEvent.changeText(field, '2027-02-29');
  expect(screen.getByDisplayValue('2027-02-29')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Hide manual date' })).toBeDisabled();
  expect(screen.getByText('Enter a valid date between 1900-01-01 and 2100-12-31.')).toBeTruthy();
  fireEvent.changeText(field, '2028-02-29');
  expect(screen.getByText('Tuesday 29 February 2028')).toBeTruthy();
  expect(screen.queryByText('Choose a valid date')).toBeNull();
});

test('Tomorrow cannot advance beyond the supported final date', () => {
  render(<DateDraft initial="2100-12-31" today="2100-12-31" />);
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeDisabled();
  expect(screen.getByDisplayValue('2100-12-31')).toBeTruthy();
});

test.each([
  ['1900-02-01', 28],
  ['2000-02-01', 29],
  ['2028-02-01', 29],
  ['2100-02-01', 28],
])('calendar keeps Gregorian leap-year dates for %s', (date, count) => {
  const month = buildCalendarMonth(date);
  const dates = month.cells.filter((day): day is string => day !== null);
  expect(dates).toHaveLength(count);
  expect(new Set(dates).size).toBe(count);
  expect(dates[0]).toBe(date);
  expect(dates.at(-1)).toBe(`${date.slice(0, 7)}-${count}`);
  expect(month.cells.length % 7).toBe(0);
});

test('calendar aligns Monday-first dates and respects both supported endpoints', () => {
  expect(buildCalendarMonth('2026-02-15').cells.slice(0, 7)).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
    '2026-02-01',
  ]);
  expect(buildCalendarMonth('1900-01-01').previousMonth).toBeNull();
  expect(buildCalendarMonth('2100-12-31').nextMonth).toBeNull();
  expect(buildCalendarMonth('2026-12-31').nextMonth).toBe('2027-01-01');
  expect(buildCalendarMonth('2027-01-01').previousMonth).toBe('2026-12-01');
  expect(() => buildCalendarMonth('1899-12-31')).toThrow(RangeError);
  expect(() => buildCalendarMonth('2101-01-01')).toThrow(RangeError);
  expect(() => buildCalendarMonth('2027-02-29')).toThrow(RangeError);
});

test('Sunday alignment uses the actual weekday at the clipped January 1900 boundary', () => {
  expect(buildCalendarMonth('1900-01-01', 'sunday').cells.slice(0, 3)).toEqual([
    null,
    '1900-01-01',
    '1900-01-02',
  ]);
  expect(buildCalendarMonth('2026-02-01', 'sunday').cells[0]).toBe('2026-02-01');
  expect(buildCalendarMonth('2027-01-01', 'sunday').cells.slice(0, 6)).toEqual([
    null,
    null,
    null,
    null,
    null,
    '2027-01-01',
  ]);
});

test('changing the week start reorders the calendar without replacing a manual date draft', async () => {
  const controller = createPlanningPreferencesController({
    read: async () => null,
    write: async () => undefined,
  });
  await controller.hydrate();
  render(
    <PlanningPreferencesProvider controller={controller}>
      <DateDraft initial="2028-02-29" today="2028-02-28" />
    </PlanningPreferencesProvider>,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  fireEvent.changeText(screen.getByLabelText('Meal date in YYYY-MM-DD format'), '2028-02-3');
  await act(async () => {
    await controller.setPreference('weekStart', 'sunday');
  });
  expect(screen.getByDisplayValue('2028-02-3')).toBeTruthy();
  openCalendar();
  const weekdays = screen
    .getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/)
    .map((node) => node.props.children);
  expect(weekdays).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  expect(screen.getByText('February 2028')).toBeTruthy();
  controller.dispose();
});

test('Today and Tomorrow read the local date at invocation without resetting the existing draft', () => {
  let today = '2026-12-31';
  const onChange = jest.fn();
  const view = render(
    <MealDateSelector
      value="2028-02-29"
      today={today}
      getToday={() => today}
      onChange={onChange}
    />,
  );
  today = '2027-01-01';
  expect(screen.getByText('Tuesday 29 February 2028')).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Today' }));
  expect(onChange).toHaveBeenLastCalledWith('2027-01-01');
  today = '2026-12-31'; // A local time-zone change can move the civil date backwards.
  view.rerender(
    <MealDateSelector
      value="2028-02-29"
      today="2027-01-01"
      getToday={() => today}
      onChange={onChange}
    />,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Today' }));
  expect(onChange).toHaveBeenLastCalledWith('2026-12-31');
  fireEvent.press(screen.getByRole('button', { name: 'Tomorrow' }));
  expect(onChange).toHaveBeenLastCalledWith('2027-01-01');
});

test('the calendar uses the full 320 px sheet width for seven accessible day targets', () => {
  const onChange = jest.fn();
  render(<MealDateSelector value="2026-10-02" today="2026-10-02" onChange={onChange} />);
  openCalendar();
  const viewport = screen.getByTestId('calendar-grid-viewport');
  // The sheet's existing 20 px content gutter is reclaimed only around this grid.
  expect(StyleSheet.flatten(viewport.props.style).marginHorizontal).toBe(-20);
  fireEvent(viewport, 'layout', { nativeEvent: { layout: { width: 320 } } });
  const calendar = screen.UNSAFE_getAllByType(ScrollView).find((node) => node.props.horizontal)!;
  expect(calendar.props.showsHorizontalScrollIndicator).toBe(false);
  expect(StyleSheet.flatten(calendar.props.children.props.style).width).toBe(320);
  expect(320 / 7).toBeGreaterThanOrEqual(44);
  expect(screen.queryByText(/Scroll the calendar sideways/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Saturday 3 October 2026' }));
  expect(onChange).toHaveBeenCalledWith('2026-10-03');
});

test('enlarged calendar text retains larger targets and explains intentional horizontal scrolling', () => {
  mockEnlarged = true;
  render(<MealDateSelector value="2026-10-02" today="2026-10-02" onChange={jest.fn()} />);
  openCalendar();
  fireEvent(screen.getByTestId('calendar-grid-viewport'), 'layout', {
    nativeEvent: { layout: { width: 320 } },
  });
  const calendar = screen.UNSAFE_getAllByType(ScrollView).find((node) => node.props.horizontal)!;
  expect(calendar.props.showsHorizontalScrollIndicator).toBe(true);
  expect(StyleSheet.flatten(calendar.props.children.props.style).width).toBe(448);
  expect(screen.getByText(/Scroll the calendar sideways to reach every weekday/)).toBeTruthy();
  fireEvent(screen.getByTestId('calendar-grid-viewport'), 'layout', {
    nativeEvent: { layout: { width: 500 } },
  });
  expect(calendar.props.showsHorizontalScrollIndicator).toBe(false);
  expect(screen.queryByText(/Scroll the calendar sideways/)).toBeNull();
});

test('browsing another month does not change the draft; deliberate day selection closes the calendar', () => {
  const onChange = jest.fn();
  render(<MealDateSelector value="2026-12-31" today="2026-12-30" onChange={onChange} />);
  expect(screen.queryByLabelText('Meal date in YYYY-MM-DD format')).toBeNull();
  openCalendar();
  expect(screen.getByRole('button', { name: 'Thursday 31 December 2026' })).toBeSelected();
  expect(screen.getByRole('button', { name: 'Wednesday 30 December 2026, today' })).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.getByText('January 2027')).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Friday 1 January 2027' }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('2027-01-01');
  expect(screen.queryByRole('button', { name: 'Next month' })).toBeNull();
  finishCalendarDismissal();
});

test.each([
  ['1900-01-01', 'Previous month'],
  ['2100-12-31', 'Next month'],
])(
  'calendar navigation stops at %s without silently clamping the chosen date',
  (date, boundary) => {
    const onChange = jest.fn();
    render(<MealDateSelector value={date} today="2026-09-30" onChange={onChange} />);
    openCalendar();
    const button = screen.getByRole('button', { name: boundary });
    expect(button).toBeDisabled();
    fireEvent.press(button);
    expect(onChange).not.toHaveBeenCalled();
  },
);

test('closing the calendar retains invalid manual input and reopening starts at the chosen date', () => {
  render(<DateDraft initial="2027-02-29" today="2028-02-28" />);
  expect(screen.getByDisplayValue('2027-02-29')).toBeTruthy();
  openCalendar();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByDisplayValue('2027-02-29')).toBeTruthy();
  finishCalendarDismissal();
  openCalendar();
  fireEvent.press(screen.getByRole('button', { name: 'Tuesday 29 February 2028' }));
  expect(screen.getByDisplayValue('2028-02-29')).toBeTruthy();
  finishCalendarDismissal();
  openCalendar();
  expect(screen.getByText('February 2028')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Tuesday 29 February 2028' })).toBeSelected();
});

test('cancelling after browsing another month leaves the selected date unchanged', () => {
  const onChange = jest.fn();
  render(<MealDateSelector value="2026-12-31" today="2026-12-30" onChange={onChange} />);
  openCalendar();
  fireEvent.press(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.getByText('January 2027')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText('Thursday 31 December 2026')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Next month' })).toBeNull();
  finishCalendarDismissal();
  openCalendar();
  expect(screen.getByText('December 2026')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Thursday 31 December 2026' })).toBeSelected();
});

test('an unfinished manual date keeps the last valid calendar month without changing its draft', () => {
  render(<DateDraft initial="2028-02-29" today="2026-09-30" />);
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  fireEvent.changeText(screen.getByLabelText('Meal date in YYYY-MM-DD format'), '2028-02-3');
  openCalendar();
  expect(screen.getByText('February 2028')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Tuesday 29 February 2028' })).not.toBeSelected();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByDisplayValue('2028-02-3')).toBeTruthy();
  expect(screen.getByText('Choose a valid date')).toBeTruthy();
  finishCalendarDismissal();
});

test('a rapid calendar reopen waits for the old modal dismissal and ignores duplicate dismissal', () => {
  const onChange = jest.fn();
  render(<MealDateSelector value="2028-02-29" today="2026-09-30" onChange={onChange} />);
  openCalendar();
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent.press(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.getByText('March 2028')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(modal.props.visible).toBe(false);
  fireEvent.press(screen.getByRole('button', { name: 'Choose from calendar' }));
  expect(modal.props.visible).toBe(false);
  finishCalendarDismissal();
  expect(modal.props.visible).toBe(true);
  fireEvent(modal, 'show');
  expect(screen.getByText('February 2028')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Tuesday 29 February 2028' })).toBeSelected();
  finishCalendarDismissal();
  expect(modal.props.visible).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});
