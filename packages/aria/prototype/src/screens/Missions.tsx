/**
 * Missions: the mission register and the mission detail drawer.
 *
 * The list answers "what is running and how far along is it"; the drawer answers
 * "what is the plan, what has happened, and what is left" without leaving the
 * register. Filters and search are local, and an empty result keeps the filter
 * row on screen so the reader can get back.
 */

import { useMemo, useState } from 'react'
import { Button } from '../components/primitives.tsx'
import { FilterRow, Metric, PageHeader, ProgressBar, PrototypeNotice, SearchField } from '../components/Controls.tsx'
import { Panel } from '../components/Panel.tsx'
import { RegionState } from '../components/Feedback.tsx'
import { MissionCard, missionTone } from '../components/Record.tsx'
import { StatusBadge, StatusDot } from '../components/Status.tsx'
import { Drawer, DrawerProse, DrawerSection } from '../components/Drawer.tsx'
import { GlyphArtifact, GlyphAttention, GlyphNewMission, GlyphVerify } from '../components/icons.tsx'
import { absoluteStamp, relativeAge } from '../format.ts'
import type { Mission, MissionStatus, Workspace } from '../model.ts'
import type { Translate } from '../locales/index.ts'
import css from './Missions.module.css'

/** The mission list filter, including the "all" pseudo-status. */
type MissionFilterValue = 'all' | MissionStatus

/**
 * Render the missions screen.
 * @param props.workspace - the demonstration workspace.
 * @param props.now - reference moment for relative ages.
 * @param props.selectedId - mission currently open in the drawer.
 * @param props.onSelect - opens or closes a mission.
 * @param props.onNewMission - opens the new-mission dialog.
 * @param props.onNavigate - moves to another screen.
 * @param props.t - the dictionary resolver.
 * @returns the missions screen and its drawer.
 */
export function Missions({ workspace, now, selectedId, onSelect, onNewMission, onNavigate, t }: {
  workspace: Workspace
  now: string
  selectedId: string | undefined
  onSelect: (id: string | undefined) => void
  onNewMission: () => void
  onNavigate: (route: 'agents' | 'activity') => void
  t: Translate
}) {
  const [filter, setFilter] = useState<MissionFilterValue>('all')
  const [query, setQuery] = useState('')

  const counts = useMemo(() => {
    const map = new Map<MissionFilterValue, number>([['all', workspace.missions.length]])
    for (const mission of workspace.missions) {
      map.set(mission.status, (map.get(mission.status) ?? 0) + 1)
    }
    return map
  }, [workspace.missions])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return workspace.missions.filter(mission => {
      if (filter !== 'all' && mission.status !== filter) return false
      if (needle === '') return true
      return mission.title.toLowerCase().includes(needle)
        || mission.objective.toLowerCase().includes(needle)
        || mission.desk.toLowerCase().includes(needle)
    })
  }, [workspace.missions, filter, query])

  const selected = selectedId === undefined ? undefined : workspace.missions.find(mission => mission.id === selectedId)
  const running = workspace.missions.filter(mission => mission.status === 'running').length
  const awaiting = workspace.missions.filter(mission => mission.status === 'awaiting').length
  const review = workspace.missions.filter(mission => mission.status === 'review').length
  const complete = workspace.missions.filter(mission => mission.status === 'complete').length
  const meanProgress = running + awaiting + review === 0
    ? 0
    : Math.round(workspace.missions
      .filter(mission => mission.status === 'running' || mission.status === 'awaiting' || mission.status === 'review')
      .reduce((sum, mission) => sum + mission.progress, 0) / (running + awaiting + review))
  const newestClosed = workspace.missions
    .filter(mission => mission.status === 'complete')
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
  const oldestWaiting = workspace.missions
    .filter(mission => mission.status === 'awaiting')
    .toSorted((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0]

  const filters: readonly { value: MissionFilterValue, label: string, count: number }[] = [
    { value: 'all', label: t('mission.status.all'), count: counts.get('all') ?? 0 },
    { value: 'running', label: t('mission.status.running'), count: counts.get('running') ?? 0 },
    { value: 'awaiting', label: t('mission.status.awaiting'), count: counts.get('awaiting') ?? 0 },
    { value: 'review', label: t('mission.status.review'), count: counts.get('review') ?? 0 },
    { value: 'complete', label: t('mission.status.complete'), count: counts.get('complete') ?? 0 },
    { value: 'failed', label: t('mission.status.failed'), count: counts.get('failed') ?? 0 },
    { value: 'paused', label: t('mission.status.paused'), count: counts.get('paused') ?? 0 },
  ]

  return (
    <>
      <PageHeader
        title={t('missions.title')}
        subtitle={t('missions.subtitle')}
        eyebrow={`${workspace.name} · ${t('nav.sectionPrimary')}`}
        titleId="aria-missions-title"
        actions={(
          <Button variant="primary" icon={<GlyphNewMission size={15} />} onClick={onNewMission}>
            {t('missions.newMission')}
          </Button>
        )}
      />

      <section className={css.metrics} aria-label={t('overview.indicators')}>
        <div className={css.metricCell}>
          <Metric
            label={t('mission.status.running')}
            value={String(running)}
            tone="accent"
            detail={t('missions.statRunning', { value: meanProgress })}
          />
        </div>
        <div className={css.metricCell}>
          <Metric
            label={t('mission.status.awaiting')}
            value={String(awaiting)}
            tone="warn"
            detail={oldestWaiting === undefined ? t('overview.attentionEmpty') : t('missions.statAwaiting', { when: relativeAge(oldestWaiting.updatedAt, now, t) })}
          />
        </div>
        <div className={css.metricCell}>
          <Metric label={t('mission.status.review')} value={String(review)} detail={t('missions.statReview')} />
        </div>
        <div className={css.metricCell}>
          <Metric
            label={t('mission.status.complete')}
            value={String(complete)}
            detail={newestClosed === undefined
              ? t('common.empty')
              : t('missions.statComplete', { when: relativeAge(newestClosed.updatedAt, now, t) })}
          />
        </div>
      </section>

      <div className={css.toolbar}>
        <FilterRow
          options={filters}
          value={filter}
          onChange={setFilter}
          label={t('common.filters')}
          scroll
        />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('missions.search')}
          label={t('missions.search')}
          clearLabel={t('common.clear')}
        />
      </div>

      <p className={css.count} aria-live="polite">
        {query.trim() === '' && filter === 'all'
          ? t('missions.count', { count: visible.length })
          : t('missions.countFiltered', { shown: visible.length, total: workspace.missions.length })}
      </p>

      {visible.length === 0 ? (
        <Panel padding="md">
          <RegionState
            glyph="search"
            title={t('missions.emptyTitle')}
            description={t('missions.emptyBody')}
            action={(
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setFilter('all'); setQuery('') }}
              >
                {t('missions.clearFilters')}
              </Button>
            )}
          />
        </Panel>
      ) : (
        <ul className={css.grid}>
          {visible.map(mission => (
            <li key={mission.id}>
              <MissionCard
                mission={mission}
                agents={workspace.agents}
                selected={mission.id === selectedId}
                onOpen={() => { onSelect(mission.id) }}
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
        eyebrow={(
          <>
            <span>{selected?.desk ?? ''}</span>
            <span aria-hidden="true">·</span>
            <span className={css.mono}>{selected?.id ?? ''}</span>
          </>
        )}
        title={selected?.title ?? ''}
        closeLabel={t('common.close')}
        hintLabel={t('common.close')}
        width="wide"
        footer={selected === undefined ? undefined : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onSelect(undefined)
                onNavigate('activity')
              }}
            >
              {t('missions.detail.events')}
            </Button>
            {selected.status === 'awaiting' || selected.status === 'review' ? (
              <>
                <Button variant="outline" size="sm">{t('missions.detail.requestChanges')}</Button>
                <Button variant="primary" size="sm">{t('missions.detail.approve')}</Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => { onSelect(undefined) }}>{t('common.close')}</Button>
            )}
          </>
        )}
      >
        {selected === undefined ? null : (
          <MissionDetail
            mission={selected}
            workspace={workspace}
            now={now}
            onOpenAgent={() => { onSelect(undefined); onNavigate('agents') }}
            t={t}
          />
        )}
      </Drawer>
    </>
  )
}

/**
 * Render the body of a mission's detail drawer.
 * @param props.mission - the mission being shown.
 * @param props.workspace - the workspace, for agent lookups.
 * @param props.now - reference moment for relative ages.
 * @param props.onOpenAgent - opens an agent from a step's assignment.
 * @param props.t - the dictionary resolver.
 * @returns the detail body.
 */
function MissionDetail({ mission, workspace, now, onOpenAgent, t }: {
  mission: Mission
  workspace: Workspace
  now: string
  onOpenAgent: () => void
  t: Translate
}) {
  const tone = missionTone(mission.status)
  const agentById = new Map(workspace.agents.map(agent => [agent.id, agent]))
  const completeSteps = mission.steps.filter(step => step.status === 'complete').length
  const settledSteps = mission.steps.filter(step => step.status === 'complete' || step.status === 'failed' || step.status === 'skipped').length
  const currentIndex = mission.steps.findIndex(step => step.status === 'running')
  const reviewCopy = mission.status === 'review'
    ? t('missions.detail.reviewPassed')
    : mission.status === 'awaiting'
      ? t('missions.detail.reviewBlocked')
      : mission.status === 'failed'
        ? t('missions.detail.reviewFailed')
        : t('missions.detail.reviewRunning')

  return (
    <>
      <div className={css.detailHeader}>
        <StatusBadge tone={tone} label={t(`mission.status.${mission.status}`)} pulse={mission.status === 'running'} />
        <div className={css.detailProgress}>
          <ProgressBar
            value={mission.progress}
            label={t('missions.progressLabel')}
            tone={mission.status === 'failed' ? 'danger' : mission.status === 'awaiting' ? 'warn' : mission.status === 'review' ? 'review' : 'accent'}
          />
          <div className={css.detailProgressMeta}>
            <span className={css.mono}>{mission.progress}%</span>
            <span>{t('missions.detail.stepsCount', { done: completeSteps, settled: settledSteps, total: mission.steps.length })}</span>
          </div>
        </div>
      </div>

      <DrawerSection title={t('missions.detail.objective')}>
        <DrawerProse>{mission.objective}</DrawerProse>
        <DrawerProse>{mission.brief}</DrawerProse>
      </DrawerSection>

      <DrawerSection title={t('missions.detail.plan')}>
        <ol className={css.steps}>
          {mission.steps.map((step, index) => {
            const agent = step.agentId === null ? undefined : agentById.get(step.agentId)
            const state = step.status === 'complete' ? 'done' : step.status === 'running' ? 'active' : step.status === 'failed' ? 'failed' : step.status === 'skipped' ? 'idle' : 'pending'
            return (
              <li key={step.id} className={css.step} data-state={state}>
                <span className={css.stepMarker} aria-hidden="true">
                  {step.status === 'complete' ? '✓' : step.status === 'failed' ? '!' : String(index + 1).padStart(2, '0')}
                </span>
                <span className={css.stepBody}>
                  <span className={css.stepTitle}>
                    {step.title}
                    {index === currentIndex ? <span className={css.stepNow}>{t('missions.detail.currentStep')}</span> : null}
                  </span>
                  <span className={css.stepDetail}>{step.detail}</span>
                  <span className={css.stepMeta}>
                    {agent === undefined ? null : (
                      <button type="button" className={css.stepAgent} onClick={onOpenAgent}>
                        {agent.name}
                      </button>
                    )}
                    <span className={css.mono}>{step.timing}</span>
                    <span>{t(`mission.status.${stepStatusWord(step.status)}`)}</span>
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      </DrawerSection>

      <DrawerSection title={t('missions.detail.review')}>
        <div className={css.reviewRow}>
          <span className={css.reviewGlyph} data-tone={mission.status === 'awaiting' ? 'warn' : mission.status === 'failed' ? 'danger' : 'neutral'}>
            {mission.status === 'awaiting' || mission.status === 'failed' ? <GlyphAttention size={15} /> : <GlyphVerify size={15} />}
          </span>
          <p className={css.reviewText}>{reviewCopy}</p>
        </div>
      </DrawerSection>

      <DrawerSection title={t('missions.detail.artifacts')}>
        {mission.artifacts.length === 0 ? (
          <RegionState glyph="empty" title={t('missions.detail.artifactsEmpty')} compact align="start" />
        ) : (
          <ul className={css.artifacts}>
            {mission.artifacts.map(artifact => (
              <li key={artifact.id} className={css.artifact}>
                <span className={css.artifactGlyph}><GlyphArtifact size={15} /></span>
                <span className={css.artifactText}>
                  <span className={css.artifactName}>{artifact.name}</span>
                  <span className={css.artifactMeta}>{artifact.meta}</span>
                </span>
                <span className={css.artifactKind}>{artifact.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </DrawerSection>

      <DrawerSection title={t('missions.detail.events')}>
        <ol className={css.events}>
          {mission.events.map(event => {
            const agent = event.actorId === null ? undefined : agentById.get(event.actorId)
            return (
              <li key={event.id} className={css.event} data-kind={event.kind}>
                <span className={css.eventTime}>{absoluteStamp(event.at, now)}</span>
                <StatusDot
                  tone={event.kind === 'failure' ? 'failed' : event.kind === 'warning' ? 'waiting' : event.kind === 'approval' ? 'review' : event.kind === 'artifact' ? 'active' : 'done'}
                  size={6}
                />
                <span className={css.eventText}>
                  <span>{event.summary}</span>
                  <span className={css.eventActor}>{agent === undefined ? eventKindLabel(event.kind, t) : `${agent.name} · ${eventKindLabel(event.kind, t)}`}</span>
                </span>
              </li>
            )
          })}
        </ol>
      </DrawerSection>

      <p className={css.detailFooter}>
        {t('common.created', { when: relativeAge(mission.createdAt, now, t) })}
        <span aria-hidden="true"> · </span>
        {t('common.updated', { when: relativeAge(mission.updatedAt, now, t) })}
        <span aria-hidden="true"> · </span>
        <button type="button" className={css.stepAgent} onClick={onOpenAgent}>
          {mission.agentIds.map(id => agentById.get(id)?.name).filter(Boolean).join(', ')}
        </button>
      </p>
    </>
  )
}

/**
 * Map a step status onto the mission status word the interface already has.
 * @param status - step lifecycle state.
 * @returns the mission status whose label the step borrows.
 */
function stepStatusWord(status: Mission['steps'][number]['status']): MissionStatus {
  switch (status) {
    case 'complete': return 'complete'
    case 'running': return 'running'
    case 'failed': return 'failed'
    case 'skipped': return 'paused'
    case 'pending': return 'paused'
  }
}

/**
 * Describe an event kind in the existing status vocabulary.
 * @param kind - the recorded event kind.
 * @param t - the dictionary resolver.
 * @returns a short event classification.
 */
function eventKindLabel(kind: Mission['events'][number]['kind'], t: Translate): string {
  switch (kind) {
    case 'plan': return t('missions.detail.plan')
    case 'action': return t('activity.title')
    case 'approval': return t('missions.detail.review')
    case 'artifact': return t('missions.detail.artifacts')
    case 'warning': return t('activity.outcome.attention')
    case 'failure': return t('activity.outcome.failure')
  }
}
