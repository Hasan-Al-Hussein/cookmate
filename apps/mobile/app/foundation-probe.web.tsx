import { Notice } from '../src/components/Controls';
import { Page, PageHeader } from '../src/components/Page';

export default function DiagnosticRoute() {
  return (
    <Page>
      <PageHeader back />
      <Notice title="Native checks are unavailable in this web preview">
        Run the foundation probe in the iPhone app. Browser behavior cannot verify native device
        storage or secure credentials.
      </Notice>
    </Page>
  );
}
