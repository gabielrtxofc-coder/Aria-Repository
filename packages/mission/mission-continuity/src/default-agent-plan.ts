/**
 * The shipped deployment policy for the `mission/agent-setup` seam.
 *
 * Recovery itself never selects a provider, a model, or a reasoning effort: the
 * mechanism resumes the durable session and asks the composition how to compose
 * the Agent. This plugin is that answer for a stock dsh profile — it reuses the
 * host's own default model selection (`ctx.agentDefaultModel`, the same
 * selection entry points use for a new Agent) and never invents a route when the
 * host has none, so a deployment without a default model still fails loud
 * instead of resuming under a guessed provider.
 *
 * The host service is read structurally rather than imported: mission
 * continuity must not depend on any model-selection package, and this policy
 * must keep working when a profile swaps that service for its own. A deployment
 * that wants another composition registers its own listener in a later patch
 * layer; an already-resolved `agentOptions` (from a layer closer to the caller)
 * always wins.
 * @module @deepseek-ai/dsh-mission-continuity/default-agent-plan
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from './domain.ts'
import type { MissionAgentSetupPlan } from './types.ts'

export const name = 'mission-default-agent-plan'

/** Provider, model, and optional effort a host default selection resolves to. */
interface DefaultSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

/** The one method this policy needs from the host's default model service. */
interface DefaultSelectionService {
  currentSelection(): DefaultSelection
}

/** Read one field as a non-empty string, if it is one. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Whether a host value exposes the one method this policy needs. */
function isDefaultSelectionService(value: unknown): value is DefaultSelectionService {
  return typeof value === 'object' && value !== null
    && typeof Reflect.get(value, 'currentSelection') === 'function'
}

/**
 * Read the host's default model selection without depending on its package.
 * @param ctx - composition that may provide `agentDefaultModel`.
 * @returns agent options for a recovered Agent, or `undefined` when the host
 *   provides no default selection this policy can trust.
 */
export function defaultAgentOptions(ctx: Context): AgentOptions | undefined {
  // The service name is not part of this package's Context declarations, so the
  // lookup stays structural: a profile without the service simply gets no fill.
  const service: unknown = ctx.get('agentDefaultModel')
  if (!isDefaultSelectionService(service)) return undefined
  const selection = service.currentSelection()
  const provider = text(selection.provider)
  const model = text(selection.model)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = text(selection.reasoningEffort)
  if (reasoningEffort === undefined) return { provider, model }
  // The effort id is branded by the provider adapter, which owns the vocabulary.
  return { provider, model, reasoningEffort: reasoningEffort as NonNullable<AgentOptions['reasoningEffort']> }
}

/**
 * Fill an unresolved recovery plan with the host's default model selection.
 * @param ctx - composition providing the default selection, if any.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.on('mission/agent-setup', async (request, next): Promise<MissionAgentSetupPlan> => {
    const plan = await next(request)
    if (plan.agentOptions !== undefined) return plan
    const agentOptions = defaultAgentOptions(ctx)
    if (agentOptions === undefined) return plan
    return { ...plan, agentOptions }
  }), 'mission-continuity default agent plan')
}
