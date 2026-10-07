import { useEffect, useState } from 'react';
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
import type { openContentCookingStore } from '../../data/contentCookingStore';
import { ContentRecipeReaderView } from './ContentRecipeReaderView';
import type { ContentPhotoResource } from './contentPhotoResourceTypes';

export type ContentRecipeTarget =
  | { kind: 'current'; recipeId: string }
  | { kind: 'exact'; ref: RecipeContentRef };
type Cooking = Awaited<ReturnType<typeof openContentCookingStore>>;
type Store = {
  content: Pick<Cooking['content'], 'readExact' | 'readCurrent' | 'readPhoto'>;
  subscribe: Cooking['subscribe'];
};
interface Props {
  store: Store;
  target: ContentRecipeTarget;
  /** The host changes this immediately on owner or content-policy revocation. */
  scopeKey: string;
  onBack(): void;
  onCleanupFailure(resource: ContentPhotoResource): void;
  onPlan?(ref: RecipeContentRef): void;
}
type State =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; lookup: ReadingLookup; readingKey: string; store: Store };

/** Real-store consumer. It never resolves an exact history/plan target through the current ID. */
export function ContentRecipeReader(props: Props) {
  const valid =
    props.target.kind === 'exact'
      ? validateRecipeContentRef(props.target.ref)
      : props.target.kind === 'current' && /^[0-9]{1,20}$/.test(props.target.recipeId);
  if (!valid) return <Unavailable onBack={props.onBack} />;
  return <Reader key={canonicalContentJson([props.scopeKey, props.target])} {...props} />;
}
function Unavailable({ onBack, retry }: { onBack(): void; retry?: () => void }) {
  return (
    <Page bottomInset>
      <IconButton name="back" label="Back" onPress={onBack} />
      <Notice title="Recipe could not be opened" tone="caution">
        <AppText>
          This recipe version could not be verified for the current workspace. Your saved record has
          not been changed.
        </AppText>
      </Notice>
      {retry && <ActionButton label="Try again" onPress={retry} />}
    </Page>
  );
}
function Reader({ store, target, scopeKey, onBack, onPlan, onCleanupFailure }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Capture the full target once for this keyed screen; later caller mutation is not authority.
  const [ownedTarget] = useState(
    () => JSON.parse(canonicalContentJson(target)) as ContentRecipeTarget,
  );
  useEffect(() => {
    let active = true,
      generation = 0;
    const load = () => {
      const ticket = ++generation;
      setState({ kind: 'loading' });
      void Promise.resolve()
        .then(() => {
          if (!active || ticket !== generation) return null;
          return ownedTarget.kind === 'exact'
            ? store.content.readExact(ownedTarget.ref)
            : store.content.readCurrent(ownedTarget.recipeId);
        })
        .then((result) => {
          if (!result) return;
          if (!active || ticket !== generation) return;
          setState({
            kind: 'ready',
            lookup: result.value,
            readingKey: canonicalContentJson([scopeKey, result.head, result.adoptionRevision]),
            store,
          });
        })
        .catch(() => {
          if (active && ticket === generation) setState({ kind: 'failed' });
        });
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = store.subscribe((change) => {
        if (active && change.kind === 'adoption') load();
      });
      load();
    } catch {
      setState({ kind: 'failed' });
    }
    return () => {
      active = false;
      generation++;
      unsubscribe?.();
    };
  }, [store, ownedTarget, scopeKey, attempt]);
  if (state.kind === 'failed')
    return <Unavailable onBack={onBack} retry={() => setAttempt((value) => value + 1)} />;
  if (state.kind === 'loading' || state.store !== store)
    return (
      <Page bottomInset>
        <IconButton name="back" label="Back" onPress={onBack} />
        <AppText role="support">Opening this recipe version…</AppText>
      </Page>
    );
  return (
    <ContentRecipeReaderView
      lookup={state.lookup}
      scopeKey={state.readingKey}
      readPhoto={store.content.readPhoto}
      onBack={onBack}
      onCleanupFailure={onCleanupFailure}
      {...(onPlan ? { onPlan } : {})}
    />
  );
}
