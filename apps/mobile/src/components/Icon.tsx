import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme, useThemedStyles, type ThemeTokens } from '../design/ThemeProvider';
import { forwardRef } from 'react';
import { Image, StyleSheet, View, type PressableProps } from 'react-native';
import { controlStateProps } from './controlStateProps';

const icons = {
  home: require('../../assets/icons/home.png'),
  heart: require('../../assets/icons/heart.png'),
  calendar: require('../../assets/icons/calendar.png'),
  chat: require('../../assets/icons/chat.png'),
  sparkle: require('../../assets/icons/sparkle.png'),
  settings: require('../../assets/icons/settings.png'),
  back: require('../../assets/icons/back.png'),
  chevronRight: require('../../assets/icons/chevronRight.png'),
  chevronLeft: require('../../assets/icons/chevronLeft.png'),
  search: require('../../assets/icons/search.png'),
  filter: require('../../assets/icons/filter.png'),
  close: require('../../assets/icons/close.png'),
  plus: require('../../assets/icons/plus.png'),
  check: require('../../assets/icons/check.png'),
  more: require('../../assets/icons/more.png'),
  leaf: require('../../assets/icons/leaf.png'),
  sun: require('../../assets/icons/sun.png'),
  moon: require('../../assets/icons/moon.png'),
  coffee: require('../../assets/icons/coffee.png'),
  shopping: require('../../assets/icons/shopping.png'),
  book: require('../../assets/icons/book.png'),
  globe: require('../../assets/icons/globe.png'),
  external: require('../../assets/icons/external.png'),
  info: require('../../assets/icons/info.png'),
} as const;

export type IconName = keyof typeof icons;

const selectedIcons = {
  home: require('../../assets/icons/homeFilled.png'),
  heart: require('../../assets/icons/heartFilled.png'),
} as const;

export function AppIcon({
  name,
  size = 22,
  color,
  selected = false,
}: {
  name: IconName;
  size?: number;
  color?: string;
  selected?: boolean;
}) {
  const t = useTheme();
  const source =
    selected && (name === 'home' || name === 'heart') ? selectedIcons[name] : icons[name];
  return (
    <Image
      source={source}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no"
      resizeMode="contain"
      fadeDuration={0}
      style={{ width: size, height: size }}
      tintColor={color ?? t.color.ink}
    />
  );
}

export type IconButtonProps = Omit<PressableProps, 'children'> & {
  label: string;
  name: IconName;
  selected?: boolean;
  tone?: 'surface' | 'brand' | 'quiet';
  iconSize?: number;
};

export const IconButton = forwardRef<View, IconButtonProps>(function IconButton(
  {
    label,
    name,
    selected,
    tone = 'surface',
    iconSize = 22,
    disabled,
    style,
    accessibilityState,
    accessibilityLabel = label,
    ...props
  },
  ref,
) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  const isSelected = selected ?? accessibilityState?.selected;
  const isDisabled = disabled ?? accessibilityState?.disabled ?? false;
  const color = isDisabled
    ? t.color.disabledInk
    : isSelected
      ? t.color.brandText
      : tone === 'brand'
        ? t.color.onBrand
        : t.color.ink;

  return (
    <Pressable
      {...props}
      ref={ref}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={isDisabled}
      {...controlStateProps(
        {
          ...accessibilityState,
          disabled: isDisabled,
          ...(isSelected !== undefined ? { selected: isSelected } : {}),
        },
        'button',
      )}
      style={(state) => [
        styles.button,
        tone === 'brand' && styles.brand,
        tone === 'quiet' && styles.quiet,
        isSelected && styles.selected,
        state.pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        typeof style === 'function' ? style(state) : style,
      ]}
    >
      <AppIcon name={name} size={iconSize} color={color} selected={!!isSelected} />
    </Pressable>
  );
});

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    button: {
      width: t.control.minimumTarget,
      height: t.control.minimumTarget,
      minWidth: t.control.minimumTarget,
      minHeight: t.control.minimumTarget,
      borderRadius: t.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      backgroundColor: t.color.surfaceMuted,
    },
    brand: { backgroundColor: t.color.brand },
    quiet: { backgroundColor: 'transparent' },
    selected: { backgroundColor: t.color.selection },
    pressed: { opacity: 0.7 },
    disabled: { backgroundColor: t.color.disabledSurface },
  });
