import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

/**
 * Capacitor configuration for ZiniaPython IDE.
 *
 * The bundle identifier below is a default. Change `appId` (and the matching
 * PRODUCT_BUNDLE_IDENTIFIER in ios/App/App.xcodeproj) to an identifier you own
 * before signing the app - see docs/SIGNING.md.
 */
const config: CapacitorConfig = {
  appId: 'com.ziniapython.ide',
  appName: 'ZiniaPython',
  webDir: 'dist',
  ios: {
    // The editor manages its own scrolling; stop the WKWebView from bouncing the whole UI.
    scrollEnabled: false,
    contentInset: 'never',
    backgroundColor: '#0e1220',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    Keyboard: {
      // "native" resizes the WKWebView itself, so the editor and key bar stay above the keyboard.
      resize: KeyboardResize.Native,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
