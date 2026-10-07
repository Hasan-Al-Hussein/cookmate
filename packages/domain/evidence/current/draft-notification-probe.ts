import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLocalStore } from '../../../../apps/mobile/src/data/localStore';
import { desktopConnection } from '../../test/helpers/sqlite';
import { recoveryFixture, ready } from '../../test/helpers/recoveryGate';
import type { StoreChange } from '../../src/services';

// Actual public factory, isolated temporary file SQLite, no implementation edits.
async function openFixture() {
  const owner = await recoveryFixture();
  const connections: ReturnType<typeof desktopConnection>[] = [];
  const opened = await createLocalStore({
    openConnection: async () => {
      const connection = desktopConnection(owner.path);
      connections.push(connection);
      return connection.connection;
    },
    platform: owner.platform,
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => ({ localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
  });
  assert.equal(opened.kind, 'ready');
  if (opened.kind !== 'ready') assert.fail();
  const services = opened.services;
  const assistant = services.assistant({ connectionGeneration: () => 1 });
  ready(await assistant.refreshRecoveryGate());
  const header = ready(await assistant.readConversation()).header;
  const guard = {
    conversationId: header.conversationId,
    generation: header.generation,
    expectedConversationRevision: header.revision,
  };
  return { connections, assistant, services, guard, header, close: async () => { await services.close(); await owner.close(); } };
}

const concurrent = await openFixture();
try {
  const events: StoreChange[] = [];
  concurrent.services.queries.subscribe(event => events.push(event));
  const firstText = 'First\u0000\ud800/e\u0301/😀';
  const secondText = 'Second\udc00/"literal JSON"';
  const mutableGuard = { ...concurrent.guard };
  const first = concurrent.assistant.saveDraft(mutableGuard, firstText);
  mutableGuard.generation += 10;
  const second = concurrent.assistant.saveDraft(concurrent.guard, secondText);
  const results = await Promise.all([first, second]);
  assert.equal(events.length, 2);
  for (let index = 0; index < 2; index++) {
    const result = results[index]!;
    const header = ready(result);
    if (result.kind !== 'ready') assert.fail();
    const event = events.find(item => item.revision === result.revision)!;
    assert.ok(event);
    assert.deepEqual(event.conversationChange, { kind: 'draft_only', header });
    assert.deepEqual(header, { ...concurrent.header, composerDraft: [firstText, secondText][index] });
    assert.ok(Object.isFrozen(header));
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.conversationChange));
    assert.ok(Object.isFrozen(event.conversationChange!.header));
    assert.throws(() => Object.assign(header, { composerDraft: 'caller mutation' }));
    assert.equal(event.conversationChange!.header.composerDraft, [firstText, secondText][index]);
  }
  const last = ready(await concurrent.assistant.readConversation()).header;
  assert.equal(last.composerDraft, secondText);
  assert.equal(last.revision, concurrent.header.revision);
  assert.equal(last.nextSequence, concurrent.header.nextSequence);
  assert.equal(last.generation, concurrent.header.generation);
  assert.ok(results[0].kind === 'ready' && results[1].kind === 'ready');
  assert.equal(results[1].revision, results[0].revision + 1);
  console.log('CONCURRENT_DRAFTS', JSON.stringify({ events: events.length, matchedTransactionRevisions: true, semanticHeaderUnchanged: true, exactUtf16: true, capturedGuard: true, immutable: true, finalDraft: 'second' }));
} finally { await concurrent.close(); }

const deferred = await openFixture();
try {
  const events: StoreChange[] = [];
  deferred.services.queries.subscribe(event => events.push(event));
  const writer = deferred.connections[0]!.connection;
  const reader = deferred.connections[1]!.connection;
  const originalExec = writer.exec;
  const originalAll = reader.all;
  let unavailable = true;
  let loseAck = true;
  reader.all = async (sql, values) => {
    if (unavailable) throw new Error('isolated reader outage');
    return originalAll(sql, values);
  };
  writer.exec = async sql => {
    await originalExec(sql);
    if (sql === 'COMMIT' && loseAck) {
      loseAck = false;
      throw new Error('isolated lost draft acknowledgement');
    }
  };
  assert.equal((await deferred.assistant.saveDraft(deferred.guard, 'Durable deferred draft')).kind, 'failed');
  assert.equal(events.length, 0);
  unavailable = false;
  // A successful independent read can reconcile the durable draft later; it is not a fresh draft commit.
  ready(await deferred.assistant.readIntent(randomUUID()));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.conversationChange, undefined);
  assert.equal(events[0]!.recovery, undefined);
  assert.equal(ready(await deferred.assistant.readConversation()).header.composerDraft, 'Durable deferred draft');
  ready(await deferred.assistant.readIntent(randomUUID()));
  assert.equal(events.length, 1);
  console.log('DEFERRED_ACK', JSON.stringify({ duringOutage: 0, afterProof: 1, conversationChange: false, recoveryCertificate: false, repeatNotification: false }));
} finally { await deferred.close(); }
