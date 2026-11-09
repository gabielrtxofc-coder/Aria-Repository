/**
 * Structural atoms: the panel, the section heading, the metadata list and the
 * divider.
 *
 * A screen composes these instead of styling its own card, which is what keeps
 * padding, stroke and heading rhythm identical on all six screens.
 */

import type { CSSProperties, ReactNode } from 'react'
import clsx from 'clsx'
import css from './Panel.module.css'

/** Surface a panel paints. */
export type PanelVariant = 'surface' | 'plain' | 'inset' | 'elevated'

/**
 * Render a card surface.
 * @param props.children - panel content.
 * @param props.variant - surface treatment (default `surface`).
 * @param props.padding - inner padding step (default `md`).
 * @param props.interactive - render as a button that responds to hover.
 * @param props.selected - draw the selected stroke.
 * @param props.as - element to render: `section` by default, `div` when the
 *   panel is a layout wrapper rather than a labelled region.
 * @param props.onClick - click handler; also makes the panel a button.
 * @param props.className - extra class for layout placement.
 * @param props.style - layout custom properties.
 * @returns the panel element.
 */
export function Panel({ children, variant = 'surface', padding = 'md', interactive = false, selected = false, as = 'section', onClick, className, style, ...rest }: {
  children?: ReactNode
  variant?: PanelVariant | undefined
  padding?: 'none' | 'sm' | 'md' | 'lg' | undefined
  interactive?: boolean | undefined
  selected?: boolean | undefined
  as?: 'section' | 'div' | 'article' | 'li' | undefined
  onClick?: (() => void) | undefined
  className?: string | undefined
  style?: CSSProperties | undefined
  'aria-label'?: string | undefined
  'aria-labelledby'?: string | undefined
}) {
  const Element = interactive || onClick !== undefined ? 'button' : as
  return (
    <Element
      type={Element === 'button' ? 'button' : undefined}
      className={clsx(css.panel, className)}
      data-variant={variant}
      data-padding={padding}
      data-interactive={interactive || onClick !== undefined || undefined}
      data-selected={selected || undefined}
      style={style}
      onClick={onClick}
      {...rest}
    >
      {children}
    </Element>
  )
}

/**
 * Render the heading block a panel opens with.
 * @param props.title - the heading text.
 * @param props.eyebrow - small capitalised label above the heading.
 * @param props.hint - supporting sentence under the heading.
 * @param props.actions - right-aligned controls.
 * @param props.size - heading step (default `md`).
 * @param props.level - heading element to render (default `h2`).
 * @param props.id - element id, so a panel can point at it with `aria-labelledby`.
 * @returns the heading row.
 */
export function SectionHeading({ title, eyebrow, hint, actions, size = 'md', level = 2, id }: {
  title: ReactNode
  eyebrow?: string | undefined
  hint?: string | undefined
  actions?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  level?: 1 | 2 | 3 | 4
  id?: string | undefined
}) {
  const Heading = `h${level}` as const
  return (
    <div className={css.header}>
      <div className={css.heading}>
        {eyebrow === undefined ? null : <span className={css.eyebrow}>{eyebrow}</span>}
        <Heading className={css.title} data-size={size} id={id}>{title}</Heading>
        {hint === undefined ? null : <span className={css.hint}>{hint}</span>}
      </div>
      {actions === undefined ? null : <div className={css.actions}>{actions}</div>}
    </div>
  )
}

/** One label/value row of a {@link MetaList}. */
export interface MetaEntry {
  readonly term: string
  readonly value: ReactNode
  /** Render the value in the code face, for identifiers and timestamps. */
  readonly mono?: boolean
}

/**
 * Render a two-column label/value list.
 * @param props.items - rows, in display order.
 * @param props.className - extra class for layout placement.
 * @returns the description list.
 */
export function MetaList({ items, className }: {
  items: readonly MetaEntry[]
  className?: string | undefined
}) {
  return (
    <dl className={clsx(css.metaList, className)}>
      {items.map(item => (
        <div key={item.term} style={{ display: 'contents' }}>
          <dt className={css.metaTerm}>{item.term}</dt>
          <dd className={clsx(css.metaValue, item.mono === true && css.mono)}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Render a hairline divider.
 * @returns the divider element.
 */
export function Divider() {
  return <hr className={css.divider} />
}
