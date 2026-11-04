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

import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import { UNCERTAIN_ACKNOWLEDGED, UNCERTAIN_OPERATIONS } from '../src/runtime.ts'
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


/**
 * Drive a real tool call to the one durable shape recovery cannot resolve: the
 * call is recorded, and its result says the outcome is unknown. Appending
 * through the live session (not by editing the artifact) keeps the log exactly
 * what the runtime writes when a tool disappears mid-call.
 */
function recordUnknownCall(agent: Agent): void {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId('call-effect'),
    name: 'external_effect',
    arguments: '{}',
  })
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-effect'),
      content: [{ type: 'text', text: 'the tool did not report back' }],
      isError: true,
    }),
    error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
  }, { surfaceOp: 'append' })
}

/** Absolute path of one session's durable artifact. */
async function findArtifact(root: string, sessionId: string): Promise<string> {
  const entries = await readdir(join(root, 'sessions'), { recursive: true, withFileTypes: true })
  const found = entries.find(entry => entry.isFile()
    && entry.parentPath.includes(sessionId)
    && entry.name.endsWith('.jsonl'))
  if (found === undefined) throw new Error(`no artifact for ${sessionId}`)
  return join(found.parentPath, found.name)
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
  it('holds the mission instead of resuming past the doubt', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-uncertain-')
    cleanups.push(cleanup)
    const harness = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    const agent = await createAgent(harness)
    await harness.ctx.missions.start(agent, { objective: 'publish', completionCriteria: ['done'] })
    recordUnknownCall(agent)
    expect(harness.ctx.missions.uncertainOperations(agent))
      .toEqual([{ callId: 'call-effect', name: 'external_effect' }])

    const report = await harness.ctx.missions.sweep()

    expect(report).toMatchObject({ considered: 1, resumed: 0, held: 1 })
    const [row] = await harness.ctx.missions.ledger.list()
    expect(row.state).toBe('held')
    expect(row.lastError?.code).toBe(UNCERTAIN_OPERATIONS)
    expect(row.lastError?.message).toContain('external_effect')
    // Recovery did not spend an attempt, and the model was never told to go on.
    expect(row.attempts).toBe(0)
    await harness.ctx.sessions.flush(agent.session)
    expect(countMissionNotices(await readSessionArtifact(root).catch(() => ''))).toBe(0)
  })

  it('resumes only after a human clears the recorded doubt, and remembers it', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-ack-')
    cleanups.push(cleanup)
    const harness = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    const agent = await createAgent(harness)
    await harness.ctx.missions.start(agent, { objective: 'publish', completionCriteria: ['done'] })
    recordUnknownCall(agent)
    await harness.ctx.missions.sweep()

    const held = harness.ctx.missions.get(agent)!
    await harness.ctx.missions.resume(agent, { id: held.id, revision: held.revision })

    const [acknowledged] = await harness.ctx.missions.ledger.list()
    expect(acknowledged.lastError?.code).toBe(UNCERTAIN_ACKNOWLEDGED)
    expect(acknowledged.attempts).toBe(0)

    // The acknowledgement is what lets the next sweep act despite the doubt.
    const report = await harness.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1 })
    const [resumed] = await harness.ctx.missions.ledger.list()
    expect(resumed.attempts).toBe(1)
    expect(resumed.state).toBe('armed')
  })

  it('does not acknowledge doubt the log no longer holds', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-ack-clean-')
    cleanups.push(cleanup)
    const harness = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    const agent = await createAgent(harness)
    await harness.ctx.missions.start(agent, { objective: 'publish', completionCriteria: ['done'] })
    const authorized = await harness.ctx.missions.authorize(
      agent,
      { id: harness.ctx.missions.get(agent)!.id, revision: harness.ctx.missions.get(agent)!.revision },
      { code: UNCERTAIN_OPERATIONS, message: 'held for review' },
    )

    await harness.ctx.missions.resume(agent, { id: authorized.id, revision: authorized.revision })

    const [row] = await harness.ctx.missions.ledger.list()
    expect(row.lastError).toBeUndefined()
    expect(row.state).toBe('armed')
  })

  it('renders the plan recovery reads from the todo projection', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-plan-')
    cleanups.push(cleanup)
    const harness = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    const agent = await createAgent(harness)
    const projections = harness.ctx.sessionProjections as unknown as {
      stateOf: (session: unknown, key: string) => unknown
    }
    const original = projections.stateOf.bind(projections)
    vi.spyOn(projections, 'stateOf').mockImplementation(((session: unknown, key: string) =>
      key === 'todos'
        ? [{ content: 'check the deployment', status: 'pending' }]
        : original(session, key)) as never)

    expect(harness.ctx.missions.plan(agent)).toEqual([
      { content: 'check the deployment', status: 'pending' },
    ])
  })
})

describe('index rebuild failures', () => {
  it('rebuilds what it can when one stored session cannot be read', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-rebuild-skip-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')])
    for (const id of ['mission-session-a', 'mission-session-b']) {
      const handle = await first.ctx.agents.create({
        sessionId: SessionId(id),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await first.ctx.missions.start(handle.agent, {
        objective: `mission ${id}`,
        completionCriteria: ['partial'],
      })
      await first.ctx.sessions.flush(handle.agent.session)
    }
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    // A session whose stored log cannot be decoded must cost that session only.
    await writeFile(await findArtifact(root, 'mission-session-a'), '{not a session log\n')
    await removeIndexFiles(root)
    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    expect((await second.ctx.missions.ledger.list()).map(row => String(row.sessionId)))
      .toEqual(['mission-session-b'])
  })

  it('keeps rebuilding when one stored session cannot be read', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-rebuild-ghost-')
    cleanups.push(cleanup)
    const harness = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    // A storage that lists a session whose artifact is already gone (a delete
    // that stopped halfway, or a start that never flushed) must cost one row.
    vi.spyOn(harness.ctx.sessionPersistence, 'list').mockResolvedValue([
      { header: { id: 'mission-session-ghost' } } as never,
    ])
    await (harness.ctx.missions as unknown as { rebuildIndex: () => Promise<void> }).rebuildIndex()
    expect(await harness.ctx.missions.ledger.list()).toEqual([])
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
