import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogueBoundary } from '@cookmate/catalogue';
import type { CommandResult } from '@cookmate/contracts';
import { readSnapshot } from '../../../apps/mobile/src/data/query';
import { readReceiptInSnapshot } from '../../../apps/mobile/src/data/stateRepositories';
import type { RecoveryImpact, SqlSession, SqlValue } from '../../../apps/mobile/src/data/sql';
import { deferred, fixture, ready, receipt, reviewValue } from './helpers/assistantContinuation';

for (const commandState of ['frozen', 'prospective'] as const) {
  for (const evidence of ['matching', 'unreadable', 'missing', 'conflicting', 'corrupt'] as const) {
    test(
      `TAIL-DATA-02 ${commandState}: queued historical confirmation after rollback cleanup failure keeps ${evidence} evidence terminal`,
      { timeout: 20000 },
      async () => {
        const f = await fixture();
        const holding = deferred();
        const releaseHeldJob = deferred();
        const confirmationQueued = deferred();
        let heldOutcome: Promise<unknown> | undefined;
        let confirmation: Promise<CommandResult> | undefined;
        try {
          const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
          if (commandState === 'frozen') ready(await f.finalize(turn.plan));
          await f.reopen(1);
          const review = reviewValue(await f.review(turn.plan));
          assert.equal(review.slot.commandState, commandState);
          const committed = receipt(await f.store.actions.confirmActionContinuation({ review }));
          const actual = ready(
            await readSnapshot(f.store.reader, (session) =>
              readReceiptInSnapshot(session, committed.operationId, catalogueBoundary),
            ),
          );
          assert.deepEqual(
            actual,
            committed,
            'the first confirmation produced a real durable receipt',
          );
          assert.equal(f.store.writer.requiresRecovery(), false);
          assert.equal(f.attempts.length, 1);
          const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
          assert.equal(saved.intent.phase, 'settled');
          assert.deepEqual(saved.slotResults, [
            {
              slotId: turn.plan.slots[0]!.slotId,
              result: { kind: 'receipt', receipt: committed },
            },
          ]);
          if (evidence === 'missing') {
            f.store.database
              .prepare('DELETE FROM operation_receipt WHERE operation_id=?')
              .run(committed.operationId);
          } else if (evidence === 'conflicting') {
            f.store.database
              .prepare('UPDATE operation_receipt SET payload_fingerprint=? WHERE operation_id=?')
              .run('f'.repeat(64), committed.operationId);
          } else if (evidence === 'corrupt') {
            f.store.database
              .prepare('UPDATE operation_receipt SET effects_json=? WHERE operation_id=?')
              .run('{}', committed.operationId);
          }
          const before = f.snapshot();
          const events = f.events.length;
          const sabotage = new Error('unrelated held read failed before rollback cleanup');

          // This unrelated job owns an actual BEGIN IMMEDIATE and performs only a read.
          // It cannot alter the command, receipt, journal, cursor or domain state.
          const held = f.store.writer.transaction(
            async (session) => {
              const rows = await session.all(
                'SELECT revision FROM state_revision WHERE collection=?',
                ['store'],
              );
              assert.equal(rows.length, 1);
              holding.resolve();
              await releaseHeldJob.promise;
              throw sabotage;
            },
            { kind: 'read_only' },
          );
          heldOutcome = held.then(
            () => assert.fail('the held job must reject'),
            (error: unknown) => error,
          );
          await holding.promise;

          let writerRegistrations = 0;
          let queuedBodies = 0;
          let healthyAtRegistration = false;
          let writerQueries = 0;
          let writerPrepares = 0;
          let writerRuns = 0;
          const writerExec: string[] = [];
          const transaction = f.store.writer.transaction.bind(f.store.writer);
          f.store.writer.transaction = <Value>(
            work: (session: SqlSession) => Promise<Value>,
            impact?: RecoveryImpact,
            admission?: () => undefined,
          ) => {
            writerRegistrations++;
            healthyAtRegistration = !f.store.writer.requiresRecovery();
            const queued = transaction<Value>(
              async (session) => {
                queuedBodies++;
                return work(session);
              },
              impact,
              admission,
            );
            // The original transaction has now registered with the real queue.
            confirmationQueued.resolve();
            return queued;
          };
          const all = f.store.connection.all;
          f.store.connection.all = async <Row extends object>(
            sql: string,
            values?: readonly SqlValue[],
          ) => {
            writerQueries++;
            return all<Row>(sql, values);
          };
          const prepare = f.store.connection.prepare;
          f.store.connection.prepare = async (sql) => {
            writerPrepares++;
            const statement = await prepare(sql);
            return {
              ...statement,
              run: async (values) => {
                writerRuns++;
                return statement.run(values);
              },
            };
          };
          const exec = f.store.connection.exec;
          f.store.connection.exec = async (sql) => {
            writerExec.push(sql);
            return exec(sql);
          };

          assert.equal(
            f.store.writer.requiresRecovery(),
            false,
            'confirmation begins against a healthy writer',
          );
          confirmation = f.store.actions.confirmActionContinuation({ review });
          await confirmationQueued.promise;
          assert.equal(writerRegistrations, 1);
          assert.equal(healthyAtRegistration, true);
          assert.equal(queuedBodies, 0, 'confirmation is queued behind the unrelated active job');
          assert.equal(f.store.writer.requiresRecovery(), false);

          f.faults.rollback = true;
          f.faults.independentReceiptRead = evidence === 'unreadable';
          releaseHeldJob.resolve();
          assert.equal(await heldOutcome, sabotage);
          const result = await confirmation;
          assert.equal(
            f.store.writer.requiresRecovery(),
            true,
            'real rollback cleanup failed before the queued body ran',
          );
          assert.equal(writerRegistrations, 1);
          assert.equal(
            queuedBodies,
            0,
            'the dirty queue rejects before the historical target SELECT',
          );
          assert.deepEqual(writerExec, ['ROLLBACK'], 'only the unrelated job attempts cleanup SQL');
          assert.equal(writerQueries, 0);
          assert.equal(writerPrepares, 0);
          assert.equal(writerRuns, 0);

          if (evidence === 'matching') {
            assert.deepEqual(receipt(result), actual);
          } else {
            assert.equal(result.kind, 'failed', JSON.stringify(result));
            if (result.kind !== 'failed') assert.fail();
            assert.equal(result.operationId, committed.operationId);
            if (evidence === 'conflicting') {
              assert.equal(result.kind, 'failed');
              if (result.kind !== 'failed') assert.fail();
              assert.equal(result.error.code, 'operation_conflict');
            }
            if (evidence === 'corrupt') {
              assert.equal(result.kind, 'failed');
              if (result.kind !== 'failed') assert.fail();
              assert.equal(result.error.code, 'storage_failure');
            }
          }
          assert.deepEqual(f.snapshot(), before);
          assert.equal(f.attempts.length, 1);
          assert.equal(
            f.events.length,
            events,
            'the original successful commit was already announced exactly once',
          );
          f.faults.independentReceiptRead = false;
          const proof = await readSnapshot(f.store.reader, (session) =>
            readReceiptInSnapshot(session, committed.operationId, catalogueBoundary),
          );
          if (evidence === 'missing') assert.equal(ready(proof), null);
          else if (evidence === 'corrupt') assert.equal(proof.kind, 'failed');
          else if (evidence === 'conflicting')
            assert.equal(ready(proof)?.payloadFingerprint, 'f'.repeat(64));
          else assert.deepEqual(ready(proof), actual);
          assert.equal(
            f.store.writer.requiresRecovery(),
            true,
            'independent receipt proof grants no writer cleanup recovery',
          );
        } finally {
          releaseHeldJob.resolve();
          await Promise.allSettled([heldOutcome, confirmation]);
          f.faults.rollback = false;
          f.faults.independentReceiptRead = false;
          await f.close();
        }
      },
    );
  }
}
