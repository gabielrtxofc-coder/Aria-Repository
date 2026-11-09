/**
 * Record components: the mission card, the agent card and the activity row.
 *
 * Each is one interactive surface rather than a card with a link inside it, so
 * the keyboard and pointer contracts are identical on every screen that uses it.
 */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import { StatusBadge, StatusDot, type StatusTone } from './Status.tsx'
import { ProgressBar } from './Controls.tsx'
import { relativeAge } from '../format.ts'
import type { ActivityEntry, Agent, Mission } from '../model.ts'
import { DEMO_REFERENCE } from '../fixtures.ts'
import type { Translate } from '../locales/index.ts'
import css from './Record.module.css'

/**
 * Map a mission status onto the shared status tone.
 * @param status - mission lifecycle state.
 * @returns the tone the badge and dot paint with.
 */
export function missionTone(status: Mission['status']): StatusTone {
  switch (status) {
    case 'running': return 'active'
    case 'awaiting': return 'waiting'
    case 'review': return 'review'
    case 'complete': return 'done'
    case 'failed': return 'failed'
    case 'paused': return 'idle'
  }
}

/**
 * Map an agent availability onto the shared status tone.
 * @param availability - agent availability.
 * @returns the tone the badge and dot paint with.
 */
export function agentTone(availability: Agent['availability']): StatusTone {
  switch (availability) {
    case 'available': return 'active'
    case 'engaged': return 'review'
    case 'restricted': return 'waiting'
    case 'offline': return 'idle'
  }
}

/**
 * Map an activity outcome onto the shared status tone.
 * @param outcome - recorded outcome.
 * @returns the tone the row's dot paints with.
 */
export function outcomeTone(outcome: ActivityEntry['outcome']): StatusTone {
  switch (outcome) {
    case 'success': return 'active'
    case 'failure': return 'failed'
    case 'attention': return 'waiting'
    case 'info': return 'done'
  }
}

/** Initials for an agent's mark. */
function agentInitials(name: string): string {
  return name.slice(0, 2).toUpperCase()
}

/** Reference moment the demonstration data is written against. */
const NOW = DEMO_REFERENCE

/**
 * Render the mission card used by the dashboard and the mission list.
 * @param props.mission - the mission to summarise.
 * @param props.agents - agent lookup for the participant row.
 * @param props.selected - whether the mission is open in the drawer.
 * @param props.onOpen - opens the mission.
 * @param props.compact - drops the objective line, for the dashboard column.
 * @param props.t - the dictionary resolver.
 * @returns the card element.
 */
export function MissionCard({ mission, agents, selected = false, onOpen, compact = false, t }: {
  mission: Mission
  agents: readonly Agent[]
  selected?: boolean | undefined
  onOpen: () => void
  compact?: boolean | undefined
  t: Translate
}) {
  const tone = missionTone(mission.status)
  const statusKey = `mission.status.${mission.status}` as const
  const participants = agents.filter(agent => mission.agentIds.includes(agent.id))
  const currentStep = mission.steps.find(step => step.status === 'running')
  return (
    <button
      type="button"
      className={css.card}
      onClick={onOpen}
      data-selected={selected || undefined}
      aria-label={`${mission.title} · ${t(statusKey)} · ${t('common.progress', { value: mission.progress })}`}
    >
      <span className={css.cardTop}>
        <span className={css.cardHeading}>
          <span className={css.cardTitle}>{mission.title}</span>
          {compact ? null : <span className={css.cardSubtitle}>{mission.objective}</span>}
        </span>
        <StatusBadge tone={tone} label={t(statusKey)} pulse={mission.status === 'running'} />
      </span>

      {currentStep === undefined ? null : (
        <span className={css.cardMeta}>
          <StatusDot tone="active" pulse />
          {currentStep.title}
        </span>
      )}

      <ProgressBar
        value={mission.progress}
        label={t('missions.progressLabel')}
        tone={mission.status === 'failed' ? 'danger' : mission.status === 'complete' ? 'muted' : mission.status === 'awaiting' ? 'warn' : mission.status === 'review' ? 'review' : 'accent'}
      />

      <span className={css.cardFoot}>
        <span className={css.cardMeta}>
          <span className={css.mono}>{mission.progress}%</span>
          <span className={css.metaSep} aria-hidden="true" />
          <span>{mission.desk}</span>
          {compact ? null : (
            <>
              <span className={css.metaSep} aria-hidden="true" />
              <span className={css.mono}>{t('common.updated', { when: relativeAge(mission.updatedAt, NOW, t) })}</span>
            </>
          )}
        </span>
        <span className={css.avatarStack} aria-hidden="true">
          {participants.slice(0, 3).map(agent => (
            <span key={agent.id} className={css.avatarChip} title={agent.name}>{agentInitials(agent.name)}</span>
          ))}
        </span>
      </span>
    </button>
  )
}

/**
 * Render the agent card.
 * @param props.agent - the agent to summarise.
 * @param props.assignments - missions the agent is currently assigned to.
 * @param props.onOpen - opens the agent.
 * @param props.t - the dictionary resolver.
 * @returns the card element.
 */
export function AgentCard({ agent, assignments, onOpen, t }: {
  agent: Agent
  assignments: readonly Mission[]
  onOpen: () => void
  t: Translate
}) {
  const tone = agentTone(agent.availability)
  const availabilityKey = `agent.availability.${agent.availability}` as const
  return (
    <button
      type="button"
      className={css.agentCard}
      data-availability={agent.availability}
      onClick={onOpen}
      aria-label={`${agent.name} · ${agent.role} · ${t(availabilityKey)}`}
    >
      <span className={css.agentHead}>
        <span className={css.agentMark} aria-hidden="true">{agentInitials(agent.name)}</span>
        <span className={css.agentIdentity}>
          <span className={css.agentName}>{agent.name}</span>
          <span className={css.agentRole}>{agent.role}</span>
        </span>
        <StatusDot tone={tone} pulse={agent.availability === 'engaged'} size={7} />
      </span>
      <span className={css.agentSummary}>{agent.summary}</span>
      <span className={css.tagRow}>
        {agent.capabilities.slice(0, 3).map(capability => (
          <span key={capability.name} className={css.tag} data-level={capability.level}>{capability.name}</span>
        ))}
      </span>
      <span className={css.agentFoot}>
        <span>{t(availabilityKey)}</span>
        <span className={css.mono}>{agent.model}</span>
      </span>
      <span className={css.agentFoot} style={{ borderTop: 'none', paddingTop: 0 }}>
        <span>{assignments.length === 0 ? t('agents.noAssignments') : t('agents.cardAssignments', { count: assignments.length })}</span>
      </span>
    </button>
  )
}

/**
 * Render one row of the activity timeline.
 * @param props.entry - the recorded event.
 * @param props.mission - the mission the event belongs to, when it has one.
 * @param props.agent - the agent that acted, when one did.
 * @param props.stamp - already-formatted timestamp.
 * @param props.showRail - draw the connector below the dot.
 * @param props.selected - whether the entry is open in the drawer.
 * @param props.onOpen - opens the event.
 * @param props.t - the dictionary resolver.
 * @returns the row element.
 */
export function ActivityRow({ entry, mission, agent, stamp, showRail, selected = false, onOpen, t }: {
  entry: ActivityEntry
  mission: Mission | undefined
  agent: Agent | undefined
  stamp: string
  showRail: boolean
  selected?: boolean | undefined
  onOpen: () => void
  t: Translate
}) {
  const tone = outcomeTone(entry.outcome)
  const outcomeKey = `activity.outcome.${entry.outcome}` as const
  return (
    <button
      type="button"
      className={css.activityRow}
      onClick={onOpen}
      data-selected={selected || undefined}
    >
      <span className={css.activityTime}>{stamp}</span>
      <span className={css.activityRail}>
        {showRail ? <span className={css.activityRailLine} aria-hidden="true" /> : null}
        <StatusDot tone={tone} size={7} />
      </span>
      <span className={css.activityBody}>
        <span className={css.activityTitle}>{entry.title}</span>
        <span className={css.activityDetail}>{entry.detail}</span>
        <span className={css.activityTags}>
          {agent === undefined ? null : (
            <span className={css.activityActor}>
              <span className={css.mono}>{agent.name}</span>
            </span>
          )}
          {mission === undefined ? null : (
            <span className={css.mono}>{mission.title}</span>
          )}
          <span>{t(entry.scope === 'mission' ? 'activity.scope.mission' : entry.scope === 'agent' ? 'activity.scope.agent' : 'activity.scope.system')}</span>
        </span>
      </span>
      <span className={css.activitySide}>
        <span className={css.outcomeChip} data-outcome={entry.outcome}>{entry.outcome === 'info' ? t('activity.outcome.info') : t(outcomeKey)}</span>
      </span>
    </button>
  )
}

/**
 * Render a small tag in the prototype's own tone vocabulary.
 *
 * This is deliberately not the ui-primitives `Tag`: the prototype needs a
 * quieter default than a hairline outline and a tone for "this is the default
 * choice", neither of which the shared control expresses.
 * @param props.children - tag text.
 * @param props.tone - colour family; `neutral` is the default read-only state.
 * @param props.mono - render in the code face.
 * @returns the tag element.
 */
export function Tag({ children, tone = 'neutral', mono = false }: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'muted' | 'warn' | 'danger'
  mono?: boolean | undefined
}) {
  return <span className={clsx(css.tag, mono && css.mono)} data-tone={tone}>{children}</span>
}

