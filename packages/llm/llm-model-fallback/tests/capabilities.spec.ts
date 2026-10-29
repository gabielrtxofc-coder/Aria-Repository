import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
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

function routes(adapter: { requests: GenerateOptions[] }): string[] {
  return adapter.requests.map(request => `${request.provider}/${request.model}`)
}

describe('model-route fallback capability gating', () => {
  it('skips a candidate that cannot honor the configured reasoning effort and takes the next one', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        // Declares reasoning, but not the effort the chain configures.
        secondary: {
          responses: [textResponse('unused')],
          inputModalities: ['text'],
          reasoningEfforts: ['low'],
        },
        tertiary: {
          responses: [textResponse('served with the effort')],
          inputModalities: ['text'],
          reasoningEfforts: ['low', 'max'],
        },
      },
      chain: [
        { ...SECONDARY, reasoningEffort: 'max' },
        { ...TERTIARY, reasoningEffort: 'max' },
      ],
    })
    const agent = await ctx.agentLoop.create(SessionId('effort-gated'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(routes(adapter)).toEqual(['primary/model-a', 'tertiary/model-c'])
    expect(adapter.requests.at(-1)?.reasoningEffort).toBe('max')
    expect(typed(events, 'llm/model-switched')[0]?.data).toMatchObject({
      to: { ...TERTIARY, reasoningEffort: 'max' },
      rejected: [{ route: SECONDARY, reason: 'reasoning-effort-unsupported' }],
    })
    expect(typed(events, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
  })

  it('skips a candidate whose declared context window cannot hold the next request', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: {
          // One served turn establishes the measured input size, then the
          // quota failure forces the switch.
          responses: [textResponse('first'), new LlmError('quota exhausted', 'QUOTA')],
          inputModalities: ['text'],
          contextWindow: 200_000,
        },
        secondary: {
          responses: [textResponse('unused')],
          inputModalities: ['text'],
          // Smaller than the measured input plus the request's output cap.
          contextWindow: 8_192,
        },
        tertiary: { responses: [textResponse('fits the conversation')], inputModalities: ['text'] },
      },
      chain: [SECONDARY, TERTIARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('context-gated'), { ...PRIMARY, maxTokens: 16_384 })
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()
    agent.followup(promptText('again'))
    await agent.whenIdle()

    expect(routes(adapter)).toEqual(['primary/model-a', 'primary/model-a', 'tertiary/model-c'])
    expect(typed(events, 'llm/model-switched')[0]?.data).toMatchObject({
      to: TERTIARY,
      rejected: [{ route: SECONDARY, reason: 'context-window-too-small' }],
    })
  })

  it('requires a candidate that can read a mid-conversation system prompt the history already carries', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: {
          responses: [new LlmError('quota exhausted', 'QUOTA')],
          inputModalities: ['text'],
          systemPromptUpdate: 'in-history',
        },
        secondary: { responses: [textResponse('unused')], inputModalities: ['text'] },
        tertiary: {
          responses: [textResponse('reads the updated prompt')],
          inputModalities: ['text'],
          systemPromptUpdate: 'in-history',
        },
      },
      chain: [SECONDARY, TERTIARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('prompt-format-gated'), PRIMARY)
    const events = recordEvents(ctx, agent)
    // The session's retained history carries a system prompt after the first
    // message, which only an in-history reader can honor.
    agent.session.append('system/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'system-update' as never,
        role: 'system',
        content: [{ type: 'text', text: 'an updated system prompt' }],
        source: { kind: 'system-prompt' },
      },
    } as never, { surfaceOp: 'append' })

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(routes(adapter)).toEqual(['primary/model-a', 'tertiary/model-c'])
    expect(typed(events, 'llm/model-switched')[0]?.data).toMatchObject({
      to: TERTIARY,
      rejected: [{ route: SECONDARY, reason: 'prompt-format-mismatch' }],
    })
  })

  it('keeps an incompatible candidate from ending the chain under the production selection path', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: {
          responses: [new LlmError('quota exhausted', 'QUOTA')],
          inputModalities: ['text', 'image'],
        },
        'text-only': { responses: [textResponse('unused')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('continued')], inputModalities: ['text', 'image'] },
      },
      chain: [{ provider: 'text-only', model: 'model-t' }, SECONDARY],
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('incompatible-middle'),
      agentOptions: PRIMARY,
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: PRIMARY, assembled: undefined })
      },
    })

    handle.agent.followup(createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: `sha256:${'c'.repeat(64)}` as never,
          mediaType: 'image/png',
          bytes: 8,
          width: 1,
          height: 1,
        },
      }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    expect(routes(adapter)).toEqual(['primary/model-a', 'secondary/model-b'])
    expect(handle.agent.session.requestHeader()?.config).toMatchObject(SECONDARY)
  })

  it('propagates cancellation instead of reporting the candidate as unknown', async () => {
    const { ctx } = await harness({
      routes: { primary: { responses: [], inputModalities: ['text'] } },
    })
    const agent = await ctx.agentLoop.create(SessionId('cancelled-lookup'), PRIMARY)
    agent.session.append('request/header', { header: { config: PRIMARY }, reason: 'initial' })
    const aborted = new AbortController()
    aborted.abort()

    const action = await agentEvents(ctx, agent).waterfall(
      'agent/request-error',
      {
        turn: 1,
        step: 1,
        provider: PRIMARY.provider,
        failure: { message: 'quota exhausted', code: 'QUOTA' },
        retryPolicy: undefined,
        signal: aborted.signal,
      },
      () => Promise.resolve(undefined),
    )
    expect(action).toBeUndefined()
  })

  it('carries the selected reasoning effort into the resumed route', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: {
          responses: [new LlmError('quota exhausted', 'QUOTA')],
          inputModalities: ['text'],
          reasoningEfforts: ['low', 'high'],
        },
        secondary: {
          responses: [textResponse('done')],
          inputModalities: ['text'],
          reasoningEfforts: ['low', 'high'],
        },
      },
      chain: [{ ...SECONDARY, reasoningEffort: 'high' }],
    })
    const agent = await ctx.agentLoop.create(SessionId('effort-on-route'), {
      ...PRIMARY,
      reasoningEffort: ReasoningEffortId('low'),
    })
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.reasoningEffort])).toEqual([
      ['primary', 'low'],
      ['secondary', 'high'],
    ])
    expect(typed(events, 'llm/model-switched')[0]?.data.to).toEqual({ ...SECONDARY, reasoningEffort: 'high' })
  })
})
