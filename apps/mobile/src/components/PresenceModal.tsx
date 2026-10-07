import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Keyboard,
  Modal,
  Platform,
  StyleSheet,
  View,
  type ModalProps,
} from 'react-native';
import { useThemedStyles, type ThemeTokens } from '../design/ThemeProvider';
import { PreviewFrame } from './PreviewFrame';
import { useSheetPresence } from './useSheetPresence';

/** Retained visuals must never retain an old handler's permission to act. */
export function useModalAction<Args extends unknown[]>(
  active: boolean,
  action: (...args: Args) => void,
) {
  const current = useRef({ active, action });
  current.current = { active, action };
  useLayoutEffect(() => {
    current.current.active = active;
    return () => {
      current.current.active = false;
    };
  }, [active]);
  return useCallback((...args: Args) => {
    if (current.current.active) current.current.action(...args);
  }, []);
}

/** Keeps only inert closing visuals; callers retain approval, draft and command ownership. */
export function PresenceModal({
  visible,
  onRequestClose,
  onDismiss,
  onShow,
  children,
  preview = false,
  accessibilityLabel,
  ...modalProps
}: Pick<ModalProps, 'presentationStyle' | 'accessibilityLabel'> & {
  visible: boolean;
  onRequestClose: () => void;
  onDismiss?: () => void;
  onShow?: () => void;
  children: ReactNode;
  preview?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const retained = useRef({ children, accessibilityLabel });
  const wasVisible = useRef(visible);
  const presence = useSheetPresence({
    visible,
    ...(onShow ? { onShow } : {}),
    ...(onDismiss ? { onDismiss } : {}),
  });
  const requestClose = useModalAction(visible, onRequestClose);
  useLayoutEffect(() => {
    if (visible) retained.current = { children, accessibilityLabel };
    else {
      if (wasVisible.current) Keyboard.dismiss();
      if (!presence.present) retained.current = { children: null, accessibilityLabel };
    }
    wasVisible.current = visible;
  }, [accessibilityLabel, children, presence.present, visible]);
  const display = visible
    ? { children, accessibilityLabel }
    : presence.present
      ? retained.current
      : { children: null, accessibilityLabel };
  const surface = (
    <Animated.View
      style={[styles.root, presence.style, { pointerEvents: visible ? 'auto' : 'none' }]}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      {...(Platform.OS === 'web' ? { inert: !visible, 'aria-hidden': !visible } : {})}
    >
      {display.children}
    </Animated.View>
  );
  return (
    <Modal
      {...modalProps}
      {...(display.accessibilityLabel ? { accessibilityLabel: display.accessibilityLabel } : {})}
      visible={presence.present}
      animationType="none"
      onRequestClose={requestClose}
      onShow={presence.onShow}
      onDismiss={presence.onDismiss}
    >
      <View style={styles.root} testID="presence-modal-underlay">
        {preview ? <PreviewFrame>{surface}</PreviewFrame> : surface}
      </View>
    </Modal>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({ root: { flex: 1, minHeight: 0, backgroundColor: t.color.canvas } });
