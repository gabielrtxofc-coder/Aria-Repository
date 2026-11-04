/**
 * Durable failures never look like success. Every path that cannot prove the
 * state reached the medium reports a structured failure and leaves a visible
 * blocker instead of claiming the mission advanced.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MissionError } from '../src/index.ts'
import { createAgent, mountHarness, tempRoot, textResponse } from './harness.ts'

const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

/** Mount one composition rooted at a fresh durable directory. */
async function mount() {
  const { root, cleanup } = await tempRoot('dsh-mission-durability-')
  cleanups.push(cleanup)
  const harness = await mountHarness({
    root,
    script: [textResponse('ok'), textResponse('ok')],
    config: { sweepOnStartup: false },
  })
  contexts.push(harness.ctx)
  return { harness, root, agent: await createAgent(harness) }
}

describe('persistence failures', () => {
  it('reports a failed checkpoint flush instead of claiming durability', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, {
      objective: 'durable checkpoint',
      completionCriteria: ['flushed'],
    })
    const failure = new Error('disk is read-only')
    vi.spyOn(harness.ctx.sessions, 'flush').mockRejectedValue(failure)
    await expect(harness.ctx.missions.checkpoint(agent, started))
      .rejects.toMatchObject({ code: 'MISSION_PERSISTENCE_FAILED' })
    // The index was not refreshed, so nothing claims the checkpoint is durable.
    const row = await harness.ctx.missions.ledger.list()
    expect(row[0]?.revision).toBe(started.revision)
  })

  it('reports a failed attempt flush and keeps the recorded attempt visible', async () => {
    const { harness, agent } = await mount()
    const started = await harness.ctx.missions.start(agent, {
      objective: 'durable attempt',
      completionCriteria: ['flushed'],
    })
    vi.spyOn(harness.ctx.sessions, 'flush').mockRejectedValue(new Error('write failed'))
    await expect(harness.ctx.missions.recordAttempt(agent, started, {
      interruption: { kind: 'process-restart', at: 1 },
    })).rejects.toBeInstanceOf(MissionError)
    const current = harness.ctx.missions.get(agent)!
    expect(current.attempts).toBe(1)
    expect((await harness.ctx.missions.ledger.list())[0]?.attempts).toBe(started.attempts)
  })

  it('refuses to start a mission whose discovery row cannot be written', async () => {
    const { harness, agent } = await mount()
    vi.spyOn(harness.ctx.missions.ledger, 'put').mockRejectedValue(new Error('domain closed'))
    await expect(harness.ctx.missions.start(agent, { objective: 'index failure', completionCriteria: ['x'] }))
      .rejects.toMatchObject({ code: 'MISSION_PERSISTENCE_FAILED' })
    // No record was appended, and the durable objective cannot look healthy.
    expect(harness.ctx.missions.get(agent)).toBeUndefined()
    expect(harness.ctx.goals.get(agent)).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'mission-index-failed' },
    })
  })

  it('drops the index row and blocks the objective when the record cannot be appended', async () => {
    const { harness, agent } = await mount()
    const append = agent.session.append.bind(agent.session)
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, data: unknown) => {
      if (type === 'mission/change') throw new Error('append refused')
      return append(type as never, data as never)
    }) as typeof agent.session.append)
    await expect(harness.ctx.missions.start(agent, { objective: 'append failure', completionCriteria: ['x'] }))
      .rejects.toThrow('append refused')
    expect(await harness.ctx.missions.ledger.list()).toHaveLength(0)
    expect(harness.ctx.goals.get(agent)).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'mission-record-failed' },
    })
  })
})

describe('malformed durable records', () => {
  it('refuses to open a corrupted discovery row instead of dropping it silently', async () => {
    const { root, cleanup } = await tempRoot('dsh-mission-corrupt-')
    cleanups.push(cleanup)
    const first = await mountHarness({
      root,
      script: [],
      config: { sweepOnStartup: false },
    })
    contexts.push(first.ctx)
    const agent = await createAgent(first)
    await first.ctx.missions.start(agent, { objective: 'corrupt me', completionCriteria: ['x'] })
    await first.ctx.missions.ledger.close()
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    // Corrupt the stored row the way an interrupted write would.
    const path = join(root, 'storages', 'mission_continuity.json')
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      tables: Record<string, Record<string, Record<string, unknown>>>
    }
    const table = stored.tables['recoveries']!
    const key = Object.keys(table)[0]!
    table[key] = { ...table[key]!, state: 'sometimes' }
    await writeFile(path, JSON.stringify(stored))

    await expect(mountHarness({ root, script: [], config: { sweepOnStartup: false } }))
      .rejects.toThrow(/domain 'mission_continuity': stored record/)
  })
})
