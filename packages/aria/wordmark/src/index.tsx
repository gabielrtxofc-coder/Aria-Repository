/**
 * Aria brand artwork and its stylesheet.
 *
 * Importing this module registers the wordmark and lockup CSS; every component
 * is a plain function component with no runtime dependencies beyond React.
 */

import './brand.css'

/**
 * Aria brand artwork.
 *
 * The mark is one geometric construction: a tapered portal — a narrow gable
 * with its apex cut flat, so it reads as a pediment rather than a roof — closed
 * by the ground line and crossed by a single lintel. The flat apex is what
 * turns a plain triangle into the letter A, and the one lintel is the only
 * interior stroke, so the drawing survives at 16px without a simplified
 * second version.
 *
 * The name is set in Montserrat, the brand face the DSH theme package already
 * ships (`ui-theme/brand-font.css`), so the wordmark is text rather than
 * outlined paths: it stays crisp at any size, inherits the type scale, and
 * never drifts from the font file.
 */

import type { CSSProperties, ReactNode } from 'react'

/** Placement and color props shared by the mark variants. */
export interface AriaMarkProps {
  /** Square edge in px. */
  size?: number | undefined
  /** Extra class for layout placement. */
  className?: string | undefined
  /** Stroke color; the mark inherits `currentColor` when this is omitted. */
  color?: string | undefined
}

/** Native design grid of the mark and of the symbol plate. */
export const ARIA_MARK_VIEWBOX = 24

/**
 * The mark on its 24-unit grid: the portal outline plus the lintel.
 *
 * The lintel overshoots the two legs by a fraction of a unit, the way a real
 * crossbar meets a stroke, so the intersection reads as a joint and not as a
 * crop.
 */
export const ARIA_MARK_GEOMETRY = {
  portal: 'M10.6 2.7H13.4L19.2 21.3H4.8Z',
  lintel: 'M7.6 14.4H16.4',
} as const;

/**
 * Render the primary Aria mark.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @param props.color - stroke color; defaults to `currentColor`.
 * @returns the mark as an `aria-hidden` decorative SVG.
 */
export function AriaMark({ size = 24, className, color }: AriaMarkProps) {
  // Below 20px the hairline joint disappears, so the stroke steps up while the
  // counter still survives; above it the mark keeps its drawn weight.
  const weight = size <= 16 ? 2.3 : 1.75
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${ARIA_MARK_VIEWBOX} ${ARIA_MARK_VIEWBOX}`}
      fill="none"
      className={className}
      style={color === undefined ? undefined : { color }}
      aria-hidden="true"
      focusable="false"
      data-aria-mark=""
    >
      <g stroke="currentColor" strokeWidth={weight} strokeLinecap="square" strokeLinejoin="miter">
        <path d={ARIA_MARK_GEOMETRY.portal} />
        <path d={ARIA_MARK_GEOMETRY.lintel} strokeWidth={weight * 0.86} />
      </g>
    </svg>
  )
}

/**
 * Render the compact symbol: the mark inside a rounded plate.
 *
 * This is the launcher, favicon and collapsed-rail variant. The accent plate is
 * the one place the interface allows the mark to become a solid block, and it
 * keeps the mark's optical weight stable when it sits alone in a square.
 * @param props.size - square edge in px (default 26).
 * @param props.className - extra class for layout placement.
 * @param props.tone - `plate` fills the tile with the accent and draws the mark
 *   in ink; `outline` keeps the tile transparent and strokes it.
 * @returns the symbol as an `aria-hidden` decorative SVG.
 */
export function AriaSymbol({ size = 26, className, tone = 'plate' }: {
  size?: number | undefined
  className?: string | undefined
  tone?: 'plate' | 'outline'
}) {
  const inset = 4.4
  const scale = (ARIA_MARK_VIEWBOX - inset * 2) / ARIA_MARK_VIEWBOX
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${ARIA_MARK_VIEWBOX} ${ARIA_MARK_VIEWBOX}`}
      className={className}
      aria-hidden="true"
      focusable="false"
      data-aria-symbol=""
    >
      <rect
        x="0.6"
        y="0.6"
        width={ARIA_MARK_VIEWBOX - 1.2}
        height={ARIA_MARK_VIEWBOX - 1.2}
        rx="5.4"
        fill={tone === 'plate' ? 'var(--aria-lime-400, #c8f169)' : 'transparent'}
        stroke={tone === 'plate' ? 'none' : 'currentColor'}
        strokeWidth="1.1"
      />
      <g
        transform={`translate(${inset} ${inset}) scale(${scale})`}
        stroke={tone === 'plate' ? 'var(--aria-lime-ink, #0b0e0c)' : 'currentColor'}
        strokeWidth="2.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
        fill="none"
      >
        <path d={ARIA_MARK_GEOMETRY.portal} />
        <path d={ARIA_MARK_GEOMETRY.lintel} strokeWidth="2.15" />
      </g>
    </svg>
  )
}

/** Wordmark case: mixed-case for the product, tracked capitals for brand use. */
export type AriaWordmarkCase = 'product' | 'capital'

/**
 * Render the wordmark as text in the brand face.
 * @param props.height - cap height in px, which sets the font size (default 18).
 * @param props.case - `product` sets "Aria."; `capital` sets "ARIA." with wide
 *   tracking for posters, documentation and the app title bar.
 * @param props.className - extra class for layout placement.
 * @param props.color - text color; defaults to `currentColor`.
 * @returns the wordmark span, with the name plain and the period in the accent.
 */
export function AriaWordmark({ height = 18, case: wordCase = 'product', className, color }: {
  height?: number | undefined
  case?: AriaWordmarkCase | undefined
  className?: string | undefined
  color?: string | undefined
}) {
  const capital = wordCase === 'capital'
  const style: CSSProperties & Record<'--aria-wordmark-size' | '--aria-wordmark-tracking', string> = {
    '--aria-wordmark-size': `${height}px`,
    '--aria-wordmark-tracking': capital ? '0.19em' : '0.005em',
    ...(color === undefined ? {} : { color }),
  }
  return (
    <span
      data-aria-wordmark={wordCase}
      className={className}
      style={style}
    >
      {capital ? 'ARIA' : 'Aria'}
      <span data-aria-wordmark-period="">.</span>
    </span>
  )
}

/**
 * Render the sidebar lockup: the symbol plate beside the wordmark, with an
 * optional descriptor. This is the only variant that carries a tagline, and the
 * tagline is optional so the collapsed rail can render the plate alone.
 * @param props.tagline - short descriptor under the wordmark, already localized.
 * @param props.compact - hide the wordmark, keeping the plate for the rail.
 * @param props.className - extra class for layout placement.
 * @returns the lockup span.
 */
export function AriaLockup({ tagline, compact = false, className, children }: {
  tagline?: string | undefined
  compact?: boolean | undefined
  className?: string | undefined
  children?: ReactNode
}) {
  return (
    <span className={className} data-aria-lockup="" data-compact={compact || undefined}>
      <AriaSymbol size={compact ? 24 : 26} />
      {compact ? null : (
        <span data-aria-lockup-text="">
          <AriaWordmark height={15} />
          {tagline === undefined || tagline === '' ? null : (
            <span data-aria-lockup-tagline="">{tagline}</span>
          )}
        </span>
      )}
      {children}
    </span>
  )
}

/**
 * Render the square application icon: the ink plate, a hairline inset and the
 * accent mark. This is the favicon and install affordance drawing, and the
 * icon variation the brand documentation shows.
 * @param props.size - square edge in px (default 128).
 * @param props.rounded - corner radius in px; defaults to 22% of the edge.
 * @returns the icon as an `aria-hidden` decorative SVG.
 */
export function AriaAppIcon({ size = 128, rounded }: {
  size?: number | undefined
  rounded?: number | undefined
}) {
  const radiusUnits = ((rounded ?? Math.round(size * 0.22)) / size) * 128
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" focusable="false" data-aria-app-icon="">
      <rect width="128" height="128" rx={radiusUnits} fill="#0b0e0c" />
      <rect
        x="0.75"
        y="0.75"
        width="126.5"
        height="126.5"
        rx={Math.max(radiusUnits - 0.75, 0)}
        fill="none"
        stroke="#273128"
        strokeWidth="1.5"
      />
      <g
        transform="translate(25 25) scale(3.25)"
        stroke="#c8f169"
        strokeWidth="1.44"
        strokeLinecap="square"
        strokeLinejoin="miter"
        fill="none"
      >
        <path d={ARIA_MARK_GEOMETRY.portal} />
        <path d={ARIA_MARK_GEOMETRY.lintel} strokeWidth="1.24" />
      </g>
    </svg>
  )
}
