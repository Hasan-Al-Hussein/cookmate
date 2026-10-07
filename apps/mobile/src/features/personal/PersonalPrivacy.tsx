import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppIcon } from '../../components/Icon';
import { MotionPressable } from '../../components/MotionPressable';
import { AppText } from '../../components/Typography';
import { controlStateProps } from '../../components/controlStateProps';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';

export function PersonalPrivacy() {
  const [expanded, setExpanded] = useState(false);
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.group}>
      <AppText role="support" color="inkSecondary">
        Private to this workspace.
      </AppText>
      <MotionPressable
        accessibilityRole="button"
        accessibilityLabel="Privacy & storage details"
        {...controlStateProps({ expanded }, 'button')}
        onPress={() => setExpanded((open) => !open)}
        style={({ pressed }) => [styles.disclosure, pressed && styles.pressed]}
      >
        <AppText role="label" color="brandText" style={styles.label}>
          Privacy &amp; storage details
        </AppText>
        <View style={{ transform: [{ rotate: expanded ? '-90deg' : '90deg' }] }}>
          <AppIcon name="chevronRight" size={18} color={theme.color.brandText} />
        </View>
      </MotionPressable>
      {expanded && (
        <View style={styles.details}>
          <AppText role="support" color="inkSecondary">
            Notes, collections and manual shopping items stay in this local workspace and are not
            automatically sent to the assistant.
          </AppText>
          <AppText role="support" color="inkSecondary">
            Format-2 backups include these details as unencrypted data; older core backups exclude
            them. Review the backup’s contents before saving or sharing.
          </AppText>
          <AppText role="support" color="inkSecondary">
            Deleting an item here does not erase retained restore archives or files saved elsewhere.
            Clearing app or browser storage can remove local work.
          </AppText>
        </View>
      )}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    group: { gap: t.space.xxs },
    disclosure: {
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: t.space.xs,
      paddingVertical: t.space.xs,
      borderRadius: t.radius.small,
    },
    label: { flexShrink: 1 },
    pressed: { backgroundColor: t.color.selection },
    details: { gap: t.space.sm, paddingBottom: t.space.xs },
  });
