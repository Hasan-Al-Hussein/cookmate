import type { ConfirmationOptions } from './confirmAction';

export function confirmAction({ title, message, onConfirm }: ConfirmationOptions) {
  if (typeof globalThis.confirm === 'function' && globalThis.confirm(`${title}\n\n${message}`)) {
    onConfirm();
  }
}
