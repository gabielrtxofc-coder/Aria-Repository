/**
 * What the pending-call tracker may and may not claim about a wide fan-out.
 *
 * One step can dispatch far more tool calls than the bounded tracking window
 * holds. Calls the window had to drop are still *open*, which is not the same
 * fact as "its result says the outcome is unknown": a call whose result became
 * durable settled, whoever was tracking it. These specs drive the real
 * production loop at 10, 30, and 40 simultaneous calls — the widths a deployment
 * configures — and pin both directions: a successful call never becomes a doubt,
 * and a genuinely unknown outcome is never lost because the window was full.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, ToolCallId, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { missionProjectionDefinition } from '../src/index.ts'
import type { MissionProjectionState, MissionSnapshot } from '../src/index.ts'
import { UNCERTAIN_OPERATIONS } from '../src/runtime.ts'
import {
  createAgent,
  mountHarness,
  tempRoot,
  textResponse,
  waitFor,
} from './harness.ts'
import type { MissionHarness } from './harness.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** The tool the fan-out steps dispatch. */
const FAN_TOOL = 'external_effect'

/** One tool call event. */
function callEvent(callId: string, seq: number): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time: 1,
    data: { turn: 1, step: 1, callId: ToolCallId(callId), name: FAN_TOOL, arguments: '{}' },
  } as SessionEvent
}

/** One tool result event, optionally reporting an unknown outcome. */
function resultEvent(callId: string, seq: number, unknownOutcome: boolean): SessionEvent {
  const message = createToolResultMessage({
    callId: ToolCallId(callId),
    content: [{ type: 'text', text: unknownOutcome ? 'the tool did not report back' : 'done' }],
    isError: unknownOutcome,
  })
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: 1,
    data: {
      turn: 1, step: 1, message,
      ...unknownOutcome ? { error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN } } : {},
    },
  } as SessionEvent
}

/** Replay a list of events through the projection unit. */
function replay(events: readonly SessionEvent[]): MissionProjectionState {
  return events.reduce<MissionProjectionState>(
    (state, event) => missionProjectionDefinition.apply(state, event),
    missionProjectionDefinition.init(),
  )
}

/** One committed mission start, in the shape the durable log records it. */
function startEvent(seq: number): SessionEvent {
  const mission: MissionSnapshot = {
    id: 'mission-one' as MissionSnapshot['id'],
    revision: 1,
    goal: { id: 'goal-one' as MissionSnapshot['goal']['id'], revision: 1 },
    completionCriteria: ['tests hold'],
    recovery: 'enabled',
    maxRecoveryAttempts: 3,
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    type: 'mission/change',
    seq: SessionSeq(seq),
    time: 1,
    data: { kind: 'mission/change', version: 1, operation: 'start', mission },
  } as SessionEvent
}

/** How many doubts the folded state reports, named or not. */
function doubtCount(state: MissionProjectionState): number {
  return state.uncertainOperations.length + (state.uncertainOverflow ?? 0)
}

/** One assistant answer requesting `count` parallel calls of the fan-out tool. */
function fanOutResponse(count: number): StreamChunk[] {
  const chunks: StreamChunk[] = []
  for (let index = 0; index < count; index += 1) {
    const callId = `call-${index}`
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call', id: ToolCallId(callId), name: FAN_TOOL, arguments: JSON.stringify({ id: callId }),
        },
      },
    )
  }
  chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  return chunks
}

/** A parallel-safe tool whose every body waits until the test releases it. */
function gatedTool(failing: ReadonlySet<number>): {
  readonly tool: ReturnType<typeof defineContentToolFixture>
  readonly started: string[]
  releaseAll: () => void
} {
  const gates = new Map<string, () => void>()
  const started: string[] = []
  const tool = defineContentToolFixture({
    name: FAN_TOOL,
    description: 'one simulated external effect',
    parameters: { id: { type: 'string', required: true } },
    isConcurrencySafe: () => true,
    async execute(args) {
      started.push(args.id)
      // Every body holds, so the step records all its calls before any result —
      // the order that used to push open calls out of the tracking window.
      await new Promise<void>(resolve => { gates.set(args.id, resolve) })
      if (failing.has(Number.parseInt(args.id.slice('call-'.length), 10))) {
        throw new HarnessError('the effect may or may not have landed', TOOL_OUTCOME_UNKNOWN)
      }
      return [{ type: 'text', text: `done-${args.id}` }]
    },
  })
  return {
    tool,
    started,
    releaseAll() {
      for (const [, release] of [...gates]) release()
      gates.clear()
    },
  }
}

/** The live mission projection state of one composition. */
function projection(harness: MissionHarness, agent: Agent): MissionProjectionState {
  const state = harness.ctx.sessionProjections.stateOf(agent.session, 'mission')
  if (state === undefined) throw new Error('mission projection is not registered')
  return state
}

/**
 * Run one real turn whose model answer fans out into `count` parallel tool
 * calls, and let every call reach a committed result — the successful shape, or
 * the shape where the ids named by `failing` report an unknown outcome.
 * @param count - how many calls the step dispatches at once.
 * @param failing - call indices whose tool body reports an unknown outcome.
 * @returns the mounted composition, its live agent, and the fan-out gate.
 */
async function runFanOut(count: number, failing: ReadonlySet<number> = new Set()): Promise<{
  harness: MissionHarness
  agent: Agent
}> {
  const { root, cleanup } = await tempRoot('dsh-mission-wide-step-')
  cleanups.push(cleanup)
  const harness = await mountHarness({
    root,
    driver: true,
    maxParallelToolCalls: count,
    script: [fanOutResponse(count), ...Array.from({ length: 5 }, () => textResponse('settled'))],
    config: { sweepOnStartup: false },
  })
  contexts.push(harness.ctx)
  const gate = gatedTool(failing)
  harness.ctx.tools.register(gate.tool)
  const agent = await createAgent(harness)
  await harness.ctx.missions.start(agent, {
    objective: 'apply the fan-out migration',
    completionCriteria: ['every recorded call has a settled outcome'],
    maxRecoveryAttempts: 3,
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fan out' }], source: { kind: 'user' } }))
  await waitFor(() => gate.started.length === count, 30_000)
  gate.releaseAll()
  // Every result is durable once the window holds no open call at all.
  await waitFor(() => projection(harness, agent).pendingCalls.length === 0, 30_000)
  await waitFor(() => agent.status !== 'running', 30_000)
  return { harness, agent }
}

describe('wide fan-out of successful calls', () => {
  /**
   * Reproduced defect (L-1): a call the bounded window dropped became a doubt
   * the moment it was displaced, and its later successful result — matching
   * nothing — could not take that doubt back. Every width above the window used
   * to invent doubts for calls that had all succeeded.
   */
  it.each([10, 30, 40])('leaves no doubt behind a step of %i successful calls', async (count) => {
    const { harness, agent } = await runFanOut(count)
    const state = projection(harness, agent)
    expect(state.pendingCalls).toEqual([])
    expect(harness.ctx.missions.uncertainOperations(agent)).toEqual([])
    expect(harness.ctx.missions.uncertainOverflow(agent)).toBe(0)
    // No phantom hold either: a sweep finds nothing to ask a human about.
    expect(await harness.ctx.missions.sweep()).toMatchObject({ considered: 1, resumed: 1, held: 0 })
    expect(harness.ctx.missions.get(agent)?.authorization).toBeUndefined()
  }, 120_000)

  it('settles a displaced call when its result arrives, whatever the order', () => {
    // The worst shape for a bounded window: the whole fan-out is recorded first,
    // so every early call leaves the window while it is still open.
    const calls = Array.from({ length: 40 }, (_value, index) => callEvent(`call-${index}`, index))
    const results = Array.from({ length: 40 }, (_value, index) => resultEvent(`call-${index}`, 100 + index, false))
    const state = replay([...calls, ...results])
    expect(state.pendingCalls).toEqual([])
    expect(state.uncertainOperations).toEqual([])
    expect(doubtCount(state)).toBe(0)
    // The same step committed in model order, call after call, is the shape a
    // narrow pool produces: still nothing doubtful.
    const interleaved = Array.from({ length: 40 }, (_value, index) => [
      callEvent(`call-${index}`, index * 2),
      resultEvent(`call-${index}`, index * 2 + 1, false),
    ]).flat()
    expect(doubtCount(replay(interleaved))).toBe(0)
    expect(replay(interleaved).pendingCalls).toEqual([])
  })

  it('reports a doubt only for calls whose result says the outcome is unknown', () => {
    const failures = new Set([24, 25, 31, 39])
    const events: SessionEvent[] = []
    for (let index = 0; index < 40; index += 1) events.push(callEvent(`call-${index}`, index))
    for (let index = 0; index < 40; index += 1) {
      events.push(resultEvent(`call-${index}`, 100 + index, failures.has(index)))
    }
    const state = replay(events)
    expect(state.uncertainOperations.map(operation => operation.callId).sort()).toEqual(
      [...failures].map(index => `call-${index}`).sort(),
    )
    expect(doubtCount(state)).toBe(failures.size)
  })

  it('keeps counting doubts the bounded window cannot name', () => {
    // Unknown outcomes for the calls the window dropped: nothing may be lost
    // just because no slot remained to name them.
    const events: SessionEvent[] = []
    for (let index = 0; index < 40; index += 1) events.push(callEvent(`call-${index}`, index))
    for (let index = 0; index < 40; index += 1) {
      events.push(resultEvent(`call-${index}`, 100 + index, index < 18))
    }
    const state = replay(events)
    expect(doubtCount(state)).toBe(18)
    expect(state.uncertainOperations).toHaveLength(0)
    expect(state.uncertainOverflow).toBe(18)
    // A successful call never becomes a doubt, so the rest of the step is clean.
    expect(state.pendingCalls).toEqual([])
  })

  it('carries the counted state across a mission change', () => {
    // A mission mutation committed while a wide step is still open must not
    // restart the accounting: the calls displaced from the window are open facts,
    // and so is every doubt already recorded.
    const calls = Array.from({ length: 26 }, (_value, index) => callEvent(`call-${index}`, index))
    const midway = replay([...calls, startEvent(100)])
    expect(midway.pendingCalls).toHaveLength(22)
    expect(midway.pendingOverflow).toBe(4)
    expect(midway.uncertainOverflow).toBeUndefined()
    // The results arrive: the first four belong to calls the window had dropped.
    const results = Array.from({ length: 26 }, (_value, index) => resultEvent(`call-${index}`, 200 + index, index < 4))
    const settled = replay([...calls, startEvent(100), ...results])
    expect(settled.pendingCalls).toEqual([])
    expect(settled.pendingOverflow).toBeUndefined()
    expect(settled.uncertainOperations).toEqual([])
    expect(settled.uncertainOverflow).toBe(4)
    expect(doubtCount(settled)).toBe(4)
  })

  it('reads a result for an identity nobody recorded as what it is', () => {
    // The counted-open total is only ever released by a result that answers a
    // displaced call. A result for an identity this projection never counted
    // settles nothing - and a session log that recorded one without advertising
    // the call is rejected as corrupt by the store, so nothing is being hidden.
    const definite = replay([startEvent(0), resultEvent('call-ghost', 1, false)])
    expect(definite.current?.id).toBe('mission-one')
    expect(definite.pendingOverflow).toBeUndefined()
    expect(doubtCount(definite)).toBe(0)
    // The same holds for an unknown outcome: no doubt is manufactured out of an
    // identity the log never advertised, and no counted call is released.
    const unknown = replay([startEvent(0), resultEvent('call-ghost', 1, true)])
    expect(doubtCount(unknown)).toBe(0)
    expect(unknown.pendingOverflow).toBeUndefined()
  })

  it('never retracts a recorded unknown outcome with a later result', () => {
    const state = replay([callEvent('call-1', 0), resultEvent('call-1', 1, true)])
    expect(state.uncertainOperations).toEqual([{ callId: 'call-1', name: FAN_TOOL }])
    // A second, definite result for the same identity does not make the doubt
    // disappear: the recorded unknown outcome stays a fact of the log.
    const after = missionProjectionDefinition.apply(state, resultEvent('call-1', 2, false))
    expect(after.uncertainOperations).toEqual([{ callId: 'call-1', name: FAN_TOOL }])
  })
})

describe('wide fan-out with real failures', () => {
  it('identifies every uncertain call and blocks recovery until each is acknowledged', async () => {
    const failing = new Set([30, 31, 32, 33])
    const { harness, agent } = await runFanOut(40, failing)
    const missions = harness.ctx.missions
    // The four calls that reported an unknown outcome are all accounted for, and
    // none of the 36 successful ones joined them.
    expect(missions.uncertainOperations(agent).map(operation => operation.callId).sort())
      .toEqual([...failing].map(index => `call-${index}`).sort())
    expect(missions.uncertainOverflow(agent)).toBe(0)

    // Not one of them crosses recovery unacknowledged.
    expect(await missions.sweep()).toMatchObject({ considered: 1, held: 1, resumed: 0 })
    const held = missions.get(agent)!
    expect(held.authorization?.code).toBe(UNCERTAIN_OPERATIONS)
    expect(held.authorization?.message).toContain('4 recorded')
    expect(held.attempts).toBe(0)
    const [row] = await missions.ledger.list()
    expect(row.state).toBe('held')
    expect(row.lastError?.code).toBe(UNCERTAIN_OPERATIONS)

    // The human reviews those four; the mission continues, and only the doubts
    // the review covered are cleared.
    await missions.resume(agent, { id: held.id, revision: held.revision })
    expect(missions.get(agent)?.uncertainAcknowledged).toBe(4)
    expect(await missions.sweep()).toMatchObject({ considered: 1, resumed: 1, held: 0 })
    expect(missions.get(agent)?.authorization).toBeUndefined()
  }, 120_000)

  it('holds a mission whose uncertain outcomes are too many for the window to name', async () => {
    // Failures on the calls the window had to drop: they cannot be named, so the
    // count is what keeps them in front of the human.
    const failing = new Set([0, 1, 2, 3, 4, 5, 6, 7])
    const { harness, agent } = await runFanOut(40, failing)
    const missions = harness.ctx.missions
    expect(missions.uncertainOperations(agent)).toHaveLength(0)
    expect(missions.uncertainOverflow(agent)).toBe(8)
    expect(await missions.sweep()).toMatchObject({ considered: 1, held: 1, resumed: 0 })
    const held = missions.get(agent)!
    expect(held.authorization?.code).toBe(UNCERTAIN_OPERATIONS)
    expect(held.authorization?.message).toContain('8 recorded')
    await missions.resume(agent, { id: held.id, revision: held.revision })
    expect(missions.get(agent)?.uncertainAcknowledged).toBe(8)
    expect(await missions.sweep()).toMatchObject({ considered: 1, resumed: 1 })
  }, 120_000)
})
