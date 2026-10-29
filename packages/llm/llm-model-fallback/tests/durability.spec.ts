/**
 * Durability of the switch record, and recovery at the two points a task can
 * lose its owner: after a tool already executed, and after a failed checkpoint.
 *
 * These suites mount the real JSONL backend, so "durable" means a byte the next
 * process can read — not an in-memory append.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mountFallbackHarness, promptText, textResponse } from './harness.ts'

const PRIMARY = { provider: 'primary', model: 'model-a' }
const SECONDARY = { provider: 'secondary', model: 'model-b' }

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function persistenceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-fallback-durability-'))
  roots.push(root)
  return root
}

function routes(adapter: { requests: GenerateOptions[] }): string[] {
  return adapter.requests.map(request => `${request.provider}/${request.model}`)
}

function recorded<Type extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: Type,
): Extract<SessionEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: Type }> => event.type === type)
}

/** Concatenate every plaintext JSONL artifact under a persistence root. */
async function readRawLogs(root: string): Promise<string> {
  const files: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  await walk(root)
  const contents = await Promise.all(files.map(async path => readFile(path, 'utf8')))
  return contents.join('\n')
}

/** Read one stored session's physical log through a read handle. */
async function readStoredEvents(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

describe('model-route fallback durability', () => {
  it('confirms the switch record reached storage before the replacement request is dispatched', async () => {
    const root = await persistenceRoot()
    const sessionId = SessionId('durable-switch')
    let atRetry: string | undefined
    const harness = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('served by the alternative')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
      // The observer runs inside the adapter's dispatch: a request it sees has
      // already passed every durability checkpoint that precedes the stream.
      onRequest: (request) => {
        if (request.provider !== 'secondary') return
        atRetry = undefined
        const snapshot = readFileSyncLogs(root)
        atRetry = snapshot
      },
    })
    const agent = await harness.ctx.agentLoop.create(sessionId, PRIMARY)
    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(routes(harness.adapter)).toEqual(['primary/model-a', 'secondary/model-b'])
    // A crash between the switch and the retry must not re-run the failed
    // route: the decision is already a readable byte when the retry leaves.
    expect(atRetry).toContain('llm/model-switched')
    expect(atRetry).toContain('"model":"model-b"')
    await harness.ctx.fiber.dispose()
  })

  it('proves a batched append alone would not have reached storage at that point', async () => {
    // The backend batches live appends; without the awaited checkpoint the
    // switch record would still be buffered here. This pins the reason the
    // plugin flushes instead of relying on the batch window.
    const root = await persistenceRoot()
    let atFirstRequest: string | undefined
    const harness = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      routes: { primary: { responses: [textResponse('one')], inputModalities: ['text'] } },
      onRequest: () => {
        atFirstRequest ??= readFileSyncLogs(root)
      },
    })
    const agent = await harness.ctx.agentLoop.create(SessionId('batched-append'), PRIMARY)
    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(atFirstRequest).not.toContain('request/header')
    expect(atFirstRequest).not.toContain('assistant/message')
    // …while an explicit checkpoint makes the completed turn readable.
    await harness.ctx.sessions.flush(agent.session)
    expect(await readRawLogs(root)).toContain('assistant/message')
    await harness.ctx.fiber.dispose()
  })

  it('keeps recovering in-process when the checkpoint write fails, and never claims it succeeded', async () => {
    const root = await persistenceRoot()
    const harness = await mountFallbackHarness({
      persistenceRoot: root,
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('served anyway')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const reported = vi.spyOn(harness.ctx.logger, 'error')
    const sessions = harness.ctx.sessions
    const flush = vi.spyOn(sessions, 'flush').mockRejectedValueOnce(new Error('disk full'))
    const events: SessionEvent[] = []
    const agent = await harness.ctx.agentLoop.create(SessionId('failed-checkpoint'), PRIMARY)
    harness.ctx.on('session/event', (session, event) => {
      if (session === agent.session) events.push(event)
    })

    agent.followup(promptText('go'))
    await agent.whenIdle()

    expect(flush).toHaveBeenCalled()
    // The failure is loud and specific: storage was not confirmed.
    expect(reported).toHaveBeenCalledWith(expect.stringContaining('could not confirm the switch record reached storage'))
    // Recovery still proceeds in-process rather than dead-ending the task.
    expect(routes(harness.adapter)).toEqual(['primary/model-a', 'secondary/model-b'])
    expect(recorded(events, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
    const switched = recorded(events, 'llm/model-switched')[0]?.data
    // The record itself never asserts a durability it does not have.
    expect(switched).not.toHaveProperty('durable')
    await harness.ctx.fiber.dispose()
  })

  it('resumes a turn whose tool already executed without re-running the tool or waiting for a human', async () => {
    const root = await persistenceRoot()
    const sessionId = SessionId('crashed-mid-tool')
    // Lifecycle 0: a log that stops after the tool STARTED — the recorded call
    // may already have had its side effect when the process died.
    const seeding = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      routes: { primary: { responses: [], inputModalities: ['text'] } },
    })
    const seed: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: SessionSeq(1), time: 1, data: { turn: 1, step: 1 } },
      // A stored log opens with the system prompt inside the first open step: it
      // is the protected surface head every later message appends to.
      { type: 'system/message', seq: SessionSeq(2), time: 1, surfaceOp: 'append', data: {
        turn: 1,
        step: 1,
        message: {
          id: 'system-head' as never,
          role: 'system',
          content: [{ type: 'text', text: 'an operator instruction' }],
          source: { kind: 'system-prompt' },
        },
      } } as SessionEvent,
      { type: 'user/message', seq: SessionSeq(3), time: 1, surfaceOp: 'append', data: createUserMessage({
        content: [{ type: 'text', text: 'run the task' }],
        source: { kind: 'user' },
      }) },
      { type: 'assistant/message', seq: SessionSeq(4), time: 2, surfaceOp: 'append', data: {
        turn: 1,
        step: 1,
        stream: [],
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'probe', arguments: '{}' }],
          source: { kind: 'model', ...PRIMARY },
        }),
      } },
      { type: 'tool/call', seq: SessionSeq(5), time: 2, data: {
        turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'probe', arguments: '{}',
      } },
    ]
    const prepared = seeding.ctx.sessions.prepare(sessionId)
    const handle = await seeding.ctx.sessionPersistence.create(prepared.header)
    await handle.append(seed)
    await handle.close()
    await seeding.ctx.fiber.dispose()

    // Lifecycle 1: a fresh process resumes with the opt-in, and nobody speaks.
    const harness = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      resumeInterruptedTurns: true,
      maxRecoveryAttempts: 1,
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        // The resumed history carries the system prompt after the first message,
        // so only an in-history reader can honor it.
        secondary: {
          responses: [textResponse('verified state and continued')],
          inputModalities: ['text'],
          systemPromptUpdate: 'in-history',
        },
      },
      chain: [SECONDARY],
    })
    let executions = 0
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'Record one completed step.',
      parameters: {},
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'probe recorded' }]
      },
    }))
    const events: SessionEvent[] = []
    harness.ctx.on('session/event', (session, event) => {
      if (session.id === sessionId) events.push(event)
    })

    const resumed = await harness.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: PRIMARY })
    await resumed.agent.whenIdle()

    // The harness itself drove the continuation: no human message was admitted.
    expect(recorded(events, 'user/message').every(event => event.data.source.kind !== 'user')).toBe(true)
    expect(recorded(events, 'user/message').map(event => event.data.source.kind)).toContain('model-fallback-recovery')
    // One turn — the continuation — started in this lifecycle, without a human
    // message having restarted it.
    expect(recorded(events, 'turn/start')).toHaveLength(1)
    expect(recorded(events, 'turn/start')[0]?.data.turn).toBe(2)
    // The unknown outcome was recorded instead of the tool being re-executed.
    expect(executions).toBe(0)
    // Drain the batched tail so the assertions below read the stored truth.
    await harness.ctx.sessions.flush(resumed.agent.session)
    const stored = await readStoredEvents(harness.ctx, sessionId)
    const unknown = stored.filter(event => event.type === 'tool/result'
      && event.data.error?.code === TOOL_OUTCOME_UNKNOWN)
    expect(unknown).toHaveLength(1)
    // The continuation reached the model with that uncertainty in its history.
    const request = harness.adapter.requests[0]
    expect(JSON.stringify(request?.messages)).toContain('TOOL_OUTCOME_UNKNOWN')
    // And the recovery decisions are durable, not just in memory.
    expect(routes(harness.adapter)).toEqual(['primary/model-a', 'secondary/model-b'])
    expect(stored.some(event => event.type === 'llm/model-switched')).toBe(true)
    expect(stored.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await resumed.dispose()
    await harness.ctx.fiber.dispose()
  })
})

/** Synchronous plaintext log read, usable from inside the adapter's dispatch. */
function readFileSyncLogs(root: string): string {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  walk(root)
  return files.map(path => readFileSync(path, 'utf8')).join('\n')
}
