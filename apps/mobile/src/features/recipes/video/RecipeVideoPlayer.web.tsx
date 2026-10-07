import { useEffect, useRef } from 'react';
import { buildEmbedUrl, classifyPlayerError, type RecipeVideoPlayerProps } from './videoModel';
import { loadYoutubeApi, type YoutubePlayer } from './youtubeWebApi';

export function RecipeVideoPlayer({
  videoId,
  title,
  height,
  onStatus,
  onError,
}: RecipeVideoPlayerProps) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onStatus, onError });
  callbacks.current = { onStatus, onError };
  useEffect(() => {
    let disposed = false;
    let player: YoutubePlayer | undefined;
    const frame = document.createElement('iframe');
    frame.title = `YouTube recipe video for ${title}`;
    // SQLite's isolated web preview must retain COEP. Give third-party media an
    // ephemeral credentialless context instead of weakening the app's headers.
    frame.setAttribute('credentialless', '');
    frame.src = buildEmbedUrl(videoId, window.location.origin);
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.allow = 'autoplay; encrypted-media; fullscreen';
    frame.allowFullscreen = true;
    Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0' });
    container.current?.appendChild(frame);
    callbacks.current.onStatus('loading');
    void loadYoutubeApi()
      .then((api) => {
        if (disposed) return;
        player = new api.Player(frame, {
          events: {
            onReady: ({ target }) => {
              if (disposed) return;
              callbacks.current.onStatus('ready');
              target.playVideo();
            },
            onStateChange: ({ data }) => {
              if (disposed) return;
              const states = {
                0: 'ended',
                1: 'playing',
                2: 'paused',
                3: 'loading',
                5: 'ready',
              } as const;
              const state = states[data as keyof typeof states];
              if (state) callbacks.current.onStatus(state);
            },
            onError: ({ data }) => {
              if (!disposed) callbacks.current.onError(classifyPlayerError(data));
            },
            onAutoplayBlocked: () => {
              if (!disposed) callbacks.current.onStatus('ready');
            },
          },
        });
      })
      .catch(() => {
        if (!disposed) callbacks.current.onError('network');
      });
    return () => {
      disposed = true;
      player?.destroy();
      frame.remove();
    };
  }, [videoId, title]);
  return <div ref={container} style={{ width: '100%', height }} />;
}
