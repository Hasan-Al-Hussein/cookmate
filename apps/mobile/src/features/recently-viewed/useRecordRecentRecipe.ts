import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  canonicalContentJson,
  validateRecipeContentRef,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { useRecentlyViewed } from './RecentlyViewedProvider';

/** One successful body opening per real focus visit, never a card read or hydration refocus. */
export function useRecordRecentRecipe({
  visitKey,
  contentRef,
  isCurrent,
}: {
  visitKey: string;
  contentRef: Readonly<RecipeContentRef> | null;
  isCurrent(): boolean;
}) {
  const { enabled, hydrated, recordOpen } = useRecentlyViewed();
  let refKey: string | null = null;
  try {
    if (contentRef && validateRecipeContentRef(contentRef))
      refKey = canonicalContentJson(contentRef, 1024);
  } catch {
    /* No exact reference, no record. */
  }
  const latest = useRef({ visitKey, refKey, recordOpen, isCurrent });
  latest.current = { visitKey, refKey, recordOpen, isCurrent };
  const active = useRef<{ attempted: boolean } | null>(null);
  const [visit, setVisit] = useState<{ attempted: boolean } | null>(null);
  useFocusEffect(
    useCallback(() => {
      const opened = { attempted: false };
      active.current = opened;
      setVisit(opened);
      return () => {
        if (active.current === opened) active.current = null;
      };
    }, [visitKey, recordOpen]),
  );
  useEffect(() => {
    if (!visit || active.current !== visit || visit.attempted || !hydrated) return;
    // Enabling collection elsewhere does not retroactively record an already-open disabled visit.
    if (!enabled) {
      visit.attempted = true;
      return;
    }
    if (!refKey) return;
    const current = () => {
      try {
        return (
          active.current === visit &&
          latest.current.visitKey === visitKey &&
          latest.current.refKey === refKey &&
          latest.current.recordOpen === recordOpen &&
          latest.current.isCurrent()
        );
      } catch {
        return false;
      }
    };
    if (!current()) return;
    const owned: unknown = JSON.parse(refKey);
    if (!validateRecipeContentRef(owned)) return;
    visit.attempted = true;
    void recordOpen(owned, current).catch(() => {
      /* The controller exposes storage failure; never replay automatically. */
    });
  }, [enabled, hydrated, recordOpen, refKey, visit, visitKey, isCurrent]);
}
