import { useThemedStyles, type ThemeTokens } from '../design/ThemeProvider';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppText } from './Typography';

export function PreviewFrame({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.root}>
      <View style={styles.banner}>
        <AppText role="support">CookMate web preview · Browser-local data · AI unavailable</AppText>
      </View>
      {children}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, minHeight: 0 },
    banner: {
      backgroundColor: t.color.surface,
      borderBottomColor: t.color.divider,
      borderBottomWidth: 1,
      paddingHorizontal: t.space.gutter,
      paddingVertical: t.space.xs,
    },
  });
