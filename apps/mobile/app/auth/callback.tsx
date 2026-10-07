import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { Platform } from 'react-native';
import { Page } from '../../src/components/Page';
import { AppText } from '../../src/components/Typography';
import { useAccount } from '../../src/features/account/AccountProvider';

export default function AccountCallback() {
  const { runtime } = useAccount();
  const router = useRouter();
  const started = useRef(false);
  useEffect(() => {
    if (started.current || Platform.OS !== 'web') return;
    started.current = true;
    const href = window.location.href;
    window.history.replaceState(window.history.state, '', '/auth/callback');
    void runtime.completeCallback(href).finally(() => router.replace('/account'));
  }, [runtime, router]);
  return (
    <Page>
      <AppText role="title">Finishing sign-in…</AppText>
      <AppText>Your local cooking is kept while CookMate checks the sign-in response.</AppText>
    </Page>
  );
}
