/**
 * Autonomous mission recovery: the startup sweep that turns durable mission
 * records back into running work without a new user message.
 *
 * The sweep never decides from the durable index alone. Every candidate is
 * reconciled against the session log (the authority), the linked durable
 * objective, and any pending human authorization before an attempt is
 * consumed. A mission whose work cannot be recovered safely is left `held`
 * with a diagnostic instead of being guessed at.
 * @module @deepseek-ai/dsh-mission-continuity
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { GoalChanged, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_DIAGNOSTIC_LENGTH } from './runtime.ts'
import { renderMissionRecoveryNotice } from './prompt.ts'
import type { RecoveryRecord } from './ledger.ts'
import type { MissionService, ResolvedConfig } from './service.ts'
import type {
  MissionAgentSetupPlan,
  MissionAgentSetupRequest,
  MissionInterruptionKind,
  MissionView,
} from './types.ts'

/** What one candidate produced. */
export type MissionSweepOutcome = 'resumed' | 'held' | 'settled' | 'exhausted' | 'failed'

/** Result of one recovery sweep. */
export interface MissionSweepReport {
  /** Armed rows the sweep considered. */
  readonly considered: number
  /** Missions whose work was resumed. */
  readonly resumed: number
  /** Missions left waiting for human action. */
  readonly held: number
  /** Stale rows dropped because the log no longer holds a recoverable mission. */
  readonly settled: number
  /** Missions whose recovery budget was already spent. */
  readonly exhausted: number
  /** Missions whose recovery raised an unexpected failure. */
  readonly failed: number
}

/** Render an unexpected value for logs and diagnostics. */
function reasonOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Bound one diagnostic to what a durable row accepts. */
function diagnostic(message: string): string {
  return message.length <= MAX_DIAGNOSTIC_LENGTH ? message : message.slice(0, MAX_DIAGNOSTIC_LENGTH)
}

/**
 * Recovery driver for one composition. It holds the Agents it resumed so the
 * work keeps running, releases them when the mission settles, and never
 * revives a mission whose durable state forbids it.
 */
export class MissionSupervisor {
  private readonly handles = new Map<string, AgentHandle>()
  private running: Promise<MissionSweepReport> | undefined
  private stopping = false

  /**
   * @param ctx - host services providing agents, goals, and logging.
   * @param service - mission state owner the sweep reconciles against.
   * @param config - validated deployment configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly service: MissionService,
    private readonly config: ResolvedConfig,
  ) {
    ctx.effect(() => {
      const settled = ctx.on('goal/changed', ({ agent, change }) => {
        void this.reconcileGoal(agent, change).catch((error: unknown) => {
          ctx.logger.warn(`mission-continuity: goal reconciliation failed: ${reasonOf(error)}`)
        })
      })
      const disposed = ctx.on('agent/disposed', ({ agent }) => {
        this.handles.delete(agent.session.id)
      })
      return () => {
        settled()
        disposed()
      }
    }, 'mission-continuity supervisor')
  }

  /**
   * Attach to the running composition and perform the configured startup sweep.
   * @returns resolution after the startup sweep, if one is configured.
   */
  async start(): Promise<void> {
    if (!this.config.sweepOnStartup) return
    await this.sweep()
  }

  /**
   * Recover every armed mission in the durable index, first-writer order, up to
   * the configured bound. Concurrent callers share one running sweep.
   * @returns the report for the sweep that ran or is running.
   */
  async sweep(): Promise<MissionSweepReport> {
    if (this.running !== undefined) return await this.running
    const run = this.runSweep().finally(() => { this.running = undefined })
    this.running = run
    return await run
  }

  /**
   * Release the Agent this supervisor holds for one session, if any. Called when
   * a mission settles or is cleared by another owner.
   * @param sessionId - session whose held Agent is released.
   */
  release(sessionId: SessionId): void {
    const handle = this.handles.get(sessionId)
    if (handle === undefined) return
    this.handles.delete(sessionId)
    void handle.dispose().catch((error: unknown) => {
      this.ctx.logger.warn(
        `mission-continuity: could not release the recovered agent for "${sessionId}": ${reasonOf(error)}`,
      )
    })
  }

  /**
   * Stop claiming missions and release every held Agent.
   * @returns resolution after the running sweep and every release settle.
   */
  async dispose(): Promise<void> {
    this.stopping = true
    const waits: Promise<void>[] = []
    for (const sessionId of [...this.handles.keys()]) {
      const handle = this.handles.get(sessionId)
      this.handles.delete(sessionId)
      if (handle !== undefined) waits.push(handle.dispose())
    }
    if (this.running !== undefined) waits.push(this.running.then(() => undefined, () => undefined))
    await Promise.allSettled(waits)
  }

  /** Perform one sweep, reporting every candidate outcome. */
  private async runSweep(): Promise<MissionSweepReport> {
    const rows = (await this.service.ledger.list())
      .filter(row => row.state === 'armed')
      .slice(0, this.config.maxMissionsPerSweep)
    const report = { considered: rows.length, resumed: 0, held: 0, settled: 0, exhausted: 0, failed: 0 }
    for (const row of rows) {
      if (this.stopping) break
      const outcome = await this.recover(row)
      report[outcome] += 1
    }
    return report
  }

  /**
   * Recover one candidate, converting any unexpected failure into a diagnostic.
   * The Agent this call resumed stays held only when the mission actually
   * resumed work; every other outcome releases it again.
   */
  private async recover(row: RecoveryRecord): Promise<MissionSweepOutcome> {
    let handle: AgentHandle | undefined
    try {
      let agent = this.ctx.agents.get(row.sessionId)
      if (agent === undefined) {
        const plan = await this.planFor(row.sessionId)
        handle = await this.ctx.agents.resume({
          resumeSessionId: row.sessionId,
          ...plan.agentOptions === undefined ? {} : { agentOptions: plan.agentOptions },
          ...plan.setup === undefined ? {} : { setup: plan.setup },
        })
        agent = handle.agent
        this.handles.set(row.sessionId, handle)
      }
      // A live agent means the previous turn failed; a resumed one means the
      // whole process went away. The durable record keeps the distinction.
      const outcome = await this.claim(row, agent, handle === undefined ? 'request-failed' : 'process-restart')
      if (outcome !== 'resumed' && handle !== undefined) this.release(row.sessionId)
      return outcome
    } catch (error: unknown) {
      if (handle !== undefined) this.release(row.sessionId)
      await this.hold(row, 'recovery-failed', reasonOf(error))
      return 'failed'
    }
  }

  /** Reconcile one candidate against the durable log and act on the result. */
  private async claim(
    row: RecoveryRecord,
    agent: Agent,
    interruption: MissionInterruptionKind,
  ): Promise<MissionSweepOutcome> {
    const mission = this.service.get(agent)
    if (mission === undefined || mission.id !== row.missionId) {
      await this.settle(row)
      return 'settled'
    }
    if (mission.settled) {
      await this.settle(row)
      return 'settled'
    }
    if (mission.recovery === 'disabled') {
      await this.hold(row, 'recovery-disabled', 'This mission does not authorize autonomous recovery.')
      return 'held'
    }
    if (mission.authorization !== undefined) {
      await this.hold(row, mission.authorization.code, mission.authorization.message)
      return 'held'
    }
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined || goal.id !== mission.goal.id) {
      await this.hold(row, 'objective-missing', 'The mission objective is no longer current for this session.')
      return 'held'
    }
    if (goal.phase === 'complete') {
      await this.settle(row)
      return 'settled'
    }
    if (goal.phase === 'paused' || goal.phase === 'blocked') {
      await this.hold(row, `objective-${goal.phase}`, goal.blockedReason?.message
        ?? `The mission objective is ${goal.phase}; recovery needs a human resume.`)
      return 'held'
    }
    if (mission.attempts >= mission.maxRecoveryAttempts) {
      this.exhaust(agent, mission, goal)
      await this.hold(row, 'recovery-exhausted',
        `The recovery budget of ${mission.maxRecoveryAttempts} attempts is spent.`)
      return 'exhausted'
    }
    await this.resume(agent, mission, goal, interruption)
    return 'resumed'
  }

  /**
   * Consume the durable attempt, notify the model, then re-arm the objective so
   * the same-session continuation driver takes over. The attempt record is
   * flushed before either step, so work never starts on an unrecorded attempt.
   */
  private async resume(
    agent: Agent,
    mission: MissionView,
    goal: GoalView,
    interruption: MissionInterruptionKind,
  ): Promise<void> {
    const interrupted = Date.now()
    const attempted = await this.service.recordAttempt(
      agent,
      { id: mission.id, revision: mission.revision },
      { interruption: { kind: interruption, at: interrupted } },
    )
    const notice = createUserMessage({
      content: renderMissionRecoveryNotice({
        mission: attempted,
        objective: goal.objective,
        attempt: attempted.attempts,
        steps: this.service.plan(agent),
        uncertainOperations: this.service.uncertainOperations(agent),
      }),
      source: {
        kind: 'mission',
        missionId: attempted.id,
        revision: attempted.revision,
        attempt: attempted.attempts,
      },
    })
    // Queue the notice before arming the objective: the continuation driver
    // yields to competing queued input, so the model reads why it woke before
    // the next automatic round is admitted.
    agent.followup(notice)
    const current = this.ctx.goals.get(agent)
    if (current !== undefined && current.id === goal.id && current.activation === 'disarmed') {
      this.ctx.goals.resume(agent, { id: current.id, revision: current.revision })
    }
  }

  /** Record exhaustion on the durable objective so a human sees the blocker. */
  private exhaust(agent: Agent, mission: MissionView, goal: GoalView): void {
    try {
      this.ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
        code: 'recovery-exhausted',
        message: `Mission "${mission.id}" consumed its ${mission.maxRecoveryAttempts} autonomous recovery attempts.`,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`mission-continuity: could not record recovery exhaustion: ${reasonOf(error)}`)
    }
  }

  /** Keep the index honest when the durable objective moves on its own. */
  private async reconcileGoal(agent: Agent, change: GoalChanged): Promise<void> {
    const mission = this.service.get(agent)
    if (mission === undefined || mission.goal.id !== change.ref.id) return
    const row = (await this.service.ledger.list()).find(entry => entry.missionId === mission.id)
    if (row === undefined) return
    if (mission.settled || change.goal?.phase === 'complete') {
      await this.settle(row)
      return
    }
    if (change.goal?.phase === 'blocked') {
      await this.hold(row, change.goal.blockedReason?.code ?? 'objective-blocked',
        change.goal.blockedReason?.message ?? 'The mission objective reported a blocker.')
      return
    }
    if (row.revision === mission.revision && row.state === this.service.rowState(mission)) return
    await this.service.ledger.put({
      ...row,
      revision: mission.revision,
      attempts: mission.attempts,
      state: this.service.rowState(mission),
      updatedAt: new Date(mission.updatedAt).toISOString(),
    })
  }

  /** Drop a stale row and stop holding its Agent. */
  private async settle(row: RecoveryRecord): Promise<void> {
    await this.service.ledger.delete(row.missionId)
    this.release(row.sessionId)
  }

  /** Mark one row as waiting for human action, with its diagnostic. */
  private async hold(row: RecoveryRecord, code: string, message: string): Promise<void> {
    try {
      await this.service.ledger.put({
        ...row,
        state: 'held',
        lastError: { code: code.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), message: diagnostic(message) },
        updatedAt: new Date().toISOString(),
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`mission-continuity: could not hold the recovery row for "${row.missionId}": ${reasonOf(error)}`)
    }
  }

  /**
   * Ask the deployment how to compose one resumed Agent. Recovery never picks
   * a provider, a model, or a preset on its own: an empty plan resumes the log
   * without options, and the first request then fails loud.
   */
  private async planFor(sessionId: SessionId): Promise<MissionAgentSetupPlan> {
    const request: MissionAgentSetupRequest = { sessionId }
    return await this.ctx.waterfall(
      'mission/agent-setup',
      request,
      async (): Promise<MissionAgentSetupPlan> => ({}),
    )
  }
}
