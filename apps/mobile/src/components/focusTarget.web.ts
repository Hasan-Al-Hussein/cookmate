import type { View } from 'react-native';

export function focusTarget(target: View | null): boolean {
  const element = target as unknown as HTMLElement | null;
  if (!element?.isConnected || typeof element.focus !== 'function') return false;
  let restoreTabIndex: (() => void) | undefined;
  try {
    // Headings need programmatic focus without joining the keyboard tab order.
    if (!element.hasAttribute('tabindex')) {
      element.setAttribute('tabindex', '-1');
      restoreTabIndex = () => {
        element.removeEventListener('blur', restoreTabIndex!);
        if (element.getAttribute('tabindex') === '-1') element.removeAttribute('tabindex');
      };
      element.addEventListener('blur', restoreTabIndex, { once: true });
    }
    element.focus({ preventScroll: true });
    const focused = element.ownerDocument.activeElement === element;
    if (!focused) restoreTabIndex?.();
    return focused;
  } catch {
    restoreTabIndex?.();
    return false;
  }
}
