import { MotionPressable as Pressable } from '../../components/MotionPressable';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { createContext, useContext, useMemo, useRef, useEffect, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import type { Favourite, Immutable } from '@cookmate/domain';
import { ActionButton } from '../../components/Controls';
import { AppIcon } from '../../components/Icon';
import { controlStateProps } from '../../components/controlStateProps';
import { CommittedSelectionAccent } from '../../components/CommittedSelectionAccent';
import type { QueryState } from './WorkspaceProvider';
import { useActionFocus } from '../../hooks/useActionFocus';
import {
  useOrdinaryFavouritesQuery,
  useOrdinaryWorkspaceActions,
} from '../content/useOrdinaryWorkspace';
import type { ContentFavouriteEntry } from '../../data/contentWorkspaceQueries';

type Favourites = readonly Immutable<Favourite>[];
interface FavouritesContext {
  state: QueryState<Favourites>;
  retry(): void;
  contentState?: QueryState<readonly ContentFavouriteEntry[]>;
}
const Context = createContext<FavouritesContext>({
  state: { kind: 'loading' },
  retry() {},
});
export function FavouritesProvider({ children }: { children: ReactNode }) {
  const query = useOrdinaryFavouritesQuery();
  const value = useMemo<FavouritesContext>(() => {
    if (query.mode === 'bundled') return query;
    const contentState = query.state;
    let state: QueryState<Favourites>;
    if (contentState.kind === 'ready')
      state = { ...contentState, value: contentState.value.map((entry) => entry.favourite) };
    else {
      const { previous, ...pending } = contentState;
      state = {
        ...pending,
        ...(previous ? { previous: previous.map((entry) => entry.favourite) } : {}),
      };
    }
    return { state, contentState, retry: query.retry };
  }, [query.mode, query.state, query.retry]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useFavourites = () => useContext(Context);

export function FavouriteButton({
  recipeId,
  title,
  compact = false,
  restoreOnUnsave = false,
  inline = false,
  canSave = true,
}: {
  recipeId: string;
  title: string;
  compact?: boolean;
  restoreOnUnsave?: boolean;
  inline?: boolean;
  canSave?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  const { state } = useFavourites();
  const { actions, scopeKey } = useOrdinaryWorkspaceActions();
  const focus = useActionFocus();
  const entries = state.kind === 'ready' ? state.value : state.previous;
  const saved = entries?.some((entry) => entry.recipeId === recipeId) ?? false;
  const disabled = state.kind !== 'ready' || !actions || actions.blocked || (!saved && !canSave);
  const label = `${saved ? 'Unsave' : 'Save'} ${title}${state.kind !== 'ready' || !actions ? ', saved state unavailable' : ''}`;
  const alive = useRef(true);
  const current = { actions, scopeKey, state, recipeId, saved, disabled };
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const toggle = () => {
    if (!alive.current || latest.current !== current || disabled) return;
    void actions?.begin(
      { kind: 'setFavourite', recipeId, saved: !saved },
      { restoreFocus: focus.restoreFocus, restoreAfterCommitRemoval: restoreOnUnsave && saved },
    );
  };
  if (!compact)
    return (
      <ActionButton
        ref={focus.ref}
        variant="secondary"
        label={saved ? 'Saved · Unsave recipe' : 'Save recipe'}
        accessibilityLabel={label}
        accessibilityState={{ selected: saved }}
        disabled={disabled}
        onPress={toggle}
      />
    );
  return (
    <Pressable
      ref={focus.ref}
      style={[styles.save, !inline && styles.overlay]}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...controlStateProps({ disabled, selected: saved }, 'button')}
      disabled={disabled}
      onPress={toggle}
    >
      <CommittedSelectionAccent
        selected={saved}
        enabled={state.kind === 'ready'}
        hasSnapshot={state.kind !== 'failed' && entries !== undefined}
      >
        <AppIcon
          name="heart"
          selected={saved}
          color={disabled ? t.color.disabledInk : t.color.brandText}
        />
      </CommittedSelectionAccent>
    </Pressable>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    save: {
      width: t.control.minimumTarget,
      height: t.control.minimumTarget,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.surface,
      borderColor: t.color.divider,
      borderWidth: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    overlay: { position: 'absolute', top: t.space.xs, right: t.space.xs },
  });
