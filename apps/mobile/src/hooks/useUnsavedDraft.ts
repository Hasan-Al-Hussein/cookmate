import { useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { confirmAction } from '../components/confirmAction';

/** Covers header Back, route replacement and iOS edge-swipe removal through the native stack. */
export function useUnsavedDraft(dirty: boolean, title: string) {
  const navigation = useNavigation();
  usePreventRemove(dirty, ({ data }) => {
    confirmAction({
      title,
      message: 'Your unconfirmed choices will be discarded.',
      cancelLabel: 'Keep editing',
      confirmLabel: 'Discard changes',
      destructive: true,
      onConfirm: () => navigation.dispatch(data.action),
    });
  });
}
