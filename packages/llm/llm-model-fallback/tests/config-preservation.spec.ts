/**
 * The recovered route's call configuration must reproduce the routing decision
 * across a restart — without overriding a later user choice.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mountFallbackHarness, promptText, textResponse } from './harness.ts'

const PRIMARY = { provider: 'primary', model: 'model-a' }
const SECONDARY = { provider: 'secondary', model: 'model-b' }
const SESSION = SessionId('fallback-config-preservation')

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function persistenceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fallback-config-'))
  roots.push(root)
  return root
}

/** Route and effort pairs, in dispatch order. */
function calls(adapter: { requests: GenerateOptions[] }): (string | undefined)[][] {
  return adapter.requests.map(request => [`${request.provider}/${request.model}`, request.reasoningEffort])
}

function recorded<Type extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: Type,
): Extract<SessionEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: Type }> => event.type === type)
}

describe('model-route fallback configuration preservation', () => {
  it('reuses the exact reasoning configuration the recovered route used before the restart', async () => {
    const root = await persistenceRoot()
    const efforts = ['low', 'high', 'max']
    const first = await mountFallbackHarness({
      persistenceRoot: root,
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'], reasoningEfforts: efforts },
        secondary: { responses: [textResponse('answered by the alternative')], inputModalities: ['text'], reasoningEfforts: efforts },
      },
      // The alternative is configured with its own effort, which is NOT the
      // effort the entry route was using.
      chain: [{ ...SECONDARY, reasoningEffort: 'max' }],
    })
    const agent = await first.ctx.agentLoop.create(SESSION, {
      ...PRIMARY,
      reasoningEffort: ReasoningEffortId('high'),
    })
    const before: SessionEvent[] = []
    first.ctx.on('session/event', (session, event) => {
      if (session === agent.session) before.push(event)
    })
    agent.followup(promptText('first request'))
    await agent.whenIdle()

    const usedBefore = calls(first.adapter)
    expect(usedBefore).toEqual([['primary/model-a', 'high'], ['secondary/model-b', 'max']])
    // The durable switch record carries the effort, so a reader can reproduce
    // the decision without guessing.
    expect(recorded(before, 'llm/model-switched')[0]?.data.to).toEqual({ ...SECONDARY, reasoningEffort: 'max' })
    expect(first.ctx.sessionProjections.stateOf(agent.session, 'llmModelFallback'))
      .toMatchObject({ active: { route: { ...SECONDARY, reasoningEffort: 'max' } } })
    await first.ctx.fiber.dispose()

    const second = await mountFallbackHarness({
      persistenceRoot: root,
      routes: {
        primary: { responses: [], inputModalities: ['text'], reasoningEfforts: efforts },
        secondary: { responses: [textResponse('continued')], inputModalities: ['text'], reasoningEfforts: efforts },
      },
      chain: [{ ...SECONDARY, reasoningEffort: 'max' }],
    })
    const resumed = await second.ctx.agents.resume({
      resumeSessionId: SESSION,
      agentOptions: { ...PRIMARY, reasoningEffort: ReasoningEffortId('high') },
    })
    resumed.agent.followup(promptText('second request'))
    await resumed.agent.whenIdle()

    // The route AND the effort are the ones actually in use before the restart.
    expect(calls(second.adapter)).toEqual([usedBefore.at(-1)])
    await resumed.dispose()
    await second.ctx.fiber.dispose()
  })

  it('lets a later user selection replace the recovered configuration', async () => {
    const root = await persistenceRoot()
    const efforts = ['low', 'high', 'max']
    const first = await mountFallbackHarness({
      persistenceRoot: root,
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'], reasoningEfforts: efforts },
        secondary: { responses: [textResponse('answered by the alternative'), textResponse('answered by the alternative')], inputModalities: ['text'], reasoningEfforts: efforts },
      },
      chain: [{ ...SECONDARY, reasoningEffort: 'max' }],
    })
    const agent = await first.ctx.agentLoop.create(SESSION, {
      ...PRIMARY,
      reasoningEffort: ReasoningEffortId('high'),
    })
    agent.followup(promptText('first request'))
    await agent.whenIdle()
    expect(calls(first.adapter).at(-1)).toEqual(['secondary/model-b', 'max'])
    await first.ctx.fiber.dispose()

    const second = await mountFallbackHarness({
      persistenceRoot: root,
      routes: {
        primary: { responses: [], inputModalities: ['text'], reasoningEfforts: efforts },
        secondary: { responses: [textResponse('user choice'), textResponse('still the user choice')], inputModalities: ['text'], reasoningEfforts: efforts },
      },
      chain: [{ ...SECONDARY, reasoningEffort: 'max' }],
    })
    // The product installs the selection mechanism on the resumed agent; the
    // user's choice reaches the request through it.
    const selection = {
      current: { ...PRIMARY, reasoningEffort: ReasoningEffortId('high') },
      assembled: undefined,
    }
    const resumed = await second.ctx.agents.resume({
      resumeSessionId: SESSION,
      agentOptions: { ...PRIMARY, reasoningEffort: ReasoningEffortId('high') },
      setup: (agentCtx) => { installModelSelection(agentCtx, selection) },
    })
    // The user picks a lower effort on the recovered route; the recorded
    // recovery must not override that decision on the following turn.
    selection.current = { ...SECONDARY, reasoningEffort: ReasoningEffortId('low') }
    resumed.agent.session.append('model/selection', { ...SECONDARY, reasoningEffort: 'low' })
    resumed.agent.followup(promptText('use a cheaper effort'))
    await resumed.agent.whenIdle()

    expect(calls(second.adapter).at(-1)).toEqual(['secondary/model-b', 'low'])
    resumed.agent.followup(promptText('and keep it'))
    await resumed.agent.whenIdle()
    expect(calls(second.adapter).at(-1)).toEqual(['secondary/model-b', 'low'])
    await resumed.dispose()
    await second.ctx.fiber.dispose()
  })
})
