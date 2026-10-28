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
import { z as zod } from 'zod'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { classifyModelFailure } from './classification.ts'
import { requiredInputModalities, resolveCandidates } from './selection.ts'
import { routeKey, sameRoute, selectionOf } from './route.ts'
import type { ModelFallbackCandidateConfig, ResolvedModelFallbackPolicy } from './route.ts'
import { MODEL_FAILURE_CATEGORIES, ModelSwitchId } from './types.ts'
import type { ModelFailureCategory, RouteRef } from './types.ts'

export type { ModelFallbackCandidateConfig, ResolvedModelFallbackPolicy } from './route.ts'
export { routeKey, sameRoute, selectionOf } from './route.ts'
export { classifyModelFailure } from './classification.ts'
export { requiredInputModalities, resolveCandidates } from './selection.ts'
export type { CandidateResolution, CandidateResolutionRequest } from './selection.ts'
export { MODEL_FAILURE_CATEGORIES, ModelSwitchId }
export type {
  CandidateRejectionReason,
  ModelFailureCategory,
  ModelFallbackExhaustedEventData,
  ModelSwitchedEventData,
  RejectedCandidate,
  RouteRef,
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
})

const CANDIDATE_KEYS: ReadonlySet<string> = new Set(['provider', 'model', 'reasoningEffort'])
const CONFIG_KEYS: ReadonlySet<string> = new Set(['chain', 'switchOn', 'maxSwitchesPerTurn'])

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

  return Object.freeze({
    chain: Object.freeze(chain),
    switchOn: Object.freeze(checkedCategories),
    maxSwitchesPerTurn,
  })
}

export const name = 'llm-model-fallback'
export const inject = ['agents', 'sessionProjections', 'llm']

/** Non-serializable hooks that keep switch identities deterministic in tests. */
export interface ModelFallbackInternals {
  /** Mint one switch identity; defaults to a random UUID. */
  switchId?: () => string
}

/** One durable recovery route: the replacement and the route it replaced. */
export interface ActiveFallbackRoute {
  /** Route the session continues on. */
  readonly route: RouteRef
  /** Route this replacement stands in for. */
  readonly replaces: RouteRef
}

/** Durable model-route fallback state folded from one session log. */
export interface ModelFallbackState {
  /** Replacement route in force, or null while the session routes normally. */
  readonly active: ActiveFallbackRoute | null
  /** Turn whose attempt list and switch count the state tracks. */
  readonly turn: number | null
  /** Routes that failed or replaced another route during the tracked turn. */
  readonly attempted: RouteRef[]
  /** Switches performed during the tracked turn. */
  readonly switches: number
  /** Step whose recovery found no usable alternative. */
  readonly paused: { readonly turn: number; readonly step: number; readonly category: ModelFailureCategory } | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Durable model-route fallback state for one Session. */
    llmModelFallback: ModelFallbackState
  }
}

const INITIAL_STATE: ModelFallbackState = Object.freeze({
  active: null,
  turn: null,
  attempted: [],
  switches: 0,
  paused: null,
})

const routeRefSchema = zod.object({ provider: zod.string().min(1), model: zod.string().min(1) })

const categorySchema = zod.union(MODEL_FAILURE_CATEGORIES.map(category => zod.literal(category)))

const modelFallbackStateSchema: zod.ZodType<ModelFallbackState> = zod.object({
  active: zod.object({ route: routeRefSchema, replaces: routeRefSchema }).nullable(),
  turn: zod.number().int().nonnegative().nullable(),
  attempted: zod.array(routeRefSchema),
  switches: zod.number().int().nonnegative(),
  paused: zod.object({
    turn: zod.number().int().nonnegative(),
    step: zod.number().int().nonnegative(),
    category: categorySchema,
  }).nullable(),
})

function appendAttempted(attempted: readonly RouteRef[], route: RouteRef): RouteRef[] {
  return attempted.some(previous => sameRoute(previous, route)) ? [...attempted] : [...attempted, { ...route }]
}

/**
 * Advance durable fallback state by one committed Session event.
 * @param state - state before the event.
 * @param event - next committed Session event.
 * @returns the same or an advanced state.
 */
function applyModelFallbackState(state: ModelFallbackState, event: SessionEvent): ModelFallbackState {
  // `model/selection` belongs to an entry-point package this plugin does not
  // depend on: the string comparison keeps that event vocabulary out of the
  // shared type graph while still honoring an explicit route choice.
  const eventType: string = event.type
  if (eventType === 'model/selection') return state.active === null ? state : { ...state, active: null }
  switch (event.type) {
    case 'turn/start':
      return { ...state, turn: event.data.turn, attempted: [], switches: 0, paused: null }
    case 'llm/model-switched': {
      const active: ActiveFallbackRoute = { route: event.data.to, replaces: event.data.from }
      if (event.data.turn !== state.turn) return { ...state, active }
      return {
        ...state,
        active,
        attempted: appendAttempted(appendAttempted(state.attempted, event.data.from), event.data.to),
        switches: state.switches + 1,
        paused: null,
      }
    }
    case 'llm/model-fallback-exhausted':
      return {
        ...state,
        paused: { turn: event.data.turn, step: event.data.step, category: event.data.category },
      }
    case 'request/header': {
      if (state.active === null) return state
      const route = { provider: event.data.header.config.provider, model: event.data.header.config.model }
      return sameRoute(route, state.active.route) ? state : { ...state, active: null }
    }
    default:
      return state
  }
}

const modelFallbackProjection = {
  key: 'llmModelFallback',
  stateVersion: 1,
  stateSchema: modelFallbackStateSchema,
  init: () => INITIAL_STATE,
  apply: applyModelFallbackState,
} satisfies ProjectionDefinition<'llmModelFallback', ModelFallbackState>

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

  /** Re-apply the recovered route to one request that would otherwise retry the failed one. */
  function overrideConfig(agent: Agent, config: LlmCallConfig): LlmCallConfig {
    const override = ctx.get('modelRouting')?.overrideFor(agent.ctx)
    if (override === undefined) return config
    if (config.provider !== override.replaces.provider || config.model !== override.replaces.model) return config
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = config
    const route: ModelSelection = override.route
    return {
      ...withoutInheritedEffort,
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    }
  }

  ctx.on('agent/request', async ({ agent }, next) => overrideConfig(agent, await next()), { prepend: true })

  ctx.on('agent/created', ({ agent }) => {
    const routing = ctx.get('modelRouting')
    /* v8 ignore next -- `inject` guarantees the Agent registry, which owns ctx.modelRouting */
    if (routing === undefined) return
    const { active } = readState(agent.session)
    if (active === null) routing.clearOverride(agent.ctx)
    else routing.setOverride(agent.ctx, { route: active.route, replaces: active.replaces })
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
    if (state.switches >= policy.maxSwitchesPerTurn) return undefined
    const resolution = await resolveCandidates({
      llm: ctx.llm,
      chain: policy.chain,
      failed,
      attempted: state.attempted,
      requiredModalities: requiredInputModalities(agent.session.deriveMessages()),
      /* v8 ignore next -- the turn signal aborted during the model-metadata lookup */
      ...aborted() ? {} : { signal },
    })
    /* v8 ignore next -- cancellation raced the candidate lookup */
    if (aborted()) return undefined
    const target = resolution.eligible[0]
    if (target === undefined) {
      if (state.paused?.turn !== turn || state.paused.step !== step) {
        agent.session.append('llm/model-fallback-exhausted', {
          turn,
          step,
          category,
          failure,
          attempted: [...state.attempted],
          rejected: [...resolution.rejected],
        })
        ctx.logger.warn(
          `llm-model-fallback: no configured alternative can serve turn ${turn} step ${step} `
          + `after ${failure.code} from ${failed.provider}/${failed.model}; `
          + `the step stays closed and the task keeps its durable state`,
        )
      }
      return undefined
    }
    agent.session.append('llm/model-switched', {
      switchId: ModelSwitchId(mintSwitchId()),
      turn,
      step,
      category,
      failure,
      from: failed,
      to: { provider: target.provider, model: target.model },
      rejected: [...resolution.rejected],
    })
    ctx.get('modelRouting')?.setOverride(agent.ctx, {
      route: selectionOf(target),
      replaces: failed,
    })
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
