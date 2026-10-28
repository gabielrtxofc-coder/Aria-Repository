/**
 * Failure classification for model-route recovery.
 *
 * Routing reads {@link LlmFailure} codes and HTTP statuses, never message text
 * for codes the harness already normalized. Quota wording is the one message
 * heuristic: providers report an exhausted balance with no distinct code.
 *
 * @module @deepseek-ai/dsh-llm-model-fallback/classification
 */

import {
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  QUOTA_EXCEEDED_CODE,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { ModelFailureCategory } from './types.ts'

/** Codes a bounded retry may resolve on the same route. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', EMPTY_RESPONSE_CODE])

/** Codes naming a route that is temporarily out of service. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'SERVER',
  'UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'OVERLOADED',
])

/** Codes naming an exhausted account quota or balance. */
const QUOTA_CODES: ReadonlySet<string> = new Set([QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE])

/** Codes naming a payment or budget state that blocks the route. */
const BILLING_CODES: ReadonlySet<string> = new Set(['BILLING', 'PAYMENT_REQUIRED', 'INSUFFICIENT_BALANCE'])

/** Codes naming a credential the route cannot use. */
const AUTH_CODES: ReadonlySet<string> = new Set(['AUTH', 'MISSING_CREDENTIAL', INVALID_CREDENTIAL_CODE])

/** Codes naming a request or deployment defect, which another model cannot fix. */
const CONFIGURATION_CODES: ReadonlySet<string> = new Set([
  'NO_ADAPTER',
  'INVALID_ARGS',
  'INVALID_CATALOG',
  'INVALID_PREPARED_CALL',
])

/**
 * Classify one failed model request for recovery routing.
 * @param failure - serializable facts normalized at the adapter boundary.
 * @returns the category that decides retry, switch, or terminal handling.
 */
export function classifyModelFailure(failure: LlmFailure): ModelFailureCategory {
  const { code, status } = failure
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return 'context'
  if (QUOTA_CODES.has(code) || isQuotaExceededError(failure.message)) return 'quota'
  if (AUTH_CODES.has(code) || status === 401 || status === 403) return 'auth'
  if (BILLING_CODES.has(code) || status === 402) return 'billing'
  if (TRANSIENT_CODES.has(code) || status === 408 || status === 429) return 'transient'
  if (UNAVAILABLE_CODES.has(code) || (status !== undefined && status >= 500)) return 'unavailable'
  if (CONFIGURATION_CODES.has(code)) return 'configuration'
  return 'unknown'
}
