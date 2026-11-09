/**
 * The Aria prototype application.
 *
 * `AriaPrototype` owns everything that is shared between screens: the current
 * location (kept in the URL hash so a refresh lands on the same screen), the
 * demonstration workspace with any mission created in this session, the
 * new-mission dialog, the feedback banner, and the two detail drawers.
 *
 * It reads no DSH service, registers no plugin, and issues no network request.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Shell } from './shell/Shell.tsx'
import { Overview } from './screens/Overview.tsx'
import { Missions } from './screens/Missions.tsx'
import { Agents } from './screens/Agents.tsx'
import { Knowledge } from './screens/Knowledge.tsx'
import { Activity } from './screens/Activity.tsx'
import { Settings } from './screens/Settings.tsx'
import { FeedbackBanner, useFeedback } from './components/Toast.tsx'
import { NewMissionModal, type MissionDraft } from './components/NewMissionModal.tsx'
import { DEMO_REFERENCE, DEMO_WORKSPACE } from './fixtures.ts'
import { translate } from './locales/index.ts'
import { DEFAULT_LOCATION, formatLocation, parseLocation, type Location, type RouteId } from './routes.ts'
import type { Mission } from './model.ts'
import css from './App.module.css'

/**
 * Render the prototype.
 * @returns the complete interface.
 */
export function AriaPrototype() {
  const t = translate
  const [location, setLocation] = useState<Location>(() =>
    typeof window === 'undefined' ? DEFAULT_LOCATION : parseLocation(window.location.hash))
  const [missions, setMissions] = useState<readonly Mission[]>(DEMO_WORKSPACE.missions)
  const [newMissionOpen, setNewMissionOpen] = useState(false)
  const feedback = useFeedback()

  /** Move to a screen, clearing any detail query that belonged to the previous one. */
  const navigate = useCallback((route: RouteId) => {
    setLocation(current => (current.route === route ? current : { route, query: {} }))
  }, [])

  /** Open the mission drawer without unmounting the register underneath it. */
  const openMission = useCallback((id: string | undefined) => {
    setLocation({ route: 'missions', query: id === undefined ? {} : { mission: id } })
  }, [])

  /** Open the agent drawer. */
  const openAgent = useCallback((id: string | undefined) => {
    setLocation({ route: 'agents', query: id === undefined ? {} : { agent: id } })
  }, [])

  // Overlays are portalled to `document.body`, outside this component's subtree.
  // Carrying the token class on the body while the prototype is mounted is what
  // lets the dialog and the drawer paint in Aria's palette; it is removed again
  // on unmount so the host document is left as it was found.
  useEffect(() => {
    document.body.classList.add('aria-surface')
    return () => { document.body.classList.remove('aria-surface') }
  }, [])

  useEffect(() => {
    const next = formatLocation(location)
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [location])

  useEffect(() => {
    const onHashChange = (): void => { setLocation(parseLocation(window.location.hash)) }
    window.addEventListener('hashchange', onHashChange)
    return () => { window.removeEventListener('hashchange', onHashChange) }
  }, [])

  const workspace = useMemo(() => ({ ...DEMO_WORKSPACE, missions }), [missions])
  const awaitingCount = missions.filter(mission => mission.status === 'awaiting').length

  /**
   * Add a demonstration mission to local state and open it.
   *
   * The mission starts in its first step and is not scheduled by anything: it
   * exists for the length of this browser session and disappears on reload.
   * @param draft - the objective, constraints, desk and priority typed by the operator.
   */
  const createMission = (draft: MissionDraft): void => {
    const id = `mis-demo-${missions.length + 1}`
    const title = draft.objective.length > 54 ? `${draft.objective.slice(0, 52)}…` : draft.objective
    const mission: Mission = {
      id,
      title,
      objective: draft.objective,
      brief: draft.constraints === '' ? t('missions.new.created') : draft.constraints,
      status: 'running',
      progress: 4,
      createdAt: DEMO_REFERENCE,
      updatedAt: DEMO_REFERENCE,
      agentIds: ['agent-atlas'],
      desk: draft.desk,
      steps: [
        {
          id: `${id}-step-1`,
          title: 'Scope the objective',
          detail: 'Atlas restates the objective, names the decision it supports, and lists what would count as evidence.',
          status: 'running',
          agentId: 'agent-atlas',
          timing: '0m 12s',
        },
        {
          id: `${id}-step-2`,
          title: 'Assemble the evidence',
          detail: 'Retrieval runs against the knowledge collections once the scope is accepted.',
          status: 'pending',
          agentId: 'agent-vector',
          timing: '—',
        },
        {
          id: `${id}-step-3`,
          title: 'Verify against the brief',
          detail: 'Sentry checks every claim against a citation before the desk sees the result.',
          status: 'pending',
          agentId: 'agent-sentry',
          timing: '—',
        },
      ],
      events: [
        { id: `${id}-event-1`, at: DEMO_REFERENCE, kind: 'plan', summary: 'Mission created in the prototype session; first step started.', actorId: 'agent-atlas' },
      ],
      artifacts: [],
    }
    setMissions(current => [mission, ...current])
    setNewMissionOpen(false)
    setLocation({ route: 'missions', query: { mission: id } })
    feedback.show(t('missions.new.created'), { tone: 'success' })
  }

  return (
    <div className={`${css.root} aria-surface`} data-active-route={location.route}>
      <Shell
        route={location.route}
        onNavigate={navigate}
        workspace={workspace}
        awaitingCount={awaitingCount}
        t={t}
        onOpenSearch={() => { navigate('knowledge') }}
      >
        {location.route === 'overview' ? (
          <Overview
            workspace={workspace}
            now={DEMO_REFERENCE}
            onOpenMission={openMission}
            onOpenAgent={openAgent}
            onNewMission={() => { setNewMissionOpen(true) }}
            onNavigate={navigate}
            t={t}
          />
        ) : null}

        {location.route === 'missions' ? (
          <Missions
            workspace={workspace}
            now={DEMO_REFERENCE}
            selectedId={location.query.mission}
            onSelect={openMission}
            onNewMission={() => { setNewMissionOpen(true) }}
            onNavigate={navigate}
            t={t}
          />
        ) : null}

        {location.route === 'agents' ? (
          <Agents
            workspace={workspace}
            now={DEMO_REFERENCE}
            selectedId={location.query.agent}
            onSelect={openAgent}
            onNavigate={navigate}
            t={t}
          />
        ) : null}

        {location.route === 'knowledge' ? (
          <Knowledge workspace={workspace} now={DEMO_REFERENCE} onOpenMission={() => { openMission(undefined) }} t={t} />
        ) : null}

        {location.route === 'activity' ? (
          <Activity
            workspace={workspace}
            now={DEMO_REFERENCE}
            onOpenMission={openMission}
            onOpenAgent={openAgent}
            t={t}
          />
        ) : null}

        {location.route === 'settings' ? <Settings workspace={workspace} t={t} /> : null}
      </Shell>

      <NewMissionModal
        open={newMissionOpen}
        onClose={() => { setNewMissionOpen(false) }}
        onSubmit={createMission}
        desks={[...new Set(missions.map(mission => mission.desk))]}
        t={t}
      />
      <FeedbackBanner message={feedback.message} onDismiss={feedback.clear} dismissLabel={t('common.dismiss')} />
    </div>
  )
}
