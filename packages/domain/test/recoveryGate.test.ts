import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runBound } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';
import { finishAudit, ready, recoveryFixture } from './helpers/recoveryGate';

test('cold discovery rejects orphan recovery evidence after freshness invalidation without changing it', async () => {
  for (const table of [
    'assistant_acceptance_envelope',
    'assistant_action_plan',
    'assistant_acceptance',
    'command_slot',
  ]) {
    const f = await recoveryFixture();
    try {
      await f.addTurn({ execute: false });
      const gate = f.install();
      assert.equal((await finishAudit(gate)).value.candidates.length, 1);
      const id = randomUUID();
      f.database.exec('PRAGMA foreign_keys=OFF');
      if (table === 'assistant_acceptance_envelope')
        f.database
          .prepare('INSERT INTO assistant_acceptance_envelope VALUES (?,?,0)')
          .run(id, randomUUID());
      else if (table === 'assistant_action_plan')
        f.database
          .prepare(
            'INSERT INTO assistant_action_plan SELECT ?,plan_json,guards_json,cursor FROM assistant_action_plan LIMIT 1',
          )
          .run(id);
      else if (table === 'assistant_acceptance')
        f.database
          .prepare(
            'INSERT INTO assistant_acceptance SELECT ?,normalization_version,fingerprint,acknowledgement_json FROM assistant_acceptance LIMIT 1',
          )
          .run(id);
      else
        f.database
          .prepare(
            'INSERT INTO command_slot SELECT ?,?,position,?,command_json FROM command_slot LIMIT 1',
          )
          .run(randomUUID(), id, randomUUID());
      f.database.exec('PRAGMA foreign_keys=ON');
      assert.ok(f.database.prepare('PRAGMA foreign_key_check').all().length > 0);
      const before = f.database.prepare('SELECT total_changes() AS count').get()!.count;
      assert.equal((await gate.refreshRecoveryGate()).kind, 'failed', table);
      assert.equal(gate.unchangedCertificate(), undefined);
      assert.equal(f.database.prepare('SELECT total_changes() AS count').get()!.count, before);
      assert.equal(
        f.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_intent_id=?`).get(id)!
          .count,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test('32/100 settled plans use bounded cold audits and zero historical bodies or hashes on warm/draft checks', async (t) => {
  for (const size of [32, 100]) {
    const f = await recoveryFixture();
    try {
      for (let index = 0; index < size; index++) await f.addTurn();
      const gate = f.install();
      f.resetCounters();
      const cold = await finishAudit(gate);
      const coldCounts = { ...f.counters, ports: cold.calls };
      assert.equal(cold.calls, Math.ceil(size / 32));
      assert.equal(cold.value.candidates.length, 0);
      assert.equal(coldCounts.hashes, size);
      f.resetCounters();
      const warm = await finishAudit(gate);
      const warmCounts = { ...f.counters, ports: warm.calls };
      assert.equal(warm.value.token, cold.value.token);
      assert.equal(warm.value.candidates, cold.value.candidates);
      assert.equal(warmCounts.hashes, 0);
      assert.equal(warmCounts.bodies, 0);
      assert.equal(warm.calls, 1);
      const header = f.database
        .prepare('SELECT conversation_id AS id,generation FROM conversation')
        .get()!;
      const contextRevision = f.database
        .prepare("SELECT revision FROM state_revision WHERE collection='conversation'")
        .get()!.revision as number;
      f.resetCounters();
      ready(
        await f.turns.saveDraft(
          {
            conversationId: header.id as string,
            generation: header.generation as number,
            expectedConversationRevision: contextRevision,
          },
          'A persisted draft',
        ),
      );
      assert.deepEqual(gate.unchangedCertificate(), { kind: 'unchanged', token: warm.value.token });
      const draft = await finishAudit(gate);
      const draftCounts = { ...f.counters, ports: draft.calls };
      assert.equal(draft.value.token, warm.value.token);
      assert.equal(draftCounts.bodies, 0);
      assert.equal(draftCounts.hashes, 0);
      const active = await f.addTurn({ execute: false });
      await finishAudit(gate);
      f.resetCounters();
      await f.writer.transaction(
        async (session) => {
          await runBound(
            session,
            'UPDATE assistant_intent_context SET slot_results_json=? WHERE user_intent_id=?',
            [
              JSON.stringify([
                {
                  slotId: active.plan.slots[0]!.slotId,
                  result: {
                    kind: 'failed',
                    operationId: active.plan.slots[0]!.operationId,
                    error: {
                      code: 'network_unavailable',
                      messageKey: 'test.unavailable',
                      retry: 'after_reconnect',
                    },
                  },
                },
              ]),
              active.plan.userIntentId,
            ],
          );
          await runBound(
            session,
            "UPDATE state_revision SET revision=revision+1 WHERE collection='store'",
            [],
          );
        },
        { kind: 'intents', userIntentIds: [active.plan.userIntentId] },
      );
      const journal = await finishAudit(gate);
      const journalCounts = { ...f.counters, ports: journal.calls };
      assert.equal(journal.calls, 1);
      assert.equal(journalCounts.hashes, 1);
      assert.deepEqual(
        journal.value.candidates.map((proof) => proof.userIntentId),
        [active.plan.userIntentId],
      );
      t.diagnostic(
        JSON.stringify({
          retainedSettled: size,
          cold: coldCounts,
          warm: warmCounts,
          draftAndRefresh: draftCounts,
          journalAndRefresh: journalCounts,
        }),
      );
    } finally {
      await f.close();
    }
  }
});

test('cold continuation survives drafts and does not omit a newly inserted intent before the keyset cursor', async () => {
  const f = await recoveryFixture();
  try {
    for (let index = 0; index < 33; index++)
      await f.addTurn({ id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
    const gate = f.install();
    const first = ready(await gate.refreshRecoveryGate());
    assert.equal(first.kind, 'checking');
    if (first.kind !== 'checking') assert.fail();
    const header = f.database
      .prepare('SELECT conversation_id AS id,generation FROM conversation')
      .get()!;
    const revision = f.database
      .prepare("SELECT revision FROM state_revision WHERE collection='conversation'")
      .get()!.revision as number;
    ready(
      await f.turns.saveDraft(
        {
          conversationId: header.id as string,
          generation: header.generation as number,
          expectedConversationRevision: revision,
        },
        'Typing during cold audit',
      ),
    );
    assert.deepEqual(gate.unchangedCertificate(), { kind: 'unchanged', token: first.token });
    const active = await f.addTurn({ id: '00000000-0000-4000-8000-000000000001', execute: false });
    const next = await finishAudit(gate);
    assert.equal(next.calls, 1);
    assert.notEqual(next.value.token, first.token);
    assert.deepEqual(
      next.value.candidates.map((proof) => proof.userIntentId),
      [active.plan.userIntentId],
    );
    const commandCount = f.database.prepare('SELECT count(*) AS n FROM operation_receipt').get()?.n;
    assert.equal(commandCount, 33);
    const stale = await gate.refreshRecoveryGate({ continuation: first.continuation });
    assert.equal(stale.kind, 'failed');
  } finally {
    await f.close();
  }
});

test('partial receipt progress remains a candidate until cancellation proves the reserved remainder unexecuted', async () => {
  const f = await recoveryFixture();
  try {
    const turn = await f.addTurn({ twoSlots: true, execute: false });
    const gate = f.install();
    const initial = await finishAudit(gate);
    assert.deepEqual(
      initial.value.candidates[0]!.slots.map((slot) => slot.outcome),
      ['unresolved', 'unresolved'],
    );
    assert.equal((await f.actions.executeIntentSlot(turn.slotInput())).kind, 'receipt');
    const partial = await finishAudit(gate);
    assert.notEqual(partial.value.token, initial.value.token);
    assert.deepEqual(
      partial.value.candidates[0]!.slots.map((slot) => slot.outcome),
      ['receipt', 'unresolved'],
    );
    ready(
      await f.actions.cancelIntent({
        userIntentId: turn.plan.userIntentId,
        expectedIntentRevision: 0,
      }),
    );
    const cancelled = await finishAudit(gate);
    assert.equal(cancelled.value.candidates.length, 0);
    const proof = ready(await f.actions.readActionRecovery(turn.plan.userIntentId));
    assert.deepEqual(
      proof!.slots.map((slot) => slot.outcome),
      ['receipt', 'not_executed'],
    );
    assert.equal((await f.actions.finalizeNextIntentSlot(turn.slotInput(1))).kind, 'failed');
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM operation_receipt').get()!.n, 1);
  } finally {
    await f.close();
  }
});

test('clear during cold progress replaces coverage generation and retains only independent direct intents', async () => {
  const f = await recoveryFixture();
  try {
    for (let index = 0; index < 33; index++) await f.addTurn({ plan: false });
    const gate = f.install();
    const initial = ready(await gate.refreshRecoveryGate());
    assert.equal(initial.kind, 'checking');
    assert.equal((await f.clearConversation()).kind, 'receipt');
    const cleared = await finishAudit(gate);
    assert.equal(cleared.value.candidates.length, 0);
    assert.equal(cleared.value.conversationId, initial.conversationId);
    assert.equal(cleared.value.conversationGeneration, initial.conversationGeneration + 1);
    assert.notEqual(cleared.value.token, initial.token);
    assert.equal(
      f.database.prepare('SELECT count(*) AS n FROM assistant_intent_context').get()!.n,
      0,
    );
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM operation_receipt').get()!.n, 1);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM pending_intent').get()!.n, 1);
    if (initial.kind !== 'checking') assert.fail();
    assert.equal(
      (await gate.refreshRecoveryGate({ continuation: initial.continuation })).kind,
      'failed',
    );
  } finally {
    await f.close();
  }
});

test('no-plan message corruption, missing plans and receipt deletion are detected after unexpected same-handle writes', async () => {
  for (const corruption of ['reply', 'plan', 'receipt']) {
    const f = await recoveryFixture();
    try {
      const turn = await f.addTurn({ plan: corruption !== 'reply' });
      const gate = f.install();
      await finishAudit(gate);
      if (corruption === 'reply')
        f.database
          .prepare('UPDATE message SET text=? WHERE message_id=?')
          .run(JSON.stringify('Corrupted reply'), turn.begun.acceptanceEnvelope.assistantMessageId);
      else if (corruption === 'plan')
        f.database
          .prepare('DELETE FROM assistant_action_plan WHERE user_intent_id=?')
          .run(turn.plan.userIntentId);
      else
        f.database
          .prepare('DELETE FROM operation_receipt WHERE operation_id=?')
          .run(turn.plan.slots[0]!.operationId);
      const changes = f.database.prepare('SELECT total_changes() AS n').get()?.n;
      const events: unknown[] = [];
      gate.subscribeRecoveryInvalidation((event) => events.push(event));
      assert.equal((await gate.refreshRecoveryGate()).kind, 'failed');
      assert.ok(events.some((event) => (event as { token: unknown }).token === null));
      assert.equal(gate.unchangedCertificate(), undefined);
      assert.equal(f.database.prepare('SELECT total_changes() AS n').get()?.n, changes);
    } finally {
      await f.close();
    }
  }
});

test('external commits before BEGIN and after COMMIT never publish a stale reusable baseline', async () => {
  for (const boundary of ['beforeBegin', 'afterCommit'] as const) {
    const f = await recoveryFixture();
    const external = desktopConnection(f.path);
    try {
      const turn = await f.addTurn({ plan: false });
      const gate = f.install();
      await finishAudit(gate);
      f.faults[boundary] = () => {
        f.faults[boundary] = undefined;
        external.database
          .prepare('UPDATE message SET text=? WHERE message_id=?')
          .run(
            JSON.stringify('Externally changed'),
            turn.begun.acceptanceEnvelope.assistantMessageId,
          );
      };
      assert.equal((await gate.refreshRecoveryGate()).kind, 'failed');
      assert.equal(gate.unchangedCertificate(), undefined);
    } finally {
      await external.connection.close();
      await f.close();
    }
  }
});

test('cold discovery rejects missing assistant context for active and no-plan intents after external deletion', async () => {
  for (const plan of [true, false]) {
    const f = await recoveryFixture();
    const external = desktopConnection(f.path);
    try {
      const turn = await f.addTurn({ plan, execute: false });
      const gate = f.install();
      const initial = await finishAudit(gate);
      assert.equal(initial.value.candidates.length, plan ? 1 : 0);
      external.database
        .prepare('DELETE FROM assistant_intent_context WHERE user_intent_id=?')
        .run(turn.request.userIntentId);
      assert.equal((await gate.refreshRecoveryGate()).kind, 'failed');
      assert.equal(gate.unchangedCertificate(), undefined);
    } finally {
      await external.connection.close();
      await f.close();
    }
  }
});

test('unknown impact invalidates before callback; rollback and lost acknowledgement never certify staged recovery', async () => {
  for (const mode of ['rollback', 'ack']) {
    const f = await recoveryFixture();
    try {
      await f.addTurn();
      const gate = f.install();
      await finishAudit(gate);
      const events: { token: string | null }[] = [];
      gate.subscribeRecoveryInvalidation((event) => events.push(event));
      f.faults.commitAck = mode === 'ack';
      await assert.rejects(
        f.writer.transaction(async (session) => {
          assert.ok(events.length > 0, 'invalidation must precede mutating callback');
          assert.equal(gate.unchangedCertificate(), undefined);
          await runBound(session, 'UPDATE conversation SET composer_draft=?', [
            JSON.stringify('Unknown write'),
          ]);
          if (mode === 'rollback') throw new Error('injected rollback');
        }),
      );
      assert.equal(gate.unchangedCertificate(), undefined);
      assert.equal(events.at(-1)!.token, null);
      if (mode === 'rollback') {
        f.resetCounters();
        await finishAudit(gate);
        assert.equal(f.counters.hashes, 1);
      } else assert.equal((await gate.refreshRecoveryGate()).kind, 'failed');
    } finally {
      await f.close();
    }
  }
});

test('read-only mutation, invalid draft, schema change and unavailable fences fail closed', async () => {
  for (const mode of ['read_only', 'draft', 'schema', 'fence']) {
    const f = await recoveryFixture();
    try {
      const gate = f.install();
      await finishAudit(gate);
      if (mode === 'read_only')
        await assert.rejects(
          f.writer.transaction(
            async (session) => {
              await runBound(session, 'UPDATE conversation SET composer_draft=?', [
                JSON.stringify('hidden write'),
              ]);
            },
            { kind: 'read_only' },
          ),
        );
      else if (mode === 'draft')
        await assert.rejects(
          f.writer.transaction(
            async (session) => {
              await runBound(session, 'UPDATE conversation SET next_sequence=next_sequence+1', []);
            },
            { kind: 'draft_only' },
          ),
        );
      else {
        if (mode === 'schema')
          f.database.exec('CREATE TABLE unexpected_recovery_table(value TEXT)');
        else f.faults.failFence = true;
        assert.equal((await gate.refreshRecoveryGate()).kind, 'failed');
      }
      assert.equal(gate.unchangedCertificate(), undefined);
    } finally {
      await f.close();
    }
  }
});

test('an oversized single receipt fails before decoding its body and a closed gate rejects old continuations', async () => {
  const f = await recoveryFixture();
  try {
    const turn = await f.addTurn();
    f.database
      .prepare('UPDATE operation_receipt SET effects_json=? WHERE operation_id=?')
      .run(
        JSON.stringify([{ extra: 'x'.repeat(2 * 1024 * 1024) }]),
        turn.plan.slots[0]!.operationId,
      );
    const gate = f.install();
    f.resetCounters();
    assert.equal((await gate.refreshRecoveryGate()).kind, 'failed');
    assert.equal(f.counters.bodies, 0);
    assert.equal(f.counters.hashes, 0);
    gate.close();
    assert.equal((await gate.refreshRecoveryGate({ continuation: 'old-instance' })).kind, 'failed');
  } finally {
    await f.close();
  }
});

test('schema identity is verified at first use and retained across failed coverage audits', async () => {
  for (const priorAudit of [false, true]) {
    const f = await recoveryFixture();
    try {
      const gate = f.install();
      if (priorAudit) {
        await finishAudit(gate);
        await assert.rejects(
          f.writer.transaction(async () => {
            throw new Error('rollback');
          }),
        );
      }
      f.database.exec('CREATE TABLE unexpected_recovery_table(value TEXT)');
      assert.equal((await gate.refreshRecoveryGate()).kind, 'failed');
      assert.equal(gate.unchangedCertificate(), undefined);
    } finally {
      await f.close();
    }
  }
});
