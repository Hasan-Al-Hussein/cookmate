import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { StyleSheet, View } from 'react-native';
import { AppIcon } from '../../components/Icon';

export function ConnectionSettings({ showTitle = true }: { showTitle?: boolean }) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.section}>
      {showTitle && (
        <View style={styles.heading}>
          <AppIcon name="chat" color={t.color.assistantText} />
          <AppText role="section" accessibilityRole="header" style={styles.title}>
            AI connection
          </AppText>
        </View>
      )}
      <Notice title="Pairing is unavailable in this web preview">
        <AppText>
          Open AI connection in the iPhone app to pair with your laptop. This browser preview
          supports local cooking workflows without an AI connection.
        </AppText>
      </Notice>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
    heading: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    title: { flex: 1, minWidth: 0 },
  });
