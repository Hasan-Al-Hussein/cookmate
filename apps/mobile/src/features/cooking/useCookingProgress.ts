import { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import type {
  CookingService,
  CookingSession,
  CookingSessionView,
  Immutable,
} from '@cookmate/domain';
import { instructionSections, sectionForPassage } from './instructionSections';

type SessionView = Immutable<CookingSessionView>;
const saveError =
  'Reading progress could not be saved. Your recipe and shopping list are unchanged. Reload the saved position before continuing.';

export function useCookingProgress({
  service,
  recipeId,
  sections,
  visible,
  onPosition,
}: {
  service: CookingService | undefined;
  recipeId: string;
  sections: ReturnType<typeof instructionSections>;
  visible: boolean;
  onPosition: (position: number) => void;
}) {
  const [view, setView] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const currentView = useRef<SessionView | null>(null);
  const mounted = useRef(true);
  const loadGeneration = useRef(0);
  const pendingPosition = useRef<number | null>(null);
  const pump = useRef<Promise<void> | null>(null);
  const activeWrite = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current++;
    };
  }, []);
  const publish = (next: SessionView) => {
    currentView.current = next;
    if (mounted.current) setView(next);
  };
  const load = useCallback(
    async (proofId?: string) => {
      if (!service || (activeWrite.current && !pump.current)) return;
      const generation = ++loadGeneration.current;
      setLoading(true);
      setError(null);
      try {
        await pump.current;
        const result = await service.readSession(recipeId);
        if (!mounted.current || generation !== loadGeneration.current) return;
        if (result.kind === 'failed') {
          setError(
            'Saved reading progress is unavailable. You can still read the original full instructions.',
          );
          return;
        }
        publish(result.value);
        const position =
          result.value.resume === 'matching' && result.value.session
            ? sectionForPassage(sections, result.value.session.passageSequence)
            : 0;
        setChanged(result.value.resume === 'content_changed' || position === null);
        onPosition(position ?? 0);
        setUncertain(null);
        if (proofId && result.value.session?.lastOperationId !== proofId)
          setError(
            'The current saved position is loaded, but the earlier save could not be verified. It has not been repeated.',
          );
      } catch {
        if (mounted.current && generation === loadGeneration.current)
          setError('Saved reading progress could not be read. Try loading it again.');
      } finally {
        if (mounted.current && generation === loadGeneration.current) setLoading(false);
      }
    },
    [service, recipeId, sections, onPosition],
  );
  useEffect(() => {
    if (visible && service) void load();
  }, [visible, service, load]);

  function acceptSession(session: Immutable<CookingSession>, position?: number) {
    const previous = currentView.current;
    if (previous)
      publish({ ...previous, session, resume: session.state === 'active' ? 'matching' : 'none' });
    if (mounted.current) {
      setChanged(false);
      setError(null);
      setUncertain(null);
      if (position !== undefined) onPosition(position);
    }
  }
  function move(position: number) {
    if (
      !service ||
      !currentView.current ||
      loading ||
      changed ||
      uncertain ||
      error ||
      (activeWrite.current && !pump.current)
    )
      return false;
    pendingPosition.current = position;
    if (pump.current) return true;
    activeWrite.current = true;
    setSaving(true);
    pump.current = (async () => {
      while (pendingPosition.current !== null) {
        const requested = pendingPosition.current;
        pendingPosition.current = null;
        const snapshot = currentView.current;
        const passageSequence = sections[requested]?.[0]?.sequence;
        if (!snapshot || passageSequence === undefined) continue;
        if (
          snapshot.session?.state === 'active' &&
          snapshot.session.passageSequence === passageSequence
        )
          continue;
        const operationId = Crypto.randomUUID();
        try {
          const result = await service.saveSession({
            operationId,
            recipeId,
            sessionId:
              snapshot.session?.state === 'active'
                ? snapshot.session.sessionId
                : Crypto.randomUUID(),
            expectedRevision: snapshot.session?.revision ?? null,
            contentFingerprint: snapshot.currentContent.contentFingerprint,
            readerVersion: 1,
            passageSequence,
          });
          if (result.kind === 'ready') acceptSession(result.value);
          else {
            pendingPosition.current = null;
            if (mounted.current) {
              setError(saveError);
              if (result.kind === 'uncertain') setUncertain(operationId);
            }
            break;
          }
        } catch {
          pendingPosition.current = null;
          if (mounted.current) {
            setError(
              'The reading-position save is unconfirmed. Check its saved state before another change.',
            );
            setUncertain(operationId);
          }
          break;
        }
      }
    })().finally(() => {
      pump.current = null;
      activeWrite.current = false;
      if (mounted.current) setSaving(false);
    });
    return true;
  }
  async function resolveChanged(action: 'restart' | 'dismiss') {
    const snapshot = currentView.current;
    if (!service || !snapshot || activeWrite.current || loading) return;
    const firstSequence = sections[0]?.[0]?.sequence;
    if (action === 'restart' && firstSequence === undefined) return;
    if (action === 'dismiss' && !snapshot.session) return;
    activeWrite.current = true;
    setSaving(true);
    setError(null);
    const operationId = Crypto.randomUUID();
    try {
      const result =
        action === 'restart'
          ? await service.saveSession({
              operationId,
              recipeId,
              sessionId: Crypto.randomUUID(),
              expectedRevision: snapshot.session?.revision ?? null,
              contentFingerprint: snapshot.currentContent.contentFingerprint,
              readerVersion: 1,
              passageSequence: firstSequence!,
            })
          : await service.dismissSession({
              operationId,
              recipeId,
              sessionId: snapshot.session!.sessionId,
              expectedRevision: snapshot.session!.revision,
            });
      if (result.kind === 'ready') acceptSession(result.value, 0);
      else if (mounted.current) {
        setError(saveError);
        if (result.kind === 'uncertain') setUncertain(operationId);
      }
    } catch {
      if (mounted.current) {
        setError(
          'This progress change is unconfirmed. Check its saved state; it will not be repeated automatically.',
        );
        setUncertain(operationId);
      }
    } finally {
      activeWrite.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return {
    view,
    loading,
    saving,
    error,
    uncertain,
    changed,
    ready: !!view && !loading && !changed && !error && !uncertain && (!saving || !!pump.current),
    move,
    reload: () => load(uncertain ?? undefined),
    restart: () => resolveChanged('restart'),
    dismiss: () => resolveChanged('dismiss'),
    acceptCompleted: (_session: Immutable<CookingSession> | null) => {
      // A recovered receipt can predate a newer reading session. Read current state,
      // rather than treating the receipt's historical closed session as current.
      void load();
    },
  };
}
