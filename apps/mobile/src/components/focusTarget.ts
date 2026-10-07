import { AccessibilityInfo, findNodeHandle, type View } from 'react-native';

export function focusTarget(target: View | null): boolean {
  const handle = target && findNodeHandle(target);
  if (!handle) return false;
  AccessibilityInfo.setAccessibilityFocus(handle);
  return true;
}
