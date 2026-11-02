/**
 * What a successful start promises, and what survives when it does not return.
 *
 * The guarantee under test is one-directional and exact: if `start()` resolves,
 * the mission record is durable and a later process finds it; if the process
 * dies anywhere earlier, no phantom mission appears and no durable mission is
 * left invisible. The index is a hint that startup can rebuild from the session
 * logs, never the source of truth.
 *
 * The crash boundaries are simulated by taking the durable directory away from
 * the composition — copying it, or reading it through a second composition —
 * instead of by flushing first, so a record that only exists in memory is
 * simply not there.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import {
  countMissionNotices,
  createAgent,
  mountHarness,
  readSessionArtifact,
  tempRoot,
  textResponse,
} from './harness.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Mount one composition rooted at `root` and own its cleanup. */
async function mount(
  root: string,
  script: Parameters<typeof mountHarness>[0]['script'],
  config: Parameters<typeof mountHarness>[0]['config'] = {},
) {
  const harness = await mountHarness({ root, script, driver: true, config })
  contexts.push(harness.ctx)
  return harness
}

/** A durable copy of a root, as the disk would hold it after a process vanished. */
async function snapshotRoot(root: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), 'dsh-mission-snapshot-'))
  await cp(root, copy, { recursive: true })
  cleanups.push(async () => { await rm(copy, { recursive: true, force: true }) })
  return copy
}

/** Every file under one directory, for "the index is gone" simulations. */
async function removeIndexFiles(root: string): Promise<void> {
  await rm(join(root, 'storages'), { recursive: true, force: true })
}

describe('mission start durability', () => {
  it('makes the record durable before it resolves, with no later flush', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-durable-start-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'survive a kill right after start resolves',
      completionCriteria: ['the record is on disk'],
    })

    // The crash: the disk as it stands now, with nothing else flushed by this
    // process and no graceful stop.
    const disk = await snapshotRoot(root)
    const second = await mount(disk, [textResponse('continued')], { sweepOnStartup: false })
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1 })
    const resumed = second.ctx.agents.get(SessionId('mission-session'))
    expect(resumed).toBeDefined()
    expect(second.ctx.missions.get(resumed!)).toMatchObject({ id: started.id, attempts: 1 })
  })

  it('leaves nothing recoverable when the record cannot be made durable', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-flush-fail-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    const flush = vi.spyOn(first.ctx.sessions, 'flush').mockRejectedValue(new Error('disk gone'))
    await expect(first.ctx.missions.start(agent, {
      objective: 'never durable',
      completionCriteria: ['nothing'],
    })).rejects.toMatchObject({ code: 'MISSION_PERSISTENCE_FAILED' })
    flush.mockRestore()

    // The failed start drops its row and blocks the objective: no phantom work.
    expect(await first.ctx.missions.ledger.list()).toHaveLength(0)
    expect(first.ctx.missions.get(agent)).toBeUndefined()
    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    expect(await second.ctx.missions.ledger.list()).toHaveLength(0)
    expect((await second.ctx.missions.sweep()).considered).toBe(0)
  })

  it('appends no record when the discovery row cannot be written', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-index-fail-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    const put = vi.spyOn(first.ctx.missions.ledger, 'put').mockRejectedValue(new Error('index gone'))
    await expect(first.ctx.missions.start(agent, {
      objective: 'no index, no start',
      completionCriteria: ['nothing'],
    })).rejects.toMatchObject({ code: 'MISSION_PERSISTENCE_FAILED' })
    put.mockRestore()

    // A start rejected before the record exists must not leave one behind: the
    // log holds no mission change a later process could recover from.
    expect(await first.ctx.missions.ledger.list()).toHaveLength(0)
    // Nothing was flushed, so there may be no artifact at all; either way the
    // log holds no mission record a later process could recover from.
    const artifact = await readSessionArtifact(root).catch(() => '')
    expect(artifact).not.toContain('"operation":"start"')
    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    expect((await second.ctx.missions.sweep()).considered).toBe(0)
  })
})

describe('discovery index rebuild', () => {
  it('finds a durable mission whose index was lost', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-rebuild-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'outlive the index',
      completionCriteria: ['the log still knows the mission'],
    })
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    // The index is gone; the session log is not. The index is never the source
    // of truth, so startup must rebuild the hint and recover the work.
    await removeIndexFiles(root)
    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    expect(await second.ctx.missions.ledger.list()).toMatchObject([{ missionId: started.id, state: 'armed' }])
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1 })
    const resumed = second.ctx.agents.get(SessionId('mission-session'))
    expect(second.ctx.missions.get(resumed!)).toMatchObject({ id: started.id, attempts: 1 })
  })

  it('does not rebuild rows for missions that are already finished', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-rebuild-settled-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'already done',
      completionCriteria: ['finished'],
    })
    first.ctx.goals.complete(agent, started.goal)
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    await removeIndexFiles(root)
    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    // Completed work is not recoverable work: the rebuild writes no row, and the
    // sweep has nothing to consider instead of settling a phantom every boot.
    expect(await second.ctx.missions.ledger.list()).toHaveLength(0)
    expect((await second.ctx.missions.sweep()).considered).toBe(0)
  })

  it('honours the rebuild bound instead of reading every stored session', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-rebuild-bound-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    for (const id of ['mission-session-a', 'mission-session-b']) {
      const handle = await first.ctx.agents.create({
        sessionId: SessionId(id),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await first.ctx.missions.start(handle.agent, {
        objective: `mission ${id}`,
        completionCriteria: ['bounded'],
      })
      await first.ctx.sessions.flush(handle.agent.session)
    }
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    await removeIndexFiles(root)
    const second = await mount(root, [textResponse('continued')], {
      sweepOnStartup: false,
      maxRebuildSessions: 1,
      sessionId: 'mission-session-a',
    })
    expect(await second.ctx.missions.ledger.list()).toHaveLength(1)
  })

  it('can be turned off, leaving the index exactly as the medium has it', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-rebuild-off-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'no rebuild', completionCriteria: ['off'] })
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    await removeIndexFiles(root)
    const second = await mount(root, [textResponse('continued')], {
      sweepOnStartup: false,
      rebuildIndexOnStartup: false,
    })
    expect(await second.ctx.missions.ledger.list()).toHaveLength(0)
    expect((await second.ctx.missions.sweep()).considered).toBe(0)
  })
})

describe('interrupted calls with no durable result', () => {
  /**
   * Put the durable log in the exact state a crash inside a tool leaves behind:
   * a recorded call and a committed result whose outcome is unknown.
   */
  function recordUnknownCall(ctx: Context, session: Parameters<typeof createAgent>[0]['session'] extends never ? never : {
    append: (type: string, data: unknown, opts?: unknown) => unknown
  }): void {
    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('call-effect'), name: 'external_effect', arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('call-effect'),
        content: [{ type: 'text', text: 'the call never produced a durable result' }],
        isError: true,
      }),
      error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
    }, { surfaceOp: 'append' })
    void ctx
  }

  it('holds the mission instead of resuming past the doubt', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-uncertain-gate-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'never repeat blindly',
      completionCriteria: ['the external state is verified first'],
    })
    recordUnknownCall(first.ctx, agent.session)
    expect(first.ctx.missions.uncertainOperations(agent)).toEqual([
      { callId: 'call-effect', name: 'external_effect' },
    ])
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    const report = await second.ctx.missions.sweep()
    // Held, not resumed: no attempt spent, no Agent composed, no model request.
    expect(report).toMatchObject({ considered: 1, resumed: 0, held: 1 })
    expect(second.ctx.agents.get(SessionId('mission-session'))).toBeUndefined()
    expect(second.adapter.requests).toHaveLength(0)
    expect(await second.ctx.missions.ledger.list()).toMatchObject([{
      missionId: started.id,
      attempts: 0,
      state: 'held',
      lastError: { code: 'uncertain-operations' },
    }])
  })

  it('resumes once a human clears the recorded doubt, and remembers it', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-uncertain-ack-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'resume after review',
      completionCriteria: ['reviewed'],
    })
    recordUnknownCall(first.ctx, agent.session)
    const blocked = await first.ctx.missions.authorize(agent, started, {
      code: 'uncertain-operations',
      message: 'Interrupted tool calls whose outcome is unknown: external_effect.',
    })
    // The human decision: clear the authorization. The durable index keeps the
    // acknowledgement so the next sweep does not raise the same hold again.
    const resumedByHuman = await first.ctx.missions.resume(agent, {
      id: blocked.id,
      revision: blocked.revision,
    })
    expect((await first.ctx.missions.ledger.list())[0]).toMatchObject({
      state: 'armed',
      lastError: { code: 'uncertain-operations-acknowledged' },
    })
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1, held: 0 })
    const resumed = second.ctx.agents.get(SessionId('mission-session'))
    expect(second.ctx.missions.get(resumed!)).toMatchObject({
      id: resumedByHuman.id,
      attempts: 1,
    })
    await second.ctx.sessions.flush(resumed!.session)
    expect(countMissionNotices(await readSessionArtifact(root))).toBe(1)
  })

  it('rebuilds what it can when one stored session cannot be read', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-rebuild-skip-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'survive a bad log', completionCriteria: ['partial'] })
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    await removeIndexFiles(root)
    const second = await mountHarness({
      root,
      script: [textResponse('continued')],
      driver: true,
      config: { sweepOnStartup: false },
    })
    contexts.push(second.ctx)
    // One unreadable session must cost that session, not the whole rebuild.
    const warn = vi.spyOn(second.ctx.logger, 'warn')
    const stored = (second.ctx.missions as unknown as {
      storedMission: (id: SessionId) => Promise<unknown>
    })
    const original = stored.storedMission.bind(second.ctx.missions)
    stored.storedMission = async (id: SessionId) => {
      if (String(id) === 'mission-session') throw new Error('unreadable log')
      return await original(id)
    }
    await (second.ctx.missions as unknown as { rebuildIndex: () => Promise<void> }).rebuildIndex()
    expect(warn.mock.calls.some(call => String(call[0]).includes('unreadable log'))).toBe(true)
    expect(await second.ctx.missions.ledger.list()).toHaveLength(0)
  })

  it('skips the rebuild entirely when the medium cannot be listed', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-rebuild-listfail-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'list failure', completionCriteria: ['soft'] })
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    await removeIndexFiles(root)
    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    const warn = vi.spyOn(second.ctx.logger, 'warn')
    const list = vi.spyOn(second.ctx.sessionPersistence, 'list').mockRejectedValue(new Error('medium offline'))
    await (second.ctx.missions as unknown as { rebuildIndex: () => Promise<void> }).rebuildIndex()
    expect(warn.mock.calls.some(call => String(call[0]).includes('medium offline'))).toBe(true)
    list.mockRestore()
  })
})

describe('single recovery per interruption', () => {
  it('shares one resume between concurrent sweeps', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-concurrent-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'one recovery', completionCriteria: ['once'] })
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    const reports = await Promise.all([
      second.ctx.missions.sweep(),
      second.ctx.missions.sweep(),
      second.ctx.missions.sweep(),
    ])
    // Concurrent callers observe the same sweep, so exactly one attempt and one
    // notice exist afterwards.
    expect(reports.map(report => report.resumed)).toEqual([1, 1, 1])
    const resumed = second.ctx.agents.get(SessionId('mission-session'))
    expect(second.ctx.missions.get(resumed!)?.attempts).toBe(1)
    await second.ctx.sessions.flush(resumed!.session)
    expect(countMissionNotices(await readSessionArtifact(root))).toBe(1)
  })

  it('resumes once when two instances sweep the same durable mission', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-two-instances-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'two owners', completionCriteria: ['once'] })
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    // Two live compositions over the same durable home, like a second `dsh`
    // started before the first one exited.
    const alpha = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    const beta = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    const reports = await Promise.allSettled([
      alpha.ctx.missions.sweep(),
      beta.ctx.missions.sweep(),
    ])
    const resumed = reports.filter(result => result.status === 'fulfilled' && result.value.resumed === 1)
    const skipped = reports.filter(result => result.status === 'fulfilled' && result.value.skipped === 1)
    // Exactly one instance wins the session; the other reports that the mission
    // is owned elsewhere instead of resuming and consuming a second attempt.
    expect(resumed).toHaveLength(1)
    expect(skipped).toHaveLength(1)
    const owner = resumed[0]!.status === 'fulfilled' && reports[0].status === 'fulfilled'
      && reports[0].value.resumed === 1 ? alpha : beta
    const loser = owner === alpha ? beta : alpha
    expect(loser.ctx.agents.get(SessionId('mission-session'))).toBeUndefined()
    // The winner holds one attempt and one notice; the loser wrote neither.
    const alive = owner.ctx.agents.get(SessionId('mission-session'))
    expect(owner.ctx.missions.get(alive!)?.attempts).toBe(1)
    await owner.ctx.sessions.flush(alive!.session)
    expect(countMissionNotices(await readSessionArtifact(root))).toBe(1)
    // The loser wrote nothing: a fresh composition reads the winner's row, not a
    // stale copy of it.
    const third = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    expect(await third.ctx.missions.ledger.list()).toMatchObject([{ attempts: 1, state: 'armed' }])
  })

  it('charges one more attempt when the process dies during recovery itself', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-crash-in-recovery-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'recover through two deaths', completionCriteria: ['bounded'] })
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    // First recovery: the attempt is durable before the work starts.
    const recovering = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    expect((await recovering.ctx.missions.sweep()).resumed).toBe(1)
    const disk = await snapshotRoot(root)

    // The recovering process dies with its attempt recorded and its notice
    // queued. A later start charges exactly one more attempt, and the mission is
    // still not declared complete.
    const next = await mount(disk, [textResponse('continued')], { sweepOnStartup: false })
    const report = await next.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1 })
    const resumed = next.ctx.agents.get(SessionId('mission-session'))
    const mission = next.ctx.missions.get(resumed!)
    expect(mission?.attempts).toBe(2)
    expect(mission?.settled).toBe(false)
    await next.ctx.sessions.flush(resumed!.session)
    // Two interruptions, two attempts, two notices — and one mission record.
    expect(countMissionNotices(await readSessionArtifact(disk))).toBe(2)
    expect((await readSessionArtifact(disk)).split('"operation":"start"').length - 1).toBe(1)
    expect(await next.ctx.missions.ledger.list()).toMatchObject([{ attempts: 2 }])
  })

  it('does not recover a mission whose work already completed', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-complete-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'finish once',
      completionCriteria: ['done'],
    })
    first.ctx.goals.complete(agent, started.goal)
    await first.ctx.sessions.flush(agent.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    expect((await second.ctx.missions.sweep()).considered).toBe(0)
    expect(second.ctx.agents.get(SessionId('mission-session'))).toBeUndefined()
  })
})
