import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useOptionalAccount } from './accountContext';
import { AppText } from '../../components/Typography';

/** The account entry reflects the current session without advertising a connection status. */
export function AccountEntry({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const identity = useOptionalAccount()?.state.identity;
  const initials = identity?.displayName
    ?.trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0])
    .join('')
    .toLocaleUpperCase();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Account"
      accessibilityHint={
        identity ? 'Manage your account and backup' : 'Local cooking and optional sign-in'
      }
      onPress={onPress}
      style={({ pressed }) => [styles.target, pressed && styles.pressed]}
    >
      <View
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.badge}
      >
        {initials ? (
          <AppText role="bodyStrong" color="brand">
            {initials}
          </AppText>
        ) : (
          <Svg width={22} height={22} viewBox="0 0 24 24" focusable={false}>
            <Circle cx={12} cy={8} r={3.25} fill="none" stroke={t.color.ink} strokeWidth={1.6} />
            <Path
              d="M5 20v-1.25A5.75 5.75 0 0 1 10.75 13h2.5A5.75 5.75 0 0 1 19 18.75V20"
              fill="none"
              stroke={t.color.ink}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          </Svg>
        )}
      </View>
    </Pressable>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    target: {
      width: t.control.minimumTarget,
      height: t.control.minimumTarget,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: t.radius.pill,
      flexShrink: 0,
    },
    badge: {
      width: 34,
      height: 34,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: { backgroundColor: t.color.selection },
  });
