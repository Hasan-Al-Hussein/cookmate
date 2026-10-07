import { useTheme } from '../../design/ThemeProvider';
import { StyleSheet, View } from 'react-native';
import { BrandMark } from '../../components/BrandMark';

/** A decorative cooking mark, never a control or connection-status indicator. */
export function AssistantEmblem() {
  const t = useTheme();

  return (
    <View
      aria-hidden
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.badge, { backgroundColor: t.color.assistant }]}
    >
      <BrandMark width={25} height={25} color={t.color.onAssistant} />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
