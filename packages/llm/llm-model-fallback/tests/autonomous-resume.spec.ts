/**
 * Autonomous resume: a resumed Session continues its interrupted or paused task
 * without a new user message — only when the deployment opts in, and only for
 * the bounded number of attempts it configured.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mountFallbackHarness, promptText, textResponse } from './harness.ts'

const PRIMARY = { provider: 'primary', model: 'model-a' }
const SECONDARY = { provider: 'secondary', model: 'model-b' }

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function routes(adapter: { requests: GenerateOptions[] }): string[] {
  return adapter.requests.map(request => `${request.provider}/${request.model}`)
}

function recorded<Type extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: Type,
): Extract<SessionEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: Type }> => event.type === type)
}

/**
 * A log whose first turn was closed by an exhausted fallback chain: the task
 * has an ownerless remainder, and the durable pause says why.
 */
function pausedTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 1, data: { turn: 1, step: 1 } },
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
        content: [{ type: 'text', text: 'step one of the task is done' }],
        source: { kind: 'model', ...PRIMARY },
      }),
    } },
    { type: 'llm/model-fallback-exhausted', seq: SessionSeq(5), time: 3, data: {
      turn: 1,
      step: 1,
      category: 'quota',
      failure: { message: 'quota exhausted', code: 'QUOTA' },
      cause: 'no-eligible-candidate',
      attempted: [],
      rejected: [],
    } },
    { type: 'step/end', seq: SessionSeq(6), time: 3, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(7), time: 3, data: {
      turn: 1,
      reason: { kind: 'error', error: { message: 'quota exhausted', code: 'QUOTA' } },
    } },
  ] as SessionEvent[]
}

/** Persist one seeded log through a throwaway composition. */
async function seed(root: string, sessionId: SessionId, events: readonly SessionEvent[]): Promise<void> {
  const seeding = await mountFallbackHarness({
    persistenceRoot: root,
    persistenceCompression: 'none',
    routes: { primary: { responses: [], inputModalities: ['text'] } },
  })
  const prepared = seeding.ctx.sessions.prepare(sessionId)
  const handle = await seeding.ctx.sessionPersistence.create(prepared.header)
  await handle.append(events)
  await handle.close()
  await seeding.ctx.fiber.dispose()
}

/** Collect the events one resumed session appends in this composition. */
function recordSession(ctx: Context, sessionId: SessionId): SessionEvent[] {
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => {
    if (session.id === sessionId) events.push(event)
  })
  return events
}

describe('model-route fallback autonomous resume', () => {
  it('continues a paused task after a restart with no new user message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fallback-resume-'))
    roots.push(root)
    const sessionId = SessionId('paused-task')
    await seed(root, sessionId, pausedTurn())

    const harness = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      resumeInterruptedTurns: true,
      routes: {
        primary: { responses: [textResponse('finished the task')], inputModalities: ['text'] },
      },
    })
    const events = recordSession(harness.ctx, sessionId)
    const resumed = await harness.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: PRIMARY })
    await resumed.agent.whenIdle()

    // Nobody spoke: the only admitted message is the harness continuation.
    expect(recorded(events, 'user/message').map(event => event.data.source.kind))
      .toEqual(['model-fallback-recovery'])
    expect(recorded(events, 'turn/start').map(event => event.data.turn)).toEqual([2])
    expect(recorded(events, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
    expect(routes(harness.adapter)).toEqual(['primary/model-a'])
    // The continuation is instructed not to repeat completed steps.
    const prompt = JSON.stringify(harness.adapter.requests[0]?.messages)
    expect(prompt).toContain('Continue the task from the durable state')
    await resumed.dispose()
    await harness.ctx.fiber.dispose()
  })

  it('leaves a resumed Session idle unless the deployment opts in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fallback-resume-off-'))
    roots.push(root)
    const sessionId = SessionId('paused-task-opt-out')
    await seed(root, sessionId, pausedTurn())

    const harness = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      routes: { primary: { responses: [textResponse('unused')], inputModalities: ['text'] } },
    })
    const events = recordSession(harness.ctx, sessionId)
    const resumed = await harness.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: PRIMARY })
    await resumed.agent.whenIdle()

    // Default off: the user's turn to speak, and no tokens are spent unasked.
    expect(harness.adapter.requests).toEqual([])
    expect(recorded(events, 'turn/start')).toEqual([])
    // The durable pause is still readable after the restart.
    expect(harness.ctx.sessionProjections.stateOf(resumed.agent.session, 'llmModelFallback'))
      .toMatchObject({ paused: { turn: 1, step: 1, category: 'quota' } })
    await resumed.dispose()
    await harness.ctx.fiber.dispose()
  })

  it('bounds automatic continuations so a restart loop cannot spend without end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fallback-resume-bound-'))
    roots.push(root)
    const sessionId = SessionId('bounded-recovery')
    await seed(root, sessionId, pausedTurn())

    // Lifecycle 1: the automatic continuation runs and fails again, spending
    // the single allowed attempt.
    const first = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      resumeInterruptedTurns: true,
      maxRecoveryAttempts: 1,
      routes: { primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] } },
      // Configured, but no provider serves it in this composition: every
      // candidate is rejected and the pause is recorded durably.
      chain: [SECONDARY],
    })
    const firstResumed = await first.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: PRIMARY })
    await firstResumed.agent.whenIdle()
    expect(first.adapter.requests).toHaveLength(1)
    expect(first.ctx.sessionProjections.stateOf(firstResumed.agent.session, 'llmModelFallback'))
      .toMatchObject({ recoveryAttempts: 1, paused: { turn: 2, step: 1 } })
    await firstResumed.dispose()
    await first.ctx.fiber.dispose()

    // Lifecycle 2: same log, a working alternative is now available — but the
    // allowance is spent, so the harness stays silent and the machine keeps a
    // durable record of the pause instead of looping.
    const second = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      resumeInterruptedTurns: true,
      maxRecoveryAttempts: 1,
      routes: { secondary: { responses: [textResponse('unused')], inputModalities: ['text'] } },
      chain: [SECONDARY],
    })
    const events = recordSession(second.ctx, sessionId)
    const secondResumed = await second.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: PRIMARY })
    await secondResumed.agent.whenIdle()

    expect(second.adapter.requests).toEqual([])
    expect(recorded(events, 'turn/start')).toEqual([])
    await secondResumed.dispose()
    await second.ctx.fiber.dispose()
  })

  it('restores the spent allowance from durable history, then resets it for a human message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fallback-resume-reset-'))
    roots.push(root)
    const sessionId = SessionId('recovered-after-human')
    // The log already carries one harness continuation and one open turn: the
    // allowance is spent before this process starts.
    await seed(root, sessionId, [
      ...pausedTurn(),
      { type: 'turn/start', seq: SessionSeq(8), time: 4, data: { turn: 2 } },
      { type: 'step/start', seq: SessionSeq(9), time: 4, data: { turn: 2, step: 1 } },
      { type: 'user/message', seq: SessionSeq(10), time: 4, surfaceOp: 'append', data: createUserMessage({
        content: [{ type: 'text', text: 'continue the task from the durable state' }],
        source: { kind: 'model-fallback-recovery', form: 'notice', summary: 'turn 1 paused' },
      }) },
    ] as SessionEvent[])

    const harness = await mountFallbackHarness({
      persistenceRoot: root,
      persistenceCompression: 'none',
      resumeInterruptedTurns: true,
      maxRecoveryAttempts: 1,
      routes: { primary: { responses: [textResponse('answered')], inputModalities: ['text'] } },
    })
    const resumed = await harness.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: PRIMARY })
    await resumed.agent.whenIdle()
    // The spent allowance survives the restart: no automatic turn, no spend.
    expect(harness.adapter.requests).toEqual([])

    await resumed.agent.whenIdle()
    resumed.agent.followup(promptText('please continue'))
    await resumed.agent.whenIdle()

    expect(harness.adapter.requests).toHaveLength(1)
    // A human message starts a fresh allowance.
    expect(harness.ctx.sessionProjections.stateOf(resumed.agent.session, 'llmModelFallback'))
      .toMatchObject({ recoveryAttempts: 0 })
    await resumed.dispose()
    await harness.ctx.fiber.dispose()
  })
})
