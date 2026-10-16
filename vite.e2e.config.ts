import { mergeConfig } from 'vite'
import base from './vite.config.ts'

/**
 * Build used only by scripts/device-e2e.mjs. It exposes the real storage service
 * to the device test via `window.__cosplayPosE2E` and makes sure the service
 * module is in the bundle even before the UI imports it. Never ship this build.
 */
export default mergeConfig(base, {
  // Separate folder so a concurrent production build in dist/ cannot replace it.
  build: { outDir: 'dist-e2e', emptyOutDir: true },
  define: { 'import.meta.env.VITE_E2E': JSON.stringify('1') },
  plugins: [{
    name: 'cosplaypos-e2e-hook',
    // 'pre' so the injected entry is bundled like the app's own script.
    transformIndexHtml: { order: 'pre' as const, handler: () => [{ tag: 'script', attrs: { type: 'module', src: '/src/services/index.ts' }, injectTo: 'body' as const }] },
  }],
})
