import { createRequire } from 'node:module';
import { channel } from 'node:diagnostics_channel';

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(import.meta.dirname);
const requestStart = channel('http.server.request.start');
const subscriptionKey = Symbol.for('cookmate.webPreviewHeaders');

// Expo may reload this config in the same process.
if (globalThis[subscriptionKey]) {
  requestStart.unsubscribe(globalThis[subscriptionKey]);
  delete globalThis[subscriptionKey];
}

if (process.env.COOKMATE_WEB_PREVIEW === '1') {
  config.resolver.assetExts.push('wasm');

  // Expo SDK57 serves '/' before Metro middleware. Set SQLite's isolation headers
  // at request start so the initial HTML and worker assets receive them together.
  // Only this preview process's loopback requests are affected; iPhone LAN is not.
  const addPreviewHeaders = ({ request, response }) => {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? '')) return;
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  };
  requestStart.subscribe(addPreviewHeaders);
  globalThis[subscriptionKey] = addPreviewHeaders;
}

export default config;
