import { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { canonicalContentJson, type ReadingRecipe } from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import type {
  ContentCookingSessionRequest,
  ContentCookingSessionView,
} from '../../data/contentCookingSessions';
import type { ContentCookingReaderHost } from './contentCookingPorts';
import { useContentCookingReferences } from './useContentCookingReferences';
import {
  contentCookingReferenceRecipe,
  type ContentCookingReference,
} from './contentCookingReferences';
import { sectionForPassage, type ReadingPassage } from './instructionSections';
import { useOptionalContentPrivateState } from '../content/contentPrivateState';
const same = (a: unknown, b: unknown) => canonicalContentJson(a) === canonicalContentJson(b);
export function useContentSessionOperations(
  host: ContentCookingReaderHost,
  isCurrent: () => boolean,
  onConfirmed: () => Promise<void>,
) {
  const privateState = useOptionalContentPrivateState();
  const recovery = useContentCookingReferences(
    host.readInstallationId,
    isCurrent,
    privateState?.references.cooking,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const latest = useRef({ recovery, onConfirmed });
  latest.current = { recovery, onConfirmed };
  async function perform(
    request: Immutable<ContentCookingSessionRequest>,
    retained?: Immutable<ContentCookingReference>,
  ) {
    if (
      !isCurrent() ||
      running.current ||
      !latest.current.recovery.ready ||
      (!retained && latest.current.recovery.records.length) ||
      (retained && !latest.current.recovery.records.some((item) => same(item, retained)))
    )
      return false;
    const ownedRequest: Immutable<ContentCookingSessionRequest> = JSON.parse(
      canonicalContentJson(request, 8192),
    );
    if (retained && (retained.kind !== 'session' || !same(retained.request, ownedRequest)))
      return false;
    const record =
      retained ??
      Object.freeze({
        kind: 'session' as const,
        request: ownedRequest,
        createdAt: new Date().toISOString(),
      });
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!retained && !(await recovery.remember(record))) return false;
      if (!isCurrent()) return false;
      const result =
        ownedRequest.kind === 'save'
          ? await host.sessions.saveSession(ownedRequest.input)
          : await host.sessions.dismissSession(ownedRequest.input);
      if (!isCurrent()) return false;
      if (result.kind === 'ready') {
        if (result.value.operationId !== ownedRequest.input.operationId)
          throw new Error('Receipt mismatch');
        await recovery.release(record);
        if (!isCurrent()) return false;
        await latest.current.onConfirmed();
        return isCurrent();
      }
      // A deliberate retry may meet newer state; keep its original evidence until checked.
      if (result.kind === 'failed' && !retained) {
        await recovery.release(record);
        if (!isCurrent()) return false;
      }
      setError(
        result.kind === 'uncertain' || retained
          ? 'The reading change is unconfirmed. Check it or retry this same request; no new operation has been created.'
          : 'Reading progress changed or could not be saved. Reload its current state before another change.',
      );
      return false;
    } catch {
      if (isCurrent())
        setError(
          'The reading change is unconfirmed. Its original reference is kept; no automatic retry will run.',
        );
      return false;
    } finally {
      running.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  async function check(record: Immutable<ContentCookingReference>) {
    if (
      record.kind !== 'session' ||
      !isCurrent() ||
      running.current ||
      !latest.current.recovery.records.some((item) => same(item, record))
    )
      return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await host.sessions.recover(record.request);
      if (!isCurrent()) return;
      if (
        result.kind === 'ready' &&
        result.value &&
        result.value.operationId === record.request.input.operationId
      ) {
        await recovery.release(record);
        if (!isCurrent()) return;
        await latest.current.onConfirmed();
      } else
        setError(
          'No saved reading receipt could be confirmed. Keep this reference; the request has not been repeated.',
        );
    } catch {
      if (isCurrent())
        setError('The reading receipt could not be checked. Its original reference is retained.');
    } finally {
      running.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  return {
    recovery,
    busy,
    error,
    ready: recovery.ready && !recovery.records.length && !busy,
    perform,
    check,
    retry: (record: Immutable<ContentCookingReference>) =>
      record.kind === 'session' ? perform(record.request, record) : Promise.resolve(false),
  };
}
export function useContentCookingProgress({
  host,
  recipe,
  sections,
  visible,
  isCurrent,
  onPosition,
}: {
  host: ContentCookingReaderHost;
  recipe: Immutable<ReadingRecipe>;
  sections: readonly (readonly ReadingPassage[])[];
  visible: boolean;
  isCurrent(): boolean;
  onPosition(position: number): void;
}) {
  const [view, setView] = useState<Immutable<ContentCookingSessionView> | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null);
  const state = useRef(view);
  state.current = view;
  const generation = useRef(0),
    active = useRef(true),
    position = useRef(onPosition);
  position.current = onPosition;
  const load = useCallback(async () => {
    if (!isCurrent()) return;
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await host.sessions.readSession(recipe.recipeId);
      if (!active.current || !isCurrent() || request !== generation.current) return;
      if (result.kind !== 'ready') throw new Error();
      state.current = result.value;
      setView(result.value);
      const matches =
        result.value.session?.readerVersion === 2 &&
        same(result.value.session.contentRef, recipe.contentRef);
      const next =
        matches && result.value.resume === 'exact'
          ? sectionForPassage(sections, result.value.session!.passageSequence)
          : 0;
      if (next === null)
        setError(
          'The saved passage is not present in this exact recipe version. Reload the saved reading state.',
        );
      position.current(next ?? 0);
    } catch {
      if (active.current && isCurrent() && request === generation.current)
        setError('Saved reading progress could not be checked. The full recipe remains available.');
    } finally {
      if (active.current && isCurrent() && request === generation.current) setLoading(false);
    }
  }, [host, recipe, sections, isCurrent]);
  const operation = useContentSessionOperations(host, isCurrent, load);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);
  useEffect(
    () =>
      host.subscribeCooking((change) => {
        if (
          visible &&
          (change.recipeId === recipe.recipeId || change.recipeId === null) &&
          isCurrent()
        )
          void load();
      }),
    [host, visible, isCurrent, load, recipe.recipeId],
  );
  const session = view?.session;
  const different =
    !!session &&
    session.state === 'active' &&
    (session.readerVersion !== 2 ||
      !same(session.contentRef, recipe.contentRef) ||
      view?.resume !== 'exact');
  const ready = !!view && !loading && !error && !different && operation.ready;
  function save(passageSequence: number, restart = false) {
    const current = state.current;
    if (!isCurrent() || !current || loading || !operation.ready || (!restart && !ready))
      return false;
    const previous = current.session;
    void operation.perform({
      kind: 'save',
      input: {
        operationId: Crypto.randomUUID(),
        sessionId:
          !restart && previous?.readerVersion === 2 && previous.state === 'active'
            ? previous.sessionId
            : Crypto.randomUUID(),
        contentRef: recipe.contentRef,
        expectedRevision: previous?.revision ?? null,
        passageSequence,
      },
    });
    return true;
  }
  function dismiss() {
    const current = state.current?.session;
    if (!isCurrent() || !current || !operation.ready) return;
    void operation.perform({
      kind: 'dismiss',
      input: {
        operationId: Crypto.randomUUID(),
        recipeId: recipe.recipeId,
        sessionId: current.sessionId,
        expectedRevision: current.revision,
      },
    });
  }
  return {
    view,
    loading,
    error,
    operation,
    different,
    ready,
    move: (index: number) => {
      const first = sections[index]?.[0];
      return !!first && save(first.sequence);
    },
    restart: () => {
      const first = sections[0]?.[0];
      if (first) save(first.sequence, true);
    },
    dismiss,
    reload: load,
    hasActiveSession: session?.state === 'active' && !different,
    pendingForRecipe: operation.recovery.records.filter(
      (entry) => contentCookingReferenceRecipe(entry) === recipe.recipeId,
    ),
  };
}
