/**
 * Vite configuration for the standalone preview.
 *
 * The preview is a design review tool, not a deployment target: it aliases the
 * workspace packages to their sources so nothing has to be built first, and it
 * binds to 0.0.0.0 so the sandbox can proxy it to a browser. It does not alias
 * `ui-primitives`: `src/atoms.ts` already imports the atoms the prototype uses
 * from their source files, which keeps this config to the two Aria packages.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: here('.'),
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/dsh-aria-prototype$/, replacement: here('../src/index.ts') },
      { find: /^@deepseek-ai\/dsh-aria-theme\/tokens\.css$/, replacement: here('../../theme/src/css/tokens.css') },
      { find: /^@deepseek-ai\/dsh-aria-theme$/, replacement: here('../../theme/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-aria-wordmark\/brand\.css$/, replacement: here('../../wordmark/src/brand.css') },
      { find: /^@deepseek-ai\/dsh-aria-wordmark$/, replacement: here('../../wordmark/src/index.tsx') },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 5273,
    strictPort: false,
    // The preview is proxied by the sandbox under a generated host name.
    allowedHosts: true,
  },
  build: {
    outDir: here('../lib/preview'),
    emptyOutDir: true,
  },
})
