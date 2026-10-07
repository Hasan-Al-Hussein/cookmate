import { isActualLocalDate } from '@cookmate/contracts';
import type { DateContext } from '@cookmate/contracts';
import type { IntentGuardSnapshot } from '@cookmate/domain';
import { isAppId, isRevision, requireConversationRecord } from './conversationRecords';
export function utf8Length(text: string): number {
  let length = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    length += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return length;
}

export function parseBoundedJson(json: string, maxBytes = 131072): unknown {
  requireConversationRecord(
    typeof json === 'string' && json.length <= maxBytes && utf8Length(json) <= maxBytes,
  );
  return JSON.parse(json) as unknown;
}

export function equivalentJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object')
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(',')}}`;
    return JSON.stringify(value);
  };
  return canonical(left) === canonical(right);
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isDateContext(value: unknown): value is DateContext {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    typeof value.localDate === 'string' &&
    isActualLocalDate(value.localDate) &&
    typeof value.timeZone === 'string' &&
    value.timeZone.length >= 1 &&
    [...value.timeZone].length <= 100 &&
    typeof value.utcOffsetMinutes === 'number' &&
    Number.isInteger(value.utcOffsetMinutes) &&
    Math.abs(value.utcOffsetMinutes) <= 840
  );
}

export function isIntentGuard(value: unknown): value is IntentGuardSnapshot {
  return (
    record(value) &&
    Object.keys(value).every((key) =>
      [
        'conversationId',
        'conversationGeneration',
        'contextRevision',
        'connectionGeneration',
        'preferenceRevision',
        'planRevision',
        'shoppingScopeRevision',
        'relativeDateContext',
      ].includes(key),
    ) &&
    isAppId(value.conversationId) &&
    isRevision(value.conversationGeneration) &&
    isRevision(value.contextRevision) &&
    isRevision(value.connectionGeneration) &&
    isRevision(value.preferenceRevision) &&
    (value.planRevision === undefined || isRevision(value.planRevision)) &&
    (value.shoppingScopeRevision === undefined || isRevision(value.shoppingScopeRevision)) &&
    isDateContext(value.relativeDateContext)
  );
}
