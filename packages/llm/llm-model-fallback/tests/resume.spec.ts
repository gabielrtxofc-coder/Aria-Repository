import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mountFallbackHarness, promptText, textResponse, toolCallResponse } from './harness.ts'

const PRIMARY = { provider: 'primary', model: 'model-a' }
const SECONDARY = { provider: 'secondary', model: 'model-b' }
const SESSION = SessionId('fallback-restart')

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function persistenceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-fallback-'))
  roots.push(root)
  return root
}

function requests(adapter: { requests: GenerateOptions[] }): string[] {
  return adapter.requests.map(request => `${request.provider}/${request.model}`)
}

function recorded<Type extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: Type,
): Extract<SessionEvent, { type: Type }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: Type }> => event.type === type)
}

describe('model-route fallback across a restart', () => {
  it('pauses on an exhausted chain, then continues the task on another model after resume', async () => {
    const root = await persistenceRoot()
    const first = await mountFallbackHarness({
      persistenceRoot: root,
      probeTool: true,
      routes: {
        primary: {
          responses: [
            toolCallResponse('call-1', 'probe', {}),
            toolCallResponse('call-2', 'probe', {}),
            toolCallResponse('call-3', 'probe', {}),
            toolCallResponse('call-4', 'probe', {}),
            new LlmError('quota exhausted', 'QUOTA'),
          ],
          inputModalities: ['text'],
        },
      },
      // The alternative is configured but its provider is not mounted in this
      // composition, so every candidate is rejected and the task pauses.
      chain: [SECONDARY],
    })
    const agent = await first.ctx.agentLoop.create(SESSION, PRIMARY)
    const before: SessionEvent[] = []
    first.ctx.on('session/event', (session, event) => {
      if (session === agent.session) before.push(event)
    })
    agent.followup(promptText('run the five-step task'))
    await agent.whenIdle()

    expect(recorded(before, 'tool/call')).toHaveLength(4)
    expect(recorded(before, 'tool/result')).toHaveLength(4)
    expect(recorded(before, 'llm/model-fallback-exhausted')).toHaveLength(1)
    expect(recorded(before, 'turn/end')[0]?.data.reason).toMatchObject({ kind: 'error', error: { code: 'QUOTA' } })
    await first.ctx.fiber.dispose()

    // A new process-equivalent composition mounts a different provider set.
    const second = await mountFallbackHarness({
      persistenceRoot: root,
      probeTool: true,
      routes: {
        // The exhausted quota is still in force after the restart.
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('finished the remaining step')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const resumed = await second.ctx.agents.resume({ resumeSessionId: SESSION, agentOptions: PRIMARY })
    const after: SessionEvent[] = []
    second.ctx.on('session/event', (session, event) => {
      if (session === resumed.agent.session) after.push(event)
    })
    resumed.agent.followup(promptText('please continue where you stopped'))
    await resumed.agent.whenIdle()

    // The restarted harness failed over once and ran only the missing step.
    expect(requests(second.adapter)).toEqual(['primary/model-a', 'secondary/model-b'])
    expect(recorded(after, 'llm/model-switched')[0]?.data).toMatchObject({
      turn: 2,
      step: 1,
      category: 'quota',
      from: PRIMARY,
      to: SECONDARY,
    })
    expect(recorded(after, 'tool/call')).toHaveLength(0)
    expect(recorded(after, 'tool/result')).toHaveLength(0)
    expect(recorded(after, 'turn/start')[0]?.data.turn).toBe(2)
    expect(recorded(after, 'turn/end')[0]?.data.reason).toEqual({ kind: 'completed' })
    expect(recorded(after, 'assistant/message')[0]?.data.message.source).toMatchObject(SECONDARY)

    // Everything the first model produced is still the request's history.
    const request = second.adapter.requests[0]
    const toolResults = request?.messages.filter(message => message.role === 'tool') ?? []
    expect(toolResults).toHaveLength(4)
    expect(request?.messages.filter(message => message.role === 'user')).toHaveLength(2)
    const history = JSON.stringify(request?.messages)
    expect(history).toContain('call-1')
    expect(history).toContain('call-4')
    await resumed.dispose()
    await second.ctx.fiber.dispose()
  })

  it('restores a recorded switch so a resumed session keeps its recovered route', async () => {
    const root = await persistenceRoot()
    const first = await mountFallbackHarness({
      persistenceRoot: root,
      routes: {
        primary: { responses: [new LlmError('quota exhausted', 'QUOTA')], inputModalities: ['text'] },
        secondary: { responses: [textResponse('answered by the alternative')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const agent = await first.ctx.agentLoop.create(SESSION, PRIMARY)
    agent.followup(promptText('first request'))
    await agent.whenIdle()
    expect(first.adapter.requests.map(request => request.provider)).toEqual(['primary', 'secondary'])
    await first.ctx.fiber.dispose()

    const second = await mountFallbackHarness({
      persistenceRoot: root,
      routes: {
        primary: { responses: [], inputModalities: ['text'] },
        secondary: { responses: [textResponse('continued on the alternative')], inputModalities: ['text'] },
      },
      chain: [SECONDARY],
    })
    const resumed = await second.ctx.agents.resume({ resumeSessionId: SESSION, agentOptions: PRIMARY })
    expect(second.ctx.sessionProjections.stateOf(resumed.agent.session, 'llmModelFallback')).toMatchObject({
      active: { route: SECONDARY, replaces: PRIMARY },
      switches: 1,
    })
    resumed.agent.followup(promptText('second request'))
    await resumed.agent.whenIdle()

    expect(requests(second.adapter)).toEqual(['secondary/model-b'])
    await resumed.dispose()
    await second.ctx.fiber.dispose()
  })
})
