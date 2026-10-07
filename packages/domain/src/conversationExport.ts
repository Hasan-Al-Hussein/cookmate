import type { CatalogueIdentity } from '@cookmate/contracts';
import type { ConversationHeader, StoredConversationMessage } from './conversationPorts';
import type { Immutable } from './search';

export const CONVERSATION_EXPORT_FORMAT = 'cookmate-conversation-transcript';
export const CONVERSATION_EXPORT_VERSION = 1;
export const CONVERSATION_EXPORT_MAX_MESSAGES = 1000;
export const CONVERSATION_EXPORT_MAX_BYTES = 2 * 1024 * 1024;
export const conversationExportPrivacy = Object.freeze({
  plaintext: true,
  includes: 'Persisted user and assistant messages, timestamps, statuses and stored recipe IDs.',
  sensitiveText: 'Messages may contain personal information you typed or received.',
  referenceEvidence:
    'Recipe IDs are exactly as stored, in display order. Historical recipe revisions were not stored; the export context catalogue is not a historical attribution.',
  excluded: Object.freeze([
    'Unsent composer draft',
    'Internal prompts and request context',
    'Credentials, provider keys and pairing secrets',
    'AI sharing consent',
    'Executable proposals, action payloads and operation receipts',
    'Unrelated cooking data and settings',
  ]),
});

export interface ConversationExportMessage {
  messageId: string;
  sequence: number;
  role: StoredConversationMessage['role'];
  text: string;
  status: StoredConversationMessage['status'];
  createdAt: string;
  referenceSets: { referenceSetId: string; recipeIds: string[] }[];
}
export interface ConversationExportSnapshot {
  format: typeof CONVERSATION_EXPORT_FORMAT;
  schemaVersion: typeof CONVERSATION_EXPORT_VERSION;
  restorable: false;
  exportedAt: string;
  conversation: Pick<ConversationHeader, 'conversationId' | 'generation' | 'revision'>;
  /** Identity at export time only, never an attribution of historical message content. */
  exportContext: { catalogue: CatalogueIdentity };
  messages: ConversationExportMessage[];
  counts: {
    messages: number;
    userMessages: number;
    assistantMessages: number;
    referenceSets: number;
    recipeReferences: number;
  };
  privacy: typeof conversationExportPrivacy;
}
export type ConversationExportFailure = 'message_limit' | 'byte_limit' | 'invalid_record';
export class ConversationExportError extends Error {
  constructor(readonly reason: ConversationExportFailure) {
    super(`Conversation export: ${reason}`);
    this.name = 'ConversationExportError';
  }
}

/** Each representation has its own UTF-8 limit; neither can silently truncate. */
export function assertConversationExportTextSize(text: string): void {
  if (conversationExportTextByteLength(text) > CONVERSATION_EXPORT_MAX_BYTES)
    throw new ConversationExportError('byte_limit');
}

/** Works on native runtimes without Buffer or TextEncoder, including lone-surrogate replacement. */
export function conversationExportTextByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function freeze<Value>(value: Value): Immutable<Value> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Immutable<Value>;
}

/** Input rows have passed the persisted conversation reader's evidence checks. */
export function createConversationExportSnapshot(input: {
  exportedAt: string;
  catalogue: Readonly<CatalogueIdentity>;
  header: Immutable<ConversationHeader>;
  messages: readonly Immutable<StoredConversationMessage>[];
}): Immutable<ConversationExportSnapshot> {
  if (input.messages.length > CONVERSATION_EXPORT_MAX_MESSAGES)
    throw new ConversationExportError('message_limit');
  const messageIds = new Set<string>();
  let previousSequence = -1;
  const messages = input.messages.map((message): ConversationExportMessage => {
    if (
      message.conversationId !== input.header.conversationId ||
      message.generation !== input.header.generation ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence <= previousSequence ||
      message.sequence >= input.header.nextSequence ||
      messageIds.has(message.messageId) ||
      message.referenceSets.some((set) => set.messageId !== message.messageId)
    )
      throw new ConversationExportError('invalid_record');
    previousSequence = message.sequence;
    messageIds.add(message.messageId);
    // Select display fields, never spread a message/header or serialize a request/intent.
    return {
      messageId: message.messageId,
      sequence: message.sequence,
      role: message.role,
      text: message.text,
      status: message.status,
      createdAt: message.createdAt,
      referenceSets: message.referenceSets.map((set) => ({
        referenceSetId: set.referenceSetId,
        recipeIds: [...set.recipeIds],
      })),
    };
  });
  const snapshot: ConversationExportSnapshot = {
    format: CONVERSATION_EXPORT_FORMAT,
    schemaVersion: CONVERSATION_EXPORT_VERSION,
    restorable: false,
    exportedAt: input.exportedAt,
    conversation: {
      conversationId: input.header.conversationId,
      generation: input.header.generation,
      revision: input.header.revision,
    },
    exportContext: {
      catalogue: { version: input.catalogue.version, fingerprint: input.catalogue.fingerprint },
    },
    messages,
    counts: {
      messages: messages.length,
      userMessages: messages.filter((message) => message.role === 'user').length,
      assistantMessages: messages.filter((message) => message.role === 'assistant').length,
      referenceSets: messages.reduce((count, message) => count + message.referenceSets.length, 0),
      recipeReferences: messages.reduce(
        (count, message) =>
          count + message.referenceSets.reduce((sum, set) => sum + set.recipeIds.length, 0),
        0,
      ),
    },
    privacy: conversationExportPrivacy,
  };
  assertConversationExportTextSize(JSON.stringify(snapshot));
  formatConversationExportText(snapshot);
  return freeze(snapshot);
}

/** Readable UTF-8 text with LF framing; message text is retained exactly, including its newlines. */
export function formatConversationExportText(
  snapshot: Immutable<ConversationExportSnapshot>,
): string {
  if (snapshot.messages.length > CONVERSATION_EXPORT_MAX_MESSAGES)
    throw new ConversationExportError('message_limit');
  const lines = [
    'CookMate conversation transcript',
    `Format: ${CONVERSATION_EXPORT_FORMAT}; version ${CONVERSATION_EXPORT_VERSION}`,
    'Non-restorable record for reading only. It cannot resume chat or execute actions.',
    `Exported at: ${snapshot.exportedAt}`,
    `Conversation: ${snapshot.conversation.conversationId}; generation ${snapshot.conversation.generation}; revision ${snapshot.conversation.revision}`,
    `Export-context catalogue: ${snapshot.exportContext.catalogue.version} (${snapshot.exportContext.catalogue.fingerprint})`,
    conversationExportPrivacy.referenceEvidence,
    `Messages: ${snapshot.counts.messages}; user: ${snapshot.counts.userMessages}; assistant: ${snapshot.counts.assistantMessages}; recipe references: ${snapshot.counts.recipeReferences}`,
    '',
    'Privacy: This is a plaintext file.',
    conversationExportPrivacy.sensitiveText,
    `Excluded: ${conversationExportPrivacy.excluded.join('; ')}.`,
  ];
  for (const message of snapshot.messages) {
    lines.push(
      '',
      '---',
      `${message.role === 'user' ? 'User' : 'Assistant'} | ${message.createdAt} | ${message.status}`,
      `Message: ${message.messageId}; sequence ${message.sequence}`,
      '',
      message.text,
    );
    message.referenceSets.forEach((set, setIndex) => {
      lines.push('', `Recipe references ${setIndex + 1} (stored set ${set.referenceSetId}):`);
      set.recipeIds.forEach((recipeId, index) =>
        lines.push(`${index + 1}. Recipe ID: ${recipeId}`),
      );
    });
  }
  const text = `${lines.join('\n')}\n`;
  assertConversationExportTextSize(text);
  return text;
}
