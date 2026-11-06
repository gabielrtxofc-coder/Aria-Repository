/**
 * The mission service (`ctx.missions`): durable, event-sourced mission records
 * over one session log, plus the `mission` projection that folds them.
 *
 * The service owns what a durable objective cannot express — completion
 * criteria, the autonomous-recovery authorization, the bounded attempt budget,
 * the last consistent checkpoint, and the interruption being recovered — and
 * never restates the objective, the plan, or tool results that other durable
 * owners already hold. Recovery itself lives in ./supervisor.ts.
 * @module @deepseek-ai/dsh-mission-continuity
 */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: declares the `todos` projection key this service reads for the plan.
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { RecoveryNoticeStep } from './prompt.ts'
import { GoalId, goalProjectionDefinition } from '@deepseek-ai/dsh-goal'
import { SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { applyMissionChange, decodeMissionChange, foldMission, missionChangeRef } from './fold.ts'
import type { MissionFoldState } from './fold.ts'
import {
  MAX_COMPLETION_CRITERIA,
  MAX_COMPLETION_CRITERION_LENGTH,
  MAX_DIAGNOSTIC_LENGTH,
  MISSION_CHANGE_VERSION,
  UNCERTAIN_ACKNOWLEDGED,
  UNCERTAIN_OPERATIONS,
  MissionError,
  MissionId,
  POLICY_CODE_PATTERN,
} from './runtime.ts'
import type { MissionErrorCode } from './runtime.ts'
import { RecoveryLedger, assertPolicyCode } from './ledger.ts'
import { recordedUncertainty } from './uncertainty.ts'
import type { RecoveryRecord } from './ledger.ts'
import { MissionSupervisor } from './supervisor.ts'
import type { MissionSweepReport } from './supervisor.ts'
import type { MissionChangeMeta, MissionSnapshotChangeMeta } from './domain.ts'
import type {
  MissionAuthorization,
  MissionChangeOperation,
  MissionChanged,
  MissionInterruption,
  MissionProjectionState,
  MissionRecoveryPolicy,
  MissionRef,
  MissionSnapshot,
  MissionView,
  StartMissionRequest,
  UncertainOperation,
} from './types.ts'

export type * from './types.ts'
export type * from './domain.ts'
export type { MissionSweepReport, MissionSweepOutcome } from './supervisor.ts'
export type { RecoveryRecord, RecoveryRowState } from './ledger.ts'
export {
  MAX_COMPLETION_CRITERIA,
  MAX_COMPLETION_CRITERION_LENGTH,
  MAX_DIAGNOSTIC_LENGTH,
  MISSION_CHANGE_VERSION,
  UNCERTAIN_ACKNOWLEDGED,
  UNCERTAIN_OPERATIONS,
  MissionError,
  MissionId,
} from './runtime.ts'
export { applyMissionChange, decodeMissionChange, foldMission, missionChangeRef } from './fold.ts'
export { missionContinuityDomain, recoveryRecordSchema } from './ledger.ts'
export { renderMissionRecoveryNotice } from './prompt.ts'
export { recordedUncertainty, unacknowledgedUncertainty } from './uncertainty.ts'
export type {
  RecoveryNoticeInput,
  RecoveryNoticeOperation,
  RecoveryNoticeStep,
} from './prompt.ts'

/** Supported change operations carrying a complete snapshot. */
type SnapshotOperation = Exclude<MissionChangeOperation, 'clear'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    missions: MissionService
  }
}

/** Deployment defaults for mission continuity. */
export interface Config {
  /** Recover missions found in the durable index when this plugin activates. */
  sweepOnStartup?: boolean
  /** Autonomous recovery budget used when a start request omits its own. */
  defaultMaxRecoveryAttempts?: number
  /** Most index rows one sweep considers; the remainder waits for the next sweep. */
  maxMissionsPerSweep?: number
  /**
   * Rebuild missing index rows from the durable session logs before the startup
   * sweep. The index is a hint, never the source of truth, so a lost row must
   * not make a durable mission permanently invisible.
   */
  rebuildIndexOnStartup?: boolean
  /** Most stored sessions one rebuild reads while looking for unknown missions. */
  maxRebuildSessions?: number
}

/** Validated deployment configuration. */
export interface ResolvedConfig {
  /** Whether activation performs a recovery sweep. */
  sweepOnStartup: boolean
  /** Positive default recovery budget. */
  defaultMaxRecoveryAttempts: number
  /** Positive bound on rows considered by one sweep. */
  maxMissionsPerSweep: number
  /** Whether activation rebuilds missing index rows from the session logs. */
  rebuildIndexOnStartup: boolean
  /** Positive bound on session logs one rebuild reads. */
  maxRebuildSessions: number
}

/**
 * Most calls one of the projection's two windows tracks for one session.
 *
 * The tracker must hold one whole step's fan-out, not one arbitrary slice of
 * it: the agent loop dispatches up to its `maxParallelToolCalls` tool calls at
 * once (10 by default, and a deployment may configure more), so a bound below
 * that drops calls that are still legitimately in flight. A dropped pending call
 * makes its later `TOOL_OUTCOME_UNKNOWN` result invisible, and recovery then
 * resumes a mission past a call whose external effect nobody confirmed. The
 * bound is 2x the shipped fan-out plus a margin.
 *
 * Overflowing the bound may cost a name, never the fact. A call the open-call
 * window had to drop is counted ({@link
 * MissionProjectionState.pendingOverflow}) and the count settles when a result
 * for it arrives: a call whose result became durable is settled, whoever was
 * tracking it, so it must not be remembered as a doubt. Only a result that
 * actually reports an unknown outcome becomes one, and a doubt the doubt window
 * cannot hold is counted ({@link MissionProjectionState.uncertainOverflow})
 * instead of being dropped.
 */
const MAX_TRACKED_CALLS = 22

/** Mission id schema shared by the projection and its client view. */
const missionIdSchema = zod.string().min(1).max(200).transform(MissionId)

/** Linked objective ref schema. */
const goalRefSchema = zod.object({
  id: zod.string().min(1).max(200).transform(GoalId),
  revision: zod.number().int().positive(),
}).strict()

/** Interruption schema of a stored mission record. */
const interruptionSchema = zod.object({
  kind: zod.enum(['process-restart', 'request-failed', 'turn-aborted', 'unknown']),
  at: zod.number().int().nonnegative(),
  detail: zod.string().min(1).max(MAX_DIAGNOSTIC_LENGTH).optional(),
}).strict()

/** Checkpoint schema of a stored mission record. */
const checkpointSchema = zod.object({
  seq: zod.number().int().nonnegative(),
  at: zod.number().int().nonnegative(),
}).strict()

/** Pending-authorization schema of a stored mission record. */
const authorizationSchema = zod.object({
  code: zod.string().regex(POLICY_CODE_PATTERN),
  message: zod.string().min(1).max(MAX_DIAGNOSTIC_LENGTH),
}).strict()

/** One durable mission record, as stored by `mission/change`. */
const missionSnapshotSchema: ZodType<MissionSnapshot> = zod.object({
  id: missionIdSchema,
  revision: zod.number().int().positive(),
  goal: goalRefSchema,
  completionCriteria: zod.array(
    zod.string().min(1).max(MAX_COMPLETION_CRITERION_LENGTH),
  ).min(1).max(MAX_COMPLETION_CRITERIA),
  recovery: zod.enum(['enabled', 'disabled']),
  maxRecoveryAttempts: zod.number().int().positive(),
  attempts: zod.number().int().nonnegative(),
  interruption: interruptionSchema.optional(),
  checkpoint: checkpointSchema.optional(),
  authorization: authorizationSchema.optional(),
  uncertainAcknowledged: zod.number().int().nonnegative().optional(),
  createdAt: zod.number().int().nonnegative(),
  updatedAt: zod.number().int().nonnegative(),
}).strict()

/** One tool call tracked for recovery diagnostics. */
const trackedCallSchema: ZodType<UncertainOperation> = zod.object({
  callId: zod.string().min(1),
  name: zod.string().min(1),
}).strict()

/** Strict checkpoint state of the `mission` projection. */
const missionProjectionStateSchema: ZodType<MissionProjectionState> = zod.object({
  current: missionSnapshotSchema.nullable(),
  seenMissionIds: zod.array(zod.string().min(1)),
  failure: zod.string().min(1).nullable(),
  pendingCalls: zod.array(trackedCallSchema),
  uncertainOperations: zod.array(trackedCallSchema),
  uncertainOverflow: zod.number().int().positive().optional(),
  pendingOverflow: zod.number().int().positive().optional(),
}).strict()

/** Client view: the current mission record, or null before start and after clear. */
const missionViewSchema: ZodType<MissionSnapshot | null> = missionSnapshotSchema.nullable()

/** Build strict fold state from one checkpoint-safe projection state. */
function foldState(state: MissionProjectionState): MissionFoldState {
  return {
    mission: state.current ?? undefined,
    lastRef: undefined,
    seenMissionIds: new Set(state.seenMissionIds),
    cleared: state.current === null && state.seenMissionIds.length > 0,
  }
}

/** Project one fold state into checkpoint-safe projection state. */
function projectionState(state: MissionFoldState, tracked: MissionProjectionState): MissionProjectionState {
  return {
    current: state.mission ?? null,
    seenMissionIds: [...state.seenMissionIds],
    failure: tracked.failure,
    pendingCalls: tracked.pendingCalls,
    uncertainOperations: tracked.uncertainOperations,
    ...tracked.uncertainOverflow === undefined ? {} : { uncertainOverflow: tracked.uncertainOverflow },
    ...tracked.pendingOverflow === undefined ? {} : { pendingOverflow: tracked.pendingOverflow },
  }
}

/** The bounded collection plus the calls it had to drop. */
interface TrackResult {
  /** Calls retained, newest last. */
  readonly kept: readonly UncertainOperation[]
  /** Calls displaced by the bound, oldest first. */
  readonly displaced: readonly UncertainOperation[]
}

/**
 * Append one tracked call, keeping the collection bounded and unique.
 * @param calls - calls tracked before this event.
 * @param call - call to append.
 * @returns the bounded collection and whatever the bound displaced.
 */
function trackCall(calls: readonly UncertainOperation[], call: UncertainOperation): TrackResult {
  const appended = [...calls.filter(entry => entry.callId !== call.callId), call]
  return { kept: appended.slice(-MAX_TRACKED_CALLS), displaced: appended.slice(0, -MAX_TRACKED_CALLS) }
}

/**
 * Fold one unknown-outcome call into the state. The bounded list is
 * `MAX_TRACKED_CALLS` long, so an unknown outcome that has to displace a
 * recorded one is counted instead of forgotten: recovery treats a non-zero
 * overflow exactly like a listed call.
 * @param state - state before the result.
 * @param call - call whose committed result reported an unknown outcome.
 * @returns the state carrying the doubt.
 */
function trackUncertain(state: MissionProjectionState, ...calls: readonly UncertainOperation[]): MissionProjectionState {
  let retained: readonly UncertainOperation[] = state.uncertainOperations
  let overflow = state.uncertainOverflow ?? 0
  for (const call of calls) {
    const tracked = trackCall(retained, call)
    retained = tracked.kept
    overflow += tracked.displaced.length
  }
  return {
    ...state,
    uncertainOperations: retained,
    ...overflow === 0 ? {} : { uncertainOverflow: overflow },
  }
}

/**
 * Set the counted open calls, dropping the count entirely once it reaches zero
 * so a settled session reports a clean state instead of a stale `0`.
 * @param state - state to carry every other field of.
 * @param open - how many recorded calls are still open and unnamed.
 * @returns the state carrying that count.
 */
function countPending(state: MissionProjectionState, open: number): MissionProjectionState {
  const { pendingOverflow: _dismissed, ...rest } = state
  return open > 0 ? { ...rest, pendingOverflow: open } : rest
}

/**
 * Settle one open call the bounded window could no longer name, doubting it only
 * when the arriving result reports an unknown outcome.
 *
 * Both halves come from one fact: a result arrived for an identity the open-call
 * window had already dropped. The call stopped being open — its outcome is now
 * recorded — so it leaves the counted-open total, and it joins the doubt count
 * only if what was recorded is that nobody knows.
 * @param state - state before the result.
 * @param open - how many counted calls were still open, at least one.
 * @param unknown - whether this result says the outcome is unknown.
 * @returns the state with that counted call settled.
 */
function settleCountedCall(state: MissionProjectionState, open: number, unknown: boolean): MissionProjectionState {
  const settled = countPending(state, open - 1)
  if (!unknown) return settled
  return { ...settled, uncertainOverflow: (state.uncertainOverflow ?? 0) + 1 }
}

/**
 * Fold one committed session event into the projection state. Mission changes
 * replay through the same strict fold the service reads, so a damaged record
 * leaves `failure` set instead of yielding a partly interpreted mission.
 * @param state - checkpoint state before the event.
 * @param event - committed session event.
 * @returns the state after the event, or the same reference when unaffected.
 */
function applyMissionProjection(state: MissionProjectionState, event: SessionEvent): MissionProjectionState {
  switch (event.type) {
    case 'mission/change': {
      if (state.failure !== null) return state
      try {
        const next = applyMissionChange(foldState(state), decodeMissionChange(event.data))
        return projectionState(next, state)
      } catch (error: unknown) {
        return { ...state, failure: error instanceof Error ? error.message : String(error) }
      }
    }
    case 'tool/call': {
      const call = { callId: event.data.callId, name: event.data.name }
      if (state.uncertainOperations.some(entry => entry.callId === call.callId)) return state
      const tracked = trackCall(state.pendingCalls, call)
      if (tracked.displaced.length === 0) return { ...state, pendingCalls: tracked.kept }
      // A displaced call is still open, and an open call is not a doubt yet: its
      // result may still arrive and say the outcome is known. Forget it and
      // recovery would resume past it, so the count keeps it visible until the
      // log settles it — one way or the other.
      return {
        ...state,
        pendingCalls: tracked.kept,
        pendingOverflow: (state.pendingOverflow ?? 0) + tracked.displaced.length,
      }
    }
    case 'tool/result': {
      const callId = event.data.message.source.callId
      const unknown = event.data.error?.code === TOOL_OUTCOME_UNKNOWN
      const pending = state.pendingCalls.find(entry => entry.callId === callId)
      if (pending === undefined) {
        // Not in the window: either an identity already recorded as a doubt, or
        // one of the open calls the window had to drop. Only the second case
        // accounts for anything, and it settles the count rather than doubting
        // the call: a result that became durable answers the question the
        // displacement was about, whatever the tracker remembered.
        if (state.uncertainOperations.some(entry => entry.callId === callId)) return state
        const open = state.pendingOverflow ?? 0
        return open > 0 ? settleCountedCall(state, open, unknown) : state
      }
      const remaining = state.pendingCalls.filter(entry => entry.callId !== callId)
      if (!unknown) return { ...state, pendingCalls: remaining }
      return trackUncertain({ ...state, pendingCalls: remaining }, pending)
    }
    default:
      return state
  }
}

/** Strict `mission` projection unit: durable record plus recovery diagnostics. */
export const missionProjectionDefinition = {
  key: 'mission',
  stateSchema: missionProjectionStateSchema,
  // 2: the tracker counts the open calls its window cannot name, so a displaced
  // call is no longer remembered as a doubt its result never earned. A cached
  // state from version 1 is discarded and re-folded from the session log.
  stateVersion: 2,
  init: (): MissionProjectionState => ({
    current: null,
    seenMissionIds: [],
    failure: null,
    pendingCalls: [],
    uncertainOperations: [],
  }),
  apply: applyMissionProjection,
  wire: { viewSchema: missionViewSchema, view: state => state.current },
} satisfies ProjectionDefinition<'mission', MissionProjectionState>

/** Validate one positive safe integer. */
function positiveInteger(value: unknown, code: MissionErrorCode, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new MissionError(`${field} must be a positive safe integer`, code)
  }
  return value
}

/** Validate and normalize completion criteria. */
function resolveCriteria(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMPLETION_CRITERIA) {
    throw new MissionError(
      `completionCriteria must hold between 1 and ${MAX_COMPLETION_CRITERIA} statements`,
      'MISSION_INVALID_CRITERIA',
    )
  }
  return value.map((entry: unknown, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new MissionError(`completionCriteria[${index}] must be a non-empty string`, 'MISSION_INVALID_CRITERIA')
    }
    if (entry.length > MAX_COMPLETION_CRITERION_LENGTH) {
      throw new MissionError(
        `completionCriteria[${index}] must be at most ${MAX_COMPLETION_CRITERION_LENGTH} characters`,
        'MISSION_INVALID_CRITERIA',
      )
    }
    return entry
  })
}

/** Validated start request. */
interface ResolvedStart {
  readonly objective: string
  readonly completionCriteria: readonly string[]
  readonly maxGoalRounds: number | undefined
  readonly maxRecoveryAttempts: number
  readonly recovery: MissionRecoveryPolicy
}

/** Validate one start request. */
function resolveStart(request: StartMissionRequest, defaultMaxRecoveryAttempts: number): ResolvedStart {
  if (typeof request.objective !== 'string' || request.objective.trim().length === 0) {
    throw new MissionError('mission objective must be a non-empty string', 'MISSION_INVALID_OBJECTIVE')
  }
  return {
    objective: request.objective.trim(),
    completionCriteria: resolveCriteria(request.completionCriteria),
    maxGoalRounds: request.maxGoalRounds === undefined
      ? undefined
      : positiveInteger(request.maxGoalRounds, 'MISSION_INVALID_ATTEMPTS', 'maxGoalRounds'),
    maxRecoveryAttempts: request.maxRecoveryAttempts === undefined
      ? defaultMaxRecoveryAttempts
      : positiveInteger(request.maxRecoveryAttempts, 'MISSION_INVALID_ATTEMPTS', 'maxRecoveryAttempts'),
    recovery: request.recovery ?? 'enabled',
  }
}

/** Validate one pending authorization. */
function resolveAuthorization(value: MissionAuthorization): MissionAuthorization {
  if (typeof value.code !== 'string' || !POLICY_CODE_PATTERN.test(value.code)) {
    throw new MissionError('mission authorization requires a lower-kebab-case code', 'MISSION_INVALID_AUTHORIZATION')
  }
  const code = assertPolicyCode(value.code)
  if (typeof value.message !== 'string' || value.message.trim().length === 0
    || value.message.length > MAX_DIAGNOSTIC_LENGTH) {
    throw new MissionError(
      `mission authorization message must be a non-empty string of at most ${MAX_DIAGNOSTIC_LENGTH} characters`,
      'MISSION_INVALID_AUTHORIZATION',
    )
  }
  return { code, message: value.message }
}

/** Validate one interruption record. */
function resolveInterruption(value: MissionInterruption): MissionInterruption {
  if (!Number.isSafeInteger(value.at) || value.at < 0) {
    throw new MissionError('interruption time must be a non-negative safe integer', 'MISSION_INVALID_INTERRUPTION')
  }
  if (value.detail !== undefined && (value.detail.trim().length === 0
    || value.detail.length > MAX_DIAGNOSTIC_LENGTH)) {
    throw new MissionError(
      `interruption detail must be a non-empty string of at most ${MAX_DIAGNOSTIC_LENGTH} characters`,
      'MISSION_INVALID_INTERRUPTION',
    )
  }
  return value.detail === undefined
    ? { kind: value.kind, at: value.at }
    : { kind: value.kind, at: value.at, detail: value.detail }
}

/**
 * Resolve deployment configuration; exported so the documented defaults stay
 * directly testable without a composition.
 * @param config - partial deployment configuration.
 * @returns the complete configuration every consumer reads.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    sweepOnStartup: config.sweepOnStartup ?? true,
    defaultMaxRecoveryAttempts: positiveInteger(
      config.defaultMaxRecoveryAttempts ?? 3,
      'MISSION_INVALID_ATTEMPTS',
      'defaultMaxRecoveryAttempts',
    ),
    maxMissionsPerSweep: positiveInteger(
      config.maxMissionsPerSweep ?? 32,
      'MISSION_INVALID_ATTEMPTS',
      'maxMissionsPerSweep',
    ),
    rebuildIndexOnStartup: config.rebuildIndexOnStartup ?? true,
    maxRebuildSessions: positiveInteger(
      config.maxRebuildSessions ?? 64,
      'MISSION_INVALID_ATTEMPTS',
      'maxRebuildSessions',
    ),
  }
}

/** Render an unexpected value for logs and diagnostics. */
function reasonOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Mission service (`ctx.missions`). Mission state lives in the owning session
 * log; the durable storage domain holds only the discovery index a later
 * process start reads, and that index is always reconciled against the log.
 */
export class MissionService extends Service {
  /**
   * `sessionPersistence` is a load-order requirement rather than a directly
   * called service: recovery resumes a persisted session through the agent
   * factory, which rejects without a persistence backend.
   */
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'storageDomain', 'goals']

  static Config: z<Config> = z.object({
    sweepOnStartup: z.boolean().default(true),
    defaultMaxRecoveryAttempts: z.number().step(1).min(1).max(100).default(3),
    maxMissionsPerSweep: z.number().step(1).min(1).max(1_000).default(32),
    rebuildIndexOnStartup: z.boolean().default(true),
    maxRebuildSessions: z.number().step(1).min(1).max(10_000).default(64),
  })

  /** Validated deployment configuration. */
  readonly resolved: ResolvedConfig
  /** Durable discovery index shared with the supervisor. */
  readonly ledger: RecoveryLedger
  /** Autonomous recovery driver for the missions this service records. */
  readonly supervisor: MissionSupervisor
  private readonly initialized: Promise<void>

  /**
   * @param ctx - host services owning sessions, projections, storage, and goals.
   * @param config - validated deployment configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'missions')
    this.resolved = resolveConfig(config)
    this.ledger = new RecoveryLedger(ctx)
    ctx.sessionProjections.register(missionProjectionDefinition)
    this.supervisor = new MissionSupervisor(ctx, this, this.resolved)
    ctx.effect(() => async () => {
      await this.supervisor.dispose()
      await this.ledger.close()
    })
    this.initialized = this.boot()
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * Read the current mission for one exact live agent.
   * @param agent - owning live agent.
   * @returns a fresh view, or `undefined` when no mission is current.
   * @throws {@link MissionError} when the agent is not the registry's live
   *   instance, or when the session's mission history failed strict replay.
   */
  get(agent: Agent): MissionView | undefined {
    this.assertLive(agent)
    const current = this.state(agent).current
    if (current === null) return undefined
    return { ...current, settled: this.settled(agent, current) }
  }

  /**
   * Recorded calls whose committed outcome is unknown, oldest first.
   *
   * This is what the durable log says about these calls, not what recovery still
   * has to stop for: a doubt a human already reviewed stays visible here — the
   * model still needs to know the outcome of a call nobody confirmed — and is
   * excluded only from the backlog `unacknowledgedUncertainty` reports.
   * @param agent - owning live agent.
   * @returns bounded call identities for recovery diagnostics.
   */
  uncertainOperations(agent: Agent): readonly UncertainOperation[] {
    this.assertLive(agent)
    return this.state(agent).uncertainOperations
  }

  /**
   * Unknown-outcome calls the bounded tracker could not list. Non-zero means the
   * doubt is at least as serious as a listed call, so callers that gate on
   * {@link uncertainOperations} must gate on this value too — and gate on both
   * through {@link unacknowledgedUncertainty}, which is also what subtracts the
   * reviews the mission record already carries.
   * @param agent - owning live agent.
   * @returns how many unknown-outcome calls were counted but not listed.
   */
  uncertainOverflow(agent: Agent): number {
    this.assertLive(agent)
    return this.state(agent).uncertainOverflow ?? 0
  }

  /**
   * Current plan entries from the todo projection, in plan order.
   * @param agent - owning live agent.
   * @returns plan entries, empty when no plan owner is composed for the session.
   */
  plan(agent: Agent): readonly RecoveryNoticeStep[] {
    this.assertLive(agent)
    // The todo projection owns the plan; this package publishes only the step
    // shape recovery renders, so no foreign plan type leaks through the API.
    return (this.ctx.sessionProjections.stateOf(agent.session, 'todos') ?? [])
      .map(item => ({ content: item.content, status: item.status }))
  }

  /**
   * Start one mission and the durable objective it carries. The discovery row
   * is written before the mission change, so a later process start can find the
   * mission; a rejected row write fails the start instead of leaving work that
   * nothing can recover.
   * @param agent - owning live agent.
   * @param request - objective, completion criteria, and optional budgets.
   * @returns the created mission view.
   * @throws {@link MissionError} on invalid input, an existing mission, or a
   *   rejected durable write.
   */
  async start(agent: Agent, request: StartMissionRequest): Promise<MissionView> {
    this.assertLive(agent)
    const spec = resolveStart(request, this.resolved.defaultMaxRecoveryAttempts)
    const current = this.state(agent).current
    if (current !== null) {
      throw new MissionError(
        `mission "${current.id}" is already current for this session`,
        'MISSION_STALE_REVISION',
      )
    }
    const goal = this.ctx.goals.create(agent, {
      objective: spec.objective,
      ...spec.maxGoalRounds === undefined ? {} : { maxGoalRounds: spec.maxGoalRounds },
    })
    const now = Date.now()
    const mission: MissionSnapshot = {
      id: MissionId(`mission-${randomUUID()}`),
      revision: 1,
      goal: { id: goal.id, revision: goal.revision },
      completionCriteria: spec.completionCriteria,
      recovery: spec.recovery,
      maxRecoveryAttempts: spec.maxRecoveryAttempts,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.ledger.put(this.row(agent, mission, this.rowState(mission)))
    } catch (error: unknown) {
      this.blockUnrecoverable(agent, mission, 'mission-index-failed',
        `The autonomous recovery index could not be written: ${reasonOf(error)}`)
      throw new MissionError(
        `mission index write failed: ${reasonOf(error)}`,
        'MISSION_PERSISTENCE_FAILED',
      )
    }
    try {
      const view = this.commit(agent, 'start', mission)
      // `commit` only appends. The start promise must not report success while
      // the record it announces could still be lost with the process, so the
      // durability barrier runs before the caller sees the mission.
      await this.flush(agent)
      return view
    } catch (error: unknown) {
      await this.dropRow(mission.id, agent)
      this.blockUnrecoverable(agent, mission, 'mission-record-failed',
        `The mission record could not be made durable: ${reasonOf(error)}`)
      // The caller was told the start failed, so the session must not be left
      // holding a current mission nobody may recover and nobody can replace. A
      // tombstone makes the slot reusable; it rides the same broken medium, and
      // when it is lost the recovery sweep settles the orphaned record instead.
      this.abandonStart(agent, mission)
      throw error instanceof MissionError
        ? error
        : new MissionError(
            `mission record could not be flushed: ${reasonOf(error)}`,
            'MISSION_PERSISTENCE_FAILED',
          )
    }
  }

  /**
   * Record a durable checkpoint of the mission's progress: the session prefix
   * up to the appended event is flushed before the call resolves, so a later
   * process start resumes after completed work instead of repeating it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the checkpointed view.
   * @throws {@link MissionError} on a stale ref or a rejected flush.
   */
  async checkpoint(agent: Agent, ref: MissionRef): Promise<MissionView> {
    const current = this.expect(agent, ref)
    const view = this.commit(agent, 'checkpoint', this.advance(current, {
      checkpoint: { seq: this.nextSeq(agent), at: Math.max(Date.now(), current.updatedAt) },
    }))
    await this.flush(agent)
    await this.tryRecordRow(agent, view)
    return view
  }

  /**
   * Consume one recovery attempt and record why recovery is taking over. The
   * appended record and the work it authorizes are flushed before this resolves,
   * so a rejected flush fails the attempt instead of running work the durable
   * log cannot justify.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param input - the interruption cause and optional bounded detail.
   * @returns the updated view with the consumed attempt.
   * @throws {@link MissionError} on a stale ref, a disabled policy, an exhausted
   *   budget, or a rejected flush.
   */
  async recordAttempt(
    agent: Agent,
    ref: MissionRef,
    input: { readonly interruption: MissionInterruption },
  ): Promise<MissionView> {
    const current = this.expect(agent, ref)
    const interruption = resolveInterruption(input.interruption)
    if (current.recovery === 'disabled') {
      throw new MissionError(
        `mission "${current.id}" does not authorize autonomous recovery`,
        'MISSION_RECOVERY_DISABLED',
      )
    }
    if (current.attempts >= current.maxRecoveryAttempts) {
      throw new MissionError(
        `mission "${current.id}" already consumed its ${current.maxRecoveryAttempts} recovery attempts`,
        'MISSION_INVALID_ATTEMPTS',
      )
    }
    const view = this.commit(agent, 'attempt', this.advance(current, {
      attempts: current.attempts + 1,
      interruption,
      checkpoint: { seq: this.nextSeq(agent), at: Math.max(Date.now(), current.updatedAt) },
    }))
    await this.flush(agent)
    await this.tryRecordRow(agent, view)
    return view
  }

  /**
   * Record pending human authorization. Autonomous recovery stops claiming the
   * mission until {@link resume} records the decision, so recovery never
   * substitutes for the approval the approval seam owns.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param authorization - policy-owned code and explanation.
   * @returns the updated view.
   */
  async authorize(agent: Agent, ref: MissionRef, authorization: MissionAuthorization): Promise<MissionView> {
    const current = this.expect(agent, ref)
    const view = this.commit(agent, 'authorize', this.advance(current, {
      authorization: resolveAuthorization(authorization),
    }))
    await this.recordRow(agent, view)
    return view
  }

  /**
   * Clear pending human authorization after the decision was recorded, making
   * the mission claimable again.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the updated view.
   * @throws {@link MissionError} when no authorization is pending.
   */
  async resume(agent: Agent, ref: MissionRef): Promise<MissionView> {
    const current = this.expect(agent, ref)
    if (current.authorization === undefined) {
      throw new MissionError(
        `mission "${current.id}" records no pending authorization`,
        'MISSION_INVALID_AUTHORIZATION',
      )
    }
    // Clearing an uncertainty hold is the human decision that lets recovery
    // touch this mission again, and the decision has a scope: the person reviewed
    // the doubts this mission had been shown, no more. The count of those doubts
    // is what the record keeps, so a call whose outcome becomes unknown later is
    // outstanding on its own and the next sweep stops for it again. The count
    // lives with the durable record — never with a discovery row — because the
    // row is a hint that a later mutation or an index rebuild rewrites, while
    // this is the fact of what was reviewed.
    const state = this.state(agent)
    const recorded = recordedUncertainty(state.uncertainOperations, state.uncertainOverflow ?? 0)
    const reviewing = current.authorization.code === UNCERTAIN_OPERATIONS && recorded > 0
    const acknowledged = Math.max(current.uncertainAcknowledged ?? 0, reviewing ? recorded : 0)
    const next: MissionSnapshot = {
      id: current.id,
      revision: current.revision + 1,
      goal: current.goal,
      completionCriteria: current.completionCriteria,
      recovery: current.recovery,
      maxRecoveryAttempts: current.maxRecoveryAttempts,
      attempts: current.attempts,
      ...current.interruption === undefined ? {} : { interruption: current.interruption },
      ...current.checkpoint === undefined ? {} : { checkpoint: current.checkpoint },
      ...acknowledged === 0 ? {} : { uncertainAcknowledged: acknowledged },
      createdAt: current.createdAt,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    }
    const view = this.commit(agent, 'resume', next)
    if (reviewing) {
      // The row keeps a diagnostic of the same decision, for whoever reads the
      // index. It reports the review and never authorizes anything: a sweep
      // decides from the durable record, so no doubt recorded after this moment
      // can inherit it.
      await this.ledger.put({
        ...this.row(agent, view, this.rowState(view)),
        lastError: {
          code: UNCERTAIN_ACKNOWLEDGED,
          message: `A human reviewed ${recorded} recorded tool call(s) with unknown outcomes and resumed this mission.`,
        },
      })
      return view
    }
    await this.recordRow(agent, view)
    return view
  }

  /**
   * Clear the current mission, retaining a durable tombstone, and remove its
   * discovery row. The linked objective is deliberately untouched: releasing
   * the continuity commitment is not completing the work.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the tombstone ref, one revision past the cleared record.
   */
  async clear(agent: Agent, ref: MissionRef): Promise<MissionRef> {
    const current = this.expect(agent, ref)
    const change: MissionChangeMeta = {
      kind: 'mission/change',
      version: MISSION_CHANGE_VERSION,
      operation: 'clear',
      cleared: { id: current.id, revision: current.revision },
      clearedAt: Math.max(Date.now(), current.updatedAt),
    }
    agent.session.append('mission/change', change)
    this.notify(agent, change)
    await this.dropRow(current.id, agent)
    this.supervisor.release(agent.session.id)
    return { id: current.id, revision: current.revision + 1 }
  }

  /**
   * Recover every armed mission the durable index lists, then report what
   * happened. Calls are serialized, so two sweeps never claim one mission twice.
   * @returns the sweep report; per-mission failures are reported, never thrown.
   */
  async sweep(): Promise<MissionSweepReport> {
    return await this.supervisor.sweep()
  }

  /**
   * Standing index state for one durable record: `armed` only while autonomous
   * recovery may claim it without human action.
   * @param current - durable mission record.
   * @returns the row state the record justifies.
   */
  rowState(current: MissionSnapshot): 'armed' | 'held' {
    return current.recovery === 'enabled'
      && current.authorization === undefined
      && current.attempts < current.maxRecoveryAttempts
      ? 'armed'
      : 'held'
  }

  /** Open the ledger, repair it from durable logs, then perform the startup sweep. */
  private async boot(): Promise<void> {
    await this.ledger.open()
    await this.rebuildIndex()
    await this.supervisor.start()
  }

  /**
   * Rebuild discovery rows the index lost from the durable session logs.
   *
   * The log owns mission state and the index only makes it discoverable without
   * reading every log, so a missing row must never hide a durable mission: a
   * restored medium, a dropped write, or a hand-edited index would otherwise
   * strand work that exists on disk. Startup therefore reads the logs of the
   * sessions the index does not mention and writes the row each durable record
   * justifies. A rebuilt row is still only a hint — the sweep reconciles it
   * against the log before it claims anything — and the scan is bounded, so an
   * unreachable or oversized corpus degrades to "not rebuilt this boot".
   */
  private async rebuildIndex(): Promise<void> {
    if (!this.resolved.rebuildIndexOnStartup) return
    let known: Set<string>
    let snapshots: readonly { readonly header: { readonly id: string } }[]
    try {
      known = new Set((await this.ledger.list()).map(row => row.sessionId))
      snapshots = await this.ctx.sessionPersistence.list()
    } catch (error: unknown) {
      this.ctx.logger.warn(`mission-continuity: index rebuild skipped: ${reasonOf(error)}`)
      return
    }
    const missing = snapshots.filter(snapshot => !known.has(snapshot.header.id))
    if (missing.length === 0) return
    let rebuilt = 0
    for (const snapshot of missing.slice(0, this.resolved.maxRebuildSessions)) {
      try {
        const mission = await this.storedMission(SessionId(snapshot.header.id))
        if (mission === null) continue
        await this.ledger.put(this.rowFor(SessionId(snapshot.header.id), mission, this.rowState(mission)))
        rebuilt += 1
      } catch (error: unknown) {
        this.ctx.logger.warn(
          `mission-continuity: index rebuild skipped "${snapshot.header.id}": ${reasonOf(error)}`,
        )
      }
    }
    if (rebuilt > 0) {
      this.ctx.logger.info(`mission-continuity: rebuilt ${rebuilt} discovery row(s) from the session logs`)
    }
  }

  /**
   * Fold one stored session log far enough to find the mission work it still
   * owes. The log is the authority, so the rebuild reads the same events a
   * replay would: the current mission record, and the durable objective it is
   * linked to. A mission whose objective already completed is finished work, not
   * recoverable work, and must not reappear as an armed row on every boot.
   * @param sessionId - session whose durable log to read.
   * @returns the durable record, or `null` when the log holds no recoverable mission.
   */
  private async storedMission(sessionId: SessionId): Promise<MissionSnapshot | null> {
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read(0)
      const mission = foldMission(events).mission
      if (mission === undefined) return null
      const goals = events.reduce(goalProjectionDefinition.apply, goalProjectionDefinition.init())
      const goal = goals.current
      // Only a live objective is recoverable work: a completed one is settled,
      // and a missing or replaced one is the sweep's `objective-missing` hold,
      // which a rebuild cannot justify from a dropped index alone.
      if (goal === null || goal.goal.id !== mission.goal.id || goal.goal.phase === 'complete') return null
      return mission
    } finally {
      await handle.close()
    }
  }

  /** Projection state, failing loudly after a retained replay failure. */
  private state(agent: Agent): MissionProjectionState {
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'mission')
    /* v8 ignore next -- static inject requires the projection registry before activation. */
    if (state === undefined) {
      throw new MissionError('mission projection is not registered', 'MISSION_AGENT_NOT_LIVE')
    }
    if (state.failure !== null) {
      throw new MissionError(`mission history failed strict replay: ${state.failure}`, 'MISSION_AGENT_NOT_LIVE')
    }
    return state
  }

  /** Require the exact registered live agent. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new MissionError(`agent "${agent.id}" is not the registry's live instance`, 'MISSION_AGENT_NOT_LIVE')
    }
  }

  /** Require the exact current revision. */
  private expect(agent: Agent, ref: MissionRef): MissionSnapshot {
    this.assertLive(agent)
    const current = this.state(agent).current
    if (current === null || current.id !== ref.id) {
      throw new MissionError(`mission "${ref.id}" is not current for this session`, 'MISSION_NOT_FOUND')
    }
    if (current.revision !== ref.revision) {
      throw new MissionError(
        `mission "${ref.id}" is at revision ${current.revision}, not ${ref.revision}`,
        'MISSION_STALE_REVISION',
      )
    }
    return current
  }

  /** Build the next revision of one current record. */
  private advance(current: MissionSnapshot, patch: Partial<MissionSnapshot>): MissionSnapshot {
    return {
      ...current,
      ...patch,
      id: current.id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: Math.max(Date.now(), current.updatedAt),
    }
  }

  /** The seq the next appended event will occupy. */
  private nextSeq(agent: Agent): number {
    return Math.max(0, agent.session.seq - 1)
  }

  /** Whether the linked objective already records completion. */
  private settled(agent: Agent, mission: MissionSnapshot): boolean {
    const goal = this.ctx.goals.get(agent)
    return goal !== undefined && goal.id === mission.goal.id && goal.phase === 'complete'
  }

  /** Append one snapshot change, notify, and return the committed view. */
  private commit(agent: Agent, operation: SnapshotOperation, mission: MissionSnapshot): MissionView {
    const change: MissionSnapshotChangeMeta = {
      kind: 'mission/change',
      version: MISSION_CHANGE_VERSION,
      operation,
      mission,
    }
    agent.session.append('mission/change', change)
    this.notify(agent, change)
    return { ...mission, settled: this.settled(agent, mission) }
  }

  /** Refresh the discovery row durably. */
  private async recordRow(agent: Agent, view: MissionSnapshot): Promise<void> {
    await this.ledger.put(this.row(agent, view, this.rowState(view)))
  }

  /** Refresh the discovery row, reporting a rejected write without failing the mutation. */
  private async tryRecordRow(agent: Agent, view: MissionSnapshot): Promise<void> {
    try {
      await this.recordRow(agent, view)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `mission-continuity: could not refresh the recovery index for "${view.id}": ${reasonOf(error)}`,
      )
    }
  }

  /** Remove a discovery row, reporting a rejected removal without failing the caller. */
  private async dropRow(missionId: MissionSnapshot['id'], agent: Agent): Promise<void> {
    try {
      await this.ledger.delete(missionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `mission-continuity: could not drop the recovery row for "${missionId}" (agent "${agent.id}"): ${reasonOf(error)}`,
      )
    }
  }

  /** Build one discovery row from a durable record. */
  private row(agent: Agent, mission: MissionSnapshot, state: 'armed' | 'held'): RecoveryRecord {
    return this.rowFor(agent.session.id, mission, state)
  }

  /** Build one discovery row for a stored record owned by one session. */
  private rowFor(sessionId: SessionId, mission: MissionSnapshot, state: 'armed' | 'held'): RecoveryRecord {
    const lastError = state === 'held'
      ? {
          code: mission.authorization?.code
            ?? (mission.recovery === 'disabled' ? 'recovery-disabled' : 'recovery-exhausted'),
          message: mission.authorization?.message
            ?? (mission.recovery === 'disabled'
              ? 'This mission does not authorize autonomous recovery.'
              : `The recovery budget of ${mission.maxRecoveryAttempts} attempts is spent.`),
        }
      : undefined
    return {
      sessionId,
      missionId: mission.id,
      goalId: mission.goal.id,
      revision: mission.revision,
      attempts: mission.attempts,
      state,
      ...lastError === undefined ? {} : { lastError },
      updatedAt: new Date(mission.updatedAt).toISOString(),
    }
  }

  /**
   * Retire a mission whose start already failed, so the session can start again
   * instead of exposing a current record the caller was told does not exist.
   * @param agent - owning live agent.
   * @param mission - the record the failed start had committed.
   */
  private abandonStart(agent: Agent, mission: MissionSnapshot): void {
    try {
      const change: MissionChangeMeta = {
        kind: 'mission/change',
        version: MISSION_CHANGE_VERSION,
        operation: 'clear',
        cleared: { id: mission.id, revision: mission.revision },
        clearedAt: Math.max(Date.now(), mission.updatedAt),
      }
      agent.session.append('mission/change', change)
      this.notify(agent, change)
    } catch (error: unknown) {
      this.ctx.logger.warn(`mission-continuity: could not retire the failed start: ${reasonOf(error)}`)
    }
  }

  /** Fail closed: an unwritable mission record must not look like a running mission. */
  private blockUnrecoverable(agent: Agent, mission: MissionSnapshot, code: string, message: string): void {
    try {
      const goal = this.ctx.goals.get(agent)
      if (goal === undefined || goal.id !== mission.goal.id) return
      this.ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
        code,
        message: message.slice(0, MAX_DIAGNOSTIC_LENGTH),
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`mission-continuity: could not block the mission objective: ${reasonOf(error)}`)
    }
  }

  /** Flush the session, reporting a rejected durability barrier as a mission failure. */
  private async flush(agent: Agent): Promise<void> {
    try {
      await this.ctx.sessions.flush(agent.session)
    } catch (error: unknown) {
      throw new MissionError(
        `mission durability checkpoint failed: ${reasonOf(error)}`,
        'MISSION_PERSISTENCE_FAILED',
      )
    }
  }

  /** Emit the contained live notification for one committed change. */
  private notify(agent: Agent, change: MissionChangeMeta): void {
    const notification: MissionChanged = {
      operation: change.operation,
      ref: missionChangeRef(change),
      ...change.operation === 'clear' ? {} : { mission: { ...change.mission, settled: false } },
    }
    try {
      agentEvents(this.ctx, agent).emit('mission/changed', { change: notification })
    } catch (error: unknown) {
      /* v8 ignore start -- agentEvents contains listener failures; only a dispatch error reaches this guard. */
      this.ctx.logger.warn(`mission-continuity: mission/changed listener failed: ${reasonOf(error)}`)
      /* v8 ignore stop */
    }
  }
}

export default MissionService
