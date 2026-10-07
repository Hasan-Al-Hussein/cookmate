import type { ContractError } from '@cookmate/contracts';
import type { Immutable, StoredAssistantIntent, StoredConversationMessage } from '@cookmate/domain';

// Presentation only: Data/Core still check the retained turn and current context on every retry.
export function canOfferTurnRetry(error: ContractError): boolean {
  return (
    error.code !== 'cancelled' &&
    (error.retry === 'after_delay' ||
      error.retry === 'after_reconnect' ||
      error.retry === 'reconcile')
  );
}

export function canOfferHistoricalTurnRetry(
  message: Immutable<StoredConversationMessage>,
  record: Immutable<StoredAssistantIntent> | undefined,
): boolean {
  if (
    !record ||
    message.role !== 'user' ||
    record.intent.phase !== 'cancelled' ||
    record.actionPlan ||
    record.intent.slots.length > 0
  )
    return false;
  if (message.status === 'interrupted') return record.response === null;
  return (
    message.status === 'failed' &&
    record.response?.kind === 'error' &&
    canOfferTurnRetry(record.response.error)
  );
}

export function newRequestGuidance(error: ContractError): string | undefined {
  if (error.code === 'cancelled' || error.code === 'provider_refused') return;
  if (error.retry === 'after_correction' || error.retry === 'never')
    return 'Review the guidance above and edit your message before sending a new request.';
}
