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
 *
 * Precedence is what makes the answer trustworthy: a provider-normalized code
 * speaks first, then the HTTP status the provider returned, and only an
 * otherwise unclassified failure is read for quota wording. A message that
 * happens to mention a balance therefore cannot turn an explicit `AUTH` or
 * `BILLING` code, or a 401/402 response, into an exhausted quota — the two
 * outcomes differ: an exhausted quota may be recovered on another route, while
 * a rejected credential on this account may not.
 * @param failure - serializable facts normalized at the adapter boundary.
 * @returns the category that decides retry, switch, or terminal handling.
 */
export function classifyModelFailure(failure: LlmFailure): ModelFailureCategory {
  const { code, status } = failure
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return 'context'
  if (AUTH_CODES.has(code)) return 'auth'
  if (BILLING_CODES.has(code)) return 'billing'
  if (QUOTA_CODES.has(code)) return 'quota'
  if (TRANSIENT_CODES.has(code)) return 'transient'
  if (UNAVAILABLE_CODES.has(code)) return 'unavailable'
  if (CONFIGURATION_CODES.has(code)) return 'configuration'
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'billing'
  if (status === 408 || status === 429) return 'transient'
  if (status !== undefined && status >= 500) return 'unavailable'
  // Last resort: no organized signal. Providers report an exhausted balance
  // with no distinct code or status, so the wording is the only evidence left.
  if (isQuotaExceededError(failure.message)) return 'quota'
  return 'unknown'
}
