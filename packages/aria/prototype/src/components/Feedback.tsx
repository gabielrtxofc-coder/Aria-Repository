/**
 * Region states: loading, empty, unavailable, failed, and the spinner and
 * skeleton shapes they are built from.
 *
 * A screen never renders its own "nothing here" paragraph. It picks one of
 * these states and supplies the copy, so an empty mission list and an empty
 * knowledge collection read the same way.
 */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconWarningOutlineRegular, IconArchiveOutlineRegular, IconSearchOutlineRegular, IconRefreshOutlineRegular, IconLoadingOutlineRegular } from './primitives.tsx'
import css from './Feedback.module.css'

/**
 * Render a rotating spinner.
 * @param props.size - diameter in px (default 18).
 * @param props.tone - `accent` for dark-on-lime placement inside a filled button.
 * @param props.label - accessible name; the spinner is announced as a status.
 * @returns the spinner element.
 */
export function Spinner({ size = 18, tone = 'default', label }: {
  size?: number | undefined
  tone?: 'default' | 'accent'
  label?: string | undefined
}) {
  return (
    <span
      className={css.spinner}
      data-tone={tone}
      style={{ ['--size' as string]: `${size}px` }}
      role="status"
      aria-label={label}
    />
  )
}

/**
 * Render placeholder rows while a list region loads.
 * @param props.rows - number of rows (default 3).
 * @returns the skeleton block.
 */
export function SkeletonList({ rows = 3 }: { rows?: number | undefined }) {
  return (
    <div className={css.skeleton} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className={css.skeletonRow} key={index}>
          <span className={css.bar} data-width="short" />
          <span className={css.bar} data-width="mid" data-grow="" />
          <span className={css.bar} data-width="short" />
        </div>
      ))}
    </div>
  )
}

/** Which glyph a state shows. */
export type StateGlyph = 'empty' | 'search' | 'unavailable' | 'error' | 'loading'

/**
 * Render a region state: one glyph, a heading, a sentence and an optional action.
 * @param props.glyph - which icon to show.
 * @param props.tone - glyph tint; `accent` marks a positive empty, `danger` a failure.
 * @param props.title - the state's heading.
 * @param props.description - the sentence under it.
 * @param props.action - optional recovery control.
 * @param props.compact - tighter padding, for a state inside a card.
 * @param props.align - `start` left-aligns the block.
 * @returns the state element.
 */
export function RegionState({ glyph, tone = 'neutral', title, description, action, compact = false, align = 'center' }: {
  glyph: StateGlyph
  tone?: 'neutral' | 'accent' | 'danger'
  title: string
  description?: string | undefined
  action?: ReactNode
  compact?: boolean | undefined
  align?: 'center' | 'start'
}) {
  const icon = glyph === 'search'
    ? <IconSearchOutlineRegular size={18} />
    : glyph === 'unavailable'
      ? <IconArchiveOutlineRegular size={18} />
      : glyph === 'error'
        ? <IconWarningOutlineRegular size={18} />
        : glyph === 'loading'
          ? <IconLoadingOutlineRegular size={18} />
          : <IconArchiveOutlineRegular size={18} />
  return (
    <div className={css.state} data-compact={compact || undefined} data-align={align}>
      <span className={css.glyph} data-tone={tone}>{icon}</span>
      <span className={css.body}>
        <p className={css.title}>{title}</p>
        {description === undefined ? null : <p className={css.description}>{description}</p>}
      </span>
      {action === undefined ? null : <span className={css.action}>{action}</span>}
    </div>
  )
}

/**
 * Render the retry affordance an error state usually carries.
 * @param props.label - already-localized button text.
 * @param props.onRetry - retry handler.
 * @returns the retry button.
 */
export function RetryAction({ label, onRetry }: { label: string, onRetry: () => void }) {
  return <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={14} />} onClick={onRetry}>{label}</Button>
}

/**
 * Render a translucent busy scrim over a region that is re-fetching.
 * @param props.label - accessible name for the busy state.
 * @param props.className - extra class for layout placement.
 * @returns the scrim element.
 */
export function BusyOverlay({ label, className }: { label: string, className?: string | undefined }) {
  return (
    <div className={clsx(css.state, className)} role="status" aria-label={label} data-compact="">
      <Spinner label={label} />
    </div>
  )
}
