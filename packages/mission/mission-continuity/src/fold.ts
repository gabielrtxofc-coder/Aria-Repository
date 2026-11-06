/**
 * Pure replay fold and strict decoder for durable mission changes. Malformed
 * shapes, discontinuous revisions, non-monotonic budgets, and forbidden
 * transitions are rejected instead of being interpreted, so a damaged record
 * leaves mission access failed at that position rather than silently wrong.
 * @module @deepseek-ai/dsh-mission-continuity
 */

import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import { TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  MAX_COMPLETION_CRITERIA,
  MAX_COMPLETION_CRITERION_LENGTH,
  MAX_DIAGNOSTIC_LENGTH,
  MISSION_CHANGE_VERSION,
  MissionId,
  POLICY_CODE_PATTERN,
  UNCERTAIN_OPERATIONS,
} from './runtime.ts'
import type {
  MissionChangeMeta,
  MissionClearChangeMeta,
  MissionSnapshotChangeMeta,
} from './domain.ts'
import { freezeUncertaintyScope } from './uncertainty.ts'
import type {
  MissionAuthorization,
  MissionChangeOperation,
  MissionCheckpoint,
  MissionInterruption,
  MissionInterruptionKind,
  MissionRef,
  MissionSnapshot,
  MissionUncertaintyScope,
} from './types.ts'

/** Operations that carry a complete post-mutation snapshot. */
const SNAPSHOT_OPERATIONS: ReadonlySet<Exclude<MissionChangeOperation, 'clear'>> = new Set([
  'start',
  'checkpoint',
  'attempt',
  'authorize',
  'resume',
])

/** Accepted interruption causes. */
const INTERRUPTION_KINDS: ReadonlySet<MissionInterruptionKind> = new Set([
  'process-restart',
  'request-failed',
  'turn-aborted',
  'unknown',
])

/** Mutable accumulator kept private to the pure fold. */
export interface MissionFoldState {
  /** Current mission, absent before the first start and after a clear. */
  mission: MissionSnapshot | undefined
  /** Latest mutation ref, including a clear tombstone. */
  lastRef: MissionRef | undefined
  /** Every mission id already started in this session. */
  seenMissionIds: Set<string>
  /** Whether a clear tombstone makes a fresh start legal. */
  cleared: boolean
  /** Durable unknown-result ordinal at this point in the session event log. */
  uncertaintyRecorded: number
}

/**
 * Build an empty replay accumulator.
 * @returns mutable state with no current mission or prior ref.
 */
export function emptyMissionFoldState(): MissionFoldState {
  return {
    mission: undefined,
    lastRef: undefined,
    seenMissionIds: new Set(),
    cleared: false,
    uncertaintyRecorded: 0,
  }
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Require exactly the named own keys, in any order. */
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${subject} has unexpected field "${key}"`)
  }
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`mission change ${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`mission change ${field} must be a non-negative safe integer`)
  }
  return value
}

/** Require one bounded, non-empty, trimmed string. */
function boundedText(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    throw new Error(`mission change ${field} must be a non-empty string of at most ${limit} characters`)
  }
  return value
}

/** Decode one durable ref. */
function decodeRef(value: unknown, field: string): MissionRef {
  if (!isRecord(value)) throw new Error(`mission change ${field} must be an object`)
  exactKeys(value, ['id', 'revision'], `mission change ${field}`)
  return {
    id: MissionId(boundedText(value['id'], `${field}.id`, 200)),
    revision: positiveInteger(value['revision'], `${field}.revision`),
  }
}

/** Decode the linked objective ref. */
function decodeGoalRef(value: unknown): GoalRef {
  if (!isRecord(value)) throw new Error('mission change mission.goal must be an object')
  exactKeys(value, ['id', 'revision'], 'mission change mission.goal')
  return {
    id: GoalId(boundedText(value['id'], 'mission.goal.id', 200)),
    revision: positiveInteger(value['revision'], 'mission.goal.revision'),
  }
}

/** Decode completion criteria. */
function decodeCriteria(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMPLETION_CRITERIA) {
    throw new Error(`mission change mission.completionCriteria must hold 1..${MAX_COMPLETION_CRITERIA} statements`)
  }
  return value.map((entry, index) =>
    boundedText(entry, `mission.completionCriteria[${index}]`, MAX_COMPLETION_CRITERION_LENGTH))
}

/** Decode the interruption record. */
function decodeInterruption(value: unknown): MissionInterruption {
  if (!isRecord(value)) throw new Error('mission change mission.interruption must be an object')
  const kind = value['kind']
  if (typeof kind !== 'string' || !INTERRUPTION_KINDS.has(kind as MissionInterruptionKind)) {
    throw new Error('mission change mission.interruption.kind is not a known interruption cause')
  }
  exactKeys(value, ['kind', 'at', 'detail'], 'mission change mission.interruption')
  const at = nonNegativeInteger(value['at'], 'mission.interruption.at')
  const detail = value['detail']
  return detail === undefined
    ? { kind: kind as MissionInterruptionKind, at }
    : {
        kind: kind as MissionInterruptionKind,
        at,
        detail: boundedText(detail, 'mission.interruption.detail', MAX_DIAGNOSTIC_LENGTH),
      }
}

/** Decode the checkpoint record. */
function decodeCheckpoint(value: unknown): MissionCheckpoint {
  if (!isRecord(value)) throw new Error('mission change mission.checkpoint must be an object')
  exactKeys(value, ['seq', 'at'], 'mission change mission.checkpoint')
  return {
    seq: nonNegativeInteger(value['seq'], 'mission.checkpoint.seq'),
    at: nonNegativeInteger(value['at'], 'mission.checkpoint.at'),
  }
}

/** Decode an immutable uncertainty scope from one authorization. */
function decodeUncertaintyScope(value: unknown): MissionUncertaintyScope {
  if (!isRecord(value)) throw new Error('mission authorization uncertaintyScope must be an object')
  exactKeys(value, ['from', 'through', 'operations', 'unlisted'], 'mission authorization uncertaintyScope')
  const from = nonNegativeInteger(value['from'], 'authorization.uncertaintyScope.from')
  const through = nonNegativeInteger(value['through'], 'authorization.uncertaintyScope.through')
  const unlisted = nonNegativeInteger(value['unlisted'], 'authorization.uncertaintyScope.unlisted')
  const rawOperations = value['operations']
  if (!Array.isArray(rawOperations) || rawOperations.length > 22) {
    throw new Error('mission authorization uncertaintyScope.operations must be a bounded array')
  }
  const operations = rawOperations.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`mission authorization uncertaintyScope.operations[${index}] must be an object`)
    exactKeys(raw, ['callId', 'name'], `mission authorization uncertaintyScope.operations[${index}]`)
    return {
      callId: boundedText(raw['callId'], `authorization.uncertaintyScope.operations[${index}].callId`, 2_000),
      name: boundedText(raw['name'], `authorization.uncertaintyScope.operations[${index}].name`, 2_000),
    }
  })
  if (through < from || operations.length + unlisted !== through - from) {
    throw new Error('mission authorization uncertaintyScope does not account for its reviewed interval')
  }
  if (new Set(operations.map(operation => operation.callId)).size !== operations.length) {
    throw new Error('mission authorization uncertaintyScope repeats a call identity')
  }
  return freezeUncertaintyScope({ from, through, operations, unlisted })
}

/** Decode the pending authorization record. */
function decodeAuthorization(value: unknown): MissionAuthorization {
  if (!isRecord(value)) throw new Error('mission change mission.authorization must be an object')
  exactKeys(value, ['code', 'message', 'uncertaintyScope'], 'mission change mission.authorization')
  const code = value['code']
  if (typeof code !== 'string' || !POLICY_CODE_PATTERN.test(code)) {
    throw new Error('mission change mission.authorization.code must be lower-kebab-case')
  }
  const uncertaintyScope = value['uncertaintyScope'] === undefined
    ? undefined
    : decodeUncertaintyScope(value['uncertaintyScope'])
  if (uncertaintyScope !== undefined && code !== UNCERTAIN_OPERATIONS) {
    throw new Error('mission authorization uncertaintyScope requires uncertain-operations code')
  }
  return Object.freeze({
    code,
    message: boundedText(value['message'], 'mission.authorization.message', MAX_DIAGNOSTIC_LENGTH),
    ...(uncertaintyScope === undefined ? {} : { uncertaintyScope }),
  })
}

/** Decode one complete mission snapshot. */
function decodeSnapshot(value: unknown): MissionSnapshot {
  if (!isRecord(value)) throw new Error('mission change mission must be an object')
  exactKeys(value, [
    'id',
    'revision',
    'goal',
    'completionCriteria',
    'recovery',
    'maxRecoveryAttempts',
    'attempts',
    'interruption',
    'checkpoint',
    'authorization',
    'uncertainAcknowledged',
    'createdAt',
    'updatedAt',
  ], 'mission change mission')
  const maxRecoveryAttempts = positiveInteger(value['maxRecoveryAttempts'], 'mission.maxRecoveryAttempts')
  const attempts = nonNegativeInteger(value['attempts'], 'mission.attempts')
  if (attempts > maxRecoveryAttempts) {
    throw new Error('mission change mission.attempts cannot exceed maxRecoveryAttempts')
  }
  const recovery = value['recovery']
  if (recovery !== 'enabled' && recovery !== 'disabled') {
    throw new Error('mission change mission.recovery must be enabled or disabled')
  }
  const createdAt = nonNegativeInteger(value['createdAt'], 'mission.createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'mission.updatedAt')
  if (updatedAt < createdAt) throw new Error('mission change mission update cannot precede its start')
  const interruption = value['interruption']
  const checkpoint = value['checkpoint']
  const authorization = value['authorization']
  const acknowledged = value['uncertainAcknowledged']
  return {
    id: MissionId(boundedText(value['id'], 'mission.id', 200)),
    revision: positiveInteger(value['revision'], 'mission.revision'),
    goal: decodeGoalRef(value['goal']),
    completionCriteria: decodeCriteria(value['completionCriteria']),
    recovery,
    maxRecoveryAttempts,
    attempts,
    ...interruption === undefined ? {} : { interruption: decodeInterruption(interruption) },
    ...checkpoint === undefined ? {} : { checkpoint: decodeCheckpoint(checkpoint) },
    ...authorization === undefined ? {} : { authorization: decodeAuthorization(authorization) },
    // The acknowledgement is a count of reviewed doubts, so it must be a whole
    // number; an absent one means nobody has reviewed anything yet, which is a
    // different fact from "zero doubts were reviewed" only in the record, never
    // in what recovery refuses to do.
    ...acknowledged === undefined
      ? {}
      : { uncertainAcknowledged: nonNegativeInteger(value['uncertainAcknowledged'], 'mission.uncertainAcknowledged') },
    createdAt,
    updatedAt,
  }
}

/**
 * Decode one durable mission change without interpreting it.
 * @param value - the `mission/change` payload as it was stored or supplied.
 * @returns the validated change.
 * @throws when the payload is not exactly one well-formed mission change.
 */
export function decodeMissionChange(value: unknown): MissionChangeMeta {
  if (!isRecord(value)) throw new Error('mission change must be an object')
  if (value['kind'] !== 'mission/change') throw new Error('mission change kind must be mission/change')
  if (value['version'] !== MISSION_CHANGE_VERSION) {
    throw new Error(`mission change version must be ${MISSION_CHANGE_VERSION}`)
  }
  const operation = value['operation']
  if (operation === 'clear') {
    exactKeys(value, ['kind', 'version', 'operation', 'cleared', 'clearedAt'], 'mission clear change')
    const cleared: MissionClearChangeMeta = {
      kind: 'mission/change',
      version: MISSION_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeRef(value['cleared'], 'cleared'),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    }
    return cleared
  }
  if (typeof operation !== 'string' || !SNAPSHOT_OPERATIONS.has(operation as MissionSnapshotChangeMeta['operation'])) {
    throw new Error('mission change operation is not a known mission operation')
  }
  exactKeys(value, ['kind', 'version', 'operation', 'mission'], 'mission change')
  const snapshot: MissionSnapshotChangeMeta = {
    kind: 'mission/change',
    version: MISSION_CHANGE_VERSION,
    operation: operation as MissionSnapshotChangeMeta['operation'],
    mission: decodeSnapshot(value['mission']),
  }
  return snapshot
}

/**
 * Ref of one decoded change, including a clear tombstone.
 * @param change - decoded change committed to the session log.
 * @returns the mission identity and revision the change produced.
 */
export function missionChangeRef(change: MissionChangeMeta): MissionRef {
  return change.operation === 'clear'
    ? { id: change.cleared.id, revision: change.cleared.revision }
    : { id: change.mission.id, revision: change.mission.revision }
}

/**
 * Apply one decoded change to the accumulator, rejecting every transition the
 * domain does not produce.
 * @param state - accumulator before the change.
 * @param change - validated change, in log order.
 * @returns the accumulator after the change.
 * @throws when the change cannot follow the accumulated state.
 */
export function applyMissionChange(state: MissionFoldState, change: MissionChangeMeta): MissionFoldState {
  if (change.operation === 'clear') {
    const current = state.mission
    if (current === undefined) throw new Error('mission clear requires a current mission')
    if (current.id !== change.cleared.id || current.revision !== change.cleared.revision) {
      throw new Error('mission clear must name the exact current revision')
    }
    return {
      mission: undefined,
      lastRef: { id: change.cleared.id, revision: change.cleared.revision },
      seenMissionIds: state.seenMissionIds,
      cleared: true,
      uncertaintyRecorded: state.uncertaintyRecorded,
    }
  }
  let next = change.mission
  const current = state.mission
  if (change.operation === 'start') {
    if (current !== undefined) throw new Error('mission start requires that no mission is current')
    if (next.revision !== 1) throw new Error('mission start must begin at revision 1')
    if (next.authorization !== undefined || next.uncertainAcknowledged !== undefined) {
      throw new Error('mission start cannot contain prior authorization or uncertainty acknowledgement')
    }
    if (state.seenMissionIds.has(next.id)) throw new Error('mission start reuses a released mission id')
    return {
      mission: next,
      lastRef: { id: next.id, revision: next.revision },
      seenMissionIds: new Set([...state.seenMissionIds, next.id]),
      cleared: false,
      uncertaintyRecorded: state.uncertaintyRecorded,
    }
  }
  if (current === undefined) throw new Error(`mission ${change.operation} requires a current mission`)
  if (current.id !== next.id) throw new Error('mission mutation cannot change the mission identity')
  if (next.revision !== current.revision + 1) {
    throw new Error('mission mutation must advance exactly one revision')
  }
  if (next.createdAt !== current.createdAt) throw new Error('mission mutation cannot change its start time')
  if (next.updatedAt < current.updatedAt) throw new Error('mission mutation time cannot move backward')
  if (next.attempts < current.attempts) throw new Error('mission attempts cannot decrease')
  if (change.operation === 'attempt' && next.attempts !== current.attempts + 1) {
    throw new Error('mission attempt must consume exactly one recovery attempt')
  }
  if (next.maxRecoveryAttempts !== current.maxRecoveryAttempts) {
    throw new Error('mission recovery budget is fixed at start')
  }
  if (next.goal.id !== current.goal.id) throw new Error('mission objective binding is fixed at start')
  if (next.completionCriteria.length !== current.completionCriteria.length
    || next.completionCriteria.some((criterion, index) => criterion !== current.completionCriteria[index])) {
    throw new Error('mission completion criteria are fixed at start')
  }
  const before = current.checkpoint?.seq
  const after = next.checkpoint?.seq
  if (before !== undefined && after !== undefined && after < before) {
    throw new Error('mission checkpoint cannot move backward')
  }
  // Acknowledgements are a durable prefix watermark in the event-ordered stream
  // of TOOL_OUTCOME_UNKNOWN results. Only `resume` may advance it, and then only
  // to the scope frozen on the authorization it consumes.
  const clearedBefore = current.uncertainAcknowledged ?? 0
  const clearedAfter = next.uncertainAcknowledged ?? 0
  if (clearedAfter < clearedBefore) {
    throw new Error('mission uncertainty acknowledgement cannot shrink')
  }
  if (change.operation === 'authorize') {
    if (clearedAfter !== clearedBefore) {
      throw new Error('mission authorization cannot advance uncertainty acknowledgement')
    }
    let authorization = next.authorization
    if (authorization === undefined) throw new Error('mission authorize must record an authorization')
    // Older logs did not persist the scope as a field, but the supervisor's
    // durable authorization message recorded the exact backlog count. Rebuild
    // that frozen interval from the message and event ordinal, never from a
    // later `resume()` snapshot. Unrecognizable legacy messages stay unscoped
    // and therefore cannot acknowledge any doubt.
    if (authorization.code === UNCERTAIN_OPERATIONS && authorization.uncertaintyScope === undefined) {
      const match = /^Interrupted tool calls whose outcome is unknown: (\d+) recorded/u.exec(authorization.message)
      const presented = match?.[1] === undefined ? undefined : Number(match[1])
      const through = presented === undefined ? undefined : clearedBefore + presented
      if (presented !== undefined && Number.isSafeInteger(presented) && presented > 0
        && through !== undefined && Number.isSafeInteger(through)
        && through === state.uncertaintyRecorded) {
        authorization = Object.freeze({
          ...authorization,
          uncertaintyScope: freezeUncertaintyScope({
            from: clearedBefore, through, operations: [], unlisted: presented,
          }),
        })
        next = { ...next, authorization }
      }
    }
    const scope = authorization.uncertaintyScope
    if (authorization.code === UNCERTAIN_OPERATIONS && scope !== undefined) {
      if (scope.from !== clearedBefore || scope.through !== state.uncertaintyRecorded) {
        throw new Error('mission uncertainty authorization scope does not match the event-log watermark')
      }
    } else if (authorization.code !== UNCERTAIN_OPERATIONS && scope !== undefined) {
      throw new Error('only uncertain-operations authorization may carry an uncertainty scope')
    }
  } else if (change.operation === 'resume') {
    const authorization = current.authorization
    if (authorization === undefined) throw new Error('mission resume requires a pending authorization')
    if (next.authorization !== undefined) throw new Error('mission resume must consume the pending authorization')
    const scope = authorization.code === UNCERTAIN_OPERATIONS ? authorization.uncertaintyScope : undefined
    let expectedAcknowledgement = clearedBefore
    if (scope !== undefined) {
      if (scope.from !== clearedBefore || scope.through > state.uncertaintyRecorded) {
        throw new Error('mission resume uncertainty scope is invalid or exceeds the durable event log')
      }
      expectedAcknowledgement = Math.max(clearedBefore, scope.through)
    }
    if (clearedAfter !== expectedAcknowledgement) {
      throw new Error('mission resume acknowledgement exceeds or differs from its presented scope')
    }
  } else {
    if (clearedAfter !== clearedBefore) {
      throw new Error('only mission resume may advance uncertainty acknowledgement')
    }
    if (JSON.stringify(next.authorization ?? null) !== JSON.stringify(current.authorization ?? null)) {
      throw new Error('mission mutation cannot alter a pending authorization outside authorize or resume')
    }
  }
  return {
    mission: next,
    lastRef: { id: next.id, revision: next.revision },
    seenMissionIds: state.seenMissionIds,
    cleared: false,
    uncertaintyRecorded: state.uncertaintyRecorded,
  }
}

/**
 * Strict replay of a session's durable mission changes.
 * @param events - the session log, or its child-owned suffix.
 * @returns the folded current mission and counters.
 * @throws when any committed change cannot follow the accumulated state.
 */
export function foldMission(events: readonly SessionEvent[]): MissionFoldState {
  let state = emptyMissionFoldState()
  for (const event of events) {
    if (event.type === 'tool/result' && event.data.error?.code === TOOL_OUTCOME_UNKNOWN) {
      /* v8 ignore next -- a JavaScript array cannot contain enough events to reach MAX_SAFE_INTEGER. */
      if (state.uncertaintyRecorded >= Number.MAX_SAFE_INTEGER) {
        throw new Error('mission uncertainty event ordinal exceeds the safe integer range')
      }
      state = { ...state, uncertaintyRecorded: state.uncertaintyRecorded + 1 }
      continue
    }
    if (event.type === 'mission/change') {
      state = applyMissionChange(state, decodeMissionChange(event.data))
    }
  }
  return state
}
