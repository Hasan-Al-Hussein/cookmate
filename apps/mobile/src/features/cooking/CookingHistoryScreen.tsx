import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { getRecipe } from '@cookmate/catalogue';
import type {
  CookMateQueries,
  CookingHistoryEntry,
  CookingService,
  Immutable,
} from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { Page, PageHeader } from '../../components/Page';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import { ContentCookingHistory } from './ContentCookingHistory';
import { CookingHistoryList, CookingHistoryEntryFrame } from './CookingHistoryList';
export default function CookingHistoryScreen() {
  const runtime = useOrdinaryContentRuntime();
  return (
    <Page bottomInset>
      <PageHeader back title="Cooking history" />
      {runtime ? <ContentCookingHistory host={runtime.host} /> : <LegacyCookingHistory />}
    </Page>
  );
}
function LegacyCookingHistory() {
  const { availability } = useWorkspace();
  const service = availability.kind === 'ready' ? availability.services.cooking : undefined;
  return (
    <>
      {service && availability.kind === 'ready' ? (
        <CookingHistory
          service={service}
          readInstallationId={availability.services.queries.readInstallationId}
        />
      ) : (
        <Notice title="Cooking history is unavailable here">
          This build has no active local cooking-history service. No history or notes have been
          created.
        </Notice>
      )}
    </>
  );
}

export function CookingHistory({
  service,
  readInstallationId,
}: {
  service: CookingService;
  readInstallationId: CookMateQueries['readInstallationId'];
}) {
  return (
    <CookingHistoryList<Immutable<CookingHistoryEntry>>
      service={service}
      readInstallationId={readInstallationId}
      cookedRecovery={service}
      itemKey={(entry) => entry.eventId}
      renderItem={(entry) => <HistoryEntry entry={entry} />}
      emptyContent={
        <>
          <AppText role="section">Cook something worth remembering.</AppText>
          <AppText>
            Explore a recipe and mark “I cooked this” in its cooking view when you’re done. Viewing
            or planning a recipe never adds it here.
          </AppText>
        </>
      }
      privacyDetails="These entries and reading progress stay in this workspace. Format-2 backups include cooking history and private cooking notes only when you explicitly select them for that export. Older core backups and ordinary exports without that choice exclude history. Reading progress is not exported."
    />
  );
}

function HistoryEntry({ entry }: { entry: Immutable<CookingHistoryEntry> }) {
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const current = getRecipe(entry.recipeId);
  const photoMatches = current?.photoKey === entry.photoKey;
  return (
    <CookingHistoryEntryFrame
      title={entry.recipeTitle}
      cookedOn={entry.cookedOn}
      note={entry.note}
      {...(entry.origin === 'backup' ? { origin: 'backup' as const } : {})}
      photo={
        photoMatches ? (
          <RecipePhoto
            compact
            recipeId={entry.recipeId}
            title={entry.recipeTitle}
            aspectRatio={1}
          />
        ) : (
          <AppText role="support">Recorded photo unavailable</AppText>
        )
      }
    >
      {!current && (
        <AppText role="support">This recipe is no longer in the available catalogue.</AppText>
      )}
      <View style={styles.actions}>
        <ActionButton
          label="View recipe"
          accessibilityLabel={`View recipe ${entry.recipeTitle}`}
          variant="quiet"
          disabled={!current}
          onPress={() => router.push({ pathname: '/recipe/[id]', params: { id: entry.recipeId } })}
        />
        <ActionButton
          label="Plan again"
          accessibilityLabel={`Plan ${entry.recipeTitle} again`}
          variant="secondary"
          disabled={!current}
          onPress={() =>
            router.push({ pathname: '/plan-edit', params: { recipeId: entry.recipeId } })
          }
        />
      </View>
    </CookingHistoryEntryFrame>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm },
  });
