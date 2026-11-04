/**
 * Mission records: durable start, bounded recovery attempts, checkpoints,
 * pending authorization, clearing, and strict replay of damaged history.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  applyMissionChange,
  decodeMissionChange,
  emptyMissionFoldState,
  MissionError,
  missionChangeRef,
} from '../src/index.ts'
import type { MissionChangeMeta, MissionSnapshot } from '../src/index.ts'
import { createAgent, mountHarness, stopHarness, tempRoot, textResponse } from './harness.ts'
import type { MissionHarness } from './harness.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Mount one composition that shares a durable root and an agent. */
async function setup(): Promise<{ harness: MissionHarness; agent: Agent }> {
  const { root, cleanup } = await tempRoot('dsh-mission-domain-')
  cleanups.push(cleanup)
  const harness = await mountHarness({ root, script: [textResponse('ok'), textResponse('ok')] })
  contexts.push(harness.ctx)
  return { harness, agent: await createAgent(harness) }
}

/** One valid durable mission record. */
function snapshot(overrides: Partial<MissionSnapshot> = {}): MissionSnapshot {
  return {
    id: 'mission-one' as MissionSnapshot['id'],
    revision: 1,
    goal: { id: 'goal-one' as MissionSnapshot['goal']['id'], revision: 1 },
    completionCriteria: ['tests pass'],
    recovery: 'enabled',
    maxRecoveryAttempts: 2,
    attempts: 0,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

/** One full-snapshot change around a record. */
function change(record: MissionSnapshot, operation: 'start' | 'checkpoint' | 'attempt' | 'authorize' | 'resume' = 'start'): MissionChangeMeta {
  return { kind: 'mission/change', version: 1, operation, mission: record }
}

describe('mission lifecycle', () => {
  it('starts a mission with its durable objective and completion criteria', async () => {
    const { harness, agent } = await setup()
    const view = await harness.ctx.missions.start(agent, {
      objective: 'ship the recovery path',
      completionCriteria: ['recovery test passes', 'docs updated'],
    })
    expect(view).toMatchObject({
      revision: 1,
      attempts: 0,
      recovery: 'enabled',
      completionCriteria: ['recovery test passes', 'docs updated'],
      settled: false,
    })
    expect(harness.ctx.goals.get(agent)?.objective).toBe('ship the recovery path')
    expect(harness.ctx.missions.get(agent)?.id).toBe(view.id)
    const rows = await harness.ctx.missions.ledger.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ missionId: view.id, state: 'armed', attempts: 0, sessionId: harness.session })
  })

  it('rejects a second mission and invalid input without writing a record', async () => {
    const { harness, agent } = await setup()
    await harness.ctx.missions.start(agent, { objective: 'first', completionCriteria: ['done'] })
    await expect(harness.ctx.missions.start(agent, { objective: 'second', completionCriteria: ['done'] }))
      .rejects.toBeInstanceOf(MissionError)
    expect(() => harness.ctx.missions.rowState(snapshot())).not.toThrow()
    await expect(harness.ctx.missions.start(agent, { objective: '   ', completionCriteria: ['done'] }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_OBJECTIVE' })
  })

  it('validates criteria, budgets, authorization, and interruption input', async () => {
    const { harness, agent } = await setup()
    const missions = harness.ctx.missions
    await expect(missions.start(agent, { objective: 'x', completionCriteria: [] }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_CRITERIA' })
    await expect(missions.start(agent, { objective: 'x', completionCriteria: ['  '] }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_CRITERIA' })
    await expect(missions.start(agent, { objective: 'x', completionCriteria: ['a'], maxRecoveryAttempts: 0 }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_ATTEMPTS' })
    await expect(missions.start(agent, { objective: 'x', completionCriteria: ['a'], maxGoalRounds: -1 }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_ATTEMPTS' })
    const view = await missions.start(agent, { objective: 'x', completionCriteria: ['a'], recovery: 'disabled' })
    expect(view.recovery).toBe('disabled')
    await expect(missions.authorize(agent, view, { code: 'Not Kebab', message: 'wait' }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_AUTHORIZATION' })
    await expect(missions.authorize(agent, view, { code: 'needs-human', message: '   ' }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_AUTHORIZATION' })
    await expect(missions.recordAttempt(agent, view, { interruption: { kind: 'unknown', at: -1 } }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_INTERRUPTION' })
    await expect(missions.recordAttempt(agent, view, { interruption: { kind: 'unknown', at: 1, detail: ' ' } }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_INTERRUPTION' })
  })

  it('records attempt budget, interruption, and checkpoint monotonically', async () => {
    const { harness, agent } = await setup()
    const missions = harness.ctx.missions
    const started = await missions.start(agent, {
      objective: 'keep going',
      completionCriteria: ['done'],
      maxRecoveryAttempts: 2,
    })
    const checkpointed = await missions.checkpoint(agent, started)
    expect(checkpointed.checkpoint?.seq).toBeGreaterThan(0)

    const attempted = await missions.recordAttempt(agent, checkpointed, {
      interruption: { kind: 'process-restart', at: 1_700_000_000_000, detail: 'process exited' },
    })
    expect(attempted.attempts).toBe(1)
    expect(attempted.interruption).toMatchObject({ kind: 'process-restart', detail: 'process exited' })
    expect(attempted.revision).toBe(3)

    await expect(missions.recordAttempt(agent, started, { interruption: { kind: 'unknown', at: 0 } }))
      .rejects.toMatchObject({ code: 'MISSION_STALE_REVISION' })
    await expect(missions.recordAttempt(agent, { id: started.id, revision: 99 }, {
      interruption: { kind: 'unknown', at: 0 },
    })).rejects.toMatchObject({ code: 'MISSION_STALE_REVISION' })
    await expect(missions.checkpoint(agent, { id: started.id, revision: 99 }))
      .rejects.toMatchObject({ code: 'MISSION_STALE_REVISION' })
    await expect(missions.checkpoint(agent, { id: 'other' as typeof started.id, revision: 1 }))
      .rejects.toMatchObject({ code: 'MISSION_NOT_FOUND' })

    const second = await missions.recordAttempt(agent, attempted, { interruption: { kind: 'unknown', at: 5 } })
    expect(second.attempts).toBe(2)
    await expect(missions.recordAttempt(agent, second, { interruption: { kind: 'unknown', at: 6 } }))
      .rejects.toMatchObject({ code: 'MISSION_INVALID_ATTEMPTS' })
    expect(harness.ctx.missions.get(agent)?.attempts).toBe(2)
  })

  it('refuses recovery attempts on a mission that does not authorize them', async () => {
    const { harness, agent } = await setup()
    const view = await harness.ctx.missions.start(agent, {
      objective: 'human only',
      completionCriteria: ['done'],
      recovery: 'disabled',
    })
    expect(harness.ctx.missions.rowState(view)).toBe('held')
    await expect(harness.ctx.missions.recordAttempt(agent, view, { interruption: { kind: 'unknown', at: 0 } }))
      .rejects.toMatchObject({ code: 'MISSION_RECOVERY_DISABLED' })
  })

  it('holds a mission while human authorization is pending and releases it on resume', async () => {
    const { harness, agent } = await setup()
    const missions = harness.ctx.missions
    const started = await missions.start(agent, { objective: 'needs approval', completionCriteria: ['done'] })
    const authorized = await missions.authorize(agent, started, {
      code: 'needs-human-approval',
      message: 'Waiting for the deployment approval.',
    })
    expect(authorized.authorization).toMatchObject({ code: 'needs-human-approval' })
    expect(missions.rowState(authorized)).toBe('held')
    expect((await missions.ledger.list())[0]?.lastError?.code).toBe('needs-human-approval')

    const resumed = await missions.resume(agent, authorized)
    expect(resumed.authorization).toBeUndefined()
    expect(missions.rowState(resumed)).toBe('armed')
    await expect(missions.resume(agent, resumed)).rejects.toMatchObject({ code: 'MISSION_INVALID_AUTHORIZATION' })
  })

  it('clears a mission with a tombstone and drops its discovery row', async () => {
    const { harness, agent } = await setup()
    const missions = harness.ctx.missions
    const started = await missions.start(agent, { objective: 'temporary', completionCriteria: ['done'] })
    const cleared = await missions.clear(agent, started)
    expect(cleared.revision).toBe(started.revision + 1)
    expect(missions.get(agent)).toBeUndefined()
    expect(await missions.ledger.list()).toHaveLength(0)
    // The linked objective survives: releasing continuity is not completing work.
    expect(harness.ctx.goals.get(agent)).toBeDefined()
  })

  it('reads uncertain operations and the plan from their durable owners', async () => {
    const { harness, agent } = await setup()
    await harness.ctx.missions.start(agent, { objective: 'plan', completionCriteria: ['done'] })
    expect(harness.ctx.missions.uncertainOperations(agent)).toEqual([])
    expect(harness.ctx.missions.plan(agent)).toEqual([])
  })

  it('rejects access for an agent another registry owns', async () => {
    const { harness, agent } = await setup()
    await harness.ctx.missions.start(agent, { objective: 'live only', completionCriteria: ['done'] })
    const { root, cleanup } = await tempRoot('dsh-mission-foreign-')
    cleanups.push(cleanup)
    const other = await mountHarness({ root, script: [] })
    contexts.push(other.ctx)
    const foreign = await createAgent(other)
    expect(() => harness.ctx.missions.get(foreign)).toThrow(MissionError)
    await expect(harness.ctx.missions.start(foreign, { objective: 'x', completionCriteria: ['y'] }))
      .rejects.toMatchObject({ code: 'MISSION_AGENT_NOT_LIVE' })
    expect(harness.ctx.missions.get(agent)?.id).toBeDefined()
  })
})

describe('strict replay', () => {
  it('folds a start, a checkpoint, attempts, and a clear', () => {
    const first = snapshot()
    let state = applyMissionChange(emptyMissionFoldState(), change(first))
    state = applyMissionChange(state, change({ ...first, revision: 2, checkpoint: { seq: 4, at: 11 } }, 'checkpoint'))
    state = applyMissionChange(state, change({
      ...first,
      revision: 3,
      attempts: 1,
      interruption: { kind: 'process-restart', at: 12 },
    }, 'attempt'))
    expect(state.mission).toMatchObject({ revision: 3, attempts: 1 })
    state = applyMissionChange(state, {
      kind: 'mission/change',
      version: 1,
      operation: 'clear',
      cleared: { id: first.id, revision: 3 },
      clearedAt: 13,
    })
    expect(state.mission).toBeUndefined()
    expect(state.lastRef).toEqual({ id: first.id, revision: 3 })
  })

  it('rejects discontinuous, impossible, or malformed history', () => {
    const first = snapshot()
    const started = applyMissionChange(emptyMissionFoldState(), change(first))
    // Revision must advance by exactly one.
    expect(() => applyMissionChange(started, change({ ...first, revision: 3 }, 'checkpoint'))).toThrow()
    // A second start while one is current is illegal.
    expect(() => applyMissionChange(started, change({ ...first, id: 'mission-two' as typeof first.id }))).toThrow()
    // Attempts must consume exactly one budget slot.
    expect(() => applyMissionChange(started, change({ ...first, revision: 2, attempts: 2 }, 'attempt'))).toThrow()
    // Attempts may never decrease.
    const attempted = applyMissionChange(started, change({ ...first, revision: 2, attempts: 1 }, 'attempt'))
    expect(() => applyMissionChange(attempted, change({ ...first, revision: 3, attempts: 0 }, 'checkpoint'))).toThrow()
    // Budget, criteria, and objective binding are fixed at start.
    expect(() => applyMissionChange(started, change({ ...first, revision: 2, maxRecoveryAttempts: 5 }, 'checkpoint'))).toThrow()
    expect(() => applyMissionChange(started, change({ ...first, revision: 2, completionCriteria: ['other'] }, 'checkpoint'))).toThrow()
    expect(() => applyMissionChange(started, change({
      ...first,
      revision: 2,
      goal: { id: 'other' as typeof first.goal.id, revision: 1 },
    }, 'checkpoint'))).toThrow()
    // A checkpoint may not move backward, and time may not move backward.
    const late = applyMissionChange(started, change({ ...first, revision: 2, checkpoint: { seq: 9, at: 11 } }, 'checkpoint'))
    expect(() => applyMissionChange(late, change({ ...first, revision: 3, checkpoint: { seq: 4, at: 12 } }, 'checkpoint'))).toThrow()
    expect(() => applyMissionChange(late, change({ ...first, revision: 3, updatedAt: 9 }, 'checkpoint'))).toThrow()
    expect(() => applyMissionChange(late, change({ ...first, revision: 3, createdAt: 11 }, 'checkpoint'))).toThrow()
    expect(() => applyMissionChange(late, change({ ...first, revision: 3, id: 'other' as typeof first.id }, 'checkpoint'))).toThrow()
    // A reused identity after a clear is illegal.
    const cleared = applyMissionChange(late, {
      kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: first.id, revision: 2 }, clearedAt: 20,
    })
    expect(() => applyMissionChange(cleared, change(first))).toThrow()
    // A clear needs a current mission and the exact revision.
    expect(() => applyMissionChange(cleared, {
      kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: first.id, revision: 2 }, clearedAt: 21,
    })).toThrow()
    expect(() => applyMissionChange(started, {
      kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: first.id, revision: 5 }, clearedAt: 21,
    })).toThrow()
  })

  it('decodes only canonical durable payloads', () => {
    const valid = change(snapshot())
    expect(decodeMissionChange(valid)).toEqual(valid)
    expect(missionChangeRef(valid)).toEqual({ id: 'mission-one', revision: 1 })
    const malformed: unknown[] = [
      null,
      [],
      { ...valid, kind: 'goal/change' },
      { ...valid, version: 2 },
      { ...valid, operation: 'unknown' },
      { ...valid, extra: true },
      { ...valid, mission: null },
      { ...valid, mission: { ...snapshot(), extra: 1 } },
      { ...valid, mission: { ...snapshot(), revision: 0 } },
      { ...valid, mission: { ...snapshot(), attempts: 3 } },
      { ...valid, mission: { ...snapshot(), recovery: 'sometimes' } },
      { ...valid, mission: { ...snapshot(), completionCriteria: [] } },
      { ...valid, mission: { ...snapshot(), completionCriteria: [''] } },
      { ...valid, mission: { ...snapshot(), updatedAt: 1 } },
      { ...valid, mission: { ...snapshot(), interruption: { kind: 'mystery', at: 1 } } },
      { ...valid, mission: { ...snapshot(), interruption: { kind: 'unknown', at: 1, detail: '' } } },
      { ...valid, mission: { ...snapshot(), interruption: { kind: 'unknown', at: 1, extra: 1 } } },
      { ...valid, mission: { ...snapshot(), checkpoint: { seq: -1, at: 1 } } },
      { ...valid, mission: { ...snapshot(), authorization: { code: 'Bad Code', message: 'x' } } },
      { ...valid, mission: { ...snapshot(), authorization: { code: 'ok', message: '' } } },
      { ...valid, mission: { ...snapshot(), goal: { id: 'g', revision: 0 } } },
      { ...valid, mission: { ...snapshot(), goal: null } },
      { ...valid, mission: { ...snapshot(), id: '  ' } },
      {
        kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: 'mission-one', revision: 1 }, clearedAt: 1,
      },
    ]
    for (const value of malformed.slice(0, -1)) {
      expect(() => decodeMissionChange(value)).toThrow()
    }
    expect(decodeMissionChange(malformed.at(-1))).toMatchObject({ operation: 'clear' })
    expect(() => decodeMissionChange({
      kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: 'mission-one' }, clearedAt: 1,
    })).toThrow()
    expect(() => decodeMissionChange({
      kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: 'm', revision: 1 }, clearedAt: -1,
    })).toThrow()
  })
})

describe('projection', () => {
  it('exposes the durable record and null before start and after clear', async () => {
    const { harness, agent } = await setup()
    expect(harness.ctx.sessionProjections.stateOf(agent.session, 'mission')?.current).toBeNull()
    await harness.ctx.missions.start(agent, { objective: 'projected', completionCriteria: ['done'] })
    const snapshotValue = harness.ctx.sessionProjections.snapshot(agent.session)
    expect(snapshotValue.values['mission']).toMatchObject({ completionCriteria: ['done'], revision: 1 })
    const view = harness.ctx.missions.get(agent)!
    await harness.ctx.missions.clear(agent, view)
    expect(harness.ctx.sessionProjections.snapshot(agent.session).values['mission']).toBeNull()
  })

  it('keeps a strict replay failure instead of exposing a partial record', async () => {
    const { harness, agent } = await setup()
    const started = await harness.ctx.missions.start(agent, { objective: 'damaged', completionCriteria: ['done'] })
    const { settled: _settled, ...record } = started
    agent.session.append('mission/change', {
      kind: 'mission/change',
      version: 1,
      operation: 'attempt',
      mission: { ...record, revision: 7, attempts: 1 },
    })
    const state = harness.ctx.sessionProjections.stateOf(agent.session, 'mission')
    expect(state?.failure).toContain('revision')
    expect(() => harness.ctx.missions.get(agent)).toThrow(/strict replay/)
  })
})

describe('foreign agent identity', () => {
  it('refuses a mission start for an agent the registry does not own', async () => {
    const { harness, agent } = await setup()
    const { root, cleanup } = await tempRoot('dsh-mission-shadow-')
    cleanups.push(cleanup)
    const other = await mountHarness({ root, script: [] })
    contexts.push(other.ctx)
    const foreign = await createAgent(other)
    expect(foreign.session).not.toBe(agent.session)
    await expect(harness.ctx.missions.start(foreign, { objective: 'x', completionCriteria: ['y'] }))
      .rejects.toMatchObject({ code: 'MISSION_AGENT_NOT_LIVE' })
    expect(harness.ctx.missions.get(agent)).toBeUndefined()
  })
})
