import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalStore } from '../../data/localStore';
import type { GatewayConnection } from '../../connection';
import { recoveryFixture, ready } from '../../../../../packages/domain/test/helpers/recoveryGate';
import { desktopConnection } from '../../../../../packages/domain/test/helpers/sqlite';
import { AssistantRuntime, type AssistantCoordinator } from './assistantRuntime';

async function fixture(initialTurns = 0) {
  const owner = await recoveryFixture();
  async function append(count: number, unresolvedFirst = false) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const unresolved = unresolvedFirst && i === 0;
      const turn = await owner.addTurn({ plan: unresolved, execute: false });
      ids.push(turn.request.userIntentId);
      if (!unresolved)
        ready(
          await owner.actions.cancelIntent({
            userIntentId: turn.request.userIntentId,
            expectedIntentRevision: 0,
          }),
        );
    }
    return ids;
  }
  await append(initialTurns);
  const result = await createLocalStore({
    openConnection: async () => desktopConnection(owner.path).connection,
    platform: owner.platform,
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => ({ localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
  });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') assert.fail();
  const services = result.services;
  const persistence = { ...services.assistant({ connectionGeneration: () => 1 }) };
  const connection = {
    getState: () => ({ status: 'unpaired', generation: 1 }),
    restore: async () => undefined,
  } as unknown as GatewayConnection;
  const runtime = new AssistantRuntime(
    persistence,
    { invalidate() {} } as AssistantCoordinator,
    connection,
    services,
  );
  runtime.start();
  await runtime.reload();
  await runtime.recovery.check();
  return {
    owner,
    services,
    persistence,
    runtime,
    append,
    async close() {
      await runtime.dispose();
      await services.close();
      await owner.close();
    },
  };
}

async function loadAll(runtime: AssistantRuntime, maximum = 10) {
  for (let i = 0; runtime.state.conversation?.hasEarlier; i++) {
    assert.ok(i < maximum, 'paging must reach retained history in bounded pages');
    assert.notEqual(runtime.state.conversation.beforeSequence, null);
    await runtime.reload(true);
    assert.equal(runtime.state.readError, undefined);
  }
}

test('actual empty view can page to externally retained oldest unresolved history after same-generation refresh', async () => {
  const f = await fixture();
  try {
    assert.equal(f.runtime.state.conversation!.hasEarlier, false);
    const ids = await f.append(32, true);
    await f.runtime.reload();
    assert.equal(ready(await f.persistence.readConversation()).hasEarlier, true);
    assert.equal(f.runtime.state.conversation!.hasEarlier, true);
    assert.notEqual(f.runtime.state.conversation!.beforeSequence, null);
    await f.runtime.recovery.check();
    assert.equal(f.runtime.mutationsHeld, true);
    assert.equal(f.runtime.recovery.admitsNewMutation, false);
    await loadAll(f.runtime);
    assert.equal(Object.keys(f.runtime.state.conversation!.intents).length, 32);
    assert.equal(f.runtime.state.conversation!.messages.length, 64);
    assert.ok(f.runtime.state.conversation!.intents[ids[0]!]);
    assert.equal(f.runtime.state.historyProofs?.[ids[0]!]!.slots[0]!.outcome, 'unresolved');
    assert.equal(
      f.runtime.mutationsHeld,
      true,
      'display paging does not release recovery authority',
    );
  } finally {
    await f.close();
  }
});

test('actual disconnected pages keep old messages and fill the gap without repeated refresh hiding it', async () => {
  const f = await fixture(15);
  try {
    const oldMessages = f.runtime.state.conversation!.messages;
    assert.equal(oldMessages.length, 30);
    await f.append(40);
    await f.runtime.reload();
    assert.equal(f.runtime.state.conversation!.messages.length, 60);
    assert.equal(f.runtime.state.conversation!.beforeSequence, 80);
    assert.equal(f.runtime.state.conversation!.hasHistoryGap, true);
    for (const message of oldMessages)
      assert.deepEqual(
        f.runtime.state.conversation!.messages.find((item) => item.messageId === message.messageId),
        message,
      );
    await f.runtime.reload();
    assert.equal(f.runtime.state.conversation!.beforeSequence, 80);
    await f.runtime.reload(true);
    assert.equal(f.runtime.state.conversation!.beforeSequence, 50);
    assert.equal(f.runtime.state.conversation!.hasHistoryGap, true);
    assert.equal(f.runtime.state.conversation!.messages.length, 90);
    await f.runtime.reload(true);
    assert.equal(f.runtime.state.conversation!.hasEarlier, false);
    assert.equal(f.runtime.state.conversation!.hasHistoryGap, false);
    assert.equal(f.runtime.state.conversation!.beforeSequence, null);
    assert.equal(f.runtime.state.conversation!.messages.length, 110);
    assert.equal(Object.keys(f.runtime.state.conversation!.intents).length, 55);
  } finally {
    await f.close();
  }
});

test('actual overlap and repeated refresh retain earlier progress; draft events do not alter paging coverage', async () => {
  const f = await fixture(40);
  try {
    await f.runtime.reload(true);
    assert.equal(f.runtime.state.conversation!.beforeSequence, 20);
    await f.append(5);
    await f.runtime.reload();
    await f.runtime.reload();
    assert.equal(f.runtime.state.conversation!.beforeSequence, 20);
    assert.equal(f.runtime.state.conversation!.messages.length, 70);
    assert.equal(f.runtime.state.conversation!.hasHistoryGap, false);
    await f.runtime.recovery.check();
    await f.runtime.reload();
    const messages = f.runtime.state.conversation!.messages;
    f.runtime.setDraft('Keep earlier paging while typing');
    await (Reflect.get(f.runtime, 'drafts') as Promise<void>);
    assert.equal(f.runtime.state.conversation!.beforeSequence, 20);
    assert.equal(f.runtime.state.conversation!.messages, messages);
    await loadAll(f.runtime);
    assert.equal(f.runtime.state.conversation!.messages.length, 90);
    assert.equal(f.runtime.state.draft, 'Keep earlier paging while typing');
  } finally {
    await f.close();
  }
});

test('actual append discovered while paging backwards exposes the unseen latest range', async () => {
  const f = await fixture(40);
  try {
    assert.equal(f.runtime.state.conversation!.beforeSequence, 50);
    await f.append(20);
    await f.runtime.reload(true);
    assert.equal(f.runtime.state.conversation!.beforeSequence, 120);
    assert.equal(f.runtime.state.conversation!.hasHistoryGap, true);
    assert.equal(f.runtime.state.conversation!.hasEarlier, true);
    assert.equal(f.runtime.state.conversation!.messages.length, 60);
    await loadAll(f.runtime);
    assert.equal(f.runtime.state.conversation!.messages.length, 120);
    assert.equal(Object.keys(f.runtime.state.conversation!.intents).length, 60);
  } finally {
    await f.close();
  }
});

test('actual clear resets old coverage and a later new-generation gap remains reachable', async () => {
  const f = await fixture(20);
  try {
    const generation = f.runtime.state.conversation!.header.generation;
    await loadAll(f.runtime);
    const review = ready(await f.services.commands.reviewDirect({ kind: 'clearConversation' }));
    const command = ready(await f.services.commands.prepareDirect(review));
    f.runtime.invalidate();
    assert.equal((await f.services.commands.execute(command)).kind, 'receipt');
    await f.runtime.reload();
    assert.equal(f.runtime.state.conversation!.header.generation, generation + 1);
    assert.equal(f.runtime.state.conversation!.messages.length, 0);
    assert.equal(f.runtime.state.conversation!.hasEarlier, false);
    await f.append(20);
    await f.runtime.reload();
    assert.equal(f.runtime.state.conversation!.hasEarlier, true);
    await loadAll(f.runtime);
    assert.equal(f.runtime.state.conversation!.messages.length, 40);
    assert.equal(f.runtime.state.conversation!.hasEarlier, false);
  } finally {
    await f.close();
  }
});
