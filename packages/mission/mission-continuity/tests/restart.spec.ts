/**
 * Continuity across a composition restart over one durable directory: the
 * second composition finds the mission in its durable index, reconciles it
 * against the session log, and continues the work without a new user message.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  countMissionNotices,
  createAgent,
  mountHarness,
  readSessionArtifact,
  requestText,
  stopHarness,
  tempRoot,
  textResponse,
  waitFor,
} from './harness.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Mount one composition rooted at `root` and own its cleanup. */
async function mount(root: string, script: Parameters<typeof mountHarness>[0]['script'], config?: Parameters<typeof mountHarness>[0]['config']) {
  const harness = await mountHarness({ root, script, driver: true, config: config ?? {} })
  contexts.push(harness.ctx)
  return harness
}

describe('restart continuity', () => {
  it('resumes a mission through the startup sweep without a new user message', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-restart-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('step one')])
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'ship the recovery path',
      completionCriteria: ['restart test passes'],
    })
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(root, [textResponse('continued after restart')], { sweepOnStartup: false })
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1, held: 0, settled: 0, exhausted: 0, failed: 0 })

    const resumed = second.ctx.agents.get(SessionId('mission-session'))
    expect(resumed).toBeDefined()
    const mission = second.ctx.missions.get(resumed!)
    expect(mission).toMatchObject({ id: started.id, attempts: 1, revision: started.revision + 1 })
    expect(mission?.interruption?.kind).toBe('process-restart')
    // The projection is rebuilt from the durable log, not from memory.
    expect(second.ctx.sessionProjections.stateOf(resumed!.session, 'mission')?.current)
      .toMatchObject({ id: started.id, attempts: 1 })
  })

  it('tells the model why it woke and continues the same objective', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-continue-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('step one')])
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, {
      objective: 'finish the migration',
      completionCriteria: ['migration test passes'],
    })
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(root, [textResponse('continued work'), textResponse('done')], { sweepOnStartup: false })
    await second.ctx.missions.sweep()
    const resumed = second.ctx.agents.get(SessionId('mission-session'))!
    // The recovery notice is a logged, model-visible message — not hidden state.
    await waitFor(() => second.adapter.requests.some(request => requestText(request).includes('<mission_recovery ')))
    await second.ctx.sessions.flush(resumed.session)
    const artifact = await readSessionArtifact(root)
    expect(countMissionNotices(artifact)).toBe(1)
    expect(second.adapter.requests.length).toBeGreaterThan(0)
    const texts = second.adapter.requests.map(request => requestText(request))
    expect(texts.some(text => text.includes('<mission_recovery '))).toBe(true)
    expect(texts.some(text => text.includes('finish the migration'))).toBe(true)
    // The objective is re-armed, so the same-session driver keeps going.
    expect(second.ctx.goals.get(resumed)?.activation).toBe('armed')
  })

  it('does not duplicate attempts when the sweep runs twice', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-once-')
    cleanups.push(cleanup)
    const first = await mount(root, [textResponse('step one')])
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'stay once', completionCriteria: ['once'] })
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(root, [textResponse('continued')], { sweepOnStartup: false })
    expect((await second.ctx.missions.sweep()).resumed).toBe(1)
    // A second sweep sees the same armed row but the live agent is already resumed.
    const again = await second.ctx.missions.sweep()
    expect(again.considered).toBe(1)
    const resumed = second.ctx.agents.get(SessionId('mission-session'))!
    expect(second.ctx.missions.get(resumed)?.attempts).toBe(2)
    await second.ctx.sessions.flush(resumed.session)
    const artifact = await readSessionArtifact(root)
    expect(countMissionNotices(artifact)).toBe(2)
  })
})
