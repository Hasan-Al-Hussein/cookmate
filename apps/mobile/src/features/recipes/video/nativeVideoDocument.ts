import {
  buildEmbedUrl,
  classifyPlayerError,
  type VideoFailure,
  type VideoStatus,
} from './videoModel';

const BRIDGE_SOURCE = 'cookmate-recipe-video';
const MAX_MESSAGE_LENGTH = 512;
const statuses = new Set<VideoStatus>(['loading', 'ready', 'playing', 'paused', 'ended']);

export interface NativeVideoDocument {
  html: string;
  baseUrl: string;
  embedUrl: string;
}

/** The installed binary's identity is required; app configuration is not an Expo Go identity. */
export function nativeVideoOrigin(applicationId: string | null): string {
  if (
    !applicationId ||
    applicationId.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
      applicationId,
    ) ||
    applicationId.split('.').some((label) => label.length > 63)
  )
    throw new Error('A valid installed application identifier is required for video playback');
  return `https://${applicationId.toLowerCase()}`;
}

export function createNativeVideoDocument(
  videoId: string,
  applicationId: string | null,
): NativeVideoDocument {
  const baseUrl = nativeVideoOrigin(applicationId);
  const embedUrl = buildEmbedUrl(videoId, baseUrl);
  // Only validated identifiers/URLs enter HTML. Recipe titles and source HTML never do.
  const safeEmbedUrl = embedUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return {
    baseUrl,
    embedUrl,
    html: `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; style-src 'unsafe-inline'; frame-src https://www.youtube.com; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;width:100%;height:100%;background:#000}#player{display:block;width:100%;height:100%;border:0;min-width:200px;min-height:200px}</style>
</head><body>
<iframe id="player" title="YouTube recipe video" src="${safeEmbedUrl}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
<script>
(function () {
  'use strict';
  var videoId = ${JSON.stringify(videoId)};
  var player = null;
  var active = true;
  function send(type, value) {
    if (!active || !window.ReactNativeWebView) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({source:${JSON.stringify(BRIDGE_SOURCE)},videoId:videoId,type:type,value:value}));
  }
  function onVisibilityChange() {
    if (document.hidden && player && typeof player.pauseVideo === 'function') player.pauseVideo();
  }
  function dispose() {
    if (!active) return;
    active = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', dispose);
    window.onYouTubeIframeAPIReady = undefined;
    window.__cookMateVideoApiFailed = undefined;
    if (player) {
      try { player.pauseVideo(); } catch (_) {}
      try { player.destroy(); } catch (_) {}
      player = null;
    }
  }
  window.__cookMateVideoDispose = dispose;
  window.__cookMateVideoApiFailed = function () { send('failure', 'network'); };
  window.onYouTubeIframeAPIReady = function () {
    if (!active) return;
    player = new window.YT.Player('player', {events:{
      onReady:function (event) {
        if (!active) return;
        send('status', 'ready');
        // The parent mounts this document only after a deliberate local Play action.
        try { event.target.playVideo(); } catch (_) { send('status', 'ready'); }
      },
      onStateChange:function (event) {
        var status = {'-1':'ready','0':'ended','1':'playing','2':'paused','3':'loading','5':'ready'}[event.data];
        if (status) send('status', status);
      },
      onAutoplayBlocked:function () { send('status', 'ready'); },
      onError:function (event) { send('error', event.data); }
    }});
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', dispose);
})();
</script>
<script src="https://www.youtube.com/iframe_api" onerror="window.__cookMateVideoApiFailed &amp;&amp; window.__cookMateVideoApiFailed()"></script>
</body></html>`,
  };
}

export type NativeVideoEvent =
  | { kind: 'status'; status: VideoStatus }
  | { kind: 'failure'; failure: VideoFailure };

/** The bridge conveys display state only; no native command or catalogue data is accepted. */
export function parseNativeVideoMessage(
  raw: string,
  expectedVideoId: string,
): NativeVideoEvent | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'source,type,value,videoId' ||
    record.source !== BRIDGE_SOURCE ||
    record.videoId !== expectedVideoId
  )
    return null;
  if (record.type === 'status' && statuses.has(record.value as VideoStatus))
    return { kind: 'status', status: record.value as VideoStatus };
  if (
    record.type === 'error' &&
    typeof record.value === 'number' &&
    Number.isSafeInteger(record.value) &&
    record.value >= 0 &&
    record.value <= 65535
  )
    return { kind: 'failure', failure: classifyPlayerError(record.value) };
  if (record.type === 'failure' && record.value === 'network')
    return { kind: 'failure', failure: 'network' };
  return null;
}

export function allowNativeVideoNavigation(
  request: { url: string; isTopFrame?: boolean; hasTargetFrame?: boolean },
  document: Pick<NativeVideoDocument, 'baseUrl' | 'embedUrl'>,
): boolean {
  if (request.hasTargetFrame === false) return false;
  if (request.url === 'about:blank') return true;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.href === `${document.baseUrl}/`) return true;
  // WKWebView reports child-frame loads. Do not block the provider's HTTPS subframes.
  // The top-level local document remains locked, and popup/OS navigation is intercepted.
  if (request.isTopFrame === false) return true;
  return request.isTopFrame === undefined && url.href === document.embedUrl;
}
