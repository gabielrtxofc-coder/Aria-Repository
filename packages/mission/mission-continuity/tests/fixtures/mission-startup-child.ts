/**
 * One DSH process for the startup-recovery proof: it boots the shipped
 * `headless` profile (the `base` bundle plus `headless`) through the same
 * profile loader, patch stack, and Cordis Loader the `dsh` launcher uses, with
 * one keyless overlay that swaps only the model route.
 *
 * Modes:
 * - `crash`: create a session and a mission, durably checkpoint it, start a
 *   turn, and stay alive. The parent waits for the model request to appear and
 *   `SIGKILL`s the process, so the durable state is exactly what a crash leaves.
 * - `resume`: do nothing but boot. Recovery must happen inside startup; this
 *   mode never calls `sweep()`, `resume()`, or any other mission mutation, and
 *   it sends no user message.
 * - `resume-disabled`: the same boot with `sweepOnStartup: false`, proving the
 *   opposite behavior.
 * - `crash-start`: start a mission and `SIGKILL` this process the instant
 *   `start()` resolves — no checkpoint, no explicit flush, no turn. Whatever a
 *   later process finds is exactly what `start()` itself promised to persist.
 *
 * Usage: mission-startup-child.ts <crash|resume|resume-disabled> <overlay.patch.yml>
 */

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '../../src/index.ts'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [mode, overlay] = process.argv.slice(2)
if ((mode !== 'crash' && mode !== 'crash-start' && mode !== 'resume' && mode !== 'resume-disabled')
  || overlay === undefined) {
  throw new Error('usage: mission-startup-child.ts <crash|crash-start|resume|resume-disabled> <overlay.patch.yml>')
}

/**
 * Where this process actually loaded the mission package from. A built-lane
 * proof is only worth something if the children execute built files, so every
 * report publishes the resolved entry instead of assuming it.
 */
const missionEntry = import.meta.resolve('@deepseek-ai/dsh-mission-continuity')

const OBJECTIVE = 'finish the durable mission across a real restart'
const CRITERION = 'the recovered turn reaches the model without a new user message'
/** The overlay's default model route, used to create the Agent the mission runs on. */
const ROUTE = { provider: 'mission-mock', model: 'mission-mock' }

/** Keep this process alive until the parent kills it. */
function waitForever(): Promise<never> {
  return new Promise(() => { setInterval(() => {}, 60_000) })
}

/** Resolve an asynchronous condition or fail with a diagnostic. */
async function waitUntilAsync(predicate: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Resolve a condition or fail with a diagnostic. */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** One user message as the durable log records it. */
interface DurableUserMessage {
  /** Provenance recorded on the message; `injected` for harness-authored blocks. */
  readonly source: string
  /** Whether the first text block is the mission recovery notice. */
  readonly notice: boolean
}

/**
 * Read the durable user messages of one session through the persistence
 * backend itself. The backend owns the stored encoding (compressed or not), so
 * this fixture never parses an artifact format and the same code works in both
 * launch lanes.
 * @param ctx - booted composition providing session persistence.
 * @param sessionId - session whose stored log to read.
 * @returns the durable user messages, in log order.
 */
async function userMessages(ctx: Context, sessionId: SessionId): Promise<DurableUserMessage[]> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(0)
    return events.flatMap((event) => {
      if (event.type !== 'user/message') return []
      const data = event.data as { content?: { type?: string; text?: string }[]; source?: { kind?: string } }
      const first = data.content?.find(block => block.type === 'text')?.text ?? ''
      return [{ source: data.source?.kind ?? 'injected', notice: first.startsWith('<mission_recovery') }]
    })
  } finally {
    await handle.close()
  }
}

/** Count model-visible recovery notices in one durable session log. */
async function countNotices(ctx: Context, sessionId: SessionId): Promise<number> {
  return (await userMessages(ctx, sessionId)).filter(message => message.notice).length
}

const home = process.env['DSH_HOME']
if (home === undefined) throw new Error('DSH_HOME must name the shared durable home')

const ctx: Context = await bootProductionProfile({
  binName: 'mission-startup-proof',
  profile: 'headless',
  overlayPaths: [overlay],
})

const sessionId = SessionId(process.env['MISSION_SESSION_ID'] ?? `mission-startup-${randomUUID()}`)

if (mode === 'crash') {
  const handle = await ctx.agents.create({ sessionId, agentOptions: ROUTE })
  const started = await ctx.missions.start(handle.agent, {
    objective: OBJECTIVE,
    completionCriteria: [CRITERION],
    maxGoalRounds: 2,
  })
  // A checkpoint flushes the session, so the crash leaves a durable mission
  // record (objective, criteria, revision, checkpoint) and not only an index row.
  await ctx.missions.checkpoint(handle.agent, started)
  await ctx.sessions.flush(handle.agent.session)
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    missionEntry,
    sessionId,
    missionId: started.id,
    revision: ctx.missions.get(handle.agent)?.revision,
    settled: ctx.missions.get(handle.agent)?.settled,
    criteria: ctx.missions.get(handle.agent)?.completionCriteria,
  })}\n`)
  // An ordinary turn, so the process dies with a model request in flight.
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'begin the durable work' }],
    source: { kind: 'user' },
  }))
  await waitForever()
}

if (mode === 'crash-start') {
  const handle = await ctx.agents.create({ sessionId, agentOptions: ROUTE })
  const started = await ctx.missions.start(handle.agent, {
    objective: OBJECTIVE,
    completionCriteria: [CRITERION],
  })
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    missionEntry,
    sessionId,
    missionId: started.id,
    revision: started.revision,
  })}\n`)
  // Kill without flushing anything else: the only durable record of this
  // mission is whatever `start()` itself pushed to the medium.
  process.kill(process.pid, 'SIGKILL')
  await waitForever()
}

// Nothing below drives recovery: no sweep, no resume, no user message.
const bootedAt = Date.now()
const resumed = ctx.agents.get(sessionId)
const missionAtBoot = resumed === undefined ? undefined : ctx.missions.get(resumed)
// The objective state recovery left behind, read before any turn of this process runs.
const goalAtBoot = resumed === undefined ? undefined : ctx.goals.get(resumed)
// The discovery index read once, immediately after startup settled, so the report
// distinguishes "recovered during boot" from "recovered later".
const rowsAtBoot = await ctx.missions.ledger.list()

if (mode === 'resume') {
  if (resumed === undefined || missionAtBoot === undefined) {
    process.stdout.write(`${JSON.stringify({
      type: 'report',
      error: 'startup did not resume the interrupted session',
      rowsAtBoot,
    })}\n`)
    process.exit(1)
  }
  await waitUntilAsync(async () => await countNotices(ctx, sessionId) > 0, 'the recovery notice in the durable session log')
  // The goal-round driver admits the next round after the notice; the objective's
  // round cap then ends the mission deterministically.
  await waitUntil(
    () => {
      const current = resumed === undefined ? undefined : ctx.goals.get(resumed)
      return current === undefined || current.phase === 'blocked' || current.roundsStarted >= 2
    },
    'the first automatic round after recovery',
    45_000,
  )
  await ctx.sessions.flush(resumed.session)
  const final = ctx.missions.get(resumed)
  const goal = ctx.goals.get(resumed)
  process.stdout.write(`${JSON.stringify({
    type: 'report',
    missionEntry,
    bootMs: Date.now() - bootedAt,
    liveAgentAtBoot: true,
    attemptAtBoot: missionAtBoot.attempts,
    interruptionAtBoot: missionAtBoot.interruption?.kind,
    checkpointAtBoot: missionAtBoot.checkpoint,
    objectiveAtBoot: goalAtBoot?.objective,
    activationAtBoot: goalAtBoot?.activation,
    roundsStartedAtBoot: goalAtBoot?.roundsStarted,
    rowsAtBoot,
    attempts: final?.attempts,
    objective: goal?.objective,
    activation: goal?.activation,
    phase: goal?.phase,
    roundsStarted: goal?.roundsStarted,
    settled: final?.settled,
    notices: await countNotices(ctx, sessionId),
    userSources: await userMessages(ctx, sessionId),
  })}\n`)
} else {
  // Give a background recovery every chance to happen before reporting none.
  await new Promise(resolve => setTimeout(resolve, 4_000))
  const later = ctx.agents.get(sessionId)
  process.stdout.write(`${JSON.stringify({
    type: 'report',
    missionEntry,
    bootMs: Date.now() - bootedAt,
    liveAgentAtBoot: resumed !== undefined,
    liveAgentLater: later !== undefined,
    rowsAtBoot,
    attempts: later === undefined ? undefined : ctx.missions.get(later)?.attempts,
    notices: await countNotices(ctx, sessionId),
    userSources: await userMessages(ctx, sessionId),
  })}\n`)
}

process.exit(0)
