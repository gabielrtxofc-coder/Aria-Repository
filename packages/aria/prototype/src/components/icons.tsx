/**
 * The prototype's icon set.
 *
 * Navigation and section glyphs that the DSH primitive icon library does not
 * carry are drawn here on the same 24-unit grid with the same 1.6 stroke, so a
 * prototype icon and a reused primitive icon sit in one row without a weight
 * mismatch. Everything else imports straight from `ui-primitives`.
 */

import type { ReactNode } from 'react'

/** Placement props shared by the prototype glyphs. */
export interface GlyphProps {
  /** Square edge in px (default 16). */
  size?: number | undefined
  className?: string | undefined
}

/**
 * Wrap glyph artwork in the shared grid and stroke settings.
 * @param props.size - square edge in px.
 * @param props.className - extra class for layout placement.
 * @param props.children - path artwork drawn against `currentColor`.
 * @returns the glyph SVG.
 */
function Glyph({ size = 16, className, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Overview: a dashboard split into a wide tile and two stacked tiles. */
export function GlyphOverview(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3.2" y="3.2" width="8.2" height="7.4" rx="1.6" />
      <rect x="3.2" y="13.4" width="8.2" height="7.4" rx="1.6" />
      <rect x="14.4" y="3.2" width="6.4" height="17.6" rx="1.6" />
    </Glyph>
  )
}

/** Missions: a plan with a checked first entry. */
export function GlyphMissions(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4 6.4 5.6 8l2.6-2.6" />
      <path d="M4 13.2 5.6 14.8 8.2 12.2" />
      <path d="M4 19.4h.02" />
      <path d="M12.4 6.6h7.4M12.4 13.4h7.4M12.4 19.6h4.6" />
    </Glyph>
  )
}

/** Agents: two overlapping operator capsules. */
export function GlyphAgents(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="9.4" cy="8.6" r="3.2" />
      <path d="M3.6 19.4c0-2.9 2.6-4.9 5.8-4.9s5.8 2 5.8 4.9" />
      <path d="M16.2 6.1a3.1 3.1 0 0 1 0 5.9" />
      <path d="M17.7 14.9c1.7.7 2.9 2.2 2.9 4.2" />
    </Glyph>
  )
}

/** Knowledge: stacked reference volumes. */
export function GlyphKnowledge(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4.2 5.4c2.4-1 5-1 7.8.5V19c-2.8-1.5-5.4-1.5-7.8-.5Z" />
      <path d="M19.8 5.4c-2.4-1-5-1-7.8.5V19c2.8-1.5 5.4-1.5 7.8-.5Z" />
      <path d="M12 5.9V19" />
    </Glyph>
  )
}

/** Activity: a pulse trace. */
export function GlyphActivity(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M2.8 12.4h4l2.4-6.2 3.2 12.2 2.6-8 1.8 4h4.4" />
    </Glyph>
  )
}

/** Settings: a control column with two sliders. */
export function GlyphSettings(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M6.2 3.8v6.1M6.2 14.1v6.1M17.8 3.8v8.1M17.8 16.1v4.1" />
      <circle cx="6.2" cy="12" r="2.1" />
      <circle cx="17.8" cy="14" r="2.1" />
    </Glyph>
  )
}

/** New mission: a plus in a square. */
export function GlyphNewMission(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3.4" />
      <path d="M12 8.2v7.6M8.2 12h7.6" />
    </Glyph>
  )
}

/** Search: a magnifier with a fine handle. */
export function GlyphSearch(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="10.6" cy="10.6" r="6.2" />
      <path d="m15.4 15.4 4.4 4.4" />
    </Glyph>
  )
}

/** Attention: an exclamation inside a triangle. */
export function GlyphAttention(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M12 4.2 21 20.2H3Z" />
      <path d="M12 9.6v4.6M12 17.4h.02" />
    </Glyph>
  )
}

/** Artifact: a document with a folded corner. */
export function GlyphArtifact(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M6 3.6h7L18.6 9v11.4H6Z" />
      <path d="M12.8 3.8V9.2h5" />
    </Glyph>
  )
}

/** Verification: a shield with a tick. */
export function GlyphVerify(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.4 19.4 6v6.2c0 4.2-2.9 7-7.4 8.4-4.5-1.4-7.4-4.2-7.4-8.4V6Z" />
      <path d="m8.8 12.2 2.3 2.3 4.2-4.4" />
    </Glyph>
  )
}

/** Model: a small processor die. */
export function GlyphModel(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.4" />
      <path d="M9.6 3.4v3M14.4 3.4v3M9.6 17.6v3M14.4 17.6v3M3.4 9.6h3M3.4 14.4h3M17.6 9.6h3M17.6 14.4h3" />
    </Glyph>
  )
}

/** Memory: layered storage rings. */
export function GlyphMemory(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <ellipse cx="12" cy="6.6" rx="7.4" ry="2.8" />
      <path d="M4.6 6.6v5.2c0 1.6 3.3 2.8 7.4 2.8s7.4-1.2 7.4-2.8V6.6" />
      <path d="M4.6 11.8V17c0 1.6 3.3 2.8 7.4 2.8s7.4-1.2 7.4-2.8v-5.2" />
    </Glyph>
  )
}

/** Integration: two linked nodes. */
export function GlyphIntegration(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3.2" y="3.2" width="7.4" height="7.4" rx="2" />
      <rect x="13.4" y="13.4" width="7.4" height="7.4" rx="2" />
      <path d="M10.8 6.9h4.2a2.6 2.6 0 0 1 2.6 2.6v3.7" />
    </Glyph>
  )
}

/** Appearance: a half-filled circle. */
export function GlyphAppearance(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 3.8a8.2 8.2 0 0 1 0 16.4Z" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

/** General: a horizontal control row. */
export function GlyphGeneral(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3.6 7.4h16.8M3.6 16.6h16.8" />
      <circle cx="9" cy="7.4" r="2.2" fill="var(--aria-bg-surface)" />
      <circle cx="15.4" cy="16.6" r="2.2" fill="var(--aria-bg-surface)" />
    </Glyph>
  )
}

/** Empty queue: three stacked bars with nothing behind them. */
export function GlyphQueue(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4.4 7.4h11.2M4.4 12h15.2M4.4 16.6h7.6" />
    </Glyph>
  )
}

/** Notifications: a bell with a flat clapper. */
export function GlyphBell(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M6.4 10.2a5.6 5.6 0 0 1 11.2 0c0 3.2.8 5 1.6 6.2H4.8c.8-1.2 1.6-3 1.6-6.2Z" />
      <path d="M10.2 19.4a2 2 0 0 0 3.6 0" />
    </Glyph>
  )
}

/** Navigation menu: three rules, the middle one short. */
export function GlyphMenu(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </Glyph>
  )
}

/** Clock: a dial with hands. */
export function GlyphClock(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.2 2" />
    </Glyph>
  )
}

/** Arrow: a right-pointing rule with a head, used on "view all" links. */
export function GlyphArrowRight(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4.6 12h14.2M13.4 6.6 18.8 12l-5.4 5.4" />
    </Glyph>
  )
}

/** Capability: three stacked rules of decreasing length. */
export function GlyphCapability(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4.6 6.6h14.8M4.6 12h10.4M4.6 17.4h6.6" />
    </Glyph>
  )
}

/** Security: a padlock, drawn on the same grid as the shield. */
export function GlyphSecurity(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4.6" y="10.6" width="14.8" height="9.4" rx="2.4" />
      <path d="M8.4 10.6V8.2a3.6 3.6 0 0 1 7.2 0v2.4" />
      <path d="M12 14.4v2.2" />
    </Glyph>
  )
}
