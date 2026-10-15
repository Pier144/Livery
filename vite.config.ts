import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import license from 'rollup-plugin-license';
import { defineConfig } from 'vitest/config';

const host = process.env.TAURI_DEV_HOST;

/**
 * The licence of every npm package in the bundle, with its full text, written to
 * `dist/licenses/javascript.txt` (shown in About → Licenses; the Rust side is
 * `public/licenses/rust.txt`, see scripts/notices.mjs).
 */
const javascriptNotices = license({
  thirdParty: {
    includePrivate: false,
    output: {
      file: fileURLToPath(new URL('./dist/licenses/javascript.txt', import.meta.url)),
      template: (deps) =>
        [...deps]
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          .map((d) =>
            [
              `${d.name} ${d.version} — ${d.license ?? 'UNKNOWN'}`,
              d.repository && typeof d.repository === 'object' ? d.repository.url : (d.repository ?? d.homepage ?? ''),
              '',
              (d.licenseText ?? '').trim() || `(${d.license ?? 'licence'} — no licence file in the package)`,
              d.noticeText ? `\n${d.noticeText.trim()}` : '',
            ]
              .filter((line, i) => i !== 1 || line)
              .join('\n'),
          )
          .join(`\n\n${'-'.repeat(72)}\n\n`) + '\n',
    },
  },
});

// Tauri expects a fixed port and must not have its Rust sources watched by Vite.
export default defineConfig({
  plugins: [react(), javascriptNotices],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome110',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
