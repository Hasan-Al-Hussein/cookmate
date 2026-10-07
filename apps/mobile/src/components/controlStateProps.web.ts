import type { AccessibilityRole, AccessibilityState } from 'react-native';

export function controlStateProps(state: AccessibilityState, role: AccessibilityRole) {
  return {
    ...((role === 'checkbox' || role === 'radio') && state.checked !== undefined
      ? { 'aria-checked': state.checked }
      : {}),
    ...(role === 'tab' && state.selected !== undefined ? { 'aria-selected': state.selected } : {}),
    ...(role === 'button' && state.selected !== undefined
      ? { 'aria-pressed': state.selected }
      : {}),
    ...(state.expanded !== undefined ? { 'aria-expanded': state.expanded } : {}),
    ...(state.busy !== undefined ? { 'aria-busy': state.busy } : {}),
    ...(state.disabled !== undefined ? { 'aria-disabled': state.disabled } : {}),
  };
}
