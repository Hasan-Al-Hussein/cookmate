export type VideoStatus = 'loading' | 'ready' | 'playing' | 'paused' | 'ended';
export type VideoFailure = 'network' | 'unavailable' | 'configuration' | 'playback';
export interface RecipeVideoPlayerProps {
  videoId: string;
  title: string;
  height: number;
  onStatus: (status: VideoStatus) => void;
  onError: (failure: VideoFailure) => void;
}

export const VIDEO_LOAD_TIMEOUT_MS = 25000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export function safeSourceUrl(value: string | null | undefined): URL | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function youtubeVideoId(value: string | null | undefined): string | null {
  const url = safeSourceUrl(value);
  if (!url || url.port) return null;
  let id: string | null = null;
  if (url.hostname === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  else if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1)
      id = url.searchParams.get('v');
    else id = /^\/(?:embed|shorts)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

export function buildEmbedUrl(videoId: string, origin: string): string {
  const page = safeSourceUrl(origin);
  if (!VIDEO_ID.test(videoId) || !page || page.origin !== origin)
    throw new Error('Invalid video identity');
  const url = new URL(`https://www.youtube.com/embed/${videoId}`);
  url.search = new URLSearchParams({
    playsinline: '1',
    enablejsapi: '1',
    controls: '1',
    origin,
  }).toString();
  return url.toString();
}

export function classifyPlayerError(code: number): VideoFailure {
  if (code === 153) return 'configuration';
  if ([100, 101, 150].includes(code)) return 'unavailable';
  return 'playback';
}

export const videoFailureCopy: Record<VideoFailure, string> = {
  network:
    'The video could not load. Check your connection and try again. Your recipe is still available.',
  unavailable: 'This video cannot play here. Open it on YouTube instead.',
  configuration:
    'YouTube could not verify this player’s app identity. You can open the supplied video on YouTube.',
  playback: 'This video could not play here. You can retry or open it on YouTube.',
};
