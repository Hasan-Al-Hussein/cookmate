import { Image, Platform, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { MotionPressable } from '../../components/MotionPressable';
import { AppText } from '../../components/Typography';
import { controlStateProps } from '../../components/controlStateProps';
import { useTheme, useThemeMode } from '../../design/ThemeProvider';

/** Presentation only: provider capability and sign-in remain owned by the caller. */
export function ProviderSignInButton({
  provider,
  label = `Continue with ${provider === 'apple' ? 'Apple' : 'Google'}`,
  disabled = false,
  onPress,
}: {
  provider: 'apple' | 'google';
  label?: string;
  disabled?: boolean;
  onPress(): void;
}) {
  const t = useTheme();
  const dark = useThemeMode() === 'dark';
  const apple = provider === 'apple';
  const background = apple
    ? dark
      ? disabled
        ? '#D2D0CA'
        : '#FFFFFF'
      : disabled
        ? '#494947'
        : '#000000'
    : dark
      ? '#131314'
      : '#FFFFFF';
  const foreground = apple
    ? dark
      ? '#131314'
      : '#FFFFFF'
    : disabled
      ? t.color.disabledInk
      : dark
        ? '#E3E3E3'
        : '#1F1F1F';

  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...controlStateProps({ disabled }, 'button')}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: apple
            ? background
            : disabled
              ? t.color.divider
              : dark
                ? '#8E918F'
                : '#747775',
          borderRadius: t.radius.control,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.logo}
      >
        {apple ? (
          <Svg
            width={20}
            height={25}
            viewBox="20.5 16 15 19"
            focusable={false}
            {...(Platform.OS === 'web' ? { 'aria-hidden': true } : { accessible: false })}
          >
            <Path
              fill={foreground}
              fillRule="nonzero"
              d="M28.2226562,20.3846154 C29.0546875,20.3846154 30.0976562,19.8048315 30.71875,19.0317864 C31.28125,18.3312142 31.6914062,17.352829 31.6914062,16.3744437 C31.6914062,16.2415766 31.6796875,16.1087095 31.65625,16 C30.7304687,16.0362365 29.6171875,16.640178 28.9492187,17.4494596 C28.421875,18.06548 27.9414062,19.0317864 27.9414062,20.0222505 C27.9414062,20.1671964 27.9648438,20.3121424 27.9765625,20.3604577 C28.0351562,20.3725366 28.1289062,20.3846154 28.2226562,20.3846154 Z M25.2929688,35 C26.4296875,35 26.9335938,34.214876 28.3515625,34.214876 C29.7929688,34.214876 30.109375,34.9758423 31.375,34.9758423 C32.6171875,34.9758423 33.4492188,33.792117 34.234375,32.6325493 C35.1132812,31.3038779 35.4765625,29.9993643 35.5,29.9389701 C35.4179688,29.9148125 33.0390625,28.9122695 33.0390625,26.0979021 C33.0390625,23.6579784 34.9140625,22.5588048 35.0195312,22.474253 C33.7773438,20.6382708 31.890625,20.5899555 31.375,20.5899555 C29.9804688,20.5899555 28.84375,21.4596313 28.1289062,21.4596313 C27.3554688,21.4596313 26.3359375,20.6382708 25.1289062,20.6382708 C22.8320312,20.6382708 20.5,22.5950413 20.5,26.2911634 C20.5,28.5861411 21.3671875,31.013986 22.4335938,32.5842339 C23.3476562,33.9129053 24.1445312,35 25.2929688,35 Z"
            />
          </Svg>
        ) : (
          <Image
            source={require('../../../assets/brand/google-g.png')}
            resizeMode="contain"
            accessible={false}
            style={styles.googleLogo}
          />
        )}
      </View>
      <AppText role="control" style={[styles.label, { color: foreground }]}>
        {label}
      </AppText>
      <View accessible={false} style={styles.balance} />
    </MotionPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  logo: { width: 24, height: 26, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  googleLogo: { width: 22, height: 22 },
  label: { flex: 1, textAlign: 'center' },
  balance: { width: 24, flexShrink: 0 },
});
