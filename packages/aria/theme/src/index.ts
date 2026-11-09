/**
 * Aria theme package: the design tokens and the palette data behind them.
 *
 * Import the sheets for their side effects — `tokens.css` declares the
 * `--aria-*` scale and rebinds the `--dsw-alias-*` tokens the reused DSH atoms
 * paint with.
 */

import './css/tokens.css'

export {
  ARIA_PALETTE, ARIA_RADII, ARIA_STATUS, contrastRatio, hexToRgb, relativeLuminance,
} from './tokens.ts'
export type { PaletteStep } from './tokens.ts'
