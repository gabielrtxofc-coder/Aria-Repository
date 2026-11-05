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
import { MAX_DIAGNOSTIC_LENGTH, UNCERTAIN_OPERATIONS } from './runtime.ts'
import { unacknowledgedUncertainty } from './uncertainty.ts'
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
export type MissionSweepOutcome = 'resumed' | 'held' | 'settled' | 'exhausted' | 'failed' | 'skipped'

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
  /** Candidates this supervisor already recovered and has not seen progress from. */
  readonly skipped: number
}

/** Render an unexpected value for logs and diagnostics. */
function reasonOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Whether a failure means another live instance owns the session, not that the
 * mission is broken. Two `dsh` processes over one home are a supported mistake:
 * the loser must not clobber the winner's index row with its own stale view.
 * @param error - the rejection raised while composing or reading the session.
 * @returns `true` when the session belongs to another owner.
 */
function ownedElsewhere(error: unknown): boolean {
  return error instanceof Error && error.name === 'SessionAlreadyOwnedError'
}

/**
 * Render the diagnostic that records an unknown-outcome hold.
 *
 * The message must fit the durable record's diagnostic limit: an over-long one
 * is rejected by `authorize()`, and the sweep would then hold the mission under
 * a generic failure code instead of the `uncertain-operations` code a human has
 * to clear — leaving the work stuck behind a doubt nobody is told how to
 * resolve. The number of recorded doubts always fits; the names are what get
 * trimmed, because the count is what a human acts on.
 * @param uncertain - unknown-outcome calls the tracker could list.
 * @param overflow - unknown-outcome calls it had to count instead.
 * @returns a diagnostic of at most {@link MAX_DIAGNOSTIC_LENGTH} characters.
 */
export function uncertainMessage(
  uncertain: readonly { readonly name: string }[],
  overflow: number,
): string {
  const total = uncertain.length + overflow
  const head = `Interrupted tool calls whose outcome is unknown: ${total} recorded`
  const trailer = '. Verify the external state before this mission continues.'
  const names = [...new Set(uncertain.map(operation => operation.name))]
  const shown: string[] = []
  for (const name of names) {
    const candidate = [...shown, name].join(', ')
    const rendered = candidate === names.join(', ') ? ` (${candidate})` : ` (${candidate}, …)`
    if ((head + rendered + trailer).length > MAX_DIAGNOSTIC_LENGTH) break
    shown.push(name)
  }
  const detail = shown.length === 0 ? '' : ` (${shown.join(', ')}${shown.length === names.length ? '' : ', …'})`
  // Every part above is budgeted, so the result fits; the slice is the belt.
  return `${head}${detail}${trailer}`.slice(0, MAX_DIAGNOSTIC_LENGTH)
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
  /**
   * Missions this supervisor already recovered, keyed by session, with the
   * durable state the recovery left behind. One interruption buys one recovery:
   * a later sweep skips a candidate whose record still reads exactly like the
   * one an attempt already paid for, so a repeated sweep cannot consume a second
   * attempt, queue a second notice, or resume the same work twice.
   */
  private readonly claims = new Map<string, { readonly missionId: string; readonly revision: number; readonly attempts: number }>()
  /**
   * Rotation cursor over `ledger.list()` order. `maxMissionsPerSweep` bounds the
   * work one sweep does, not which missions it can ever reach: without a cursor
   * every sweep starts at the same first row, so a mission this supervisor has
   * already claimed keeps the budget to itself forever and every later
   * interruption stays unrecoverable until the first mission settles. Each
   * sweep starts where the previous one stopped and wraps once, so every armed
   * mission is reached within `ceil(rows / perSweep)` sweeps.
   */
  private cursor = 0
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
        this.claims.delete(agent.session.id)
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
    this.claims.delete(sessionId)
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
    const waits: Promise<unknown>[] = []
    for (const [sessionId, handle] of [...this.handles]) {
      this.handles.delete(sessionId)
      this.claims.delete(sessionId)
      waits.push(handle.dispose())
    }
    this.claims.clear()
    // `allSettled` already contains a failing sweep or release.
    if (this.running !== undefined) waits.push(this.running)
    await Promise.allSettled(waits)
  }

  /** Perform one sweep, reporting every candidate outcome. */
  private async runSweep(): Promise<MissionSweepReport> {
    const armed = (await this.service.ledger.list()).filter(row => row.state === 'armed')
    const rows = this.rotate(armed)
    const report = { considered: rows.length, resumed: 0, held: 0, settled: 0, exhausted: 0, failed: 0, skipped: 0 }
    for (const row of rows) {
      if (this.stopping) break
      const outcome = await this.recover(row)
      report[outcome] += 1
    }
    return report
  }

  /**
   * Take this sweep's bounded window of candidates, starting at the cursor left
   * by the previous sweep and wrapping once. The cursor advances by the number
   * of rows this sweep considered, so a repeated sweep of a large index reaches
   * a different window instead of re-examining the same leading rows forever.
   * `ledger.list()` is first-write ordered, so the rotation is stable across
   * sweeps of the same index.
   * @param armed - every armed row the index holds, in ledger order.
   * @returns at most `maxMissionsPerSweep` rows, in ledger order from the cursor.
   */
  private rotate(armed: readonly RecoveryRecord[]): readonly RecoveryRecord[] {
    if (armed.length === 0) return []
    const bound = this.config.maxMissionsPerSweep
    const start = this.cursor % armed.length
    const window = [...armed.slice(start), ...armed.slice(0, start)].slice(0, bound)
    this.cursor = (start + window.length) % armed.length
    return window
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
      // The Agent this supervisor already resumed for the same durable state
      // *is* the recovery; claiming it again would duplicate the work.
      if (agent !== undefined && this.alreadyRecovered(agent)) return 'skipped'
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
      // The other owner is already recovering this mission. Leaving the row
      // alone keeps its attempt count and notice the only ones that exist.
      if (ownedElsewhere(error)) return 'skipped'
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
    // A call that started without a durable result may or may not have changed
    // external state. Resuming would let the model repeat a destructive action
    // nobody confirmed, so recovery stops and records the doubt where a human
    // can act on it; only a recorded decision resumes this mission — and only
    // for the doubts that decision covered, which is why the backlog is measured
    // against the durable record instead of any note the index row may carry. A
    // row is a hint: it is rewritten by the next mutation and rebuilt from the
    // logs, so it cannot be what authorizes continuing past an effect nobody
    // confirmed.
    const backlog = unacknowledgedUncertainty(
      this.service.uncertainOperations(agent),
      this.service.uncertainOverflow(agent),
      mission.uncertainAcknowledged,
    )
    if (backlog.count > 0) {
      const message = uncertainMessage(backlog.operations, backlog.unlisted)
      const authorized = await this.service.authorize(
        agent,
        { id: mission.id, revision: mission.revision },
        { code: UNCERTAIN_OPERATIONS, message },
      )
      await this.hold({ ...row, revision: authorized.revision, attempts: authorized.attempts },
        UNCERTAIN_OPERATIONS, message)
      return 'held'
    }
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined || goal.id !== mission.goal.id) {
      await this.hold(row, 'objective-missing', 'The mission objective is no longer current for this session.')
      return 'held'
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
   * Whether this supervisor already paid an attempt for the durable state one
   * Agent still holds. Progress advances the revision or the attempt count, so a
   * genuinely new interruption after progress is claimable again.
   * @param agent - live Agent the candidate resolves to.
   * @returns `true` when a claim covers the current record.
   */
  private alreadyRecovered(agent: Agent): boolean {
    const claim = this.claims.get(agent.session.id)
    if (claim === undefined) return false
    const mission = this.service.get(agent)
    // A claim is only written for the record its Agent still holds, so the
    // lookup above cannot miss; the guard keeps a torn composition honest.
    /* v8 ignore start */
    if (mission === undefined) return false
    /* v8 ignore stop */
    return mission.id === claim.missionId
      && mission.revision === claim.revision
      && mission.attempts === claim.attempts
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
        uncertainOverflow: this.service.uncertainOverflow(agent),
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
    this.claims.set(agent.session.id, {
      missionId: attempted.id,
      revision: attempted.revision,
      attempts: attempted.attempts,
    })
    const current = this.ctx.goals.get(agent)
    // Recording the attempt already disarmed this objective, so the resume
    // below is the one that re-arms it; the guard keeps `goals.resume` (which
    // rejects an armed goal) from failing a sweep on a defensive path.
    /* v8 ignore next */
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
      // `goals.block` always records a reason; the fallback keeps a row written
      // by an older producer readable instead of asserting on it.
      /* v8 ignore next -- goals.block always records a reason */
      const blocked = change.goal.blockedReason ?? { code: 'objective-blocked', message: 'The mission objective reported a blocker.' }
      await this.hold(row, blocked.code, blocked.message)
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
    this.claims.delete(row.sessionId)
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
