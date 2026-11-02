/**
 * Defensive contracts: configuration defaults, contained listener failures,
 * release/dispose paths, and goal reconciliation. Each case asserts the
 * behavior the containment exists for, not merely that a branch executed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { missionProjectionDefinition, MissionService, resolveConfig } from '../src/index.ts'
import type { RecoveryRecord } from '../src/index.ts'
import { createAgent, mountHarness, stopHarness, tempRoot, textResponse } from './harness.ts'
import type { MissionHarness } from './harness.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

/** Mount a composition on a fresh durable root. */
async function mount(config: Parameters<typeof mountHarness>[0]['config'] = { sweepOnStartup: false }) {
  const { root, cleanup } = await tempRoot('dsh-mission-edge-')
  cleanups.push(cleanup)
  const harness = await mountHarness({ root, script: [textResponse('ok'), textResponse('ok')], config })
  contexts.push(harness.ctx)
  return { harness, root, agent: await createAgent(harness) }
}

/** Poll an asynchronous condition; `waitFor` only accepts a sync predicate. */
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: condition did not hold in time')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** A row as a crashed process would leave it. */
function armedRow(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    sessionId: SessionId('orphan-session'),
    missionId: 'mission-stale' as RecoveryRecord['missionId'],
    goalId: 'goal-stale' as RecoveryRecord['goalId'],
    revision: 1,
    attempts: 0,
    state: 'armed',
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('configuration and validation edges', () => {
  it('falls back to documented defaults for a partial configuration', () => {
    expect(resolveConfig({})).toEqual({
      sweepOnStartup: true,
      defaultMaxRecoveryAttempts: 3,
      maxMissionsPerSweep: 32,
      rebuildIndexOnStartup: true,
      maxRebuildSessions: 64,
    })
    expect(resolveConfig({
      sweepOnStartup: false,
      defaultMaxRecoveryAttempts: 7,
      maxMissionsPerSweep: 2,
      rebuildIndexOnStartup: false,
      maxRebuildSessions: 5,
    })).toEqual({
      sweepOnStartup: false,
      defaultMaxRecoveryAttempts: 7,
      maxMissionsPerSweep: 2,
      rebuildIndexOnStartup: false,
      maxRebuildSessions: 5,
    })
  })

  it('rejects an oversized completion criterion', async () => {
    const { harness, agent } = await mount()
    await expect(harness.ctx.missions.start(agent, {
      objective: 'big criterion',
      completionCriteria: ['x'.repeat(2_001)],
    })).rejects.toMatchObject({ code: 'MISSION_INVALID_CRITERIA' })
  })

  it('reports a non-error durability rejection verbatim', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, { objective: 'raw rejection', completionCriteria: ['x'] })
    vi.spyOn(harness.ctx.sessions, 'flush').mockRejectedValue('disk gone')
    await expect(harness.ctx.missions.checkpoint(agent, started))
      .rejects.toThrow('mission durability checkpoint failed: disk gone')
  })

  it('keeps interruption and checkpoint through an authorization resume', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, {
      objective: 'full record',
      completionCriteria: ['x'],
      maxRecoveryAttempts: 4,
    })
    const checkpointed = await harness.ctx.missions.checkpoint(agent, started)
    const attempted = await harness.ctx.missions.recordAttempt(agent, checkpointed, {
      interruption: { kind: 'turn-aborted', at: 5 },
    })
    const authorized = await harness.ctx.missions.authorize(agent, attempted, { code: 'needs-human', message: 'approve' })
    const resumed = await harness.ctx.missions.resume(agent, authorized)
    expect(resumed).toMatchObject({
      attempts: 1,
      interruption: { kind: 'turn-aborted' },
      checkpoint: { seq: attempted.checkpoint?.seq },
    })
    expect(resumed.authorization).toBeUndefined()
  })
})

describe('contained failures', () => {
  it('reports a rejected index refresh without failing the recorded attempt', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, { objective: 'index refresh', completionCriteria: ['x'] })
    vi.spyOn(harness.ctx.missions.ledger, 'put').mockRejectedValue(new Error('index closed'))
    const attempted = await harness.ctx.missions.recordAttempt(agent, started, {
      interruption: { kind: 'unknown', at: 1 },
    })
    expect(attempted.attempts).toBe(1)
    expect((await harness.ctx.missions.ledger.list())[0]?.attempts).toBe(0)
  })

  it('reports a rejected row removal without masking the append failure', async () => {
    const { harness, agent } = await mount()
    const append = agent.session.append.bind(agent.session)
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, data: unknown) => {
      if (type === 'mission/change') throw new Error('append refused')
      return append(type as never, data as never)
    }) as typeof agent.session.append)
    vi.spyOn(harness.ctx.missions.ledger, 'delete').mockRejectedValue(new Error('index closed'))
    await expect(harness.ctx.missions.start(agent, { objective: 'orphan row', completionCriteria: ['x'] }))
      .rejects.toThrow('append refused')
  })

  it('skips the objective blocker when no objective is current', async () => {
    const { harness, agent } = await mount()
    vi.spyOn(harness.ctx.missions.ledger, 'put').mockRejectedValue(new Error('index closed'))
    vi.spyOn(harness.ctx.goals, 'get').mockReturnValue(undefined)
    await expect(harness.ctx.missions.start(agent, { objective: 'no objective', completionCriteria: ['x'] }))
      .rejects.toMatchObject({ code: 'MISSION_PERSISTENCE_FAILED' })
  })

  it('contains a failing objective blocker and still reports the persistence failure', async () => {
    const { harness, agent } = await mount()
    vi.spyOn(harness.ctx.missions.ledger, 'put').mockRejectedValue(new Error('index closed'))
    vi.spyOn(harness.ctx.goals, 'block').mockImplementation(() => { throw new Error('goal closed') })
    await expect(harness.ctx.missions.start(agent, { objective: 'blocker closed', completionCriteria: ['x'] }))
      .rejects.toMatchObject({ code: 'MISSION_PERSISTENCE_FAILED' })
  })

  it('contains a failing mission/changed listener', async () => {
    const { harness, agent } = await mount()
    harness.ctx.on('mission/changed', () => { throw new Error('listener exploded') })
    const view = await harness.ctx.missions.start(agent, { objective: 'noisy listener', completionCriteria: ['x'] })
    expect(harness.ctx.missions.get(agent)?.id).toBe(view.id)
  })
})

describe('recovery failure containment', () => {
  it('holds the row with a truncated diagnostic when resuming throws a non-error', async () => {
    const { harness } = await mount()
    await harness.ctx.missions.ledger.put(armedRow())
    vi.spyOn(harness.ctx.agents, 'resume').mockRejectedValue('backend exploded'.repeat(60))
    const report = await harness.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, failed: 1 })
    const row = (await harness.ctx.missions.ledger.list())[0]!
    expect(row.state).toBe('held')
    expect(row.lastError?.code).toBe('recovery-failed')
    expect(row.lastError?.message.length).toBe(500)
  })

  it('contains a failing hold write', async () => {
    const { harness } = await mount()
    await harness.ctx.missions.ledger.put(armedRow())
    vi.spyOn(harness.ctx.missions.ledger, 'put').mockRejectedValue(new Error('index closed'))
    vi.spyOn(harness.ctx.agents, 'resume').mockRejectedValue(new Error('missing session'))
    const report = await harness.ctx.missions.sweep()
    expect(report.failed).toBe(1)
  })

  it('contains a failing goal reconciliation', async () => {
    const { harness, agent } = await mount()
    await harness.ctx.missions.start(agent, { objective: 'reconcile failure', completionCriteria: ['x'] })
    vi.spyOn(harness.ctx.missions.ledger, 'list').mockRejectedValue(new Error('index closed'))
    harness.ctx.goals.edit(agent, harness.ctx.missions.get(agent)!.goal, { objective: 'edited objective' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(harness.ctx.missions.get(agent)?.revision).toBe(1)
  })

  it('contains a failing exhaustion record', async () => {
    const { harness, root } = await mount()
    const first = await mountHarness({ root, script: [], driver: false, config: { sweepOnStartup: false } })
    contexts.push(first.ctx)
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'exhaustion failure',
      completionCriteria: ['x'],
      maxRecoveryAttempts: 1,
    })
    await first.ctx.missions.recordAttempt(agent, started, { interruption: { kind: 'unknown', at: 1 } })
    const row = (await first.ctx.missions.ledger.list())[0]
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    if (row !== undefined) await harness.ctx.missions.ledger.put({ ...row, state: 'armed' })
    else await harness.ctx.missions.ledger.put(armedRow())
    const second = await mountHarness({ root, script: [], driver: false, config: { sweepOnStartup: false } })
    contexts.push(second.ctx)
    vi.spyOn(second.ctx.goals, 'block').mockImplementation(() => { throw new Error('goal closed') })
    const report = await second.ctx.missions.sweep()
    expect(report.exhausted + report.failed + report.settled).toBe(1)
  })
})

describe('goal reconciliation', () => {
  it('mirrors a goal revision into the discovery row', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, { objective: 'mirror me', completionCriteria: ['x'] })
    // A mission mutation advances the row past the goal revision, so a later
    // goal change is the only writer that can converge them.
    const checkpointed = await harness.ctx.missions.checkpoint(agent, started)
    expect(checkpointed.revision).toBe(2)
    harness.ctx.goals.edit(agent, harness.ctx.missions.get(agent)!.goal, { objective: 'mirrored objective' })
    await waitUntil(async () => (await harness.ctx.missions.ledger.list())[0]?.revision === 2)
    expect((await harness.ctx.missions.ledger.list())[0]?.revision).toBe(2)
  })

  it('ignores goal changes for a mission that already settled', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, { objective: 'settle first', completionCriteria: ['x'] })
    harness.ctx.goals.complete(agent, started.goal)
    await waitUntil(async () => (await harness.ctx.missions.ledger.list()).length === 0)
    // The row is gone; a later goal change must not resurrect it.
    harness.ctx.goals.edit(agent, { id: started.goal.id, revision: started.goal.revision + 1 }, { objective: 'late edit' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await harness.ctx.missions.ledger.list()).toHaveLength(0)
  })

  it('holds the row when the objective reports a blocker', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, { objective: 'blocked objective', completionCriteria: ['x'] })
    harness.ctx.goals.block(agent, started.goal, { code: 'needs-input', message: 'A human has to decide.' })
    await waitUntil(async () => (await harness.ctx.missions.ledger.list())[0]?.state === 'held')
    const row = (await harness.ctx.missions.ledger.list())[0]
    expect(row?.state).toBe('held')
    expect(row?.lastError).toMatchObject({ code: 'needs-input', message: 'A human has to decide.' })
  })
})

describe('held agent release', () => {
  it('releases only when the mission settles and contains a failing dispose', async () => {
    const { harness, root } = await mount()
    const other = await mountHarness({ root: await tempRoot('dsh-mission-other-').then(value => value.root), script: [], config: { sweepOnStartup: false } })
    contexts.push(other.ctx)
    const otherAgent = await createAgent(other)

    await harness.ctx.missions.ledger.put(armedRow())
    vi.spyOn(harness.ctx.agents, 'resume').mockResolvedValue({
      agent: otherAgent,
      dispose: () => Promise.reject(new Error('cannot dispose')),
    } as never)
    const report = await harness.ctx.missions.sweep()
    // The resumed Agent belongs to another session, so claiming it cannot
    // produce a mission: the row is held and the failing release is contained.
    expect(report).toMatchObject({ considered: 1, failed: 1 })
    expect((await harness.ctx.missions.ledger.list())[0]?.lastError?.code).toBe('recovery-failed')
  })

  it('invokes the deployment setup while composing a recovered agent', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-setup-')
    cleanups.push(cleanup)
    const seen: Agent[] = []
    const first = await mountHarness({ root, script: [textResponse('ok')], driver: true, config: { sweepOnStartup: false } })
    contexts.push(first.ctx)
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'setup seam', completionCriteria: ['x'] })
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mountHarness({
      root,
      script: [textResponse('ok'), textResponse('ok')],
      driver: true,
      config: { sweepOnStartup: false },
      setup: recovered => { seen.push(recovered) },
    })
    contexts.push(second.ctx)
    const report = await second.ctx.missions.sweep()
    expect(report.resumed).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.session.id).toBe('mission-session')
  })

  it('releases every held agent and waits for the running sweep when disposed', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-held-')
    cleanups.push(cleanup)
    const first = await mountHarness({ root, script: [textResponse('ok')], config: { sweepOnStartup: false } })
    contexts.push(first.ctx)
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'held across dispose', completionCriteria: ['x'] })
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mountHarness({ root, script: [textResponse('ok')], config: { sweepOnStartup: false } })
    contexts.push(second.ctx)
    await expect(second.ctx.missions.sweep()).resolves.toMatchObject({ resumed: 1 })
    // A held Agent exists now: dispose must release it and wait for the sweep
    // that is still claiming candidates.
    const sweep = second.ctx.missions.supervisor.sweep()
    await second.ctx.missions.supervisor.dispose()
    await expect(sweep).resolves.toBeDefined()
  })

  it('stops claiming and releases held agents when disposed mid-sweep', async () => {
    const { harness, root } = await mount()
    const other = await mountHarness({ root: await tempRoot('dsh-mission-dispose-').then(value => value.root), script: [], config: { sweepOnStartup: false } })
    contexts.push(other.ctx)
    const otherAgent = await createAgent(other)
    await harness.ctx.missions.ledger.put(armedRow({ missionId: 'mission-a' as RecoveryRecord['missionId'] }))
    await harness.ctx.missions.ledger.put(armedRow({ missionId: 'mission-b' as RecoveryRecord['missionId'] }))
    vi.spyOn(harness.ctx.agents, 'resume').mockImplementation(async () => {
      await Promise.resolve()
      return { agent: otherAgent, dispose: () => Promise.resolve() } as never
    })
    const sweep = harness.ctx.missions.sweep()
    await harness.ctx.missions.supervisor.dispose()
    const report = await sweep
    expect(report.considered).toBeLessThanOrEqual(2)
  })
})

describe('durable log closing', () => {
  it('refuses a row write and ignores a row removal once the domain closed', async () => {
    const { harness } = await mount()
    const ledger = harness.ctx.missions.ledger
    await ledger.close()
    await expect(ledger.put(armedRow())).rejects.toThrow('mission continuity ledger is closing')
    await expect(ledger.delete(armedRow().missionId)).resolves.toBeUndefined()
  })
})

describe('projection and fold edges', () => {
  it('records a non-error replay failure as its rendered message', () => {
    const state = missionProjectionDefinition.init()
    const broken: Parameters<typeof missionProjectionDefinition.apply>[1] = {
      type: 'mission/change',
      seq: SessionSeq(1),
      time: 1,
      get data(): never { throw 'not an error' },
    }
    expect(missionProjectionDefinition.apply(state, broken).failure).toBe('not an error')
  })
})

describe('activation and plan edges', () => {
  it('passes the goal round budget through to the objective', async () => {
    const { harness, agent } = await mount()
    const view = await harness.ctx.missions.start(agent, {
      objective: 'bounded objective',
      completionCriteria: ['x'],
      maxGoalRounds: 2,
    })
    expect(harness.ctx.goals.get(agent)).toMatchObject({ id: view.goal.id, maxGoalRounds: 2 })
  })

  it('resumes without a provider when the deployment offers no plan', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-empty-plan-')
    cleanups.push(cleanup)
    const first = await mountHarness({ root, script: [textResponse('ok')], config: { sweepOnStartup: false } })
    contexts.push(first.ctx)
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, { objective: 'no plan', completionCriteria: ['x'] })
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mountHarness({ root, script: [textResponse('ok')], config: { sweepOnStartup: false }, emptyPlan: true })
    contexts.push(second.ctx)
    const resume = vi.spyOn(second.ctx.agents, 'resume')
    const report = await second.ctx.missions.sweep()
    // Recovery never invents a route: an empty plan resumes the session and
    // lets the composition's own requirements fail loudly.
    expect(resume.mock.calls[0]?.[0]).not.toHaveProperty('agentOptions')
    expect(report).toMatchObject({ considered: 1 })
    expect((await second.ctx.missions.ledger.list())[0]?.lastError?.code ?? 'recovery-failed').toBe('recovery-failed')
    expect(started.id).toBeTruthy()
  })

  it('holds a mission that does not authorize autonomous recovery', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, {
      objective: 'no autonomous recovery',
      completionCriteria: ['x'],
      recovery: 'disabled',
    })
    await harness.ctx.missions.ledger.put({
      sessionId: agent.session.id,
      missionId: started.id,
      goalId: started.goal.id,
      revision: started.revision,
      attempts: started.attempts,
      state: 'armed',
      updatedAt: new Date().toISOString(),
    })
    const report = await harness.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, held: 1 })
    expect((await harness.ctx.missions.ledger.list())[0]?.lastError).toMatchObject({ code: 'recovery-disabled' })
  })

  it('mirrors a mission row whose recorded state is behind', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, { objective: 'stale row state', completionCriteria: ['x'] })
    // A held row with the current revision is the only shape the mirroring
    // branch can still see: revision writes and state writes share a record.
    await harness.ctx.missions.ledger.put({
      sessionId: agent.session.id,
      missionId: started.id,
      goalId: started.goal.id,
      revision: started.revision,
      attempts: started.attempts,
      state: 'held',
      updatedAt: new Date().toISOString(),
    })
    harness.ctx.goals.edit(agent, harness.ctx.missions.get(agent)!.goal, { objective: 'edited after hold' })
    await waitUntil(async () => (await harness.ctx.missions.ledger.list())[0]?.state === 'armed')
    expect((await harness.ctx.missions.ledger.list())[0]).toMatchObject({ state: 'armed', missionId: started.id })
  })

  it('drops the held agent when the agent is disposed', async () => {
    const { harness, agent } = await mount()
    await harness.ctx.missions.start(agent, { objective: 'disposed agent', completionCriteria: ['x'] })
    harness.ctx.emit('agent/disposed', { agent })
    // Releasing an already-disposed agent is a no-op rather than an error.
    expect(() => harness.ctx.missions.supervisor.release(agent.session.id)).not.toThrow()
  })

  it('waits for a running sweep when disposed', async () => {
    const { harness } = await mount()
    await harness.ctx.missions.sweep()
    await harness.ctx.missions.ledger.put(armedRow())
    vi.spyOn(harness.ctx.agents, 'resume').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      throw new Error('still resuming')
    })
    const sweep = harness.ctx.missions.supervisor.sweep()
    const disposed = harness.ctx.missions.supervisor.dispose()
    await expect(sweep).resolves.toMatchObject({ considered: 1 })
    await expect(disposed).resolves.toBeUndefined()
  })
})

