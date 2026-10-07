export interface YoutubePlayer {
  playVideo(): void;
  destroy(): void;
}
export interface YoutubeApi {
  Player: new (
    element: HTMLIFrameElement,
    options: {
      events: {
        onReady: (event: { target: YoutubePlayer }) => void;
        onStateChange: (event: { data: number }) => void;
        onError: (event: { data: number }) => void;
        onAutoplayBlocked: () => void;
      };
    },
  ) => YoutubePlayer;
}
type PlayerWindow = Window & { YT?: YoutubeApi; onYouTubeIframeAPIReady?: () => void };
let pending: Promise<YoutubeApi> | null = null;

// Called only by an explicitly activated player; importing this file makes no request.
export function loadYoutubeApi(): Promise<YoutubeApi> {
  const host = window as PlayerWindow;
  if (host.YT?.Player) return Promise.resolve(host.YT);
  if (pending) return pending;
  pending = new Promise<YoutubeApi>((resolve, reject) => {
    const previous = host.onYouTubeIframeAPIReady;
    const script = document.createElement('script');
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (host.onYouTubeIframeAPIReady === ready) {
        if (previous) host.onYouTubeIframeAPIReady = previous;
        else delete host.onYouTubeIframeAPIReady;
      }
      script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else if (host.YT?.Player) resolve(host.YT);
      else reject(new Error('Player API unavailable'));
    };
    const ready = () => {
      finish();
      previous?.();
    };
    const timer = setTimeout(() => finish(new Error('Player API timed out')), 20000);
    host.onYouTubeIframeAPIReady = ready;
    script.src = 'https://www.youtube.com/iframe_api';
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.async = true;
    script.onerror = () => finish(new Error('Player API could not load'));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
