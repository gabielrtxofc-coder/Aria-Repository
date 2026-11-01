/**
 * The retained recovery notice: one deterministic user-role block that tells
 * the model why it is being woken without a human message, what the durable
 * commitment is, what already happened, and which recorded tool calls must be
 * verified before they can be retried.
 * @module @deepseek-ai/dsh-mission-continuity
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MissionView } from './types.ts'

/** One plan entry carried into the notice. */
export interface RecoveryNoticeStep {
  /** Short imperative description recorded by the plan owner. */
  readonly content: string
  /** Current plan state. */
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** One recorded tool call whose committed outcome is unknown. */
export interface RecoveryNoticeOperation {
  /** Tool name as recorded on the call. */
  readonly name: string
  /** Durable call identity, so the model can find it in its own history. */
  readonly callId: string
}

/** Everything the notice renders, all of it derived from durable state. */
export interface RecoveryNoticeInput {
  /** Fresh mission view. */
  readonly mission: MissionView
  /** Objective text of the linked durable objective. */
  readonly objective: string
  /** Positive attempt number this notice records. */
  readonly attempt: number
  /** Current plan entries, in plan order. */
  readonly steps: readonly RecoveryNoticeStep[]
  /** Recorded calls whose results never became durable. */
  readonly uncertainOperations: readonly RecoveryNoticeOperation[]
}

/** Most plan entries quoted in one notice. */
const MAX_NOTICE_STEPS = 12

/** Most uncertain operations quoted in one notice. */
const MAX_NOTICE_OPERATIONS = 8

/** Render one plan line. */
function renderStep(step: RecoveryNoticeStep): string {
  const mark = step.status === 'completed' ? '[done]' : step.status === 'in_progress' ? '[now]' : '[pending]'
  return `- ${mark} ${step.content}`
}

/**
 * Render the recovery notice for one claimed mission.
 * @param input - mission state, objective, attempt, plan, and uncertainty facts.
 * @returns one text content block to queue as an ordinary user message.
 */
export function renderMissionRecoveryNotice(input: RecoveryNoticeInput): ContentBlock[] {
  const { mission, objective, attempt, steps, uncertainOperations } = input
  const lines: string[] = [
    `<mission_recovery mission="${mission.id}" attempt="${attempt}/${mission.maxRecoveryAttempts}">`,
    'This message is not from the user. The Harness resumed the mission you were working on',
    'before it was interrupted, and it will keep the work moving until the objective is met',
    'or a real blocker stops it.',
    '',
    `Objective (revision ${mission.goal.revision}): ${JSON.stringify(objective)}`,
    '',
    'Completion criteria:',
    ...mission.completionCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ]
  if (steps.length > 0) {
    lines.push('', 'Current plan:')
    for (const step of steps.slice(0, MAX_NOTICE_STEPS)) lines.push(renderStep(step))
    if (steps.length > MAX_NOTICE_STEPS) lines.push(`- and ${steps.length - MAX_NOTICE_STEPS} more entries`)
  }
  const checkpoint = mission.checkpoint
  if (checkpoint !== undefined) {
    lines.push('', `Last consistent checkpoint: session event ${checkpoint.seq}.`)
  }
  const interruption = mission.interruption
  if (interruption !== undefined) {
    lines.push(`Interruption being recovered: ${interruption.kind} at ${new Date(interruption.at).toISOString()}.`)
    if (interruption.detail !== undefined) lines.push(`Detail: ${interruption.detail}`)
  }
  lines.push(
    '',
    'Everything before the checkpoint is durable: earlier messages, tool results, and completed',
    'steps are still in this conversation. Do not redo work that already has a recorded result.',
  )
  if (uncertainOperations.length > 0) {
    lines.push(
      '',
      'Recorded tool calls whose outcome is unknown:',
      ...uncertainOperations.slice(0, MAX_NOTICE_OPERATIONS).map(operation =>
        `- ${operation.name} (${operation.callId})`),
      'Their side effects may or may not have happened. Verify the external state first, and',
      'retry only when the operation is read-only or idempotent.',
    )
  }
  lines.push(
    '',
    'Continue from the first unfinished plan entry. Record progress with todo_write, and mark',
    'the objective complete with update_goal once the completion criteria hold.',
    '</mission_recovery>',
  )
  return [{ type: 'text', text: lines.join('\n') }]
}
