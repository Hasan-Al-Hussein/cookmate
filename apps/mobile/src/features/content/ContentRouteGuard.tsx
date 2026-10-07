import { useMemo, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Page, PageHeader } from '../../components/Page';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { AppearanceSettings } from '../settings/AppearanceSettings';
import { PlanningSettings } from '../settings/PlanningSettings';
import { RecentlyViewedSettings } from '../recently-viewed/RecentlyViewedSettings';
import { ContentBackupSettings } from '../backup/ContentBackupSettings';
import { useOrdinaryContentRuntime } from './ordinaryContentRuntimeContext';
import { useOptionalContentAccount } from './contentAccountContext';
import { ContentAccountScreen } from './ContentAccountScreen';
import { ContentAccountCallback } from './ContentAccountCallback';

/** Prevent an unfinished content route from silently reaching packaged/account-only services. */
export function ContentRouteGuard({
  route,
  level,
  params,
  children,
}: {
  route: string;
  level: 'stack' | 'tab';
  /** The layout wrapper lives outside the screen's local search-parameter context. */
  params?: object | undefined;
  children: ReactNode;
}) {
  const runtime = useOrdinaryContentRuntime();
  const account = useOptionalContentAccount();
  if (!runtime) return children;
  if (level === 'stack' && account && route === 'account') return <ContentAccountScreen />;
  if (level === 'stack' && account && route === 'auth/callback') return <ContentAccountCallback />;
  if (
    level === 'stack' &&
    [
      '(tabs)',
      'recipe/[id]',
      'private-content',
      'plan-edit',
      'shopping-meals',
      'cooking-history',
      'recipe-personal/[id]',
      'manual-shopping',
      'collections',
      'collection/[id]',
    ].includes(route)
  )
    return children;
  if (level === 'tab' && ['index', 'plan', 'favourites'].includes(route)) return children;
  if (level === 'tab' && route === 'settings')
    return (
      <ContentSettings
        section={
          params && 'section' in params && typeof params.section === 'string'
            ? params.section
            : undefined
        }
      />
    );
  return <ContentRouteUnavailable route={route} back={level === 'stack'} />;
}

function ContentRouteUnavailable({ route, back }: { route: string; back: boolean }) {
  const router = useRouter();
  const title =
    (
      {
        favourites: 'Favourites',
        plan: 'Your plan',
        assistant: 'CookMate Assistant',
        account: 'Account & sync',
      } as Record<string, string>
    )[route] ?? 'Saved cooking';
  return (
    <Page>
      <PageHeader title={title} back={back} />
      <Notice title="This content workspace is still being connected">
        <AppText>
          Recipe browsing and reading are available here. This screen is not yet connected to this
          installation’s saved data. Your usual CookMate workspace has not been opened or changed.
        </AppText>
      </Notice>
      <ActionButton label="Explore recipes" onPress={() => router.navigate('/')} />
    </Page>
  );
}

function ContentSettings({ section }: { section: string | undefined }) {
  const router = useRouter();
  const runtime = useOrdinaryContentRuntime();
  const account = useOptionalContentAccount();
  const backupHost = useMemo(
    () =>
      runtime
        ? {
            getSnapshot: runtime.host.getSnapshot,
            subscribe: runtime.host.subscribe,
            backup: runtime.host.backup,
            restore: {
              service: runtime.host.restore,
              readInstallationId: runtime.host.readInstallationId,
            },
          }
        : null,
    [runtime],
  );
  if (!runtime || !backupHost) return null;
  if (section === 'recently-viewed')
    return (
      <Page>
        <PageHeader title="Recently viewed" back onBack={() => router.setParams({ section: '' })} />
        <RecentlyViewedSettings showTitle={false} />
      </Page>
    );
  if (section === 'planning')
    return (
      <Page>
        <PageHeader
          title="Planning defaults"
          back
          onBack={() => router.setParams({ section: '' })}
        />
        <PlanningSettings showTitle={false} />
      </Page>
    );
  if (section === 'backup')
    return (
      <Page>
        <PageHeader title="Backup & files" back onBack={() => router.setParams({ section: '' })} />
        <ContentBackupSettings host={backupHost} showTitle={false} />
      </Page>
    );
  return (
    <Page>
      <PageHeader title="Settings" />
      <Notice title="Separate content installation">
        <AppText>
          Appearance settings, cooking history and private recipe notes belong to this installation.
          Backup export, inspection and reviewed restore use this same saved data.{' '}
          {account
            ? 'Account & sync shows the availability and review choices for this installation.'
            : 'Account sync is not yet connected here.'}
        </AppText>
      </Notice>
      <AppearanceSettings />
      <ActionButton
        label="Recently viewed"
        variant="secondary"
        onPress={() => router.setParams({ section: 'recently-viewed' })}
      />
      <ActionButton
        label="Planning defaults"
        variant="secondary"
        onPress={() => router.setParams({ section: 'planning' })}
      />
      {account && (
        <ActionButton
          label="Account & sync"
          variant="secondary"
          onPress={() => router.push('/account')}
        />
      )}
      <ActionButton
        label="Backup & files"
        variant="secondary"
        onPress={() => router.setParams({ section: 'backup' })}
      />
      <ActionButton
        label="Cooking history"
        variant="secondary"
        onPress={() => router.push('/cooking-history')}
      />
      {section && section !== 'appearance' && (
        <AppText role="support">
          The requested Settings section is not available in this content installation.
        </AppText>
      )}
      <ActionButton
        label="Recipe content updates"
        variant="secondary"
        onPress={() => router.push('/private-content')}
      />
    </Page>
  );
}
