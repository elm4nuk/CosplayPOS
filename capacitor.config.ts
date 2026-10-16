import type { CapacitorConfig } from '@capacitor/cli'

/**
 * DATA SAFETY — read docs/HANDOFF.md § Rilis before changing anything here.
 * IndexedDB belongs to the WebView origin `https://localhost`. Changing `appId`,
 * `androidScheme`, or `hostname` after a release makes every sale and product
 * already on the phone invisible to the new build.
 */
const config: CapacitorConfig = {
  appId: 'com.cosplaypos.booth',
  appName: 'CosplayPOS',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  android: {
    // Cashier data never leaves the phone over HTTP; block accidental cleartext.
    allowMixedContent: false,
  },
}

export default config
