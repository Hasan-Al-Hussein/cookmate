import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import * as Application from 'expo-application';
import { WebView } from 'react-native-webview';
import type { RecipeVideoPlayerProps, VideoFailure } from './videoModel';
import {
  allowNativeVideoNavigation,
  createNativeVideoDocument,
  parseNativeVideoMessage,
} from './nativeVideoDocument';

export function RecipeVideoPlayer({
  videoId,
  title,
  height,
  onStatus,
  onError,
}: RecipeVideoPlayerProps) {
  const webView = useRef<WebView>(null);
  const callbacks = useRef({ onStatus, onError });
  callbacks.current = { onStatus, onError };
  const active = useRef(false);
  const failed = useRef(false);
  const document = useMemo(() => {
    try {
      return createNativeVideoDocument(videoId, Application.applicationId);
    } catch {
      return null;
    }
  }, [videoId]);
  const source = useMemo(
    () => (document ? { html: document.html, baseUrl: document.baseUrl } : null),
    [document],
  );

  useEffect(() => {
    active.current = true;
    failed.current = false;
    const instance = webView.current;
    if (source) callbacks.current.onStatus('loading');
    else {
      failed.current = true;
      callbacks.current.onError('configuration');
    }
    return () => {
      active.current = false;
      // Removing the native WebView is authoritative; this also releases a live API instance.
      try {
        instance?.injectJavaScript(
          'window.__cookMateVideoDispose && window.__cookMateVideoDispose(); true;',
        );
      } catch {
        // The native view may already have been removed during route/background teardown.
      }
      try {
        instance?.stopLoading();
      } catch {
        // A removed view has no remaining load to stop.
      }
    };
  }, [source]);

  function reportFailure(failure: VideoFailure) {
    if (!active.current || failed.current) return;
    failed.current = true;
    callbacks.current.onError(failure);
  }

  if (!document || !source) return <View style={{ height }} />;
  return (
    <WebView
      key={videoId}
      ref={webView}
      source={source}
      style={[styles.player, { height }]}
      accessibilityLabel={`YouTube video player for ${title}`}
      // Static HTML requires this whitelist; the predicate prevents top-level/OS escapes.
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={(request) => allowNativeVideoNavigation(request, document)}
      onOpenWindow={() => undefined}
      javaScriptEnabled
      javaScriptCanOpenWindowsAutomatically={false}
      allowsInlineMediaPlayback
      allowsFullscreenVideo
      allowsPictureInPictureMediaPlayback={false}
      allowsAirPlayForMediaPlayback={false}
      mediaPlaybackRequiresUserAction={false}
      allowsLinkPreview={false}
      allowsBackForwardNavigationGestures={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      scrollEnabled={false}
      bounces={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      onMessage={({ nativeEvent }) => {
        if (!active.current || failed.current) return;
        const event = parseNativeVideoMessage(nativeEvent.data, videoId);
        if (event?.kind === 'failure') reportFailure(event.failure);
        else if (event?.kind === 'status') callbacks.current.onStatus(event.status);
      }}
      onError={() => reportFailure('network')}
      onHttpError={({ nativeEvent }) => {
        if (
          nativeEvent.url === document.embedUrl ||
          nativeEvent.url === document.baseUrl ||
          nativeEvent.url === `${document.baseUrl}/`
        )
          reportFailure('network');
      }}
      onContentProcessDidTerminate={() => reportFailure('playback')}
      onRenderProcessGone={() => reportFailure('playback')}
    />
  );
}

const styles = StyleSheet.create({ player: { width: '100%', flex: 0, backgroundColor: '#000' } });
