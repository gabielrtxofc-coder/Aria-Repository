/**
 * The recovery decision matrix: every candidate the startup sweep considers,
 * and the durable outcome each one must produce. The index row is only a hint;
 * the session log decides.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createAgent, mountHarness, stopHarness, tempRoot, textResponse, waitFor } from './harness.ts'
import type { MissionHarness } from './harness.ts'
import type { RecoveryRecord } from '../src/index.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** One durable root shared by the crashed and the recovering composition. */
async function root(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const created = await tempRoot('dsh-mission-sweep-')
  cleanups.push(created.cleanup)
  return created
}

/** Mount a composition on `root` and stop ow it with the test. */
async function mount(root: string, config: Parameters<typeof mountHarness>[0]['config'] = { sweepOnStartup: false }) {
  const harness = await mountHarness({ root, script: [textResponse('ok'), textResponse('ok')], driver: true, config })
  contexts.push(harness.ctx)
  return harness
}

/** Start one mission in a first composition, then exit it gracefully. */
async function startThenStop(
  rootPath: string,
  request: Parameters<MissionHarness['ctx']['missions']['start']>[1],
  after?: (harness: MissionHarness, agent: Agent) => void,
): Promise<Awaited<ReturnType<MissionHarness['ctx']['missions']['start']>>> {
  const first = await mount(rootPath)
  const agent = await createAgent(first)
  const mission = await first.ctx.missions.start(agent, request)
  after?.(first, agent)
  await stopHarness(first)
  contexts.splice(contexts.indexOf(first.ctx), 1)
  return mission
}

/**
 * Leave one durable session that never started a mission.
 * @param rootPath - durable root shared with the recovering composition.
 */
async function seedPlainSession(rootPath: string): Promise<void> {
  const first = await mount(rootPath)
  const agent = await createAgent(first)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await waitFor(() => first.adapter.requests.length > 0)
  await stopHarness(first)
  contexts.splice(contexts.indexOf(first.ctx), 1)
}

/** Read the single discovery row of one composition. */
async function onlyRow(harness: MissionHarness): Promise<RecoveryRecord | undefined> {
  return (await harness.ctx.missions.ledger.list())[0]
}

/** One armed row, as a crashed process would have left it behind. */
function armedRow(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    sessionId: SessionId('mission-session'),
    missionId: 'mission-stale' as RecoveryRecord['missionId'],
    goalId: 'goal-stale' as RecoveryRecord['goalId'],
    revision: 1,
    attempts: 0,
    state: 'armed',
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('recovery sweep outcomes', () => {
  it('holds a mission whose human authorization is still pending without spending an attempt', async () => {
    const { root: rootPath } = await root()
    await startThenStop(rootPath, { objective: 'needs approval', completionCriteria: ['done'] }, (first, agent) => {
      const started = first.ctx.missions.get(agent)!
      first.ctx.missions.authorize(agent, started, {
        code: 'needs-deploy-approval',
        message: 'Waiting for the deployment window.',
      })
    })
    const second = await mount(rootPath)
    // A crash between the durable append and the index refresh leaves the stale
    // hint claiming the mission is claimable; the log still forbids recovery.
    await second.ctx.missions.ledger.put({ ...(await onlyRow(second))!, state: 'armed' })
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 0, held: 1 })
    expect(await onlyRow(second)).toMatchObject({
      state: 'held',
      attempts: 0,
      lastError: { code: 'needs-deploy-approval', message: 'Waiting for the deployment window.' },
    })
    // Recovery never approves: the objective stays disarmed and no round ran.
    const resumed = second.ctx.agents.get(SessionId('mission-session'))!
    expect(second.ctx.missions.get(resumed)?.authorization?.code).toBe('needs-deploy-approval')
    expect(second.adapter.requests).toHaveLength(0)
  })

  it('holds a mission that never authorized autonomous recovery', async () => {
    const { root: rootPath } = await root()
    await startThenStop(rootPath, {
      objective: 'human only',
      completionCriteria: ['done'],
      recovery: 'disabled',
    })
    const second = await mount(rootPath)
    // A disabled mission is written held, so the sweep must not even consider it.
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 0, held: 0 })
    expect(await onlyRow(second)).toMatchObject({ state: 'held' })
  })

  it('holds a mission whose objective is paused', async () => {
    const { root: rootPath } = await root()
    await startThenStop(rootPath, { objective: 'paused work', completionCriteria: ['done'] }, (first, agent) => {
      const mission = first.ctx.missions.get(agent)!
      first.ctx.goals.pause(agent, mission.goal)
    })
    const second = await mount(rootPath)
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, held: 1 })
    expect((await onlyRow(second))?.lastError?.code).toBe('objective-paused')
  })

  it('holds a mission whose objective is no longer current', async () => {
    const { root: rootPath } = await root()
    await startThenStop(rootPath, { objective: 'lost objective', completionCriteria: ['done'] }, (first, agent) => {
      const mission = first.ctx.missions.get(agent)!
      first.ctx.goals.clear(agent, mission.goal)
    })
    const second = await mount(rootPath)
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, held: 1 })
    expect((await onlyRow(second))?.lastError?.code).toBe('objective-missing')
  })

  it('settles a mission whose objective already completed and drops the row', async () => {
    const { root: rootPath } = await root()
    const mission = await startThenStop(rootPath, { objective: 'finished work', completionCriteria: ['done'] }, (first, agent) => {
      const current = first.ctx.missions.get(agent)!
      first.ctx.goals.complete(agent, current.goal)
    })
    const second = await mount(rootPath)
    expect(await second.ctx.missions.ledger.list()).toHaveLength(0)
    // Rebuild the hint a crash would have left: the log already says complete.
    await second.ctx.missions.ledger.put(armedRow({
      missionId: mission.id,
      goalId: mission.goal.id,
      revision: mission.revision,
    }))
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, settled: 1, resumed: 0 })
    expect(await second.ctx.missions.ledger.list()).toHaveLength(0)
  })

  it('settles a stale row whose durable log holds no mission', async () => {
    const { root: rootPath } = await root()
    await seedPlainSession(rootPath)
    const second = await mount(rootPath)
    await second.ctx.missions.ledger.put(armedRow())
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, settled: 1 })
    expect(await second.ctx.missions.ledger.list()).toHaveLength(0)
  })

  it('settles a row whose mission identity no longer matches the log', async () => {
    const { root: rootPath } = await root()
    await seedPlainSession(rootPath)
    const second = await mount(rootPath)
    await second.ctx.missions.ledger.put(armedRow({ missionId: 'mission-other' as RecoveryRecord['missionId'] }))
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, settled: 1 })
    expect(await second.ctx.missions.ledger.list()).toHaveLength(0)
  })

  it('exhausts the budget, blocks the objective, and keeps the row for a human', async () => {
    const { root: rootPath } = await root()
    await startThenStop(rootPath, {
      objective: 'one attempt only',
      completionCriteria: ['done'],
      maxRecoveryAttempts: 1,
    }, (first, agent) => {
      const mission = first.ctx.missions.get(agent)!
      first.ctx.missions.recordAttempt(agent, mission, { interruption: { kind: 'request-failed', at: 1 } })
    })
    const second = await mount(rootPath)
    // A stale hint: the row still claims the mission is claimable.
    const row = (await onlyRow(second))!
    await second.ctx.missions.ledger.put({ ...row, state: 'armed', attempts: 0 })
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, exhausted: 1 })
    const resumed = second.ctx.agents.get(SessionId('mission-session'))!
    expect(second.ctx.goals.get(resumed)).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'recovery-exhausted' },
    })
    expect(await onlyRow(second)).toMatchObject({
      state: 'held',
      lastError: { code: 'recovery-exhausted' },
    })
    expect(second.ctx.missions.get(resumed)?.attempts).toBe(1)
  })

  it('reports a failed candidate instead of reviving a session the backend lost', async () => {
    const { root: rootPath } = await root()
    const second = await mount(rootPath)
    await second.ctx.missions.ledger.put(armedRow({ sessionId: SessionId('mission-absent') }))
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, failed: 1 })
    expect(await onlyRow(second)).toMatchObject({ state: 'held', lastError: { code: 'recovery-failed' } })
  })

  it('shares one running sweep between concurrent callers', async () => {
    const { root: rootPath } = await root()
    const started = await startThenStop(rootPath, { objective: 'single flight', completionCriteria: ['done'] })
    const second = await mount(rootPath)
    const [first, again] = await Promise.all([
      second.ctx.missions.sweep(),
      second.ctx.missions.sweep(),
    ])
    expect(first).toBe(again)
    const resumed = second.ctx.agents.get(SessionId('mission-session'))!
    expect(second.ctx.missions.get(resumed)?.attempts).toBe(1)
    expect(started.id).toBe(second.ctx.missions.get(resumed)?.id)
  })

  it('bounds one sweep to the configured mission count', async () => {
    const { root: rootPath } = await root()
    const second = await mount(rootPath, { sweepOnStartup: false, maxMissionsPerSweep: 1 })
    await second.ctx.missions.ledger.put(armedRow({ missionId: 'mission-a' as RecoveryRecord['missionId'] }))
    await second.ctx.missions.ledger.put(armedRow({
      sessionId: SessionId('mission-other'),
      missionId: 'mission-b' as RecoveryRecord['missionId'],
    }))
    const report = await second.ctx.missions.sweep()
    expect(report.considered).toBe(1)
    const states = (await second.ctx.missions.ledger.list()).map(row => row.state)
    expect(states.filter(state => state === 'held')).toHaveLength(1)
  })

  it('releases the agent it held once recovery finishes', async () => {
    const { root: rootPath } = await root()
    await startThenStop(rootPath, { objective: 'released', completionCriteria: ['done'] })
    const second = await mount(rootPath)
    await second.ctx.missions.sweep()
    const resumed = second.ctx.agents.get(SessionId('mission-session'))!
    await second.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(second.ctx), 1)
    expect(resumed.status).not.toBe('running')
  })
})
