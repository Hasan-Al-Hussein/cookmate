// A device WebView does not exist in Jest. Player events are injected in controlled tests;
// this mock provides no network or native-playback evidence.
jest.mock('react-native-webview', () => ({
  WebView: require('react-native').View,
}));
