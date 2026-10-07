import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { View } from 'react-native';
import {
  canonicalContentJson,
  validateRecipeContentRef,
  type ReadingLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable, PersonalReceipt } from '@cookmate/domain';
import { Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import type { ContentWorkspaceHost } from '../content/contentWorkspaceHost';
import { useOptionalOrdinaryCatalogue } from '../content/OrdinaryCatalogue';
import { ExactRecipePhoto } from '../workspace/ExactRecipePhoto';
import { PersonalOperationFeedback, usePersonalStyles } from './PersonalUI';
import { RecipeNoteEditor } from './RecipeNoteEditor';
import { usePersonalQuery } from './usePersonalQuery';
import { usePersonalOperations } from './usePersonalOperations';
import { contentNoteReferenceStore } from './contentNoteReferenceStorage';
import { useOptionalContentPrivateState } from '../content/contentPrivateState';
export type ContentNoteHost = Pick<
  ContentWorkspaceHost,
  'notes' | 'readInstallationId' | 'getSnapshot' | 'subscribe'
>;
export type NoteTarget = {
  readonly recipeId: string;
  readonly contentRef?: Readonly<RecipeContentRef>;
};
/** Malformed exact routes never become current-recipe requests. */
export function parseRecipeNoteTarget(recipeId: unknown, serialized: unknown): NoteTarget | null {
  if (typeof recipeId !== 'string' || !/^[0-9]{1,20}$/.test(recipeId)) return null;
  if (serialized === undefined) return Object.freeze({ recipeId });
  if (typeof serialized !== 'string' || serialized.length > 1024) return null;
  try {
    const ref: unknown = JSON.parse(serialized);
    canonicalContentJson(ref, 1024);
    return validateRecipeContentRef(ref) && ref.recipeId === recipeId
      ? Object.freeze({ recipeId, contentRef: Object.freeze(ref) })
      : null;
  } catch {
    return null;
  }
}
const acceptsNoteReceipt = (receipt: Immutable<PersonalReceipt>) =>
  receipt.commandKind === 'saveNote' ||
  receipt.commandKind === 'deleteNote' ||
  (receipt.commandKind === null && receipt.outcome === 'cancelled');
/** Note-only borrowed service; no collection or manual-item capability is exposed. */
export function ContentRecipeNote({
  host,
  target,
  membershipControl,
}: {
  host: ContentNoteHost;
  target: NoteTarget;
  membershipControl?: ReactNode;
}) {
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const owner = useRef({ host, generation: 0 });
  if (owner.current.host !== host)
    owner.current = { host, generation: owner.current.generation + 1 };
  return state.status === 'ready' ? (
    <ReadyNote
      key={canonicalContentJson([owner.current.generation, state.scopeKey, target], 2048)}
      host={host}
      scopeKey={state.scopeKey}
      target={target}
      membershipControl={membershipControl}
    />
  ) : (
    <Notice title="Private note is unavailable here">
      Return after this workspace’s update or recovery finishes to check your note and any pending
      change.
    </Notice>
  );
}
function ReadyNote({
  host,
  scopeKey,
  target,
  membershipControl,
}: {
  host: ContentNoteHost;
  scopeKey: string;
  target: NoteTarget;
  membershipControl?: ReactNode;
}) {
  const styles = usePersonalStyles();
  const [editing, setEditing] = useState(false);
  const mounted = useRef(true);
  const latest = useRef({ host, scopeKey, target });
  latest.current = { host, scopeKey, target };
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
      latest.current.host === host &&
      latest.current.scopeKey === scopeKey &&
      latest.current.target === target &&
      state.status === 'ready' &&
      state.scopeKey === scopeKey
    );
  }, [host, scopeKey, target]);
  const read = useCallback(
    () => host.notes.readRecipeNote(target.recipeId),
    [host, target.recipeId],
  );
  const query = usePersonalQuery(host.notes, read, 'notes', undefined, isCurrent);
  const privateState = useOptionalContentPrivateState();
  const operation = usePersonalOperations(host.notes, host.readInstallationId, {
    isCurrent,
    referenceStore: privateState?.references.notes ?? contentNoteReferenceStore,
    acceptsReceipt: acceptsNoteReceipt,
  });
  const catalogue = useOptionalOrdinaryCatalogue();
  const reader = catalogue?.reader,
    snapshot = catalogue?.state;
  const ownership = useMemo(() => ({ reader, snapshot, target }), [reader, snapshot, target]);
  const currentOwnership = useRef(ownership);
  currentOwnership.current = ownership;
  const [loaded, setLoaded] = useState<{
    ownership: typeof ownership;
    lookup: ReadingLookup;
  } | null>(null);
  const lookup = loaded?.ownership === ownership && isCurrent() ? loaded.lookup : null;
  useEffect(() => {
    let active = true;
    if (!reader || snapshot?.kind !== 'ready' || snapshot.mode !== 'content' || !isCurrent())
      return;
    const owns = () =>
      active &&
      isCurrent() &&
      currentOwnership.current === ownership &&
      reader.getSnapshot() === snapshot;
    void (
      target.contentRef ? reader.readExact(target.contentRef) : reader.readCurrent(target.recipeId)
    )
      .then((value) => {
        if (!owns()) return;
        if (
          value.kind === 'readable' &&
          (value.recipe.recipeId !== target.recipeId ||
            (target.contentRef &&
              canonicalContentJson(value.recipe.contentRef, 1024) !==
                canonicalContentJson(target.contentRef, 1024)))
        )
          return;
        setLoaded({ ownership, lookup: value });
      })
      .catch(() => {
        if (owns()) setLoaded(null);
      });
    return () => {
      active = false;
    };
  }, [reader, snapshot, target, ownership, isCurrent]);
  const recipe = lookup?.kind === 'readable' ? lookup.recipe : null;
  return (
    <View style={styles.section}>
      {recipe ? (
        <View style={styles.row}>
          <View style={styles.photo}>
            <ExactRecipePhoto contentRef={recipe.contentRef} compact aspectRatio={1} />
          </View>
          <AppText role="section" style={styles.text}>
            {recipe.title}
          </AppText>
        </View>
      ) : (
        <Notice title="Recipe version unavailable">
          Your saved private note is kept separately from recipe content.
        </Notice>
      )}
      <AppText role="support" color="inkSecondary">
        This private note follows the recipe across versions. Original instructions stay unchanged.
      </AppText>
      <PersonalOperationFeedback operation={operation} />
      <RecipeNoteEditor
        recipeId={target.recipeId}
        query={query}
        operation={operation}
        execute={host.notes.execute}
        canAddNote={!!recipe}
        isCurrent={isCurrent}
        onEditingChange={setEditing}
      />
      {!editing && membershipControl}
    </View>
  );
}
