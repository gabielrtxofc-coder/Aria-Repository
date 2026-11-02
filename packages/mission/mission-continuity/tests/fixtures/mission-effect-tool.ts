/**
 * Simulated external effect for the interrupted-operation proofs.
 *
 * The tool has exactly the property the mission recovery contract cares about:
 * its effect lands in a file outside the process, so the file outlives a
 * `SIGKILL` and tells later runs whether the call ran once, twice, or not at
 * all. The body appends one record, publishes a failpoint (so the parent knows
 * the effect is already external when it kills the process), and then never
 * settles — the crash therefore happens between the recorded call and any
 * durable result.
 *
 * Environment:
 * - `MISSION_EFFECT_FILE`: append-only record of executed effects (required).
 * - `MISSION_EFFECT_FAILPOINT`: marker written after the effect, before hanging.
 * @module mission-effect-tool
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'mission-effect-tool'

export const inject = ['tools']

/** Register the simulated non-idempotent external operation. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'external_effect',
    description: 'Append one irreversible record to an external system.',
    parameters: {
      note: { type: 'string', description: 'Free-form note recorded with the effect.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { recorded: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'recorded' }],
    },
    execute(args, exec) {
      const file = process.env['MISSION_EFFECT_FILE']
      if (file === undefined) throw new Error('MISSION_EFFECT_FILE must name the external state file')
      // The external effect happens exactly here, outside the durable log.
      appendFileSync(file, `${JSON.stringify({
        callId: String(exec.rootCallId),
        note: typeof args.note === 'string' ? args.note : null,
        pid: process.pid,
        at: Date.now(),
      })}\n`)
      const failpoint = process.env['MISSION_EFFECT_FAILPOINT']
      if (failpoint !== undefined) writeFileSync(failpoint, 'effect-committed')
      // Never settles: the process dies while the call is still recorded as
      // started and its outcome is not durable anywhere.
      return new Promise<never>(() => {})
    },
  }))
}
