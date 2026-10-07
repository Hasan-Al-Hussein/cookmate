import type { AccessibilityRole, AccessibilityState } from 'react-native';

export function controlStateProps(state: AccessibilityState, _role: AccessibilityRole) {
  return { accessibilityState: state };
}
