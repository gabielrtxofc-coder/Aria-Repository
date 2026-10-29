import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mountFallbackHarness, promptText, textResponse } from './harness.ts'

const PRIMARY = { provider: 'primary', model: 'model-a' }
const SECONDARY = { provider: 'secondary', model: 'model-b' }
const TERTIARY = { provider: 'tertiary', model: 'model-c' }

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(options: Parameters<typeof mountFallbackHarness>[0]) {
  const mounted = await mountFallbackHarness(options)
  contexts.push(mounted.ctx)
  return mounted
}

/**
 * Create one Agent exactly the way a shipped entry point does: the entry point
 * owns a mutable selection and installs it, so prompt assembly, the request
 * header, and the switch notice all pass through the production selection path.
 */
async function createWithEntryPointSelection(
  ctx: Context,
  id: string,
  requested: { provider: string, model: string },
): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: requested,
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: requested, assembled: undefined })
    },
  })
  return handle.agent
}

function recordEvents(ctx: Context, agent: Agent): SessionEvent[] {
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => {
    if (session === agent.session) events.push(event)
  })
  return events
}

function typed<Type extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: Type,
): Extract<SessionEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: Type }> => event.type === type)
}

describe('model-route fallback with an entry-point model selection', () => {
  it('walks the whole chain A to B to C instead of returning to the failed entry route', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        tertiary: { responses: [textResponse('served by the third route')], inputModalities: ['text'] },
      },
      chain: [SECONDARY, TERTIARY],
    })
    const agent = await createWithEntryPointSelection(ctx, 'entry-chain-descent', PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'primary/model-a',
      'secondary/model-b',
      'tertiary/model-c',
    ])
    const switches = typed(events, 'llm/model-switched')
    expect(switches.map(event => event.data.to)).toEqual([SECONDARY, TERTIARY])
    expect(typed(events, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
    // The recovery override still stands in for the entry point's own route.
    expect(ctx.get('modelRouting')?.overrideFor(agent.ctx)).toMatchObject({
      route: TERTIARY,
      replaces: PRIMARY,
    })
  })

  it('keeps serving the recovered route on the following turn', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        tertiary: { responses: [textResponse('first'), textResponse('second')], inputModalities: ['text'] },
      },
      chain: [SECONDARY, TERTIARY],
    })
    const agent = await createWithEntryPointSelection(ctx, 'entry-next-turn', PRIMARY)

    agent.followup(promptText('first'))
    await agent.whenIdle()
    agent.followup(promptText('second'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => `${request.provider}/${request.model}`)).toEqual([
      'primary/model-a',
      'secondary/model-b',
      'tertiary/model-c',
      'tertiary/model-c',
    ])
  })
})
