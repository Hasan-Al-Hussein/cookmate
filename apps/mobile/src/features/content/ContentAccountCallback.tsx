import { useEffect } from 'react';
import { Page } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { useContentAccount } from './contentAccountContext';

/** Same supported callback, routed only to this installation's owned auth client. */
export function ContentAccountCallback() {
  const { completeCallback } = useContentAccount();
  useEffect(() => {
    completeCallback();
  }, [completeCallback]);
  return (
    <Page>
      <AppText role="title">Finishing sign-in…</AppText>
      <AppText>
        Your local cooking is kept while CookMate checks this installation’s sign-in response.
      </AppText>
    </Page>
  );
}
