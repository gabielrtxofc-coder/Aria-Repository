/**
 * Pure types of the mission-continuity domain: the durable mission record, its
 * compare-and-set identity, the requests that mutate it, and the `mission`
 * projection-key declaration. Free of host-side imports, so client aggregates
 * can consume the same declarations.
 *
 * A mission is the Harness-owned commitment to finish one durable objective
 * (a `dsh-goal` goal) across process restarts. It never restates the objective,
 * the plan, or tool results: those remain the goal, the todo projection, and
 * the session log. It records only what a goal cannot: the completion criteria,
 * the autonomous-recovery authorization, the bounded attempt budget, the last
 * consistent checkpoint, and the interruption being recovered from.
 *
 * @module @deepseek-ai/dsh-mission-continuity
 */

import type { AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GoalRef } from '@deepseek-ai/dsh-goal/types'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Identifies one mission across its durable revisions. */
export type MissionId = Branded<'MissionId'>

/** Compare-and-set identity for one exact mission revision. */
export interface MissionRef {
  /** Stable mission identity. */
  readonly id: MissionId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Durable cause recorded when a recovery attempt claims an interrupted mission. */
export type MissionInterruptionKind =
  | 'process-restart'
  | 'request-failed'
  | 'turn-aborted'
  | 'unknown'

/** Why autonomous recovery is taking over, captured with the attempt. */
export interface MissionInterruption {
  /** Stable cause classification of the interruption being recovered. */
  readonly kind: MissionInterruptionKind
  /** Epoch milliseconds when the recovery attempt observed the interruption. */
  readonly at: number
  /** Bounded diagnostic text; absent when the cause needs no detail. */
  readonly detail?: string | undefined
}

/**
 * Last consistent checkpoint: the session seq whose prefix was durable when the
 * mission last recorded progress. A recovery starts from this position, so
 * completed steps before it are never redone.
 */
export interface MissionCheckpoint {
  /** Highest session seq covered by a resolved durability flush. */
  readonly seq: number
  /** Epoch milliseconds when the checkpoint was recorded. */
  readonly at: number
}

/**
 * Pending human authorization. While present, autonomous recovery must not run:
 * the mission waits for the decision that the approval seam owns.
 */
export interface MissionAuthorization {
  /** Stable lower-kebab-case classification chosen by the asking consumer. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

/** Whether autonomous recovery may resume this mission after a restart. */
export type MissionRecoveryPolicy = 'enabled' | 'disabled'

/** Full durable mission state written by every non-clear mutation. */
export interface MissionSnapshot extends MissionRef {
  /** The durable objective this mission carries across restarts. */
  readonly goal: GoalRef
  /** Statements the mission must satisfy before it counts as achieved. */
  readonly completionCriteria: readonly string[]
  /** Deployment authorization for autonomous recovery. */
  readonly recovery: MissionRecoveryPolicy
  /** Total autonomous recovery attempts this mission may consume. */
  readonly maxRecoveryAttempts: number
  /** Attempts consumed so far; monotonic across restarts. */
  readonly attempts: number
  /** Cause captured by the most recent recovery attempt. */
  readonly interruption?: MissionInterruption | undefined
  /** Last consistent checkpoint, absent before the first attempt. */
  readonly checkpoint?: MissionCheckpoint | undefined
  /** Pending human authorization; present exactly while recovery is held. */
  readonly authorization?: MissionAuthorization | undefined
  /** Epoch milliseconds of the start mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}

/** Current mission view, including the derived settlement fact. */
export interface MissionView extends MissionSnapshot {
  /** Whether the linked durable objective already records completion. */
  readonly settled: boolean
}

/** Caller request that starts one mission and its durable objective. */
export interface StartMissionRequest {
  /** Human-requested completion objective; becomes the goal objective. */
  readonly objective: string
  /** Non-empty statements that define done; at least one is required. */
  readonly completionCriteria: readonly string[]
  /** Round cap for the durable objective, when the caller names one. */
  readonly maxGoalRounds?: number
  /** Autonomous recovery budget, when the caller names one. */
  readonly maxRecoveryAttempts?: number
  /** Recovery authorization; omission enables autonomous recovery. */
  readonly recovery?: MissionRecoveryPolicy
}

/**
 * Request for the composition that will rebuild one Agent during recovery.
 * Recovery cannot guess a provider, a model, or the session-scoped capability
 * set: all of them belong to the deployment that mounts mission continuity.
 */
export interface MissionAgentSetupRequest {
  /** Persisted session about to be resumed. */
  readonly sessionId: SessionId
  /** Options recovery would pass unchanged, when a caller already has them. */
  readonly agentOptions?: AgentOptions | undefined
}

/**
 * How recovery must compose one Agent. An empty plan resumes the durable log
 * without provider/model options, which fails loud on the first request; a
 * deployment supplies both here.
 */
export interface MissionAgentSetupPlan {
  /** Agent options handed to the agent factory, including provider and model. */
  readonly agentOptions?: AgentOptions | undefined
  /** Scoped capability setup run inside the resume transaction. */
  readonly setup?: AgentSetup | undefined
}

/** Live notification after one durable mission mutation commits. */
export interface MissionChanged {
  /** Accepted operation, or `clear` for a tombstone. */
  readonly operation: MissionChangeOperation
  /** Exact revision the mutation produced. */
  readonly ref: MissionRef
  /** Fresh view; absent for a clear tombstone. */
  readonly mission?: MissionView
}

/** Mission state-changing verbs recorded in the durable change. */
export type MissionChangeOperation =
  | 'start'
  | 'checkpoint'
  | 'attempt'
  | 'authorize'
  | 'resume'
  | 'clear'

/** One recorded tool call whose committed result is missing. */
export interface UncertainOperation {
  /** Durable call identity. */
  readonly callId: string
  /** Tool name recorded on the call. */
  readonly name: string
}

/** Strict host state of the `mission` projection. */
export interface MissionProjectionState {
  /** Latest durable mission record, or null before the first start and after a clear. */
  readonly current: MissionSnapshot | null
  /** Every mission id this session has used, in first-seen order. */
  readonly seenMissionIds: readonly string[]
  /** First strict replay failure, retained so dependent access fails loudly. */
  readonly failure: string | null
  /** Tool calls recorded without a committed result yet, in call order. */
  readonly pendingCalls: readonly UncertainOperation[]
  /** Calls whose committed result says the outcome is unknown, oldest first. */
  readonly uncertainOperations: readonly UncertainOperation[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    mission: MissionProjectionState
  }
  interface SessionProjectionMap {
    /**
     * The current durable mission record, or `null` before its start and after
     * its clear. Whole-value rule: every `mission/change` carries the complete
     * post-mutation record, so the fold is last-wins.
     */
    mission: MissionSnapshot | null
  }
}
