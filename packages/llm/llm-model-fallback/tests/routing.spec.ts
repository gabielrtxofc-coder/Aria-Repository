import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as fallback from '../src/index.ts'
import { mountFallbackHarness, promptText, textResponse } from './harness.ts'

// The entry point that records `model/selection` is a separate package this
// one deliberately does not depend on; the suite declares the log-only event it
// reacts to instead of importing that controller.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'model/selection': { provider: string; model: string }
  }
}

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

/** Dispatch one request failure through the Agent's real waterfall. */
function fail(
  ctx: Context,
  agent: Agent,
  overrides: { turn?: number, step?: number, provider?: string, code?: string, signal?: AbortSignal } = {},
) {
  const failure = { message: overrides.code ?? 'QUOTA', code: overrides.code ?? 'QUOTA' }
  return agentEvents(ctx, agent).waterfall(
    'agent/request-error',
    {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      provider: overrides.provider ?? PRIMARY.provider,
      failure,
      retryPolicy: undefined,
      signal: overrides.signal ?? new AbortController().signal,
    },
    () => Promise.resolve(undefined),
  )
}

describe('model-route fallback routing', () => {
  it('moves down the configured chain when the first alternative also fails', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        tertiary: { responses: [textResponse('served by the third route')], inputModalities: ['text'] },
      },
      chain: [SECONDARY, TERTIARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('chain-descent'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary', 'secondary', 'tertiary'])
    const switches = typed(events, 'llm/model-switched')
    expect(switches.map(event => event.data.to)).toEqual([SECONDARY, TERTIARY])
    expect(switches.map(event => event.data.from)).toEqual([PRIMARY, SECONDARY])
    expect(typed(events, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
  })

  it('stops switching once the per-turn allowance is spent', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        tertiary: { responses: [textResponse('unused')], inputModalities: ['text'] },
      },
      chain: [SECONDARY, TERTIARY],
      maxSwitchesPerTurn: 1,
    })
    const agent = await ctx.agentLoop.create(SessionId('switch-allowance'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['primary', 'secondary'])
    expect(typed(events, 'llm/model-switched')).toHaveLength(1)
    expect(typed(events, 'turn/end')[0]?.data.reason).toMatchObject({ kind: 'error', error: { code: 'QUOTA' } })
  })

  it('keeps the request controls of the failed route while replacing its route', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('done')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('controls'), {
      ...PRIMARY,
      maxTokens: 256,
    })
    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.at(-1)).toMatchObject({
      provider: SECONDARY.provider,
      model: SECONDARY.model,
      maxTokens: 256,
    })
  })

  it('releases the recovery route when the session records another selection', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: {
          responses: [new LlmError('quota exhausted', 'QUOTA'), new LlmError('quota exhausted again', 'QUOTA')],
          inputModalities: ['text'],
        },
        secondary: { responses: [textResponse('first answer')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('explicit-selection'), PRIMARY)

    agent.followup(promptText('first'))
    await agent.whenIdle()
    expect(ctx.get('modelRouting')?.overrideFor(agent.ctx)).toMatchObject({ route: SECONDARY, replaces: PRIMARY })

    // An entry point records its own choice; the recovery route yields to it.
    agent.session.append('model/selection', PRIMARY)
    expect(ctx.get('modelRouting')?.overrideFor(agent.ctx)).toBeUndefined()

    agent.followup(promptText('second'))
    await agent.whenIdle()
    // The entry point owns routing again: the recorded header, not the override.
    expect(adapter.requests.map(request => request.provider)).toEqual(['primary', 'secondary', 'secondary'])
    expect(ctx.get('modelRouting')?.overrideFor(agent.ctx)).toBeUndefined()
  })

  it('serves the request from the recovered route when the entry point still selects the failed one', async () => {
    const { ctx, adapter } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('done')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('override-request'), PRIMARY)

    agent.followup(promptText('go'))
    await agent.whenIdle()
    // The recovered route is in force for subsequent requests of this Agent.
    const config: LlmCallConfig = await agentEvents(ctx, agent).waterfall(
      'agent/request',
      { turn: 2, step: 0, signal: new AbortController().signal },
      () => Promise.resolve({ ...PRIMARY }),
    )
    expect(config).toMatchObject(SECONDARY)
    expect(adapter.requests.map(request => request.provider)).toEqual(['primary', 'secondary'])
  })

  it('records one exhausted pause per failed step', async () => {
    const { ctx } = await harness({
      routes: { primary: { responses: [], inputModalities: ['text'] } },
      chain: [{ provider: 'offline', model: 'model-c' }],
    })
    const agent = await ctx.agentLoop.create(SessionId('dedup-pause'), PRIMARY)
    agent.session.append('request/header', { header: { config: PRIMARY }, reason: 'initial' })
    const events = recordEvents(ctx, agent)

    expect(await fail(ctx, agent)).toBeUndefined()
    expect(await fail(ctx, agent)).toBeUndefined()

    expect(typed(events, 'llm/model-fallback-exhausted')).toHaveLength(1)
    expect(typed(events, 'llm/model-fallback-exhausted')[0]?.data).toMatchObject({
      turn: 1,
      step: 1,
      category: 'quota',
      rejected: [{ route: { provider: 'offline', model: 'model-c' }, reason: 'provider-unregistered' }],
    })
  })

  it('ignores a failure without a request header, for another provider, or after cancellation', async () => {
    const { ctx } = await harness({
      routes: {
        primary: { responses: [], inputModalities: ['text'] },
        secondary: { responses: [], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('no-header'), PRIMARY)

    // No request has been logged yet, so there is no route to replace.
    expect(await fail(ctx, agent)).toBeUndefined()
    expect(agent.session.requestHeader()).toBeUndefined()

    agent.session.append('request/header', {
      header: { config: PRIMARY },
      reason: 'initial',
    })
    expect(await fail(ctx, agent, { provider: SECONDARY.provider })).toBeUndefined()
    const aborted = new AbortController()
    aborted.abort()
    expect(await fail(ctx, agent, { signal: aborted.signal })).toBeUndefined()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/model-switched')).toHaveLength(0)
  })
})

describe('model-route fallback durable state', () => {
  it('mints a fresh switch identity when no hook is installed', async () => {
    const { ctx } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('done')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('minted-id'), PRIMARY)
    const events = recordEvents(ctx, agent)

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(typed(events, 'llm/model-switched')[0]?.data.switchId)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('carries the configured reasoning effort onto the recovered route', async () => {
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
    const agent = await ctx.agentLoop.create(SessionId('reasoning-effort'), {
      ...PRIMARY,
      reasoningEffort: ReasoningEffortId('low'),
    })

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(adapter.requests.map(request => [request.provider, request.reasoningEffort])).toEqual([
      ['primary', 'low'],
      ['secondary', 'high'],
    ])
  })

  it('clears a recorded route when another actor selects a model or logs another route', async () => {
    const { ctx } = await harness({
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('done')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await ctx.agentLoop.create(SessionId('cleared-route'), PRIMARY)

    // A selection record without a recorded switch leaves the state untouched.
    agent.session.append('model/selection', PRIMARY)
    expect(ctx.sessionProjections.stateOf(agent.session, 'llmModelFallback')).toMatchObject({ active: null })

    agent.followup(promptText('go'))
    await agent.whenIdle()
    expect(ctx.get('modelRouting')?.overrideFor(agent.ctx)).toBeDefined()

    agent.session.append('request/header', { header: { config: PRIMARY }, reason: 'change' })
    expect(ctx.sessionProjections.stateOf(agent.session, 'llmModelFallback')).toMatchObject({ active: null })
  })

  it('records a switch for a turn the fold never saw start', async () => {
    const { ctx } = await harness({ routes: { primary: { responses: [], inputModalities: ['text'] } } })
    const agent = await ctx.agentLoop.create(SessionId('unstarted-turn'), PRIMARY)

    agent.session.append('llm/model-switched', {
      switchId: 'manual' as never,
      turn: 7,
      step: 2,
      category: 'quota',
      failure: { message: 'quota exhausted', code: 'QUOTA' },
      from: PRIMARY,
      to: SECONDARY,
      rejected: [],
    })

    // The fold keeps the route but attributes no attempts to a turn it never saw.
    expect(ctx.sessionProjections.stateOf(agent.session, 'llmModelFallback')).toMatchObject({
      active: { route: SECONDARY, replaces: PRIMARY },
      attempted: [],
      switches: 0,
    })
  })
})

describe('model-route fallback disposal', () => {
  it('declines recovery once the plugin has been disposed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountFallbackHarness({
      ctx,
      routes: {
        primary: { responses: [], inputModalities: ['text'] },
        secondary: { responses: [], inputModalities: ['text'] },
      },
      // A chain-less composition still registers the plugin's recovery path.
      chain: [],
    })
    const agent = await ctx.agentLoop.create(SessionId('disposed-plugin'), PRIMARY)
    agent.session.append('request/header', { header: { config: PRIMARY }, reason: 'initial' })

    // HMR disposes one plugin fiber mid-dispatch without tearing down the composition.
    ctx.on('agent/request-error', async (_payload, next) => {
      await fiber.dispose()
      return next()
    })
    const fiber: { dispose(): Promise<void> } = await ctx.plugin(Object.assign(
      (inner: Context) => {
        fallback.apply(inner, { chain: [SECONDARY] })
      },
      { inject: fallback.inject },
    ))

    expect(await fail(ctx, agent)).toBeUndefined()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/model-switched')).toHaveLength(0)
  })
})
