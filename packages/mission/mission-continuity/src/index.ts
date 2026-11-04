/**
 * Mission continuity: durable mission records plus autonomous recovery after a
 * process restart, integrated with the Harness session, goal, and projection
 * seams. Importing this module registers the `mission` projection and the
 * `mission/change` session event declarations.
 * @module @deepseek-ai/dsh-mission-continuity
 */

export { MissionService, MissionService as default, missionProjectionDefinition } from './service.ts'
export * from './service.ts'
export type * from './types.ts'
export type * from './domain.ts'
export { emptyMissionFoldState, applyMissionChange, decodeMissionChange, foldMission, missionChangeRef } from './fold.ts'
export type { MissionFoldState } from './fold.ts'
export { MissionSupervisor } from './supervisor.ts'
export type { MissionSweepOutcome, MissionSweepReport } from './supervisor.ts'
export { POLICY_CODE_PATTERN } from './runtime.ts'
