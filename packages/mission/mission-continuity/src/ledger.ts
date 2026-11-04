/**
 * The recovery ledger: the durable, host-owned index that makes in-flight
 * missions discoverable at process start without reading any session log.
 *
 * The session log stays the authority for mission state. A ledger row is a
 * hint written ahead of the mission change it announces and removed once the
 * mission can no longer be recovered, so a stale row costs one reconciliation
 * and a missing row can only follow a rejected write that the caller reported.
 * @module @deepseek-ai/dsh-mission-continuity
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { MAX_DIAGNOSTIC_LENGTH, MissionId, POLICY_CODE_PATTERN } from './runtime.ts'

/** Whether the startup sweep may claim this row without human action. */
export type RecoveryRowState = 'armed' | 'held'

/** Bounded diagnostic retained with a row that could not be recovered. */
export const recoveryErrorSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(MAX_DIAGNOSTIC_LENGTH),
}).strict()

/** One durable discovery row. */
export const recoveryRecordSchema = z.object({
  /** Session whose log owns the mission. */
  sessionId: z.string().min(1).transform(SessionId),
  /** Mission identity the row announces; reconciliation compares it to the log. */
  missionId: z.string().min(1).refine(value => value.trim() === value && value.length <= 200, {
    message: 'Expected a trimmed mission id of at most 200 characters',
  }).transform(MissionId),
  /** Durable objective the mission carries. */
  goalId: z.string().min(1).max(200),
  /** Mission revision last observed by the writer. */
  revision: z.number().int().positive(),
  /** Attempts already consumed, mirrored for bounded startup work. */
  attempts: z.number().int().nonnegative(),
  /** Whether autonomous recovery may claim the row now. */
  state: z.enum(['armed', 'held']),
  /** Policy-owned diagnostic explaining a `held` row, or the last failure. */
  lastError: recoveryErrorSchema.optional(),
  /** Canonical UTC instant of the latest row write. */
  updatedAt: z.iso.datetime({ precision: 3 }),
}).strict().refine(record => record.state === 'armed' || record.lastError !== undefined, {
  message: 'A held recovery row must carry its diagnostic',
})

/** Durable discovery row value. */
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>

/** Diagnostics retained by the ledger; keys are mission ids. */
export const missionContinuityDomain = defineDomain({
  name: 'mission_continuity',
  version: 1,
  tables: { recoveries: domainTable<RecoveryRecord['missionId'], RecoveryRecord>(recoveryRecordSchema) },
})

/**
 * Validate one policy-owned diagnostic code at the domain boundary.
 * @param code - caller-supplied classification.
 * @returns the same code when it is lower-kebab-case.
 * @throws when the code would not round-trip through durable decoding.
 */
export function assertPolicyCode(code: string): string {
  if (!POLICY_CODE_PATTERN.test(code)) {
    throw new Error(`"${code}" must be a lower-kebab-case classification code`)
  }
  return code
}

/**
 * Durable mission index over the `recovery` table of the
 * `mission_continuity` storage domain. Every write is durable before it
 * resolves, so a caller that awaits {@link put} can rely on discovery by a
 * later process start.
 */
export class RecoveryLedger {
  private readonly ready: Promise<Domain<typeof missionContinuityDomain>>
  private closing = false

  /**
   * @param ctx - context providing `storageDomain`.
   */
  constructor(ctx: Context) {
    this.ready = ctx.storageDomain.open(missionContinuityDomain)
  }

  /**
   * Wait for the durable domain to open; malformed rows reject startup instead
   * of publishing a partial index.
   * @returns resolution after the domain is open.
   */
  async open(): Promise<void> {
    await this.ready
  }

  /**
   * Read every discovery row, in first-write order.
   * @returns a detached list of stored rows.
   */
  async list(): Promise<RecoveryRecord[]> {
    const domain = await this.ready
    return [...domain.table('recoveries').entries()].map(([, record]) => record)
  }

  /**
   * Write one discovery row durably.
   * @param record - complete row value.
   * @returns resolution after the write is durable.
   * @throws when the domain is closing or the medium rejects the write.
   */
  async put(record: RecoveryRecord): Promise<void> {
    const domain = await this.ready
    if (this.closing) throw new Error('mission continuity ledger is closing')
    await domain.table('recoveries').put(record.missionId, record)
  }

  /**
   * Remove one discovery row durably. Idempotent: an absent row is not an error.
   * @param missionId - mission whose row is removed.
   * @returns resolution after the removal is durable.
   */
  async delete(missionId: RecoveryRecord['missionId']): Promise<void> {
    const domain = await this.ready
    if (this.closing) return
    await domain.table('recoveries').delete(missionId)
  }

  /**
   * Close the durable domain. Writes requested after this resolve without
   * touching the medium.
   * @returns resolution after the domain is released.
   */
  async close(): Promise<void> {
    this.closing = true
    await (await this.ready).close()
  }
}
