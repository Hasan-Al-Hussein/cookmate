import {
  checkLocalCommand,
  commandFingerprintInput,
  CONTRACT_SCHEMA_VERSION,
} from '@cookmate/contracts';
import type {
  CatalogueBoundary,
  CommandPayload,
  ContractError,
  ConversationOrigin,
  LocalCommand,
  RelativeDateGuard,
} from '@cookmate/contracts';
import type { Immutable } from './search';

export interface CommandPlatform {
  newId(): string;
  sha256(text: string): Promise<string>;
}

export interface CommandPreparationContext {
  userIntentId?: string;
  intentRevision?: number;
  origin?: ConversationOrigin;
  relativeDateGuard?: RelativeDateGuard;
}

export class CommandPreparationError extends Error {
  constructor(public readonly detail: ContractError) {
    super(detail.messageKey);
    this.name = 'CommandPreparationError';
  }
}

function freezeJson<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}

/** Call once for a deliberately authorized action, then retain/retry that same frozen command. */
export function createCommandPreparer(platform: CommandPlatform, catalogue: CatalogueBoundary) {
  return async (
    payload: Immutable<CommandPayload>,
    context: CommandPreparationContext = {},
  ): Promise<LocalCommand> => {
    // Copy before any async hashing: caller edits cannot change an in-flight operation.
    const draft = JSON.parse(
      JSON.stringify({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        operationId: platform.newId(),
        userIntentId: context.userIntentId ?? platform.newId(),
        intentRevision: context.intentRevision ?? 0,
        ...(context.origin ? { origin: context.origin } : {}),
        ...(context.relativeDateGuard ? { relativeDateGuard: context.relativeDateGuard } : {}),
        command: payload,
        payloadFingerprint: '0'.repeat(64),
      }),
    ) as LocalCommand;
    const check = checkLocalCommand(draft, catalogue);
    if (!check.ok) throw new CommandPreparationError(check.error);
    freezeJson(draft.command);
    const fingerprint = await platform.sha256(commandFingerprintInput(draft));
    if (!/^[0-9a-f]{64}$/.test(fingerprint))
      throw new CommandPreparationError({
        code: 'invalid_input',
        field: 'payloadFingerprint',
        messageKey: 'command.invalid_fingerprint',
        retry: 'never',
      });
    return freezeJson({ ...draft, payloadFingerprint: fingerprint });
  };
}

/** Equality guard only. Current authority, revisions and receipts are checked by the executor. */
export async function verifyCommandFingerprint(
  command: LocalCommand,
  platform: Pick<CommandPlatform, 'sha256'>,
): Promise<boolean> {
  return (await platform.sha256(commandFingerprintInput(command))) === command.payloadFingerprint;
}
