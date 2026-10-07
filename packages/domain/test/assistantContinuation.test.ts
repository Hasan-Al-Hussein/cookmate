import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogueBoundary } from '@cookmate/catalogue';
import { readReceiptInSnapshot } from '../../../apps/mobile/src/data/stateRepositories';
import {
  clone,
  ready,
  receipt,
  failed,
  deferred,
  placement,
  fixture,
  failedPlan,
  reviewValue,
} from './helpers/assistantContinuation';

test('D04 reopens generation 2 to 1, reviews without dispatch and confirms only the original failed plan once', async () => {
  const f = await fixture();
  try {
    const turn = await failedPlan(f);
    const original = f.store.database
      .prepare(
        'SELECT request_json,response_json,guards_json FROM assistant_intent_context WHERE user_intent_id=?',
      )
      .get(turn.plan.userIntentId);
    const acceptance = f.store.database.prepare('SELECT * FROM assistant_acceptance').all();
    await f.reopen(1);
    failed(await f.store.executor.execute(turn.frozen.command), 'cancelled');
    const before = f.snapshot();
    const attempts = f.attempts.length;
    const review = reviewValue(await f.review(turn.plan));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.attempts.length, attempts);
    assert.equal(review.state.guards.connectionGeneration, 1);
    assert.deepEqual(review.slot, { ...turn.frozen, commandState: 'frozen' });
    assert.deepEqual(review.prefixReceipts, [
      {
        slotId: turn.plan.slots[0]!.slotId,
        receipt: turn.firstReceipt,
      },
    ]);
    const actual = receipt(await f.store.actions.confirmActionContinuation({ review }));
    assert.equal(actual.operationId, turn.frozen.command.operationId);
    assert.equal(actual.payloadFingerprint, turn.frozen.command.payloadFingerprint);
    assert.deepEqual(
      f.attempts.map((entry) => entry.kind),
      ['setFavourite', 'addPlan', 'addPlan'],
    );
    assert.equal(
      ready(await f.store.turns.readIntent(turn.plan.userIntentId))?.intent.phase,
      'settled',
    );
    assert.deepEqual(
      f.store.database
        .prepare(
          'SELECT request_json,response_json,guards_json FROM assistant_intent_context WHERE user_intent_id=?',
        )
        .get(turn.plan.userIntentId),
      original,
    );
    assert.deepEqual(
      f.store.database.prepare('SELECT * FROM assistant_acceptance').all(),
      acceptance,
    );
    const after = f.snapshot();
    assert.deepEqual(receipt(await f.store.actions.confirmActionContinuation({ review })), actual);
    assert.deepEqual(f.snapshot(), after);
    assert.equal(f.attempts.length, 3);
    assert.equal(f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n, 1);
    assert.equal(f.store.database.prepare('SELECT revision FROM favourite').get()?.revision, 1);
  } finally {
    await f.close();
  }
});

test('historical continuation acknowledgement survives a missing prefix, clear and stale ancillary metadata but never altered commands', async () => {
  const f = await fixture();
  try {
    const turn = await failedPlan(f);
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    const actual = receipt(await f.store.actions.confirmActionContinuation({ review }));
    // Fault injection removes unrelated historical prefix proof; the target receipt still stands.
    f.store.database
      .prepare('DELETE FROM operation_receipt WHERE operation_id=?')
      .run(turn.firstReceipt.operationId);
    const missingPrefix = f.snapshot();
    assert.deepEqual(receipt(await f.store.actions.confirmActionContinuation({ review })), actual);
    assert.deepEqual(f.snapshot(), missingPrefix);
    receipt(
      await f.direct({
        kind: 'clearConversation',
        conversationId: turn.request.conversationId,
        expectedGeneration: turn.request.conversationGeneration,
      }),
    );
    const historic = clone(review);
    historic.reviewToken = randomUUID();
    historic.cursor = 7;
    historic.slot.slotId = randomUUID();
    historic.prefixReceipts = [];
    historic.state.guards.connectionGeneration = 999;
    const before = f.snapshot();
    const attempts = f.attempts.length;
    assert.deepEqual(
      receipt(await f.store.actions.confirmActionContinuation({ review: historic })),
      actual,
    );
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.attempts.length, attempts);
    assert.equal(f.store.database.prepare('SELECT COUNT(*) AS n FROM pending_intent').get()?.n, 1);
    assert.equal(
      f.store.database.prepare('SELECT COUNT(*) AS n FROM assistant_intent_context').get()?.n,
      0,
    );
    const wrong = clone(historic);
    wrong.slot.command.intentRevision++;
    failed(
      await f.store.actions.confirmActionContinuation({ review: wrong }),
      'operation_conflict',
    );
    assert.deepEqual(f.snapshot(), before);
  } finally {
    await f.close();
  }
});

test('another store lifetime cannot use an old review with no receipt, but the current store can later acknowledge its real receipt', async () => {
  const f = await fixture(1);
  try {
    const turn = await failedPlan(f);
    await f.reopen(1);
    const oldActions = f.store.actions;
    const oldReview = reviewValue(await f.review(turn.plan));
    await f.reopen(1);
    const before = f.snapshot();
    failed(await f.store.actions.confirmActionContinuation({ review: oldReview }), 'cancelled');
    failed(await oldActions.confirmActionContinuation({ review: oldReview }), 'storage_failure');
    assert.deepEqual(f.snapshot(), before);
    const current = reviewValue(await f.review(turn.plan));
    assert.notEqual(current.reviewToken, oldReview.reviewToken);
    const actual = receipt(await f.store.actions.confirmActionContinuation({ review: current }));
    assert.deepEqual(
      receipt(await f.store.actions.confirmActionContinuation({ review: oldReview })),
      actual,
    );
    assert.equal(f.attempts.length, 3);
  } finally {
    await f.close();
  }
});

test(
  'invalidating a pending read prevents late installation and does not invalidate a newer review',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const blocked = f.store.writer.transaction(
        async () => {
          entered.resolve();
          await release.promise;
        },
        { kind: 'read_only' },
      );
      await entered.promise;
      const obsolete = f.review(turn.plan);
      f.store.actions.invalidateActionContinuationReview();
      const current = f.review(turn.plan);
      release.resolve();
      await blocked;
      failed(await obsolete, 'cancelled');
      const review = reviewValue(await current);
      receipt(await f.store.actions.confirmActionContinuation({ review }));
      assert.equal(f.attempts.length, 3);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  'synchronous review invalidation blocks a confirmation waiting behind a writer without changing runtime generation',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    const hashed = deferred();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      const before = f.snapshot();
      const blocked = f.store.writer.transaction(
        async () => {
          entered.resolve();
          await release.promise;
        },
        { kind: 'read_only' },
      );
      await entered.promise;
      f.faults.beforeExecutorHash = async () => {
        hashed.resolve();
      };
      const confirming = f.store.actions.confirmActionContinuation({ review });
      await hashed.promise;
      await new Promise<void>((done) => setImmediate(done));
      f.store.actions.invalidateActionContinuationReview();
      release.resolve();
      await blocked;
      failed(await confirming, 'cancelled');
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.attempts.length, 2);
      const fresh = reviewValue(await f.review(turn.plan));
      receipt(await f.store.actions.confirmActionContinuation({ review: fresh }));
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test(
  'review invalidation in the final observer rolls back effect, receipt and cursor while retaining the actual failed attempt',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      let once = true;
      f.store.writer.setObserver({
        begin: async () => {},
        beforeCommit: async () => {
          if (once) {
            once = false;
            f.store.actions.invalidateActionContinuationReview();
          }
        },
        committed: async () => {},
        failed: () => {},
      });
      const result = await f.store.actions.confirmActionContinuation({ review });
      failed(result, 'cancelled');
      assert.equal(f.attempts.length, 3);
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n,
        0,
      );
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM operation_receipt').get()?.n,
        1,
      );
      assert.equal(
        f.store.database.prepare('SELECT cursor FROM assistant_action_plan').get()?.cursor,
        1,
      );
      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId));
      assert.deepEqual(
        saved?.slotResults.find((entry) => entry.slotId === turn.frozen.slotId)?.result,
        result,
      );
      assert.deepEqual(saved?.slotResults[0]?.result, {
        kind: 'receipt',
        receipt: turn.firstReceipt,
      });
      const fresh = reviewValue(await f.review(turn.plan));
      receipt(await f.store.actions.confirmActionContinuation({ review: fresh }));
    } finally {
      await f.close();
    }
  },
);

test('continuation rejects semantic, target and runtime drift without rebasing the displayed command', async () => {
  for (const change of ['target', 'preference', 'date', 'connection', 'cancel', 'clear'] as const) {
    const f = await fixture();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      if (change === 'target')
        receipt(
          await f.direct({
            kind: 'addPlan',
            occurrenceId: randomUUID(),
            recipeId: '53064',
            placement,
            expectedTarget: { kind: 'empty' },
          }),
        );
      else if (change === 'preference')
        receipt(
          await f.direct({
            kind: 'savePreference',
            preferenceId: randomUUID(),
            type: 'cuisine',
            explicitValue: 'Indian',
            expectedPreferenceRevision: 0,
          }),
        );
      else if (change === 'date') f.changeDate();
      else if (change === 'connection') f.setGeneration(2);
      else if (change === 'cancel')
        ready(
          await f.store.actions.cancelIntent({
            userIntentId: turn.plan.userIntentId,
            expectedIntentRevision: 0,
          }),
        );
      else
        receipt(
          await f.direct({
            kind: 'clearConversation',
            conversationId: turn.request.conversationId,
            expectedGeneration: 0,
          }),
        );
      const before = f.snapshot();
      const attempts = f.attempts.length;
      failed(await f.store.actions.confirmActionContinuation({ review }));
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.attempts.length, attempts);
      assert.equal(
        f.store.database
          .prepare('SELECT 1 FROM operation_receipt WHERE operation_id=?')
          .get(turn.frozen.command.operationId),
        undefined,
      );
    } finally {
      await f.close();
    }
  }
});

test('a repeated real handler failure is journaled and consumes the review without discarding the successful prefix', async () => {
  const f = await fixture();
  try {
    const turn = await failedPlan(f);
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    f.faults.statement = 'INSERT INTO plan_occurrence';
    const result = await f.store.actions.confirmActionContinuation({ review });
    failed(result, 'storage_failure');
    f.faults.statement = '';
    const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId));
    assert.equal(saved?.intent.phase, 'reconciling');
    assert.deepEqual(
      saved?.slotResults.find((entry) => entry.slotId === turn.frozen.slotId)?.result,
      result,
    );
    assert.deepEqual(saved?.slotResults[0]?.result, {
      kind: 'receipt',
      receipt: turn.firstReceipt,
    });
    const attempts = f.attempts.length;
    failed(await f.store.actions.confirmActionContinuation({ review }));
    assert.equal(f.attempts.length, attempts);
    const fresh = reviewValue(await f.review(turn.plan));
    receipt(await f.store.actions.confirmActionContinuation({ review: fresh }));
    assert.equal(f.store.database.prepare('SELECT revision FROM favourite').get()?.revision, 1);
  } finally {
    await f.close();
  }
});

test('a continued frozen slot does not finalize, execute or hide a later original reservation', async () => {
  const f = await fixture();
  try {
    const turn = await failedPlan(f, true);
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    receipt(await f.store.actions.confirmActionContinuation({ review }));
    const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId));
    assert.equal(saved?.intent.phase, 'reconciling');
    assert.equal(saved?.intent.slots.length, 2);
    assert.equal(saved?.actionPlan?.slots.length, 3);
    assert.deepEqual(saved?.actionPlan?.slots[2], turn.plan.slots[2]);
    const proof = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId));
    assert.deepEqual(
      proof?.slots.map((slot) => slot.outcome),
      ['receipt', 'receipt', 'not_executed'],
    );
    const tail = reviewValue(await f.review(turn.plan));
    assert.equal(tail.slot.commandState, 'prospective');
    assert.equal(tail.slot.command.operationId, turn.plan.slots[2]!.operationId);
    failed(await f.finalize(turn.plan, 2), 'cancelled');
    assert.equal(
      f.store.database.prepare('SELECT COUNT(*) AS n FROM saved_preference').get()?.n,
      0,
    );
    assert.equal(f.attempts.length, 3);
  } finally {
    await f.close();
  }
});

test('two finalized preference saves continue from the actual first-receipt revision without replaying it', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept([
      { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
      { kind: 'savePreference', type: 'cuisine', explicitValue: 'Thai' },
    ]);
    ready(await f.finalize(turn.plan));
    const first = receipt(await f.execute(turn.plan));
    const frozen = ready(await f.finalize(turn.plan, 1)).slot;
    assert.equal(frozen.command.command.kind, 'savePreference');
    if (frozen.command.command.kind !== 'savePreference') assert.fail();
    assert.equal(frozen.command.command.expectedPreferenceRevision, 1);
    f.faults.statement = 'INSERT INTO saved_preference';
    failed(await f.execute(turn.plan, 1), 'storage_failure');
    f.faults.statement = '';
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    assert.equal(review.state.guards.preferenceRevision, 1);
    assert.deepEqual(review.slot, { ...frozen, commandState: 'frozen' });
    const actual = receipt(await f.store.actions.confirmActionContinuation({ review }));
    assert.deepEqual(receipt(await f.store.actions.confirmActionContinuation({ review })), actual);
    const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId));
    assert.deepEqual(saved?.slotResults[0]?.result, { kind: 'receipt', receipt: first });
    assert.equal(saved?.intent.phase, 'settled');
    assert.equal(
      f.store.database.prepare('SELECT COUNT(*) AS n FROM saved_preference').get()?.n,
      2,
    );
    assert.equal(
      f.store.database
        .prepare("SELECT revision FROM state_revision WHERE collection='preferences'")
        .get()?.revision,
      2,
    );
    assert.equal(f.attempts.length, 3);
  } finally {
    await f.close();
  }
});

test('lost continuation commit acknowledgement reconciles the durable receipt and never executes the command twice', async () => {
  const f = await fixture();
  try {
    const turn = await failedPlan(f);
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    f.faults.commitAck = true;
    const actual = receipt(await f.store.actions.confirmActionContinuation({ review }));
    assert.equal(
      f.store.writer.requiresRecovery(),
      true,
      'actual receipt remains terminal when lost COMMIT acknowledgement poisons cleanup',
    );
    await f.reopen(1);
    const before = f.snapshot();
    assert.deepEqual(receipt(await f.store.actions.confirmActionContinuation({ review })), actual);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.attempts.length, 3);
  } finally {
    await f.close();
  }
});

test('runtime changes in the final observer reject continuation after handler work without committing its effect', async () => {
  for (const change of ['connection', 'date'] as const) {
    const f = await fixture();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      let once = true;
      f.store.writer.setObserver({
        begin: async () => {},
        beforeCommit: async () => {
          if (!once) return;
          once = false;
          if (change === 'connection') f.setGeneration(2);
          else f.changeDate();
        },
        committed: async () => {},
        failed: () => {},
      });
      const result = await f.store.actions.confirmActionContinuation({ review });
      failed(result, 'stale_context');
      assert.equal(f.attempts.length, 3, 'the runtime changes after the handler ran');
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n,
        0,
      );
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM operation_receipt').get()?.n,
        1,
      );
      assert.equal(
        f.store.database.prepare('SELECT cursor FROM assistant_action_plan').get()?.cursor,
        1,
      );
      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId));
      assert.deepEqual(
        saved?.slotResults.find((entry) => entry.slotId === turn.frozen.slotId)?.result,
        result,
      );
      assert.deepEqual(saved?.slotResults[0]?.result, {
        kind: 'receipt',
        receipt: turn.firstReceipt,
      });
    } finally {
      await f.close();
    }
  }
});

test('an admitted uncertain attempt retains its correlated outcome whether its follow-up journal succeeds or is unavailable', async () => {
  for (const journalAvailable of [true, false]) {
    const f = await fixture();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      const earlier = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!.slotResults;
      let once = true;
      f.store.writer.setObserver({
        begin: async () => {},
        beforeCommit: async () => {
          if (!once) return;
          once = false;
          f.faults.independentReceiptRead = true;
          f.faults.receiptRead = !journalAvailable;
          throw new Error('injected post-callback storage failure');
        },
        committed: async () => {},
        failed: () => {},
      });
      const result = await f.store.actions.confirmActionContinuation({ review });
      assert.deepEqual(result, { kind: 'uncertain', operationId: turn.frozen.command.operationId });
      assert.equal(f.attempts.length, 3);
      f.faults.independentReceiptRead = false;
      f.faults.receiptRead = false;
      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
      if (journalAvailable)
        assert.deepEqual(
          saved.slotResults.find((entry) => entry.slotId === turn.frozen.slotId)?.result,
          result,
        );
      else
        assert.deepEqual(
          saved.slotResults,
          earlier,
          'failed persistence must not be described as a durable uncertain journal',
        );
      assert.equal(saved.intent.phase, 'reconciling');
      assert.deepEqual(saved.slotResults[0], earlier[0]);
      assert.equal(
        f.store.database.prepare('SELECT cursor FROM assistant_action_plan').get()?.cursor,
        1,
      );
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n,
        0,
      );
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM operation_receipt').get()?.n,
        1,
      );
      assert.deepEqual(
        ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))?.slots.map(
          (slot) => slot.outcome,
        ),
        ['receipt', 'not_executed'],
      );
      failed(await f.store.actions.confirmActionContinuation({ review }));
      assert.equal(f.attempts.length, 3, 'consumed uncertainty cannot silently redispatch');
      const fresh = reviewValue(await f.review(turn.plan));
      receipt(await f.store.actions.confirmActionContinuation({ review: fresh }));
    } finally {
      f.faults.independentReceiptRead = false;
      f.faults.receiptRead = false;
      await f.close();
    }
  }
});

test('an admitted receipt-write failure with failed rollback remains uncertain despite independent receipt absence', async () => {
  for (const commandFault of [false, true]) {
    const f = await fixture();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      const earlier = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!.slotResults;
      f.faults.statement = 'INSERT INTO operation_receipt';
      f.faults.statementCommandFault = commandFault;
      f.faults.rollback = true;
      const result = await f.store.actions.confirmActionContinuation({ review });
      assert.equal(
        f.attempts.length,
        3,
        'the plan handler performed its writes before receipt persistence failed',
      );
      const independent = await f.store.reader.transaction(async (session) => ({
        receipt: await readReceiptInSnapshot(
          session,
          turn.frozen.command.operationId,
          catalogueBoundary,
        ),
        occurrences: (
          await session.all<{ n: number }>('SELECT COUNT(*) AS n FROM plan_occurrence')
        )[0]!.n,
      }));
      assert.deepEqual(independent, { receipt: null, occurrences: 0 });
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n,
        1,
        'the failed writer still holds uncommitted work that an independent null cannot resolve',
      );
      assert.deepEqual(result, { kind: 'uncertain', operationId: turn.frozen.command.operationId });
      f.faults.statement = '';
      f.faults.rollback = false;
      await f.reopen(1);
      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
      assert.deepEqual(
        saved.slotResults,
        earlier,
        'unavailable writer cannot persist an invented result',
      );
      assert.equal(saved.intent.phase, 'reconciling');
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n,
        0,
      );
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM operation_receipt').get()?.n,
        1,
      );
    } finally {
      f.faults.statement = '';
      f.faults.rollback = false;
      await f.close();
    }
  }
});

test('missing prefix, catalogue drift and deliberate working-context retirement reject a still-absent continuation target', async () => {
  for (const change of ['prefix', 'catalogue', 'working_context'] as const) {
    const f = await fixture();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      if (change === 'prefix')
        f.store.database
          .prepare('DELETE FROM operation_receipt WHERE operation_id=?')
          .run(turn.firstReceipt.operationId);
      else if (change === 'catalogue')
        f.store.database
          .prepare('UPDATE catalogue_manifest SET fingerprint=? WHERE singleton=1')
          .run('0'.repeat(64));
      else
        ready(
          await f.store.context.setWorkingContext({
            expectedContextRevision: review.state.guards.contextRevision,
            afterSequence: turn.request.message.sourceSequence,
            carryMemoryIds: [],
          }),
        );
      const before = f.snapshot();
      const attempts = f.attempts.length;
      failed(await f.store.actions.confirmActionContinuation({ review }));
      failed(await f.review(turn.plan));
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.attempts.length, attempts);
    } finally {
      await f.close();
    }
  }
});

test('active and deliberately cancelled original plans never acquire a continuation review', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept();
    ready(await f.finalize(turn.plan));
    const readyState = f.snapshot();
    failed(await f.review(turn.plan), 'cancelled');
    assert.deepEqual(f.snapshot(), readyState);
    receipt(await f.execute(turn.plan));
    ready(await f.finalize(turn.plan, 1));
    const dispatched = f.snapshot();
    failed(await f.review(turn.plan), 'cancelled');
    assert.deepEqual(f.snapshot(), dispatched);
    ready(
      await f.store.actions.cancelIntent({
        userIntentId: turn.plan.userIntentId,
        expectedIntentRevision: 0,
      }),
    );
    await f.reopen(1);
    const legacyCancelled = f.snapshot();
    failed(await f.review(turn.plan), 'cancelled');
    assert.deepEqual(f.snapshot(), legacyCancelled);
    assert.equal(f.attempts.length, 1);
  } finally {
    await f.close();
  }
});

test(
  'altered live descriptors cannot execute an absent target and asynchronous caller mutation cannot change owned command bytes',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    const hashing = deferred();
    const release = deferred();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      const before = f.snapshot();
      for (const change of ['token', 'cursor', 'prefix', 'state'] as const) {
        const altered = clone(review);
        if (change === 'token') altered.reviewToken = randomUUID();
        else if (change === 'cursor') altered.cursor++;
        else if (change === 'prefix') altered.prefixReceipts = [];
        else altered.state.guards.preferenceRevision++;
        failed(
          await f.store.actions.confirmActionContinuation({ review: altered }),
          'stale_context',
        );
        assert.deepEqual(f.snapshot(), before);
        assert.equal(f.attempts.length, 2);
      }
      const owned = clone(review);
      f.faults.beforeExecutorHash = async () => {
        hashing.resolve();
        await release.promise;
      };
      const confirming = f.store.actions.confirmActionContinuation({ review: owned });
      await hashing.promise;
      owned.reviewToken = randomUUID();
      if (owned.slot.command.command.kind !== 'addPlan') assert.fail();
      owned.slot.command.command.recipeId = '53064';
      release.resolve();
      const actual = receipt(await confirming);
      assert.equal(actual.payloadFingerprint, turn.frozen.command.payloadFingerprint);
      assert.equal(
        f.store.database.prepare('SELECT recipe_id FROM plan_occurrence').get()?.recipe_id,
        '53150',
      );
      assert.equal(f.attempts.length, 3);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test('a frozen occupied replacement cannot renew its original shopping-scope guard', async () => {
  const f = await fixture();
  try {
    const occurrenceId = randomUUID();
    receipt(
      await f.direct({
        kind: 'addPlan',
        occurrenceId,
        recipeId: '53064',
        placement,
        expectedTarget: { kind: 'empty' },
      }),
    );
    const scopeRevision = f.store.database.prepare('SELECT revision FROM shopping_scope').get()!
      .revision as number;
    const turn = await f.accept(
      [
        {
          kind: 'addPlan',
          recipeId: '53150',
          placement,
          expectedTarget: { kind: 'occupied', occurrenceId, expectedRevision: 1 },
        },
      ],
      [
        {
          occurrenceId,
          expectedRevision: 1,
          expectedShoppingScopeRevision: scopeRevision,
          currentRecipeId: '53064',
          replacementRecipeId: '53150',
          includedInShopping: false,
          placement,
        },
      ],
    );
    const slot = ready(await f.finalize(turn.plan)).slot;
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    assert.deepEqual(review.slot, { ...slot, commandState: 'frozen' });
    assert.equal(review.state.guards.shoppingScopeRevision, scopeRevision);
    const planRevision = f.store.database
      .prepare("SELECT revision FROM state_revision WHERE collection='plan'")
      .get()!.revision;
    f.store.database.exec('UPDATE shopping_scope SET revision=revision+1 WHERE singleton=1');
    const before = f.snapshot();
    const attempts = f.attempts.length;
    failed(await f.store.actions.confirmActionContinuation({ review }), 'stale_context');
    failed(await f.review(turn.plan), 'stale_context');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.attempts.length, attempts);
    assert.equal(
      f.store.database.prepare("SELECT revision FROM state_revision WHERE collection='plan'").get()!
        .revision,
      planRevision,
    );
    assert.equal(
      f.store.database.prepare('SELECT recipe_id FROM plan_occurrence').get()!.recipe_id,
      '53064',
    );
  } finally {
    await f.close();
  }
});

test('corrupt or unavailable target receipt proof never falls through to a handler', async () => {
  for (const fault of ['conflict', 'corrupt', 'unavailable'] as const) {
    const f = await fixture();
    try {
      const turn = await failedPlan(f);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      receipt(await f.store.actions.confirmActionContinuation({ review }));
      if (fault === 'conflict')
        f.store.database
          .prepare('UPDATE operation_receipt SET payload_fingerprint=? WHERE operation_id=?')
          .run('f'.repeat(64), turn.frozen.command.operationId);
      else if (fault === 'corrupt')
        f.store.database
          .prepare('UPDATE operation_receipt SET effects_json=? WHERE operation_id=?')
          .run('{}', turn.frozen.command.operationId);
      else f.faults.receiptRead = true;
      const before = f.snapshot();
      const attempts = f.attempts.length;
      failed(
        await f.store.actions.confirmActionContinuation({ review }),
        fault === 'conflict' ? 'operation_conflict' : 'storage_failure',
      );
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.attempts.length, attempts);
    } finally {
      f.faults.receiptRead = false;
      await f.close();
    }
  }
});
