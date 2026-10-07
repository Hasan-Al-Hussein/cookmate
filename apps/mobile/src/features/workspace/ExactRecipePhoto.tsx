import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canonicalContentJson,
  validateRecipeContentRef,
  type ReadingLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { RecipePhotoFrame } from '../../components/RecipePhoto';
import { ContentRecipePhoto } from '../content/ContentRecipePhoto';
import { useOptionalOrdinaryCatalogue } from '../content/OrdinaryCatalogue';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';

/** A saved meal can read an older exact version without asking the current catalogue to substitute it. */
export function useExactPlanRecipe(contentRef: Readonly<RecipeContentRef> | null) {
  const context = useOptionalOrdinaryCatalogue();
  const snapshot = context?.state;
  const reader = context?.reader;
  const key = useMemo(() => {
    try {
      return contentRef && validateRecipeContentRef(contentRef)
        ? canonicalContentJson(contentRef, 1024)
        : null;
    } catch {
      return null;
    }
  }, [contentRef]);
  const [read, setRead] = useState<{
    key: string;
    snapshot: OrdinaryCatalogueState;
    reader: OrdinaryCatalogueController;
    lookup: ReadingLookup | null;
  } | null>(null);
  const active = useRef(true);
  const latest = useRef({ reader, snapshot, key });
  latest.current = { reader, snapshot, key };
  const current = useCallback(() => {
    if (
      !active.current ||
      !reader ||
      !key ||
      snapshot?.kind !== 'ready' ||
      snapshot.mode !== 'content' ||
      latest.current.reader !== reader ||
      latest.current.snapshot !== snapshot ||
      latest.current.key !== key
    )
      return false;
    try {
      if (reader.getSnapshot() !== snapshot) return false;
      void snapshot.identity;
      return true;
    } catch {
      return false;
    }
  }, [reader, snapshot, key]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    if (!reader || !snapshot || !key || !current()) return;
    const ref: unknown = JSON.parse(key);
    if (!validateRecipeContentRef(ref)) return;
    void reader
      .readExact(ref)
      .then((lookup) => {
        if (live && current()) setRead({ key, snapshot, reader, lookup });
      })
      .catch(() => {
        if (live && current()) setRead({ key, snapshot, reader, lookup: null });
      });
    return () => {
      live = false;
    };
  }, [reader, snapshot, key, current]);
  const readPhoto = useCallback<OrdinaryCatalogueController['readPhoto']>(
    async (ref, assetId, signal) => {
      if (!reader || !current() || canonicalContentJson(ref, 1024) !== key)
        throw new Error('Saved recipe scope changed');
      const value = await reader.readPhoto(ref, assetId, signal);
      if (!current()) throw new Error('Saved recipe scope changed');
      return value;
    },
    [reader, current, key],
  );
  const matching =
    !!read && read.key === key && read.snapshot === snapshot && read.reader === reader && current();
  return {
    loading: !!key && !!reader && current() && !matching,
    lookup: matching ? read.lookup : null,
    scopeKey: snapshot?.scopeKey ?? 'unavailable',
    readPhoto,
    onCleanupFailure: reader?.onPhotoCleanupFailure,
  };
}

export function ExactRecipePhoto({
  contentRef,
  assetId,
  ...frame
}: {
  contentRef: Readonly<RecipeContentRef>;
  assetId?: string | null;
  compact?: boolean;
  borderRadius?: number;
  aspectRatio?: number;
}) {
  const read = useExactPlanRecipe(contentRef);
  if (read.lookup?.kind === 'readable' && read.onCleanupFailure)
    return (
      <ContentRecipePhoto
        recipe={read.lookup.recipe}
        content={{ readPhoto: read.readPhoto }}
        scopeKey={read.scopeKey}
        onCleanupFailure={read.onCleanupFailure}
        {...(assetId === undefined ? {} : { assetId })}
        {...frame}
      />
    );
  return (
    <RecipePhotoFrame
      imageKey="saved-recipe-unavailable"
      source={undefined}
      title="Saved recipe"
      loading={read.loading}
      {...frame}
    />
  );
}
