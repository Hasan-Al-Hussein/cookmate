import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AssistantTurnRequest } from '@cookmate/contracts';
import type { GatewayConnection } from '../../connection';
import { createLocalStore } from '../../data/localStore';
import {
  desktopConnection,
  removeFixtureDirectory,
} from '../../../../../packages/domain/test/helpers/sqlite';
import { AssistantRuntime, type AssistantCoordinator } from './assistantRuntime';
import { DirectActionController } from '../workspace/directActionController';

async function fixture(retainedRequests = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-ui-'));
  const filename = join(directory, 'store.db');
  const result = await createLocalStore({
    openConnection: async () => desktopConnection(filename).connection,
    platform: {
      newId: randomUUID,
      sha256: async (text) => createHash('sha256').update(text).digest('hex'),
    },
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => ({ localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
  });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('Fixture store unavailable');
  const services = result.services;
  const port = services.assistant({ connectionGeneration: () => 1 });
  for (let i = 0; i < retainedRequests; i++) {
    const context = await port.readContext({
      text: `Retained request ${i}`,
      messageId: randomUUID(),
      selection: {},
    });
    assert.equal(context.kind, 'ready');
    if (context.kind !== 'ready') assert.fail();
    const snapshot = JSON.parse(JSON.stringify(context.value));
    const request: AssistantTurnRequest = {
      apiVersion: '2',
      catalogue: services.queries.catalogue,
      requestId: randomUUID(),
      userIntentId: randomUUID(),
      intentRevision: 0,
      conversationId: snapshot.conversationId,
      conversationGeneration: snapshot.conversationGeneration,
      connectionGeneration: 1,
      message: snapshot.currentMessage,
      context: {
        date: snapshot.date,
        history: snapshot.history,
        memory: snapshot.memory,
        preferences: snapshot.preferences,
        referenceSets: snapshot.referenceSets,
        planOccurrences: snapshot.planOccurrences,
      },
      capabilities: ['saveRecipe'],
    };
    const begun = await port.beginTurn({
      request,
      expectedConversationRevision: snapshot.contextRevision,
    });
    assert.equal(begun.kind, 'ready');
    if (begun.kind !== 'ready') assert.fail();
    const cancelled = await port.cancelIntent({
      userIntentId: request.userIntentId,
      expectedIntentRevision: begun.value.intent.revision,
    });
    assert.equal(cancelled.kind, 'ready');
  }
  const counts = {
    gate: 0,
    conversationPages: 0,
    intentPages: 0,
    intentBodies: 0,
    displayProofs: 0,
    settlements: 0,
  };
  const persistence = {
    ...port,
    refreshRecoveryGate: async (...args: Parameters<typeof port.refreshRecoveryGate>) => {
      counts.gate++;
      return port.refreshRecoveryGate(...args);
    },
    readConversation: async (...args: Parameters<typeof port.readConversation>) => {
      counts.conversationPages++;
      return port.readConversation(...args);
    },
    readIntentPage: async (...args: Parameters<typeof port.readIntentPage>) => {
      counts.intentPages++;
      return port.readIntentPage(...args);
    },
    readIntent: async (...args: Parameters<typeof port.readIntent>) => {
      counts.intentBodies++;
      return port.readIntent(...args);
    },
    readActionRecovery: async (...args: Parameters<typeof port.readActionRecovery>) => {
      counts.displayProofs++;
      return port.readActionRecovery(...args);
    },
    reconcileActionRecovery: async (...args: Parameters<typeof port.reconcileActionRecovery>) => {
      counts.settlements++;
      return port.reconcileActionRecovery(...args);
    },
  };
  const connection = {
    getState: () => ({ status: 'unpaired', generation: 1 }),
    restore: async () => undefined,
  } as unknown as GatewayConnection;
  // This fixture never invokes provider/core actions: only actual Data + runtime + direct controller.
  const core = { invalidate() {} } as AssistantCoordinator;
  const runtime = new AssistantRuntime(persistence, core, connection, services);
  const actions = new DirectActionController(
    services,
    () => undefined,
    () => null,
    (command) => {
      if (command.command.kind === 'clearConversation') runtime.invalidate();
    },
    () => runtime.checkMutationFreshness(),
    () => {
      void runtime.recovery.check();
    },
  );
  runtime.setMutationGate(() => !actions.blocked);
  const stop = runtime.subscribe(() => actions.holdForAssistant(runtime.mutationsHeld));
  actions.holdForAssistant(runtime.mutationsHeld);
  runtime.start();
  await runtime.reload();
  await runtime.recovery.check();
  assert.equal(runtime.mutationsHeld, false);
  return {
    runtime,
    actions,
    services,
    port,
    counts,
    gateCalls: () => counts.gate,
    resetCounts() {
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
    },
    async close() {
      stop();
      await runtime.dispose();
      await services.close();
      await removeFixtureDirectory(directory);
    },
  };
}

test('actual factory draft certificate leaves the runtime gate ready without another recovery call', async () => {
  const f = await fixture();
  try {
    const before = f.gateCalls();
    f.resetCounts();
    const held: boolean[] = [];
    const stop = f.runtime.subscribe(() => held.push(f.runtime.mutationsHeld));
    f.runtime.setDraft('Retain this real SQLite draft');
    await (Reflect.get(f.runtime, 'drafts') as Promise<void>);
    await (Reflect.get(f.runtime, 'reads') as Promise<void>);
    assert.ok(before > 0);
    assert.deepEqual(f.counts, {
      gate: 0,
      conversationPages: 1,
      intentPages: 0,
      intentBodies: 0,
      displayProofs: 0,
      settlements: 0,
    });
    assert.equal(held.includes(true), false);
    const saved = await f.port.readConversation({ limit: 1 });
    assert.equal(saved.kind, 'ready');
    if (saved.kind === 'ready')
      assert.equal(saved.value.header.composerDraft, 'Retain this real SQLite draft');
    stop();
  } finally {
    await f.close();
  }
});

test('actual saved drafts with retained conversation read only their write guards and preserve loaded history', async (t) => {
  const f = await fixture(3);
  try {
    assert.equal(Object.keys(f.runtime.state.conversation!.intents).length, 3);
    const messages = f.runtime.state.conversation!.messages;
    const intents = f.runtime.state.conversation!.intents;
    f.resetCounts();
    for (let i = 0; i < 20; i++) {
      f.runtime.setDraft(`Real SQLite draft ${i}`);
      await (Reflect.get(f.runtime, 'drafts') as Promise<void>);
      await (Reflect.get(f.runtime, 'reads') as Promise<void>);
      assert.equal(f.runtime.state.conversation!.messages, messages);
      assert.equal(f.runtime.state.conversation!.intents, intents);
      assert.equal(f.runtime.state.conversation!.header.composerDraft, `Real SQLite draft ${i}`);
      assert.equal(f.runtime.state.draft, `Real SQLite draft ${i}`);
      assert.equal(f.runtime.mutationsHeld, false);
    }
    assert.deepEqual(f.counts, {
      gate: 0,
      conversationPages: 20,
      intentPages: 0,
      intentBodies: 0,
      displayProofs: 0,
      settlements: 0,
    });
    t.diagnostic(
      JSON.stringify({
        retainedRequests: 3,
        drafts: 20,
        ...f.counts,
        note: 'Conversation reads are existing one-row save guards, not transcript notification reloads; no SQL timing measured.',
      }),
    );
  } finally {
    await f.close();
  }
});

test('actual factory direct mutation survives its own invalidations and releases the shared hold after receipt proof', async () => {
  const f = await fixture();
  try {
    const held: boolean[] = [];
    const stop = f.runtime.subscribe(() => held.push(f.runtime.mutationsHeld));
    await f.actions.begin({ kind: 'setFavourite', recipeId: '52839', saved: true });
    await f.runtime.recovery.check();
    assert.equal(f.actions.state.kind, 'receipt');
    assert.equal(f.actions.blocked, false);
    assert.equal(f.runtime.mutationsHeld, false);
    assert.equal(held.includes(true), true);
    assert.equal(f.counts.settlements, 0);
    const favourites = await f.services.queries.readFavourites();
    assert.equal(favourites.kind, 'ready');
    if (favourites.kind === 'ready')
      assert.deepEqual(
        favourites.value.map((item) => item.recipeId),
        ['52839'],
      );
    stop();
  } finally {
    await f.close();
  }
});
