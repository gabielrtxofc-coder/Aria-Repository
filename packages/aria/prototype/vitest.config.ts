/**
 * Vitest configuration for the prototype's interaction specs.
 *
 * The specs run in jsdom against the package sources. Aliases make that work
 * without a build:
 *
 * - the DSH `ui-primitives` subpath is pointed at `tests/ui-primitives-shim.ts`
 *   for a spec that imports the barrel directly; the package's own sources
 *   resolve through `src/atoms.ts`, which imports the six atoms and the glyph
 *   set from their source files. The full barrel also pulls in markdown, diff
 *   and syntax-highlighting modules whose third-party dependencies are not part
 *   of this prototype's surface;
 * - the two stylesheets are resolved to their source files, so a spec that
 *   imports the package entry gets the real token sheet;
 * - the theme and wordmark packages resolve to their sources like every other
 *   workspace package.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: here('.'),
  plugins: [],
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: here('./tests/ui-primitives-shim.ts') },
      { find: /^@deepseek-ai\/dsh-aria-theme\/tokens\.css$/, replacement: here('../theme/src/css/tokens.css') },
      { find: /^@deepseek-ai\/dsh-aria-theme$/, replacement: here('../theme/src/index.ts') },
      { find: /^@deepseek-ai\/dsh-aria-wordmark\/brand\.css$/, replacement: here('../wordmark/src/brand.css') },
      { find: /^@deepseek-ai\/dsh-aria-wordmark$/, replacement: here('../wordmark/src/index.tsx') },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.tsx'],
    setupFiles: ['./tests/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
})
