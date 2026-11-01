/**
 * Host-side vocabulary of the mission-continuity domain: the durable change
 * payload, the scoped `mission/changed` event, and the model-facing message
 * source that attributes a recovery notice to its exact mission revision.
 * Kept out of ./types.ts because these declarations pull dsh-agent,
 * dsh-llm, and cordis into the program.
 * @module @deepseek-ai/dsh-mission-continuity
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

import type {
  MissionAgentSetupPlan,
  MissionAgentSetupRequest,
  MissionChangeOperation,
  MissionChanged,
  MissionRef,
  MissionSnapshot,
} from './types.ts'

/** Full-snapshot mission mutation committed by a durable `mission/change` event. */
export interface MissionSnapshotChangeMeta {
  readonly kind: 'mission/change'
  readonly version: 1
  readonly operation: Exclude<MissionChangeOperation, 'clear'>
  readonly mission: MissionSnapshot
}

/** Tombstone retained when the current mission is cleared. */
export interface MissionClearChangeMeta {
  readonly kind: 'mission/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: MissionRef
  readonly clearedAt: number
}

/** Durable change union carried by the mission domain's session event. */
export type MissionChangeMeta = MissionSnapshotChangeMeta | MissionClearChangeMeta

/**
 * Message attribution for a recovery notice. The notice is an ordinary logged
 * user message, so the model's history remains reconstructable from the session
 * log alone; the source records which mission revision and attempt produced it.
 */
export interface MissionMessageSource {
  readonly kind: 'mission'
  readonly missionId: string
  readonly revision: number
  /** Positive recovery attempt that queued the notice. */
  readonly attempt: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    mission: MissionMessageSource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation mission state or clear tombstone. The session log
     * is the durable authority for mission state; the recovery ledger used to
     * discover missions at startup is a hint that is reconciled against it.
     */
    'mission/change': MissionChangeMeta
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Mission mutation accepted by one live agent. The matching `mission/change`
     * session event has already committed. Listener failures are contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only that agent.
     * @param payload.agent - agent whose session owns the mission.
     * @param payload.change - fresh current view or clear tombstone.
     * @mode emit
     */
    'mission/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: MissionChanged }): void

    /**
     * Decide how mission recovery composes the Agent that will continue a
     * persisted session. The deployment supplies provider, model, and any
     * session-scoped capability setup; recovery never invents them. Listeners
     * must delegate through `next` and merge into its result. A composition
     * without a listener resumes the durable log with no options, which fails
     * loud on the first request — recovery documents that as a deployment
     * requirement rather than guessing a route.
     * @param payload.sessionId - persisted session about to be resumed.
     * @param payload.agentOptions - options recovery would otherwise pass unchanged.
     * @param next - delegation to the remaining listeners and the default plan.
     * @mode waterfall
     */
    'mission/agent-setup'(
      payload: MissionAgentSetupRequest,
      next: (request: MissionAgentSetupRequest) => Promise<MissionAgentSetupPlan>,
    ): Promise<MissionAgentSetupPlan>
  }
}
