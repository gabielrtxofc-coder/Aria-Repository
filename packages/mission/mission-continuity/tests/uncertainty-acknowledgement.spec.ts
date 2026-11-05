/**
 * Who a human's acknowledgement of unknown outcomes actually releases.
 *
 * A call whose outcome is unknown is a fact about one external effect, so the
 * decision that clears it belongs to that call — never to the session as a
 * whole. These specs pin both halves of that rule: an acknowledgement covers the
 * doubts it was shown (and nothing recorded afterwards), and it survives the
 * process that wrote it, because the decision lives in the durable mission
 * record rather than in a rebuildable index row.
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import { UNCERTAIN_OPERATIONS } from '../src/runtime.ts'
import {
  createAgent,
  mountHarness,
  stopHarness,
  tempRoot,
  textResponse,
} from './harness.ts'
import type { MissionHarness } from './harness.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * Mount one composition on `root`, owned by the test. The round driver stays
 * unmounted: these specs are about what recovery decides, so nothing else may
 * open a turn between the two operations they order.
 */
async function mount(
  root: string,
  script: Parameters<typeof mountHarness>[0]['script'],
  config: Parameters<typeof mountHarness>[0]['config'] = {},
): Promise<MissionHarness> {
  const harness = await mountHarness({ root, script, config })
  contexts.push(harness.ctx)
  return harness
}

/** The turn number the next appended turn must open, as the log counts them. */
function nextTurn(agent: Agent): number {
  let opened = 0
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'turn/start') opened += 1
  }
  return opened + 1
}

/**
 * Compose the session in a later process, the way the human path does: the Agent
 * is resumed over the durable log, and nothing sweeps until the test says so.
 * @param harness - freshly mounted composition over a durable session.
 * @returns the live Agent that carries the recovered session.
 */
async function adoptAgent(harness: MissionHarness): Promise<Agent> {
  const handle = await harness.ctx.agents.resume({
    resumeSessionId: harness.session,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return handle.agent
}

/**
 * Record one call whose committed result says the outcome is unknown — the
 * durable fact recovery cannot resolve on its own.
 * @param agent - owning live agent.
 * @param callId - identity of the call whose effect nobody confirmed.
 */
function recordUnknownCall(agent: Agent, callId: string): void {
  const turn = nextTurn(agent)
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  // The round has to be complete, not just foldable: the acknowledgement tests read
  // this log back after a restart, and a tool call the model never advertised is
  // corruption to that reader.
  agent.session.append('assistant/message', {
    turn,
    step: 1,
    stream: [],
    message: {
      id: randomUUID(),
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId(callId), name: 'external_effect', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock', api: 'mock' },
      stopReason: 'tool-calls',
      usage: { input: 0, output: 0, cache: { read: 0, write: 0 }, cost: { total: 0 } },
    },
  }, { surfaceOp: 'append' })
  agent.session.append('tool/call', {
    turn, step: 1, callId: ToolCallId(callId), name: 'external_effect', arguments: '{}',
  })
  agent.session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: 'the tool did not report back' }],
      isError: true,
    }),
    error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn, step: 1 })
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** The doubts the session log records, in the order the fold saw them. */
function uncertainIds(harness: MissionHarness, agent: Agent): string[] {
  return harness.ctx.missions.uncertainOperations(agent).map(operation => operation.callId)
}

/** How many unknown outcomes the bounded window could not name. */
function unnamed(harness: MissionHarness, agent: Agent): number {
  return harness.ctx.missions.uncertainOverflow(agent)
}

/** Start one mission and leave it current in a freshly mounted composition. */
async function startMission(harness: MissionHarness): Promise<Agent> {
  const agent = await createAgent(harness)
  await harness.ctx.missions.start(agent, {
    objective: 'finish the irreversible migration',
    completionCriteria: ['the external record exists and nothing runs twice'],
    maxRecoveryAttempts: 3,
  })
  return agent
}

describe('acknowledgement scope', () => {
  /**
   * Reproduced defect (B-1): the decision that cleared two unknown outcomes was
   * recorded as a property of the whole session, so every doubt recorded after
   * it — including one nobody had reviewed — read as cleared too, and the next
   * process resumed work past an unconfirmed external effect.
   */
  it('refuses to let an earlier acknowledgement cover a doubt recorded after it', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-ack-scope-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    const agent = await startMission(first)
    recordUnknownCall(agent, 'call-one')
    recordUnknownCall(agent, 'call-two')
    expect(uncertainIds(first, agent)).toEqual(['call-one', 'call-two'])

    // Recovery stops at the two doubts and asks a human.
    expect(await first.ctx.missions.sweep()).toMatchObject({ considered: 1, held: 1, resumed: 0 })
    const held = first.ctx.missions.get(agent)!
    expect(held.authorization?.code).toBe(UNCERTAIN_OPERATIONS)

    // The human reviewed exactly those two calls and resumed the mission.
    await first.ctx.missions.resume(agent, { id: held.id, revision: held.revision })
    const acknowledged = first.ctx.missions.get(agent)!
    // The decision is durable mission state, so a later process reads the same
    // scope this one was shown: two doubts, not an open-ended permission.
    expect(acknowledged.uncertainAcknowledged).toBe(2)

    // A third operation now loses its outcome, and the process dies. Nothing
    // else touched the mission record, so the recovery index still carries the
    // acknowledgement this session wrote.
    recordUnknownCall(agent, 'call-three')
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(root, [textResponse('continued'), textResponse('continued')], { sweepOnStartup: false })
    const restored = await adoptAgent(second)
    expect(second.ctx.missions.get(restored)?.uncertainAcknowledged).toBe(2)
    expect(uncertainIds(second, restored)).toEqual(['call-one', 'call-two', 'call-three'])
    expect(second.ctx.missions.get(restored)?.authorization).toBeUndefined()

    // The new doubt must stop recovery on its own.
    expect(await second.ctx.missions.sweep()).toMatchObject({ considered: 1, held: 1, resumed: 0 })
    const reheld = second.ctx.missions.get(restored)!
    expect(reheld.authorization?.code).toBe(UNCERTAIN_OPERATIONS)
    expect(reheld.attempts).toBe(0)
    const [row] = await second.ctx.missions.ledger.list()
    expect(row?.state).toBe('held')
    expect(row?.lastError?.code).toBe(UNCERTAIN_OPERATIONS)
    // The diagnostic names the count the human has to act on: one new doubt,
    // not the three the log holds, because two of them were already reviewed.
    expect(row.lastError?.message).toContain('1 recorded')

    // Acknowledging the third call is what unblocks the mission — and only then.
    await second.ctx.missions.resume(restored, { id: reheld.id, revision: reheld.revision })
    expect(second.ctx.missions.get(restored)?.uncertainAcknowledged).toBe(3)
    expect(await second.ctx.missions.sweep()).toMatchObject({ considered: 1, resumed: 1, held: 0 })
    expect(second.ctx.missions.get(restored)?.authorization).toBeUndefined()
    expect(second.ctx.missions.get(restored)?.attempts).toBe(1)
  }, 120_000)

  it('records the acknowledgement against the doubts it saw, not the whole session', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-ack-watermark-')
    cleanups.push(cleanup)
    const harness = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    const agent = await startMission(harness)
    expect(harness.ctx.missions.get(agent)?.uncertainAcknowledged).toBeUndefined()

    recordUnknownCall(agent, 'call-one')
    expect(harness.ctx.missions.uncertainOperations(agent)).toHaveLength(1)
    // Nothing is cleared yet, so the outstanding backlog blocks the sweep.
    expect(await harness.ctx.missions.sweep()).toMatchObject({ considered: 1, held: 1 })

    const held = harness.ctx.missions.get(agent)!
    await harness.ctx.missions.resume(agent, { id: held.id, revision: held.revision })
    expect(harness.ctx.missions.get(agent)?.uncertainAcknowledged).toBe(1)
    // An acknowledged doubt stops blocking recovery, but stays visible: the model
    // still has to know that a call nobody confirmed may have changed the world.
    expect(harness.ctx.missions.uncertainOperations(agent)).toEqual([
      { callId: 'call-one', name: 'external_effect' },
    ])
    expect(await harness.ctx.missions.sweep()).toMatchObject({ considered: 1, resumed: 1 })

    // Two more doubts, one acknowledgement: the next sweep sees the backlog grow.
    recordUnknownCall(agent, 'call-two')
    recordUnknownCall(agent, 'call-three')
    // Real progress in between, so the hold below is claimed afresh rather than
    // skipped as a mission this process already recovered.
    await harness.ctx.missions.checkpoint(agent, harness.ctx.missions.get(agent)!)
    const progressed = harness.ctx.missions.get(agent)!
    expect(progressed.uncertainAcknowledged).toBe(1)
    expect(await harness.ctx.missions.sweep()).toMatchObject({ considered: 1, held: 1, resumed: 0 })
    const reheld = harness.ctx.missions.get(agent)!
    expect(reheld.authorization?.message).toContain('2 recorded')
    await harness.ctx.missions.resume(agent, { id: reheld.id, revision: reheld.revision })
    expect(harness.ctx.missions.get(agent)?.uncertainAcknowledged).toBe(3)
  }, 120_000)

  it('keeps a cleared doubt cleared across a restart and an index rebuild', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-ack-rebuild-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('work')], { sweepOnStartup: false })
    const agent = await startMission(first)
    recordUnknownCall(agent, 'call-one')
    recordUnknownCall(agent, 'call-two')
    expect(await first.ctx.missions.sweep()).toMatchObject({ considered: 1, held: 1 })
    const held = first.ctx.missions.get(agent)!
    await first.ctx.missions.resume(agent, { id: held.id, revision: held.revision })
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    // The recovery index is gone: startup rebuilds it from the session logs, so
    // the mission arrives with no row history at all. The acknowledgement is
    // still there because it lives with the durable record.
    await rm(join(root, 'storages', 'mission_continuity'), { recursive: true, force: true })
    const second = await mount(root, [textResponse('continued'), textResponse('continued')], { sweepOnStartup: false })
    const restored = await adoptAgent(second)
    expect(second.ctx.missions.get(restored)?.uncertainAcknowledged).toBe(2)
    expect(uncertainIds(second, restored)).toEqual(['call-one', 'call-two'])
    expect(unnamed(second, restored)).toBe(0)
    // Cleared doubts do not re-block a rebuilt mission.
    expect(await second.ctx.missions.sweep()).toMatchObject({ considered: 1, resumed: 1, held: 0 })
    const [row] = await second.ctx.missions.ledger.list()
    expect(row).toMatchObject({ state: 'armed', attempts: 1 })
    expect(second.ctx.missions.get(restored)?.authorization).toBeUndefined()

    // A doubt this mission has never been acknowledged about blocks again.
    recordUnknownCall(restored, 'call-three')
    const progressed = second.ctx.missions.get(restored)!
    // Progress the mission so the next sweep is a new claim, not the one this
    // process already paid for.
    await second.ctx.missions.checkpoint(restored, { id: progressed.id, revision: progressed.revision })
    expect(await second.ctx.missions.sweep()).toMatchObject({ considered: 1, held: 1, resumed: 0 })
    expect(second.ctx.missions.get(restored)?.authorization?.code).toBe(UNCERTAIN_OPERATIONS)
  }, 120_000)
})
