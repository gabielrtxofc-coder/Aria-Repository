/**
 * Sweep fairness: `maxMissionsPerSweep` bounds one sweep's work, never which
 * missions a supervisor can eventually reach.
 *
 * Regression (preexisting): every sweep started at the first armed row, so a
 * mission the supervisor had already claimed consumed the whole budget on every
 * later sweep — reporting `skipped` — and a second interrupted mission stayed
 * unrecoverable for as long as the first one ran. The recovery sweep now
 * rotates, so a bounded sweep still reaches every candidate.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAgent, mountHarness, stopHarness, tempRoot, textResponse } from './harness.ts'
import type { MissionHarness } from './harness.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Leave one interrupted mission per session, each with its own durable log. */
async function seedMissions(root: string, sessions: readonly string[]): Promise<void> {
  for (const sessionId of sessions) {
    const first = await mountHarness({
      root,
      sessionId,
      driver: true,
      script: [textResponse('ok')],
      config: { sweepOnStartup: false },
    })
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: `mission ${sessionId}`, completionCriteria: ['done'] })
    await stopHarness(first)
  }
}

/** One composition over the seeded root, with a one-candidate sweep budget. */
async function recover(root: string): Promise<MissionHarness> {
  const harness = await mountHarness({
    root,
    driver: true,
    script: Array.from({ length: 8 }, () => textResponse('continued')),
    config: { sweepOnStartup: false, maxMissionsPerSweep: 1 },
  })
  contexts.push(harness.ctx)
  return harness
}

describe('sweep budget fairness', () => {
  it('reaches a second interrupted mission while the first stays claimed', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-budget-')
    cleanups.push(cleanup)
    await seedMissions(root, ['s1', 's2'])
    const harness = await recover(root)

    // Sweep 1 recovers the first mission and keeps its Agent; sweep 2 must look
    // past it instead of paying the whole budget to re-examine the claim.
    const reports = [await harness.ctx.missions.sweep(), await harness.ctx.missions.sweep()]
    expect(reports[0]).toMatchObject({ considered: 1, resumed: 1 })
    expect(reports[1]).toMatchObject({ considered: 1, resumed: 1 })

    const s1 = harness.ctx.agents.get(SessionId('s1'))
    const s2 = harness.ctx.agents.get(SessionId('s2'))
    expect(s1).toBeDefined()
    expect(s2).toBeDefined()
    // Each mission consumed exactly one attempt: the rotation did not resurrect
    // the first claim as a second recovery.
    expect(harness.ctx.missions.get(s1 as Agent)?.attempts).toBe(1)
    expect(harness.ctx.missions.get(s2 as Agent)?.attempts).toBe(1)
  }, 120_000)

  it('keeps one recovery per interrupted mission across repeated sweeps', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-budget-repeat-')
    cleanups.push(cleanup)
    await seedMissions(root, ['s1', 's2', 's3'])
    const harness = await recover(root)

    const outcomes = []
    for (let round = 0; round < 6; round += 1) outcomes.push(await harness.ctx.missions.sweep())

    // Six one-candidate sweeps over three missions: three recoveries, and the
    // remaining sweeps report the live claims as skipped rather than recovering
    // them again.
    expect(outcomes.reduce((total, report) => total + report.resumed, 0)).toBe(3)
    for (const sessionId of ['s1', 's2', 's3']) {
      const agent = harness.ctx.agents.get(SessionId(sessionId))
      expect(agent).toBeDefined()
      expect(harness.ctx.missions.get(agent as Agent)?.attempts).toBe(1)
    }
  }, 120_000)
})
