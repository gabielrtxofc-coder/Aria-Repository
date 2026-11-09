/**
 * Aria design tokens as data.
 *
 * The CSS sheet (`@deepseek-ai/dsh-aria-theme/tokens.css`) is the authority for
 * rendering; this module republishes the same values for the places that need
 * a token in JavaScript — the brand poster, the documentation screenshot gate,
 * and any component that must compute with a palette step (contrast probes).
 * Keep the two in step: the exported names match the CSS custom properties.
 */

/** One palette step: the CSS custom property name plus its sRGB value. */
export interface PaletteStep {
  /** Custom property name without the leading `--`. */
  readonly token: string
  /** Hex sRGB value, lowercase. */
  readonly value: string
  /** The role this step plays in the interface. */
  readonly role: string
}

/** The graphite-to-lime palette, ordered from darkest ground to accent. */
export const ARIA_PALETTE: readonly PaletteStep[] = [
  { token: 'aria-ink-950', value: '#0b0e0c', role: 'canvas background' },
  { token: 'aria-ink-900', value: '#101411', role: 'sidebar and inset wells' },
  { token: 'aria-ink-850', value: '#121713', role: 'surface' },
  { token: 'aria-ink-800', value: '#181f19', role: 'elevated surface' },
  { token: 'aria-ink-750', value: '#1d251e', role: 'raised surface and selected row' },
  { token: 'aria-ink-700', value: '#222c24', role: 'toast and tooltip ground' },
  { token: 'aria-line-900', value: '#273128', role: 'hairline border' },
  { token: 'aria-line-800', value: '#313d32', role: 'strong border and control stroke' },
  { token: 'aria-line-700', value: '#3c4a3e', role: 'scrollbar thumb' },
  { token: 'aria-text-050', value: '#f8fbf5', role: 'highest-contrast text on selected rows' },
  { token: 'aria-text-100', value: '#f1f5ee', role: 'primary text' },
  { token: 'aria-text-200', value: '#e2e8dd', role: 'readable body copy in overlays' },
  { token: 'aria-text-300', value: '#cbd3c7', role: 'readable secondary copy' },
  { token: 'aria-text-400', value: '#b2bdb1', role: 'control labels' },
  { token: 'aria-text-500', value: '#9aa59a', role: 'secondary text' },
  { token: 'aria-text-600', value: '#7c887d', role: 'tertiary text and metadata' },
  { token: 'aria-text-700', value: '#646e65', role: 'decorative labels only, never body copy' },
  { token: 'aria-lime-600', value: '#8fb73a', role: 'accent hairline on dark ground' },
  { token: 'aria-lime-500', value: '#b2db53', role: 'accent, pressed' },
  { token: 'aria-lime-400', value: '#c8f169', role: 'accent, default' },
  { token: 'aria-lime-300', value: '#dcf9a0', role: 'accent, hover' },
  { token: 'aria-lime-200', value: '#e8fcc4', role: 'accent text on tinted fills' },
  { token: 'aria-amber-300', value: '#f0cd8c', role: 'attention text on tinted fills' },
  { token: 'aria-amber-400', value: '#e8b95c', role: 'waiting for attention' },
  { token: 'aria-red-300', value: '#f4a09a', role: 'failure text on tinted fills' },
  { token: 'aria-red-400', value: '#ef7d75', role: 'failure' },
  { token: 'aria-blue-300', value: '#aacdf0', role: 'review text on tinted fills' },
  { token: 'aria-blue-400', value: '#8fb6e8', role: 'awaiting review' },
] as const;

/** Semantic status names the interface paints, in lifecycle order. */
export const ARIA_STATUS: readonly string[] = [
  'active', 'waiting', 'review', 'done', 'failed', 'idle',
] as const;

/** The four radii the interface uses for real, plus the capsule. */
export const ARIA_RADII = {
  sm: '6px',
  md: '10px',
  lg: '14px',
  panel: '18px',
  pill: '999px',
} as const;

/**
 * Parse a `#rrggbb` value into its 0-255 channels.
 * @param hex - six-digit hex color, with or without the leading `#`.
 * @returns the red, green, and blue channels.
 * @throws if the value is not a six-digit hex color.
 */
export function hexToRgb(hex: string): { r: number, g: number, b: number } {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`hexToRgb: expected #rrggbb, got ${JSON.stringify(hex)}`)
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

/**
 * Linearise one sRGB channel for the WCAG luminance formula.
 * @param raw - the channel value, 0-255.
 * @returns the linearised channel.
 */
function linearChannel(raw: number): number {
  const scaled = raw / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/**
 * WCAG 2.1 relative luminance of a hex color.
 * @param hex - six-digit hex color.
 * @returns luminance in 0..1.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b)
}

/**
 * WCAG 2.1 contrast ratio between two hex colors.
 * @param foreground - text or icon color.
 * @param background - the color behind it.
 * @returns the ratio, from 1 (identical) to 21 (black on white).
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}
