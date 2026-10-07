/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://cookmate.test:4312/recipes/52839"}
 */
import { act, type ReactNode } from 'react';
import { RecipeVideoPlayer } from './RecipeVideoPlayer.web';
import type { RecipeVideoPlayerProps } from './videoModel';
import { loadYoutubeApi, type YoutubeApi } from './youtubeWebApi';

jest.mock('./youtubeWebApi', () => ({ loadYoutubeApi: jest.fn() }));

// Use the installed ReactDOM without requiring an additional declaration package.
const { createRoot } = require('react-dom/client') as {
  createRoot(container: HTMLElement): { render(node: ReactNode): void; unmount(): void };
};
type PlayerOptions = ConstructorParameters<YoutubeApi['Player']>[1];

function controlledApi() {
  const instances: Array<{
    frame: HTMLIFrameElement;
    events: PlayerOptions['events'];
    player: { playVideo: jest.Mock; destroy: jest.Mock };
  }> = [];
  const Player = jest.fn((frame: HTMLIFrameElement, { events }: PlayerOptions) => {
    const player = { playVideo: jest.fn(), destroy: jest.fn() };
    instances.push({ frame, events, player });
    return player;
  });
  return { api: { Player: Player as unknown as YoutubeApi['Player'] }, Player, instances };
}

function deferredApi() {
  let resolve!: (api: YoutubeApi) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<YoutubeApi>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const loadApi = jest.mocked(loadYoutubeApi);
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);
const originalTextEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | undefined;
let provider: ReturnType<typeof controlledApi>;
let props: RecipeVideoPlayerProps & { onStatus: jest.Mock; onError: jest.Mock };

beforeAll(() => {
  // Jest Expo installs a native URL polyfill; jsdom 20 omits the TextEncoder it needs.
  // Supply the real standard encoder, retaining production URL validation unchanged.
  if (typeof globalThis.TextEncoder === 'undefined')
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      writable: true,
      value: require('node:util').TextEncoder,
    });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
});

beforeEach(() => {
  provider = controlledApi();
  loadApi.mockReset().mockResolvedValue(provider.api);
  props = {
    videoId: 'Wj7sXu9B_ME',
    title: 'Chilli & rice <recipe>',
    height: 240,
    onStatus: jest.fn(),
    onError: jest.fn(),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

function unmount() {
  const mounted = root;
  if (!mounted) return;
  act(() => mounted.unmount());
  root = undefined;
}

afterEach(() => {
  unmount();
  container.remove();
});

afterAll(() => {
  if (originalTextEncoder) Object.defineProperty(globalThis, 'TextEncoder', originalTextEncoder);
  else delete (globalThis as { TextEncoder?: unknown }).TextEncoder;
  if (originalActEnvironment)
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(overrides: Partial<RecipeVideoPlayerProps> = {}) {
  await act(async () => root!.render(<RecipeVideoPlayer {...props} {...overrides} />));
}

// jsdom does not load iframe resources by default. Only the API loader is mocked;
// these checks exercise the real ReactDOM adapter, not network playback or provider UI.
test('the activated adapter embeds the canonical video with the real page origin and provider permissions', async () => {
  await render();
  const frame = container.querySelector('iframe')!;
  expect(frame).not.toBeNull();
  const url = new URL(frame.src);
  expect(url.origin).toBe('https://www.youtube.com');
  expect(url.pathname).toBe(`/embed/${props.videoId}`);
  expect([...url.searchParams.entries()].sort()).toEqual([
    ['controls', '1'],
    ['enablejsapi', '1'],
    ['origin', window.location.origin],
    ['playsinline', '1'],
  ]);
  expect(window.location.origin).toBe('https://cookmate.test:4312');
  expect(frame.title).toBe(`YouTube recipe video for ${props.title}`);
  expect(frame.referrerPolicy).toBe('strict-origin-when-cross-origin');
  expect(frame.hasAttribute('credentialless')).toBe(true);
  expect(frame.allow).toBe('autoplay; encrypted-media; fullscreen');
  expect(frame.allowFullscreen).toBe(true);
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(provider.Player).toHaveBeenCalledTimes(1);
  expect(provider.instances[0]!.frame).toBe(frame);
  expect(provider.instances[0]!.player.playVideo).not.toHaveBeenCalled();
  expect(props.onStatus.mock.calls).toEqual([['loading']]);
});

test('official player events distinguish readiness, blocked autoplay and real playback, and classify errors', async () => {
  await render();
  const { events, player } = provider.instances[0]!;
  act(() => events.onReady({ target: player }));
  expect(player.playVideo).toHaveBeenCalledTimes(1);
  expect(props.onStatus.mock.calls).toEqual([['loading'], ['ready']]);
  act(() => {
    events.onAutoplayBlocked();
    for (const data of [3, 1, 2, 0, 5, 999]) events.onStateChange({ data });
    for (const data of [2, 153, 100, 101, 150, 5]) events.onError({ data });
  });
  expect(props.onStatus.mock.calls.map(([status]) => status)).toEqual([
    'loading',
    'ready',
    'ready',
    'loading',
    'playing',
    'paused',
    'ended',
    'ready',
  ]);
  expect(props.onError.mock.calls.map(([failure]) => failure)).toEqual([
    'playback',
    'configuration',
    'unavailable',
    'unavailable',
    'unavailable',
    'playback',
  ]);
});

test('callback and height updates retain the iframe and player while subsequent events use the latest callbacks', async () => {
  await render();
  const instance = provider.instances[0]!;
  const onStatus = jest.fn();
  const onError = jest.fn();
  await render({ height: 360, onStatus, onError });
  expect(container.querySelector('iframe')).toBe(instance.frame);
  expect(instance.frame.parentElement!.style.height).toBe('360px');
  expect(loadApi).toHaveBeenCalledTimes(1);
  expect(provider.Player).toHaveBeenCalledTimes(1);
  expect(instance.player.destroy).not.toHaveBeenCalled();
  act(() => {
    instance.events.onStateChange({ data: 2 });
    instance.events.onError({ data: 153 });
  });
  expect(onStatus.mock.calls).toEqual([['paused']]);
  expect(onError.mock.calls).toEqual([['configuration']]);
  expect(props.onStatus.mock.calls).toEqual([['loading']]);
  expect(props.onError).not.toHaveBeenCalled();
});

test('unmount destroys and removes the player and suppresses every late callback', async () => {
  await render();
  const { frame, events, player } = provider.instances[0]!;
  unmount();
  expect(player.destroy).toHaveBeenCalledTimes(1);
  expect(frame.parentNode).toBeNull();
  expect(frame.isConnected).toBe(false);
  act(() => {
    events.onReady({ target: player });
    events.onStateChange({ data: 1 });
    events.onError({ data: 100 });
    events.onAutoplayBlocked();
  });
  expect(player.playVideo).not.toHaveBeenCalled();
  expect(props.onStatus.mock.calls).toEqual([['loading']]);
  expect(props.onError).not.toHaveBeenCalled();
});

test('an API that resolves after unmount cannot construct a player or restore its iframe', async () => {
  const pending = deferredApi();
  loadApi.mockReturnValueOnce(pending.promise);
  await render();
  const frame = container.querySelector('iframe')!;
  expect(provider.Player).not.toHaveBeenCalled();
  unmount();
  await act(async () => pending.resolve(provider.api));
  expect(provider.Player).not.toHaveBeenCalled();
  expect(frame.parentNode).toBeNull();
  expect(container.querySelector('iframe')).toBeNull();
  expect(props.onStatus.mock.calls).toEqual([['loading']]);
  expect(props.onError).not.toHaveBeenCalled();
});

test.each(['mounted', 'unmounted'] as const)(
  'API rejection reports network only while %s',
  async (state) => {
    const pending = deferredApi();
    loadApi.mockReturnValueOnce(pending.promise);
    await render();
    if (state === 'unmounted') unmount();
    await act(async () => pending.reject(new Error('Controlled API load failure')));
    expect(props.onError.mock.calls).toEqual(state === 'mounted' ? [['network']] : []);
    expect(provider.Player).not.toHaveBeenCalled();
    expect(props.onStatus.mock.calls).toEqual([['loading']]);
  },
);
