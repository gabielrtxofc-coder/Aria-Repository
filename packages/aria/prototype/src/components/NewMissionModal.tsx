/**
 * New mission dialog.
 *
 * The dialog validates locally, shows a short "planning" step, and then hands
 * the entered objective to the caller, which appends a demonstration mission to
 * local state. Nothing here calls a service, and the copy says so in the
 * dialog itself rather than in a footnote.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Button, Input, Modal } from './primitives.tsx'
import { Spinner } from './Feedback.tsx'
import { PrototypeNotice } from './Controls.tsx'
import type { Translate } from '../locales/index.ts'
import css from './NewMissionModal.module.css'

/** Priority levels the dialog offers; purely presentational labels. */
const PRIORITIES = ['standard', 'elevated', 'urgent'] as const

const PRIORITY_LABEL = {
  standard: 'missions.new.priorityStandard',
  elevated: 'missions.new.priorityElevated',
  urgent: 'missions.new.priorityUrgent',
} as const

/** What the dialog collects. */
export interface MissionDraft {
  readonly objective: string
  readonly constraints: string
  readonly desk: string
  readonly priority: typeof PRIORITIES[number]
}

/**
 * Render the new-mission dialog.
 * @param props.open - whether the dialog is mounted.
 * @param props.onClose - dismissal handler.
 * @param props.onSubmit - receives the draft once the planning step completes.
 * @param props.desks - desk names offered in the desk select.
 * @param props.t - the dictionary resolver.
 * @returns the dialog.
 */
export function NewMissionModal({ open, onClose, onSubmit, desks, t }: {
  open: boolean
  onClose: () => void
  onSubmit: (draft: MissionDraft) => void
  desks: readonly string[]
  t: Translate
}) {
  const [objective, setObjective] = useState('')
  const [constraints, setConstraints] = useState('')
  const [desk, setDesk] = useState(desks[0] ?? '')
  const [priority, setPriority] = useState<typeof PRIORITIES[number]>('standard')
  const [error, setError] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const objectiveId = useId()
  const constraintsId = useId()

  // Every open starts from a clean draft, so a cancelled mission never leaves
  // half-typed text behind for the next one.
  useEffect(() => {
    if (!open) return
    setObjective('')
    setConstraints('')
    setDesk(desks[0] ?? '')
    setPriority('standard')
    setError(null)
    setPlanning(false)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    }
  }, [open, desks])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (planning) return
    const trimmed = objective.trim()
    if (trimmed === '') {
      setError(t('missions.new.required'))
      return
    }
    setError(null)
    setPlanning(true)
    // The pause stands in for plan assembly. It is a presentation delay, not a
    // request: the mission is appended to local state when it elapses.
    timer.current = setTimeout(() => {
      timer.current = null
      setPlanning(false)
      onSubmit({ objective: trimmed, constraints: constraints.trim(), desk, priority })
    }, 900)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('missions.new.title')}
      description={t('missions.new.description')}
      closeLabel={t('common.close')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose} disabled={planning}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            type="submit"
            form="aria-new-mission"
            disabled={planning}
            icon={planning ? <Spinner size={13} tone="accent" label={t('missions.new.creating')} /> : undefined}
          >
            {planning ? t('missions.new.creating') : t('missions.new.submit')}
          </Button>
        </>
      )}
    >
      <form className={css.form} id="aria-new-mission" onSubmit={submit} noValidate aria-busy={planning || undefined}>
        <div className={css.field}>
          <label className={css.label} htmlFor={objectiveId}>{t('missions.new.objective')}</label>
          <textarea
            id={objectiveId}
            className={css.textarea}
            value={objective}
            onChange={event => { setObjective(event.currentTarget.value); if (error !== null) setError(null) }}
            placeholder={t('missions.new.objectivePlaceholder')}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : `${objectiveId}-error`}
            rows={3}
            data-modal-autofocus=""
            disabled={planning}
          />
          {error === null ? null : <p className={css.error} id={`${objectiveId}-error`}>{error}</p>}
        </div>

        <div className={css.field}>
          <label className={css.label} htmlFor={constraintsId}>{t('missions.new.constraints')}</label>
          <div className={css.input}>
            <Input
              id={constraintsId}
              value={constraints}
              onChange={event => { setConstraints(event.currentTarget.value) }}
              placeholder={t('missions.new.constraintsPlaceholder')}
              disabled={planning}
            />
          </div>
        </div>

        <div className={css.row}>
          <div className={css.field}>
            <span className={css.label} id={`${objectiveId}-desk`}>{t('missions.new.desk')}</span>
            <div className={css.segmented} role="group" aria-labelledby={`${objectiveId}-desk`}>
              {desks.map(name => (
                <button
                  key={name}
                  type="button"
                  className={css.segment}
                  aria-pressed={desk === name}
                  onClick={() => { setDesk(name) }}
                  disabled={planning}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={css.field}>
          <span className={css.label} id={`${objectiveId}-priority`}>{t('missions.new.priority')}</span>
          <div className={css.segmented} role="group" aria-labelledby={`${objectiveId}-priority`}>
            {PRIORITIES.map(level => (
              <button
                key={level}
                type="button"
                className={css.segment}
                aria-pressed={priority === level}
                onClick={() => { setPriority(level) }}
                disabled={planning}
              >
                {t(PRIORITY_LABEL[level])}
              </button>
            ))}
          </div>
        </div>

        <PrototypeNotice text={t('missions.new.demoNote')} />
      </form>
    </Modal>
  )
}
