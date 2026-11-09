/**
 * Agents: the roster, the availability filter, and one agent's detail drawer.
 *
 * Agent cards are illustrative. They describe what the demonstration workspace
 * says each agent is trusted with; no agent is defined, registered, or started
 * here, and the "assign" control only changes local prototype state.
 */

import { useMemo, useState } from 'react'
import { Button } from '../components/primitives.tsx'
import { FilterRow, Metric, PageHeader, PrototypeNotice } from '../components/Controls.tsx'
import { Panel } from '../components/Panel.tsx'
import { RegionState } from '../components/Feedback.tsx'
import { AgentCard, Tag, agentTone } from '../components/Record.tsx'
import { StatusBadge } from '../components/Status.tsx'
import { Drawer, DrawerProse, DrawerSection } from '../components/Drawer.tsx'
import { GlyphCapability } from '../components/icons.tsx'
import { absoluteStamp, relativeAge } from '../format.ts'
import type { Agent, AgentAvailability, Workspace } from '../model.ts'
import type { Translate } from '../locales/index.ts'
import css from './Agents.module.css'

/** The availability filter, including the "all" pseudo-state. */
type AgentFilterValue = 'all' | AgentAvailability

/**
 * Render the agents screen.
 * @param props.workspace - the demonstration workspace.
 * @param props.now - reference moment for relative ages.
 * @param props.selectedId - agent currently open in the drawer.
 * @param props.onSelect - opens or closes an agent.
 * @param props.onNavigate - moves to the missions screen.
 * @param props.t - the dictionary resolver.
 * @returns the roster and its drawer.
 */
export function Agents({ workspace, now, selectedId, onSelect, onNavigate, t }: {
  workspace: Workspace
  now: string
  selectedId: string | undefined
  onSelect: (id: string | undefined) => void
  onNavigate: (route: 'missions' | 'activity') => void
  t: Translate
}) {
  const [filter, setFilter] = useState<AgentFilterValue>('all')
  const [assigned, setAssigned] = useState<readonly string[]>([])

  const counts = useMemo(() => {
    const map = new Map<AgentFilterValue, number>([['all', workspace.agents.length]])
    for (const agent of workspace.agents) {
      map.set(agent.availability, (map.get(agent.availability) ?? 0) + 1)
    }
    return map
  }, [workspace.agents])

  const visible = filter === 'all'
    ? workspace.agents
    : workspace.agents.filter(agent => agent.availability === filter)

  const selected = selectedId === undefined ? undefined : workspace.agents.find(agent => agent.id === selectedId)
  const filters: readonly { value: AgentFilterValue, label: string, count: number }[] = [
    { value: 'all', label: t('agents.filter.all'), count: counts.get('all') ?? 0 },
    { value: 'available', label: t('agents.filter.available'), count: counts.get('available') ?? 0 },
    { value: 'engaged', label: t('agents.filter.engaged'), count: counts.get('engaged') ?? 0 },
    { value: 'restricted', label: t('agent.availability.restricted'), count: counts.get('restricted') ?? 0 },
    { value: 'offline', label: t('agent.availability.offline'), count: counts.get('offline') ?? 0 },
  ]

  const available = counts.get('available') ?? 0
  const engaged = counts.get('engaged') ?? 0
  const totalRuns = workspace.agents.reduce((sum, agent) => sum + agent.runsLast30Days, 0)
  const withWrite = workspace.agents.filter(agent => agent.canWrite).length
  const inFlight = workspace.missions.filter(mission => mission.status === 'running' || mission.status === 'awaiting' || mission.status === 'review').length
  const sortedRuns = workspace.agents.map(agent => agent.runsLast30Days).toSorted((a, b) => a - b)
  const medianRuns = sortedRuns.length === 0 ? 0 : sortedRuns[Math.floor(sortedRuns.length / 2)] ?? 0

  return (
    <>
      <PageHeader
        title={t('agents.title')}
        subtitle={t('agents.subtitle')}
        eyebrow={`${workspace.name} · ${t('nav.sectionPrimary')}`}
        titleId="aria-agents-title"
        actions={(
          <Button variant="outline" onClick={() => { onNavigate('missions') }}>
            {t('overview.activeMissions')}
          </Button>
        )}
      />

      <section className={css.metrics} aria-label={t('overview.indicators')}>
        <div className={css.metricCell}>
          <Metric
            label={t('agents.available')}
            value={String(available)}
            tone="accent"
            detail={t('agents.statAvailable', { count: available, total: workspace.agents.length })}
          />
        </div>
        <div className={css.metricCell}>
          <Metric
            label={t('agents.engaged')}
            value={String(engaged)}
            detail={t('agents.statEngaged', { count: inFlight })}
          />
        </div>
        <div className={css.metricCell}>
          <Metric
            label={t('agents.runs')}
            value={String(totalRuns)}
            detail={t('agents.statRuns', { value: medianRuns })}
          />
        </div>
        <div className={css.metricCell}>
          <Metric
            label={t('agents.write')}
            value={`${withWrite} / ${workspace.agents.length}`}
            detail={t('agents.statWrite')}
          />
        </div>
      </section>

      <div className={css.toolbar}>
        <FilterRow options={filters} value={filter} onChange={setFilter} label={t('common.filters')} />
        <p className={css.toolbarNote}>{t('agents.assignHint')}</p>
      </div>

      {visible.length === 0 ? (
        <Panel padding="md">
          <RegionState
            glyph="empty"
            title={t('agents.emptyTitle')}
            description={t('agents.emptyBody')}
            action={<Button size="sm" variant="outline" onClick={() => { setFilter('all') }}>{t('common.clear')}</Button>}
          />
        </Panel>
      ) : (
        <ul className={css.grid}>
          {visible.map(agent => (
            <li key={agent.id}>
              <AgentCard
                agent={agent}
                assignments={workspace.missions.filter(mission => agent.assignmentIds.includes(mission.id))}
                onOpen={() => { onSelect(agent.id) }}
                t={t}
              />
            </li>
          ))}
        </ul>
      )}

      <PrototypeNotice text={t('app.prototypeNotice')} />

      <Drawer
        open={selected !== undefined}
        onClose={() => { onSelect(undefined) }}
        eyebrow={<>{t('agents.detail')} <span aria-hidden="true">·</span> <span className={css.mono}>{selected?.id ?? ''}</span></>}
        title={selected?.name ?? ''}
        closeLabel={t('common.close')}
        hintLabel={t('common.close')}
        footer={selected === undefined ? undefined : (
          <>
            <Button variant="ghost" size="sm" onClick={() => { onSelect(undefined); onNavigate('activity') }}>
              {t('agents.detail.activity')}
            </Button>
            <Button
              variant={assigned.includes(selected.id) ? 'outline' : 'primary'}
              size="sm"
              onClick={() => {
                setAssigned(current => current.includes(selected.id)
                  ? current.filter(id => id !== selected.id)
                  : [...current, selected.id])
              }}
            >
              {assigned.includes(selected.id) ? t('common.dismiss') : t('agents.assign')}
            </Button>
          </>
        )}
      >
        {selected === undefined ? null : (
          <AgentDetail
            agent={selected}
            workspace={workspace}
            now={now}
            assigned={assigned.includes(selected.id)}
            onOpenMission={() => { onSelect(undefined); onNavigate('missions') }}
            t={t}
          />
        )}
      </Drawer>
    </>
  )
}

/**
 * Render the body of an agent's detail drawer.
 * @param props.agent - the agent being shown.
 * @param props.workspace - the workspace, for assignment lookups.
 * @param props.now - reference moment for relative ages.
 * @param props.assigned - whether the prototype has staged an assignment.
 * @param props.onOpenMission - opens the mission register.
 * @param props.t - the dictionary resolver.
 * @returns the detail body.
 */
function AgentDetail({ agent, workspace, now, assigned, onOpenMission, t }: {
  agent: Agent
  workspace: Workspace
  now: string
  assigned: boolean
  onOpenMission: () => void
  t: Translate
}) {
  const missions = workspace.missions.filter(mission => agent.assignmentIds.includes(mission.id))
  const entries = workspace.activity.filter(entry => entry.agentId === agent.id).slice(0, 5)

  return (
    <>
      <div className={css.hero}>
        <span className={css.heroMark} aria-hidden="true">{agent.name.slice(0, 2).toUpperCase()}</span>
        <div className={css.heroText}>
          <p className={css.heroRole}>{agent.role}</p>
          <p className={css.heroSummary}>{agent.summary}</p>
        </div>
        <StatusBadge tone={agentTone(agent.availability)} label={t(`agent.availability.${agent.availability}`)} pulse={agent.availability === 'engaged'} />
      </div>

      <div className={css.facts}>
        <div><span>{t('agents.model')}</span><strong className={css.mono}>{agent.model}</strong></div>
        <div><span>{t('agents.context')}</span><strong>{agent.context}</strong></div>
        <div><span>{t('agents.runs')}</span><strong>{agent.runsLast30Days}</strong></div>
        <div><span>{t('agents.meanRuntime')}</span><strong>{agent.meanRuntime}</strong></div>
        <div><span>{t('agents.write')}</span><strong>{agent.canWrite ? t('agents.writeYes') : t('agents.writeNo')}</strong></div>
        <div><span>{t('agents.lastActiveLabel')}</span><strong>{relativeAge(agent.lastActiveAt, now, t)}</strong></div>
      </div>

      <DrawerSection title={t('agents.capabilities')}>
        <ul className={css.capabilities}>
          {agent.capabilities.map(capability => (
            <li key={capability.name} className={css.capability}>
              <span className={css.capabilityGlyph}><GlyphCapability size={14} /></span>
              <span className={css.capabilityText}>
                <span className={css.capabilityName}>{capability.name}</span>
                <span className={css.capabilityNote}>{capability.note}</span>
              </span>
              <Tag tone={capability.level === 'core' ? 'accent' : capability.level === 'supporting' ? 'neutral' : 'muted'}>
                {t(`agents.capability.${capability.level}`)}
              </Tag>
            </li>
          ))}
        </ul>
      </DrawerSection>

      <DrawerSection title={t('agents.assignments')}>
        {missions.length === 0 ? (
          <DrawerProse muted>{t('agents.noAssignments')}</DrawerProse>
        ) : (
          <ul className={css.assignments}>
            {missions.map(mission => (
              <li key={mission.id}>
                <button type="button" className={css.assignment} onClick={onOpenMission}>
                  <span>{mission.title}</span>
                  <span className={css.mono}>{mission.progress}%</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {assigned ? <p className={css.staged}>{t('agents.assignHint')}</p> : null}
      </DrawerSection>

      <DrawerSection title={t('agents.detail.activity')}>
        {entries.length === 0 ? (
          <DrawerProse muted>{t('agents.detail.activityEmpty')}</DrawerProse>
        ) : (
          <ol className={css.activity}>
            {entries.map(entry => (
              <li key={entry.id} className={css.activityRow}>
                <span className={css.mono}>{absoluteStamp(entry.at, now)}</span>
                <span>
                  <strong>{entry.title}</strong>
                  <span className={css.activityDetail}>{entry.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </DrawerSection>
    </>
  )
}
