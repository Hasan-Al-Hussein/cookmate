import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme, useThemedStyles, type ThemeTokens } from '../design/ThemeProvider';
import { forwardRef, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View, type PressableProps } from 'react-native';
import { AppText } from './Typography';
import { controlStateProps } from './controlStateProps';
import { useMotionPolicy } from '../design/MotionPolicy';
import { useDelayedPending } from './useDelayedPending';
import { SelectionIndicator } from './SelectionIndicator';

export const ActionButton = forwardRef<
  View,
  PressableProps & {
    label: string;
    variant?: 'primary' | 'secondary' | 'quiet';
    busy?: boolean;
  }
>(function ActionButton(
  {
    label,
    variant = 'primary',
    busy = false,
    disabled,
    style,
    accessibilityRole = 'button',
    accessibilityState,
    ...props
  },
  ref,
) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const reduced = useMotionPolicy();
  const showPending = useDelayedPending(busy);

  const blocked = disabled || busy;
  return (
    <Pressable
      {...props}
      ref={ref}
      accessibilityRole={accessibilityRole}
      disabled={blocked}
      {...controlStateProps(
        { ...accessibilityState, disabled: !!blocked, busy },
        accessibilityRole,
      )}
      style={(state) => [
        styles.button,
        variant === 'secondary' && styles.secondary,
        variant === 'quiet' && styles.quiet,
        variant === 'primary' && {
          backgroundColor: state.pressed ? t.color.brandPressed : t.color.brand,
        },
        state.pressed && variant !== 'primary' && styles.pressed,
        blocked && styles.disabled,
        typeof style === 'function' ? style(state) : style,
      ]}
    >
      {showPending && (
        <View accessible={false} accessibilityElementsHidden importantForAccessibility="no">
          {reduced ? (
            <View testID="static-pending-indicator" style={styles.staticPending} />
          ) : (
            <ActivityIndicator color={t.color.disabledInk} />
          )}
        </View>
      )}
      <AppText
        role="control"
        color={blocked ? 'disabledInk' : variant === 'primary' ? 'onBrand' : 'brand'}
        style={styles.buttonText}
      >
        {label}
      </AppText>
    </Pressable>
  );
});

export function Notice({
  title,
  children,
  tone = 'neutral',
}: {
  title: string;
  children?: ReactNode;
  tone?: 'neutral' | 'caution' | 'error';
}) {
  const styles = useThemedStyles(createStyles);

  return (
    <View
      style={[
        styles.notice,
        tone === 'caution' && styles.caution,
        tone === 'error' && styles.error,
      ]}
    >
      <AppText role="bodyStrong" color={tone === 'error' ? 'error' : 'ink'}>
        {title}
      </AppText>
      {typeof children === 'string' ? <AppText role="support">{children}</AppText> : children}
    </View>
  );
}

export function SegmentControl<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.segments}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="tab"
          {...controlStateProps({ selected: value === option.value, disabled }, 'tab')}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          style={({ pressed }) => [
            styles.segment,
            value === option.value && styles.selected,
            pressed && styles.pressed,
          ]}
        >
          <AppText role="control" color={value === option.value ? 'brand' : 'inkSecondary'}>
            {option.label}
          </AppText>
          <SelectionIndicator selected={value === option.value} style={styles.segmentMark}>
            <View style={styles.segmentLine} />
          </SelectionIndicator>
        </Pressable>
      ))}
    </View>
  );
}

export const createControlStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    field: {
      minHeight: t.control.fieldMinHeight,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      borderRadius: t.radius.control,
      backgroundColor: t.color.surface,
      color: t.color.ink,
      paddingHorizontal: t.space.md,
      paddingVertical: t.space.sm,
      ...t.type.body,
    },
  });

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    button: {
      minHeight: t.control.buttonMinHeight,
      paddingHorizontal: t.space.md,
      paddingVertical: t.space.sm,
      borderRadius: t.radius.control,
      justifyContent: 'center',
      alignItems: 'center',
      flexDirection: 'row',
      gap: t.space.xs,
    },
    buttonText: { flexShrink: 1, textAlign: 'center' },
    staticPending: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: t.color.disabledInk,
      borderTopColor: 'transparent',
    },
    secondary: {
      backgroundColor: t.color.surface,
      borderColor: t.color.divider,
      borderWidth: 1,
    },
    quiet: { backgroundColor: 'transparent' },
    disabled: { backgroundColor: t.color.disabledSurface },
    pressed: { backgroundColor: t.color.selection },
    notice: {
      backgroundColor: t.color.surfaceMuted,
      padding: t.space.sm,
      borderRadius: t.radius.small,
      gap: t.space.xs,
    },
    caution: { backgroundColor: t.color.cautionSurface },
    error: { backgroundColor: t.color.errorSurface },
    segments: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.space.xxs,
      backgroundColor: t.color.surfaceMuted,
      padding: t.space.xxs,
      borderRadius: t.radius.control,
    },
    segment: {
      minHeight: t.control.minimumTarget,
      paddingHorizontal: t.space.xs,
      paddingVertical: t.space.sm,
      justifyContent: 'center',
      borderRadius: t.radius.small,
      alignItems: 'center',
      flexGrow: 1,
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    selected: { backgroundColor: t.color.selection },
    segmentMark: { position: 'absolute', bottom: -2, start: 8, end: 8 },
    segmentLine: { height: 2, borderRadius: 1, backgroundColor: t.color.brand },
  });

export function useControlStyles() {
  return useThemedStyles(createControlStyles);
}
