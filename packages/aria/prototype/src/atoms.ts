/**
 * The subset of `@deepseek-ai/dsh-client-ui-primitives` the prototype consumes,
 * resolved from source.
 *
 * The package barrel re-exports markdown, diff and syntax-highlighting modules
 * whose third-party dependencies a source-mode toolchain may not have installed
 * — the repository's own source launch aliases the whole workspace to `src`, so
 * importing the barrel from the prototype would drag in `shiki`, `diff` and
 * `simple-icons` even though the prototype renders none of them. This module
 * re-exports the atoms and glyphs the prototype actually uses, straight from
 * their source files, so the interaction specs and the standalone preview both
 * exercise the real controls without the rest of the barrel. Every name below
 * is re-exported by `components/primitives.tsx`; a name that no screen imports
 * does not belong here.
 */

export { Button } from '../../../client/ui-primitives/src/Button.tsx'
export { Input } from '../../../client/ui-primitives/src/Input.tsx'
export { Switch } from '../../../client/ui-primitives/src/Switch.tsx'
export { Modal } from '../../../client/ui-primitives/src/Modal.tsx'
export { Tag } from '../../../client/ui-primitives/src/Tag.tsx'
export type { TagTone } from '../../../client/ui-primitives/src/Tag.tsx'
export * from '../../../client/ui-primitives/src/icons/index.tsx'
