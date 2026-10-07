import { Alert } from 'react-native';

export interface ConfirmationOptions {
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm(): void;
}

export function confirmAction({
  title,
  message,
  cancelLabel,
  confirmLabel,
  destructive,
  onConfirm,
}: ConfirmationOptions) {
  Alert.alert(title, message, [
    { text: cancelLabel, style: 'cancel' },
    {
      text: confirmLabel,
      ...(destructive ? { style: 'destructive' as const } : {}),
      onPress: onConfirm,
    },
  ]);
}
