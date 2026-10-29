/**
 * Autonomous continuation of a task whose turn no longer has an owner.
 *
 * Crash repair balances an interrupted log with synthetic closers (unknown tool
 * outcomes included) and marks the closing `turn/end` as `interrupted`; an
 * exhausted fallback chain ends its turn with an error and leaves a durable
 * pause. Both leave the task with work left and nobody driving it. A resumed
 * Session can be driven again by the harness itself, but only when the
 * deployment asks for it: a resumed Session is otherwise the user's turn to
 * speak, and a Web or SDK surface must not start spending tokens unasked.
 *
 * @module @deepseek-ai/dsh-llm-model-fallback/continuation
 */

import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelFallbackState } from './state.ts'
import type { ResolvedModelFallbackPolicy } from './route.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Harness-authored continuation of a task that lost its turn owner. */
    'model-fallback-recovery': { kind: 'model-fallback-recovery' } & { form: 'notice', summary: string }
  }
}

/** Source kind distinguishing a harness continuation from a human message. */
export const RECOVERY_SOURCE_KIND = 'model-fallback-recovery'

/** Instruction carried into the continued turn. */
export const CONTINUATION_TEXT = [
  'The previous turn was interrupted before it completed; no user message follows this one.',
  'Continue the task from the durable state in this transcript: do not repeat completed steps.',
  'A tool result marked with TOOL_OUTCOME_UNKNOWN means the call started but its outcome was never',
  'recorded. Verify external state first, and do not repeat a call that may have side effects.',
].join(' ')

/**
 * Decide whether a resumed Session continues by itself.
 * @param state - durable fallback state folded from the resumed log.
 * @param policy - resolved plugin policy, including the opt-in and attempt bound.
 * @param source - creation source reported by `agent/created`.
 * @returns the continuation message to admit, or undefined to leave the Session idle.
 */
export function continuationFor(
  state: ModelFallbackState,
  policy: ResolvedModelFallbackPolicy,
  source: string,
): UserMessage | undefined {
  if (!policy.resumeInterruptedTurns) return undefined
  // Only a resumed Session is continued: a fresh one has no work of its own.
  if (source !== 'resume') return undefined
  if (state.interrupted === null && state.paused === null) return undefined
  if (state.recoveryAttempts >= policy.maxRecoveryAttempts) return undefined
  const reason = state.interrupted !== null
    ? `turn ${state.interrupted.turn} was interrupted`
    : `turn ${state.paused?.turn ?? 0} step ${state.paused?.step ?? 0} paused after ${state.paused?.category ?? 'unknown'}`
  return createUserMessage({
    content: [{ type: 'text', text: CONTINUATION_TEXT }],
    source: {
      kind: RECOVERY_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(`${reason}; continuing the task automatically`),
    },
  })
}
