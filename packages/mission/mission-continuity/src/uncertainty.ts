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

import { MAX_DIAGNOSTIC_LENGTH } from './runtime.ts'
import type { MissionUncertaintyScope, UncertainBacklog, UncertainOperation } from './types.ts'

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

/** One authorization's frozen scope and the exact bounded message shown for it. */
export interface PresentedUncertaintyScope {
  /** Durable scope stored on the mission authorization. */
  readonly scope: MissionUncertaintyScope
  /** Human-facing diagnostic rendered only from the stored scope. */
  readonly message: string
}

/** Freeze a scope and its nested operation records against caller mutation. */
export function freezeUncertaintyScope(scope: MissionUncertaintyScope): MissionUncertaintyScope {
  const operations = Object.freeze(scope.operations.map(operation => Object.freeze({ ...operation })))
  return Object.freeze({ ...scope, operations })
}

/**
 * Freeze and render the uncertainty interval at authorization time.
 *
 * The watermark is the ordinal of the last `TOOL_OUTCOME_UNKNOWN` result already
 * in the session log. Later results receive larger ordinals, even if they push
 * an older identity out of the projection's bounded window. The persisted
 * interval plus identities printed in the message is therefore independent of
 * future fan-out completion order and survives index reconstruction.
 *
 * @param from - previously acknowledged watermark.
 * @param through - total unknown results already recorded at capture time.
 * @param backlog - exact unacknowledged doubts to present.
 * @returns immutable scope and a message bounded to the durable diagnostic limit.
 */
export function presentUncertaintyScope(
  from: number,
  through: number,
  backlog: UncertainBacklog,
): PresentedUncertaintyScope {
  if (!Number.isSafeInteger(from) || from < 0
    || !Number.isSafeInteger(through) || through < from
    || backlog.count !== through - from
    || backlog.operations.length + backlog.unlisted !== backlog.count) {
    throw new Error('uncertainty authorization scope does not match its durable watermark')
  }
  const shown: UncertainOperation[] = []
  const head = `Interrupted tool calls whose outcome is unknown: ${backlog.count} recorded`
  const trailer = '. Verify the external state before this mission continues.'
  const format = (operations: readonly UncertainOperation[], unlisted: number): string => {
    const details = operations.length === 0
      ? ''
      : ` (${operations.map(operation => `${operation.name} [${operation.callId}]`).join(', ')}`
        + `${unlisted > 0 ? `, and ${unlisted} more` : ''})`
    const aggregate = operations.length === 0 && unlisted > 0 ? ` (${unlisted} identities not listed)` : ''
    return `${head}${details || aggregate}${trailer}`
  }
  for (const operation of backlog.operations) {
    const candidate = [...shown, operation]
    const remaining = backlog.count - candidate.length
    if (format(candidate, remaining).length > MAX_DIAGNOSTIC_LENGTH) break
    shown.push(operation)
  }
  const unlisted = backlog.count - shown.length
  const scope = freezeUncertaintyScope({ from, through, operations: shown, unlisted })
  const message = format(shown, unlisted).slice(0, MAX_DIAGNOSTIC_LENGTH)
  return { scope, message }
}
