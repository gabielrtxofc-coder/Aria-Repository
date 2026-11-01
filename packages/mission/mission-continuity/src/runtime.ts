/** Runtime constructors, protocol constants, and stable failures of the mission domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { MissionId as MissionIdType } from './types.ts'

/** Version of the mission change carried by `mission/change`. */
export const MISSION_CHANGE_VERSION = 1

/** Longest completion criterion accepted at the domain boundary. */
export const MAX_COMPLETION_CRITERION_LENGTH = 2_000

/** Most completion criteria one mission may state. */
export const MAX_COMPLETION_CRITERIA = 32

/** Longest interruption or blocker detail retained in a durable record. */
export const MAX_DIAGNOSTIC_LENGTH = 500

/** Stable lower-kebab-case classification code used by durable records. */
export const POLICY_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Brand a string as a mission id.
 * @param id - raw mission identifier.
 * @returns the same string with the compile-time brand.
 */
export function MissionId(id: string): MissionIdType {
  return id as MissionIdType
}

/** Stable error codes for rejected mission reads and mutations. */
export type MissionErrorCode =
  | 'MISSION_AGENT_NOT_LIVE'
  | 'MISSION_NOT_FOUND'
  | 'MISSION_STALE_REVISION'
  | 'MISSION_INVALID_OBJECTIVE'
  | 'MISSION_INVALID_CRITERIA'
  | 'MISSION_INVALID_ATTEMPTS'
  | 'MISSION_INVALID_AUTHORIZATION'
  | 'MISSION_INVALID_INTERRUPTION'
  | 'MISSION_RECOVERY_DISABLED'
  | 'MISSION_PERSISTENCE_FAILED'

/** Error returned by the mission domain boundary. */
export class MissionError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: MissionErrorCode) {
    super(message, code)
  }
}
