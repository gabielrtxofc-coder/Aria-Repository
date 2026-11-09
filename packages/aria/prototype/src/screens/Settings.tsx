/**
 * Settings: the six configuration sections, presented as visual reference.
 *
 * Every control on this screen is local component state or a disabled read-only
 * value. Nothing is persisted, no credential is requested, and no configuration
 * of the host application is read or written — the subtitle and the notice say so
 * on the page itself.
 */

import { useState } from 'react'
import { Button, Input, Switch } from '../components/primitives.tsx'
import { PageHeader, PrototypeNotice } from '../components/Controls.tsx'
import { Panel, SectionHeading } from '../components/Panel.tsx'
import { StatusBadge } from '../components/Status.tsx'
import { Tag } from '../components/Record.tsx'
import {
  GlyphAppearance, GlyphGeneral, GlyphIntegration, GlyphMemory, GlyphModel, GlyphSecurity,
} from '../components/icons.tsx'
import type { Workspace } from '../model.ts'
import type { Translate } from '../locales/index.ts'
import css from './Settings.module.css'

/** The six settings sections. */
type SettingsSection = 'general' | 'appearance' | 'models' | 'memory' | 'integrations' | 'security'

/** A glyph per section, so the rail reads at a glance without labels competing. */
const SECTION_GLYPH: Record<SettingsSection, React.ReactNode> = {
  general: <GlyphGeneral size={15} />,
  appearance: <GlyphAppearance size={15} />,
  models: <GlyphModel size={15} />,
  memory: <GlyphMemory size={15} />,
  integrations: <GlyphIntegration size={15} />,
  security: <GlyphSecurity size={15} />,
}

/**
 * Render the settings screen.
 * @param props.workspace - the demonstration workspace, for the identity rows.
 * @param props.t - the dictionary resolver.
 * @returns the settings screen.
 */
export function Settings({ workspace, t }: { workspace: Workspace, t: Translate }) {
  const [section, setSection] = useState<SettingsSection>('general')
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable')
  const [reduceMotion, setReduceMotion] = useState(false)
  const [citations, setCitations] = useState(true)
  const [transcripts, setTranscripts] = useState(true)
  const [approvals, setApprovals] = useState(true)

  const sections: readonly { value: SettingsSection, label: string }[] = [
    { value: 'general', label: t('settings.section.general') },
    { value: 'appearance', label: t('settings.section.appearance') },
    { value: 'models', label: t('settings.section.models') },
    { value: 'memory', label: t('settings.section.memory') },
    { value: 'integrations', label: t('settings.section.integrations') },
    { value: 'security', label: t('settings.section.security') },
  ]

  return (
    <>
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        eyebrow={`${workspace.name} · ${t('nav.sectionSecondary')}`}
        titleId="aria-settings-title"
      />

      <div className={css.layout}>
        <nav className={css.rail} aria-label={t('settings.title')}>
          <ul className={css.sectionList}>
            {sections.map(item => (
              <li key={item.value}>
                <button
                  type="button"
                  className={css.sectionItem}
                  data-active={item.value === section || undefined}
                  aria-current={item.value === section ? 'page' : undefined}
                  onClick={() => { setSection(item.value) }}
                >
                  <span className={css.sectionGlyph}>{SECTION_GLYPH[item.value]}</span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className={css.main}>
          {section === 'general' ? (
            <Panel padding="md" as="section" aria-labelledby="aria-settings-general">
              <SectionHeading title={t('settings.section.general')} id="aria-settings-general" hint={t('settings.subtitle')} />
              <dl className={css.rows}>
                <Row label={t('settings.general.workspaceName')}>
                  <Input value={workspace.name} readOnly aria-label={t('settings.general.workspaceName')} />
                </Row>
                <Row label={t('settings.general.operator')} hint={workspace.operatorInitials}>
                  <Input value={workspace.operator} readOnly aria-label={t('settings.general.operator')} />
                </Row>
                <Row label={t('settings.general.locale')}>
                  <p className={css.value}>{t('settings.general.localeValue')}</p>
                </Row>
                <Row label={t('settings.general.timezone')}>
                  <p className={css.value}>UTC · 09:40</p>
                </Row>
                <Row label={t('settings.general.density')} hint={t('settings.general.densityHint')}>
                  <div className={css.segmented} role="group" aria-label={t('settings.general.density')}>
                    <button
                      type="button"
                      aria-pressed={density === 'comfortable'}
                      onClick={() => { setDensity('comfortable') }}
                    >
                      {t('settings.general.densityComfortable')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={density === 'compact'}
                      onClick={() => { setDensity('compact') }}
                    >
                      {t('settings.general.densityCompact')}
                    </button>
                  </div>
                </Row>
              </dl>
              <p className={css.previewNote}>
                {density === 'comfortable' ? t('settings.general.densityComfortable') : t('settings.general.densityCompact')}
                {' · '}
                {t('settings.general.densityHint')}
              </p>
            </Panel>
          ) : null}

          {section === 'appearance' ? (
            <>
              <Panel padding="md" as="section" aria-labelledby="aria-settings-appearance">
                <SectionHeading title={t('settings.section.appearance')} id="aria-settings-appearance" />
                <dl className={css.rows}>
                  <Row label={t('settings.appearance.theme')}>
                    <p className={css.value}>{t('settings.appearance.themeValue')}</p>
                  </Row>
                  <Row label={t('settings.appearance.accent')}>
                    <span className={css.swatches}>
                      <span className={css.swatch} data-swatch="lime" aria-label={t('settings.appearance.accentValue')} />
                      <span className={css.value}>{t('settings.appearance.accentValue')}</span>
                    </span>
                  </Row>
                  <Row label={t('settings.appearance.motion')} hint={t('settings.appearance.motionHint')}>
                    <Switch checked={reduceMotion} onChange={setReduceMotion} label={t('settings.appearance.motion')} />
                  </Row>
                </dl>
              </Panel>
              <Panel padding="md" as="section" aria-labelledby="aria-settings-type">
                <SectionHeading title={t('settings.appearance.typeScale')} id="aria-settings-type" hint={t('settings.appearance.sample')} />
                <div className={css.typeScale}>
                  <div><span className={css.typeMeta}>28 / 600</span><p className={css.typeDisplay}>Aria</p></div>
                  <div><span className={css.typeMeta}>20 / 500</span><p className={css.typeH1}>Mission register</p></div>
                  <div><span className={css.typeMeta}>14 / 500</span><p className={css.typeBody}>{t('settings.appearance.sample')}</p></div>
                  <div><span className={css.typeMeta}>11 / 400</span><p className={css.typeMetaText}>{t('settings.appearance.sample')}</p></div>
                  <div><span className={css.typeMeta}>9 / 500 · caps</span><p className={css.typeLabel}>Operational intelligence</p></div>
                </div>
              </Panel>
            </>
          ) : null}

          {section === 'models' ? (
            <Panel padding="md" as="section" aria-labelledby="aria-settings-models">
              <SectionHeading title={t('settings.section.models')} id="aria-settings-models" hint={t('settings.models.note')} />
              <dl className={css.rows}>
                <Row label={t('settings.models.routing')}>
                  <p className={css.value}>{t('settings.models.routingValue')}</p>
                </Row>
                {[
                  { label: t('settings.models.reasoner'), model: 'dsh-reasoner', ctx: '200K' },
                  { label: t('settings.models.retriever'), model: 'dsh-retriever', ctx: '128K' },
                  { label: t('settings.models.writer'), model: 'dsh-writer', ctx: '64K' },
                  { label: t('settings.models.verifier'), model: 'dsh-verifier', ctx: '32K' },
                ].map(entry => (
                  <Row key={entry.model} label={entry.label}>
                    <span className={css.modelRow}>
                      <span className={css.mono}>{entry.model}</span>
                      <Tag tone="muted">{entry.ctx}</Tag>
                      <Tag tone="accent">{t('settings.models.default')}</Tag>
                    </span>
                  </Row>
                ))}
              </dl>
            </Panel>
          ) : null}

          {section === 'memory' ? (
            <Panel padding="md" as="section" aria-labelledby="aria-settings-memory">
              <SectionHeading title={t('settings.section.memory')} id="aria-settings-memory" hint={t('settings.memory.scopeValue')} />
              <dl className={css.rows}>
                <Row label={t('settings.memory.scope')}>
                  <p className={css.value}>{t('settings.memory.scopeValue')}</p>
                </Row>
                <Row label={t('settings.memory.citations')} hint={t('settings.memory.citationsHint')}>
                  <Switch checked={citations} onChange={setCitations} label={t('settings.memory.citations')} />
                </Row>
                <Row label={t('settings.memory.transcript')} hint={t('settings.memory.transcriptHint')}>
                  <Switch checked={transcripts} onChange={setTranscripts} label={t('settings.memory.transcript')} />
                </Row>
              </dl>
            </Panel>
          ) : null}

          {section === 'integrations' ? (
            <Panel padding="md" as="section" aria-labelledby="aria-settings-integrations">
              <SectionHeading title={t('settings.section.integrations')} id="aria-settings-integrations" hint={t('settings.integrations.note')} />
              <ul className={css.integrations}>
                {[
                  { name: 'Legal vault', detail: 'Contracts and amendments', state: 'connected' as const },
                  { name: 'Finance archive', detail: 'Ledgers and margin bridges', state: 'connected' as const },
                  { name: 'Supplier register', detail: 'Vendor onboarding records', state: 'pending' as const },
                  { name: 'Trade feed', detail: 'Container rate index', state: 'disabled' as const },
                ].map(item => (
                  <li key={item.name} className={css.integration} data-state={item.state}>
                    <span className={css.integrationGlyph}><GlyphIntegration size={16} /></span>
                    <span className={css.integrationText}>
                      <span className={css.integrationName}>{item.name}</span>
                      <span className={css.integrationDetail}>{item.detail}</span>
                    </span>
                    <StatusBadge
                      tone={item.state === 'connected' ? 'active' : item.state === 'pending' ? 'waiting' : 'idle'}
                      label={t(`settings.integrations.${item.state}`)}
                    />
                    <Button size="sm" variant="ghost" disabled>{t('settings.integrations.manage')}</Button>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {section === 'security' ? (
            <Panel padding="md" as="section" aria-labelledby="aria-settings-security">
              <SectionHeading title={t('settings.section.security')} id="aria-settings-security" hint={t('settings.security.sessionValue')} />
              <dl className={css.rows}>
                <Row label={t('settings.security.session')}>
                  <p className={css.value}>{t('settings.security.sessionValue')}</p>
                </Row>
                <Row label={t('settings.security.approvals')} hint={t('settings.security.approvalsHint')}>
                  <Switch checked={approvals} onChange={setApprovals} label={t('settings.security.approvals')} />
                </Row>
                <Row label={t('settings.security.audit')} hint={t('settings.security.auditHint')}>
                  <Tag tone="accent">Append only</Tag>
                </Row>
                <Row label={t('settings.security.export')}>
                  <Button size="sm" variant="outline" disabled>{t('settings.security.export')}</Button>
                </Row>
              </dl>
            </Panel>
          ) : null}

          <PrototypeNotice text={t('app.prototypeNotice')} />
        </div>
      </div>
    </>
  )
}

/**
 * Render one label/value row in a settings group.
 * @param props.label - the row label.
 * @param props.hint - optional supporting line under the label.
 * @param props.children - the control.
 * @returns the row.
 */
function Row({ label, hint, children }: { label: string, hint?: string, children: React.ReactNode }) {
  return (
    <div className={css.row}>
      <div className={css.rowLabel}>
        <dt>{label}</dt>
        {hint === undefined ? null : <dd>{hint}</dd>}
      </div>
      <div className={css.rowControl}>{children}</div>
    </div>
  )
}
