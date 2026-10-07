import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderPhysicalAdmission,
  getProcessProviderAdmission,
  readProviderRequestLimit,
} from '../src/provider-physical-admission';
import { GatewayError } from '../src/errors';

const rejection =
  (seconds: number, code: 'busy' | 'quota' = 'busy') =>
  (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, code === 'quota' ? 429 : 503);
    assert.deepEqual(error.detail, {
      code,
      messageKey: `gateway.${code}`,
      retry: 'after_delay',
      retryAfterSeconds: seconds,
    });
    return true;
  };

test('local policy defaults to five and rejects unsafe or noncanonical limits without exposing input', () => {
  assert.equal(readProviderRequestLimit(undefined), 5);
  assert.equal(readProviderRequestLimit('1'), 1);
  assert.equal(readProviderRequestLimit('1000'), 1000);
  for (const value of [
    '',
    '0',
    '01',
    '+5',
    '-1',
    '1.5',
    '1e2',
    ' 5',
    '5 ',
    '1001',
    'Infinity',
    'PRIVATE_CONFIG',
  ]) {
    assert.throws(
      () => readProviderRequestLimit(value),
      (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.equal(error.detail.code, 'provider_unavailable');
        assert.equal(error.detail.retry, 'after_correction');
        assert.equal(JSON.stringify(error).includes('PRIVATE_CONFIG'), false);
        return true;
      },
    );
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, 1001])
    assert.throws(
      () => createProviderPhysicalAdmission({ requestsPerMinute: value }),
      GatewayError,
    );
});

test('sliding physical window expires at exactly sixty seconds and denied calls reserve nothing', () => {
  let now = 1000;
  const admission = createProviderPhysicalAdmission({ requestsPerMinute: 2, now: () => now });
  admission.admit();
  now = 15_250;
  admission.admit();
  for (let index = 0; index < 10; index++) assert.throws(() => admission.admit(), rejection(46));
  now = 60_999;
  assert.throws(() => admission.admit(), rejection(1));
  now = 61_000;
  admission.admit();
  assert.throws(() => admission.admit(), rejection(15));
  now = 75_250;
  admission.admit();
});

test('already-aborted and clock-callback-aborted calls do not consume admission', () => {
  const before = new AbortController();
  before.abort();
  const during = new AbortController();
  const admission = createProviderPhysicalAdmission({
    requestsPerMinute: 1,
    now: () => {
      during.abort();
      return 0;
    },
  });
  assert.throws(() => admission.admit(before.signal));
  assert.throws(() => admission.admit(during.signal));
  admission.admit(new AbortController().signal);
  assert.throws(() => admission.admit(), rejection(60));
});

test('shared cooldown only extends and rejection uses the later cooldown or window expiry', () => {
  let now = 0;
  const admission = createProviderPhysicalAdmission({ requestsPerMinute: 1, now: () => now });
  admission.admit();
  admission.recordQuota(10);
  now = 5000;
  assert.throws(() => admission.admit(), rejection(55, 'quota'));
  admission.recordQuota(120);
  now = 10_000;
  admission.recordQuota(0);
  admission.recordQuota(2);
  assert.throws(() => admission.admit(), rejection(115, 'quota'));
  now = 124_999;
  assert.throws(() => admission.admit(), rejection(1, 'quota'));
  now = 125_000;
  admission.admit();
});

test('missing or unusable quota hints use sixty seconds while explicit zero and one-day hints stay distinct', () => {
  for (const [hint, expected] of [
    [undefined, 60],
    [-1, 60],
    [0.5, 60],
    [Infinity, 60],
    [NaN, 60],
    [86401, 60],
    [0, 0],
    [9, 9],
    [86400, 86400],
  ] as const) {
    const admission = createProviderPhysicalAdmission({ requestsPerMinute: 5, now: () => 0 });
    admission.recordQuota(hint);
    if (expected === 0) admission.admit();
    else assert.throws(() => admission.admit(), rejection(expected, 'quota'));
  }
});

test('backward clocks cannot shorten limits and invalid clocks fail future admission closed', () => {
  let now = 0;
  const admission = createProviderPhysicalAdmission({ requestsPerMinute: 1, now: () => now });
  admission.admit();
  now = 30_000;
  assert.throws(() => admission.admit(), rejection(30));
  now = 10_000;
  assert.throws(() => admission.admit(), rejection(30));
  now = 60_000;
  admission.admit();
  now = NaN;
  assert.doesNotThrow(() => admission.recordQuota(9));
  now = 120_000;
  assert.throws(
    () => admission.admit(),
    (error: unknown) => error instanceof GatewayError && error.detail.retry === 'after_correction',
  );
  for (const now of [
    () => -1,
    () => Infinity,
    () => Number.MAX_SAFE_INTEGER,
    () => {
      throw new Error('PRIVATE_CLOCK');
    },
  ]) {
    const invalid = createProviderPhysicalAdmission({ requestsPerMinute: 1, now });
    assert.throws(
      () => invalid.admit(),
      (error: unknown) =>
        error instanceof GatewayError && !JSON.stringify(error).includes('PRIVATE_CLOCK'),
    );
  }
});

test('process owner reuses spent state and rejects conflicting reconfiguration; explicit instances stay isolated', () => {
  const first = getProcessProviderAdmission(2);
  first.admit();
  const relaunched = getProcessProviderAdmission(2);
  assert.equal(first, relaunched);
  relaunched.admit();
  assert.throws(() => getProcessProviderAdmission(3), GatewayError);
  assert.throws(
    () => getProcessProviderAdmission(2).admit(),
    (error: unknown) => error instanceof GatewayError && error.detail.code === 'busy',
  );
  for (let index = 0; index < 2; index++)
    createProviderPhysicalAdmission({ requestsPerMinute: 1, now: () => 0 }).admit();
});
