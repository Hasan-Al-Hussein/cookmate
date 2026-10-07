import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunControl, QUIET_PERIOD_MS } from './control';
import type { EvaluationAllowance, EvaluationClock, Journal } from './control';
import { ORDER } from './plan';

const allowance: EvaluationAllowance = {
  maxHttpRequests: 80,
  maxJudgedCases: 16,
  maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 40, 'gemini-3.8-flash': 40 },
  quietPeriodMs: QUIET_PERIOD_MS,
  expiresAt: 86_400_000,
};
function autoClock() {
  return {
    time: 0,
    now() {
      return this.time;
    },
    async sleep(milliseconds: number, signal: AbortSignal) {
      signal.throwIfAborted();
      this.time += milliseconds;
    },
  };
}
function makeControl(journal: Journal = { append: async () => {} }) {
  return new RunControl(journal, allowance, autoClock());
}
function manualClock() {
  let time = 0;
  const timers = new Set<{ at: number; finish(error?: unknown): void }>();
  const clock: EvaluationClock & { advance(milliseconds: number): void } = {
    now: () => time,
    sleep(milliseconds, signal) {
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        const abort = () => timer.finish(signal.reason);
        const timer = {
          at: time + milliseconds,
          finish(error?: unknown) {
            timers.delete(timer);
            signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve();
          },
        };
        timers.add(timer);
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    advance(milliseconds) {
      time += milliseconds;
      for (const timer of [...timers]) if (timer.at <= time) timer.finish();
    },
  };
  return clock;
}

test('initial and per-model quiet envelopes preserve the full turn deadline; allocation never refills', async () => {
  const clock = manualClock();
  const control = new RunControl(
    { append: async () => {} },
    {
      ...allowance,
      maxJudgedCases: 6,
      maxHttpRequests: 30,
      maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 10, 'gemini-3.8-flash': 15 },
    },
    clock,
  );
  const model = 'gemini-3.5-flash-lite';
  let admitted = false;
  let calls = 0;
  const firstPromise = control.start('L01', model).then((turn) => {
    admitted = true;
    return turn;
  });
  clock.advance(64_999);
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(control.attempts.length, 0);
  clock.advance(1);
  const first = await firstPromise;
  assert.equal(first.queueWaitMs, 65_000);
  assert.equal(first.deadline - clock.now(), 45_000);
  const dispatchFive = async (turn: typeof first) => {
    for (const operation of [
      'preflight',
      'generation',
      'generation',
      'preflight',
      'generation',
    ] as const) {
      clock.advance(100);
      await turn.forward(operation, async (attempt) => {
        calls++;
        turn.finish(attempt, true, 'fixture_valid');
      });
    }
    turn.close();
  };
  await dispatchFive(first);
  const other = await control.start('L01', 'gemini-3.8-flash');
  assert.equal(other.queueWaitMs, 0, 'the other model does not inherit this model cooldown');
  other.close();
  admitted = false;
  const secondPromise = control.start('L09', model).then((turn) => {
    admitted = true;
    return turn;
  });
  clock.advance(64_999);
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(calls, 5);
  clock.advance(1);
  const second = await secondPromise;
  assert.equal(second.deadline - clock.now(), 45_000);
  await dispatchFive(second);
  await assert.rejects(control.start('L14', model), /evaluation_allowance_exhausted/);
  clock.advance(2 * 86_400_000);
  await assert.rejects(control.start('L14', model), /evaluation_allowance_exhausted/);
  assert.equal(calls, 10);
  assert.equal(control.attempts.length, 10);
});

test('stop or expiry during admission waits prevents every physical dispatch', async () => {
  for (const reason of ['operator_stop', 'campaign_expired']) {
    const clock = manualClock();
    const control = new RunControl(
      { append: async () => {} },
      { ...allowance, expiresAt: 70_000 },
      clock,
    );
    const waiting = control.start('L01', 'gemini-3.5-flash-lite');
    const rejected = assert.rejects(waiting, new RegExp(reason));
    if (reason === 'operator_stop') control.stop(reason);
    else clock.advance(70_000);
    await rejected;
    assert.equal(control.attempts.length, 0);
    assert.equal(control.globalStop, reason);
  }
});

test('campaign expiry after journaling a dispatch retains its charge and prevents transport', async () => {
  const clock = autoClock();
  const control = new RunControl(
    {
      append: async (event) => {
        if ((event as { event: string }).event === 'dispatch_reserved')
          clock.time = allowance.expiresAt;
      },
    },
    allowance,
    clock,
  );
  const current = await control.start('L01', 'gemini-3.5-flash-lite');
  await assert.rejects(
    current.forward('preflight', async () => assert.fail('unexpected transport')),
    /campaign_expired/,
  );
  assert.equal(control.attempts.length, 1);
  assert.equal(control.attempts[0]!.state, 'reserved');
  current.close();
  await assert.rejects(control.start('L09', 'gemini-3.5-flash-lite'), /campaign_expired/);
});

test('an uncertain request and a failed preflight both consume the finite allocation', async () => {
  const control = new RunControl(
    { append: async () => {} },
    {
      ...allowance,
      maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 5, 'gemini-3.8-flash': 40 },
    },
    autoClock(),
  );
  const current = await control.start('L01', 'gemini-3.5-flash-lite');
  await assert.rejects(
    current.forward('generation', async () => {
      throw new Error('uncertain');
    }),
    /uncertain/,
  );
  await current.forward('preflight', async (attempt) => current.finish(attempt, false, 'http_500'));
  current.close();
  await assert.rejects(
    control.start('L09', 'gemini-3.5-flash-lite'),
    /evaluation_allowance_exhausted/,
  );
  assert.equal(control.attempts.length, 2);
  assert.equal(control.attempts[0]!.result, 'pending');
  assert.equal(control.attempts[1]!.result, 'failed');
});

test('exact finite matrix admits at most 80 forwarded HTTP requests with production sublimits', async () => {
  const control = makeControl();
  let calls = 0;
  for (const pair of ORDER) {
    const current = await control.start(pair.caseId, pair.model);
    for (const operation of [
      'preflight',
      'generation',
      'generation',
      'preflight',
      'generation',
    ] as const)
      await current.forward(operation, async (attempt) => {
        calls++;
        current.finish(attempt, true, 'fixture_valid');
      });
    current.close();
  }
  assert.equal(calls, 80);
  assert.equal(control.attempts.filter((attempt) => attempt.operation === 'generation').length, 48);
  assert.equal(control.admission.reservedInputTokens, 576_000);
  assert.equal(control.admission.reservedOutputAndThoughtTokens, 96_000);
  await assert.rejects(
    control.start('L01', 'gemini-3.5-flash-lite'),
    /unregistered_or_repeated_case/,
  );
});

test('one prior invalid generation plus transient failure blocks its retry, with independent model streak', async () => {
  const control = makeControl();
  const first = await control.start('L01', 'gemini-3.5-flash-lite');
  await first.forward('generation', async (attempt) =>
    first.finish(attempt, false, 'invalid_model_result'),
  );
  first.close();
  const other = await control.start('L01', 'gemini-3.8-flash');
  await other.forward('generation', async (attempt) => other.finish(attempt, true, 'valid'));
  other.close();
  const second = await control.start('L09', 'gemini-3.5-flash-lite');
  await second.forward('preflight', async (attempt) => second.finish(attempt, true, 'preflight'));
  await second.forward('generation', async (attempt) => second.finish(attempt, false, 'http_503'));
  let retry = false;
  await assert.rejects(
    second.forward('generation', async () => {
      retry = true;
    }),
    /candidate_stopped/,
  );
  assert.equal(retry, false);
  assert.equal(control.streak.get('gemini-3.5-flash-lite'), 2);
  assert.equal(control.stoppedCandidates.has('gemini-3.8-flash'), false);
  assert.equal(control.admission.reservedInputTokens, 36_000);
  assert.equal(
    control.attempts
      .filter((attempt) => attempt.operation === 'generation')
      .every((attempt) => attempt.reportedUsage?.status === 'UNKNOWN'),
    true,
  );
  second.close();
});

test('validated retrieval resets failure once; propagated exceptions cannot count twice', async () => {
  const control = makeControl();
  const current = await control.start('L01', 'gemini-3.5-flash-lite');
  await current.forward('generation', async (attempt) => {
    current.finish(attempt, false, 'http_503');
    current.finish(attempt, false, 'propagated');
  });
  assert.equal(control.streak.get(current.model), 1);
  await current.forward('generation', async (attempt) =>
    current.finish(attempt, true, 'validated_retrieve'),
  );
  assert.equal(control.streak.get(current.model), 0);
  current.close();
});

test('deadline or storage failure during durable reservation cannot forward a request', async () => {
  const clock = autoClock();
  const control = new RunControl(
    {
      append: async (event) => {
        if ((event as { event: string }).event === 'dispatch_reserved') clock.time += 45_000;
      },
    },
    allowance,
    clock,
  );
  const current = await control.start('L01', 'gemini-3.5-flash-lite');
  let forwarded = false;
  await assert.rejects(
    current.forward('generation', async () => {
      forwarded = true;
    }),
    /deadline/,
  );
  assert.equal(forwarded, false);
  assert.equal(control.attempts[0]?.state, 'reserved');
  assert.equal(control.globalStop, 'deadline');
  current.close();
  const broken = makeControl({
    append: async (event) => {
      if ((event as { event: string }).event === 'dispatch_reserved')
        throw new Error('private write details');
    },
  });
  const failed = await broken.start('L01', 'gemini-3.5-flash-lite');
  await assert.rejects(
    failed.forward('generation', async () => {
      forwarded = true;
    }),
    /evidence_write_failed/,
  );
  assert.equal(forwarded, false);
  assert.equal(broken.globalStop, 'evidence_write_failed');
  failed.close();
});

test('subceilings, global stop and concurrent attempts fail before transport', async () => {
  for (const operation of ['generation', 'preflight'] as const) {
    const control = makeControl();
    const current = await control.start('L01', 'gemini-3.5-flash-lite');
    for (let i = 0; i < (operation === 'generation' ? 3 : 2); i++)
      await current.forward(operation, async (attempt) => current.finish(attempt, true, 'valid'));
    await assert.rejects(
      current.forward(operation, async () => assert.fail('unexpected dispatch')),
      /dispatch_ceiling/,
    );
    current.close();
  }
  const stopped = makeControl();
  const current = await stopped.start('L01', 'gemini-3.5-flash-lite');
  stopped.stop('quota');
  await assert.rejects(
    current.forward('preflight', async () => assert.fail('unexpected dispatch')),
    /quota/,
  );
  current.close();
});
