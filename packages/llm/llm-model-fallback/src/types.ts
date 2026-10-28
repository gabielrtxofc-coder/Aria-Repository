/**
 * Durable vocabulary and failure categories for model-route fallback.
 *
 * @module @deepseek-ai/dsh-llm-model-fallback/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** Stable identity of one durable route switch in a Session log. */
export type ModelSwitchId = Branded<'ModelSwitchId'>

/**
 * Brand an implementation-minted switch identity.
 * @param id - opaque switch identity.
 * @returns the same string, branded; no validation is performed.
 */
export function ModelSwitchId(id: string): ModelSwitchId {
  return id as ModelSwitchId
}

/** One provider route named without request controls. */
export interface RouteRef {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/**
 * How a failed model request is classified for recovery.
 *
 * `transient` and `unavailable` may succeed on the same route later;
 * `quota`, `billing`, and `auth` describe a route that cannot serve the request
 * until an operator intervenes; `configuration` and `context` are request or
 * deployment defects that another model cannot fix; `unknown` covers codes
 * this build does not recognize.
 */
export type ModelFailureCategory =
  | 'transient'
  | 'unavailable'
  | 'quota'
  | 'billing'
  | 'auth'
  | 'configuration'
  | 'context'
  | 'unknown'

/**
 * Every failure category the classifier can return, in a stable order.
 *
 * The plugin configuration validates `switchOn` against this list, so a new
 * category becomes selectable without another constant to remember.
 */
export const MODEL_FAILURE_CATEGORIES: readonly ModelFailureCategory[] = [
  'transient', 'unavailable', 'quota', 'billing', 'auth', 'configuration', 'context', 'unknown',
]

/** Why one configured candidate was not selected. */
export type CandidateRejectionReason =
  | 'already-attempted'
  | 'provider-unregistered'
  | 'model-unknown'
  | 'capability-mismatch'

/** One configured candidate that could not serve the failed request. */
export interface RejectedCandidate {
  /** Candidate route that was rejected. */
  readonly route: RouteRef
  /** Exact reason it was rejected. */
  readonly reason: CandidateRejectionReason
}

/** Durable record of one route switch performed to continue a failed request. */
export interface ModelSwitchedEventData {
  /** Identity of this switch, reused by any log a reviewer correlates. */
  switchId: ModelSwitchId
  /** Turn that owned the failed request. */
  turn: number
  /** Step that owned the failed request. */
  step: number
  /** Classification of the failure that caused this switch. */
  category: ModelFailureCategory
  /** Serialized provider failure that triggered the switch. */
  failure: LlmFailure
  /** Route that failed. */
  from: RouteRef
  /** Route selected to continue the request. */
  to: RouteRef
  /** Configured candidates rejected before the selected route, in chain order. */
  rejected: RejectedCandidate[]
}

/** Durable record that no configured candidate could continue a failed request. */
export interface ModelFallbackExhaustedEventData {
  /** Turn that owned the failed request. */
  turn: number
  /** Step that owned the failed request. */
  step: number
  /** Classification of the failure that ended the recovery attempt. */
  category: ModelFailureCategory
  /** Serialized provider failure that ended the recovery attempt. */
  failure: LlmFailure
  /** Routes already tried or skipped during this turn. */
  attempted: RouteRef[]
  /** Configured candidates rejected while looking for an alternative. */
  rejected: RejectedCandidate[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Non-surface record that a failed model request continues on another route.
     * The next request header names the selected route, so the transcript stays
     * reconstructable from the log alone.
     */
    'llm/model-switched': ModelSwitchedEventData
    /**
     * Non-surface record that every configured alternative was unavailable, so
     * the failed step stays closed and the task pauses on its durable state.
     */
    'llm/model-fallback-exhausted': ModelFallbackExhaustedEventData
  }
}
