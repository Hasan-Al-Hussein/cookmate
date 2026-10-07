import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CommandResult, OperationReceipt, ProposalResponse } from '@cookmate/contracts';
import type { RecoveryImpact, SqlSession, SqlValue } from '../../../apps/mobile/src/data/sql';
import {
  clone,
  deferred,
  failed,
  fixture,
  placement,
  ready,
  receipt,
  reviewValue,
  saveAndPlan,
} from './helpers/assistantContinuation';

type Fixture = Awaited<ReturnType<typeof fixture>>;

function revision(f: Fixture, collection: string): number {
  return f.store.database
    .prepare('SELECT revision FROM state_revision WHERE collection=?')
    .get(collection)!.revision as number;
}

function frozenCommand(f: Fixture, operationId: string): string | undefined {
  return f.store.database
    .prepare('SELECT command_json FROM command_slot WHERE operation_id=?')
    .get(operationId)?.command_json as string | undefined;
}

function hasReceipt(f: Fixture, operationId: string): boolean {
  return !!f.store.database
    .prepare('SELECT operation_id FROM operation_receipt WHERE operation_id=?')
    .get(operationId);
}

function cursor(f: Fixture, id: string): number {
  return f.store.database
    .prepare('SELECT cursor FROM assistant_action_plan WHERE user_intent_id=?')
    .get(id)!.cursor as number;
}

function noReceipt(result: CommandResult, operationId: string) {
  assert.notEqual(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind === 'receipt') assert.fail();
  assert.equal(result.operationId, operationId);
}

const preferencesAndFavourite: ProposalResponse['proposals'] = [
  { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
  { kind: 'savePreference', type: 'cuisine', explicitValue: 'Thai' },
  { kind: 'saveRecipe', recipeId: '53064' },
];

test('prospective reviews stay pure and three original reservations use actual no-op preference revisions', async () => {
  const f = await fixture();
  try {
    const existingPreferenceId = randomUUID();
    receipt(
      await f.direct({
        kind: 'savePreference',
        preferenceId: existingPreferenceId,
        type: 'cuisine',
        explicitValue: 'Italian',
        expectedPreferenceRevision: 0,
      }),
    );
    const turn = await f.accept(clone(preferencesAndFavourite));
    const originalPlan = JSON.stringify(turn.plan);
    await f.reopen(1);
    const initial = f.snapshot();
    const superseded = reviewValue(await f.review(turn.plan));
    const first = reviewValue(await f.review(turn.plan));
    assert.equal(first.slot.commandState, 'prospective');
    assert.notEqual(first.reviewToken, superseded.reviewToken);
    assert.deepEqual(first.slot.command, superseded.slot.command);
    assert.deepEqual(f.snapshot(), initial);
    failed(await f.store.actions.confirmActionContinuation({ review: superseded }));
    assert.deepEqual(f.snapshot(), initial);

    const receipts: OperationReceipt[] = [];
    for (let index = 0; index < turn.plan.slots.length; index++) {
      const beforeReview = f.snapshot();
      const review = index === 0 ? first : reviewValue(await f.review(turn.plan));
      assert.deepEqual(f.snapshot(), beforeReview);
      assert.equal(review.slot.commandState, 'prospective');
      assert.equal(review.cursor, index);
      assert.equal(review.slot.slotId, turn.plan.slots[index]!.slotId);
      assert.equal(review.slot.command.operationId, turn.plan.slots[index]!.operationId);
      assert.equal(review.prefixReceipts.length, index);
      assert.equal(frozenCommand(f, review.slot.command.operationId), undefined);
      if (index < 2) {
        assert.equal(review.slot.command.command.kind, 'savePreference');
        if (review.slot.command.command.kind !== 'savePreference') assert.fail();
        assert.equal(review.slot.command.command.expectedPreferenceRevision, 1);
      }
      const actual = receipt(await f.store.actions.confirmActionContinuation({ review }));
      receipts.push(actual);
      assert.equal(actual.outcome, index === 0 ? 'no_op' : 'committed');
      assert.equal(actual.operationId, turn.plan.slots[index]!.operationId);
      assert.equal(actual.payloadFingerprint, review.slot.command.payloadFingerprint);
      assert.deepEqual(JSON.parse(frozenCommand(f, actual.operationId)!), review.slot.command);
      assert.equal(cursor(f, turn.plan.userIntentId), index + 1);
      assert.equal(revision(f, 'preferences'), index === 0 ? 1 : 2);
      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
      assert.equal(saved.intent.phase, index === 2 ? 'settled' : 'reconciling');
      assert.equal(JSON.stringify(saved.actionPlan), originalPlan);
      const afterCommit = f.snapshot();
      assert.deepEqual(
        receipt(await f.store.actions.confirmActionContinuation({ review })),
        actual,
      );
      assert.deepEqual(f.snapshot(), afterCommit, 'historical replay writes nothing');
    }
    const proof = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
    assert.deepEqual(
      proof.slots.map((slot) => slot.receipt),
      receipts,
    );
    assert.ok(proof.slots.every((slot) => slot.outcome === 'receipt'));
    assert.equal(
      f.store.database.prepare('SELECT COUNT(*) AS n FROM saved_preference').get()?.n,
      2,
    );
    assert.equal(f.store.database.prepare('SELECT COUNT(*) AS n FROM favourite').get()?.n, 1);
    assert.deepEqual(
      f.attempts
        .filter((attempt) =>
          turn.plan.slots.some((slot) => slot.operationId === attempt.operationId),
        )
        .map((attempt) => attempt.operationId),
      turn.plan.slots.map((slot) => slot.operationId),
    );
    assert.equal(
      f.store.database
        .prepare('SELECT preference_id FROM saved_preference WHERE value=?')
        .get(JSON.stringify('Italian'))?.preference_id,
      existingPreferenceId,
    );
    const duplicateLink = f.store.database
      .prepare(
        'SELECT preference_id,saved_revision FROM source_preference_link WHERE save_operation_id=?',
      )
      .get(turn.plan.slots[0]!.operationId);
    assert.equal(duplicateLink?.preference_id, existingPreferenceId);
    assert.equal(duplicateLink?.saved_revision, 1);
  } finally {
    await f.close();
  }
});

test('a foreign preference edit rejects a prospective command without freezing or rebasing it', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept(clone(preferencesAndFavourite));
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    receipt(
      await f.direct({
        kind: 'savePreference',
        preferenceId: randomUUID(),
        type: 'cuisine',
        explicitValue: 'Greek',
        expectedPreferenceRevision: 0,
      }),
    );
    const before = f.snapshot();
    const attempts = f.attempts.length;
    failed(await f.store.actions.confirmActionContinuation({ review }));
    failed(await f.review(turn.plan));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.attempts.length, attempts);
    assert.equal(frozenCommand(f, review.slot.command.operationId), undefined);
    assert.equal(hasReceipt(f, review.slot.command.operationId), false);
  } finally {
    await f.close();
  }
});

test(
  'prospective A final observer revocation rolls back only finalization and permits a fresh review',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
      await f.reopen(1);
      const review = reviewValue(await f.review(turn.plan));
      const before = f.snapshot();
      let revoked = false;
      f.store.writer.setObserver({
        begin: async () => {},
        beforeCommit: async (session) => {
          if (revoked) return;
          const rows = await session.all('SELECT 1 FROM command_slot WHERE operation_id=?', [
            review.slot.command.operationId,
          ]);
          if (!rows.length) return;
          revoked = true;
          f.store.actions.invalidateActionContinuationReview();
        },
        committed: async () => {},
        failed: () => {},
      });
      failed(await f.store.actions.confirmActionContinuation({ review }), 'cancelled');
      assert.equal(revoked, true, 'revocation runs after A has inserted the candidate');
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.attempts.length, 0);
      const fresh = reviewValue(await f.review(turn.plan));
      assert.equal(fresh.slot.commandState, 'prospective');
      assert.deepEqual(fresh.slot.command, review.slot.command);
      receipt(await f.store.actions.confirmActionContinuation({ review: fresh }));
      assert.equal(f.attempts.length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'dismissal or deliberate cancellation in the clean A-to-B gap cannot dispatch the frozen command',
  { timeout: 20000 },
  async () => {
    for (const change of ['dismiss', 'cancel'] as const) {
      const f = await fixture();
      const reached = deferred();
      const release = deferred();
      let confirming: Promise<CommandResult> | undefined;
      try {
        const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
        await f.reopen(1);
        const review = reviewValue(await f.review(turn.plan));
        const storeRevision = revision(f, 'store');
        const conversationRevision = revision(f, 'conversation');
        f.faults.beforeExecutorHash = async () => {
          if (!frozenCommand(f, review.slot.command.operationId)) return;
          reached.resolve();
          await release.promise;
        };
        confirming = f.store.actions.confirmActionContinuation({ review });
        await reached.promise;
        assert.equal(revision(f, 'store'), storeRevision + 1);
        assert.equal(revision(f, 'conversation'), conversationRevision);
        assert.equal(cursor(f, turn.plan.userIntentId), 0);
        assert.equal(hasReceipt(f, review.slot.command.operationId), false);
        assert.deepEqual(
          JSON.parse(frozenCommand(f, review.slot.command.operationId)!),
          review.slot.command,
        );
        if (change === 'dismiss') f.store.actions.invalidateActionContinuationReview();
        else
          ready(
            await f.store.actions.cancelIntent({
              userIntentId: turn.plan.userIntentId,
              expectedIntentRevision: 0,
            }),
          );
        release.resolve();
        noReceipt(await confirming, review.slot.command.operationId);
        assert.equal(f.attempts.length, 0);
        assert.equal(hasReceipt(f, review.slot.command.operationId), false);
        assert.equal(cursor(f, turn.plan.userIntentId), 0);
        assert.deepEqual(
          JSON.parse(frozenCommand(f, review.slot.command.operationId)!),
          review.slot.command,
        );
        if (change === 'cancel') failed(await f.review(turn.plan));
        else {
          const fresh = reviewValue(await f.review(turn.plan));
          assert.equal(fresh.slot.commandState, 'frozen');
          assert.deepEqual(fresh.slot.command, review.slot.command);
          receipt(await f.store.actions.confirmActionContinuation({ review: fresh }));
          assert.equal(f.attempts.length, 1);
        }
      } finally {
        release.resolve();
        await confirming?.catch(() => {});
        await f.close();
      }
    }
  },
);

test(
  'uncertain A acknowledgement or cleanup never enters B and reopen proves the actual frozen state',
  { timeout: 20000 },
  async () => {
    for (const fault of ['commit_ack', 'rollback'] as const) {
      const f = await fixture();
      try {
        const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
        await f.reopen(1);
        const review = reviewValue(await f.review(turn.plan));
        let armed = false;
        if (fault === 'commit_ack') {
          const prepare = f.store.connection.prepare;
          f.store.connection.prepare = async (sql) => {
            const statement = await prepare(sql);
            return {
              ...statement,
              run: async (values) => {
                await statement.run(values);
                if (sql.startsWith('INSERT INTO command_slot') && !armed) {
                  armed = true;
                  f.faults.commitAck = true;
                }
              },
            };
          };
        } else {
          f.store.writer.setObserver({
            begin: async () => {},
            beforeCommit: async (session) => {
              if (armed) return;
              const rows = await session.all('SELECT 1 FROM command_slot WHERE operation_id=?', [
                review.slot.command.operationId,
              ]);
              if (!rows.length) return;
              armed = true;
              f.faults.rollback = true;
              throw new Error('A final observer failed before COMMIT');
            },
            committed: async () => {},
            failed: () => {},
          });
        }
        const result = await f.store.actions.confirmActionContinuation({ review });
        noReceipt(result, review.slot.command.operationId);
        assert.equal(armed, true);
        assert.equal(f.store.writer.requiresRecovery(), true);
        assert.equal(f.attempts.length, 0);
        failed(await f.store.actions.reconcileActionRecovery(turn.plan.userIntentId));
        assert.equal(f.attempts.length, 0);
        f.faults.rollback = false;
        await f.reopen(1);
        assert.equal(hasReceipt(f, review.slot.command.operationId), false);
        assert.equal(cursor(f, turn.plan.userIntentId), 0);
        const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
        assert.equal(saved.slotResults.length, 0);
        assert.equal(saved.intent.slots.length, fault === 'commit_ack' ? 1 : 0);
        const fresh = reviewValue(await f.review(turn.plan));
        assert.equal(fresh.slot.commandState, fault === 'commit_ack' ? 'frozen' : 'prospective');
        assert.deepEqual(fresh.slot.command, review.slot.command);
        receipt(await f.store.actions.confirmActionContinuation({ review: fresh }));
        assert.equal(f.attempts.length, 1);
      } finally {
        f.faults.rollback = false;
        await f.close();
      }
    }
  },
);

test('B failure after prospective A retains exact frozen bytes and its actual result for one explicit retry', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept([
      {
        kind: 'addPlan',
        recipeId: '53150',
        placement,
        expectedTarget: { kind: 'empty' },
      },
    ]);
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    f.faults.statement = 'INSERT INTO plan_occurrence';
    const result = await f.store.actions.confirmActionContinuation({ review });
    failed(result, 'storage_failure');
    f.faults.statement = '';
    const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
    assert.equal(saved.intent.phase, 'reconciling');
    assert.deepEqual(saved.intent.slots, [
      { slotId: review.slot.slotId, command: review.slot.command },
    ]);
    assert.deepEqual(saved.slotResults, [{ slotId: review.slot.slotId, result }]);
    assert.equal(cursor(f, turn.plan.userIntentId), 0);
    assert.equal(hasReceipt(f, review.slot.command.operationId), false);
    const fresh = reviewValue(await f.review(turn.plan));
    assert.equal(fresh.slot.commandState, 'frozen');
    assert.deepEqual(fresh.slot.command, review.slot.command);
    const actual = receipt(await f.store.actions.confirmActionContinuation({ review: fresh }));
    assert.deepEqual(receipt(await f.store.actions.confirmActionContinuation({ review })), actual);
    assert.equal(f.attempts.length, 2);
    assert.equal(f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n, 1);
  } finally {
    await f.close();
  }
});

test('ordinary wrapper and exposed executor failures retire only the actual frozen cursor in the same lifetime', async () => {
  for (const route of ['wrapper', 'executor'] as const) {
    const f = await fixture();
    try {
      const turn = await f.accept(clone(saveAndPlan));
      ready(await f.finalize(turn.plan));
      const prefix = receipt(await f.execute(turn.plan));
      const frozen = ready(await f.finalize(turn.plan, 1)).slot;
      if (route === 'executor') {
        const bad = clone(frozen.command);
        bad.payloadFingerprint = 'f'.repeat(64);
        const beforeBad = f.snapshot();
        failed(await f.store.executor.execute(bad));
        assert.deepEqual(f.snapshot(), beforeBad, 'arbitrary invalid input retires no authority');
      }
      const conversationRevision = revision(f, 'conversation');
      f.faults.statement = 'INSERT INTO plan_occurrence';
      const result =
        route === 'wrapper'
          ? await f.execute(turn.plan, 1)
          : await f.store.executor.execute(frozen.command);
      failed(result, 'storage_failure');
      f.faults.statement = '';
      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
      assert.equal(saved.intent.phase, 'reconciling');
      assert.equal(
        f.store.database
          .prepare('SELECT lifecycle FROM assistant_intent_context WHERE user_intent_id=?')
          .get(turn.plan.userIntentId)?.lifecycle,
        'accepted',
      );
      assert.equal(revision(f, 'conversation'), conversationRevision);
      assert.deepEqual(saved.intent.slots[1], frozen);
      assert.deepEqual(saved.slotResults, [
        { slotId: turn.plan.slots[0]!.slotId, result: { kind: 'receipt', receipt: prefix } },
        { slotId: frozen.slotId, result },
      ]);
      assert.equal(cursor(f, turn.plan.userIntentId), 1);
      assert.equal(hasReceipt(f, frozen.command.operationId), false);
      const attempts = f.attempts.length;
      failed(await f.store.executor.execute(frozen.command), 'cancelled');
      assert.equal(f.attempts.length, attempts);
      const review = reviewValue(await f.review(turn.plan));
      assert.equal(review.slot.commandState, 'frozen');
      const actual = receipt(await f.store.actions.confirmActionContinuation({ review }));
      assert.deepEqual(receipt(await f.store.executor.execute(frozen.command)), actual);
      assert.equal(
        f.attempts.filter((entry) => entry.operationId === prefix.operationId).length,
        1,
      );
      assert.equal(
        f.attempts.filter((entry) => entry.operationId === actual.operationId).length,
        2,
      );
    } finally {
      await f.close();
    }
  }
});

test('failed ordinary finalization suspends the original reservation without a phantom command or result', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
    const beforeWrongSlot = f.snapshot();
    failed(
      await f.store.actions.finalizeNextIntentSlot({
        ...f.slotInput(turn.plan),
        slotId: randomUUID(),
      }),
    );
    assert.deepEqual(f.snapshot(), beforeWrongSlot, 'an arbitrary slot does not retire the plan');
    const conversationRevision = revision(f, 'conversation');
    const storeRevision = revision(f, 'store');
    f.faults.statement = 'INSERT INTO command_slot';
    failed(await f.finalize(turn.plan), 'storage_failure');
    f.faults.statement = '';
    const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
    assert.equal(saved.intent.phase, 'reconciling');
    assert.equal(
      f.store.database
        .prepare('SELECT lifecycle FROM assistant_intent_context WHERE user_intent_id=?')
        .get(turn.plan.userIntentId)?.lifecycle,
      'accepted',
    );
    assert.deepEqual(saved.intent.slots, []);
    assert.deepEqual(saved.slotResults, []);
    assert.equal(frozenCommand(f, turn.plan.slots[0]!.operationId), undefined);
    assert.equal(hasReceipt(f, turn.plan.slots[0]!.operationId), false);
    assert.equal(revision(f, 'conversation'), conversationRevision);
    assert.equal(revision(f, 'store'), storeRevision + 1);
    assert.equal(f.attempts.length, 0);
    const review = reviewValue(await f.review(turn.plan));
    assert.equal(review.slot.commandState, 'prospective');
    assert.equal(review.slot.command.operationId, turn.plan.slots[0]!.operationId);
    receipt(await f.store.actions.confirmActionContinuation({ review }));
    assert.equal(f.attempts.length, 1);
  } finally {
    await f.close();
  }
});

test('a healthy failed-attempt hold survives pure reads and resolves only through explicit same-lifetime reconciliation', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept(clone(saveAndPlan));
    ready(await f.finalize(turn.plan));
    const prefix = receipt(await f.execute(turn.plan));
    const frozen = ready(await f.finalize(turn.plan, 1)).slot;
    const prepare = f.store.connection.prepare;
    let failedHandler = false;
    f.store.connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        ...statement,
        run: async (values) => {
          try {
            await statement.run(values);
          } catch (error) {
            if (sql.startsWith('INSERT INTO plan_occurrence')) {
              failedHandler = true;
              f.faults.receiptRead = true;
              f.faults.independentReceiptRead = true;
            }
            throw error;
          }
        },
      };
    };
    f.faults.statement = 'INSERT INTO plan_occurrence';
    const result = await f.execute(turn.plan, 1);
    noReceipt(result, frozen.command.operationId);
    failed(result, 'storage_failure');
    if (result.kind !== 'failed') assert.fail();
    assert.equal(
      result.error.messageKey,
      'storage.command_failed',
      'later proof failure preserves the actual executor diagnostic',
    );
    assert.equal(failedHandler, true);
    assert.equal(
      f.store.writer.requiresRecovery(),
      false,
      'clean rollback is distinct from unreadable evidence',
    );
    failed(await f.store.actions.reconcileActionRecovery(turn.plan.userIntentId));
    f.faults.statement = '';
    f.faults.receiptRead = false;
    f.faults.independentReceiptRead = false;

    const beforeReads = f.snapshot();
    const proof = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
    assert.equal(proof.phase, 'dispatched');
    assert.equal(proof.slots[1]!.outcome, 'unresolved');
    failed(await f.review(turn.plan));
    assert.deepEqual(f.snapshot(), beforeReads, 'restored pure reads neither journal nor suspend');
    const attempts = f.attempts.length;
    noReceipt(await f.store.executor.execute(frozen.command), frozen.command.operationId);
    assert.equal(f.attempts.length, attempts, 'ordinary execution cannot bypass the retained hold');
    const resolved = await f.store.actions.reconcileActionRecovery(turn.plan.userIntentId);
    const value = ready(resolved)!;
    assert.equal(value.phase, 'reconciling');
    assert.equal(value.slots[1]!.outcome, 'not_executed');
    assert.deepEqual(value.slots[0]!.receipt, prefix);
    if (resolved.kind !== 'ready') assert.fail();
    assert.equal(resolved.revision, revision(f, 'store'));
    const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
    assert.deepEqual(
      saved.slotResults.find((entry) => entry.slotId === frozen.slotId)?.result,
      result,
    );
    const afterSettlement = f.snapshot();
    const notifications = f.events.length;
    ready(await f.store.actions.reconcileActionRecovery(turn.plan.userIntentId));
    assert.deepEqual(f.snapshot(), afterSettlement);
    assert.equal(f.events.length, notifications);
    const review = reviewValue(await f.review(turn.plan));
    receipt(await f.store.actions.confirmActionContinuation({ review }));
    assert.equal(f.attempts.length, attempts + 1);
  } finally {
    f.faults.receiptRead = false;
    f.faults.independentReceiptRead = false;
    await f.close();
  }
});

test('no-hold reconciliation and existing recovery reads do not retire healthy active reservations', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept(clone(saveAndPlan));
    const before = f.snapshot();
    const events = f.events.length;
    const pure = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
    const explicit = ready(await f.store.actions.reconcileActionRecovery(turn.plan.userIntentId))!;
    assert.deepEqual(explicit, pure);
    assert.equal(explicit.phase, 'ready');
    assert.ok(explicit.slots.every((slot) => slot.outcome === 'unresolved'));
    failed(await f.review(turn.plan));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.events.length, events);
    assert.equal(f.attempts.length, 0);
    ready(await f.finalize(turn.plan));
    receipt(await f.execute(turn.plan));
  } finally {
    await f.close();
  }
});

test('a present corrupt prefix blocks prospective finalization while the target is genuinely absent', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept(clone(saveAndPlan));
    ready(await f.finalize(turn.plan));
    const prefix = receipt(await f.execute(turn.plan));
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    assert.equal(review.slot.commandState, 'prospective');
    f.store.database
      .prepare('UPDATE operation_receipt SET payload_fingerprint=? WHERE operation_id=?')
      .run('f'.repeat(64), prefix.operationId);
    assert.equal(hasReceipt(f, prefix.operationId), true);
    assert.equal(hasReceipt(f, review.slot.command.operationId), false);
    const before = f.snapshot();
    const attempts = f.attempts.length;
    failed(await f.store.actions.confirmActionContinuation({ review }), 'storage_failure');
    failed(await f.review(turn.plan), 'storage_failure');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.attempts.length, attempts);
    assert.equal(frozenCommand(f, review.slot.command.operationId), undefined);
    assert.equal(cursor(f, turn.plan.userIntentId), 1);
  } finally {
    await f.close();
  }
});

test('a prospective descriptor acknowledges its actual receipt before corrupt prefix or cleared authority, but never a corrupt target', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept(clone(saveAndPlan));
    ready(await f.finalize(turn.plan));
    const prefix = receipt(await f.execute(turn.plan));
    await f.reopen(1);
    const review = reviewValue(await f.review(turn.plan));
    assert.equal(review.slot.commandState, 'prospective');
    const actual = receipt(await f.store.actions.confirmActionContinuation({ review }));
    f.store.database
      .prepare('UPDATE operation_receipt SET effects_json=? WHERE operation_id=?')
      .run('{}', prefix.operationId);
    const corruptPrefix = f.snapshot();
    assert.deepEqual(receipt(await f.store.actions.confirmActionContinuation({ review })), actual);
    assert.deepEqual(f.snapshot(), corruptPrefix);
    receipt(
      await f.direct({
        kind: 'clearConversation',
        conversationId: turn.request.conversationId,
        expectedGeneration: turn.request.conversationGeneration,
      }),
    );
    const historical = clone(review);
    historical.reviewToken = randomUUID();
    historical.slot.slotId = randomUUID();
    historical.slot.commandState = 'frozen';
    historical.cursor = 0;
    historical.prefixReceipts = [];
    historical.state.guards.connectionGeneration += 20;
    const cleared = f.snapshot();
    const attempts = f.attempts.length;
    assert.deepEqual(
      receipt(await f.store.actions.confirmActionContinuation({ review: historical })),
      actual,
    );
    assert.deepEqual(f.snapshot(), cleared);
    f.store.database
      .prepare('UPDATE operation_receipt SET effects_json=? WHERE operation_id=?')
      .run('{}', actual.operationId);
    const corruptTarget = f.snapshot();
    failed(
      await f.store.actions.confirmActionContinuation({ review: historical }),
      'storage_failure',
    );
    assert.deepEqual(f.snapshot(), corruptTarget);
    assert.equal(f.attempts.length, attempts);
  } finally {
    await f.close();
  }
});

test(
  'an ordinary command hashing before another failure cannot dispatch after that cursor is suspended',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    const hashing = deferred();
    const releaseHash = deferred();
    let delayed: Promise<CommandResult> | undefined;
    try {
      const turn = await f.accept(clone(saveAndPlan));
      ready(await f.finalize(turn.plan));
      const prefix = receipt(await f.execute(turn.plan));
      const frozen = ready(await f.finalize(turn.plan, 1)).slot;
      let intercepted = false;
      f.faults.beforeExecutorHash = async () => {
        if (intercepted) return;
        intercepted = true;
        hashing.resolve();
        await releaseHash.promise;
      };
      delayed = f.store.executor.execute(frozen.command);
      await hashing.promise;
      assert.equal(f.attempts.length, 1, 'the delayed command has not entered its handler');

      f.faults.statement = 'INSERT INTO plan_occurrence';
      const actualFailure = await f.execute(turn.plan, 1);
      failed(actualFailure, 'storage_failure');
      f.faults.statement = '';
      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
      assert.equal(saved.intent.phase, 'reconciling');
      assert.deepEqual(saved.slotResults[1], { slotId: frozen.slotId, result: actualFailure });
      const suspended = f.snapshot();
      const attempts = f.attempts.length;

      releaseHash.resolve();
      failed(await delayed, 'cancelled');
      assert.deepEqual(f.snapshot(), suspended, 'a late hash cannot recreate ordinary authority');
      assert.equal(f.attempts.length, attempts);
      assert.equal(hasReceipt(f, frozen.command.operationId), false);
      assert.equal(cursor(f, turn.plan.userIntentId), 1);
      const review = reviewValue(await f.review(turn.plan));
      assert.equal(review.slot.commandState, 'frozen');
      const actual = receipt(await f.store.actions.confirmActionContinuation({ review }));
      assert.equal(actual.operationId, frozen.command.operationId);
      assert.equal(
        f.attempts.filter((entry) => entry.operationId === prefix.operationId).length,
        1,
      );
      assert.equal(
        f.attempts.filter((entry) => entry.operationId === actual.operationId).length,
        2,
      );
    } finally {
      releaseHash.resolve();
      await delayed?.catch(() => {});
      await f.close();
    }
  },
);

test(
  'an older suspension cannot clear a newer admitted hold, and explicit retry resolves the already-suspended cursor without a duplicate write',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    const olderReceiptRead = deferred();
    const releaseOlderRead = deferred();
    const newerHandler = deferred();
    const releaseNewerHandler = deferred();
    const olderSettlementQueued = deferred();
    const olderSettlementBeforeCommit = deferred();
    const releaseOlderSettlement = deferred();
    const newerSettlementQueued = deferred();
    let older: Promise<CommandResult> | undefined;
    let newer: Promise<CommandResult> | undefined;
    try {
      const turn = await f.accept(clone(saveAndPlan));
      ready(await f.finalize(turn.plan));
      const prefix = receipt(await f.execute(turn.plan));
      const frozen = ready(await f.finalize(turn.plan, 1)).slot;
      const operationId = frozen.command.operationId;
      const initialRevision = revision(f, 'store');
      const initialConversationRevision = revision(f, 'conversation');
      const initialEvents = f.events.length;
      const schedule: string[] = [];
      let handlerEntries = 0;
      let receiptReadPaused = false;
      let writerCalls = 0;
      let activeWriterCall = 0;
      let newerReachedCommit = false;
      let newerSettlementReadFailed = false;
      let failNewerSettlementRead = true;

      const prepare = f.store.connection.prepare;
      f.store.connection.prepare = async (sql) => {
        const statement = await prepare(sql);
        return {
          ...statement,
          run: async (values) => {
            if (sql.startsWith('INSERT INTO plan_occurrence')) {
              handlerEntries++;
              if (handlerEntries === 1) {
                schedule.push('older-handler-failed');
                throw new Error('older real plan INSERT failed');
              }
              if (handlerEntries === 2) {
                schedule.push('newer-handler-entered');
                newerHandler.resolve();
                await releaseNewerHandler.promise;
              }
            }
            await statement.run(values);
          },
        };
      };

      // Delay a real independent receipt read after the older transaction rolled back.
      // This leaves the older attempt's result unresolved while a second ordinary
      // transaction proves current authority and enters the actual handler.
      const readerTransaction = f.store.reader.transaction.bind(f.store.reader);
      f.store.reader.transaction = <Value>(
        work: (session: SqlSession) => Promise<Value>,
        impact?: RecoveryImpact,
        admission?: () => undefined,
      ) =>
        readerTransaction<Value>(
          async (session) =>
            work({
              ...session,
              all: async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
                if (
                  !receiptReadPaused &&
                  handlerEntries === 1 &&
                  sql.includes('FROM operation_receipt') &&
                  values?.includes(operationId)
                ) {
                  receiptReadPaused = true;
                  schedule.push('older-receipt-read-paused');
                  olderReceiptRead.resolve();
                  await releaseOlderRead.promise;
                }
                return session.all<Row>(sql, values);
              },
            }),
          impact,
          admission,
        );

      // No transaction body or result is replaced. After setup these calls are the
      // two executor transactions followed by their two genuine failure settlements.
      const writerTransaction = f.store.writer.transaction.bind(f.store.writer);
      f.store.writer.transaction = <Value>(
        work: (session: SqlSession) => Promise<Value>,
        impact?: RecoveryImpact,
        admission?: () => undefined,
      ) => {
        const call = ++writerCalls;
        if (call === 3) {
          schedule.push('older-settlement-queued');
          olderSettlementQueued.resolve();
        }
        if (call === 4) {
          schedule.push('newer-settlement-queued');
          newerSettlementQueued.resolve();
        }
        return writerTransaction<Value>(
          async (session) => {
            activeWriterCall = call;
            return work(session);
          },
          impact,
          admission,
        );
      };

      const all = f.store.connection.all;
      f.store.connection.all = async <Row extends object>(
        sql: string,
        values?: readonly SqlValue[],
      ) => {
        if (
          activeWriterCall === 4 &&
          failNewerSettlementRead &&
          sql.includes('FROM operation_receipt') &&
          values?.includes(operationId)
        ) {
          newerSettlementReadFailed = true;
          schedule.push('newer-settlement-evidence-failed');
          throw new Error('newer held attempt evidence temporarily unavailable');
        }
        return all<Row>(sql, values);
      };
      f.store.writer.setObserver({
        begin: async () => {},
        beforeCommit: async (session) => {
          if (activeWriterCall === 2) {
            newerReachedCommit = true;
            schedule.push('newer-before-final-admission');
            const rows = await session.all('SELECT 1 FROM operation_receipt WHERE operation_id=?', [
              operationId,
            ]);
            assert.equal(
              rows.length,
              1,
              'the newer real handler and receipt work occurred before the final guard',
            );
          }
          if (activeWriterCall === 3) {
            schedule.push('older-suspension-before-commit');
            olderSettlementBeforeCommit.resolve();
            await releaseOlderSettlement.promise;
          }
        },
        committed: async () => {},
        failed: () => {},
      });

      older = f.store.executor.execute(frozen.command);
      await olderReceiptRead.promise;
      newer = f.store.executor.execute(frozen.command);
      await newerHandler.promise;
      assert.equal(handlerEntries, 2, 'both ordinary attempts were genuinely admitted');
      releaseOlderRead.resolve();
      await olderSettlementQueued.promise;
      releaseNewerHandler.resolve();
      await olderSettlementBeforeCommit.promise;
      await newerSettlementQueued.promise;
      releaseOlderSettlement.resolve();

      const olderResult = await older;
      const newerResult = await newer;
      failed(olderResult, 'storage_failure');
      failed(newerResult, 'stale_context');
      if (newerResult.kind !== 'failed') assert.fail();
      assert.equal(newerResult.error.messageKey, 'assistant.reconciliation_required');
      assert.equal(newerReachedCommit, true);
      assert.equal(newerSettlementReadFailed, true);
      assert.equal(f.store.writer.requiresRecovery(), false);
      assert.equal(hasReceipt(f, operationId), false);
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n,
        0,
      );
      assert.equal(cursor(f, turn.plan.userIntentId), 1);
      assert.equal(
        revision(f, 'store'),
        initialRevision + 1,
        'only the older suspension committed',
      );
      assert.equal(revision(f, 'conversation'), initialConversationRevision);
      assert.equal(f.events.length, initialEvents + 1);
      assert.ok(
        schedule.indexOf('older-settlement-queued') <
          schedule.indexOf('newer-before-final-admission'),
      );
      assert.ok(
        schedule.indexOf('newer-settlement-queued') <
          schedule.indexOf('newer-settlement-evidence-failed'),
      );

      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
      assert.equal(saved.intent.phase, 'reconciling');
      assert.deepEqual(saved.slotResults[0], {
        slotId: turn.plan.slots[0]!.slotId,
        result: { kind: 'receipt', receipt: prefix },
      });
      assert.deepEqual(saved.slotResults[1], { slotId: frozen.slotId, result: olderResult });
      const suspended = f.snapshot();
      const proof = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
      assert.equal(proof.slots[1]!.outcome, 'not_executed');
      failed(await f.review(turn.plan), 'stale_context');
      assert.deepEqual(
        f.snapshot(),
        suspended,
        'older settlement and pure proof cannot release the newer hold',
      );

      failNewerSettlementRead = false;
      const eventsBeforeRetry = f.events.length;
      const reconciled = ready(
        await f.store.actions.reconcileActionRecovery(turn.plan.userIntentId),
      )!;
      assert.equal(reconciled.phase, 'reconciling');
      assert.equal(reconciled.slots[1]!.outcome, 'not_executed');
      assert.deepEqual(
        f.snapshot(),
        suspended,
        'resolving an already-suspended cursor changes no durable history or revision',
      );
      assert.equal(f.events.length, eventsBeforeRetry);
      const review = reviewValue(await f.review(turn.plan));
      assert.equal(review.slot.commandState, 'frozen');
      assert.deepEqual(review.slot.command, frozen.command);
      receipt(await f.store.actions.confirmActionContinuation({ review }));
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS n FROM plan_occurrence').get()?.n,
        1,
      );
      assert.equal(f.attempts.filter((entry) => entry.operationId === operationId).length, 3);
      assert.equal(
        f.attempts.filter((entry) => entry.operationId === prefix.operationId).length,
        1,
      );
    } finally {
      releaseOlderRead.resolve();
      releaseNewerHandler.resolve();
      releaseOlderSettlement.resolve();
      await Promise.allSettled(
        [older, newer].filter((pending): pending is Promise<CommandResult> => !!pending),
      );
      await f.close();
    }
  },
);
