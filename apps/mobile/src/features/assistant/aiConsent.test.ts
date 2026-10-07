import { AiConsentController, aiConsentVersion } from './aiConsent';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(initial: string | null = null) {
  let stored = initial;
  const store = {
    read: jest.fn(async () => stored),
    write: jest.fn(async (value: string) => {
      stored = value;
    }),
  };
  const consent = new AiConsentController(store, () => '2026-09-30T12:00:00.000Z');
  return { consent, store, stored: () => stored };
}
const record = (overrides = {}) =>
  JSON.stringify({
    format: 1,
    installationId: 'installation',
    disclosureVersion: aiConsentVersion,
    allowed: true,
    decidedAt: '2026-09-30T11:00:00.000Z',
    ...overrides,
  });

test('permission requires explicit durable choice, then survives the same installation restart', async () => {
  const f = fixture();
  expect(() => f.consent.assertAllowed()).toThrow();
  await f.consent.bind('installation');
  expect(f.consent.getSnapshot().status).toBe('required');
  expect(f.store.write).not.toHaveBeenCalled();
  const saving = f.consent.decide(true);
  expect(() => f.consent.assertAllowed()).toThrow();
  await saving;
  expect(() => f.consent.assertAllowed()).not.toThrow();
  const restarted = fixture(f.stored());
  await restarted.consent.bind('installation');
  expect(restarted.consent.getSnapshot()).toEqual({
    status: 'allowed',
    acceptedAt: '2026-09-30T12:00:00.000Z',
  });
});

test.each([
  record({ disclosureVersion: 'old-disclosure' }),
  record({ installationId: 'other-installation' }),
])('changed disclosure or installation never inherits permission', async (raw) => {
  const f = fixture(raw);
  await f.consent.bind('installation');
  expect(f.consent.getSnapshot().status).toBe('required');
  expect(() => f.consent.assertAllowed()).toThrow();
  expect(f.stored()).toBe(raw);
});

test.each(['{', record({ format: 2 }), record({ extra: true }), ' '.repeat(2049)])(
  'malformed or unsupported storage fails closed without overwriting it',
  async (raw) => {
    const f = fixture(raw);
    await f.consent.bind('installation');
    await f.consent.decide(true);
    expect(f.consent.getSnapshot().status).toBe('error');
    expect(() => f.consent.assertAllowed()).toThrow();
    expect(f.store.write).not.toHaveBeenCalled();
  },
);

test('failed withdrawal blocks immediately and retry saves withdrawal instead of loading an old grant', async () => {
  const f = fixture(record());
  await f.consent.bind('installation');
  f.store.write.mockRejectedValueOnce(new Error('disk failure'));
  const withdrawing = f.consent.decide(false);
  expect(() => f.consent.assertAllowed()).toThrow();
  await withdrawing;
  expect(f.consent.getSnapshot().status).toBe('error');
  await f.consent.retry();
  expect(f.consent.getSnapshot().status).toBe('declined');
  expect(JSON.parse(f.stored()!).allowed).toBe(false);
});

test('withdrawal racing a slow allow never publishes allowed and is stored last', async () => {
  const f = fixture();
  await f.consent.bind('installation');
  const delayed = deferred<void>();
  const realWrite = f.store.write.getMockImplementation()!;
  f.store.write.mockImplementationOnce(async (value) => {
    await delayed.promise;
    await realWrite(value);
  });
  const states: string[] = [];
  f.consent.subscribe(() => states.push(f.consent.getSnapshot().status));
  const grant = f.consent.decide(true);
  const withdrawal = f.consent.decide(false);
  delayed.resolve();
  await Promise.all([grant, withdrawal]);
  expect(states).not.toContain('allowed');
  expect(f.consent.getSnapshot().status).toBe('declined');
  expect(JSON.parse(f.stored()!).allowed).toBe(false);
});

test('late grant read cannot overwrite a new installation state', async () => {
  const f = fixture();
  const read = deferred<string | null>();
  f.store.read.mockReturnValueOnce(read.promise);
  const old = f.consent.bind('installation');
  await Promise.resolve();
  const fresh = f.consent.bind('replacement');
  read.resolve(record());
  await Promise.all([old, fresh]);
  expect(f.consent.getSnapshot().status).toBe('required');
});

test('write acknowledgement without matching stored value is not permission', async () => {
  const f = fixture();
  await f.consent.bind('installation');
  f.store.write.mockResolvedValueOnce(undefined);
  await f.consent.decide(true);
  expect(f.consent.getSnapshot().status).toBe('error');
  expect(() => f.consent.assertAllowed()).toThrow();
});
