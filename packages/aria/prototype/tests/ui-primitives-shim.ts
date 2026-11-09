/**
 * Test alias for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The subset lives in `src/atoms.ts` — one list shared by the specs, the
 * preview and the screens — so the test alias cannot drift from what the
 * prototype actually imports. The barrel itself is unusable in a source-mode
 * checkout: it re-exports markdown, diff and syntax-highlighting modules whose
 * third-party dependencies are not part of this package's surface.
 */

export * from '../src/atoms.ts'
