import type {
  LocalCommand,
  MultiActionResult,
  OperationReceipt,
  PendingIntent,
} from './generated/types.js';
import { validateLocalCommand, validateMultiActionResult } from './generated/validators.js';

type IntentPhase = PendingIntent['phase'];
const transitions: Record<IntentPhase, readonly IntentPhase[]> = {
  draft: ['awaiting_response', 'ready', 'cancelled'],
  awaiting_response: ['clarification', 'confirmation', 'ready', 'settled', 'cancelled'],
  clarification: ['awaiting_response', 'confirmation', 'ready', 'cancelled'],
  confirmation: ['awaiting_response', 'clarification', 'ready', 'cancelled'],
  ready: ['dispatched', 'cancelled'],
  dispatched: ['reconciling', 'settled'],
  reconciling: ['settled'],
  settled: [],
  cancelled: [],
};

export function canTransitionIntent(from: IntentPhase, to: IntentPhase): boolean {
  return transitions[from].includes(to);
}

// Cancellation cannot undo a dispatched mutation or erase its receipt.
export function phaseAfterCancel(phase: IntentPhase): IntentPhase {
  if (phase === 'settled' || phase === 'cancelled') return phase;
  return phase === 'dispatched' || phase === 'reconciling' ? 'reconciling' : 'cancelled';
}

/** Startup only: the caller must first validate an accepted frozen action plan. */
export function phaseAfterStartupSuspension(phase: IntentPhase): 'reconciling' | null {
  return phase === 'ready' || phase === 'dispatched' || phase === 'reconciling'
    ? 'reconciling'
    : null;
}

export function matchOperationReceipt(
  command: LocalCommand,
  receipt: OperationReceipt | undefined,
): 'missing' | 'existing' | 'conflict' {
  if (!receipt) return 'missing';
  if (
    receipt.operationId !== command.operationId ||
    receipt.payloadFingerprint !== command.payloadFingerprint ||
    receipt.userIntentId !== command.userIntentId
  )
    return 'conflict';
  return 'existing';
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

// Hash this with SHA-256 in the native/gateway adapter. The hash is an equality
// guard, not authorization or a signature. Recompute before receipt lookup.
export function commandFingerprintInput(command: Omit<LocalCommand, 'payloadFingerprint'>): string {
  const {
    schemaVersion,
    operationId,
    userIntentId,
    intentRevision,
    origin,
    relativeDateGuard,
    command: payload,
  } = command;
  return stableJson({
    schemaVersion,
    operationId,
    userIntentId,
    intentRevision,
    origin,
    relativeDateGuard,
    command: payload,
  });
}

export type FrozenActionBatch = Pick<PendingIntent, 'userIntentId' | 'slots'>;

export function actionResultsMatchFrozenSlots(
  result: unknown,
  frozen: FrozenActionBatch,
): result is MultiActionResult {
  if (
    !validateMultiActionResult(result) ||
    result.userIntentId !== frozen.userIntentId ||
    result.slots.length !== frozen.slots.length
  )
    return false;
  const commands = new Map<string, LocalCommand>();
  const operations = new Set<string>();
  for (const slot of frozen.slots) {
    if (
      !validateLocalCommand(slot.command) ||
      slot.command.userIntentId !== frozen.userIntentId ||
      commands.has(slot.slotId) ||
      operations.has(slot.command.operationId)
    )
      return false;
    commands.set(slot.slotId, slot.command);
    operations.add(slot.command.operationId);
  }
  const seen = new Set<string>();
  for (const slot of result.slots) {
    const command = commands.get(slot.slotId);
    if (!command || seen.has(slot.slotId)) return false;
    seen.add(slot.slotId);
    if (slot.result.kind === 'receipt') {
      if (matchOperationReceipt(command, slot.result.receipt) !== 'existing') return false;
    } else if (slot.result.operationId !== command.operationId) return false;
    if (
      slot.result.kind === 'failed' &&
      slot.result.error.operationId !== undefined &&
      slot.result.error.operationId !== command.operationId
    )
      return false;
  }
  return true;
}

export function summarizeActionResults(
  result: unknown,
  frozen: FrozenActionBatch,
): 'complete' | 'partial' | 'failed' | 'uncertain' | 'invalid' {
  if (!actionResultsMatchFrozenSlots(result, frozen)) return 'invalid';
  if (result.slots.some((slot) => slot.result.kind === 'uncertain')) return 'uncertain';
  const completed = result.slots.filter((slot) => slot.result.kind === 'receipt').length;
  if (completed === result.slots.length && completed > 0) return 'complete';
  return completed > 0 ? 'partial' : 'failed';
}
