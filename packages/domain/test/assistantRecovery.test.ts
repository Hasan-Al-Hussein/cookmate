import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { catalogueBoundary } from '@cookmate/catalogue';
import { readAssistantIntentInSnapshot } from '../../../apps/mobile/src/data/assistantIntentRecords';
import { recoverInterruptedAssistantWork } from '../../../apps/mobile/src/data/assistantRecovery';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { ready, recoveryFixture } from './helpers/recoveryGate';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

function revisions(database: DatabaseSync) {
  return database
    .prepare('SELECT collection,revision FROM state_revision ORDER BY collection')
    .all();
}

function revision(database: DatabaseSync, collection: string): number {
  return database.prepare('SELECT revision FROM state_revision WHERE collection=?').get(collection)
    ?.revision as number;
}

function authority(database: DatabaseSync, id: string) {
  return database
    .prepare(
      'SELECT p.phase,a.lifecycle FROM pending_intent p JOIN assistant_intent_context a ON a.user_intent_id=p.user_intent_id WHERE p.user_intent_id=?',
    )
    .get(id);
}

function immutableRecords(database: DatabaseSync, id: string) {
  return {
    context: database
      .prepare(
        'SELECT request_json,response_json,guards_json,slot_results_json,context_revision FROM assistant_intent_context WHERE user_intent_id=?',
      )
      .get(id),
    envelope: database
      .prepare('SELECT * FROM assistant_acceptance_envelope WHERE user_intent_id=?')
      .get(id),
    acceptance: database
      .prepare('SELECT * FROM assistant_acceptance WHERE user_intent_id=?')
      .get(id),
    action: database.prepare('SELECT * FROM assistant_action_plan WHERE user_intent_id=?').get(id),
    commands: database
      .prepare('SELECT * FROM command_slot WHERE user_intent_id=? ORDER BY position')
      .all(id),
    receipts: database
      .prepare('SELECT * FROM operation_receipt WHERE user_intent_id=? ORDER BY operation_id')
      .all(id),
  };
}

test('startup suspends accepted ready plans with or without finalized commands without changing semantic guards', async () => {
  for (const finalized of [false, true]) {
    const f = await recoveryFixture();
    try {
      const turn = await f.addTurn({ plan: finalized, execute: false, twoSlots: true });
      if (!finalized) {
        const accepted = ready(await f.turns.readIntent(turn.request.userIntentId));
        assert.ok(accepted?.guards);
        ready(
          await f.actions.freezeActionPlan({
            plan: turn.plan,
            expectedIntentRevision: 0,
            guards: accepted.guards,
          }),
        );
      }
      const id = turn.request.userIntentId;
      const before = immutableRecords(f.database, id);
      const storeRevision = revision(f.database, 'store');
      const contextRevision = revision(f.database, 'conversation');
      await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
      assert.equal(authority(f.database, id)?.phase, 'reconciling');
      assert.equal(authority(f.database, id)?.lifecycle, 'accepted');
      assert.equal(ready(await f.turns.readIntent(id))?.intent.phase, 'reconciling');
      assert.equal(revision(f.database, 'store'), storeRevision + 1);
      assert.equal(revision(f.database, 'conversation'), contextRevision);
      assert.deepEqual(immutableRecords(f.database, id), before);

      const settledRevisions = revisions(f.database);
      const changes = f.database.prepare('SELECT total_changes() AS n').get()?.n;
      await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
      assert.deepEqual(revisions(f.database), settledRevisions);
      assert.deepEqual(immutableRecords(f.database, id), before);
      assert.equal(f.database.prepare('SELECT total_changes() AS n').get()?.n, changes);

      const finalize = await f.actions.finalizeNextIntentSlot(turn.slotInput(finalized ? 1 : 0));
      assert.equal(finalize.kind, 'failed');
      if (finalize.kind === 'failed') assert.equal(finalize.error.code, 'cancelled');
      if (finalized) {
        const execute = await f.actions.executeIntentSlot(turn.slotInput());
        assert.equal(execute.kind, 'failed');
        if (execute.kind === 'failed') assert.equal(execute.error.code, 'cancelled');
      }
      assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM operation_receipt').get()?.n, 0);
      assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM favourite').get()?.n, 0);
    } finally {
      await f.close();
    }
  }
});

test('disk reopen preserves a dispatched receipt prefix and repeated suspended startup performs no writes', async () => {
  const f = await recoveryFixture();
  let originalClosed = false;
  let reopened: { database: DatabaseSync; writer: SerializedWriter } | undefined;
  try {
    const turn = await f.addTurn({ twoSlots: true });
    ready(await f.actions.finalizeNextIntentSlot(turn.slotInput(1)));
    const id = turn.request.userIntentId;
    assert.equal(authority(f.database, id)?.phase, 'dispatched');
    const before = immutableRecords(f.database, id);
    assert.equal(before.receipts.length, 1);
    const favourites = f.database.prepare('SELECT * FROM favourite ORDER BY recipe_id').all();
    const storeRevision = revision(f.database, 'store');
    const contextRevision = revision(f.database, 'conversation');
    await f.reader.close();
    await f.writer.close();
    originalClosed = true;

    for (const first of [true, false]) {
      const storage = desktopConnection(f.path);
      reopened = { database: storage.database, writer: new SerializedWriter(storage.connection) };
      await configureConnection(storage.connection);
      await recoverInterruptedAssistantWork(reopened.writer, catalogueBoundary);
      assert.equal(authority(reopened.database, id)?.phase, 'reconciling');
      assert.equal(authority(reopened.database, id)?.lifecycle, 'accepted');
      assert.deepEqual(immutableRecords(reopened.database, id), before);
      assert.deepEqual(
        reopened.database.prepare('SELECT * FROM favourite ORDER BY recipe_id').all(),
        favourites,
      );
      assert.equal(revision(reopened.database, 'store'), storeRevision + 1);
      assert.equal(revision(reopened.database, 'conversation'), contextRevision);
      const saved = await reopened.writer.transaction((session) =>
        readAssistantIntentInSnapshot(session, catalogueBoundary, id),
      );
      assert.equal(saved?.intent.phase, 'reconciling');
      assert.equal(saved?.slotResults[0]?.result.kind, 'receipt');
      if (!first)
        assert.equal(reopened.database.prepare('SELECT total_changes() AS n').get()?.n, 0);
      await reopened.writer.close();
      reopened = undefined;
    }
  } finally {
    if (originalClosed) {
      await reopened?.writer.close();
      await removeFixtureDirectory(dirname(f.path));
    } else await f.close();
  }
});

test('mixed sending-message recovery advances semantic revision without rewriting suspended action guards', async () => {
  const f = await recoveryFixture();
  try {
    const turn = await f.addTurn({ execute: false });
    const id = turn.request.userIntentId;
    const before = immutableRecords(f.database, id);
    const storeRevision = revision(f.database, 'store');
    const contextRevision = revision(f.database, 'conversation');
    const messageId = randomUUID();
    const sequence = f.database.prepare('SELECT next_sequence AS n FROM conversation').get()?.n;
    f.database
      .prepare('INSERT INTO message VALUES (?, ?, 0, ?, ?, ?, ?, ?)')
      .run(
        messageId,
        turn.request.conversationId,
        sequence!,
        'user',
        JSON.stringify('Another interrupted request'),
        'sending',
        '2026-09-28T00:00:00.000Z',
      );
    f.database.exec('UPDATE conversation SET next_sequence=next_sequence+1');

    await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
    assert.equal(authority(f.database, id)?.lifecycle, 'accepted');
    assert.equal(authority(f.database, id)?.phase, 'reconciling');
    assert.equal(revision(f.database, 'store'), storeRevision + 1);
    assert.equal(revision(f.database, 'conversation'), contextRevision + 1);
    assert.deepEqual(immutableRecords(f.database, id), before);
    assert.equal(
      f.database.prepare('SELECT status FROM message WHERE message_id=?').get(messageId)?.status,
      'interrupted',
    );
    const saved = ready(await f.turns.readIntent(id));
    assert.equal(saved?.guards?.contextRevision, contextRevision);
    const changes = f.database.prepare('SELECT total_changes() AS n').get()?.n;
    await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
    assert.equal(f.database.prepare('SELECT total_changes() AS n').get()?.n, changes);
  } finally {
    await f.close();
  }
});

test('deliberate cancellation and legacy cancelled/reconciling plans never regain accepted provenance', async () => {
  for (const partial of [false, true]) {
    const f = await recoveryFixture();
    try {
      const turn = await f.addTurn({ execute: partial, twoSlots: true });
      ready(
        await f.actions.cancelIntent({
          userIntentId: turn.request.userIntentId,
          expectedIntentRevision: 0,
        }),
      );
      const id = turn.request.userIntentId;
      const before = immutableRecords(f.database, id);
      const beforeRevisions = revisions(f.database);
      const changes = f.database.prepare('SELECT total_changes() AS n').get()?.n;
      await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
      assert.equal(authority(f.database, id)?.lifecycle, 'cancelled');
      assert.equal(authority(f.database, id)?.phase, partial ? 'reconciling' : 'cancelled');
      assert.deepEqual(immutableRecords(f.database, id), before);
      assert.deepEqual(revisions(f.database), beforeRevisions);
      assert.equal(f.database.prepare('SELECT total_changes() AS n').get()?.n, changes);
    } finally {
      await f.close();
    }
  }
});

test('accepted proposals without a frozen plan retain fail-closed semantic retirement', async () => {
  const f = await recoveryFixture();
  try {
    const turn = await f.addTurn({ plan: false });
    const id = turn.request.userIntentId;
    const before = immutableRecords(f.database, id);
    assert.equal(before.action, undefined);
    const storeRevision = revision(f.database, 'store');
    const contextRevision = revision(f.database, 'conversation');
    await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
    assert.equal(authority(f.database, id)?.lifecycle, 'cancelled');
    assert.equal(authority(f.database, id)?.phase, 'cancelled');
    assert.equal(revision(f.database, 'store'), storeRevision + 1);
    assert.equal(revision(f.database, 'conversation'), contextRevision + 1);
    assert.deepEqual(immutableRecords(f.database, id), before);
    const changes = f.database.prepare('SELECT total_changes() AS n').get()?.n;
    await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
    assert.equal(f.database.prepare('SELECT total_changes() AS n').get()?.n, changes);
  } finally {
    await f.close();
  }
});

test('corrupt accepted plans or missing prefix receipts fail startup atomically instead of gaining suspension provenance', async () => {
  for (const corruption of ['plan', 'suspended_plan', 'receipt'] as const) {
    const f = await recoveryFixture();
    try {
      const turn = await f.addTurn({ execute: corruption === 'receipt', twoSlots: true });
      const id = turn.request.userIntentId;
      if (corruption === 'suspended_plan')
        await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
      if (corruption !== 'receipt')
        f.database
          .prepare('UPDATE assistant_action_plan SET plan_json=? WHERE user_intent_id=?')
          .run('{}', id);
      else f.database.prepare('DELETE FROM operation_receipt WHERE user_intent_id=?').run(id);
      const before = immutableRecords(f.database, id);
      const beforeAuthority = authority(f.database, id);
      const beforeRevisions = revisions(f.database);
      await assert.rejects(
        recoverInterruptedAssistantWork(f.writer, catalogueBoundary),
        /Stored conversation is invalid/,
      );
      assert.deepEqual(authority(f.database, id), beforeAuthority);
      assert.deepEqual(immutableRecords(f.database, id), before);
      assert.deepEqual(revisions(f.database), beforeRevisions);
    } finally {
      await f.close();
    }
  }
});
