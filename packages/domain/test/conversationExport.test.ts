import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { StoredConversationMessage } from '../src/conversationPorts';
import {
  assertConversationExportTextSize,
  CONVERSATION_EXPORT_MAX_BYTES,
  CONVERSATION_EXPORT_MAX_MESSAGES,
  ConversationExportError,
  conversationExportTextByteLength,
  createConversationExportSnapshot,
  formatConversationExportText,
} from '../src/conversationExport';

const timestamp = '2026-10-01T08:00:00.000Z';
const header = {
  conversationId: randomUUID(),
  generation: 3,
  revision: 17,
  composerDraft: 'PRIVATE-UNSENT-DRAFT',
  nextSequence: 2000,
};
const catalogue = { version: 'export-context', fingerprint: 'a'.repeat(64) };
const message = (sequence: number, text = 'Retained text'): StoredConversationMessage => ({
  messageId: randomUUID(),
  conversationId: header.conversationId,
  generation: header.generation,
  sequence,
  role: 'assistant',
  text,
  status: 'complete',
  createdAt: timestamp,
  referenceSets: [],
});
const snapshot = (messages: StoredConversationMessage[]) =>
  createConversationExportSnapshot({ exportedAt: timestamp, catalogue, header, messages });
const failure = (reason: ConversationExportError['reason']) => (error: unknown) =>
  error instanceof ConversationExportError && error.reason === reason;

test('selects only display fields, freezes a detached snapshot and retains reference display order', () => {
  const source = {
    ...message(0, 'مرحبا 👩🏽‍🍳\nA second line\r\nOriginal newline.'),
    prompt: 'INTERNAL-PROMPT',
    actionPlan: { value: 'EXECUTABLE-PROPOSAL' },
    credentials: 'PRIVATE-TOKEN',
  };
  source.referenceSets = [
    { referenceSetId: randomUUID(), messageId: source.messageId, recipeIds: ['52839', '52835'] },
    { referenceSetId: randomUUID(), messageId: source.messageId, recipeIds: ['52819'] },
  ];
  const value = snapshot([source]);
  assert.equal(value.restorable, false);
  assert.equal(value.format, 'cookmate-conversation-transcript');
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(value.exportContext.catalogue, catalogue);
  assert.deepEqual(value.counts, {
    messages: 1,
    userMessages: 0,
    assistantMessages: 1,
    referenceSets: 2,
    recipeReferences: 3,
  });
  assert.deepEqual(value.messages[0]!.referenceSets[0]!.recipeIds, ['52839', '52835']);
  const text = formatConversationExportText(value);
  assert.ok(text.includes(source.text));
  assert.ok(text.indexOf('Recipe ID: 52839') < text.indexOf('Recipe ID: 52835'));
  assert.ok(text.indexOf('Recipe ID: 52835') < text.indexOf('Recipe ID: 52819'));
  assert.match(text, /Non-restorable/);
  assert.match(text, /Historical recipe revisions were not stored/);
  for (const secret of [
    'PRIVATE-UNSENT-DRAFT',
    'INTERNAL-PROMPT',
    'EXECUTABLE-PROPOSAL',
    'PRIVATE-TOKEN',
  ]) {
    assert.ok(!text.includes(secret));
    assert.ok(!JSON.stringify(value).includes(secret));
  }
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.messages[0]!.referenceSets[0]!.recipeIds));
  source.text = 'Changed after snapshot';
  assert.notEqual(source.text, value.messages[0]!.text);
  assert.equal(formatConversationExportText(value), text);
  assert.ok(text.endsWith('\n'));
});

test('empty transcript is explicit and exactly 1000 messages are allowed without truncation', () => {
  assert.equal(snapshot([]).counts.messages, 0);
  const rows = Array.from({ length: CONVERSATION_EXPORT_MAX_MESSAGES }, (_, index) =>
    message(index),
  );
  assert.equal(snapshot(rows).messages.length, CONVERSATION_EXPORT_MAX_MESSAGES);
  assert.throws(
    () => snapshot([...rows, message(CONVERSATION_EXPORT_MAX_MESSAGES)]),
    failure('message_limit'),
  );
});

test('UTF-8 limits include multibyte text and both serialized and readable representations', () => {
  const unicode = 'A\u00e9\u20ac\ud800👩🏽‍🍳';
  assert.equal(conversationExportTextByteLength(unicode), Buffer.byteLength(unicode, 'utf8'));
  assert.doesNotThrow(() =>
    assertConversationExportTextSize('a'.repeat(CONVERSATION_EXPORT_MAX_BYTES)),
  );
  assert.throws(
    () => assertConversationExportTextSize('a'.repeat(CONVERSATION_EXPORT_MAX_BYTES + 1)),
    failure('byte_limit'),
  );
  assert.throws(
    () => snapshot([message(0, '🍲'.repeat(CONVERSATION_EXPORT_MAX_BYTES / 4))]),
    failure('byte_limit'),
  );
  const value = snapshot([message(0)]);
  assert.throws(
    () =>
      formatConversationExportText({
        ...value,
        messages: [{ ...value.messages[0]!, text: 'x'.repeat(CONVERSATION_EXPORT_MAX_BYTES) }],
      }),
    failure('byte_limit'),
  );
});

test('wrong conversation, stale generation, duplicate/out-of-order messages and detached references fail whole export', () => {
  const original = message(1);
  for (const invalid of [
    [{ ...original, conversationId: randomUUID() }],
    [{ ...original, generation: header.generation + 1 }],
    [original, original],
    [message(2), message(1)],
    [{ ...original, sequence: header.nextSequence }],
    [
      {
        ...original,
        referenceSets: [
          {
            referenceSetId: randomUUID(),
            messageId: randomUUID(),
            recipeIds: ['52835'] as [string],
          },
        ],
      },
    ],
  ])
    assert.throws(() => snapshot(invalid), failure('invalid_record'));
});
