/**
 * Page-level controls: the page header, filter chips, the search field, the
 * progress bar, the metric block and the prototype notice.
 */

import { forwardRef, useId, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconCloseOutlineRegular, IconSparkleRegular } from './primitives.tsx'
import { GlyphSearch } from './icons.tsx'
import css from './Controls.module.css'

/**
 * Render the header every screen opens with: eyebrow, title, subtitle and the
 * screen's primary actions.
 * @param props.title - the screen name.
 * @param props.subtitle - one sentence on what the screen is for.
 * @param props.eyebrow - small capitalised label above the title.
 * @param props.actions - primary and secondary controls.
 * @param props.titleId - id the main landmark points at, so the heading is the
 *   accessible name of the screen.
 * @returns the header element.
 */
export function PageHeader({ title, subtitle, eyebrow, actions, titleId }: {
  title: string
  subtitle?: string | undefined
  eyebrow?: string | undefined
  actions?: ReactNode
  titleId?: string | undefined
}) {
  return (
    <header className={css.pageHeader}>
      <div className={css.pageHeading}>
        {eyebrow === undefined ? null : <span className={css.pageEyebrow}>{eyebrow}</span>}
        <h1 className={css.pageTitle} id={titleId} tabIndex={-1}>{title}</h1>
        {subtitle === undefined ? null : <p className={css.pageSubtitle}>{subtitle}</p>}
      </div>
      {actions === undefined ? null : <div className={css.pageActions}>{actions}</div>}
    </header>
  )
}

/** One chip of a {@link FilterRow}. */
export interface FilterOption<Value extends string> {
  readonly value: Value
  readonly label: string
  /** Optional count rendered inside the chip. */
  readonly count?: number | undefined
}

/**
 * Render a row of mutually exclusive filter chips.
 * @param props.options - the filter options, in display order.
 * @param props.value - the selected option.
 * @param props.onChange - selection handler.
 * @param props.label - accessible name for the group.
 * @param props.className - extra class for layout placement.
 * @param props.scroll - keep the chips on one line and scroll horizontally instead of wrapping.
 * @returns the group element.
 */
export function FilterRow<Value extends string>({ options, value, onChange, label, className, scroll = false }: {
  options: readonly FilterOption<Value>[]
  value: Value
  onChange: (value: Value) => void
  label: string
  className?: string | undefined
  /** Keep the chips on one line and scroll them when the row is out of room. */
  scroll?: boolean | undefined
}) {
  return (
    <div className={clsx(css.filterRow, className)} role="group" aria-label={label} data-scroll={scroll || undefined}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className={css.filterChip}
          aria-pressed={option.value === value}
          onClick={() => { onChange(option.value) }}
        >
          {option.label}
          {option.count === undefined ? null : <span className={css.filterCount}>{option.count}</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * Render a search field with a leading glyph, an optional trailing key hint and
 * a clear button once the field has text.
 * @param props.value - current text.
 * @param props.onChange - change handler receiving the new text.
 * @param props.placeholder - already-localized placeholder.
 * @param props.label - accessible name.
 * @param props.hint - key hint shown on the trailing edge while empty.
 * @param props.clearLabel - accessible name of the clear button.
 * @param props.className - extra class for layout placement.
 * @param ref - forwarded to the native input, so a screen can focus it.
 * @returns the field wrapper.
 */
export const SearchField = forwardRef<HTMLInputElement, {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  hint?: string | undefined
  clearLabel: string
  className?: string | undefined
}>(function SearchField({ value, onChange, placeholder, label, hint, clearLabel, className }, ref) {
  return (
    <span className={clsx(css.searchField, className)}>
      <GlyphSearch size={15} />
      <input
        ref={ref}
        type="search"
        className={css.searchInput}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={event => { onChange(event.currentTarget.value) }}
      />
      {value === '' ? (hint === undefined ? null : <kbd className={css.shortcut}>{hint}</kbd>) : (
        <button type="button" className={css.searchClear} aria-label={clearLabel} onClick={() => { onChange('') }}>
          <IconCloseOutlineRegular size={12} />
        </button>
      )}
    </span>
  )
})

/** The tone a progress bar takes, derived from what it is reporting. */
export type ProgressTone = 'accent' | 'muted' | 'warn' | 'danger' | 'review'

/**
 * Render a determinate progress bar.
 * @param props.value - completion in whole percent, clamped to 0-100.
 * @param props.tone - which color the fill takes.
 * @param props.label - accessible name; the bar reports itself as a progressbar.
 * @param props.size - track height in px (default 4).
 * @returns the bar element.
 */
export function ProgressBar({ value, tone = 'accent', label, size }: {
  value: number
  tone?: ProgressTone | undefined
  label: string
  size?: number | undefined
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <div
      className={css.progress}
      data-tone={tone === 'accent' ? undefined : tone}
      role="progressbar"
      aria-label={label}
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ ['--value' as string]: `${clamped}%`, ...(size === undefined ? {} : { height: size }) }}
    >
      <span className={css.progressFill} />
    </div>
  )
}

/**
 * Render a labelled figure with an optional period delta and a supporting line.
 * @param props.label - what the figure measures.
 * @param props.value - the figure, already formatted.
 * @param props.detail - one supporting sentence.
 * @param props.delta - preformatted change since the previous period, e.g. "+2".
 * @param props.tone - accent or warning emphasis.
 * @returns the metric block.
 */
export function Metric({ label, value, detail, delta, tone = 'neutral' }: {
  label: string
  value: string
  detail?: string | undefined
  delta?: string | null | undefined
  tone?: 'neutral' | 'accent' | 'warn'
}) {
  return (
    <div className={css.metric} data-tone={tone === 'neutral' ? undefined : tone}>
      <span className={css.metricLabel}>{label}</span>
      <span className={css.metricRow}>
        <span className={css.metricValue}>{value}</span>
        {delta === undefined || delta === null ? null : (
          <span className={css.metricDelta} data-direction={delta.startsWith('+') ? 'up' : delta.startsWith('-') || delta.startsWith('−') ? 'down' : 'flat'}>
            {delta.startsWith('-') || delta.startsWith('−') ? delta.replace('-', '−') : delta}
          </span>
        )}
      </span>
      {detail === undefined ? null : <p className={css.metricDetail}>{detail}</p>}
    </div>
  )
}

/**
 * Render the prototype's data disclaimer.
 * @param props.text - already-localized sentence.
 * @param props.className - extra class for layout placement.
 * @returns the notice element.
 */
export function PrototypeNotice({ text, className }: { text: string, className?: string | undefined }) {
  return (
    <p className={clsx(css.notice, className)}>
      <span className={css.noticeGlyph}><IconSparkleRegular size={13} /></span>
      {text}
    </p>
  )
}

/** One tab of a {@link TabStrip}. */
export interface TabOption<Value extends string> {
  readonly value: Value
  readonly label: string
  readonly icon?: ReactNode
}

/**
 * Render a compact tab strip.
 * @param props.options - tabs in display order.
 * @param props.value - the selected tab.
 * @param props.onChange - selection handler.
 * @param props.label - accessible name for the tab list.
 * @returns the tab list.
 */
export function TabStrip<Value extends string>({ options, value, onChange, label }: {
  options: readonly TabOption<Value>[]
  value: Value
  onChange: (value: Value) => void
  label: string
}) {
  const id = useId()
  return (
    <div className={css.tabs} role="tablist" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="tab"
          id={`${id}-${option.value}`}
          className={css.tab}
          aria-selected={option.value === value}
          aria-controls={`${id}-${option.value}-panel`}
          onClick={() => { onChange(option.value) }}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  )
}
