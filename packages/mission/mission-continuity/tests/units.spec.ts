/**
 * Unit contracts of the pure pieces: strict durable decoding, the bounded
 * discovery ledger, and the recovery notice the model reads.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  applyMissionChange,
  decodeMissionChange,
  emptyMissionFoldState,
  foldMission,
  MAX_DIAGNOSTIC_LENGTH,
  recordedUncertainty,
  renderMissionRecoveryNotice,
  unacknowledgedUncertainty,
} from '../src/index.ts'
import type {
  MissionChangeMeta,
  MissionSnapshot,
  RecoveryNoticeStep,
  UncertainOperation,
} from '../src/index.ts'

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

/** One `mission/change` payload. */
function change(record: MissionSnapshot, operation: MissionChangeMeta['operation'] = 'start'): MissionChangeMeta {
  return { kind: 'mission/change', version: 1, operation, mission: record }
}

/** The text of a rendered notice. */
function noticeText(...args: Parameters<typeof renderMissionRecoveryNotice>): string {
  const blocks = renderMissionRecoveryNotice(...args)
  return blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
}

/** One named doubt, for the backlog arithmetic below. */
function doubt(index: number): UncertainOperation {
  return { callId: `call-${index}`, name: 'external_effect' }
}

describe('uncertainty backlog', () => {
  it('keeps exactly what the last human review did not cover', () => {
    expect(unacknowledgedUncertainty([], 0, undefined)).toMatchObject({ operations: [], unlisted: 0, count: 0 })
    // Two doubts and a review that covered only the first: the later one stays outstanding.
    expect(unacknowledgedUncertainty([doubt(0), doubt(1)], 0, 1)).toMatchObject({
      operations: [{ callId: 'call-1', name: 'external_effect' }],
      unlisted: 0,
      count: 1,
    })
    // Doubts the bounded window could not name stay in the count, and are reported
    // as unlisted rather than quietly dropped.
    const named = Array.from({ length: 22 }, (_value, index) => doubt(index))
    const backlog = unacknowledgedUncertainty(named, 4, 3)
    expect(backlog.count).toBe(23)
    expect(backlog.operations).toHaveLength(22)
    expect(backlog.unlisted).toBe(1)
    expect(recordedUncertainty(named, 4)).toBe(26)
    // A review covering every recorded doubt empties the backlog; a mark that does
    // not correspond to a recorded doubt clears nothing at all.
    expect(unacknowledgedUncertainty([doubt(0), doubt(1)], 4, 6))
      .toMatchObject({ operations: [], unlisted: 0, count: 0 })
    expect(unacknowledgedUncertainty([doubt(0), doubt(1)], 0, 5)).toMatchObject({ count: 2, unlisted: 0 })
    expect(unacknowledgedUncertainty([doubt(0), doubt(1)], 0, -1)).toMatchObject({ count: 2 })
  })
})

describe('strict durable decoding', () => {
  const malformed: unknown[] = [
    { ...change(snapshot()), mission: { ...snapshot(), goal: null } },
    { ...change(snapshot()), mission: { ...snapshot(), goal: { id: 'goal-one' } } },
    { ...change(snapshot()), mission: { ...snapshot(), goal: { id: 'goal-one', revision: 1, extra: true } } },
    { ...change(snapshot()), mission: { ...snapshot(), goal: { id: '   ', revision: 1 } } },
    { ...change(snapshot()), mission: { ...snapshot(), completionCriteria: 'one' } },
    { ...change(snapshot()), mission: { ...snapshot(), completionCriteria: ['x'.repeat(2_001)] } },
    { ...change(snapshot()), mission: { ...snapshot(), interruption: 'restart' } },
    { ...change(snapshot()), mission: { ...snapshot(), interruption: { kind: 'process-restart', at: 1, detail: null } } },
    { ...change(snapshot()), mission: { ...snapshot(), interruption: { kind: 'process-restart', at: 1, detail: '' } } },
    { ...change(snapshot()), mission: { ...snapshot(), interruption: { kind: 'process-restart', at: 1.5 } } },
    { ...change(snapshot()), mission: { ...snapshot(), checkpoint: 'now' } },
    { ...change(snapshot()), mission: { ...snapshot(), checkpoint: { seq: 1 } } },
    { ...change(snapshot()), mission: { ...snapshot(), checkpoint: { seq: 1, at: 1, extra: 1 } } },
    { ...change(snapshot()), mission: { ...snapshot(), authorization: 'wait' } },
    { ...change(snapshot()), mission: { ...snapshot(), authorization: { code: 'needs-human' } } },
    { ...change(snapshot()), mission: { ...snapshot(), authorization: { code: 'Needs-Human', message: 'x' } } },
    { ...change(snapshot()), mission: { ...snapshot(), authorization: { code: 'needs-human', message: '  ' } } },
    { ...change(snapshot()), mission: { ...snapshot(), id: '' } },
    { ...change(snapshot()), mission: { ...snapshot(), id: 'x'.repeat(201) } },
    { ...change(snapshot()), mission: { ...snapshot(), revision: 1.5 } },
    { ...change(snapshot()), mission: { ...snapshot(), recovery: 'maybe' } },
    { ...change(snapshot()), mission: { ...snapshot(), maxRecoveryAttempts: 0 } },
    { ...change(snapshot()), mission: { ...snapshot(), uncertainAcknowledged: 'three' } },
    { ...change(snapshot()), mission: { ...snapshot(), uncertainAcknowledged: 1.5 } },
    { ...change(snapshot()), mission: { ...snapshot(), uncertainAcknowledged: -1 } },
    { ...change(snapshot()), mission: { ...snapshot(), createdAt: -1 } },
    { kind: 'mission/change', version: 1, operation: 'clear', cleared: 'mission-one', clearedAt: 1 },
    { kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: 'mission-one', revision: 1 }, clearedAt: 1, extra: true },
    { kind: 'mission/change', version: 1, operation: 'clear', cleared: { id: 'mission-one', revision: 1 }, clearedAt: 1.5 },
  ]

  it('rejects every malformed durable payload', () => {
    for (const value of malformed) expect(() => decodeMissionChange(value)).toThrow()
  })

  it('folds a session log while ignoring unrelated events', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'mission/change', seq: SessionSeq(1), time: 1, data: change(snapshot()) },
      { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const state = foldMission(events)
    expect(state.mission).toMatchObject({ id: 'mission-one', revision: 1 })
    expect(foldMission([]).mission).toBeUndefined()
  })

  it('refuses a committed change that cannot follow the accumulated state', () => {
    const first = snapshot()
    const started = applyMissionChange(emptyMissionFoldState(), change(first))
    // A checkpoint that moves backward is impossible.
    const late = applyMissionChange(started, change({ ...first, revision: 2, checkpoint: { seq: 9, at: 2 } }, 'checkpoint'))
    expect(() => applyMissionChange(late, change({ ...first, revision: 3, checkpoint: { seq: 4, at: 3 } }, 'checkpoint')))
      .toThrow()
    // A first checkpoint after one without a previous checkpoint is fine.
    expect(applyMissionChange(started, change({ ...first, revision: 2, checkpoint: { seq: 1, at: 2 } }, 'checkpoint')))
      .toMatchObject({ mission: { revision: 2 } })
    // A mutation can never introduce a mission that was never started.
    expect(() => applyMissionChange(emptyMissionFoldState(),
      change({ ...first, revision: 2, checkpoint: { seq: 1, at: 2 } }, 'checkpoint')))
      .toThrow('mission checkpoint requires a current mission')
  })

  it('refuses a mutation that narrows a recorded uncertainty review', () => {
    const first = snapshot()
    const started = applyMissionChange(emptyMissionFoldState(), change(first))
    const reviewed = applyMissionChange(started, change({ ...first, revision: 2, uncertainAcknowledged: 3 }, 'resume'))
    expect(reviewed.mission?.uncertainAcknowledged).toBe(3)
    // A later review covering less than an earlier one would return cleared doubts
    // to the backlog without anybody noticing.
    expect(() => applyMissionChange(reviewed,
      change({ ...first, revision: 3, uncertainAcknowledged: 2 }, 'checkpoint')))
      .toThrow('mission uncertainty acknowledgement cannot shrink')
    // Losing the field reads as "nothing was ever reviewed" - the same silent
    // reversal, refused for the same reason.
    expect(() => applyMissionChange(reviewed, change({ ...first, revision: 3 }, 'checkpoint')))
      .toThrow('mission uncertainty acknowledgement cannot shrink')
    // Widening the review is the only direction the mark can move, and a mission
    // that never had one keeps none.
    expect(applyMissionChange(reviewed, change({ ...first, revision: 3, uncertainAcknowledged: 5 }, 'resume')))
      .toMatchObject({ mission: { uncertainAcknowledged: 5 } })
    expect(applyMissionChange(started, change({ ...first, revision: 2 }, 'checkpoint')))
      .toMatchObject({ mission: { revision: 2 } })
    expect(decodeMissionChange(change({ ...first, uncertainAcknowledged: 2 })).mission.uncertainAcknowledged).toBe(2)
  })
})

describe('bounded discovery ledger', () => {
  it('refuses a diagnostic code that would not round-trip', async () => {
    const { assertPolicyCode } = await import('../src/ledger.ts')
    expect(assertPolicyCode('needs-human')).toBe('needs-human')
    expect(() => assertPolicyCode('Needs Human')).toThrow()
  })
})

describe('recovery notice', () => {
  const steps: RecoveryNoticeStep[] = [
    { content: 'read the log', status: 'completed' },
    { content: 'write the fix', status: 'in_progress' },
    { content: 'run the tests', status: 'pending' },
  ]

  const operations: UncertainOperation[] = [
    { callId: 'call-1', name: 'bash' },
  ]

  it('renders the objective, criteria, plan, checkpoint, and uncertainty', () => {
    const text = noticeText({
      mission: {
        ...snapshot({ revision: 2, attempts: 1 }),
        checkpoint: { seq: 4, at: 5 },
        interruption: { kind: 'process-restart', at: 1_700_000_000_000, detail: 'process exited' },
      },
      objective: 'ship it',
      attempt: 1,
      steps,
      uncertainOperations: operations,
    })
    expect(text).toContain('<mission_recovery mission="mission-one" attempt="1/3">')
    expect(text).toContain('Objective (revision 1): "ship it"')
    expect(text).toContain('1. tests hold')
    expect(text).toContain('- [done] read the log')
    expect(text).toContain('- [now] write the fix')
    expect(text).toContain('- [pending] run the tests')
    expect(text).toContain('Last consistent checkpoint: session event 4.')
    expect(text).toContain('Interruption being recovered: process-restart')
    expect(text).toContain('Detail: process exited')
    expect(text).toContain('- bash (call-1)')
    expect(text).toContain('retry only when the operation is read-only or idempotent.')
  })

  it('omits optional sections and bounds long lists', () => {
    const bare = noticeText({
      mission: snapshot({ revision: 2, attempts: 1 }),
      objective: 'quiet mission',
      attempt: 1,
      steps: [],
      uncertainOperations: [],
    })
    expect(bare).not.toContain('Current plan:')
    expect(bare).not.toContain('Last consistent checkpoint')
    expect(bare).not.toContain('Interruption being recovered')
    expect(bare).not.toContain('Recorded tool calls whose outcome is unknown:')

    const crowded = noticeText({
      mission: snapshot({ revision: 2, attempts: 1 }),
      objective: 'busy mission',
      attempt: 1,
      steps: Array.from({ length: 14 }, (_value, index) => ({ content: `step ${index}`, status: 'pending' as const })),
      uncertainOperations: Array.from({ length: 10 }, (_value, index) => ({ callId: `call-${index}`, name: 'bash' })),
    })
    expect(crowded).toContain('- and 2 more entries')
    expect(crowded).toContain('- bash (call-7)')
    expect(crowded).not.toContain('- bash (call-8)')
    // The bounded list says how many recorded doubts it could not name.
    expect(crowded).toContain('- and 2 more recorded calls with unknown outcomes')
  })

  it('names a doubt the bounded tracker could not list', () => {
    const text = noticeText({
      mission: snapshot({ revision: 2, attempts: 1 }),
      objective: 'overflowed mission',
      attempt: 1,
      steps: [],
      uncertainOperations: operations,
      uncertainOverflow: 3,
    })
    expect(text).toContain('Recorded tool calls whose outcome is unknown:')
    expect(text).toContain('- bash (call-1)')
    expect(text).toContain('- and 3 more recorded calls with unknown outcomes')
  })
})

describe('bounded hold diagnostics', () => {
  /**
   * Regression (preexisting): the unknown-outcome diagnostic listed every call
   * name, and `authorize()` rejects a message over the durable diagnostic limit.
   * One wide fan-out therefore threw inside the claim, and the mission was held
   * under a generic failure code instead of the authorization code a human has
   * to clear — work stuck behind a doubt nobody was told how to resolve.
   */
  it('renders an unknown-outcome diagnostic the durable record accepts', async () => {
    const { uncertainMessage } = await import('../src/supervisor.ts')
    const message = uncertainMessage(
      Array.from({ length: 40 }, () => ({ name: 'a_very_long_tool_name_that_would_not_fit', callId: 'id' })),
      7,
    )
    expect(message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH)
    // The count is never trimmed: it is what a human acts on.
    expect(message).toContain('47 recorded')
    expect(message).toContain('Verify the external state')
    // A single name still fits, and no name means the count stands alone.
    expect(uncertainMessage([{ name: 'bash', callId: 'c' }], 0)).toContain('(bash)')
    expect(uncertainMessage([], 3)).toContain('3 recorded')
  })

  /**
   * The same bound, at the other edge: a name that does not fit is left out
   * rather than cut in half, because a half-written tool name is not evidence.
   */
  it('leaves out the names that do not fit instead of truncating one', async () => {
    const { uncertainMessage } = await import('../src/supervisor.ts')
    const tooWide = 'y'.repeat(MAX_DIAGNOSTIC_LENGTH)
    const partial = uncertainMessage([{ name: 'read_file' }, { name: 'write_file' }, { name: tooWide }], 0)
    expect(partial).toContain('(read_file, write_file, …)')
    expect(partial).not.toContain('y'.repeat(20))
    // With no name short enough to fit, the count stands alone - and the count is
    // what a human acts on.
    const none = uncertainMessage([{ name: tooWide }], 2)
    expect(none).not.toContain('y'.repeat(20))
    expect(none).toContain('3 recorded')
    for (const message of [partial, none]) {
      expect(message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH)
    }
  })
})
