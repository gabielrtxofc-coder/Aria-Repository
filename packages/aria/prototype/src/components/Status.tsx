/**
 * Status vocabulary: the dot, the badge, and the system indicator.
 *
 * Three components share one tone map, so a mission that reads "awaiting" on
 * the dashboard reads the same word, the same color, and the same dot in the
 * mission list and in the activity timeline.
 */

import clsx from 'clsx'
import css from './Status.module.css'
import type { Translate } from '../locales/index.ts'

/** The palette tone a status resolves to. */
export type StatusTone = 'active' | 'waiting' | 'review' | 'done' | 'failed' | 'idle'

/**
 * Render a status dot.
 * @param props.tone - which status the dot reports.
 * @param props.pulse - animate the dot; reserved for work in flight.
 * @param props.size - dot diameter in px (default 7).
 * @param props.className - extra class for layout placement.
 * @returns the dot element, hidden from assistive technology; pair with text.
 */
export function StatusDot({ tone, pulse = false, size = 7, className }: {
  tone: StatusTone
  pulse?: boolean | undefined
  size?: number | undefined
  className?: string | undefined
}) {
  return (
    <span
      data-status-dot={tone}
      data-pulse={pulse || undefined}
      className={clsx(css.dot, className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}

/**
 * Render a status badge: a dot and a word in a tinted capsule.
 * @param props.tone - which status the badge reports.
 * @param props.label - already-localized status word.
 * @param props.pulse - animate the dot for work in flight.
 * @param props.className - extra class for layout placement.
 * @returns the badge element.
 */
export function StatusBadge({ tone, label, pulse = false, className }: {
  tone: StatusTone
  label: string
  pulse?: boolean | undefined
  className?: string | undefined
}) {
  return (
    <span data-status-badge={tone} className={clsx(css.badge, className)}>
      <StatusDot tone={tone} pulse={pulse} size={6} />
      {label}
    </span>
  )
}

/**
 * Render the workspace's system status: a dot, the state word, and the
 * measured load beside it.
 * @param props.state - system state, which picks the tone and the word.
 * @param props.label - already-localized state word.
 * @param props.load - already-formatted scheduler load, e.g. "38%".
 * @param props.queue - number of queued runs.
 * @param props.t - the dictionary resolver.
 * @returns the indicator element.
 */
export function SystemIndicator({ state, label, load, queue, t }: {
  state: 'nominal' | 'degraded' | 'maintenance'
  label: string
  load: string
  queue: number
  t: Translate
}) {
  const tone: StatusTone = state === 'nominal' ? 'active' : state === 'degraded' ? 'waiting' : 'review'
  return (
    <span className={css.system} data-system-state={state}>
      <StatusDot tone={tone} pulse={state === 'nominal'} />
      <span className={css.systemLabel}>{label}</span>
      <span className={css.systemDivider} aria-hidden="true" data-system-divider="" />
      <span className={css.systemMeta} data-system-meta="">
        {t('status.load')} {load}
      </span>
      <span className={css.systemMeta} data-system-meta="">
        {t('status.queue')} {queue}
      </span>
    </span>
  )
}
