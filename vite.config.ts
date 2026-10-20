import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { ziniaDevBridge } from './vite-dev-bridge.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  // Relative asset URLs: Capacitor serves the bundle from capacitor://localhost/.
  base: './',
  // `npm run dev:bridge` (mode "bridge") adds the desktop development bridge.
  // It is a dev-server feature only and never part of a build.
  plugins: mode === 'bridge' ? [ziniaDevBridge(repoRoot)] : [],
  build: {
    outDir: 'dist',
    target: 'safari15',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: false,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
  },
}));
