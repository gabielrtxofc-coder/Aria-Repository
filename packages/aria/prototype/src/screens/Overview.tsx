/**
 * Overview: the operational dashboard.
 *
 * The screen answers three questions in reading order — what Aria is doing,
 * what needs the operator, and what it has already finished — and it keeps the
 * indicator row narrow so the mission list stays the largest element on the
 * page. Every figure comes from the demonstration workspace.
 */

import { Button } from '../components/primitives.tsx'
import { GlyphAttention, GlyphArrowRight, GlyphNewMission } from '../components/icons.tsx'
import { Metric, PageHeader, ProgressBar, PrototypeNotice } from '../components/Controls.tsx'
import { Panel, SectionHeading } from '../components/Panel.tsx'
import { RegionState } from '../components/Feedback.tsx'
import { StatusDot } from '../components/Status.tsx'
import { ActivityRow, MissionCard, agentTone } from '../components/Record.tsx'
import { absoluteStamp } from '../format.ts'
import type { Workspace } from '../model.ts'
import type { Translate } from '../locales/index.ts'
import css from './Overview.module.css'

/** Which activity entries the dashboard shows before linking to the timeline. */
const ACTIVITY_TAIL = 4

/**
 * Render the overview screen.
 * @param props.workspace - the demonstration workspace.
 * @param props.now - reference moment the relative ages are measured from.
 * @param props.onOpenMission - opens a mission's detail drawer.
 * @param props.onOpenAgent - opens an agent's detail drawer.
 * @param props.onNewMission - opens the new-mission dialog.
 * @param props.onNavigate - moves to another screen.
 * @param props.t - the dictionary resolver.
 * @returns the dashboard.
 */
export function Overview({ workspace, now, onOpenMission, onOpenAgent, onNewMission, onNavigate, t }: {
  workspace: Workspace
  now: string
  onOpenMission: (id: string) => void
  onOpenAgent: (id: string) => void
  onNewMission: () => void
  onNavigate: (route: 'missions' | 'agents' | 'activity') => void
  t: Translate
}) {
  const running = workspace.missions.filter(mission => mission.status === 'running' || mission.status === 'awaiting' || mission.status === 'review')
  const attention = workspace.missions.filter(mission => mission.status === 'awaiting' || mission.status === 'review')
  const engaged = workspace.agents.filter(agent => agent.availability === 'engaged' || agent.availability === 'available')
  const agentById = new Map(workspace.agents.map(agent => [agent.id, agent]))
  const activeAgents = workspace.agents.filter(agent => agent.availability !== 'offline')
  const tail = workspace.activity.slice(0, ACTIVITY_TAIL)

  const hour = Number(now.slice(11, 13))
  const greeting = hour < 12 ? t('overview.greetingMorning') : hour < 18 ? t('overview.greetingAfternoon') : t('overview.greetingEvening')

  return (
    <>
      <PageHeader
        title={t('overview.title')}
        subtitle={t('overview.subtitle')}
        eyebrow={`${t('overview.workspace')} · ${workspace.name}`}
        titleId="aria-overview-title"
        actions={(
          <Button variant="primary" icon={<GlyphNewMission size={15} />} onClick={onNewMission}>
            {t('common.new')}
          </Button>
        )}
      />

      <section className={css.banner} aria-labelledby="aria-overview-banner-title">
        <div className={css.bannerText}>
          <span className={css.bannerGreeting}>{greeting}, {workspace.operator.split(' ').slice(-1)[0]}</span>
          <h2 className={css.bannerTitle} id="aria-overview-banner-title">
            {running.length} {running.length === 1 ? 'mission' : 'missions'} in flight across {workspace.name}
          </h2>
          <p className={css.bannerDetail}>
            Aria is executing {running.filter(mission => mission.status === 'running').length} and holding {attention.length} for your decision.
            {workspace.status.detail === '' ? null : ` ${workspace.status.detail}.`}
          </p>
        </div>
        <div className={css.bannerActions}>
          <Button variant="outline" onClick={onNewMission} icon={<GlyphNewMission size={15} />}>
            {t('overview.quickCreate')}
          </Button>
          <Button variant="ghost" onClick={() => { onNavigate('activity') }} icon={<GlyphArrowRight size={15} />}>
            {t('nav.activity')}
          </Button>
        </div>
      </section>

      <section aria-labelledby="aria-overview-indicators">
        <h2 id="aria-overview-indicators" className={css.visuallyHidden}>
          {t('overview.indicators')}
        </h2>
        <div className={css.indicatorGrid}>
          {workspace.indicators.map(indicator => (
            <div className={css.indicatorCell} key={indicator.id}>
              <Metric
                label={indicator.label}
                value={indicator.value}
                detail={indicator.detail}
                delta={indicator.delta}
                tone={indicator.tone}
              />
            </div>
          ))}
        </div>
      </section>

      <div className={css.columns}>
        <div className={css.stack}>
          <Panel padding="md" as="section" aria-labelledby="aria-overview-missions">
            <SectionHeading
              title={t('overview.activeMissions')}
              id="aria-overview-missions"
              hint={`${running.length} of ${workspace.missions.length} missions`}
              actions={(
                <button type="button" className={css.footLink} onClick={() => { onNavigate('missions') }}>
                  {t('common.viewAll')} <GlyphArrowRight size={13} />
                </button>
              )}
            />
            <ul className={css.missionList} style={{ marginTop: 16 }}>
              {running.length === 0 ? (
                <li>
                  <RegionState
                    glyph="empty"
                    title={t('overview.activeMissionsEmpty')}
                    action={<Button size="sm" variant="outline" onClick={onNewMission}>{t('common.new')}</Button>}
                    compact
                  />
                </li>
              ) : running.map(mission => (
                <li key={mission.id}>
                  <MissionCard
                    mission={mission}
                    agents={workspace.agents}
                    onOpen={() => { onOpenMission(mission.id) }}
                    t={t}
                  />
                </li>
              ))}
            </ul>
          </Panel>

          <Panel padding="md" as="section" aria-labelledby="aria-overview-activity">
            <SectionHeading
              title={t('overview.activity')}
              id="aria-overview-activity"
              hint={t('overview.activityHint')}
              actions={(
                <button type="button" className={css.footLink} onClick={() => { onNavigate('activity') }}>
                  {t('common.viewAll')} <GlyphArrowRight size={13} />
                </button>
              )}
            />
            <ul className={css.activityList} style={{ marginTop: 12 }}>
              {tail.map(entry => (
                <li key={entry.id}>
                  <ActivityRow
                    entry={entry}
                    mission={entry.missionId === null ? undefined : workspace.missions.find(mission => mission.id === entry.missionId)}
                    agent={entry.agentId === null ? undefined : agentById.get(entry.agentId)}
                    stamp={absoluteStamp(entry.at, now)}
                    showRail={false}
                    onOpen={() => { onNavigate('activity') }}
                    t={t}
                  />
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className={css.stack}>
          <Panel padding="md" as="section" aria-labelledby="aria-overview-attention">
            <SectionHeading
              title={t('overview.attention')}
              id="aria-overview-attention"
              hint={attention.length === 0 ? t('overview.attentionEmpty') : undefined}
            />
            <ul className={css.attentionList} style={{ marginTop: 12 }}>
              {attention.length === 0 ? (
                <li>
                  <RegionState glyph="empty" tone="accent" title={t('overview.attentionEmpty')} compact />
                </li>
              ) : attention.map(mission => (
                <li key={mission.id} className={css.attentionItem}>
                  <span className={css.attentionGlyph}><GlyphAttention size={15} /></span>
                  <span className={css.attentionText}>
                    <span className={css.attentionTitle}>{mission.title}</span>
                    <span className={css.attentionDetail}>
                      {mission.status === 'review'
                        ? t('missions.detail.reviewPassed')
                        : t('missions.detail.reviewBlocked')}
                    </span>
                  </span>
                  <span className={css.attentionAction}>
                    <Button size="sm" variant="outline" onClick={() => { onOpenMission(mission.id) }}>
                      {t('overview.attentionAction')}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel padding="md" as="section" aria-labelledby="aria-overview-agents">
            <SectionHeading
              title={t('overview.agents')}
              id="aria-overview-agents"
              hint={`${engaged.length} on duty · ${activeAgents.length} registered`}
              actions={(
                <button type="button" className={css.footLink} onClick={() => { onNavigate('agents') }}>
                  {t('common.viewAll')} <GlyphArrowRight size={13} />
                </button>
              )}
            />
            <ul className={css.agentList} style={{ marginTop: 8 }}>
              {activeAgents.slice(0, 5).map(agent => (
                <li key={agent.id}>
                  <button
                    type="button"
                    className={css.agentRow}
                    data-availability={agent.availability}
                    onClick={() => { onOpenAgent(agent.id) }}
                  >
                    <span className={css.agentMark} aria-hidden="true">{agent.name.slice(0, 2).toUpperCase()}</span>
                    <span className={css.agentText}>
                      <span className={css.agentName}>{agent.name}</span>
                      <span className={css.agentRole}>{agent.role}</span>
                    </span>
                    <StatusDot tone={agentTone(agent.availability)} pulse={agent.availability === 'engaged'} />
                    <span className={css.agentState}>
                      {t(`agent.availability.${agent.availability}`)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel padding="md" as="section" aria-labelledby="aria-overview-pipeline">
            <SectionHeading title={t('overview.pipeline')} id="aria-overview-pipeline" hint={t('overview.pipelineHint')} />
            <ul className={css.pipelineList} style={{ marginTop: 14 }}>
              {running.length === 0 ? (
                <li><RegionState glyph="empty" title={t('overview.queueEmpty')} compact /></li>
              ) : running.map(mission => {
                const stepIndex = mission.steps.findIndex(step => step.status === 'running')
                const step = stepIndex === -1 ? undefined : mission.steps[stepIndex]
                return (
                  <li key={mission.id} className={css.pipelineItem}>
                    <span className={css.pipelineName}>
                      <span className={css.pipelineTitle}>{mission.title}</span>
                      <span className={css.pipelineStep}>
                        {step === undefined
                          ? t('missions.detail.review')
                          : `${t('common.step', { index: stepIndex + 1 })} · ${step.title}`}
                      </span>
                      <ProgressBar
                        value={mission.progress}
                        label={t('missions.progressLabel')}
                        size={3}
                        tone={mission.status === 'awaiting' ? 'warn' : mission.status === 'review' ? 'review' : 'accent'}
                      />
                    </span>
                    <span className={css.pipelineValue}>{mission.progress}%</span>
                  </li>
                )
              })}
            </ul>
          </Panel>
        </div>
      </div>

      <PrototypeNotice text={t('app.prototypeNotice')} />
    </>
  )
}
