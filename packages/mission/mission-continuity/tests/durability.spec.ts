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
  soleRow,
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
  // `sessionId` is a harness concern, not a mission Config field: it selects the
  // session the composition reattaches to, so it travels beside the config
  // instead of inside it.
  sessionId?: string,
) {
  const harness = await mountHarness({ root, script, driver: true, config, ...(sessionId === undefined ? {} : { sessionId }) })
  contexts.push(harness.ctx)
  return harness
}

/**
 * Restart the composition on `root` so the startup index rebuild runs.
 *
 * The rebuild is a private step of activation, so the test observes it the way a
 * deployment does: mount again and await the ready services. That boot promise
 * resolves after the ledger opens, the index is rebuilt from the session logs,
 * and the startup sweep has run. Reaching into a service member would instead
 * pin an implementation detail that configuration already exposes.
 * @param root - durable root shared with the previous composition.
 * @param config - mission configuration for the restarted composition.
 * @returns the restarted, fully initialized composition.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- single awaited mount, kept async for call-site symmetry
async function restartAndRebuild(
  root: string,
  config: Parameters<typeof mountHarness>[0]['config'],
  beforeMission?: Parameters<typeof mountHarness>[0]['beforeMission'],
): Promise<Awaited<ReturnType<typeof mount>>> {
  const harness = await mountHarness({
    root,
    script: [textResponse('continued')],
    driver: true,
    config: config ?? {},
    ...beforeMission === undefined ? {} : { beforeMission },
  } satisfies Parameters<typeof mountHarness>[0])
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

/**
 * Drive the wider shape the pending-call bound used to lose: more calls in
 * flight than the tracker retained, each ending in an unknown outcome. A wide
 * fan-out is ordinary (the agent loop dispatches up to ten calls at once), so
 * this is the same doubt as {@link recordUnknownCall}, only fanned out.
 * @param agent - owning live agent.
 * @param count - how many calls the step started.
 */
function recordUnknownCalls(agent: Agent, count: number): void {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  for (let index = 0; index < count; index += 1) {
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId(`call-${index}`),
      name: 'external_effect',
      arguments: '{}',
    })
  }
  for (let index = 0; index < count; index += 1) {
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(`call-${index}`),
        content: [{ type: 'text', text: 'the tool did not report back' }],
        isError: true,
      }),
      error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
    }, { surfaceOp: 'append' })
  }
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
    }, 'mission-session-a')
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
    const row = await soleRow(harness)
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

    const acknowledged = await soleRow(harness)
    expect(acknowledged.lastError?.code).toBe(UNCERTAIN_ACKNOWLEDGED)
    expect(acknowledged.attempts).toBe(0)

    // The acknowledgement is what lets the next sweep act despite the doubt.
    const report = await harness.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1 })
    const resumed = await soleRow(harness)
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

    const row = await soleRow(harness)
    expect(row.lastError).toBeUndefined()
    expect(row.state).toBe('armed')
  })

  it('renders the plan recovery reads from the todo projection', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-plan-')
    cleanups.push(cleanup)
    const harness = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    const agent = await createAgent(harness)
    // The plan is read from the `todos` projection, so the test writes it the
    // way a deployment does: through the real `todo_write` tool, so the entry
    // becomes a logged `todo/write` the projection folds like any other.
    const written = await harness.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('plan-write'),
      name: 'todo_write',
      arguments: { todos: [{ content: 'check the deployment', status: 'pending' }] },
      agent,
    })
    expect(written.isError).toBe(false)

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
    // A storage that lists a session whose artifact is already gone (a delete
    // that stopped halfway, or a start that never flushed) must cost one row.
    // The failure has to be arranged before activation, because that is when the
    // rebuild lists the medium.
    const restarted = await restartAndRebuild(root, { sweepOnStartup: false }, (ctx) => {
      vi.spyOn(ctx.sessionPersistence, 'list').mockResolvedValue([
        { header: { id: 'mission-session-ghost' } } as never,
      ])
    })
    expect(await restarted.ctx.missions.ledger.list()).toEqual([])
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
    // The medium fails while the restarted composition is still booting, which
    // is the only window the rebuild runs in: the spy has to be in place before
    // the mission service activates, not after.
    const warnings: unknown[][] = []
    await restartAndRebuild(root, { sweepOnStartup: false }, (ctx) => {
      vi.spyOn(ctx.sessionPersistence, 'list').mockRejectedValue(new Error('medium offline'))
      vi.spyOn(ctx.logger, 'warn').mockImplementation((format: unknown, ...param: unknown[]) => {
        warnings.push([format, ...param])
      })
    })
    expect(warnings.some(args => String(args[0]).includes('medium offline'))).toBe(true)
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

describe('wide fan-out with unknown outcomes', () => {
  /**
   * Regression (preexisting): the pending-call window was smaller than one
   * step's fan-out, so a step that started more calls than the window held left
   * its earliest calls untracked. Their unknown-outcome results matched nothing,
   * the mission looked doubt-free, and the startup sweep resumed work past an
   * external effect nobody had confirmed.
   */
  it('holds the mission instead of resuming past calls it could not track', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-fanout-')
    cleanups.push(cleanup)
    const harness = await mount(root, [textResponse('should not run')], { sweepOnStartup: false })
    const agent = await createAgent(harness)
    await harness.ctx.missions.start(agent, { objective: 'wide fan-out', completionCriteria: ['safe'] })
    recordUnknownCalls(agent, 24)

    // Every one of the 24 calls is a recorded doubt, and none of them is lost:
    // the listed window is bounded, the remainder is counted.
    const listed = harness.ctx.missions.uncertainOperations(agent)
    expect(listed).toHaveLength(22)
    expect(harness.ctx.missions.uncertainOverflow(agent)).toBe(2)

    const report = await harness.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 0, held: 1 })
    const row = (await harness.ctx.missions.ledger.list())[0]
    expect(row?.lastError?.code).toBe(UNCERTAIN_OPERATIONS)
    // The count is what a human acts on, so it always fits the durable
    // diagnostic; the names are what the bound trims.
    expect(row?.lastError?.message).toContain('24 recorded')
    expect(row?.lastError?.message).toContain('external_effect')
    // Recovery never spent an attempt on a doubt it could not resolve.
    expect(row?.attempts).toBe(0)
    expect(harness.ctx.missions.get(agent)?.authorization?.code).toBe(UNCERTAIN_OPERATIONS)
    // No recovery notice was queued for work that must wait for a human.
    await harness.ctx.sessions.flush(agent.session)
    expect(countMissionNotices(await readSessionArtifact(root))).toBe(0)
  })
})
