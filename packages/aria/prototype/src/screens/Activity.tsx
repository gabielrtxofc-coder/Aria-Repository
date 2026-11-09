/**
 * Activity: the chronological record, grouped by day.
 *
 * The timeline is derived from the same activity entries the dashboard's tail
 * uses, so a reader who follows "view all" sees the events they came from. Two
 * filters — scope and outcome — narrow the list locally, and an event can open
 * its mission or its agent.
 */

import { useMemo, useState } from 'react'
import { Button } from '../components/primitives.tsx'
import { FilterRow, PageHeader, PrototypeNotice } from '../components/Controls.tsx'
import { Panel } from '../components/Panel.tsx'
import { RegionState } from '../components/Feedback.tsx'
import { ActivityRow } from '../components/Record.tsx'
import { Drawer, DrawerProse, DrawerSection } from '../components/Drawer.tsx'
import { absoluteStamp, dayBucket, relativeAge } from '../format.ts'
import type { ActivityEntry, Workspace } from '../model.ts'
import type { Translate } from '../locales/index.ts'
import css from './Activity.module.css'

/** Scope filter values. */
type ScopeValue = 'all' | ActivityEntry['scope']
/** Outcome filter values. */
type OutcomeValue = 'all' | ActivityEntry['outcome']

/**
 * Render the activity screen.
 * @param props.workspace - the demonstration workspace.
 * @param props.now - reference moment for the day buckets.
 * @param props.onOpenMission - opens a mission from an event.
 * @param props.onOpenAgent - opens an agent from an event.
 * @param props.t - the dictionary resolver.
 * @returns the timeline.
 */
export function Activity({ workspace, now, onOpenMission, onOpenAgent, t }: {
  workspace: Workspace
  now: string
  onOpenMission: (id: string) => void
  onOpenAgent: (id: string) => void
  t: Translate
}) {
  const [scope, setScope] = useState<ScopeValue>('all')
  const [outcome, setOutcome] = useState<OutcomeValue>('all')
  const [selected, setSelected] = useState<string | undefined>(undefined)

  const entries = useMemo(() => workspace.activity.filter(entry => {
    if (scope !== 'all' && entry.scope !== scope) return false
    if (outcome !== 'all' && entry.outcome !== outcome) return false
    return true
  }), [workspace.activity, scope, outcome])

  const groups = useMemo(() => {
    const buckets: { key: string, label: string, entries: ActivityEntry[] }[] = []
    for (const entry of entries) {
      const label = dayBucket(entry.at, now, t)
      const last = buckets[buckets.length - 1]
      if (last !== undefined && last.label === label) last.entries.push(entry)
      else buckets.push({ key: `group-${buckets.length}`, label, entries: [entry] })
    }
    return buckets
  }, [entries, now, t])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const entry of workspace.activity) {
      map.set(entry.scope, (map.get(entry.scope) ?? 0) + 1)
      map.set(entry.outcome, (map.get(entry.outcome) ?? 0) + 1)
    }
    return map
  }, [workspace.activity])

  const event = selected === undefined ? undefined : workspace.activity.find(entry => entry.id === selected)
  const mission = event?.missionId === null || event?.missionId === undefined
    ? undefined
    : workspace.missions.find(item => item.id === event.missionId)
  const agent = event?.agentId === null || event?.agentId === undefined
    ? undefined
    : workspace.agents.find(item => item.id === event.agentId)

  const scopeOptions: readonly { value: ScopeValue, label: string, count: number }[] = [
    { value: 'all', label: t('activity.scope.all'), count: workspace.activity.length },
    { value: 'mission', label: t('activity.scope.mission'), count: counts.get('mission') ?? 0 },
    { value: 'agent', label: t('activity.scope.agent'), count: counts.get('agent') ?? 0 },
    { value: 'system', label: t('activity.scope.system'), count: counts.get('system') ?? 0 },
  ]

  const outcomeOptions: readonly { value: OutcomeValue, label: string, count: number }[] = [
    { value: 'all', label: t('activity.outcome.all'), count: workspace.activity.length },
    { value: 'success', label: t('activity.outcome.success'), count: counts.get('success') ?? 0 },
    { value: 'attention', label: t('activity.outcome.attention'), count: counts.get('attention') ?? 0 },
    { value: 'failure', label: t('activity.outcome.failure'), count: counts.get('failure') ?? 0 },
    { value: 'info', label: t('activity.outcome.info'), count: counts.get('info') ?? 0 },
  ]

  return (
    <>
      <PageHeader
        title={t('activity.title')}
        subtitle={t('activity.subtitle')}
        eyebrow={`${workspace.name} · ${t('activity.eventCount', { count: workspace.activity.length })}`}
        titleId="aria-activity-title"
        actions={(
          <Button variant="ghost" onClick={() => { setScope('all'); setOutcome('all') }}>
            {t('activity.clearFilters')}
          </Button>
        )}
      />

      <div className={css.toolbar}>
        <div className={css.filterGroup}>
          <span className={css.filterLabel}>{t('common.filters')}</span>
          <FilterRow options={scopeOptions} value={scope} onChange={setScope} label={t('common.filters')} scroll />
        </div>
        <div className={css.filterGroup}>
          <span className={css.filterLabel}>{t('activity.outcome.all')}</span>
          <FilterRow options={outcomeOptions} value={outcome} onChange={setOutcome} label={t('activity.outcome.all')} scroll />
        </div>
      </div>

      {entries.length === 0 ? (
        <Panel padding="md">
          <RegionState
            glyph="empty"
            title={t('activity.emptyTitle')}
            description={t('activity.emptyBody')}
            action={<Button size="sm" variant="outline" onClick={() => { setScope('all'); setOutcome('all') }}>{t('activity.clearFilters')}</Button>}
          />
        </Panel>
      ) : (
        <div className={css.timeline}>
          {groups.map(group => (
            <section key={group.key} className={css.group} aria-labelledby={`aria-activity-${group.key}`}>
              <h2 className={css.groupTitle} id={`aria-activity-${group.key}`}>
                <span>{group.label}</span>
                <span className={css.groupCount}>{t('activity.eventCount', { count: group.entries.length })}</span>
              </h2>
              <ul className={css.list}>
                {group.entries.map(entry => (
                  <li key={entry.id}>
                    <ActivityRow
                      entry={entry}
                      mission={entry.missionId === null ? undefined : workspace.missions.find(item => item.id === entry.missionId)}
                      agent={entry.agentId === null ? undefined : workspace.agents.find(item => item.id === entry.agentId)}
                      stamp={absoluteStamp(entry.at, now)}
                      showRail
                      selected={entry.id === selected}
                      onOpen={() => { setSelected(entry.id) }}
                      t={t}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <PrototypeNotice text={t('app.prototypeNotice')} />

      <Drawer
        open={event !== undefined}
        onClose={() => { setSelected(undefined) }}
        eyebrow={(
          <>
            <span>{t('activity.detail')}</span>
            <span aria-hidden="true">·</span>
            <span>{event === undefined ? '' : t(`activity.outcome.${event.outcome}`)}</span>
          </>
        )}
        title={event?.title ?? ''}
        closeLabel={t('common.close')}
        hintLabel={t('common.close')}
        footer={event === undefined ? undefined : (
          <>
            {mission === undefined ? null : (
              <Button variant="outline" size="sm" onClick={() => { setSelected(undefined); onOpenMission(mission.id) }}>
                {t('activity.openMission')}
              </Button>
            )}
            {agent === undefined ? null : (
              <Button variant="outline" size="sm" onClick={() => { setSelected(undefined); onOpenAgent(agent.id) }}>
                {t('activity.openAgent')}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setSelected(undefined) }}>{t('common.close')}</Button>
          </>
        )}
      >
        {event === undefined ? null : (
          <>
            <div className={css.eventFacts}>
              <div><span>{t('activity.timestamp')}</span><strong className={css.mono}>{absoluteStamp(event.at, now)}</strong></div>
              <div><span>{t('activity.when')}</span><strong>{relativeAge(event.at, now, t)}</strong></div>
              <div><span>{t('activity.scopeLabel')}</span><strong>{t(`activity.scope.${event.scope}`)}</strong></div>
              <div><span>{t('activity.outcomeLabel')}</span><strong>{t(`activity.outcome.${event.outcome}`)}</strong></div>
            </div>
            <DrawerSection title={t('common.details')}>
              <DrawerProse>{event.detail}</DrawerProse>
            </DrawerSection>
            {mission === undefined ? null : (
              <DrawerSection title={t('activity.openMission')}>
                <button type="button" className={css.linkRow} onClick={() => { setSelected(undefined); onOpenMission(mission.id) }}>
                  <span>{mission.title}</span>
                  <span>{t(`mission.status.${mission.status}`)}</span>
                </button>
              </DrawerSection>
            )}
            {agent === undefined ? null : (
              <DrawerSection title={t('activity.openAgent')}>
                <button type="button" className={css.linkRow} onClick={() => { setSelected(undefined); onOpenAgent(agent.id) }}>
                  <span>{agent.name}</span>
                  <span>{agent.role}</span>
                </button>
              </DrawerSection>
            )}
          </>
        )}
      </Drawer>
    </>
  )
}
