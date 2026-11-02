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
 *
 * Usage: mission-startup-child.ts <crash|resume|resume-disabled> <overlay.patch.yml>
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.js'
import type {} from '../../src/index.ts'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [mode, overlay] = process.argv.slice(2)
if ((mode !== 'crash' && mode !== 'resume' && mode !== 'resume-disabled') || overlay === undefined) {
  throw new Error('usage: mission-startup-child.ts <crash|resume|resume-disabled> <overlay.patch.yml>')
}

const OBJECTIVE = 'finish the durable mission across a real restart'
const CRITERION = 'the recovered turn reaches the model without a new user message'
/** The overlay's default model route, used to create the Agent the mission runs on. */
const ROUTE = { provider: 'mission-mock', model: 'mission-mock' }

/** Keep this process alive until the parent kills it. */
function waitForever(): Promise<never> {
  return new Promise(() => { setInterval(() => {}, 60_000) })
}

/** Resolve a condition or fail with a diagnostic. */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Durable session artifact text under the shipped `dshHomePath('sessions')` root. */
function sessionArtifact(home: string, sessionId: string): string {
  const root = join(home, 'sessions')
  // The shipped layout is `sessions/<cwd-key>/<sessionId>/session.v<N>.jsonl.zstd`.
  const match = readdirSync(root, { recursive: true, encoding: 'utf8', withFileTypes: true })
    .filter(entry => entry.isFile()
      && entry.parentPath.includes(sessionId)
      && /^session.*\.jsonl(\.zstd)?$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
    .at(0)
  if (match === undefined) throw new Error(`no session artifact for ${sessionId} under ${root}`)
  const bytes = readFileSync(match)
  if (!match.endsWith('.zstd')) return bytes.toString()
  const { frames } = scanZstdFrames(bytes)
  return frames.map(({ start, end }) => zstdDecompressSync(bytes.subarray(start, end)).toString()).join('')
}

/** Durable user messages, with who queued them and whether they are a recovery notice. */
interface DurableUserMessage {
  /** Provenance recorded on the message; `injected` for harness-authored blocks. */
  readonly source: string
  /** Whether the first text block is the mission recovery notice. */
  readonly notice: boolean
}

/** Read every durable user message of one session, in order. */
function userMessages(home: string, sessionId: string): DurableUserMessage[] {
  return sessionArtifact(home, sessionId)
    .split('\n')
    .filter(line => line.startsWith('{'))
    .flatMap((line) => {
      const record = JSON.parse(line) as {
        type?: string
        data?: { content?: { type?: string; text?: string }[]; source?: { kind?: string } }
      }
      if (record.type !== 'user/message') return []
      const first = record.data?.content?.find(block => block.type === 'text')?.text ?? ''
      return [{ source: record.data?.source?.kind ?? 'injected', notice: first.startsWith('<mission_recovery') }]
    })
}

/** Count model-visible recovery notices in one durable session log. */
function countNotices(home: string, sessionId: string): number {
  return userMessages(home, sessionId).filter(message => message.notice).length
}

/** Provenance of every durable user message, in order, so the proof can show who spoke when. */
function userMessageSources(home: string, sessionId: string): { source: string; notice: boolean }[] {
  return userMessages(home, sessionId)
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
  await waitUntil(() => countNotices(home, sessionId) > 0, 'the recovery notice in the durable session log')
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
    notices: countNotices(home, sessionId),
    userSources: userMessageSources(home, sessionId),
  })}\n`)
} else {
  // Give a background recovery every chance to happen before reporting none.
  await new Promise(resolve => setTimeout(resolve, 4_000))
  const later = ctx.agents.get(sessionId)
  process.stdout.write(`${JSON.stringify({
    type: 'report',
    bootMs: Date.now() - bootedAt,
    liveAgentAtBoot: resumed !== undefined,
    liveAgentLater: later !== undefined,
    rowsAtBoot,
    attempts: later === undefined ? undefined : ctx.missions.get(later)?.attempts,
    notices: countNotices(home, sessionId),
    userSources: userMessageSources(home, sessionId),
  })}\n`)
}

process.exit(0)
