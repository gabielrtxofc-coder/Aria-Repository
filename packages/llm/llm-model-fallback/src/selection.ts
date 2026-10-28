/**
 * Candidate eligibility for a failed model request.
 *
 * A configured route becomes eligible only when its provider is registered in
 * this process, its exact model resolves, it did not already fail in the
 * current turn, and it can accept the input modalities the retained
 * conversation needs. Every rejection is reported so the durable switch record
 * explains what was skipped instead of silently choosing something else.
 *
 * @module @deepseek-ai/dsh-llm-model-fallback/selection
 */

import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, Message, ModelModality } from '@deepseek-ai/dsh-llm'
import { routeKey, sameRoute } from './route.ts'
import type { ModelFallbackCandidateConfig } from './route.ts'
import type { RejectedCandidate, RouteRef } from './types.ts'

/** Inputs one candidate resolution reads. */
export interface CandidateResolutionRequest {
  /** Live model runtime that owns the registered provider routes. */
  readonly llm: LlmRuntime
  /** Configured replacement routes in preference order. */
  readonly chain: readonly ModelFallbackCandidateConfig[]
  /** Route whose request failed. */
  readonly failed: RouteRef
  /** Routes already tried during the current turn. */
  readonly attempted: readonly RouteRef[]
  /** Input modalities the retained conversation requires. */
  readonly requiredModalities: readonly ModelModality[]
  /** Cancellation for asynchronous model-metadata lookups. */
  readonly signal?: AbortSignal
}

/** Eligibility outcome for one failed request. */
export interface CandidateResolution {
  /** Eligible routes in chain order; the first one serves the retry. */
  readonly eligible: readonly ModelFallbackCandidateConfig[]
  /** Routes rejected on the way, in chain order. */
  readonly rejected: readonly RejectedCandidate[]
}

/**
 * List the input modalities the retained conversation requires from a model.
 * Only declared requirements are returned: a text-only conversation asks for
 * nothing, so an adapter that advertises no modality list stays eligible.
 * @param messages - messages derived from the Session log.
 * @returns required modalities, deduplicated and stably ordered.
 */
export function requiredInputModalities(messages: readonly Message[]): readonly ModelModality[] {
  return messages.some(message => contentHasImage(message.content)) ? ['image'] : []
}

/**
 * Resolve which configured routes can serve a retried request.
 * @param request - chain, failing route, attempted routes, required modalities, and runtime.
 * @returns eligible candidates and the rejected ones with reasons.
 */
export async function resolveCandidates(request: CandidateResolutionRequest): Promise<CandidateResolution> {
  const providers = new Set(request.llm.listProviders().map(provider => provider.id))
  const attempted = new Set(request.attempted.map(routeKey))
  const eligible: ModelFallbackCandidateConfig[] = []
  const rejected: RejectedCandidate[] = []
  for (const candidate of request.chain) {
    const route: RouteRef = { provider: candidate.provider, model: candidate.model }
    if (sameRoute(route, request.failed) || attempted.has(routeKey(route))) {
      rejected.push({ route, reason: 'already-attempted' })
      continue
    }
    if (!providers.has(candidate.provider)) {
      rejected.push({ route, reason: 'provider-unregistered' })
      continue
    }
    let modalities: readonly ModelModality[] | undefined
    try {
      modalities = (await request.llm.resolveModelInfo(candidate.provider, candidate.model, request.signal)).inputModalities
    } catch (_unresolvableModel) {
      // An adapter that cannot describe this model cannot be trusted to serve it.
      rejected.push({ route, reason: 'model-unknown' })
      continue
    }
    if (modalities !== undefined && request.requiredModalities.some(needed => !modalities.includes(needed))) {
      rejected.push({ route, reason: 'capability-mismatch' })
      continue
    }
    eligible.push(candidate)
  }
  return { eligible, rejected }
}
