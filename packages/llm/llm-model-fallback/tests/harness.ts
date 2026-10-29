/**
 * Shared mounting, scripted adapters, and response helpers for the fallback suites.
 *
 * The only mocks here are the model adapters: every other service is the real
 * implementation the product mounts, including the production AgentLoop and the
 * JSONL session backend used by the restart tests.
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import * as modelFallback from '../src/index.ts'
import type { ModelFallbackCandidateConfig, ModelFailureCategory } from '../src/index.ts'

/** One scripted provider route: its responses, in request order. */
export interface ScriptedRoute {
  /** Responses served to successive requests; an Error is thrown at request time. */
  responses: (StreamChunk[] | LlmError)[]
  /** Declared input modalities; omission leaves the adapter non-committal. */
  inputModalities?: ModelModality[]
  /** Provider-owned request retry policy served for this route. */
  retryPolicy?: RetryPolicyConfig
  /** Selectable reasoning efforts this route declares, least to greatest. */
  reasoningEfforts?: string[]
  /** Provider-owned context capacity this route declares. */
  contextWindow?: number
  /** Declared mid-conversation system prompt handling. */
  systemPromptUpdate?: 'in-history'
  /** Declared mid-conversation tool declaration handling. */
  toolUpdate?: 'in-history' | 'addition-only'
}

/** Adapter whose routes are scripted per provider and recorded per request. */
export class ScriptedAdapter extends LlmAdapter {
  /** Every request this adapter received, in dispatch order. */
  readonly requests: GenerateOptions[] = []

  private readonly retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>>

  constructor(
    private readonly routes: Readonly<Record<string, ScriptedRoute>>,
    private readonly observe?: (options: GenerateOptions) => void,
  ) {
    super()
    this.retryPolicies = Object.fromEntries(Object.entries(routes).map(([provider, route]) => [
      provider,
      route.retryPolicy === undefined
        ? undefined
        : resolveRetryPolicy(route.retryPolicy, `scripted route "${provider}" retryPolicy`),
    ]))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.routes[provider]?.inputModalities === undefined
        ? {}
        : { inputModalities: this.routes[provider]?.inputModalities },
      ...this.routes[provider]?.reasoningEfforts === undefined
        ? {}
        : {
          reasoning: {
            efforts: this.routes[provider]?.reasoningEfforts?.map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
          },
        },
      ...this.routes[provider]?.contextWindow === undefined
        ? {}
        : { context: { contextWindow: this.routes[provider]?.contextWindow ?? 0 } },
      ...this.routes[provider]?.systemPromptUpdate === undefined
        ? {}
        : { systemPromptUpdate: this.routes[provider]?.systemPromptUpdate },
      ...this.routes[provider]?.toolUpdate === undefined
        ? {}
        : { toolUpdate: this.routes[provider]?.toolUpdate },
    })
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.observe?.(options)
    const route = this.routes[options.provider]
    if (route === undefined) throw new Error(`ScriptedAdapter: no route "${options.provider}"`)
    const entry = route.responses.shift()
    if (entry === undefined) throw new Error(`ScriptedAdapter: script exhausted for "${options.provider}"`)
    if (entry instanceof Error) throw entry
    yield * entry
  }
}

/** One plain text response. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One response that requests a single tool call. */
export function toolCallResponse(rawCallId: string, name: string, args: object, text?: string): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  const chunks: StreamChunk[] = []
  let index = 0
  if (text !== undefined) {
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
    index += 1
  }
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsJson },
    {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: callId, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/** Options shared by every fallback suite. */
export interface HarnessOptions {
  /** Pre-built context to mount into; omission creates and owns a fresh one. */
  ctx?: Context
  /** Scripted routes, keyed by provider id. */
  routes: Readonly<Record<string, ScriptedRoute>>
  /** Configured replacement chain. */
  chain?: ModelFallbackCandidateConfig[]
  /** Failure categories that may switch routes. */
  switchOn?: ModelFailureCategory[]
  /** Switch allowance for one turn. */
  maxSwitchesPerTurn?: number
  /** Mount the retry-policy plugin ahead of the fallback plugin. */
  retry?: boolean
  /** Root directory for the real JSONL session backend. */
  persistenceRoot?: string
  /** Physical encoding of the JSONL backend; `none` lets a test read the log. */
  persistenceCompression?: 'zstd' | 'none'
  /** Register the `probe` tool so a scripted task can take several steps. */
  probeTool?: boolean
  /** Deterministic switch identities, consumed in order. */
  switchIds?: string[]
  /** Continue an interrupted or paused task when the Session is resumed. */
  resumeInterruptedTurns?: boolean
  /** Automatic continuation turns allowed after the last human message. */
  maxRecoveryAttempts?: number
  /** Observer invoked with each request before the adapter streams it. */
  onRequest?: (options: GenerateOptions) => void
}

/** Mounted harness returned to a suite. */
export interface FallbackHarness {
  /** Context that owns every mounted service. */
  readonly ctx: Context
  /** The single scripted adapter serving every route. */
  readonly adapter: ScriptedAdapter
}

/** A message that only carries text, for ordinary prompts. */
export function promptText(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Mount the full harness with the production services and this plugin.
 * @param options - routes, plugin configuration, and optional persistence.
 * @returns the mounted context and its recording adapter.
 */
export async function mountFallbackHarness(options: HarnessOptions): Promise<FallbackHarness> {
  const ctx = options.ctx ?? new Context()
  // The observer runs inside the adapter's dispatch, after every listener that
  // precedes the request (durability checkpoints included) has settled.
  const observe = options.onRequest
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  // The backend mounts before the loop so teardown drains live writers first.
  if (options.persistenceRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, {
      root: options.persistenceRoot,
      ...options.persistenceCompression === undefined ? {} : { compression: options.persistenceCompression },
    })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(options.routes, observe)
  ctx.llm.registerAdapter(Object.keys(options.routes), adapter)

  if (options.probeTool === true) {
    ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'Record one completed step.',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'probe recorded' }] },
    }))
  }
  const config = {
    chain: options.chain ?? [],
    ...options.switchOn === undefined ? {} : { switchOn: options.switchOn },
    ...options.maxSwitchesPerTurn === undefined ? {} : { maxSwitchesPerTurn: options.maxSwitchesPerTurn },
    ...options.resumeInterruptedTurns === undefined ? {} : { resumeInterruptedTurns: options.resumeInterruptedTurns },
    ...options.maxRecoveryAttempts === undefined ? {} : { maxRecoveryAttempts: options.maxRecoveryAttempts },
  }
  if (options.switchIds === undefined) {
    await ctx.plugin(modelFallback, config)
  } else {
    const switchIds = [...options.switchIds]
    // Cordis forwards only the configuration to a function plugin, so the
    // deterministic identity hooks enter through the plugin body itself.
    await ctx.plugin(Object.assign(
      (inner: Context) => {
        modelFallback.apply(inner, config, { switchId: () => switchIds.shift() ?? 'switch-extra' })
      },
      { inject: modelFallback.inject },
    ))
  }
  // The retry policy is downstream of the fallback: a scheduled retry on the
  // failed route wins, and only a declined failure reaches the switch.
  if (options.retry === true) await ctx.plugin(LlmRetry)
  return { ctx, adapter }
}
