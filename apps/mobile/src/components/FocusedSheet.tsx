import { useLayoutEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemedStyles, type ThemeTokens } from '../design/ThemeProvider';
import { ActionButton } from './Controls';
import { AppText } from './Typography';
import { PreviewFrame } from './PreviewFrame';
import { focusTarget } from './focusTarget';
import { useSheetPresence } from './useSheetPresence';

/** Keeps the underlying task mounted while one supporting task owns focus. */
export function FocusedSheet({
  visible,
  title,
  onClose,
  onDismiss,
  onShow,
  closeLabel = 'Done',
  scroll = true,
  retainClosingContent = true,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  onDismiss?: () => void;
  onShow?: () => void;
  closeLabel?: string;
  scroll?: boolean;
  /** Disable only when current children remain valid after the caller closes the sheet. */
  retainClosingContent?: boolean;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  const heading = useRef<View>(null);
  const retained = useRef({ title, closeLabel, scroll, children });
  const wasVisible = useRef(visible);
  const presence = useSheetPresence({
    visible,
    onShow: () => {
      focusTarget(heading.current);
      onShow?.();
    },
    ...(onDismiss ? { onDismiss } : {}),
  });
  useLayoutEffect(() => {
    if (visible) retained.current = { title, closeLabel, scroll, children };
    else {
      if (wasVisible.current) Keyboard.dismiss();
      if (!presence.present) retained.current = { title, closeLabel, scroll, children: null };
    }
    wasVisible.current = visible;
  }, [children, closeLabel, presence.present, scroll, title, visible]);
  const display =
    visible || (presence.present && !retainClosingContent)
      ? { title, closeLabel, scroll, children }
      : presence.present
        ? retained.current
        : { title, closeLabel, scroll, children: null };
  const requestClose = () => {
    if (visible) onClose();
  };

  return (
    <Modal
      visible={presence.present}
      accessibilityLabel={display.title}
      animationType="none"
      presentationStyle="fullScreen"
      onRequestClose={requestClose}
      onDismiss={presence.onDismiss}
      onShow={presence.onShow}
    >
      <View style={styles.root} testID="focused-sheet-underlay">
        <PreviewFrame>
          <Animated.View
            style={[styles.root, presence.style, { pointerEvents: visible ? 'auto' : 'none' }]}
            accessibilityElementsHidden={!visible}
            importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
            {...(Platform.OS === 'web' ? { inert: !visible, 'aria-hidden': !visible } : {})}
          >
            <SafeAreaView style={styles.root} accessibilityViewIsModal>
              <KeyboardAvoidingView
                style={styles.root}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              >
                <View style={styles.header}>
                  <View ref={heading} accessible accessibilityRole="header" style={styles.title}>
                    <AppText role="section">{display.title}</AppText>
                  </View>
                  <ActionButton
                    label={display.closeLabel}
                    variant="quiet"
                    onPress={requestClose}
                    disabled={!visible}
                  />
                </View>
                {display.scroll ? (
                  <ScrollView
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={styles.content}
                  >
                    {display.children}
                  </ScrollView>
                ) : (
                  <View style={styles.body}>{display.children}</View>
                )}
              </KeyboardAvoidingView>
            </SafeAreaView>
          </Animated.View>
        </PreviewFrame>
      </View>
    </Modal>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, minHeight: 0, backgroundColor: t.color.canvas },
    header: {
      minHeight: 64,
      paddingHorizontal: t.space.gutter,
      paddingVertical: t.space.xxs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.xs,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    title: { flex: 1, minWidth: 0 },
    body: { flex: 1, minHeight: 0 },
    content: {
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
      padding: t.space.gutter,
      paddingBottom: t.space.xl,
      gap: t.space.md,
    },
  });
