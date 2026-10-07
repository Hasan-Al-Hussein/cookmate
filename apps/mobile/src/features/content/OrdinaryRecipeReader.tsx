import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canonicalContentJson,
  validateRecipeContentRef,
  type ReadingLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { ActionButton, Notice } from '../../components/Controls';
import { IconButton } from '../../components/Icon';
import { Page } from '../../components/Page';
import { AppText } from '../../components/Typography';
import {
  ContentRecipeReaderView,
  type ContentCookingReadingParts,
} from './ContentRecipeReaderView';
import { useOptionalOrdinaryCatalogue } from './OrdinaryCatalogue';
import type { OrdinaryCatalogueController, OrdinaryCatalogueState } from './ordinaryCatalogueState';
import { useFocusEffect, useRouter } from 'expo-router';
import { View } from 'react-native';
import { focusTarget } from '../../components/focusTarget';
import { ContentCookingReader } from '../cooking/ContentCookingReader';
import { useOrdinaryContentRuntime } from './ordinaryContentRuntimeContext';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { FavouriteButton } from '../workspace/FavouritesState';
import { WorkspaceFeedback } from '../workspace/WorkspaceFeedback';
import { RecipePersonalEntry } from '../personal/RecipePersonalEntry';
import { useRecordRecentRecipe } from '../recently-viewed/useRecordRecentRecipe';

type Section = 'ingredients' | 'instructions' | 'source';
type Target =
  | { readonly kind: 'current'; readonly recipeId: string }
  | { readonly kind: 'exact'; readonly ref: Readonly<RecipeContentRef> };
interface Props {
  recipeId: unknown;
  /** A single, bounded JSON route parameter. It is a reference, never content authority. */
  contentRef?: unknown;
  section?: unknown;
  cook?: unknown;
  onBack(): void;
}
type Ready = Extract<OrdinaryCatalogueState, { kind: 'ready' }>;

export function ordinaryRecipeTarget(id: unknown, serialized: unknown): Target | null {
  if (typeof id !== 'string' || !/^[0-9]{1,20}$/.test(id)) return null;
  if (serialized === undefined) return Object.freeze({ kind: 'current', recipeId: id });
  if (typeof serialized !== 'string' || serialized.length > 1024) return null;
  try {
    const ref: unknown = JSON.parse(serialized);
    // Descriptor-safe canonicalization also enforces the UTF-8 bound before use.
    canonicalContentJson(ref, 1024);
    if (!validateRecipeContentRef(ref) || ref.recipeId !== id) return null;
    return Object.freeze({ kind: 'exact', ref: Object.freeze(ref) });
  } catch {
    return null;
  }
}

function Unavailable({
  onBack,
  retry,
  exact = false,
}: {
  onBack(): void;
  retry?: () => void;
  exact?: boolean;
}) {
  return (
    <Page bottomInset>
      <IconButton name="back" label="Back" onPress={onBack} />
      <Notice
        title={exact ? 'Saved recipe version unavailable' : 'Recipe could not be opened'}
        tone="caution"
      >
        <AppText>
          This recipe version could not be verified for the current workspace. Return to your recipe
          list or saved record. Your saved data has not been changed.
        </AppText>
      </Notice>
      {retry && <ActionButton label="Try again" onPress={retry} />}
    </Page>
  );
}

/** Ordinary recipe route, using only the live catalogue's issued content reader. */
export function OrdinaryRecipeReader({ recipeId, contentRef, section, cook, onBack }: Props) {
  const catalogue = useOptionalOrdinaryCatalogue();
  const target = useMemo(() => ordinaryRecipeTarget(recipeId, contentRef), [recipeId, contentRef]);
  const initialSection: Section =
    cook === 'resume'
      ? 'instructions'
      : section === 'source' || section === 'instructions'
        ? section
        : 'ingredients';
  const mounted = useRef(true);
  const render = { catalogue, target, initialSection };
  const latest = useRef(render);
  latest.current = render;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = () => mounted.current && latest.current === render;
  const back = () => {
    if (active()) onBack();
  };
  if (!target) return <Unavailable onBack={back} exact={contentRef !== undefined} />;
  if (catalogue?.state.kind === 'loading')
    return (
      <Page bottomInset>
        <IconButton name="back" label="Back" onPress={back} />
        <AppText role="support">Opening this recipe version…</AppText>
      </Page>
    );
  const reader = catalogue?.reader;
  const snapshot = catalogue?.state;
  if (
    !reader ||
    snapshot?.kind !== 'ready' ||
    snapshot.mode !== 'content' ||
    snapshot.photoMode !== 'verified' ||
    !reader.onPhotoCleanupFailure
  ) {
    const retry =
      snapshot?.kind === 'failed' && reader
        ? () => {
            if (active() && reader.getSnapshot() === snapshot) reader.retry();
          }
        : undefined;
    return (
      <Unavailable onBack={back} exact={target.kind === 'exact'} {...(retry ? { retry } : {})} />
    );
  }
  return (
    <Reader
      key={canonicalContentJson([snapshot.scopeKey, target, initialSection])}
      reader={reader}
      snapshot={snapshot}
      target={target}
      initialSection={initialSection}
      resumeCooking={cook === 'resume'}
      onBack={back}
      onCleanupFailure={reader.onPhotoCleanupFailure}
    />
  );
}

function Reader({
  reader,
  snapshot,
  target,
  initialSection,
  resumeCooking,
  onBack,
  onCleanupFailure,
}: {
  reader: OrdinaryCatalogueController;
  snapshot: Ready;
  target: Target;
  initialSection: Section;
  resumeCooking: boolean;
  onBack(): void;
  onCleanupFailure: NonNullable<OrdinaryCatalogueController['onPhotoCleanupFailure']>;
}) {
  const router = useRouter();
  const runtime = useOrdinaryContentRuntime();
  const { clock } = useWorkspace();
  const [cookingVisible, setCookingVisible] = useState(resumeCooking);
  const cookingTrigger = useRef<View>(null);
  const pendingWatch = useRef<(() => void) | null>(null);
  useFocusEffect(
    useCallback(
      () => () => {
        pendingWatch.current = null;
        setCookingVisible(false);
      },
      [],
    ),
  );
  const [state, setState] = useState<
    | { kind: 'loading' | 'failed' }
    | { kind: 'ready'; lookup: ReadingLookup; snapshot: Ready; reader: OrdinaryCatalogueController }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  const latest = useRef({ reader, snapshot });
  latest.current = { reader, snapshot };
  const ports = useMemo(
    () => ({
      readCurrent: reader.readCurrent.bind(reader),
      readExact: reader.readExact.bind(reader),
      readPhoto: reader.readPhoto.bind(reader),
      getSnapshot: reader.getSnapshot.bind(reader),
    }),
    [reader],
  );
  const current = useCallback(() => {
    if (
      !mounted.current ||
      latest.current.reader !== reader ||
      latest.current.snapshot !== snapshot
    )
      return false;
    try {
      if (ports.getSnapshot() !== snapshot) return false;
      // The ready identity getter also checks the host before its subscription has propagated.
      void snapshot.identity;
      return true;
    } catch {
      return false;
    }
  }, [ports, reader, snapshot]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    void Promise.resolve()
      .then(async () => {
        if (!active || !current()) return;
        const lookup =
          target.kind === 'exact'
            ? await ports.readExact(target.ref)
            : await ports.readCurrent(target.recipeId);
        if (!active || !current()) return;
        setState({ kind: 'ready', lookup, reader, snapshot });
      })
      .catch(() => {
        if (active && current()) setState({ kind: 'failed' });
      });
    return () => {
      active = false;
    };
  }, [ports, target, reader, snapshot, current, attempt]);
  const readPhoto = useCallback<OrdinaryCatalogueController['readPhoto']>(
    async (ref, assetId, signal) => {
      if (!current()) throw new Error('Recipe workspace changed');
      const result = await ports.readPhoto(ref, assetId, signal);
      if (!current()) throw new Error('Recipe workspace changed');
      return result;
    },
    [current, ports],
  );
  const back = () => {
    if (current()) onBack();
  };
  useRecordRecentRecipe({
    visitKey: canonicalContentJson(target, 2048),
    contentRef:
      state.kind === 'ready' &&
      state.reader === reader &&
      state.snapshot === snapshot &&
      state.lookup.kind === 'readable'
        ? state.lookup.recipe.contentRef
        : null,
    isCurrent: current,
  });
  if (!current()) return <Unavailable onBack={onBack} exact={target.kind === 'exact'} />;
  if (state.kind === 'failed')
    return (
      <Unavailable
        onBack={back}
        exact={target.kind === 'exact'}
        retry={() => {
          if (current()) setAttempt((value) => value + 1);
        }}
      />
    );
  if (state.kind !== 'ready' || state.reader !== reader || state.snapshot !== snapshot)
    return (
      <Page bottomInset>
        <IconButton name="back" label="Back" onPress={back} />
        <AppText role="support">Opening this recipe version…</AppText>
      </Page>
    );
  return (
    <ContentRecipeReaderView
      lookup={state.lookup}
      scopeKey={snapshot.scopeKey}
      initialSection={initialSection}
      readPhoto={readPhoto}
      onBack={back}
      saveControl={
        state.lookup.kind === 'readable' && state.lookup.state !== 'historical' ? (
          <FavouriteButton
            recipeId={state.lookup.recipe.recipeId}
            title={state.lookup.recipe.title}
            compact
            inline
            canSave={state.lookup.state === 'current'}
          />
        ) : null
      }
      workspaceFeedback={<WorkspaceFeedback />}
      cookingControl={
        runtime && state.lookup.kind === 'readable' ? (
          <ActionButton
            ref={cookingTrigger}
            label="Cooking view"
            variant="secondary"
            onPress={() => {
              if (current()) setCookingVisible(true);
            }}
          />
        ) : null
      }
      {...(runtime
        ? {
            renderCooking: (parts: ContentCookingReadingParts) => (
              <ContentCookingReader
                {...parts}
                host={runtime.host}
                scopeKey={snapshot.scopeKey}
                clock={clock}
                visible={cookingVisible}
                onClose={() => {
                  pendingWatch.current = null;
                  if (current()) setCookingVisible(false);
                }}
                {...(parts.onWatch
                  ? {
                      onWatch: () => {
                        if (!current()) return;
                        pendingWatch.current = parts.onWatch!;
                        setCookingVisible(false);
                      },
                    }
                  : {})}
                onDismiss={() => {
                  const watch = pendingWatch.current;
                  pendingWatch.current = null;
                  if (!current()) return;
                  if (watch) watch();
                  else focusTarget(cookingTrigger.current);
                }}
                onResumeRecipe={(ref: RecipeContentRef) => {
                  if (current()) {
                    pendingWatch.current = null;
                    router.replace({
                      pathname: '/recipe/[id]',
                      params: {
                        id: ref.recipeId,
                        contentRef: canonicalContentJson(ref, 1024),
                        cook: 'resume',
                      },
                    });
                  }
                }}
              />
            ),
          }
        : {})}
      personalControl={
        <RecipePersonalEntry
          recipeId={target.kind === 'exact' ? target.ref.recipeId : target.recipeId}
          {...(state.lookup.kind === 'readable'
            ? { contentRef: state.lookup.recipe.contentRef }
            : target.kind === 'exact'
              ? { contentRef: target.ref }
              : {})}
          isCurrent={current}
        />
      }
      onPlan={(ref) => {
        if (current())
          router.push({
            pathname: '/plan-edit',
            params: { recipeId: ref.recipeId, contentRef: canonicalContentJson(ref, 1024) },
          });
      }}
      // Cleanup must reach the resource owner even after this reading scope has retired.
      onCleanupFailure={onCleanupFailure}
    />
  );
}
