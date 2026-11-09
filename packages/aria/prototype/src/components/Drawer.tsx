/**
 * Detail drawer: the panel that opens over the workspace for a mission, an
 * agent or an event.
 *
 * The drawer owns its focus contract: focus moves into the panel when it opens,
 * Tab and Shift+Tab stay inside it, Escape closes it, and the opener receives
 * focus back when it closes. The scrim is a real button so a pointer user can
 * dismiss it too.
 */

import { useCallback, useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutlineRegular } from './primitives.tsx'
import css from './Drawer.module.css'

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Render a right-hand detail drawer.
 * @param props.open - whether the drawer is mounted.
 * @param props.onClose - dismissal handler for Escape, the close button and the scrim.
 * @param props.eyebrow - small label above the title, usually the record type.
 * @param props.title - the record's name.
 * @param props.closeLabel - accessible name of the close control.
 * @param props.hintLabel - accessible name of the scrim dismissal control.
 * @param props.footer - action row pinned to the bottom of the panel.
 * @param props.width - `wide` for artifact-heavy records.
 * @param props.children - drawer body.
 * @returns the drawer tree, or null while closed.
 */
export function Drawer({ open, onClose, eyebrow, title, closeLabel, hintLabel, footer, width = 'default', children }: {
  open: boolean
  onClose: () => void
  eyebrow: ReactNode
  title: string
  closeLabel: string
  hintLabel: string
  footer?: ReactNode
  width?: 'default' | 'wide'
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const labelId = useId()

  // Focus into the panel on open, and hand focus back to whatever opened it on
  // close. The opener is captured before the first paint of the panel.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel.current)?.focus({ preventScroll: true })
    return () => {
      if (opener !== null && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [open])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || panel.current === null) return
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(node => node.offsetParent !== null)
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (first === undefined || last === undefined) return
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }, [onClose])

  if (!open) return null

  return createPortal(
    <div className={css.root} onKeyDown={onKeyDown}>
      <button type="button" className={css.scrim} aria-label={hintLabel} tabIndex={-1} onClick={onClose} />
      <div
        ref={panel}
        className={css.panel}
        data-width={width === 'wide' ? 'wide' : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={css.header}>
          <div className={css.headerText}>
            <div className={css.eyebrow} id={labelId}>{eyebrow}</div>
            <h2 className={css.title} id={titleId}>{title}</h2>
          </div>
          <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose} data-drawer-close="">
            <IconCloseOutlineRegular size={14} />
          </button>
        </div>
        <div className={css.body}>{children}</div>
        {footer === undefined ? null : <div className={css.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/**
 * Render one titled block of a drawer body.
 * @param props.title - already-localized block heading.
 * @param props.children - block content.
 * @param props.className - extra class for layout placement.
 * @returns the section element.
 */
export function DrawerSection({ title, children, className }: {
  title: string
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <section className={clsx(css.section, className)} aria-label={title}>
      <h3 className={css.sectionTitle}>{title}</h3>
      {children}
    </section>
  )
}

/**
 * Render body prose inside a drawer.
 * @param props.children - the sentence or paragraph.
 * @returns the paragraph element.
 */
export function DrawerProse({ children, muted = false }: { children: ReactNode, muted?: boolean | undefined }) {
  return <p className={clsx(css.prose, muted && css.proseMuted)}>{children}</p>
}
