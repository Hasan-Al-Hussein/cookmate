import { useEffect, useRef } from 'react';
import type { Immutable, PersonalReceipt } from '@cookmate/domain';

/** Associate a live draft with its actual operation, never with unrelated recovery receipts.
 * Private draft content is not copied into recovery metadata. */
export function usePersonalSubmission(
  receipt: Immutable<PersonalReceipt> | null,
  currentDraft: string,
  onConfirmed: (unchangedDraft: boolean) => void,
  onCancelled: () => void,
) {
  const draft = useRef(currentDraft);
  draft.current = currentDraft;
  const submitted = useRef<{
    operationId: string;
    entityId: string;
    commandKind: NonNullable<PersonalReceipt['commandKind']>;
    draft: string;
  } | null>(null);
  const callbacks = useRef({ onConfirmed, onCancelled });
  callbacks.current = { onConfirmed, onCancelled };
  useEffect(() => {
    const own = submitted.current;
    if (!receipt || !own || receipt.operationId !== own.operationId) return;
    if (receipt.outcome === 'cancelled') {
      submitted.current = null;
      callbacks.current.onCancelled();
    } else if (receipt.entityId === own.entityId && receipt.commandKind === own.commandKind) {
      submitted.current = null;
      callbacks.current.onConfirmed(draft.current === own.draft);
    }
  }, [receipt]);
  return {
    bind: (
      operationId: string,
      entityId: string,
      commandKind: NonNullable<PersonalReceipt['commandKind']>,
    ) => {
      submitted.current = { operationId, entityId, commandKind, draft: draft.current };
    },
  };
}
