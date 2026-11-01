/**
 * Child process for the mission-restart end-to-end test. It runs the same
 * production composition the harness mounts, in one of two modes:
 *
 * - `crash`: start a mission, durably checkpoint it, then dispatch a turn and
 *   hang inside the model request. The parent SIGKILLs this process, so the
 *   durable state is exactly what a machine crash leaves behind.
 * - `recover`: mount over the same durable root, run the startup recovery
 *   sweep, wait for the continuation to reach the model, and print one JSON
 *   report on stdout.
 *
 * Usage: mission-child.ts <crash|recover> <durable-root> <marker-path>
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import MissionService from '../../src/index.ts'
import { ScriptedAdapter, requestText, textResponse, waitFor } from '../harness.ts'

const [mode, root, marker] = process.argv.slice(2)
if ((mode !== 'crash' && mode !== 'recover') || root === undefined || marker === undefined) {
  throw new Error('usage: mission-child.ts <crash|recover> <durable-root> <marker>')
}

/** Keep the process alive until the parent kills it. */
function waitForever(): Promise<never> {
  return new Promise(() => { setInterval(() => {}, 60_000) })
}

/** Adapter whose first request publishes a failpoint and then never answers. */
class CrashAdapter extends LlmAdapter {
  /** @param failpoint - marker file the parent watches for. */
  constructor(private readonly failpoint: string) {
    super()
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    await writeFile(this.failpoint, 'turn-dispatched')
    await waitForever()
  }
}

const ctx = new Context()
const session = SessionId('mission-crash-session')
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
await ctx.plugin(SessionCheckpointPolicy)
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: join(root, 'storages') })
const facility = new DomainFacility(ctx, { backend: 'json' })
ctx.effect(() => async () => { await facility.closeAll() })
ctx.storage.mount('domain', facility)
ctx.provide('storageDomain', facility)
await ctx.plugin(GoalService)
await ctx.plugin(ToolTodo, { allowParallelInProgress: false })
await ctx.plugin(GoalRoundDriver)
// The deployment owns provider/model for a resumed Agent; recovery never
// invents a route.
ctx.effect(() => ctx.on('mission/agent-setup', async (request, next) => ({
  ...await next(request),
  agentOptions: { provider: 'child', model: 'child' },
})))
const adapter = mode === 'crash'
  ? new CrashAdapter(marker)
  : new ScriptedAdapter([textResponse('continued after the crash'), textResponse('done')])
ctx.llm.registerAdapter(['child'], adapter)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(MissionService, { sweepOnStartup: false })

if (mode === 'crash') {
  const handle = await ctx.agents.create({
    sessionId: session,
    agentOptions: { provider: 'child', model: 'child' },
  })
  const started = await ctx.missions.start(handle.agent, {
    objective: 'survive a machine crash',
    completionCriteria: ['the recovered turn reaches the model'],
  })
  // Checkpointing flushes the session, so the crash leaves a durable mission
  // record and not just an index row.
  await ctx.missions.checkpoint(handle.agent, started)
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'start the work' }],
    source: { kind: 'user' },
  }))
  await waitForever()
}

const report = await ctx.missions.sweep()
const resumed = ctx.agents.get(session)
if (resumed === undefined) throw new Error('recovery did not resume the session')
await waitFor(() => adapter.requests.some(request => requestText(request).includes('<mission_recovery ')))
const mission = ctx.missions.get(resumed)
process.stdout.write(`${JSON.stringify({
  report,
  attempts: mission?.attempts,
  interruption: mission?.interruption?.kind,
  objective: ctx.goals.get(resumed)?.objective,
  activation: ctx.goals.get(resumed)?.activation,
  requests: adapter.requests.length,
  notices: adapter.requests.filter(request => requestText(request).includes('<mission_recovery ')).length,
})}\n`)
process.exit(0)
