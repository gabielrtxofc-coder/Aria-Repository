/**
 * One DSH process for the interrupted-operation proofs.
 *
 * Every mode boots the shipped `headless` profile with the keyless overlay, so
 * the recovery behavior under test is the shipped behavior: the Cordis Loader
 * resolves the real plugins, the mission service runs its own startup work, and
 * nothing calls a mission API the production composition does not call.
 *
 * Modes:
 * - `crash`: create a session, start and checkpoint a mission, then run one
 *   ordinary turn. The keyless model asks for `external_effect`, whose body
 *   appends to `$MISSION_EFFECT_FILE` and never settles, so the process dies
 *   with a recorded call and no durable result. The parent `SIGKILL`s it as soon
 *   as the effect failpoint appears.
 * - `held`: do nothing but boot. The interrupted call must stop automatic
 *   recovery, and the report shows what startup actually did.
 * - `authorize`: boot, act as the human who read the report, clear the recorded
 *   authorization, and sweep. The mission must resume once, tell the model which
 *   calls are unknown, and never re-run the tool by itself.
 * - `authorize-quiet`: the same human path, then wait until the objective has
 *   started its next automatic round and hit its own round limit. A resumed
 *   mission keeps running its ordinary rounds, so this mode turns the traffic
 *   after recovery into a fact the report observes instead of one it races.
 *
 * Every reporting mode also counts the durable recovery notices in the stored
 * session log, which is the quantity "one interruption, one recovery" is about:
 * a resumed mission legitimately issues further model requests for its next
 * round, but only a recovery writes a notice.
 *
 * Usage: mission-uncertain-child.ts <crash|held|authorize|authorize-quiet> <overlay.patch.yml>
 */

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '../../src/index.ts'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const [mode, overlay] = process.argv.slice(2)
if ((mode !== 'crash' && mode !== 'held' && mode !== 'authorize' && mode !== 'authorize-quiet')
  || overlay === undefined) {
  throw new Error(
    'usage: mission-uncertain-child.ts <crash|held|authorize|authorize-quiet> <overlay.patch.yml>',
  )
}

const OBJECTIVE = 'finish the irreversible migration'
const CRITERION = 'the external record exists and the mission is not repeated blindly'
/** The overlay's default model route, used when this process composes an Agent itself. */
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

/** Records the simulated external operation appended, in order. */
function effectRecords(): { callId: string; pid: number }[] {
  const file = process.env['MISSION_EFFECT_FILE']
  if (file === undefined) return []
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as { callId: string; pid: number })
  } catch {
    return []
  }
}

/**
 * Where this process loaded the mission package from, so a built-lane run can
 * show it executed built files instead of asserting it.
 */
const missionEntry = import.meta.resolve('@deepseek-ai/dsh-mission-continuity')

const home = process.env['DSH_HOME']
if (home === undefined) throw new Error('DSH_HOME must name the shared durable home')

const ctx: Context = await bootProductionProfile({
  binName: 'mission-uncertain-proof',
  profile: 'headless',
  overlayPaths: [overlay],
})

const sessionId = SessionId(process.env['MISSION_SESSION_ID'] ?? `mission-uncertain-${randomUUID()}`)

if (mode === 'crash') {
  const handle = await ctx.agents.create({ sessionId, agentOptions: ROUTE })
  const started = await ctx.missions.start(handle.agent, {
    objective: OBJECTIVE,
    completionCriteria: [CRITERION],
    maxGoalRounds: 2,
  })
  await ctx.missions.checkpoint(handle.agent, started)
  await ctx.sessions.flush(handle.agent.session)
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    missionEntry,
    sessionId,
    missionId: started.id,
    effects: effectRecords().length,
  })}\n`)
  // One ordinary turn. The model asks for the external operation, the tool body
  // records the effect and blocks, and the parent kills the process here.
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'run the migration' }],
    source: { kind: 'user' },
  }))
  await waitForever()
}

/**
 * Count model-visible recovery notices in one durable session log, read through
 * the persistence backend so the fixture never parses an artifact format.
 * @param ctx - booted composition providing session persistence.
 * @param sessionId - session whose stored log to read.
 * @returns how many user messages are recovery notices.
 */
async function countNotices(ctx: Context, sessionId: SessionId): Promise<number> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(0)
    return events.filter((event) => {
      if (event.type !== 'user/message') return false
      const data = event.data as { content?: readonly { type?: string; text?: string }[] }
      const first = data.content?.find(block => block.type === 'text')?.text ?? ''
      return first.startsWith('<mission_recovery')
    }).length
  } finally {
    await handle.close()
  }
}

/** The message log the model actually saw, to prove the notice named the call. */
const requests = (): string[] => {
  const log = process.env['MISSION_MOCK_LOG']
  if (log === undefined) return []
  try {
    return readFileSync(log, 'utf8').split('\n').filter(line => line.trim() !== '')
  } catch {
    return []
  }
}

if (mode === 'held') {
  // Startup already swept; nothing else runs here.
  await new Promise(resolve => setTimeout(resolve, 3_000))
  const live = ctx.agents.get(sessionId)
  const mission = live === undefined ? undefined : ctx.missions.get(live)
  process.stdout.write(`${JSON.stringify({
    type: 'report',
    missionEntry,
    liveAgent: live !== undefined,
    rows: await ctx.missions.ledger.list(),
    attempts: mission?.attempts,
    authorization: mission?.authorization,
    notices: await countNotices(ctx, sessionId),
    requests: requests().length,
    effects: effectRecords(),
  })}\n`)
  process.exit(0)
}

// The human path: read the report, compose the session again, record the
// decision, and let the ordinary sweep resume the mission.
const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: ROUTE })
const agent = handle.agent
const pending = ctx.missions.get(agent)
if (pending === undefined) throw new Error('the interrupted mission is not recoverable')
const attemptsBefore = pending.attempts
const authorizationBefore = pending.authorization
const uncertainBefore = ctx.missions.uncertainOperations(agent)
await ctx.missions.resume(agent, { id: pending.id, revision: pending.revision })
const report = await ctx.missions.sweep()
// Read the row the recovery just wrote before the mission's own next round can
// move it: "what the recovery produced" exists only until that round starts.
const rowsAfterResume = await ctx.missions.ledger.list()
await waitUntil(() => requests().length > 0, 'the recovered model request')
if (mode === 'authorize-quiet') {
  // A resumed mission keeps running the objective's ordinary rounds. Waiting for
  // the second model request *and* the objective's own round limit makes the
  // traffic and the ledger after recovery facts this report observes, so the
  // proof cannot race the next round.
  const deadline = Date.now() + 45_000
  for (;;) {
    const rows = await ctx.missions.ledger.list()
    if (requests().length >= 2 && rows.some(row => row.lastError?.code === 'round-limit')) break
    if (Date.now() > deadline) throw new Error('timed out waiting for the objective to reach its round limit')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
await ctx.sessions.flush(agent.session)
const after = ctx.missions.get(agent)
process.stdout.write(`${JSON.stringify({
  type: 'report',
  missionEntry,
  attemptsBefore,
  authorizationBefore,
  uncertainBefore,
  attempts: after?.attempts,
  authorization: after?.authorization,
  report,
  rowsAfterResume,
  notices: await countNotices(ctx, sessionId),
  requests: requests(),
  effects: effectRecords(),
  rows: await ctx.missions.ledger.list(),
})}\n`)
process.exit(0)
