import {
  allowNativeVideoNavigation,
  createNativeVideoDocument,
  nativeVideoOrigin,
  parseNativeVideoMessage,
} from './nativeVideoDocument';

const videoId = 'Wj7sXu9B_ME';
const applicationId = 'dev.cookmate.prototype';
const message = (type: string, value: unknown, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ source: 'cookmate-recipe-video', videoId, type, value, ...overrides });

test('native client identification uses the installed binary ID, including Expo Go, without an invented fallback', () => {
  expect(nativeVideoOrigin(applicationId)).toBe('https://dev.cookmate.prototype');
  expect(nativeVideoOrigin('host.exp.Exponent')).toBe('https://host.exp.exponent');
  for (const invalid of [
    null,
    '',
    'dev.cookmate.prototype/path',
    'https://example.com',
    'x@y.com',
    'x..app',
    'x.app?key=1',
    'x.app#fragment',
    'x.app<script>',
    `${'a'.repeat(64)}.app`,
  ])
    expect(() => nativeVideoOrigin(invalid)).toThrow();
});

test('native HTML keeps the referer base, canonical video identity, provider controls and a minimum viewport', () => {
  const document = createNativeVideoDocument(videoId, applicationId);
  expect(document.baseUrl).toBe('https://dev.cookmate.prototype');
  const embed = new URL(document.embedUrl);
  expect(embed.origin).toBe('https://www.youtube.com');
  expect(embed.pathname).toBe(`/embed/${videoId}`);
  expect(embed.searchParams.get('origin')).toBe(document.baseUrl);
  expect(embed.searchParams.get('playsinline')).toBe('1');
  expect(embed.searchParams.get('enablejsapi')).toBe('1');
  expect(embed.searchParams.get('controls')).toBe('1');
  expect(document.html).toContain('strict-origin-when-cross-origin');
  expect(document.html).toContain('allowfullscreen');
  expect(document.html).toContain('min-width:200px;min-height:200px');
  expect(document.html).toContain('https://www.youtube.com/iframe_api');
  expect(document.html).not.toMatch(/modestbranding|controls=0|noreferrer|no-referrer/);
  expect(() =>
    createNativeVideoDocument(`${videoId}\" onload=\"alert(1)`, applicationId),
  ).toThrow();
  expect(() => createNativeVideoDocument(videoId, 'cookmate.app</script>')).toThrow();
});

test('native bridge accepts only bounded matching-video display events, distinguishing configuration from unavailable', () => {
  for (const status of ['loading', 'ready', 'playing', 'paused', 'ended'] as const)
    expect(parseNativeVideoMessage(message('status', status), videoId)).toEqual({
      kind: 'status',
      status,
    });
  expect(parseNativeVideoMessage(message('error', 153), videoId)).toEqual({
    kind: 'failure',
    failure: 'configuration',
  });
  for (const code of [100, 101, 150])
    expect(parseNativeVideoMessage(message('error', code), videoId)).toEqual({
      kind: 'failure',
      failure: 'unavailable',
    });
  expect(parseNativeVideoMessage(message('error', 5), videoId)).toEqual({
    kind: 'failure',
    failure: 'playback',
  });
  expect(parseNativeVideoMessage(message('failure', 'network'), videoId)).toEqual({
    kind: 'failure',
    failure: 'network',
  });
  for (const raw of [
    '',
    '{',
    'null',
    '[]',
    '"ready"',
    ' '.repeat(513),
    message('status', 'saved'),
    message('status', 'ready', { source: 'other' }),
    message('status', 'ready', { videoId: 'AS2mSRtWyW0' }),
    message('status', 'ready', { command: 'saveRecipe' }),
    message('execute', 'saveRecipe'),
    message('error', '153'),
    message('error', -1),
    message('error', 1.5),
    message('error', 65536),
    message('failure', 'configuration'),
  ])
    expect(parseNativeVideoMessage(raw, videoId)).toBeNull();
});

test('navigation retains the local document and HTTPS subframes without granting top-level or app escapes', () => {
  const document = createNativeVideoDocument(videoId, applicationId);
  expect(allowNativeVideoNavigation({ url: document.baseUrl, isTopFrame: true }, document)).toBe(
    true,
  );
  expect(allowNativeVideoNavigation({ url: 'about:blank', isTopFrame: true }, document)).toBe(true);
  expect(allowNativeVideoNavigation({ url: document.embedUrl, isTopFrame: false }, document)).toBe(
    true,
  );
  expect(
    allowNativeVideoNavigation(
      { url: 'https://www.google.com/recaptcha/iframe', isTopFrame: false },
      document,
    ),
  ).toBe(true);
  expect(allowNativeVideoNavigation({ url: document.embedUrl }, document)).toBe(true);
  for (const url of [
    document.embedUrl,
    'https://www.youtube.com/watch?v=Wj7sXu9B_ME',
    'https://example.com',
    `${document.baseUrl}/other`,
  ])
    expect(allowNativeVideoNavigation({ url, isTopFrame: true }, document)).toBe(false);
  for (const url of [
    'youtube://video',
    'intent://video',
    'file:///private/data',
    'javascript:alert(1)',
    'http://www.youtube.com/embed/x',
    'https://user:secret@example.com',
  ])
    expect(allowNativeVideoNavigation({ url, isTopFrame: false }, document)).toBe(false);
  expect(
    allowNativeVideoNavigation({ url: document.embedUrl, hasTargetFrame: false }, document),
  ).toBe(false);
  expect(allowNativeVideoNavigation({ url: 'https://example.com' }, document)).toBe(false);
});

interface PlayerEvents {
  onReady(event: { target: { playVideo(): void } }): void;
  onStateChange(event: { data: number }): void;
  onAutoplayBlocked(): void;
  onError(event: { data: number }): void;
}

function controlledPlayerDocument() {
  const document = createNativeVideoDocument(videoId, applicationId);
  const script = /<script>\s*([\s\S]*?)<\/script>/.exec(document.html)?.[1];
  if (!script) throw new Error('The native player document has no event adapter');
  const messages: string[] = [];
  const windowListeners = new Map<string, () => void>();
  const documentListeners = new Map<string, () => void>();
  const player = { playVideo: jest.fn(), pauseVideo: jest.fn(), destroy: jest.fn() };
  let events: PlayerEvents | undefined;
  const window = {
    ReactNativeWebView: { postMessage: (raw: string) => messages.push(raw) },
    YT: {
      Player: jest.fn().mockImplementation((_id: string, options: { events: PlayerEvents }) => {
        events = options.events;
        return player;
      }),
    },
    onYouTubeIframeAPIReady: undefined as (() => void) | undefined,
    __cookMateVideoApiFailed: undefined as (() => void) | undefined,
    __cookMateVideoDispose: undefined as (() => void) | undefined,
    addEventListener: (name: string, callback: () => void) => windowListeners.set(name, callback),
    removeEventListener: (name: string) => windowListeners.delete(name),
  };
  const dom = {
    hidden: false,
    addEventListener: (name: string, callback: () => void) => documentListeners.set(name, callback),
    removeEventListener: (name: string) => documentListeners.delete(name),
  };
  // Execute only our generated event adapter against local fake browser/provider objects.
  // No document, iframe, native WebView or network is created by this fixture.
  new Function('window', 'document', script)(window, dom);
  return {
    window,
    dom,
    player,
    messages,
    windowListeners,
    documentListeners,
    get events() {
      if (!events) throw new Error('The fake IFrame API is not ready');
      return events;
    },
  };
}

test('IFrame events alone establish playback and autoplay refusal leaves the provider ready', () => {
  const fixture = controlledPlayerDocument();
  expect(fixture.messages).toEqual([]);
  fixture.window.onYouTubeIframeAPIReady!();
  expect(fixture.player.playVideo).not.toHaveBeenCalled();
  fixture.events.onReady({ target: fixture.player });
  expect(fixture.player.playVideo).toHaveBeenCalledTimes(1);
  expect(fixture.messages.map((raw) => parseNativeVideoMessage(raw, videoId))).toEqual([
    { kind: 'status', status: 'ready' },
  ]);
  fixture.events.onAutoplayBlocked();
  fixture.events.onStateChange({ data: 3 });
  fixture.events.onStateChange({ data: 1 });
  fixture.events.onStateChange({ data: 2 });
  fixture.events.onStateChange({ data: 0 });
  fixture.events.onStateChange({ data: 999 });
  fixture.events.onError({ data: 153 });
  expect(fixture.messages.slice(1).map((raw) => parseNativeVideoMessage(raw, videoId))).toEqual([
    { kind: 'status', status: 'ready' },
    { kind: 'status', status: 'loading' },
    { kind: 'status', status: 'playing' },
    { kind: 'status', status: 'paused' },
    { kind: 'status', status: 'ended' },
    { kind: 'failure', failure: 'configuration' },
  ]);
});

test('hidden documents pause without resuming and disposal destroys the player and suppresses late callbacks', () => {
  const fixture = controlledPlayerDocument();
  fixture.window.onYouTubeIframeAPIReady!();
  fixture.events.onReady({ target: fixture.player });
  fixture.dom.hidden = true;
  fixture.documentListeners.get('visibilitychange')!();
  expect(fixture.player.pauseVideo).toHaveBeenCalledTimes(1);
  fixture.dom.hidden = false;
  fixture.documentListeners.get('visibilitychange')!();
  expect(fixture.player.playVideo).toHaveBeenCalledTimes(1);
  fixture.windowListeners.get('pagehide')!();
  fixture.window.__cookMateVideoDispose!();
  expect(fixture.player.destroy).toHaveBeenCalledTimes(1);
  expect(fixture.player.pauseVideo).toHaveBeenCalledTimes(2);
  expect(fixture.documentListeners.size).toBe(0);
  expect(fixture.windowListeners.size).toBe(0);
  expect(fixture.window.onYouTubeIframeAPIReady).toBeUndefined();
  const before = [...fixture.messages];
  fixture.events.onStateChange({ data: 1 });
  fixture.events.onError({ data: 100 });
  fixture.events.onReady({ target: fixture.player });
  expect(fixture.messages).toEqual(before);
  expect(fixture.player.playVideo).toHaveBeenCalledTimes(1);
});

test('a script load failure reports network and teardown before API readiness cannot start a player', () => {
  const fixture = controlledPlayerDocument();
  const lateReady = fixture.window.onYouTubeIframeAPIReady!;
  fixture.window.__cookMateVideoApiFailed!();
  expect(parseNativeVideoMessage(fixture.messages[0]!, videoId)).toEqual({
    kind: 'failure',
    failure: 'network',
  });
  fixture.window.__cookMateVideoDispose!();
  lateReady();
  expect(fixture.window.YT.Player).not.toHaveBeenCalled();
  expect(fixture.window.__cookMateVideoApiFailed).toBeUndefined();
});
