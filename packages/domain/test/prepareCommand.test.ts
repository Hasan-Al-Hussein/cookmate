import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogueBoundary } from '@cookmate/catalogue';
import { createCommandPreparer, verifyCommandFingerprint } from '../src/index';
import type { CommandPayload } from '@cookmate/contracts';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};

test('app-owned identities distinguish deliberate new intents while one frozen command can be retried', async () => {
  const prepare = createCommandPreparer(platform, catalogueBoundary);
  const first = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  const next = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
  assert.notEqual(first.operationId, next.operationId);
  assert.notEqual(first.userIntentId, next.userIntentId);
  assert.ok(await verifyCommandFingerprint(first, platform));
  assert.equal(first.origin, undefined);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.command));
});

test('caller mutation during asynchronous hashing cannot change the frozen action', async () => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepare = createCommandPreparer(
    {
      ...platform,
      sha256: async (text) => {
        await wait;
        return platform.sha256(text);
      },
    },
    catalogueBoundary,
  );
  const payload: CommandPayload = { kind: 'setFavourite', recipeId: '53064', saved: true };
  const pending = prepare(payload);
  payload.recipeId = '52835';
  payload.saved = false;
  release!();
  const command = await pending;
  assert.deepEqual(command.command, { kind: 'setFavourite', recipeId: '53064', saved: true });
  assert.ok(await verifyCommandFingerprint(command, platform));
  assert.equal(await verifyCommandFingerprint({ ...command, command: payload }, platform), false);
});

test('invalid source identity, impossible dates and bad platform hashes fail before dispatch', async () => {
  const prepare = createCommandPreparer(platform, catalogueBoundary);
  await assert.rejects(
    prepare({ kind: 'setFavourite', recipeId: '99999', saved: true }),
    /unknown_recipe/,
  );
  await assert.rejects(
    prepare({
      kind: 'addPlan',
      occurrenceId: randomUUID(),
      recipeId: '53064',
      placement: { actualDate: '2026-02-30', mealKey: 'dinner' },
      expectedTarget: { kind: 'empty' },
    }),
    /invalid_input/,
  );
  await assert.rejects(
    createCommandPreparer(
      { ...platform, sha256: async () => 'bad' },
      catalogueBoundary,
    )({ kind: 'setFavourite', recipeId: '53064', saved: true }),
    /invalid_fingerprint/,
  );
});

test('explicit conversation origin and relative date guard are included in the fingerprint', async () => {
  const prepare = createCommandPreparer(platform, catalogueBoundary);
  const command = await prepare(
    {
      kind: 'addPlan',
      occurrenceId: randomUUID(),
      recipeId: '53064',
      placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
      expectedTarget: { kind: 'empty' },
    },
    {
      userIntentId: randomUUID(),
      intentRevision: 3,
      origin: { conversationId: randomUUID(), generation: 2, messageId: randomUUID() },
      relativeDateGuard: {
        interpretedAt: { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 },
        resolvedDate: '2026-09-29',
        sourceMessageId: randomUUID(),
      },
    },
  );
  assert.ok(await verifyCommandFingerprint(command, platform));
  assert.equal(
    await verifyCommandFingerprint(
      {
        ...command,
        relativeDateGuard: { ...command.relativeDateGuard!, resolvedDate: '2026-09-30' },
      },
      platform,
    ),
    false,
  );
});
