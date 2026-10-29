/**
 * Durable model-route fallback state for one Session.
 *
 * Every fact recovery depends on after a restart is folded from the committed
 * Session log: the route in force, the entry-point route it stands in for, the
 * routes already attempted this turn, the exhausted pause, and whether crash
 * repair closed the previous turn as interrupted.
 *
 * @module @deepseek-ai/dsh-llm-model-fallback/state
 */

import { z as zod } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { sameRoute } from './route.ts'
import { MODEL_FAILURE_CATEGORIES } from './types.ts'
import type { ModelFailureCategory, RouteRef, RouteSelection } from './types.ts'
import { RECOVERY_SOURCE_KIND } from './continuation.ts'

/** One durable recovery route: the replacement and the route it replaced. */
export interface ActiveFallbackRoute {
  /**
   * Route the session continues on, with the request control it was used with.
   *
   * Successive switches keep updating this field while {@link replaces} keeps
   * naming the entry point's own route: recovery stands in for one selection
   * until another actor chooses a route, so the second switch must not start
   * standing in for the first replacement.
   */
  readonly route: RouteSelection
  /** Entry-point route this replacement stands in for. */
  readonly replaces: RouteRef
  /**
   * Route the current replacement itself replaced.
   *
   * The loop seeds each request from the last logged header, which after a
   * switch names the previous replacement rather than the entry point's route,
   * so request routing recognizes both ends of the same recovery.
   */
  readonly previous: RouteRef | null
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
  /** Turn the crash repair closed as interrupted, or null while the log is balanced. */
  readonly interrupted: { readonly turn: number } | null
  /** Automatic continuation turns admitted since the last human message. */
  readonly recoveryAttempts: number
  /** Input tokens the last reported request consumed, or null before any usage. */
  readonly observedInputTokens: number | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Durable model-route fallback state for one Session. */
    llmModelFallback: ModelFallbackState
  }
}

/** State of a Session that has not routed through recovery yet. */
export const INITIAL_STATE: ModelFallbackState = Object.freeze({
  active: null,
  turn: null,
  attempted: [],
  switches: 0,
  paused: null,
  interrupted: null,
  recoveryAttempts: 0,
  observedInputTokens: null,
})

const routeRefSchema = zod.object({ provider: zod.string().min(1), model: zod.string().min(1) })

const routeSelectionSchema = zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
  reasoningEffort: zod.string().min(1).optional(),
})

const categorySchema = zod.union(MODEL_FAILURE_CATEGORIES.map(category => zod.literal(category)))

const modelFallbackStateSchema: zod.ZodType<ModelFallbackState> = zod.object({
  active: zod.object({
    route: routeSelectionSchema,
    replaces: routeRefSchema,
    previous: routeRefSchema.nullable(),
  }).nullable(),
  turn: zod.number().int().nonnegative().nullable(),
  attempted: zod.array(routeRefSchema),
  switches: zod.number().int().nonnegative(),
  paused: zod.object({
    turn: zod.number().int().nonnegative(),
    step: zod.number().int().nonnegative(),
    category: categorySchema,
  }).nullable(),
  interrupted: zod.object({ turn: zod.number().int().nonnegative() }).nullable(),
  recoveryAttempts: zod.number().int().nonnegative(),
  observedInputTokens: zod.number().int().nonnegative().nullable(),
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
      return {
        ...state,
        turn: event.data.turn,
        attempted: [],
        switches: 0,
        paused: null,
        interrupted: null,
      }
    case 'llm/model-switched': {
      // The second switch must keep standing in for the entry point's own
      // route: a chain that walked A to B and now moves to C still replaces A,
      // otherwise the entry point's next selection revives the failed route.
      const replaces = state.active !== null && sameRoute(state.active.route, event.data.from)
        ? state.active.replaces
        : event.data.from
      const active: ActiveFallbackRoute = { route: event.data.to, replaces, previous: event.data.from }
      if (event.data.turn !== state.turn) return { ...state, active }
      return {
        ...state,
        active,
        attempted: appendAttempted(appendAttempted(state.attempted, event.data.from), event.data.to),
        switches: state.switches + 1,
        paused: null,
      }
    }
    case 'user/message': {
      const recovery = (event.data.source as { kind?: string }).kind === RECOVERY_SOURCE_KIND
      return {
        ...state,
        ...recovery ? { recoveryAttempts: state.recoveryAttempts + 1 } : { recoveryAttempts: 0 },
      }
    }
    case 'llm/model-fallback-exhausted':
      return {
        ...state,
        paused: { turn: event.data.turn, step: event.data.step, category: event.data.category },
      }
    case 'assistant/message':
      // The provider's own accounting is the only measurement of how large the
      // retained conversation now is; a candidate must fit the next request.
      return event.data.usage === undefined
        ? state
        : { ...state, observedInputTokens: event.data.usage.inputTokens }
    case 'turn/end':
      // Crash repair closes an interrupted turn with this reason; it is the
      // durable signal that the task still has work left and no owner.
      return event.data.reason.kind === 'interrupted'
        ? { ...state, interrupted: { turn: event.data.turn } }
        : { ...state, interrupted: null }
    case 'request/header': {
      if (state.active === null) return state
      const route = { provider: event.data.header.config.provider, model: event.data.header.config.model }
      return sameRoute(route, state.active.route) ? state : { ...state, active: null }
    }
    default:
      return state
  }
}

/** Projection folding {@link ModelFallbackState} from one Session log. */
export const modelFallbackProjection = {
  key: 'llmModelFallback',
  stateVersion: 1,
  stateSchema: modelFallbackStateSchema,
  init: () => INITIAL_STATE,
  apply: applyModelFallbackState,
} satisfies ProjectionDefinition<'llmModelFallback', ModelFallbackState>
