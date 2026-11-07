/**
 * The `mission` projection is the replay authority: it folds durable changes
 * strictly, tracks calls whose committed outcome is unknown, and keeps a
 * replay failure instead of exposing a partly interpreted mission.
 */

import { describe, expect, it } from 'vitest'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import { missionProjectionDefinition } from '../src/index.ts'
import type { MissionChangeMeta, MissionProjectionState, MissionSnapshot } from '../src/index.ts'

/** One valid durable mission record. */
function snapshot(overrides: Partial<MissionSnapshot> = {}): MissionSnapshot {
  return {
    id: 'mission-one' as MissionSnapshot['id'],
    revision: 1,
    goal: { id: 'goal-one' as MissionSnapshot['goal']['id'], revision: 1 },
    completionCriteria: ['tests hold'],
    recovery: 'enabled',
    maxRecoveryAttempts: 3,
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/** One `mission/change` session event around a record. */
function changeEvent(record: MissionSnapshot, seq = 0): SessionEvent {
  const data: MissionChangeMeta = { kind: 'mission/change', version: 1, operation: 'start', mission: record }
  return { type: 'mission/change', seq, time: 1, data } as SessionEvent
}

/** One tool call event. */
function callEvent(callId: string, seq: number): SessionEvent {
  return {
    type: 'tool/call',
    seq: SessionSeq(seq),
    time: 1,
    data: { turn: 1, step: 1, callId: ToolCallId(callId), name: 'bash', arguments: '{}' },
  } as SessionEvent
}

/** One tool result event for a call, optionally carrying the unknown-outcome code. */
function resultEvent(callId: string, seq: number, code?: string): SessionEvent {
  const message = createToolResultMessage({
    callId: ToolCallId(callId),
    content: [{ type: 'text', text: 'done' }],
    isError: code !== undefined,
  })
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: 1,
    data: {
      turn: 1,
      step: 1,
      message,
      ...code === undefined ? {} : { error: { name: 'unknown-outcome', code } },
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

describe('mission projection unit', () => {
  it('starts empty and exposes no mission view', () => {
    const state = missionProjectionDefinition.init()
    expect(state).toEqual({
      current: null,
      seenMissionIds: [],
      failure: null,
      pendingCalls: [],
      uncertainOperations: [],
    })
    expect(missionProjectionDefinition.wire.view(state)).toBeNull()
  })

  it('folds a durable change and exposes it as the view', () => {
    const record = snapshot()
    const state = replay([changeEvent(record)])
    expect(state.current).toEqual(record)
    expect(state.seenMissionIds).toEqual([record.id])
    expect(missionProjectionDefinition.wire.view(state)).toEqual(record)
  })

  it('keeps a replay failure and refuses later changes instead of recovering silently', () => {
    const damaged = changeEvent(snapshot({ revision: 4 }))
    const failed = replay([damaged])
    expect(failed.failure).toBeTruthy()
    expect(failed.current).toBeNull()
    // A later valid change cannot repair the projection inside one replay.
    const after = missionProjectionDefinition.apply(failed, changeEvent(snapshot()))
    expect(after).toBe(failed)
  })

  it('reports a clear tombstone as a settled projection', () => {
    const record = snapshot()
    const cleared = replay([
      changeEvent(record),
      {
        type: 'mission/change',
        seq: 1,
        time: 2,
        data: { kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: record.id, revision: 1 }, clearedAt: 2 },
      } as SessionEvent,
    ])
    expect(cleared.current).toBeNull()
    expect(cleared.seenMissionIds).toEqual([record.id])
  })

  it('tracks a call until its committed result arrives', () => {
    const pending = replay([callEvent('call-1', 0)])
    expect(pending.pendingCalls).toEqual([{ callId: 'call-1', name: 'bash' }])
    // Repeating the same call identity does not duplicate it.
    expect(missionProjectionDefinition.apply(pending, callEvent('call-1', 1)).pendingCalls)
      .toEqual([{ callId: 'call-1', name: 'bash' }])
    const settled = missionProjectionDefinition.apply(pending, resultEvent('call-1', 2))
    expect(settled.pendingCalls).toEqual([])
    expect(settled.uncertainOperations).toEqual([])
  })

  it('records a call whose committed outcome is unknown and never re-executes it', () => {
    const state = replay([callEvent('call-1', 0), resultEvent('call-1', 1, TOOL_OUTCOME_UNKNOWN)])
    expect(state.pendingCalls).toEqual([])
    expect(state.uncertainOperations).toEqual([{ callId: 'call-1', name: 'bash' }])
    // A repeated call with a known-outcome result after uncertainty is a no-op
    // for the uncertain list: the record is append-only for that identity.
    expect(missionProjectionDefinition.apply(state, callEvent('call-1', 2))).toBe(state)
  })

  it('ignores a result whose call was never observed', () => {
    const state = replay([resultEvent('call-missing', 0)])
    expect(state.pendingCalls).toEqual([])
    expect(state.uncertainOperations).toEqual([])
  })

  it('bounds the tracked calls so a long session cannot grow without limit', () => {
    const events = Array.from({ length: 40 }, (_value, index) => callEvent(`call-${index}`, index))
    const state = replay(events)
    // Bounded, and the newest calls are the ones kept.
    expect(state.pendingCalls).toHaveLength(22)
    expect(state.pendingCalls[0]?.callId).toBe('call-18')
    expect(state.pendingCalls.at(-1)?.callId).toBe('call-39')
  })

  /**
   * Regression (preexisting): the pending tracker held fewer calls than one
   * step can dispatch, so a wide fan-out silently pushed still-open calls out
   * of the window. Their `TOOL_OUTCOME_UNKNOWN` results then matched nothing and
   * recovery resumed the mission past a call whose external effect nobody had
   * confirmed. A whole step's fan-out must be tracked.
   */
  it('tracks one full parallel step and reports every unknown outcome', () => {
    const calls = Array.from({ length: 10 }, (_value, index) => callEvent(`call-${index}`, index))
    const results = Array.from({ length: 10 }, (_value, index) =>
      resultEvent(`call-${index}`, 100 + index, TOOL_OUTCOME_UNKNOWN))
    const state = replay([...calls, ...results])
    expect(state.pendingCalls).toHaveLength(0)
    expect(state.uncertainOperations).toHaveLength(10)
    expect(state.uncertainOverflow).toBeUndefined()
  })

  it('counts unknown outcomes it cannot list instead of forgetting them', () => {
    const calls = Array.from({ length: 30 }, (_value, index) => callEvent(`call-${index}`, index))
    const results = Array.from({ length: 30 }, (_value, index) =>
      resultEvent(`call-${index}`, 100 + index, TOOL_OUTCOME_UNKNOWN))
    const state = replay([...calls, ...results])
    expect(state.uncertainOperations).toHaveLength(22)
    // Eight recorded doubts could not be listed; the count keeps them visible.
    expect(state.uncertainOverflow).toBe(8)
  })

  it('leaves unrelated events untouched', () => {
    const state = missionProjectionDefinition.init()
    expect(missionProjectionDefinition.apply(state, {
      type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 },
    })).toBe(state)
  })
})
