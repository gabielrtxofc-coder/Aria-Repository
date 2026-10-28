/**
 * Configured replacement routes and the route vocabulary they share with the
 * plugin entry point.
 *
 * Chain order is the preference order: the first candidate that is registered,
 * not yet attempted this turn, and able to accept the request's input
 * modalities serves the retried request. Deployment-varying choices are
 * configuration fields, never constants.
 *
 * @module @deepseek-ai/dsh-llm-model-fallback/route
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelFailureCategory, RouteRef } from './types.ts'

/** One configured replacement route. */
export interface ModelFallbackCandidateConfig {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort for this route; omission uses the route default. */
  reasoningEffort?: string
}

/** Immutable fallback policy captured when the plugin loads. */
export interface ResolvedModelFallbackPolicy {
  /** Ordered, validated replacement routes. */
  readonly chain: readonly ModelFallbackCandidateConfig[]
  /** Failure categories that may switch routes. */
  readonly switchOn: readonly ModelFailureCategory[]
  /** Switch allowance for one turn. */
  readonly maxSwitchesPerTurn: number
}

/**
 * Compare two routes for selection purposes, ignoring request controls.
 * @param left - one route.
 * @param right - the other route.
 * @returns whether both name the same provider and model.
 */
export function sameRoute(left: RouteRef, right: RouteRef): boolean {
  return left.provider === right.provider && left.model === right.model
}

/**
 * Render one route as a stable comparison key.
 * @param route - route to key.
 * @returns provider and model joined by a separator neither may contain.
 */
export function routeKey(route: RouteRef): string {
  return JSON.stringify([route.provider, route.model])
}

/**
 * Build the selection one configured route contributes to request routing.
 * @param route - configured candidate route.
 * @returns provider, model, and the optional configured reasoning effort.
 */
export function selectionOf(route: ModelFallbackCandidateConfig): ModelSelection {
  return {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
  }
}
