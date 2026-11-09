/**
 * Time formatting for the prototype.
 *
 * Screens show one of three shapes: a relative age ("12 min ago"), an absolute
 * stamp in a detail view, or a day bucket heading in the activity timeline. All
 * three take the current moment as an argument so tests and screenshots can pin
 * it instead of reading the clock.
 */

import type { Translate } from './locales/index.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Format the age of an instant relative to a reference moment.
 * @param instant - ISO-8601 instant.
 * @param now - ISO-8601 reference moment.
 * @param t - the dictionary resolver, which owns the unit labels.
 * @returns a short age such as "3 min ago" or "2 d ago".
 */
export function relativeAge(instant: string, now: string, t: Translate): string {
  const delta = Date.parse(now) - Date.parse(instant)
  if (!Number.isFinite(delta) || delta < MINUTE) return t('common.now')
  if (delta < HOUR) return t('common.minutesAgo', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return t('common.hoursAgo', { count: Math.floor(delta / HOUR) })
  return t('common.daysAgo', { count: Math.floor(delta / DAY) })
}

/**
 * Format an instant as a wall-clock stamp.
 * @param instant - ISO-8601 instant.
 * @param now - ISO-8601 reference moment, which picks the timezone offset.
 * @returns a stamp such as "09:38" or, on another day, "Nov 7, 14:02".
 */
export function absoluteStamp(instant: string, now: string): string {
  const value = new Date(instant)
  const reference = new Date(now)
  const sameDay = value.getUTCFullYear() === reference.getUTCFullYear()
    && value.getUTCMonth() === reference.getUTCMonth()
    && value.getUTCDate() === reference.getUTCDate()
  const time = `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`
  if (sameDay) return time
  const month = value.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
  return `${month} ${value.getUTCDate()}, ${time}`
}

/**
 * Group an instant into a day bucket for the activity timeline.
 * @param instant - ISO-8601 instant.
 * @param now - ISO-8601 reference moment.
 * @param t - the dictionary resolver, which owns the bucket labels.
 * @returns "today", "yesterday" or "earlier" as localized text.
 */
export function dayBucket(instant: string, now: string, t: Translate): string {
  const reference = Date.parse(now)
  const value = Date.parse(instant)
  if (value >= reference - DAY) return t('activity.today')
  if (value >= reference - 2 * DAY) return t('activity.yesterday')
  return t('activity.earlier')
}

/**
 * Render a signed percentage for a metric delta.
 * @param delta - the change as a percent.
 * @returns the value with an explicit sign, or an em dash for no change.
 */
export function formatDelta(delta: number | null): string {
  if (delta === null || delta === 0) return '—'
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`
}
