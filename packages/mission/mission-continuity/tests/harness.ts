/**
 * Test support for mission continuity: a production AgentLoop, real JSONL
 * session persistence, real JSON domain storage, the durable goal domain, and
 * the mission service, all rooted in one temporary directory so a test can
 * dispose the whole composition and start again on the same durable state.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import MissionService from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** One scripted model answer: chunks, a failure, or an answer that never ends. */
export type ScriptEntry = StreamChunk[] | Error | 'hang' | ((options: GenerateOptions) => StreamChunk[])

/** Request-recording adapter with no network access and no real quota use. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  /** @param script - answers consumed in request order. */
  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) yield chunk
  }
}

/**
 * Wait for one condition instead of assuming a background continuation ran.
 * @param predicate - condition to await.
 * @param timeoutMs - how long to wait before failing.
 * @returns resolution once the condition holds.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition did not hold in time')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** One plain text answer. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One answer that requests a single tool call. */
export function toolCallResponse(id: string, name: string, args = '{}'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Every text block of one request, joined for ordering assertions. */
export function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Options for one mounted composition. */
export interface HarnessOptions {
  /** Durable root shared by every composition that must see the same state. */
  readonly root: string
  /** Model answers, consumed in request order. */
  readonly script: ScriptEntry[]
  /** Deployment configuration for the mission service. */
  readonly config?: Config
  /** Mount the same-session goal round driver so recovered work really continues. */
  readonly driver?: boolean
  /** Session identity shared across restarts. */
  readonly sessionId?: string
  /** Observation hook after services activate and before any Agent exists. */
  readonly onContext?: (ctx: Context) => void
  /** Provider the recovered Agent is composed with; the deployment's choice. */
  readonly provider?: string
  /** Session-scoped setup the deployment adds while composing a recovered Agent. */
  readonly setup?: (agent: Agent) => void
  /** Compose recovered Agents with no provider/model, as an unconfigured deployment would. */
  readonly emptyPlan?: boolean
  /**
   * Tool calls one step may keep in flight at once, so a test can drive the
   * fan-out width the loop would really produce. Omitted means the shipped
   * default.
   */
  readonly maxParallelToolCalls?: number
}

/** One mounted composition rooted at a durable directory. */
export interface MissionHarness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly session: SessionId
}

/** Create one isolated durable root and its cleanup. */
export async function tempRoot(prefix = 'dsh-mission-'): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
}

/**
 * Mount the production composition rooted at `options.root`.
 * @param options - durable root, scripted answers, configuration, and hooks.
 * @returns the mounted context, its adapter, and the shared session identity.
 */
export async function mountHarness(options: HarnessOptions): Promise<MissionHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(options.root, 'sessions'), compression: 'none' })
  await ctx.plugin(SessionCheckpointPolicy)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(options.root, 'storages') })
  const facility = new DomainFacility(ctx, { backend: 'json' })
  ctx.effect(() => async () => { await facility.closeAll() })
  const unmountDomain = ctx.storage.mount('domain', facility)
  ctx.effect(() => async () => { unmountDomain() })
  ctx.provide('storageDomain', facility)
  await ctx.plugin(GoalService)
  await ctx.plugin(ToolTodo, { allowParallelInProgress: false })
  if (options.driver === true) await ctx.plugin(GoalRoundDriver)
  // The composition owns provider/model for a resumed Agent; recovery never
  // invents a route. This listener is the deployment's half of the seam.
  const provider = options.provider ?? 'mock'
  const setup = options.setup
  const emptyPlan = options.emptyPlan ?? false
  ctx.effect(() => ctx.on('mission/agent-setup', async (request, next) => ({
    ...await next(request),
    ...emptyPlan
      ? {}
      : {
          agentOptions: { provider, model: provider },
          ...setup === undefined ? {} : { setup: async (_agentCtx: Context, agent: Agent) => { setup(agent) } },
        },
  })))
  const adapter = new ScriptedAdapter(options.script)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, {
    agents: [],
    ...options.maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls: options.maxParallelToolCalls },
  })
  await ctx.plugin(MissionService, options.config ?? {})
  options.onContext?.(ctx)
  return { ctx, adapter, session: SessionId(options.sessionId ?? 'mission-session') }
}

/** Create (or adopt) the mission session's Agent in one mounted composition. */
export async function createAgent(harness: MissionHarness): Promise<Agent> {
  const live = harness.ctx.agents.get(harness.session)
  if (live !== undefined) return live
  const handle = await harness.ctx.agents.create({
    sessionId: harness.session,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return handle.agent
}

/**
 * Read the durable JSONL artifact of one session, one line per stored event —
 * the authority a later process replays.
 * @param root - durable root the composition was mounted on.
 * @param sessionId - session whose artifact to read.
 * @returns the raw artifact text.
 */
export async function readSessionArtifact(root: string, sessionId = 'mission-session'): Promise<string> {
  const relative = await readdir(join(root, 'sessions'), { recursive: true })
  const marker = `${'/'}${sessionId}/`
  const artifact = relative.find(name => name.includes(marker) && name.endsWith('.jsonl'))
  if (artifact === undefined) throw new Error(`no durable artifact for session "${sessionId}"`)
  return await readFile(join(root, 'sessions', artifact), 'utf8')
}

/**
 * Count logged recovery notices in one durable artifact. The notice is a real
 * `user/message` attributed to a mission, so it survives restart as ordinary
 * history instead of hidden state.
 * @param artifact - raw session JSONL text.
 * @returns how many mission-sourced user messages the log holds.
 */
export function countMissionNotices(artifact: string): number {
  return artifact.split('\n')
    .filter(line => line.includes('"type":"user/message"') && line.includes('"kind":"mission"'))
    .length
}

/**
 * Stop one composition the way a graceful process exit does: flush every
 * session to its durable artifact, then dispose the whole context.
 * @param harness - the composition to stop.
 */
export async function stopHarness(harness: MissionHarness): Promise<void> {
  const agent = harness.ctx.agents.get(harness.session)
  if (agent !== undefined) await harness.ctx.sessions.flush(agent.session)
  await harness.ctx.fiber.dispose()
}
