/**
 * Candidate eligibility for a failed model request.
 *
 * A configured route becomes eligible only when its provider is registered in
 * this process, its exact model resolves, it did not already fail in the
 * current turn, and it can reproduce what the retained conversation needs:
 * input modalities, the accepted reasoning effort, enough context capacity for
 * the next request, and the call shapes the history already carries. Every
 * rejection is reported with its exact reason so the durable switch record
 * explains what was skipped instead of silently choosing something else, and an
 * incompatible candidate never ends the search: the next compatible route in
 * chain order serves the retry.
 *
 * @module @deepseek-ai/dsh-llm-model-fallback/selection
 */

import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, Message, ModelModality } from '@deepseek-ai/dsh-llm'
import { routeKey, sameRoute, selectionOf } from './route.ts'
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
  /** Call shapes the retained conversation already carries. */
  readonly requiredShape: RequestShape
  /** Output tokens the next request reserves, when the header pinned a cap. */
  readonly outputTokens?: number
  /** Tokens the last reported request consumed, when the adapter reported usage. */
  readonly observedInputTokens?: number
  /** Cancellation for asynchronous model-metadata lookups. */
  readonly signal?: AbortSignal
}

/** Call shapes a retained conversation requires from the continuing route. */
export interface RequestShape {
  /** The history carries a system prompt appended after the first message. */
  readonly systemPromptInHistory: boolean
  /** The history carries tool declarations added or removed mid-conversation. */
  readonly toolUpdates: boolean
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
 * List the call shapes the retained conversation already depends on.
 *
 * A history whose system prompt sits after the first message is only readable
 * by a model that declares mid-conversation updates; the same holds for tool
 * declarations the loop added or removed later. A candidate that declares
 * neither would continue the task while silently ignoring part of its prompt.
 * @param messages - messages derived from the Session log.
 * @returns whether the history needs mid-conversation system prompts or tool updates.
 */
export function requiredRequestShape(messages: readonly Message[]): RequestShape {
  let systemPromptInHistory = false
  let toolUpdates = false
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' && index > 0) systemPromptInHistory = true
    if (message.role !== 'developer') continue
    if (message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      toolUpdates = true
    }
  }
  return { systemPromptInHistory, toolUpdates }
}

/** One candidate check result: either the rejection reason or nothing. */
function contextRejection(
  info: { contextWindow?: number },
  request: CandidateResolutionRequest,
): RejectedCandidate['reason'] | undefined {
  const required = request.observedInputTokens === undefined
    ? undefined
    : request.observedInputTokens + (request.outputTokens ?? 0)
  if (info.contextWindow !== undefined && required !== undefined && info.contextWindow < required) {
    return 'context-window-too-small'
  }
  return undefined
}

/**
 * Resolve which configured routes can serve a retried request.
 * @param request - chain, failing route, attempted routes, required capabilities, and runtime.
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
    let info: {
      contextWindow?: number
      systemPromptUpdate?: string
      toolUpdate?: string
    }
    try {
      const resolved = await request.llm.resolveModelInfo(candidate.provider, candidate.model, request.signal)
      modalities = resolved.inputModalities
      info = {
        ...resolved.context === undefined ? {} : { contextWindow: resolved.context.contextWindow },
        ...resolved.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: resolved.systemPromptUpdate },
        ...resolved.toolUpdate === undefined ? {} : { toolUpdate: resolved.toolUpdate },
      }
    } catch (error: unknown) {
      // Cancellation is the caller's signal, not a fact about the candidate.
      request.signal?.throwIfAborted()
      // An adapter that cannot describe this model cannot be trusted to serve it.
      rejected.push({ route, reason: 'model-unknown' })
      continue
    }
    if (modalities !== undefined && request.requiredModalities.some(needed => !modalities?.includes(needed))) {
      rejected.push({ route, reason: 'capability-mismatch' })
      continue
    }
    if (request.requiredShape.systemPromptInHistory && info.systemPromptUpdate !== 'in-history') {
      rejected.push({ route, reason: 'prompt-format-mismatch' })
      continue
    }
    if (request.requiredShape.toolUpdates && info.toolUpdate === undefined) {
      rejected.push({ route, reason: 'tool-format-mismatch' })
      continue
    }
    const contextMismatch = contextRejection(info, request)
    if (contextMismatch !== undefined) {
      rejected.push({ route, reason: contextMismatch })
      continue
    }
    try {
      // The adapter validates the controls it would receive, so a route that
      // cannot honor this candidate's declared reasoning effort is rejected
      // here rather than failing the request a second time.
      await request.llm.resolveCallConfig({ ...selectionOf(candidate) }, request.signal)
    } catch (error: unknown) {
      request.signal?.throwIfAborted()
      rejected.push({ route, reason: 'reasoning-effort-unsupported' })
      continue
    }
    eligible.push(candidate)
  }
  return { eligible, rejected }
}
