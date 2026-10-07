import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { canonicalContentJson, type ReadingLookup } from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import type { ContentCookingHistoryPage } from '../../data/contentCookingHistoryRead';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useOptionalOrdinaryCatalogue } from '../content/OrdinaryCatalogue';
import type { ContentWorkspaceHost } from '../content/contentWorkspaceHost';
import { useOptionalContentPrivateState } from '../content/contentPrivateState';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import { ExactRecipePhoto, useExactPlanRecipe } from '../workspace/ExactRecipePhoto';
import {
  CookingHistoryEntryFrame,
  CookingHistoryList,
  type CookingHistoryListService,
} from './CookingHistoryList';

export type ContentHistoryHost = Pick<
  ContentWorkspaceHost,
  'history' | 'clearHistory' | 'readInstallationId' | 'getSnapshot' | 'subscribe'
> & {
  readerStore: Pick<ContentWorkspaceHost['readerStore'], 'subscribe'>;
};
type HistoryItem = Immutable<ContentCookingHistoryPage['items'][number]>;

/** Borrows the current host. Leaving ready state retires every row, review and clear callback. */
export function ContentCookingHistory({ host }: { host: ContentHistoryHost }) {
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  return state.status === 'ready' ? (
    <ReadyContentHistory key={state.scopeKey} host={host} scopeKey={state.scopeKey} />
  ) : (
    <Notice title="Cooking history is unavailable here">
      Cooking history cannot be checked while this workspace is unavailable. Return after its update
      or recovery finishes to check any pending change.
    </Notice>
  );
}

function ReadyContentHistory({ host, scopeKey }: { host: ContentHistoryHost; scopeKey: string }) {
  const privateState = useOptionalContentPrivateState();
  const mounted = useRef(true);
  const latestHost = useRef({ host, scopeKey });
  latestHost.current = { host, scopeKey };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = useCallback(() => {
    const state = host.getSnapshot();
    return (
      mounted.current &&
      latestHost.current.host === host &&
      latestHost.current.scopeKey === scopeKey &&
      state.status === 'ready' &&
      state.scopeKey === scopeKey
    );
  }, [host, scopeKey]);
  const service = useMemo<CookingHistoryListService<HistoryItem>>(
    () => ({
      readHistory: host.history.readHistory,
      ...host.clearHistory,
      subscribe(listener) {
        return host.readerStore.subscribe((change) => {
          if (isCurrent() && change.kind === 'cooking') listener(change.value);
        });
      },
    }),
    [host, isCurrent],
  );
  return (
    <CookingHistoryList
      service={service}
      readInstallationId={host.readInstallationId}
      {...(privateState ? { references: privateState.references.history } : {})}
      isCurrent={isCurrent}
      itemKey={(item) => item.entry.eventId}
      renderItem={(item) => <ContentHistoryEntry item={item} isCurrent={isCurrent} />}
      emptyContent={
        <>
          <AppText role="section">Your cooking history</AppText>
          <AppText>
            Saved or imported cooking entries will appear here. Explore your recipes to find
            something to cook.
          </AppText>
        </>
      }
      privacyDetails="These recorded meals and private notes belong to this workspace. Compatible backups include history only when explicitly selected. Reading progress is separate and is not exported."
    />
  );
}

function ContentHistoryEntry({ item, isCurrent }: { item: HistoryItem; isCurrent: () => boolean }) {
  const { entry, pin, source } = item;
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const exact = useExactPlanRecipe(pin.kind === 'exact' ? pin.ref : null);
  const catalogue = useOptionalOrdinaryCatalogue();
  const reader = catalogue?.reader,
    snapshot = catalogue?.state;
  const mounted = useRef(true);
  const latest = useRef({ reader, snapshot, item, isCurrent });
  latest.current = { reader, snapshot, item, isCurrent };
  const [currentRecipe, setCurrentRecipe] = useState<{
    reader: OrdinaryCatalogueController;
    snapshot: OrdinaryCatalogueState;
    lookup: ReadingLookup;
  } | null>(null);
  const [navigationError, setNavigationError] = useState(false);
  const [opening, setOpening] = useState(false);
  const navigating = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owns = useCallback(() => {
    if (
      !mounted.current ||
      !isCurrent() ||
      !reader ||
      snapshot?.kind !== 'ready' ||
      snapshot.mode !== 'content' ||
      latest.current.reader !== reader ||
      latest.current.snapshot !== snapshot ||
      latest.current.item !== item ||
      !latest.current.isCurrent()
    )
      return false;
    try {
      return reader.getSnapshot() === snapshot && !!snapshot.identity;
    } catch {
      return false;
    }
  }, [reader, snapshot, item, isCurrent]);
  useEffect(() => {
    let active = true;
    if (!reader || !snapshot || !owns()) return;
    void reader
      .readCurrent(entry.recipeId)
      .then((lookup) => {
        if (active && owns()) setCurrentRecipe({ reader, snapshot, lookup });
      })
      .catch(() => {
        if (active && owns()) setCurrentRecipe(null);
      });
    return () => {
      active = false;
    };
  }, [reader, snapshot, entry.recipeId, owns]);
  const current =
    currentRecipe &&
    currentRecipe.reader === reader &&
    currentRecipe.snapshot === snapshot &&
    owns()
      ? currentRecipe.lookup
      : null;
  const canPlan = current?.kind === 'readable' && current.state === 'current';
  const canView = pin.kind === 'exact' && exact.lookup?.kind === 'readable' && owns();
  const recipe = exact.lookup?.kind === 'readable' ? exact.lookup.recipe : null;
  const recordedPhoto = recipe?.media.find(
    (asset) =>
      asset.recipeId === entry.recipeId &&
      (entry.readerVersion === 2
        ? !!entry.photoAssetId && asset.assetId === entry.photoAssetId
        : !!entry.photoKey && asset.photoKey === entry.photoKey),
  );

  async function navigate(kind: 'exact' | 'current') {
    if (
      !reader ||
      !owns() ||
      navigating.current ||
      (kind === 'exact' && !canView) ||
      (kind === 'current' && !canPlan)
    )
      return;
    navigating.current = true;
    setOpening(true);
    setNavigationError(false);
    try {
      const result =
        kind === 'exact' && pin.kind === 'exact'
          ? await reader.readExact(pin.ref)
          : await reader.readCurrent(entry.recipeId);
      if (!owns()) return;
      if (
        result.kind !== 'readable' ||
        result.recipe.recipeId !== entry.recipeId ||
        (kind === 'current' && result.state !== 'current') ||
        (kind === 'exact' &&
          pin.kind === 'exact' &&
          canonicalContentJson(result.recipe.contentRef, 1024) !==
            canonicalContentJson(pin.ref, 1024))
      ) {
        setNavigationError(true);
        return;
      }
      const contentRef = canonicalContentJson(result.recipe.contentRef, 1024);
      if (kind === 'exact')
        router.push({ pathname: '/recipe/[id]', params: { id: entry.recipeId, contentRef } });
      else
        router.push({ pathname: '/plan-edit', params: { recipeId: entry.recipeId, contentRef } });
    } catch {
      if (owns()) setNavigationError(true);
    } finally {
      navigating.current = false;
      if (owns()) setOpening(false);
    }
  }
  return (
    <CookingHistoryEntryFrame
      title={entry.recipeTitle}
      cookedOn={entry.cookedOn}
      note={entry.note}
      {...(source === 'local' ? {} : { origin: source })}
      photo={
        pin.kind === 'exact' && recordedPhoto ? (
          <ExactRecipePhoto
            contentRef={pin.ref}
            assetId={recordedPhoto.assetId}
            compact
            aspectRatio={1}
          />
        ) : (
          <AppText role="support">Recorded photo unavailable</AppText>
        )
      }
    >
      {pin.kind === 'unresolved' ? (
        <AppText role="support">
          The exact recipe version for this entry could not be established. Its recorded title and
          note are kept here.
        </AppText>
      ) : exact.loading ? (
        <AppText role="support">Checking saved recipe version…</AppText>
      ) : !canView ? (
        <AppText role="support">
          This saved recipe version is unavailable. Its recorded title and note are kept here.
        </AppText>
      ) : exact.lookup?.kind === 'readable' && exact.lookup.state !== 'current' ? (
        <AppText role="support">
          Saved {exact.lookup.state === 'archived' ? 'archived' : 'historical'} recipe version
        </AppText>
      ) : null}
      <View style={styles.actions}>
        <ActionButton
          label="View recipe"
          accessibilityLabel={`View recipe ${entry.recipeTitle}`}
          variant="quiet"
          disabled={!canView || opening}
          onPress={() => void navigate('exact')}
        />
        {canPlan && (
          <ActionButton
            label="Plan current version"
            accessibilityLabel={`Plan current version of ${entry.recipeTitle}`}
            variant="secondary"
            disabled={opening}
            onPress={() => void navigate('current')}
          />
        )}
      </View>
      {navigationError && (
        <AppText role="support">
          This recipe changed or became unavailable. Reopen history before continuing.
        </AppText>
      )}
    </CookingHistoryEntryFrame>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({ actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm } });
