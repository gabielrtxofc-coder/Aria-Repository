/**
 * The shipped `mission/agent-setup` policy: recovery resumes the durable
 * session, and the composition answers how to compose the Agent. This policy
 * answers with the host's own default model selection and never invents one.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/default-agent-plan.ts'
import { defaultAgentOptions } from '../src/default-agent-plan.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A bare composition carrying only the host's default model service. */
async function hostWith(service: unknown): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  if (service !== undefined) {
    ctx.provide('agentDefaultModel', service)
  }
  await ctx.plugin(plugin)
  return ctx
}

/** Ask the composition how to compose one resumed Agent. */
async function plan(ctx: Context) {
  return await ctx.waterfall('mission/agent-setup', { sessionId: SessionId('session-one') }, async () => ({}))
}

describe('mission default agent plan', () => {
  it('fills an unresolved plan with the host default selection', async () => {
    const ctx = await hostWith({
      currentSelection: () => ({ provider: 'host-provider', model: 'host-model', reasoningEffort: 'high' }),
    })
    expect(await plan(ctx)).toEqual({
      agentOptions: { provider: 'host-provider', model: 'host-model', reasoningEffort: 'high' },
    })
  })

  it('omits an absent reasoning effort', async () => {
    const ctx = await hostWith({ currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) })
    expect(await plan(ctx)).toEqual({ agentOptions: { provider: 'host-provider', model: 'host-model' } })
  })

  it('keeps a selection the composition already resolved', async () => {
    const ctx = await hostWith({ currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) })
    const resolved = await ctx.waterfall('mission/agent-setup', { sessionId: SessionId('session-one') }, async () => ({
      agentOptions: { provider: 'pinned', model: 'pinned' },
    }))
    expect(resolved).toEqual({ agentOptions: { provider: 'pinned', model: 'pinned' } })
  })

  it('never invents a route when the host has no default selection', async () => {
    const ctx = await hostWith(undefined)
    expect(defaultAgentOptions(ctx)).toBeUndefined()
    expect(await plan(ctx)).toEqual({})
  })

  it('refuses a host service without a selection reader', async () => {
    const ctx = await hostWith({})
    expect(defaultAgentOptions(ctx)).toBeUndefined()
    expect(await plan(ctx)).toEqual({})
  })

  it('refuses an incomplete or malformed selection', async () => {
    const empty = await hostWith({ currentSelection: () => ({ provider: '  ', model: 'host-model' }) })
    expect(defaultAgentOptions(empty)).toBeUndefined()
    const missing = await hostWith({ currentSelection: () => ({ provider: 'host-provider' }) })
    expect(defaultAgentOptions(missing)).toBeUndefined()
    const wrongType = await hostWith({ currentSelection: () => ({ provider: 'host-provider', model: 'm', reasoningEffort: 7 }) })
    expect(defaultAgentOptions(wrongType)).toEqual({ provider: 'host-provider', model: 'm' })
  })
})
