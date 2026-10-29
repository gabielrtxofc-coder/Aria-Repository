import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelFallbackState, ModelSwitchedEventData } from '../src/index.ts'
import { mountFallbackHarness, promptText, textResponse, toolCallResponse } from './harness.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(options: Parameters<typeof mountFallbackHarness>[0]) {
  const mounted = await mountFallbackHarness(options)
  contexts.push(mounted.ctx)
  return mounted
}

/** Collect every session event one Agent commits, in order. */
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

const PRIMARY = { provider: 'primary', model: 'model-a' }
const SECONDARY = { provider: 'secondary', model: 'model-b' }

describe('model-route fallback', () => {
  it('serves a healthy request without switching', async () => {
    const { ctx, adapter } = await harness({
      routes: { primary: { responses: [textResponse('done')], inputModalities: ['text'] } },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('healthy'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary'])
    expect(typed(events, 'llm/model-switched')).toHaveLength(0)
    expect(typed(events, 'llm/model-fallback-exhausted')).toHaveLength(0)
    expect(ctx.sessionProjections.stateOf(agent.session, 'llmModelFallback')).toEqual({
      active: null,
      turn: 1,
      attempted: [],
      switches: 0,
      paused: null,
      interrupted: null,
      recoveryAttempts: 0,
      observedInputTokens: 10,
    })
  })

  it('continues a five-step task on another model after the quota is exhausted', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: {
          responses: [
            toolCallResponse('call-1', 'probe', {}),
            toolCallResponse('call-2', 'probe', {}),
            toolCallResponse('call-3', 'probe', {}),
            toolCallResponse('call-4', 'probe', {}),
            new LlmError('insufficient quota', 'QUOTA', { status: 402 }),
          ],
          inputModalities: ['text'],
        },
        secondary: { responses: [textResponse('task complete')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
      probeTool: true,
      switchIds: ['switch-1'],
    })
    const agent = await ctx.agentLoop.create(SessionId('quota-switch'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('run the five-step task'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual([
      'primary', 'primary', 'primary', 'primary', 'primary', 'secondary',
    ])
    expect(adapter.requests.at(-1)?.model).toBe('model-b')

    const [switched] = typed(events, 'llm/model-switched')
    expect(switched?.data).toMatchObject({
      switchId: 'switch-1',
      turn: 1,
      step: 5,
      category: 'quota',
      from: PRIMARY,
      to: SECONDARY,
      rejected: [],
      failure: { code: 'QUOTA' },
    } satisfies Partial<ModelSwitchedEventData>)

    // The four completed steps and their results survive the switch unchanged.
    expect(typed(events, 'tool/call')).toHaveLength(4)
    expect(typed(events, 'tool/result')).toHaveLength(4)
    expect(typed(events, 'user/message')).toHaveLength(1)
    const assistant = typed(events, 'assistant/message')
    expect(assistant.map(event => event.data.message.source)).toMatchObject([
      { provider: 'primary', model: 'model-a' },
      { provider: 'primary', model: 'model-a' },
      { provider: 'primary', model: 'model-a' },
      { provider: 'primary', model: 'model-a' },
      { provider: 'secondary', model: 'model-b' },
    ])
    expect(typed(events, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })

    // The switch is durable, non-model-visible, and the recorded header follows it.
    expect(ctx.sessionProjections.stateOf(agent.session, 'llmModelFallback')).toEqual({
      active: { route: SECONDARY, replaces: PRIMARY, previous: PRIMARY },
      turn: 1,
      attempted: [PRIMARY, SECONDARY],
      switches: 1,
      paused: null,
      interrupted: null,
      recoveryAttempts: 0,
      observedInputTokens: 10,
    } satisfies ModelFallbackState)
    expect(agent.session.requestHeader()?.config).toMatchObject(SECONDARY)
    expect(agent.session.deriveMessages().some(message => JSON.stringify(message).includes('model-switched')))
      .toBe(false)
  })

  it('keeps the recovered route for the following turn without asking the exhausted model again', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: {
          responses: [new LlmError('quota exhausted', 'QUOTA')],
          inputModalities: ['text'],
        },
        secondary: { responses: [textResponse('first answer'), textResponse('second answer')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('sticky-route'), PRIMARY)

    agent.followup(promptText('first'))
    await agent.whenIdle()
    agent.followup(promptText('second'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => (`${request.provider}/${request.model}`))).toEqual([
      'primary/model-a',
      'secondary/model-b',
      'secondary/model-b',
    ])
  })

  it('leaves a transient limit to the retry policy instead of switching models', async () => {
    const { ctx, adapter } = await harness({
      retry: true,
      routes: {
        primary: {
          responses: [new LlmError('busy', 'RATE_LIMIT', { status: 429 }), textResponse('recovered')],
          inputModalities: ['text'],
          retryPolicy: {
            mode: 'normal',
            maxRetries: 1,
            retryableCodes: ['RATE_LIMIT'],
            backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        },
        secondary: { responses: [textResponse('unused')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('transient-retry'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary', 'primary'])
    expect(typed(events, 'llm/retry')).toHaveLength(1)
    expect(typed(events, 'llm/model-switched')).toHaveLength(0)
    expect(typed(events, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
  })

  it('switches only after the retry budget is exhausted', async () => {
    const { ctx, adapter } = await harness({
      retry: true,
      routes: {
        primary: {
          responses: [
            new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
            new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
          ],
          inputModalities: ['text'],
          retryPolicy: {
            mode: 'normal',
            maxRetries: 1,
            retryableCodes: ['RATE_LIMIT'],
            backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        },
        secondary: { responses: [textResponse('served elsewhere')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('retry-then-switch'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary', 'primary', 'secondary'])
    expect(typed(events, 'llm/retry')).toHaveLength(1)
    expect(typed(events, 'llm/model-switched')[0]?.data).toMatchObject({
      category: 'transient',
      from: PRIMARY,
      to: SECONDARY,
    })
  })

  it('never treats an authentication failure as a rate limit', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('invalid api key', 'AUTH', { status: 401 })], inputModalities: ['text'] },
        secondary: { responses: [textResponse('unused')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('auth-terminal'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary'])
    expect(typed(events, 'llm/model-switched')).toHaveLength(0)
    expect(typed(events, 'llm/model-fallback-exhausted')).toHaveLength(0)
    expect(typed(events, 'turn/end')[0]?.data.reason).toMatchObject({
      kind: 'error',
      error: { code: 'AUTH' },
    })
  })

  it('switches after an authentication failure only when that category is configured', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('invalid api key', 'AUTH', { status: 401 })], inputModalities: ['text'] },
        secondary: { responses: [textResponse('served by another provider')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
      switchOn: ['auth'],
    })
    const agent = await ctx.agentLoop.create(SessionId('auth-opt-in'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary', 'secondary'])
    expect(typed(events, 'llm/model-switched')[0]?.data).toMatchObject({ category: 'auth', to: SECONDARY })
  })

  it('skips a candidate whose declared capabilities cannot accept the retained conversation', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: {
          responses: [new LlmError('quota exhausted', 'QUOTA')],
          inputModalities: ['text', 'image'],
        },
        'text-only': { responses: [textResponse('unused')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('handled the image')], inputModalities: ['text', 'image'] },
      },
      chain: [
        { provider: 'text-only', model: 'model-t' },
        SECONDARY,
      ],
    })
    const agent = await ctx.agentLoop.create(SessionId('capability-skip'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png',
          bytes: 12,
          width: 1,
          height: 1,
        },
      }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary', 'secondary'])
    expect(typed(events, 'llm/model-switched')[0]?.data).toMatchObject({
      to: SECONDARY,
      rejected: [{ route: { provider: 'text-only', model: 'model-t' }, reason: 'capability-mismatch' }],
    })
  })

  it('pauses safely when no configured alternative can serve the request', async () => {
    const { ctx, adapter } = await harness({
      routes: { primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] } },
      chain: [{ provider: 'offline', model: 'model-c' }, PRIMARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('exhausted'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary'])
    const [exhausted] = typed(events, 'llm/model-fallback-exhausted')
    expect(exhausted?.data).toMatchObject({
      turn: 1,
      step: 1,
      category: 'quota',
      attempted: [],
      rejected: [
        { route: { provider: 'offline', model: 'model-c' }, reason: 'provider-unregistered' },
        { route: PRIMARY, reason: 'already-attempted' },
      ],
    })
    expect(typed(events, 'turn/end')[0]?.data.reason).toMatchObject({ kind: 'error', error: { code: 'QUOTA' } })
    expect(ctx.sessionProjections.stateOf(agent.session, 'llmModelFallback')).toMatchObject({
      active: null,
      paused: { turn: 1, step: 1, category: 'quota' },
    })
  })

  it('honors a zero switch allowance', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('unused')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
      maxSwitchesPerTurn: 0,
    })
    const agent = await ctx.agentLoop.create(SessionId('no-switches'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary'])
    expect(typed(events, 'llm/model-switched')).toHaveLength(0)
    expect(typed(events, 'turn/end')[0]?.data.reason).toMatchObject({ kind: 'error' })
  })

  it('delegates every failure when the chain is empty', async () => {
    const { ctx, adapter } = await harness({
      routes: { primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] } },
      chain: [],
    })
    const agent = await ctx.agentLoop.create(SessionId('empty-chain'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary'])
    expect(typed(events, 'llm/model-fallback-exhausted')).toHaveLength(0)
    expect(typed(events, 'turn/end')[0]?.data.reason).toMatchObject({ kind: 'error', error: { code: 'QUOTA' } })
  })

  it('rejects an invalid configuration at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(mountFallbackHarness({
      ctx,
      routes: { primary: { responses: [textResponse('unused')], inputModalities: ['text'] } },
      chain: [SECONDARY, SECONDARY],
      // Cordis reports a synchronous load failure through its own error path,
      // so the assertion is that loading rejects at all; the message itself is
      // covered by the policy unit tests.
    })).rejects.toThrow()
  })
})
