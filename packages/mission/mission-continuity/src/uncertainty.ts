/**
 * The arithmetic of unknown outcomes: what a session log records as doubtful,
 * and how much of that a mission still owes a human review for.
 *
 * Both numbers are pure functions of durable facts — the bounded doubt window the
 * projection keeps, how many doubts that window could not name, and how many a
 * review covered — so the recovery sweep and the mission service cannot disagree
 * about whether a mission may continue, and neither has to remember anything the
 * session log does not already hold.
 * @module @deepseek-ai/dsh-mission-continuity
 */

import type { UncertainBacklog, UncertainOperation } from './types.ts'

/**
 * How many unknown outcomes one session records, whether or not the bounded
 * window can name them.
 *
 * The count is what an acknowledgement covers, so it must not depend on how many
 * names the window happened to hold: every recorded doubt is counted once, and a
 * doubt displaced out of the window is counted rather than forgotten.
 * @param operations - the bounded window of recorded doubts.
 * @param unlisted - recorded doubts that window could not name.
 * @returns the number of doubts the log records.
 */
export function recordedUncertainty(
  operations: readonly UncertainOperation[],
  unlisted: number,
): number {
  return operations.length + unlisted
}

/**
 * The unknown outcomes one mission still owes a human review for.
 *
 * A review covers exactly the doubts it was shown. The durable record counts how
 * many those were, in the order the log recorded them, and the bounded window
 * holds the newest doubts — so the outstanding ones are the last
 * `recorded - acknowledged` entries, and anything the log gained after the review
 * is outstanding again. That is what stops one decision from clearing a later
 * one: a doubt nobody has looked at has never been part of any acknowledgement,
 * and an external effect nobody confirmed must not be walked past.
 *
 * An acknowledgement that does not fit the recorded doubts — a count beyond what
 * the log can show — clears nothing at all. Recovery prefers asking a person
 * twice to resuming work past an effect nobody verified.
 * @param operations - the bounded window of recorded doubts, oldest first.
 * @param unlisted - recorded doubts that window could not name.
 * @param acknowledged - how many recorded doubts a human review cleared.
 * @returns the doubts recovery must still stop for, with what it can name.
 */
export function unacknowledgedUncertainty(
  operations: readonly UncertainOperation[],
  unlisted: number,
  acknowledged: number | undefined,
): UncertainBacklog {
  const recorded = recordedUncertainty(operations, unlisted)
  const cleared = acknowledged ?? 0
  if (cleared < 0 || cleared > recorded) return { operations, unlisted, count: recorded }
  const outstanding = recorded - cleared
  return {
    operations: outstanding >= operations.length
      ? operations
      : operations.slice(operations.length - outstanding),
    unlisted: Math.max(0, outstanding - operations.length),
    count: outstanding,
  }
}
