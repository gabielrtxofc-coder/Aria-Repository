/**
 * Unit contracts of the pure pieces: strict durable decoding, the bounded
 * discovery ledger, and the recovery notice the model reads.
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import {
  applyMissionChange,
  decodeMissionChange,
  emptyMissionFoldState,
  foldMission,
  MAX_DIAGNOSTIC_LENGTH,
  missionProjectionDefinition,
  recordedUncertainty,
  renderMissionRecoveryNotice,
  unacknowledgedUncertainty,
} from '../src/index.ts'
import type {
  MissionChangeMeta,
  MissionSnapshot,
  MissionSnapshotChangeMeta,
  MissionView,
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

/**
 * A durable record as the service presents it to the renderer. `MissionView`
 * adds the `settled` flag, which is derived from the linked objective rather
 * than stored, so the notice fixtures state it explicitly instead of widening
 * the parameter.
 */
function view(overrides: Partial<MissionSnapshot> = {}, settled = false): MissionView {
  return { ...snapshot(overrides), settled }
}

/**
 * One `mission/change` payload carrying a full snapshot. `MissionChangeMeta` is
 * a discriminated union whose `clear` arm has no `mission` field, so the
 * parameter is narrowed to the snapshot-carrying operations instead of the
 * whole union: the helper never builds the tombstone variant.
 */
function change(
  record: MissionSnapshot,
  operation: Exclude<MissionChangeMeta['operation'], 'clear'> = 'start',
): MissionSnapshotChangeMeta {
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

describe('mission projection schema', () => {
  it('rejects scopes with incomplete intervals, repeated identities, or an incompatible code', () => {
    const base = missionProjectionDefinition.init()
    const valid = {
      code: 'uncertain-operations',
      message: 'review',
      uncertaintyScope: {
        from: 0,
        through: 1,
        operations: [{ callId: 'call-1', name: 'effect' }],
        unlisted: 0,
      },
    }
    expect(missionProjectionDefinition.stateSchema.parse({
      ...base,
      current: snapshot({ revision: 2, authorization: valid }),
    })).toMatchObject({ current: { authorization: valid } })

    const invalidStates = [
      snapshot({ revision: 2, authorization: {
        ...valid,
        uncertaintyScope: { ...valid.uncertaintyScope, through: 2 },
      } }),
      snapshot({ revision: 2, authorization: {
        ...valid,
        uncertaintyScope: {
          ...valid.uncertaintyScope,
          through: 2,
          operations: [
            { callId: 'same', name: 'effect' },
            { callId: 'same', name: 'effect' },
          ],
        },
      } }),
      snapshot({ revision: 2, authorization: {
        code: 'needs-human',
        message: 'review',
        uncertaintyScope: valid.uncertaintyScope,
      } }),
    ]
    for (const current of invalidStates) {
      expect(() => missionProjectionDefinition.stateSchema.parse({ ...base, current })).toThrow()
    }
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

  it('validates authorization and resume watermarks in event order', () => {
    const first = snapshot()
    const started: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(1), time: 1, data: change(first),
    } as SessionEvent
    const unknown = (callId: string, seq: number): SessionEvent => ({
      type: 'tool/result',
      seq: SessionSeq(seq),
      time: seq,
      data: {
        turn: seq,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId(callId), content: [{ type: 'text', text: 'unknown' }], isError: true,
        }),
        error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
      },
    } as SessionEvent)
    const authorization = {
      code: 'uncertain-operations',
      message: 'Interrupted tool calls whose outcome is unknown: 1 recorded (external_effect [call-one]).',
      uncertaintyScope: {
        from: 0, through: 1, operations: [{ name: 'external_effect', callId: 'call-one' }], unlisted: 0,
      },
    }
    const authorized: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(3), time: 3,
      data: change({ ...first, revision: 2, authorization }, 'authorize'),
    } as SessionEvent
    const resumed: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(5), time: 5,
      data: change({ ...first, revision: 3, uncertainAcknowledged: 1 }, 'resume'),
    } as SessionEvent
    const folded = foldMission([
      started,
      unknown('call-one', 2),
      authorized,
      unknown('call-two', 4),
      resumed,
    ])
    expect(folded.uncertaintyRecorded).toBe(2)
    expect(folded.mission?.uncertainAcknowledged).toBe(1)

    // Spread pairs a narrowed `operation` with a mismatched `data` under
    // `exactOptionalPropertyTypes`; the harness builds the payload directly
    // instead, which is also how the other forged events in this file read.
    const forgedScope: SessionEvent = {
      type: 'mission/change',
      seq: authorized.seq,
      time: authorized.time,
      data: change({
        ...first,
        revision: 2,
        authorization: {
          ...authorization,
          uncertaintyScope: { from: 0, through: 2, operations: [], unlisted: 2 },
        },
      }, 'authorize'),
    } as SessionEvent
    expect(() => foldMission([started, unknown('call-one', 2), forgedScope]))
      .toThrow('mission uncertainty authorization scope does not match the event-log watermark')

    const forgedResume: SessionEvent = {
      type: 'mission/change',
      seq: resumed.seq,
      time: resumed.time,
      data: change({ ...first, revision: 3, uncertainAcknowledged: 2 }, 'resume'),
    } as SessionEvent
    expect(() => foldMission([started, unknown('call-one', 2), authorized, forgedResume]))
      .toThrow('mission resume acknowledgement exceeds or differs from its presented scope')
  })

  it('rejects malformed or inconsistent persisted authorization scopes', () => {
    const first = snapshot()
    const scope = { from: 0, through: 1, operations: [{ callId: 'call-1', name: 'effect' }], unlisted: 0 }
    const rawAuthorizationChange = (authorization: unknown): unknown => ({
      kind: 'mission/change',
      version: 1,
      operation: 'authorize',
      mission: { ...first, revision: 2, authorization },
    })
    const invalid: unknown[] = [
      { ...scope, operations: null },
      { ...scope, operations: Array.from({ length: 23 }, (_, index) => ({ callId: `c-${index}`, name: 'effect' })), through: 23 },
      { ...scope, operations: [null] },
      { ...scope, operations: [{ callId: 'same', name: 'effect' }, { callId: 'same', name: 'effect' }], through: 2 },
      { ...scope, through: 2 },
      { ...scope, from: 2 },
      { ...scope, unlisted: -1 },
    ]
    for (const uncertaintyScope of invalid) {
      expect(() => decodeMissionChange(rawAuthorizationChange({
        code: 'uncertain-operations', message: 'review', uncertaintyScope,
      }))).toThrow()
    }
    expect(() => decodeMissionChange(rawAuthorizationChange({
      code: 'needs-human', message: 'review', uncertaintyScope: scope,
    }))).toThrow('requires uncertain-operations code')
    expect(() => decodeMissionChange(rawAuthorizationChange({
      code: 'uncertain-operations', message: 'review', uncertaintyScope: null,
    }))).toThrow('uncertaintyScope must be an object')
  })

  it('rejects authorization transitions that attempt to forge or alter a scope', () => {
    const first = snapshot()
    const started = applyMissionChange(emptyMissionFoldState(), change(first))
    expect(() => applyMissionChange(emptyMissionFoldState(), change({
      ...first,
      authorization: { code: 'needs-human', message: 'unexpected at start' },
    }))).toThrow('mission start cannot contain prior authorization or uncertainty acknowledgement')
    expect(() => applyMissionChange(emptyMissionFoldState(), change({
      ...first,
      uncertainAcknowledged: 0,
    }))).toThrow('mission start cannot contain prior authorization or uncertainty acknowledgement')
    const stateWithOneDoubt = { ...started, uncertaintyRecorded: 1 }
    expect(() => applyMissionChange(started, change({
      ...first, revision: 2, uncertainAcknowledged: 1,
    }, 'authorize'))).toThrow('mission authorization cannot advance uncertainty acknowledgement')
    expect(() => applyMissionChange(started, change({ ...first, revision: 2 }, 'authorize')))
      .toThrow('mission authorize must record an authorization')

    const generic = applyMissionChange(started, change({
      ...first,
      revision: 2,
      authorization: { code: 'needs-human', message: 'review' },
    }, 'authorize'))
    expect(() => applyMissionChange(generic, change({
      ...first, revision: 3,
    }, 'checkpoint'))).toThrow('mission mutation cannot alter a pending authorization')
    expect(() => applyMissionChange(stateWithOneDoubt, change({
      ...first,
      revision: 2,
      authorization: {
        code: 'needs-human', message: 'review',
        uncertaintyScope: { from: 0, through: 1, operations: [], unlisted: 1 },
      },
    }, 'authorize'))).toThrow('only uncertain-operations authorization may carry an uncertainty scope')
    expect(() => applyMissionChange(stateWithOneDoubt, change({
      ...first,
      revision: 2,
      authorization: {
        code: 'uncertain-operations', message: 'review',
        uncertaintyScope: { from: 1, through: 1, operations: [], unlisted: 0 },
      },
    }, 'authorize'))).toThrow('mission uncertainty authorization scope does not match the event-log watermark')
    const impossibleScopeState = {
      ...stateWithOneDoubt,
      mission: {
        ...first,
        revision: 2,
        authorization: {
          code: 'uncertain-operations',
          message: 'review',
          uncertaintyScope: { from: 0, through: 2, operations: [], unlisted: 2 },
        },
      },
    }
    expect(() => applyMissionChange(impossibleScopeState, change({
      ...first,
      revision: 3,
      uncertainAcknowledged: 1,
    }, 'resume'))).toThrow('mission resume uncertainty scope is invalid or exceeds the durable event log')

    expect(() => applyMissionChange(started, change({ ...first, revision: 2 }, 'resume')))
      .toThrow('mission resume requires a pending authorization')
    const pending = applyMissionChange(started, change({
      ...first,
      revision: 2,
      authorization: { code: 'needs-human', message: 'review' },
    }, 'authorize'))
    expect(() => applyMissionChange(pending, change({
      ...first,
      revision: 3,
      authorization: { code: 'needs-human', message: 'still pending' },
    }, 'resume'))).toThrow('mission resume must consume the pending authorization')
  })

  it('reconstructs legacy authorization scope from its durable presented count', () => {
    const first = snapshot()
    const started: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(1), time: 1, data: change(first),
    } as SessionEvent
    const unknown: SessionEvent = {
      type: 'tool/result',
      seq: SessionSeq(2),
      time: 2,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('legacy-call'), content: [{ type: 'text', text: 'unknown' }], isError: true,
        }),
        error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
      },
    } as SessionEvent
    const authorized: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(3), time: 3,
      data: change({
        ...first,
        revision: 2,
        authorization: {
          code: 'uncertain-operations',
          message: 'Interrupted tool calls whose outcome is unknown: 1 recorded. Verify the external state first.',
        },
      }, 'authorize'),
    } as SessionEvent
    const resumed: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(4), time: 4,
      data: change({ ...first, revision: 3, uncertainAcknowledged: 1 }, 'resume'),
    } as SessionEvent
    const legacyFold = foldMission([started, unknown, authorized, resumed])
    expect(legacyFold.mission?.uncertainAcknowledged).toBe(1)
    expect(Object.isFrozen(legacyFold.mission?.authorization)).toBe(true)
    expect(Object.isFrozen(legacyFold.mission?.authorization?.uncertaintyScope)).toBe(true)

    const laterUnknown: SessionEvent = {
      type: 'tool/result',
      seq: SessionSeq(4),
      time: 4,
      data: {
        turn: 2,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('legacy-later-call'), content: [{ type: 'text', text: 'unknown' }], isError: true,
        }),
        error: { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN },
      },
    } as SessionEvent
    const resumeAfterLater: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(5), time: 5,
      data: change({ ...first, revision: 3, uncertainAcknowledged: 1 }, 'resume'),
    } as SessionEvent
    const legacyWithLaterResult = foldMission([started, unknown, authorized, laterUnknown, resumeAfterLater])
    expect(legacyWithLaterResult.uncertaintyRecorded).toBe(2)
    expect(legacyWithLaterResult.mission?.uncertainAcknowledged).toBe(1)
    expect(legacyWithLaterResult.mission?.authorization).toBeUndefined()

    const unrecognizedLegacyAuthorization: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(3), time: 3,
      data: change({
        ...first,
        revision: 2,
        authorization: { code: 'uncertain-operations', message: 'Unknown interruption; inspect manually.' },
      }, 'authorize'),
    } as SessionEvent
    const unacknowledgedResume: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(4), time: 4,
      data: change({ ...first, revision: 3 }, 'resume'),
    } as SessionEvent
    const unrecognizedFold = foldMission([started, unknown, unrecognizedLegacyAuthorization, unacknowledgedResume])
    expect(unrecognizedFold.mission?.uncertainAcknowledged).toBeUndefined()
    expect(unacknowledgedUncertainty([], 1, unrecognizedFold.mission?.uncertainAcknowledged).count).toBe(1)

    const zeroLegacyAuthorization: SessionEvent = {
      type: 'mission/change', seq: SessionSeq(3), time: 3,
      data: change({
        ...first,
        revision: 2,
        authorization: {
          code: 'uncertain-operations',
          message: 'Interrupted tool calls whose outcome is unknown: 0 recorded.',
        },
      }, 'authorize'),
    } as SessionEvent
    expect(foldMission([started, zeroLegacyAuthorization]).mission?.authorization?.uncertaintyScope).toBeUndefined()
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

  it('allows only resume to acknowledge, and only through its presented watermark', () => {
    const first = snapshot()
    const started = applyMissionChange(emptyMissionFoldState(), change(first))
    const withThreeRecorded = { ...started, uncertaintyRecorded: 3 }
    const authorization = {
      code: 'uncertain-operations',
      message: 'Interrupted tool calls whose outcome is unknown: 3 recorded',
      uncertaintyScope: { from: 0, through: 3, operations: [], unlisted: 3 },
    }
    const held = applyMissionChange(withThreeRecorded, change({
      ...first, revision: 2, authorization,
    }, 'authorize'))
    const reviewed = applyMissionChange(held, change({
      ...first, revision: 3, uncertainAcknowledged: 3,
    }, 'resume'))
    expect(reviewed.mission?.uncertainAcknowledged).toBe(3)
    expect(() => applyMissionChange(held, change({
      ...first, revision: 3, uncertainAcknowledged: 1,
    }, 'checkpoint'))).toThrow('only mission resume may advance uncertainty acknowledgement')

    // A later mutation cannot narrow or erase a monotonic watermark.
    expect(() => applyMissionChange(reviewed,
      change({ ...first, revision: 4, uncertainAcknowledged: 2 }, 'checkpoint')))
      .toThrow('mission uncertainty acknowledgement cannot shrink')
    expect(() => applyMissionChange(reviewed, change({ ...first, revision: 4 }, 'checkpoint')))
      .toThrow('mission uncertainty acknowledgement cannot shrink')

    // Even resume cannot acknowledge beyond the exact scope that was presented.
    expect(() => applyMissionChange(held, change({
      ...first, revision: 3, uncertainAcknowledged: 4,
    }, 'resume'))).toThrow('mission resume acknowledgement exceeds or differs from its presented scope')
    // Ordinary mission progress preserves the existing authorization/watermark.
    expect(applyMissionChange(started, change({ ...first, revision: 2 }, 'checkpoint')))
      .toMatchObject({ mission: { revision: 2 } })
    expect(decodeMissionChange(change({ ...first, uncertainAcknowledged: 2 }))).toMatchObject({ mission: { uncertainAcknowledged: 2 } })
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
      mission: view({
        revision: 2,
        attempts: 1,
        checkpoint: { seq: 4, at: 5 },
        interruption: { kind: 'process-restart', at: 1_700_000_000_000, detail: 'process exited' },
      }),
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
      mission: view({ revision: 2, attempts: 1 }),
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
      mission: view({ revision: 2, attempts: 1 }),
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
      mission: view({ revision: 2, attempts: 1 }),
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
    const { presentUncertaintyScope } = await import('../src/uncertainty.ts')
    const presented = presentUncertaintyScope(0, 47, {
      operations: Array.from({ length: 40 }, (_, index) => ({
        name: 'a_very_long_tool_name_that_would_not_fit', callId: `id-${index}`,
      })),
      unlisted: 7,
      count: 47,
    })
    const { message } = presented
    expect(message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH)
    // The count is never trimmed: it is what a human acts on.
    expect(message).toContain('47 recorded')
    expect(message).toContain('Verify the external state')
    // Scope identities are exactly the operations printed; all other doubts
    // remain in the durable aggregate and are counted as unlisted.
    expect(presented.scope.operations.length + presented.scope.unlisted).toBe(47)
    const one = presentUncertaintyScope(0, 1, {
      operations: [{ name: 'bash', callId: 'c' }], unlisted: 0, count: 1,
    })
    expect(one.message).toContain('bash [c]')
    expect(one.scope.operations).toEqual([{ name: 'bash', callId: 'c' }])
    expect(presentUncertaintyScope(0, 3, { operations: [], unlisted: 3, count: 3 }).message)
      .toContain('3 recorded')
  })

  /**
   * The same bound, at the other edge: a name that does not fit is left out
   * rather than cut in half, because a half-written tool name is not evidence.
   */
  it('leaves out identities that do not fit instead of truncating one', async () => {
    const { presentUncertaintyScope } = await import('../src/uncertainty.ts')
    const tooWide = 'y'.repeat(MAX_DIAGNOSTIC_LENGTH)
    const partial = presentUncertaintyScope(0, 3, {
      operations: [
        { name: 'read_file', callId: 'read-1' },
        { name: 'write_file', callId: 'write-1' },
        { name: tooWide, callId: 'wide-id' },
      ],
      unlisted: 0,
      count: 3,
    })
    expect(partial.message).toContain('read_file [read-1]')
    expect(partial.message).toContain('write_file [write-1]')
    expect(partial.message).not.toContain('y'.repeat(20))
    expect(partial.scope.operations).toHaveLength(2)
    expect(partial.scope.unlisted).toBe(1)

    // With no identity short enough to fit, the count stands alone.
    const none = presentUncertaintyScope(0, 3, {
      operations: [{ name: tooWide, callId: 'wide-id' }], unlisted: 2, count: 3,
    })
    expect(() => presentUncertaintyScope(1, 0, { operations: [], unlisted: 0, count: 0 })).toThrow()
    expect(() => presentUncertaintyScope(0, 1, { operations: [], unlisted: 0, count: 0 })).toThrow()
    expect(() => presentUncertaintyScope(0, 1, { operations: [], unlisted: 1, count: 1 })).not.toThrow()
    expect(none.message).not.toContain('y'.repeat(20))
    expect(none.message).toContain('3 recorded')
    expect(none.scope.operations).toHaveLength(0)
    expect(none.scope.unlisted).toBe(3)
    for (const message of [partial.message, none.message]) {
      expect(message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LENGTH)
    }
  })
})
