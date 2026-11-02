/**
 * Keyless model for the mission startup proofs: a real `LlmAdapter` registered
 * by the composed tree, so the profile boots through its ordinary provider
 * path without an API key.
 *
 * Every request is appended to `$MISSION_MOCK_LOG` before anything is streamed,
 * which is how the proofs observe that the recovered Agent actually asked the
 * model to continue after a restart. `$MISSION_MOCK_MODE` selects the behavior:
 * `hang` keeps the first request open forever (the parent process is killed
 * while the model is thinking, like a real crash), and `answer` completes each
 * request with a plain answer.
 * @module mission-mock-llm
 */

import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')

/** Text of the last message a request carries, as the proof reads it. */
function lastMessageText(options: GenerateOptions): string {
  const last = options.messages.at(-1)
  if (last === undefined || typeof last.content === 'string') return String(last?.content ?? '')
  return last.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('\n')
}

/** Keyless adapter that records every request before it answers or blocks. */
class MissionMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: HIGH, name: 'High' }], defaultEffort: HIGH },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const log = process.env['MISSION_MOCK_LOG']
    const text = lastMessageText(options)
    if (log !== undefined) {
      appendFileSync(log, `${JSON.stringify({ at: Date.now(), messages: options.messages.length, last: text })}\n`)
    }
    if (process.env['MISSION_MOCK_MODE'] === 'hang') {
      // Never yields: the parent kills this process with SIGKILL while the
      // request is in flight, so the interruption is a real crash mid-turn.
      await new Promise<never>(() => {})
      return
    }
    const reply = 'MISSION_MOCK_ANSWER'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'mission-mock-llm'
export const inject = ['llm']

/** Register the keyless `mission-mock` provider route. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mission-mock'], new MissionMockAdapter())
}
