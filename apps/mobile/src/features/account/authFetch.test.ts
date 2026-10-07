import { createAccountAuthFetch } from './authFetch';
import { createAuthLifetime } from './authLifetime';
import { AccountAuthError } from './authTypes';

const {
  ReadableStream,
}: { ReadableStream: typeof globalThis.ReadableStream } = require('node:stream/web');
const mockExpoFetch = jest.fn();
jest.mock('expo/fetch', () => ({
  fetch: (...args: unknown[]) => mockExpoFetch(...args),
}));

const origin = 'https://account.example';
const endpoint = `${origin}/auth/v1/token?grant_type=refresh_token`;
const bodyLimit = 1024 * 1024;
const originalEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
const originalDecoder = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder');

beforeAll(() => {
  // Use genuine codecs where Jest Expo's environment omits the web globals.
  for (const name of ['TextEncoder', 'TextDecoder'] as const) {
    if (typeof globalThis[name] === 'undefined')
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: require('node:util')[name],
      });
  }
});
beforeEach(() => {
  mockExpoFetch.mockReset();
  jest.useFakeTimers();
});
afterEach(() => {
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
afterAll(() => {
  if (originalEncoder) Object.defineProperty(globalThis, 'TextEncoder', originalEncoder);
  else Reflect.deleteProperty(globalThis, 'TextEncoder');
  if (originalDecoder) Object.defineProperty(globalThis, 'TextDecoder', originalDecoder);
  else Reflect.deleteProperty(globalThis, 'TextDecoder');
});

function streamedResponse(
  chunks: Uint8Array[],
  options: { status?: number; headers?: Record<string, string>; keepOpen?: boolean } = {},
) {
  let index = 0;
  const cancelled = jest.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else if (!options.keepOpen) controller.close();
    },
    cancel: cancelled,
  });
  return {
    response: {
      status: options.status ?? 200,
      statusText: 'Synthetic response',
      headers: new Headers({ 'content-type': 'application/json', ...options.headers }),
      body,
    },
    cancelled,
  };
}
const encoded = (value: string) => new TextEncoder().encode(value);

test('allows the configured auth endpoint and forwards JSON without cookies or redirects', async () => {
  const response = streamedResponse([encoded('{"ok":true}')], {
    status: 201,
    headers: { 'x-fixture': 'preserved' },
  });
  mockExpoFetch.mockResolvedValue(response.response);
  const admitted = jest.fn();
  const transport = createAccountAuthFetch(origin, admitted);
  const result = await transport(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"refresh_token":"synthetic-token"}',
    redirect: 'follow',
    credentials: 'include',
  });

  expect(admitted).toHaveBeenCalledTimes(1);
  expect(mockExpoFetch).toHaveBeenCalledWith(
    endpoint,
    expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"refresh_token":"synthetic-token"}',
      redirect: 'error',
      credentials: 'omit',
      signal: expect.anything(),
    }),
  );
  expect(result.status).toBe(201);
  expect(result.headers.get('x-fixture')).toBe('preserved');
  await expect(result.json()).resolves.toEqual({ ok: true });
});

test.each([
  'https://other.example/auth/v1/token',
  'https://account.example.attacker.test/auth/v1/token',
  'http://account.example/auth/v1/token',
  'https://account.example:444/auth/v1/token',
  'https://account.example/rest/v1/recipes',
  'https://account.example/auth/v10/token',
  'https://account.example/auth/v1/../token',
  'https://someone:secret@account.example/auth/v1/token',
])('rejects a disallowed auth destination before dispatch: %s', async (url) => {
  await expect(createAccountAuthFetch(origin, () => undefined)(url)).rejects.toMatchObject({
    reason: 'provider',
  });
  expect(mockExpoFetch).not.toHaveBeenCalled();
});

test('surfaces a transport redirect rejection without dispatching another request', async () => {
  mockExpoFetch.mockRejectedValue(new TypeError('Synthetic redirect blocked'));
  const request = createAccountAuthFetch(origin, () => undefined)(endpoint);
  await expect(request).rejects.toEqual(new AccountAuthError('network'));
  expect(mockExpoFetch).toHaveBeenCalledTimes(1);
  expect(mockExpoFetch.mock.calls[0]![1].redirect).toBe('error');
});

function rejectOnAbort() {
  mockExpoFetch.mockImplementation(
    (_input: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const rejectRequest = () => reject(new Error('Synthetic request aborted'));
        if (init.signal?.aborted) rejectRequest();
        else init.signal?.addEventListener('abort', rejectRequest, { once: true });
      }),
  );
}

test('forwards a caller abort while the request is pending', async () => {
  rejectOnAbort();
  const caller = new AbortController();
  const pending = createAccountAuthFetch(origin, () => undefined)(endpoint, {
    signal: caller.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({ reason: 'network' });
  const forwarded = mockExpoFetch.mock.calls[0]![1].signal as AbortSignal;
  expect(forwarded).not.toBe(caller.signal);
  expect(forwarded.aborted).toBe(false);
  caller.abort();
  await rejected;
  expect(forwarded.aborted).toBe(true);
});

test('preserves an already-aborted caller signal', async () => {
  rejectOnAbort();
  const caller = new AbortController();
  caller.abort();
  await expect(
    createAccountAuthFetch(origin, () => undefined)(endpoint, { signal: caller.signal }),
  ).rejects.toMatchObject({ reason: 'network' });
  expect(mockExpoFetch.mock.calls[0]![1].signal.aborted).toBe(true);
});

test('aborts a stalled fetch at the transport deadline and clears its timer', async () => {
  rejectOnAbort();
  const pending = createAccountAuthFetch(origin, () => undefined)(endpoint);
  const rejected = expect(pending).rejects.toMatchObject({ reason: 'network' });
  jest.advanceTimersByTime(19_999);
  expect(mockExpoFetch.mock.calls[0]![1].signal.aborted).toBe(false);
  jest.advanceTimersByTime(1);
  await rejected;
  expect(mockExpoFetch.mock.calls[0]![1].signal.aborted).toBe(true);
});

test('preserves Unicode split across streamed chunks and an exact-limit response', async () => {
  const json = '{"name":"مطبخ 🍲"}';
  const bytes = encoded(json);
  mockExpoFetch.mockResolvedValueOnce(
    streamedResponse(Array.from(bytes, (byte) => Uint8Array.of(byte))).response,
  );
  const transport = createAccountAuthFetch(origin, () => undefined);
  await expect((await transport(endpoint)).json()).resolves.toEqual(JSON.parse(json));

  mockExpoFetch.mockResolvedValueOnce(streamedResponse([encoded('a'.repeat(bodyLimit))]).response);
  expect((await (await transport(endpoint)).text()).length).toBe(bodyLimit);
});

test('rejects a streamed body over the byte limit even with a misleading small header', async () => {
  const response = streamedResponse([encoded('a'.repeat(bodyLimit)), Uint8Array.of(0x61)], {
    headers: { 'content-length': '2' },
    keepOpen: true,
  });
  mockExpoFetch.mockResolvedValue(response.response);
  await expect(createAccountAuthFetch(origin, () => undefined)(endpoint)).rejects.toMatchObject({
    reason: 'provider',
  });
  expect(response.cancelled).toHaveBeenCalledTimes(1);
});

test('cancels an unread body rejected by its oversized content-length', async () => {
  const response = streamedResponse([encoded('not needed')], {
    headers: { 'content-length': String(bodyLimit + 1) },
    keepOpen: true,
  });
  mockExpoFetch.mockResolvedValue(response.response);
  await expect(createAccountAuthFetch(origin, () => undefined)(endpoint)).rejects.toMatchObject({
    reason: 'provider',
  });
  expect(response.cancelled).toHaveBeenCalledTimes(1);
});

test.each([
  { name: 'invalid continuation byte', chunks: [Uint8Array.of(0xc3, 0x28)] },
  { name: 'truncated final character', chunks: [Uint8Array.of(0xf0, 0x9f), Uint8Array.of(0x8d)] },
])('rejects UTF-8 with $name rather than returning replacement characters', async ({ chunks }) => {
  mockExpoFetch.mockResolvedValue(streamedResponse(chunks).response);
  await expect(createAccountAuthFetch(origin, () => undefined)(endpoint)).rejects.toMatchObject({
    reason: 'network',
  });
});

test('returns an empty 204 response without inventing a JSON body', async () => {
  mockExpoFetch.mockResolvedValue(streamedResponse([], { status: 204 }).response);
  const response = await createAccountAuthFetch(origin, () => undefined)(endpoint);
  expect(response.status).toBe(204);
  await expect(response.text()).resolves.toBe('');
});

test('lets admitted work finish during retirement while rejecting new requests', async () => {
  const lifetime = createAuthLifetime();
  let resolveFetch!: (value: ReturnType<typeof streamedResponse>['response']) => void;
  mockExpoFetch.mockReturnValue(
    new Promise((resolve) => {
      resolveFetch = resolve;
    }),
  );
  const transport = createAccountAuthFetch(origin, lifetime.check);
  const pending = lifetime.track(transport(endpoint));
  lifetime.retire();
  let drained = false;
  const drain = lifetime.drain().then(() => {
    drained = true;
  });
  await expect(transport(endpoint)).rejects.toMatchObject({ reason: 'account_changed' });
  expect(mockExpoFetch).toHaveBeenCalledTimes(1);
  expect(drained).toBe(false);

  resolveFetch(streamedResponse([encoded('{"ok":true}')]).response);
  await expect((await pending).json()).resolves.toEqual({ ok: true });
  await drain;
  expect(drained).toBe(true);
});
