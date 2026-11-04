/**
 * Concurrent recovery: every way two attempts can address one session, and the
 * durable outcome each one must produce.
 *
 * The supervisor's own sweep is single-flight and guards a `SessionAlreadyOwned`
 * rejection, so none of these paths may crash a process. What is *not* obvious
 * from reading the source is what the production callers do around that guard,
 * so the cases here drive the same compositions, the same JSONL backend, and the
 * same kernel write lease the shipped profile uses — only the model route is
 * scripted.
 *
 * The invariant every case asserts is the same: at most one recovery per
 * interruption (one attempt consumed, one durable notice), a loser never
 * rewrites the winner's index row, and a concurrent attempt is reported rather
 * than thrown at the process.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  countMissionNotices,
  createAgent,
  mountHarness,
  readSessionArtifact,
  stopHarness,
  tempRoot,
  textResponse,
} from './harness.ts'
import type { MissionHarness } from './harness.ts'
import type { RecoveryRecord } from '../src/index.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await Promise.allSettled([ctx.fiber.dispose()])
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const SESSION = SessionId('mission-session')

/** One durable root that every composition in a case shares. */
async function root(): Promise<string> {
  const created = await tempRoot('dsh-mission-concurrency-')
  cleanups.push(created.cleanup)
  return created.root
}

/** Mount a composition on `root`, owning its disposal. */
async function mount(
  rootPath: string,
  config: Parameters<typeof mountHarness>[0]['config'] = { sweepOnStartup: false },
  script = [textResponse('continued'), textResponse('continued again'), textResponse('done')],
): Promise<MissionHarness> {
  const harness = await mountHarness({ root: rootPath, script, driver: true, config })
  contexts.push(harness.ctx)
  return harness
}

/**
 * Leave one interrupted mission behind: a composition starts a mission, flushes
 * it durably, and stops, so a later composition sees exactly what a crash
 * between processes leaves.
 * @param rootPath - durable root the later compositions read.
 * @returns the mission's identity and its durable revision.
 */
async function seedInterruptedMission(rootPath: string): Promise<{ id: string; revision: number }> {
  const first = await mount(rootPath)
  const agent = await createAgent(first)
  const started = await first.ctx.missions.start(agent, {
    objective: 'hold one owner across a concurrent attempt',
    completionCriteria: ['one recovery only'],
  })
  await stopHarness(first)
  contexts.splice(contexts.indexOf(first.ctx), 1)
  return { id: started.id, revision: started.revision }
}

/** The durable index as a fresh reader sees it. */
async function rowsAfter(rootPath: string): Promise<readonly RecoveryRecord[]> {
  const reader = await mount(rootPath)
  const rows = await reader.ctx.missions.ledger.list()
  await reader.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(reader.ctx), 1)
  return rows
}

describe('scenario 1 — automatic recovery resumes the session during startup', () => {
  it('takes ownership of the interrupted session and records one attempt and one notice', async () => {
    const rootPath = await root()
    const mission = await seedInterruptedMission(rootPath)

    // The startup sweep is the *only* thing that runs here: no user message, no
    // explicit resume, no mission call. Booting the composition is the trigger.
    const recovering = await mount(rootPath, {})
    const agent = recovering.ctx.agents.get(SESSION)
    expect(agent).toBeDefined()
    // The recovery happened inside boot, before this line could ask for it.
    expect(recovering.ctx.missions.get(agent as Agent)).toMatchObject({
      id: mission.id,
      attempts: 1,
      interruption: { kind: 'process-restart' },
    })
    await recovering.ctx.sessions.flush((agent as Agent).session)
    expect(countMissionNotices(await readSessionArtifact(rootPath))).toBe(1)
    expect(await rowsAfter(rootPath)).toMatchObject([{ attempts: 1, state: 'armed' }])
  })
})

describe('scenario 2 — a second attempt while the first already owns the session', () => {
  it('reports the duplicate attempt as owned elsewhere instead of taking a second recovery', async () => {
    const rootPath = await root()
    await seedInterruptedMission(rootPath)
    const owner = await mount(rootPath)
    const first = await owner.ctx.missions.sweep()
    expect(first).toMatchObject({ considered: 1, resumed: 1 })

    // A second sweep (a later tick, or a caller such as `ctx.missions.sweep()`)
    // while the recovered Agent is still live: the owner is already this
    // supervisor, so it must skip rather than resume again.
    const second = await owner.ctx.missions.sweep()
    expect(second).toMatchObject({ considered: 1, resumed: 0, skipped: 1 })
    const agent = owner.ctx.agents.get(SESSION) as Agent
    expect(owner.ctx.missions.get(agent)?.attempts).toBe(1)

    // A second composition over the same durable root is the cross-process
    // duplicate: the winner's write lease is still held, so this one must report
    // the mission as owned elsewhere and must not touch the index.
    const duplicate = await mount(rootPath)
    const third = await duplicate.ctx.missions.sweep()
    expect(third).toMatchObject({ considered: 1, resumed: 0, skipped: 1 })
    expect(duplicate.ctx.agents.get(SESSION)).toBeUndefined()

    await owner.ctx.sessions.flush(agent.session)
    expect(countMissionNotices(await readSessionArtifact(rootPath))).toBe(1)
    expect(await rowsAfter(rootPath)).toMatchObject([{ attempts: 1 }])
  })

  it('treats a raw concurrent resume of an owned session as a reportable refusal, not a crash', async () => {
    // This is the shape the audit reproduced: two `agents.resume` calls for one
    // id in one composition. Only one can take the in-process write claim, so
    // the loser rejects with `SessionAlreadyOwnedError`. The point is what the
    // rejection *is*: a stable Session-domain failure the callers translate,
    // never an unhandled rejection. The mission supervisor guards it; the API
    // gateway translates it to `session/writer-held`.
    const rootPath = await root()
    await seedInterruptedMission(rootPath)
    const composition = await mount(rootPath)
    const attempt = (): Promise<unknown> => composition.ctx.agents.resume({
      resumeSessionId: SESSION,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const results = await Promise.allSettled([attempt(), attempt()])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter(result => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error
    expect(reason.name).toBe('SessionAlreadyOwnedError')
    // The winner is the one live Agent; the loser left no second Agent behind.
    expect(composition.ctx.agents.get(SESSION)).toBeDefined()
    // Nothing is pending: every rejection was awaited and handled here.
    await new Promise(resolve => setImmediate(resolve))
  })
})

describe('scenario 3 — two compositions recover the same durable mission', () => {
  it('gives the session to exactly one composition and one attempt', async () => {
    const rootPath = await root()
    await seedInterruptedMission(rootPath)
    const alpha = await mount(rootPath)
    const beta = await mount(rootPath)

    // Both compositions sweep concurrently, the way two `dsh` processes started
    // over one home do.
    const reports = await Promise.allSettled([
      alpha.ctx.missions.sweep(),
      beta.ctx.missions.sweep(),
    ])
    expect(reports.every(result => result.status === 'fulfilled')).toBe(true)
    const outcomes = reports.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    expect(outcomes.filter(report => report.resumed === 1)).toHaveLength(1)
    expect(outcomes.filter(report => report.skipped === 1)).toHaveLength(1)

    // Exactly one composition holds a live Agent for the session.
    const holders = [alpha, beta].filter(harness => harness.ctx.agents.get(SESSION) !== undefined)
    expect(holders).toHaveLength(1)
    const holder = holders[0] as MissionHarness
    const agent = holder.ctx.agents.get(SESSION) as Agent
    expect(holder.ctx.missions.get(agent)?.attempts).toBe(1)
    await holder.ctx.sessions.flush(agent.session)
    expect(countMissionNotices(await readSessionArtifact(rootPath))).toBe(1)
    // The loser wrote nothing: the index still holds the winner's single row.
    expect(await rowsAfter(rootPath)).toMatchObject([{ attempts: 1 }])
  })

  it('keeps the loser process (composition) alive after its refusal', async () => {
    const rootPath = await root()
    await seedInterruptedMission(rootPath)
    const alpha = await mount(rootPath)
    const beta = await mount(rootPath)
    const [first, second] = await Promise.allSettled([
      alpha.ctx.missions.sweep(),
      beta.ctx.missions.sweep(),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('fulfilled')
    const loser = (first.status === 'fulfilled' && first.value.resumed === 1 ? beta : alpha)
    // The composition that lost is still usable: its own services answer.
    expect(loser.ctx.fiber.state).not.toBe(3)
    expect(await loser.ctx.missions.ledger.list()).toHaveLength(1)
    const after = await loser.ctx.missions.sweep()
    expect(after.considered).toBe(1)
    expect(after.resumed).toBe(0)
  })
})

describe('scenario 4 — an external resume during automatic recovery', () => {
  it('does not crash, does not double-recover, and never loses the mission', async () => {
    const rootPath = await root()
    await seedInterruptedMission(rootPath)
    const recovering = await mount(rootPath)

    // The automatic sweep and an external resume of the same session, issued at
    // the same time. Two interleavings are possible and both are legitimate:
    //  - the sweep takes the write claim and the external resume is refused;
    //  - the external resume takes it, so the sweep reports the candidate as
    //    owned elsewhere and consumes nothing, leaving the mission armed.
    // Neither may crash the process, and neither may recover twice.
    const [sweep, external] = await Promise.allSettled([
      recovering.ctx.missions.sweep(),
      recovering.ctx.agents.resume({
        resumeSessionId: SESSION,
        agentOptions: { provider: 'mock', model: 'mock' },
      }),
    ])
    expect(sweep.status).toBe('fulfilled')
    if (external.status === 'rejected') {
      // A refusal is a stable Session-domain failure, not an unhandled rejection.
      expect((external.reason as Error).name).toBe('SessionAlreadyOwnedError')
    }
    const agent = recovering.ctx.agents.get(SESSION) as Agent
    expect(agent).toBeDefined()

    // Whatever the interleaving was, the durable record still holds exactly one
    // actionable mission. A follow-up sweep recovers it if this boot did not, so
    // a concurrent attempt can delay a recovery but never lose it.
    const followUp = await recovering.ctx.missions.sweep()
    const recovered = recovering.ctx.agents.get(SESSION) as Agent
    const mission = recovering.ctx.missions.get(recovered)
    expect(mission?.attempts).toBe(1)
    expect(followUp.resumed + (recovered === agent ? 0 : 0)).toBeLessThanOrEqual(1)
    await recovering.ctx.sessions.flush(recovered.session)
    // One interruption, one recovery, one notice.
    expect(countMissionNotices(await readSessionArtifact(rootPath))).toBe(1)
    expect(await rowsAfter(rootPath)).toMatchObject([{ attempts: 1, state: 'armed' }])
  })

  it('keeps the mission attempt the only one when the resume is issued after recovery', async () => {
    const rootPath = await root()
    await seedInterruptedMission(rootPath)
    const recovering = await mount(rootPath)
    expect(await recovering.ctx.missions.sweep()).toMatchObject({ resumed: 1 })
    const agent = recovering.ctx.agents.get(SESSION) as Agent

    // A resumed mission keeps running ordinary rounds. An external resume that
    // arrives afterwards addresses an already-live Agent, so the in-process
    // claim refuses it instead of composing a second Agent over the same log.
    await expect(recovering.ctx.agents.resume({
      resumeSessionId: SESSION,
      agentOptions: { provider: 'mock', model: 'mock' },
    })).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
    expect(recovering.ctx.agents.get(SESSION)).toBe(agent)
    expect(recovering.ctx.missions.get(agent)?.attempts).toBe(1)
    await recovering.ctx.sessions.flush(agent.session)
    expect(countMissionNotices(await readSessionArtifact(rootPath))).toBe(1)
  })
})

describe('scenario 5 — ownership failure: another process holds the session', () => {
  it('holds the mission recoverable and consumes no attempt when the write lease is taken', async () => {
    const rootPath = await root()
    await seedInterruptedMission(rootPath)
    const owner = await mount(rootPath)
    expect(await owner.ctx.missions.sweep()).toMatchObject({ resumed: 1 })
    const owned = owner.ctx.agents.get(SESSION) as Agent
    const attemptsBefore = owner.ctx.missions.get(owned)?.attempts

    // A second process over the same home: its write open hits the kernel lease
    // the owner holds. The sweep must classify that as "owned elsewhere", not as
    // a broken mission, and must not spend one of the mission's attempts.
    const other = await mount(rootPath)
    const report = await other.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 0, failed: 0, skipped: 1 })
    expect(other.ctx.agents.get(SESSION)).toBeUndefined()
    // The refusal is not a `hold`: no diagnostic was written by the loser, so the
    // winner's row still describes a healthy armed mission.
    expect(await rowsAfter(rootPath)).toMatchObject([
      { state: 'armed', attempts: attemptsBefore },
    ])
    expect(owner.ctx.missions.get(owned)?.attempts).toBe(attemptsBefore)
  })

  it('recovers once the owner releases the session', async () => {
    const rootPath = await root()
    await seedInterruptedMission(rootPath)
    const owner = await mount(rootPath)
    expect(await owner.ctx.missions.sweep()).toMatchObject({ resumed: 1 })

    // The owner goes away without finishing; its lease goes with it.
    await owner.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(owner.ctx), 1)
    const successor = await mount(rootPath)
    const report = await successor.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1 })
    const agent = successor.ctx.agents.get(SESSION) as Agent
    expect(successor.ctx.missions.get(agent)?.attempts).toBe(2)
  })
})
