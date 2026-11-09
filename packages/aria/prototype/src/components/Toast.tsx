/**
 * Feedback banner.
 *
 * One banner at a time, bottom-centred, with an optional undo action. It is a
 * live region so a screen-reader user hears the outcome of the interaction that
 * produced it, and it holds long enough to be read before it fades.
 */

import { useEffect, useRef, useState } from 'react'
import { IconCheckCircleOutlineRegular, IconCloseOutlineRegular, IconInfoOutlineRegular } from './primitives.tsx'
import css from './Toast.module.css'

/** What the banner reports. */
export type ToastTone = 'success' | 'info' | 'warning'

/** One transient message. */
export interface ToastMessage {
  /** Sequence number, so repeating the same text restarts the banner. */
  readonly seq: number
  readonly text: string
  readonly tone: ToastTone
  /** Optional inline action, e.g. undo. */
  readonly actionLabel?: string | undefined
  readonly onAction?: (() => void) | undefined
}

/**
 * Render the feedback banner.
 * @param props.message - the message to show, or null for nothing.
 * @param props.onDismiss - called when the banner's lifetime elapses or the reader closes it.
 * @param props.dismissLabel - accessible name of the close control.
 * @param props.holdMs - how long the banner stays at full opacity (default 4200).
 * @returns the banner, or null when there is no message.
 */
export function FeedbackBanner({ message, onDismiss, dismissLabel, holdMs = 4200 }: {
  message: ToastMessage | null
  onDismiss: () => void
  dismissLabel: string
  holdMs?: number | undefined
}) {
  const latest = useRef(onDismiss)
  latest.current = onDismiss
  const seq = message?.seq ?? null

  useEffect(() => {
    if (seq === null) return
    const timer = setTimeout(() => { latest.current() }, holdMs)
    return () => { clearTimeout(timer) }
  }, [seq, holdMs])

  if (message === null) return null
  return (
    <div className={css.region} role="status" aria-live="polite">
      <div className={css.banner} data-tone={message.tone} key={message.seq}>
        <span className={css.glyph} aria-hidden="true">
          {message.tone === 'info' ? <IconInfoOutlineRegular size={15} /> : <IconCheckCircleOutlineRegular size={15} />}
        </span>
        <span className={css.text}>{message.text}</span>
        {message.actionLabel === undefined || message.onAction === undefined ? null : (
          <button type="button" className={css.action} onClick={message.onAction}>
            {message.actionLabel}
          </button>
        )}
        <button type="button" className={css.close} aria-label={dismissLabel} onClick={onDismiss}>
          <IconCloseOutlineRegular size={13} />
        </button>
      </div>
    </div>
  )
}

/**
 * Track one banner at a time.
 * @returns the current message and the setters a screen uses to raise or clear it.
 */
export function useFeedback(): {
  message: ToastMessage | null
  show: (text: string, options?: { tone?: ToastTone, actionLabel?: string, onAction?: () => void }) => void
  clear: () => void
} {
  const counter = useRef(0)
  const [message, setMessage] = useState<ToastMessage | null>(null)
  return {
    message,
    show: (text, options) => {
      counter.current += 1
      setMessage({
        seq: counter.current,
        text,
        tone: options?.tone ?? 'success',
        ...(options?.actionLabel === undefined ? {} : { actionLabel: options.actionLabel }),
        ...(options?.onAction === undefined ? {} : { onAction: options.onAction }),
      })
    },
    clear: () => { setMessage(null) },
  }
}
