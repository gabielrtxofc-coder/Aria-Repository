/**
 * Model-route fallback on the agent loop's request-recovery extension point.
 *
 * The task belongs to the harness, not to a model: when a route can no longer
 * serve a request, this plugin keeps the open step alive on a configured
 * alternative, records the switch durably, and lets the loop rebuild the
 * request from the session log. Transient failures stay with the retry policy
 * first; this plugin decides only after downstream recovery declined.
 *
 * @module @deepseek-ai/dsh-llm-model-fallback
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, ModelRouteOverride } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { classifyModelFailure } from './classification.ts'
import { continuationFor } from './continuation.ts'
import { requiredInputModalities, requiredRequestShape, resolveCandidates } from './selection.ts'
import { routeKey, sameRoute, selectionOf } from './route.ts'
import type { ModelFallbackCandidateConfig, ResolvedModelFallbackPolicy } from './route.ts'
import { INITIAL_STATE, modelFallbackProjection } from './state.ts'
import type { ActiveFallbackRoute, ModelFallbackState } from './state.ts'
import { MODEL_FAILURE_CATEGORIES, ModelSwitchId } from './types.ts'
import type { FallbackExhaustionCause, ModelFailureCategory, RejectedCandidate, RouteRef } from './types.ts'

export type { ModelFallbackCandidateConfig, ResolvedModelFallbackPolicy } from './route.ts'
export { routeKey, sameRoute, selectionOf } from './route.ts'
export { classifyModelFailure } from './classification.ts'
export { requiredInputModalities, requiredRequestShape, resolveCandidates } from './selection.ts'
export type { CandidateResolution, CandidateResolutionRequest, RequestShape } from './selection.ts'
export { CONTINUATION_TEXT, continuationFor, RECOVERY_SOURCE_KIND } from './continuation.ts'
export { INITIAL_STATE, modelFallbackProjection } from './state.ts'
export type { ActiveFallbackRoute, ModelFallbackState } from './state.ts'
export { MODEL_FAILURE_CATEGORIES, ModelSwitchId }
export type {
  CandidateRejectionReason,
  FallbackExhaustionCause,
  ModelFailureCategory,
  ModelFallbackExhaustedEventData,
  ModelSwitchedEventData,
  RejectedCandidate,
  RouteRef,
  RouteSelection,
} from './types.ts'

/** Plugin configuration for model-route fallback. */
export interface Config {
  /** Ordered replacement routes; an empty list leaves the failure terminal. */
  chain: ModelFallbackCandidateConfig[]
  /**
   * Failure categories that may switch routes. Defaults to
   * `transient`, `unavailable`, `quota`, and `billing`; `auth` switching is
   * opt-in because a malformed credential is a configuration defect.
   */
  switchOn?: ModelFailureCategory[]
  /** Switches allowed in one turn; defaults to the chain length. */
  maxSwitchesPerTurn?: number
  /**
   * Continue a task whose turn was interrupted or left paused by an exhausted
   * chain when the Session is resumed, without waiting for a new user message.
   * Defaults to off: a resumed Session is normally the user's turn to speak.
   */
  resumeInterruptedTurns?: boolean
  /** Automatic continuation turns allowed after the last human message; defaults to 1. */
  maxRecoveryAttempts?: number
}

const DEFAULT_SWITCH_ON: readonly ModelFailureCategory[] = ['transient', 'unavailable', 'quota', 'billing']

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  chain: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  })).required(),
  switchOn: z.array(z.union(MODEL_FAILURE_CATEGORIES.map(category => z.const(category)))).default([...DEFAULT_SWITCH_ON]),
  maxSwitchesPerTurn: z.number().step(1).min(0),
  resumeInterruptedTurns: z.boolean().default(false),
  maxRecoveryAttempts: z.number().step(1).min(0),
})

const CANDIDATE_KEYS: ReadonlySet<string> = new Set(['provider', 'model', 'reasoningEffort'])
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'chain',
  'switchOn',
  'maxSwitchesPerTurn',
  'resumeInterruptedTurns',
  'maxRecoveryAttempts',
])

function isCategory(value: string): value is ModelFailureCategory {
  return (MODEL_FAILURE_CATEGORIES as readonly string[]).includes(value)
}

function validateKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
}

function resolveCandidate(value: unknown, path: string): ModelFallbackCandidateConfig {
  if (typeof value !== 'object' || value === null) throw new Error(`${path} must be an object`)
  const candidate: Record<string, unknown> = value as Record<string, unknown>
  validateKeys(candidate, CANDIDATE_KEYS, path)
  const { provider, model, reasoningEffort } = candidate
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error(`${path}.provider must be a non-empty string`)
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(`${path}.model must be a non-empty string`)
  }
  if (reasoningEffort !== undefined
    && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
    throw new Error(`${path}.reasoningEffort must be a non-empty string when present`)
  }
  return Object.freeze({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  })
}

/**
 * Validate, default, and detach one fallback policy.
 * @param config - plugin configuration; omission uses an empty chain.
 * @param path - diagnostic path naming the owning plugin entry.
 * @returns an immutable policy safe to capture for the plugin lifetime.
 */
export function resolveModelFallbackPolicy(
  config: Config | undefined,
  path: string,
): ResolvedModelFallbackPolicy {
  if (config === undefined) {
    return Object.freeze({
      chain: Object.freeze([]),
      switchOn: Object.freeze([...DEFAULT_SWITCH_ON]),
      maxSwitchesPerTurn: 0,
      resumeInterruptedTurns: false,
      maxRecoveryAttempts: 0,
    })
  }
  validateKeys(config, CONFIG_KEYS, path)
  if (!Array.isArray(config.chain)) throw new Error(`${path}.chain must be an array`)
  const seen = new Set<string>()
  const chain = config.chain.map((candidate, index) => {
    const resolved = resolveCandidate(candidate, `${path}.chain[${index}]`)
    const key = routeKey(resolved)
    if (seen.has(key)) throw new Error(`${path}.chain must not repeat the route ${resolved.provider}/${resolved.model}`)
    seen.add(key)
    return resolved
  })

  const switchOn = config.switchOn ?? [...DEFAULT_SWITCH_ON]
  if (!Array.isArray(switchOn) || switchOn.length === 0) {
    throw new Error(`${path}.switchOn must be a non-empty array of failure categories`)
  }
  const checkedCategories: ModelFailureCategory[] = []
  for (const category of switchOn) {
    if (typeof category !== 'string' || !isCategory(category)) {
      throw new Error(`${path}.switchOn must contain only ${MODEL_FAILURE_CATEGORIES.join(', ')}`)
    }
    if (checkedCategories.includes(category)) throw new Error(`${path}.switchOn must not repeat "${category}"`)
    checkedCategories.push(category)
  }

  const maxSwitchesPerTurn = config.maxSwitchesPerTurn ?? chain.length
  if (!Number.isSafeInteger(maxSwitchesPerTurn) || maxSwitchesPerTurn < 0) {
    throw new Error(`${path}.maxSwitchesPerTurn must be a non-negative safe integer`)
  }

  const resumeInterruptedTurns = config.resumeInterruptedTurns ?? false
  if (typeof resumeInterruptedTurns !== 'boolean') {
    throw new Error(`${path}.resumeInterruptedTurns must be a boolean`)
  }
  const maxRecoveryAttempts = config.maxRecoveryAttempts ?? 1
  if (!Number.isSafeInteger(maxRecoveryAttempts) || maxRecoveryAttempts < 0) {
    throw new Error(`${path}.maxRecoveryAttempts must be a non-negative safe integer`)
  }

  return Object.freeze({
    chain: Object.freeze(chain),
    switchOn: Object.freeze(checkedCategories),
    maxSwitchesPerTurn,
    resumeInterruptedTurns,
    maxRecoveryAttempts,
  })
}

export const name = 'llm-model-fallback'
export const inject = ['agents', 'sessionProjections', 'llm']

/** Non-serializable hooks that keep switch identities deterministic in tests. */
export interface ModelFallbackInternals {
  /** Mint one switch identity; defaults to a random UUID. */
  switchId?: () => string
}

/**
 * Project one durable recovery route onto the live override registry.
 * @param active - folded recovery route in force.
 * @returns the override a request listener reads, with both route ends copied.
 */
function overrideOf(active: ActiveFallbackRoute): ModelRouteOverride {
  return {
    route: selectionOf(active.route),
    replaces: { ...active.replaces },
    ...active.previous === null ? {} : { previous: { ...active.previous } },
  }
}

/** Non-surface events this plugin appends; they never reach derived messages. */
const LOG_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set(['llm/model-switched', 'llm/model-fallback-exhausted'])

/**
 * Install model-route fallback and its durable projection.
 * @param ctx - plugin context that owns the listeners and switch records.
 * @param config - configured replacement chain and switch policy.
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config, internals: ModelFallbackInternals = {}): void {
  const policy: ResolvedModelFallbackPolicy = resolveModelFallbackPolicy(config, 'llm-model-fallback')
  ctx.sessionProjections.register(modelFallbackProjection)
  const mintSwitchId = internals.switchId ?? randomUUID
  const lifetime = new AbortController()

  function readState(session: Session): ModelFallbackState {
    /* v8 ignore next -- the plugin registers its own projection before any Agent exists */
    return ctx.sessionProjections.stateOf(session, 'llmModelFallback') ?? INITIAL_STATE
  }

  /**
   * Force the buffered Session events onto durable storage before the retried
   * request depends on them.
   *
   * The backend batches live appends, so a switch record that is only appended
   * would be lost by a crash between the append and the batch window, and the
   * restarted task would re-run the failed route. A rejected flush leaves the
   * events buffered for the next drain (the backend retries), so the in-process
   * recovery still proceeds and the failure is reported, never hidden.
   * @param session - Session whose switch record must be durable.
   */
  async function persist(session: Session): Promise<void> {
    const sessions = ctx.get('sessions')
    /* v8 ignore next -- a composition without a persistence service keeps recovery in memory */
    if (sessions === undefined) return
    try {
      await sessions.flush(session)
    } catch (error: unknown) {
      ctx.logger.error(
        `llm-model-fallback: session "${session.id}" could not confirm the switch record reached storage `
        + `(${String(error)}); the events stay buffered for the next flush`,
      )
    }
  }

  /** Re-apply the recovered route to one request that would otherwise retry the failed one. */
  function overrideConfig(agent: Agent, config: LlmCallConfig): LlmCallConfig {
    const override = ctx.get('modelRouting')?.overrideFor(agent.ctx)
    if (override === undefined) return config
    // A request is standing in for the entry point's own route or for the
    // replacement it already replaced; every later step seeds from the last
    // logged header, so both ends describe the same recovery.
    const replacesRequestedRoute = sameRoute(config, override.replaces)
      || (override.previous !== undefined && sameRoute(config, override.previous))
    if (!replacesRequestedRoute) return config
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = config
    return { ...withoutInheritedEffort, ...selectionOf(override.route) }
  }

  ctx.on('agent/request', async ({ agent }, next) => overrideConfig(agent, await next()), { prepend: true })

  ctx.on('agent/created', ({ agent, source }) => {
    const routing = ctx.get('modelRouting')
    const state = readState(agent.session)
    /* v8 ignore next -- `inject` guarantees the Agent registry, which owns ctx.modelRouting */
    if (routing === undefined) return
    const { active } = state
    if (active === null) routing.clearOverride(agent.ctx)
    else routing.setOverride(agent.ctx, overrideOf(active))
    // A resumed task that lost its turn owner is driven again here, before the
    // Agent is published, so no human message has to restart it.
    const continuation = continuationFor(state, policy, source)
    if (continuation === undefined) return
    agent.followup(continuation)
    ctx.logger.info(
      `llm-model-fallback: resuming session ${agent.session.id} without a new user message `
      + `(attempt ${String(state.recoveryAttempts + 1)} of ${String(policy.maxRecoveryAttempts)})`,
    )
  })

  ctx.on('session/event', (session, event) => {
    // Log-only records never describe a route another actor chose.
    if (LOG_ONLY_EVENT_TYPES.has(event.type)) return
    const routing = ctx.get('modelRouting')
    /* v8 ignore next -- `inject` guarantees the Agent registry, which owns ctx.modelRouting */
    if (routing === undefined) return
    const agent = ctx.agents.get(session.id)
    /* v8 ignore next -- a detached Session outliving its Agent has no recovery route to release */
    if (agent === undefined) return
    const override = routing.overrideFor(agent.ctx)
    if (override === undefined) return
    const eventType: string = event.type
    if (eventType === 'model/selection') {
      routing.clearOverride(agent.ctx)
      return
    }
    if (event.type !== 'request/header') return
    const route = { provider: event.data.header.config.provider, model: event.data.header.config.model }
    if (!sameRoute(route, override.route)) routing.clearOverride(agent.ctx)
  })

  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
    // Both signals stay observable after the awaits below; read them through a
    // call so the checks reflect the live state rather than a narrowed snapshot.
    const aborted = (): boolean => lifetime.signal.aborted || signal.aborted
    if (aborted()) return undefined
    // Downstream recovery owns the first decision: a scheduled retry on the
    // same route must not be replaced by a model switch.
    const downstream = await next()
    if (downstream?.kind === 'retry') return downstream
    /* v8 ignore next -- the turn or plugin signal aborted while downstream recovery ran */
    if (aborted()) return undefined
    if (policy.chain.length === 0) return undefined
    const category = classifyModelFailure(failure)
    if (!policy.switchOn.includes(category)) return undefined
    const header = agent.session.requestHeader()
    if (header === undefined) return undefined
    const failed: RouteRef = { provider: header.config.provider, model: header.config.model }
    if (failed.provider !== provider) return undefined
    const state = readState(agent.session)
    const messages = agent.session.deriveMessages()
    const requiredModalities = requiredInputModalities(messages)
    const requiredShape = requiredRequestShape(messages)
    const recordExhaustion = (cause: FallbackExhaustionCause, rejected: RejectedCandidate[]): void => {
      if (state.paused?.turn === turn && state.paused.step === step) return
      agent.session.append('llm/model-fallback-exhausted', {
        turn,
        step,
        category,
        failure,
        cause,
        attempted: [...state.attempted],
        rejected: [...rejected],
      })
    }
    if (state.switches >= policy.maxSwitchesPerTurn) {
      // The allowance is spent: the chain is not unusable, this turn is. Record
      // the pause anyway so a reader can tell the two apart.
      recordExhaustion('switch-limit-reached', [])
      ctx.logger.warn(
        `llm-model-fallback: switch allowance ${policy.maxSwitchesPerTurn} is spent for turn ${turn} `
        + `after ${failure.code} from ${failed.provider}/${failed.model}`,
      )
      return undefined
    }
    const resolution = await resolveCandidates({
      llm: ctx.llm,
      chain: policy.chain,
      failed,
      attempted: state.attempted,
      requiredModalities,
      requiredShape,
      ...header.config.maxTokens === undefined ? {} : { outputTokens: header.config.maxTokens },
      ...state.observedInputTokens === null ? {} : { observedInputTokens: state.observedInputTokens },
      /* v8 ignore next -- the turn signal aborted during the model-metadata lookup */
      ...aborted() ? {} : { signal },
    })
    /* v8 ignore next -- cancellation raced the candidate lookup */
    if (aborted()) return undefined
    const target = resolution.eligible[0]
    if (target === undefined) {
      recordExhaustion('no-eligible-candidate', [...resolution.rejected])
      ctx.logger.warn(
        `llm-model-fallback: no configured alternative can serve turn ${turn} step ${step} `
        + `after ${failure.code} from ${failed.provider}/${failed.model}; `
        + `the step stays closed and the task keeps its durable state`,
      )
      return undefined
    }
    agent.session.append('llm/model-switched', {
      switchId: ModelSwitchId(mintSwitchId()),
      turn,
      step,
      category,
      failure,
      from: failed,
      to: selectionOf(target),
      rejected: [...resolution.rejected],
    })
    // The folded state names the entry-point route the recovery stands in for,
    // so a second switch keeps replacing that same route.
    const recovered = readState(agent.session).active
    /* v8 ignore next -- the switch record just appended folds to an active route */
    if (recovered === null) return undefined
    ctx.get('modelRouting')?.setOverride(agent.ctx, overrideOf(recovered))
    await persist(agent.session)
    ctx.logger.info(
      `llm-model-fallback: continuing turn ${turn} step ${step} on ${target.provider}/${target.model} `
      + `after ${failure.code} from ${failed.provider}/${failed.model}`,
    )
    return { kind: 'retry' }
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('llm-model-fallback plugin disposed'))
  }, 'llm-model-fallback: abort pending recovery')
}
