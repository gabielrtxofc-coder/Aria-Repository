/**
 * Live recovery override for one Agent's model route.
 *
 * A recovery plugin that keeps a task on another model (an exhausted quota, an
 * unusable credential) records the replacement route here, so prompt assembly
 * and request routing stay on one route instead of disagreeing with the entry
 * point that installed a model selection.
 *
 * The override never outlives the route it replaced: it applies only while the
 * entry point's own selection still names {@link ModelRouteOverride.replaces},
 * and its owner clears it when the Session records another route.
 *
 * @module @deepseek-ai/dsh-agent/model-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { ModelSelection } from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-Agent model-route overrides recorded by request-recovery plugins. */
    modelRouting: ModelRouting
  }
}

/** One replacement route plus the route whose failure caused it. */
export interface ModelRouteOverride {
  /** Route the current step's requests use. */
  readonly route: ModelSelection
  /** Route this override replaced; the override yields once another route is selected. */
  readonly replaces: ModelSelection
}

/**
 * Agent-scoped registry of recovery route overrides (`ctx.modelRouting`).
 *
 * Entries are live process state keyed by the Agent's own scoped context: no
 * session event is written here, so a plugin that restores an override after a
 * restart reads its own durable record first and then calls
 * {@link setOverride}. An Agent scope that unwinds leaves no entry behind
 * because the key is the disposed context itself.
 */
export class ModelRouting extends Service {
  private readonly overrides = new WeakMap<Context, ModelRouteOverride>()

  /**
   * @param ctx - context that owns this service.
   */
  constructor(ctx: Context) {
    super(ctx, 'modelRouting')
  }

  /**
   * Read the recovery override recorded for one Agent scope.
   * @param agentCtx - the Agent's scoped context.
   * @returns the override, or undefined while the Agent routes normally.
   */
  overrideFor(agentCtx: Context): ModelRouteOverride | undefined {
    return this.overrides.get(agentCtx)
  }

  /**
   * Record or replace one Agent's recovery override.
   * @param agentCtx - the Agent's scoped context.
   * @param override - replacement route and the route it replaces, both copied.
   */
  setOverride(agentCtx: Context, override: ModelRouteOverride): void {
    this.overrides.set(agentCtx, {
      route: { ...override.route },
      replaces: { ...override.replaces },
    })
  }

  /**
   * Drop one Agent's recovery override so the entry point's own selection routes again.
   * @param agentCtx - the Agent's scoped context.
   */
  clearOverride(agentCtx: Context): void {
    this.overrides.delete(agentCtx)
  }
}
