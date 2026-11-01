/**
 * Continuity when the model, not the process, is what failed: the mission
 * survives a failed request and continues on a different provider. Aria owns
 * the task, so the route is a deployment decision and never part of the
 * mission record.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  countMissionNotices,
  createAgent,
  mountHarness,
  readSessionArtifact,
  requestText,
  ScriptedAdapter,
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

describe('continuity across model failure and route change', () => {
  it('keeps the mission when the model request fails, then continues on another provider', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-model-')
    cleanups.push(cleanup)

    // First composition: the only provider fails every request.
    const first = await mountHarness({
      root,
      script: [new Error('provider unavailable'), new Error('provider unavailable')],
      driver: true,
      config: { sweepOnStartup: false },
    })
    contexts.push(first.ctx)
    const agent = await createAgent(first)
    const started = await first.ctx.missions.start(agent, {
      objective: 'finish the migration',
      completionCriteria: ['migration test passes'],
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await waitFor(() => first.adapter.requests.length > 0)
    await waitFor(() => agent.status !== 'running')
    // The failed request did not touch mission state: the task is still Aria's.
    expect(first.ctx.missions.get(agent)).toMatchObject({ id: started.id, attempts: 0 })
    // A failed request is recoverable on its own: the sweep claims it live.
    const recovered = await first.ctx.missions.sweep()
    expect(recovered).toMatchObject({ considered: 1, resumed: 1 })
    expect(first.ctx.missions.get(agent)).toMatchObject({ attempts: 1, interruption: { kind: 'request-failed' } })
    await stopHarness(first)
    contexts.splice(contexts.indexOf(first.ctx), 1)

    // Second composition: the deployment routes the recovered work elsewhere.
    const second = await mountHarness({
      root,
      script: [textResponse('continued on another model')],
      driver: true,
      provider: 'backup',
      config: { sweepOnStartup: false },
    })
    contexts.push(second.ctx)
    const backup = new ScriptedAdapter([textResponse('continued on another model'), textResponse('done')])
    second.ctx.llm.registerAdapter(['backup'], backup)
    const report = await second.ctx.missions.sweep()
    expect(report).toMatchObject({ considered: 1, resumed: 1 })
    await waitFor(() => backup.requests.some(request => requestText(request).includes('<mission_recovery ')))
    // The new provider received the durable objective, not a fresh instruction.
    const resumedText = backup.requests.map(request => requestText(request)).join('\n')
    expect(resumedText).toContain('finish the migration')
    expect(resumedText).toContain('migration test passes')
    const resumed = second.ctx.agents.get(SessionId('mission-session'))!
    // The same mission identity survived both failures; only the route changed.
    expect(second.ctx.missions.get(resumed)).toMatchObject({
      id: started.id,
      attempts: 2,
      interruption: { kind: 'process-restart' },
    })
    await second.ctx.sessions.flush(resumed.session)
    // Only admitted notices are logged history: the first composition was
    // stopped while its notice was still queued behind a running turn.
    expect(countMissionNotices(await readSessionArtifact(root))).toBe(1)
  })
})
