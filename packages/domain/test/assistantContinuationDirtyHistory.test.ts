import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogueBoundary } from '@cookmate/catalogue';
import { commandFingerprintInput } from '@cookmate/contracts';
import type { CommandResult } from '@cookmate/contracts';
import { readSnapshot } from '../../../apps/mobile/src/data/query';
import { readReceiptInSnapshot } from '../../../apps/mobile/src/data/stateRepositories';
import type { RecoveryImpact, SqlSession, SqlValue } from '../../../apps/mobile/src/data/sql';
import {
  clone,
  failed,
  fixture,
  platform,
  ready,
  receipt,
  reviewValue,
} from './helpers/assistantContinuation';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type CommandState = 'frozen' | 'prospective';

async function commitWithoutAcknowledgement(f: Fixture, commandState: CommandState) {
  const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
  if (commandState === 'frozen') ready(await f.finalize(turn.plan));
  await f.reopen(1);
  const review = reviewValue(await f.review(turn.plan));
  assert.equal(review.slot.commandState, commandState);
  let armed = false;
  const prepare = f.store.connection.prepare;
  f.store.connection.prepare = async (sql) => {
    const statement = await prepare(sql);
    return {
      ...statement,
      run: async (values) => {
        await statement.run(values);
        if (!armed && sql.startsWith('INSERT INTO operation_receipt')) {
          assert.equal(values[0], review.slot.command.operationId);
          armed = true;
          // A has no receipt. Arm only after real B receipt SQL so its actual
          // COMMIT succeeds but both acknowledgement paths initially fail.
          f.faults.commitAck = true;
          f.faults.independentReceiptRead = true;
        }
      },
    };
  };
  const result = await f.store.actions.confirmActionContinuation({ review });
  assert.equal(armed, true);
  assert.deepEqual(result, { kind: 'uncertain', operationId: review.slot.command.operationId });
  assert.equal(f.store.writer.requiresRecovery(), true);
  assert.equal(f.attempts.length, 1);
  assert.equal(
    f.store.database.prepare('SELECT revision FROM favourite WHERE recipe_id=?').get('53064')
      ?.revision,
    1,
  );
  assert.equal(
    f.store.database
      .prepare('SELECT cursor FROM assistant_action_plan WHERE user_intent_id=?')
      .get(turn.plan.userIntentId)?.cursor,
    1,
  );

  f.faults.independentReceiptRead = false;
  const actual = ready(
    await readSnapshot(f.store.reader, (session) =>
      readReceiptInSnapshot(session, review.slot.command.operationId, catalogueBoundary),
    ),
  );
  assert.ok(actual, 'an independent connection proves the actual committed receipt');
  assert.equal(actual.operationId, review.slot.command.operationId);
  assert.equal(actual.payloadFingerprint, review.slot.command.payloadFingerprint);
  assert.equal(actual.outcome, 'committed');
  const committedRevision = f.store.database
    .prepare("SELECT revision FROM state_revision WHERE collection='store'")
    .get()!.revision as number;
  return { turn, review, actual, committedRevision };
}

/** Observe real calls without replacing transaction bodies, SQL results or receipts. */
function observeReplay(f: Fixture) {
  const calls = {
    writerTransactions: 0,
    writerExec: 0,
    writerQueries: 0,
    writerPrepares: 0,
    writerRuns: 0,
    independentReceiptReads: 0,
  };
  const transaction = f.store.writer.transaction.bind(f.store.writer);
  f.store.writer.transaction = <Value>(
    work: (session: SqlSession) => Promise<Value>,
    impact?: RecoveryImpact,
    admission?: () => undefined,
  ) => {
    calls.writerTransactions++;
    return transaction<Value>(work, impact, admission);
  };
  const exec = f.store.connection.exec;
  f.store.connection.exec = async (sql) => {
    calls.writerExec++;
    return exec(sql);
  };
  const all = f.store.connection.all;
  f.store.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    calls.writerQueries++;
    return all<Row>(sql, values);
  };
  const prepare = f.store.connection.prepare;
  f.store.connection.prepare = async (sql) => {
    calls.writerPrepares++;
    const statement = await prepare(sql);
    return {
      ...statement,
      run: async (values) => {
        calls.writerRuns++;
        return statement.run(values);
      },
    };
  };
  const read = f.store.reader.transaction.bind(f.store.reader);
  f.store.reader.transaction = <Value>(
    work: (session: SqlSession) => Promise<Value>,
    impact?: RecoveryImpact,
    admission?: () => undefined,
  ) =>
    read<Value>(
      async (session) =>
        work({
          ...session,
          all: async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
            if (sql.includes('FROM operation_receipt')) calls.independentReceiptReads++;
            return session.all<Row>(sql, values);
          },
        }),
      impact,
      admission,
    );
  return calls;
}

function assertNoWriterSql(calls: ReturnType<typeof observeReplay>) {
  assert.equal(calls.writerExec, 0);
  assert.equal(calls.writerQueries, 0);
  assert.equal(calls.writerPrepares, 0);
  assert.equal(calls.writerRuns, 0);
}

function assertNoReceipt(result: CommandResult, operationId: string) {
  assert.notEqual(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind === 'receipt') assert.fail();
  assert.equal(result.operationId, operationId);
}

for (const commandState of ['frozen', 'prospective'] as const) {
  test(`TAIL-DATA-01 ${commandState}: a dirty writer acknowledges the real B receipt and delivers its pending notification once`, async () => {
    const f = await fixture();
    try {
      const { review, actual, committedRevision } = await commitWithoutAcknowledgement(
        f,
        commandState,
      );
      const before = f.snapshot();
      const events = f.events.length;
      const calls = observeReplay(f);

      assert.deepEqual(
        receipt(await f.store.actions.confirmActionContinuation({ review })),
        actual,
      );
      assert.equal(
        calls.writerTransactions,
        0,
        'historical acknowledgement must bypass the dirty writer',
      );
      assertNoWriterSql(calls);
      assert.ok(calls.independentReceiptReads > 0);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.attempts.length, 1);
      assert.equal(f.store.writer.requiresRecovery(), true);
      assert.equal(
        f.events.length,
        events + 1,
        'B was durable but its commit notification was still pending',
      );
      assert.equal(f.events.at(-1)?.revision, committedRevision);
      assert.ok(f.events.at(-1)?.collections.includes('favourites'));

      f.store.actions.invalidateActionContinuationReview();
      f.setGeneration(90);
      f.changeDate();
      const historical = clone(review);
      historical.reviewToken = randomUUID();
      historical.slot.slotId = randomUUID();
      historical.slot.commandState = commandState === 'frozen' ? 'prospective' : 'frozen';
      historical.cursor = 0;
      historical.prefixReceipts = [];
      historical.state.guards.connectionGeneration = 80;
      // Stale ancillary metadata is not command authority in the receipt-only branch.
      historical.catalogue.version = 'historical-review';
      historical.catalogue.fingerprint = 'a'.repeat(64);
      for (let retry = 0; retry < 2; retry++) {
        assert.deepEqual(
          receipt(await f.store.actions.confirmActionContinuation({ review: historical })),
          actual,
        );
        assert.equal(
          f.events.length,
          events + 1,
          'the same committed notification is never delivered twice',
        );
      }
      assert.equal(calls.writerTransactions, 0);
      assertNoWriterSql(calls);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.attempts.length, 1);
      assert.equal(
        f.store.writer.requiresRecovery(),
        true,
        'receipt proof does not rehabilitate writer cleanup',
      );
    } finally {
      f.faults.independentReceiptRead = false;
      await f.close();
    }
  });

  for (const fault of ['missing', 'conflicting', 'corrupt', 'unreadable'] as const) {
    test(`TAIL-DATA-01 ${commandState}: ${fault} target evidence cannot dispatch or repair a dirty writer`, async () => {
      const f = await fixture();
      try {
        const { review } = await commitWithoutAcknowledgement(f, commandState);
        const operationId = review.slot.command.operationId;
        if (fault === 'missing') {
          f.store.database
            .prepare('DELETE FROM operation_receipt WHERE operation_id=?')
            .run(operationId);
        } else if (fault === 'conflicting') {
          f.store.database
            .prepare('UPDATE operation_receipt SET payload_fingerprint=? WHERE operation_id=?')
            .run('f'.repeat(64), operationId);
        } else if (fault === 'corrupt') {
          f.store.database
            .prepare('UPDATE operation_receipt SET effects_json=? WHERE operation_id=?')
            .run('{}', operationId);
        } else {
          f.faults.independentReceiptRead = true;
        }
        const before = f.snapshot();
        const events = f.events.length;
        const calls = observeReplay(f);
        const result = await f.store.actions.confirmActionContinuation({ review });
        assertNoReceipt(result, operationId);
        if (fault === 'conflicting') failed(result, 'operation_conflict');
        if (fault === 'corrupt') failed(result, 'storage_failure');
        assertNoWriterSql(calls);
        assert.deepEqual(f.snapshot(), before);
        assert.equal(f.attempts.length, 1);
        assert.equal(
          f.events.length,
          events,
          'unproven evidence cannot announce the pending commit',
        );
        assert.equal(f.store.writer.requiresRecovery(), true);

        f.store.actions.invalidateActionContinuationReview();
        assertNoReceipt(await f.store.actions.confirmActionContinuation({ review }), operationId);
        assertNoWriterSql(calls);
        assert.deepEqual(f.snapshot(), before);
        assert.equal(f.attempts.length, 1);
        assert.equal(f.events.length, events);
        assert.equal(f.store.writer.requiresRecovery(), true);
      } finally {
        f.faults.independentReceiptRead = false;
        await f.close();
      }
    });
  }

  test(`TAIL-DATA-01 ${commandState}: copied shape, size, fingerprint and catalogue command checks precede historical lookup`, async () => {
    const f = await fixture();
    try {
      const { review, actual } = await commitWithoutAcknowledgement(f, commandState);
      const before = f.snapshot();
      const events = f.events.length;
      const calls = observeReplay(f);
      for (const invalid of [
        'shape',
        'size',
        'fingerprint',
        'catalogue_shape',
        'catalogue_recipe',
      ] as const) {
        const changed = clone(review);
        if (invalid === 'shape') Object.assign(changed.slot.command, { unexpected: true });
        else if (invalid === 'size') changed.reviewToken = 'x'.repeat(131073);
        else if (invalid === 'fingerprint')
          changed.slot.command.payloadFingerprint = 'f'.repeat(64);
        else if (invalid === 'catalogue_shape') changed.catalogue.fingerprint = 'not-a-fingerprint';
        else {
          assert.equal(changed.slot.command.command.kind, 'setFavourite');
          if (changed.slot.command.command.kind !== 'setFavourite') assert.fail();
          changed.slot.command.command.recipeId = '99999';
          assert.equal(catalogueBoundary.recipeIds.has('99999'), false);
          const { payloadFingerprint: _oldFingerprint, ...unsigned } = changed.slot.command;
          changed.slot.command.payloadFingerprint = await platform.sha256(
            commandFingerprintInput(unsigned),
          );
        }
        const lookupCount = calls.independentReceiptReads;
        failed(await f.store.actions.confirmActionContinuation({ review: changed }));
        assert.equal(
          calls.independentReceiptReads,
          lookupCount,
          `${invalid} must not reach historical evidence`,
        );
        assert.equal(calls.writerTransactions, 0);
        assertNoWriterSql(calls);
        assert.deepEqual(f.snapshot(), before);
        assert.equal(f.attempts.length, 1);
        assert.equal(f.events.length, events);
        assert.equal(f.store.writer.requiresRecovery(), true);
      }
      assert.deepEqual(
        receipt(await f.store.actions.confirmActionContinuation({ review })),
        actual,
      );
      assert.equal(calls.writerTransactions, 0);
      assertNoWriterSql(calls);
      assert.equal(
        f.events.length,
        events + 1,
        'rejected copies neither consume nor fabricate the pending notification',
      );
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.store.writer.requiresRecovery(), true);
    } finally {
      f.faults.independentReceiptRead = false;
      await f.close();
    }
  });
}
