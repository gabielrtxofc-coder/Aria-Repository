import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  classifyModelFailure,
  requiredInputModalities,
  resolveCandidates,
  resolveModelFallbackPolicy,
  routeKey,
  sameRoute,
  selectionOf,
} from '../src/index.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ModelFailureCategory, ModelFallbackCandidateConfig } from '../src/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ScriptedAdapter, textResponse } from './harness.ts'

class UnknownModelAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.reject(new Error(`no such model ${provider}/${model}`))
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('unused')
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function failure(code: string, message = code, status?: number): LlmFailure {
  return { code, message, ...status === undefined ? {} : { status } }
}

describe('classifyModelFailure()', () => {
  it('routes retryable and route-fatal failures to distinct categories', () => {
    expect(classifyModelFailure(failure('RATE_LIMIT', 'busy'))).toBe('transient')
    expect(classifyModelFailure(failure('TIMEOUT'))).toBe('transient')
    expect(classifyModelFailure(failure('EMPTY_RESPONSE'))).toBe('transient')
    expect(classifyModelFailure(failure('SERVER'))).toBe('unavailable')
    expect(classifyModelFailure(failure('OVERLOADED'))).toBe('unavailable')
    expect(classifyModelFailure(failure('QUOTA'))).toBe('quota')
    expect(classifyModelFailure(failure('ACCOUNT_QUOTA'))).toBe('quota')
    expect(classifyModelFailure(failure('AUTH'))).toBe('auth')
    expect(classifyModelFailure(failure('MISSING_CREDENTIAL'))).toBe('auth')
    expect(classifyModelFailure(failure('INVALID_CREDENTIAL'))).toBe('auth')
    expect(classifyModelFailure(failure('CONTEXT_WINDOW_EXCEEDED'))).toBe('context')
    expect(classifyModelFailure(failure('NO_ADAPTER'))).toBe('configuration')
    expect(classifyModelFailure(failure('SOMETHING_NEW'))).toBe('unknown')
  })

  it('falls back to HTTP status when the code carries no class', () => {
    expect(classifyModelFailure(failure('PROVIDER_SPECIFIC', 'too many requests', 429))).toBe('transient')
    expect(classifyModelFailure(failure('PROVIDER_SPECIFIC', 'gateway down', 503))).toBe('unavailable')
    expect(classifyModelFailure(failure('PROVIDER_SPECIFIC', 'unauthorized', 401))).toBe('auth')
    expect(classifyModelFailure(failure('PROVIDER_SPECIFIC', 'payment required', 402))).toBe('billing')
  })

  it('recognizes provider quota wording without a distinct code', () => {
    expect(classifyModelFailure(failure('PROVIDER_SPECIFIC', 'insufficient balance'))).toBe('quota')
    expect(classifyModelFailure(failure('PROVIDER_SPECIFIC', 'quota exceeded for this month'))).toBe('quota')
    expect(classifyModelFailure(failure('PROVIDER_SPECIFIC', 'insufficient credits'))).toBe('quota')
  })
})

describe('resolveModelFallbackPolicy()', () => {
  it('defaults the switch categories and bounds switches by the chain length', () => {
    const policy = resolveModelFallbackPolicy({
      chain: [{ provider: 'a', model: 'one' }, { provider: 'b', model: 'two' }],
    }, 'llm-model-fallback')
    expect(policy.switchOn).toEqual(['transient', 'unavailable', 'quota', 'billing'])
    expect(policy.maxSwitchesPerTurn).toBe(2)
    expect(Object.isFrozen(policy.chain)).toBe(true)
    expect(Object.isFrozen(policy.chain[0])).toBe(true)
  })

  it('rejects duplicate routes, unknown keys, and invalid categories', () => {
    expect(() => resolveModelFallbackPolicy({
      chain: [{ provider: 'a', model: 'one' }, { provider: 'a', model: 'one' }],
    }, 'p')).toThrow('must not repeat the route a/one')
    expect(() => resolveModelFallbackPolicy({
      chain: [{ provider: 'a', model: 'one', extra: true } as ModelFallbackCandidateConfig],
    }, 'p')).toThrow('unknown key "extra"')
    expect(() => resolveModelFallbackPolicy({
      chain: [],
      switchOn: ['nonsense'] as ModelFailureCategory[],
    }, 'p')).toThrow('must contain only')
    expect(() => resolveModelFallbackPolicy({ chain: [], switchOn: [] }, 'p')).toThrow('non-empty array')
    expect(() => resolveModelFallbackPolicy({ chain: [], maxSwitchesPerTurn: -1 }, 'p')).toThrow('non-negative safe integer')
    expect(() => resolveModelFallbackPolicy({
      chain: [{ provider: '', model: 'one' }],
    }, 'p')).toThrow('provider must be a non-empty string')
  })
})

describe('resolveCandidates()', () => {
  async function runtime(): Promise<Context> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['primary', 'secondary', 'text-only', 'unknown-model'], new ScriptedAdapter({
      primary: { responses: [textResponse('x')], inputModalities: ['text', 'image'] },
      secondary: { responses: [textResponse('x')], inputModalities: ['text', 'image'] },
      'text-only': { responses: [textResponse('x')], inputModalities: ['text'] },
      'unknown-model': { responses: [textResponse('x')] },
    }))
    return ctx
  }

  const failed = { provider: 'primary', model: 'model-a' }

  it('keeps chain order and reports every rejected candidate', async () => {
    const ctx = await runtime()
    const resolution = await resolveCandidates({
      llm: ctx.llm,
      chain: [
        { provider: 'unregistered', model: 'm' },
        failed,
        { provider: 'text-only', model: 'model-t' },
        { provider: 'secondary', model: 'model-b' },
      ],
      failed,
      attempted: [],
      requiredModalities: ['image'],
      requiredShape: { systemPromptInHistory: false, toolUpdates: false },
    })
    expect(resolution.eligible).toEqual([{ provider: 'secondary', model: 'model-b' }])
    expect(resolution.rejected).toEqual([
      { route: { provider: 'unregistered', model: 'm' }, reason: 'provider-unregistered' },
      { route: failed, reason: 'already-attempted' },
      { route: { provider: 'text-only', model: 'model-t' }, reason: 'capability-mismatch' },
    ])
  })

  it('skips routes already attempted in this turn', async () => {
    const ctx = await runtime()
    const resolution = await resolveCandidates({
      llm: ctx.llm,
      chain: [{ provider: 'secondary', model: 'model-b' }],
      failed,
      attempted: [{ provider: 'secondary', model: 'model-b' }],
      requiredModalities: [],
      requiredShape: { systemPromptInHistory: false, toolUpdates: false },
    })
    expect(resolution.eligible).toEqual([])
    expect(resolution.rejected[0]?.reason).toBe('already-attempted')
  })

  it('treats an adapter that cannot describe the model as ineligible', async () => {
    const ctx = await runtime()
    ctx.llm.registerAdapter(['broken'], new UnknownModelAdapter())
    const resolution = await resolveCandidates({
      llm: ctx.llm,
      chain: [{ provider: 'broken', model: 'missing' }],
      failed,
      attempted: [],
      requiredModalities: [],
    })
    expect(resolution.rejected).toEqual([
      { route: { provider: 'broken', model: 'missing' }, reason: 'model-unknown' },
    ])
  })
})

describe('requiredInputModalities()', () => {
  it('asks for nothing on a text-only conversation', () => {
    expect(requiredInputModalities([createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]))
      .toEqual([])
  })
})

describe('resolveModelFallbackPolicy() diagnostics', () => {
  it('returns an empty policy when the plugin loads without configuration', () => {
    const policy = resolveModelFallbackPolicy(undefined, 'p')
    expect(policy).toEqual({
      chain: [],
      switchOn: ['transient', 'unavailable', 'quota', 'billing'],
      maxSwitchesPerTurn: 0,
      resumeInterruptedTurns: false,
      maxRecoveryAttempts: 0,
    })
  })

  it('reports every invalid configuration shape at its own path', () => {
    expect(() => resolveModelFallbackPolicy({ chain: [], extra: true } as never, 'entry'))
      .toThrow('entry: unknown key "extra"')
    expect(() => resolveModelFallbackPolicy({ chain: 'nope' } as never, 'entry'))
      .toThrow('entry.chain must be an array')
    expect(() => resolveModelFallbackPolicy({ chain: [null as never] }, 'entry'))
      .toThrow('entry.chain[0] must be an object')
    expect(() => resolveModelFallbackPolicy({ chain: [{ provider: 'a', model: '' }] }, 'entry'))
      .toThrow('entry.chain[0].model must be a non-empty string')
    expect(() => resolveModelFallbackPolicy({
      chain: [{ provider: 'a', model: 'one', reasoningEffort: '' }],
    }, 'entry')).toThrow('entry.chain[0].reasoningEffort must be a non-empty string when present')
    expect(() => resolveModelFallbackPolicy({ chain: [], switchOn: ['quota', 'quota'] }, 'entry'))
      .toThrow('entry.switchOn must not repeat "quota"')
    expect(() => resolveModelFallbackPolicy({ chain: [], maxSwitchesPerTurn: 1.5 }, 'entry'))
      .toThrow('entry.maxSwitchesPerTurn must be a non-negative safe integer')
  })
})

describe('selectionOf()', () => {
  it('converts a configured reasoning effort into a branded selection', () => {
    expect(selectionOf({ provider: 'a', model: 'one', reasoningEffort: 'high' }))
      .toEqual({ provider: 'a', model: 'one', reasoningEffort: 'high' })
    expect(selectionOf({ provider: 'a', model: 'one' })).toEqual({ provider: 'a', model: 'one' })
  })

  it('keys routes unambiguously', () => {
    expect(routeKey({ provider: 'a', model: 'b' })).toBe(routeKey({ provider: 'a', model: 'b' }))
    expect(sameRoute({ provider: 'a', model: 'b' }, { provider: 'a', model: 'c' })).toBe(false)
  })
})

describe('requiredInputModalities() with attachment content', () => {
  it('requires image support once the retained conversation carries an image', () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 12,
      width: 1,
      height: 1,
    }
    expect(requiredInputModalities([
      createUserMessage({ content: [{ type: 'image', attachment }], source: { kind: 'user' } }),
    ])).toEqual(['image'])
  })
})
