import { describe, expect, it } from 'vitest'
import { classifyModelFailure } from '../src/index.ts'

describe('classifyModelFailure precedence', () => {
  it('keeps an explicit credential code out of the quota category whatever the message says', () => {
    // Providers phrase a rejected credential many ways; only the normalized
    // code decides, because an exhausted quota may recover elsewhere while a
    // rejected credential for this account may not.
    expect(classifyModelFailure({ message: 'insufficient quota for this key', code: 'AUTH' })).toBe('auth')
    expect(classifyModelFailure({ message: 'quota exceeded', code: 'INVALID_CREDENTIAL' })).toBe('auth')
    expect(classifyModelFailure({ message: 'no credit left', code: 'AUTH', status: 429 })).toBe('auth')
  })

  it('keeps an explicit billing code out of the quota category', () => {
    expect(classifyModelFailure({ message: 'quota exceeded', code: 'BILLING' })).toBe('billing')
    expect(classifyModelFailure({ message: 'insufficient quota', code: 'INSUFFICIENT_BALANCE' })).toBe('billing')
  })

  it('prefers a normalized code over the status that accompanies it', () => {
    expect(classifyModelFailure({ message: 'insufficient quota', code: 'QUOTA', status: 402 })).toBe('quota')
    expect(classifyModelFailure({ message: 'quota wording', code: 'RATE_LIMIT', status: 429 })).toBe('transient')
  })

  it('reads the HTTP status before any wording for an unclassified failure', () => {
    expect(classifyModelFailure({ message: 'insufficient quota', code: 'UNKNOWN', status: 401 })).toBe('auth')
    expect(classifyModelFailure({ message: 'insufficient quota', code: 'UNKNOWN', status: 402 })).toBe('billing')
    expect(classifyModelFailure({ message: 'insufficient quota', code: 'UNKNOWN', status: 429 })).toBe('transient')
    expect(classifyModelFailure({ message: 'insufficient quota', code: 'UNKNOWN', status: 503 })).toBe('unavailable')
  })

  it('uses provider quota wording only when nothing else classifies the failure', () => {
    expect(classifyModelFailure({ message: 'insufficient quota', code: 'UNKNOWN' })).toBe('quota')
    expect(classifyModelFailure({ message: 'exceeded your current quota', code: '' })).toBe('quota')
    expect(classifyModelFailure({ message: 'something else entirely', code: 'UNKNOWN' })).toBe('unknown')
  })

  it('keeps a context-window failure and the request defects out of every recovery class', () => {
    expect(classifyModelFailure({ message: 'too long', code: 'CONTEXT_WINDOW_EXCEEDED' })).toBe('context')
    expect(classifyModelFailure({ message: 'bad args', code: 'INVALID_ARGS' })).toBe('configuration')
  })
})
