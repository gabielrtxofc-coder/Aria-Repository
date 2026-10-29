/**
 * The fallback is only useful where Aria actually runs it.
 *
 * These suites read the SHIPPED composition (`packages/bundle/base`, the first
 * patch layer of every base-backed profile), then mount the row exactly as the
 * composition resolves it — once uninterested (the default empty chain), once
 * with a later profile layer naming an alternative. Nothing here re-declares
 * the row: a drift between the composition and the plugin makes the suite fail.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions, PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/index.ts'
import { mountFallbackHarness, promptText, textResponse } from './harness.ts'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const baseDirectory = resolve(repository, 'packages/bundle/base')
const PRIMARY = { provider: 'primary', model: 'model-a' }
const SECONDARY = { provider: 'secondary', model: 'model-b' }

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** The shipped rows of the base composition, in declaration order. */
function shippedRows(): EntryOptions[] {
  const parsed = yaml.load(readFileSync(resolve(baseDirectory, 'cordis.patch.yml'), 'utf8'), {
    schema: entryListSchema,
  })
  if (!Array.isArray(parsed)) throw new TypeError('base patch must be a top-level patch list')
  return (parsed as PatchOptions[]).flatMap(patch => patch.insert ?? [])
}

/** The base row for this plugin, or a failure explaining the mismatch. */
function fallbackRow(): EntryOptions {
  const row = shippedRows().find(candidate => candidate.id === 'llm-model-fallback')
  if (row === undefined) throw new Error('the base composition does not mount llm-model-fallback')
  return row
}

function recorded<Type extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: Type,
): Extract<SessionEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: Type }> => event.type === type)
}

async function mountComposed(row: Config) {
  const harness = await mountFallbackHarness({
    routes: {
      primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
      secondary: { responses: [textResponse('served by the alternative')], inputModalities: ['text'] },
    },
    ...row,
  })
  contexts.push(harness.ctx)
  return harness
}

describe('the base composition owns the fallback row', () => {
  it('mounts this package by its published name with an inert, configurable chain', () => {
    const row = fallbackRow()
    const manifest = JSON.parse(
      readFileSync(resolve(repository, 'packages/llm/llm-model-fallback/package.json'), 'utf8'),
    ) as { name: string }
    expect(row.name).toBe(manifest.name)
    // The row must be loaded, not optioned off: its state projection and
    // records exist for readers in every shipped product.
    expect(row.disabled).toBeUndefined()
    expect(row.config).toMatchObject({
      chain: [],
      resumeInterruptedTurns: false,
      maxRecoveryAttempts: 1,
    })
  })

  it('declares the package dependency the loader resolves the row through', () => {
    const manifest = JSON.parse(readFileSync(resolve(baseDirectory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-llm-model-fallback')
  })

  it('sits after the retry policy, so a scheduled retry still wins the first decision', () => {
    const ids = shippedRows().map(row => row.id)
    expect(ids.indexOf('llm-retry')).toBeGreaterThan(-1)
    // Row order carries no load semantics, so this pins the documented reading
    // order of the composition rather than an activation order.
    expect(ids.indexOf('llm-model-fallback')).toBeGreaterThan(ids.indexOf('llm-retry'))
  })
})

describe('the composed row behaves as configured', () => {
  it('leaves a quota failure terminal while the chain is empty', async () => {
    const harness = await mountComposed(fallbackRow().config as Config)
    const agent = await harness.ctx.agentLoop.create(SessionId('composed-empty-chain'), PRIMARY)
    const events: SessionEvent[] = []
    harness.ctx.on('session/event', (session, event) => {
      if (session === agent.session) events.push(event)
    })

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(harness.adapter.requests.map(request => request.provider)).toEqual(['primary'])
    expect(recorded(events, 'llm/model-switched')).toEqual([])
    expect(recorded(events, 'turn/end')[0]?.data.reason).toMatchObject({ kind: 'error' })
  })

  it('switches when a later profile layer names the alternative chain', async () => {
    // A deployment configures the SAME row through its own patch layer, exactly
    // as a profile cordis.patch.yml or --patch overlay would.
    const composed = applyEntryPatches(shippedRows(), [{
      id: 'llm-model-fallback',
      config: { ...fallbackRow().config as Record<string, unknown>, chain: [SECONDARY] },
    }], () => { })
    const row = composed.find(entry => entry.id === 'llm-model-fallback')
    if (row === undefined) throw new Error('the profile layer lost the fallback row')

    const harness = await mountComposed(row.config as Config)
    const agent = await harness.ctx.agentLoop.create(SessionId('composed-chain'), PRIMARY)
    const events: SessionEvent[] = []
    harness.ctx.on('session/event', (session, event) => {
      if (session === agent.session) events.push(event)
    })

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(harness.adapter.requests.map(request => request.provider)).toEqual(['primary', 'secondary'])
    expect(recorded(events, 'llm/model-switched')[0]?.data).toMatchObject({ from: PRIMARY, to: SECONDARY })
    expect(recorded(events, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
  })
})
