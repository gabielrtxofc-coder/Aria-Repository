/**
 * Application shell: the navigation rail, the top bar and the workspace.
 *
 * The shell owns only chrome. It receives the current route, the workspace
 * record, the navigation counts and the callbacks a screen needs, and renders
 * `children` inside the workspace region — so a screen never has to know how
 * the rail or the top bar are built.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconPanelLeftOutlineRegular } from '../components/primitives.tsx'
import { AriaLockup } from '@deepseek-ai/dsh-aria-wordmark'
import { SystemIndicator } from '../components/Status.tsx'
import { GlyphSearch } from '../components/icons.tsx'
import {
  GlyphActivity, GlyphAgents, GlyphBell, GlyphKnowledge, GlyphMenu, GlyphMissions, GlyphOverview, GlyphSettings,
} from '../components/icons.tsx'
import type { RouteId } from '../routes.ts'
import type { Workspace } from '../model.ts'
import type { Translate } from '../locales/index.ts'
import css from './Shell.module.css'

/** One primary navigation entry. */
interface NavEntry {
  readonly id: RouteId
  readonly label: string
  readonly icon: ReactNode
  /** Optional count rendered as a badge, e.g. missions awaiting the operator. */
  readonly badge?: number | undefined
}

/**
 * Render the application shell.
 * @param props.route - the active screen.
 * @param props.onNavigate - route change handler.
 * @param props.workspace - the workspace record the chrome reports on.
 * @param props.awaitingCount - missions waiting on the operator.
 * @param props.t - the dictionary resolver.
 * @param props.onOpenSearch - handler for the top bar search affordance.
 * @param props.children - the active screen.
 * @returns the shell.
 */
export function Shell({ route, onNavigate, workspace, awaitingCount, t, onOpenSearch, children }: {
  route: RouteId
  onNavigate: (route: RouteId) => void
  workspace: Workspace
  awaitingCount: number
  t: Translate
  onOpenSearch: () => void
  children: ReactNode
}) {
  // Collapse is remembered for the session so a reviewer can keep the rail
  // narrow while moving between screens.
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const contentRef = useRef<HTMLElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)

  // On a narrow viewport the rail becomes an overlay drawer; navigating closes
  // it so the destination is visible immediately.
  const navigate = (next: RouteId): void => {
    onNavigate(next)
    setDrawerOpen(false)
  }

  useEffect(() => {
    contentRef.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0 })
  }, [route])

  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setDrawerOpen(false)
      menuButton.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [drawerOpen])

  const primary: readonly NavEntry[] = [
    { id: 'overview', label: t('nav.overview'), icon: <GlyphOverview size={16} /> },
    { id: 'missions', label: t('nav.missions'), icon: <GlyphMissions size={16} />, badge: awaitingCount === 0 ? undefined : awaitingCount },
    { id: 'agents', label: t('nav.agents'), icon: <GlyphAgents size={16} /> },
    { id: 'knowledge', label: t('nav.knowledge'), icon: <GlyphKnowledge size={16} /> },
    { id: 'activity', label: t('nav.activity'), icon: <GlyphActivity size={16} /> },
  ]
  const secondary: readonly NavEntry[] = [
    { id: 'settings', label: t('nav.settings'), icon: <GlyphSettings size={16} /> },
  ]

  const renderEntry = (entry: NavEntry): ReactNode => (
    <button
      key={entry.id}
      type="button"
      className={css.navItem}
      aria-current={entry.id === route ? 'page' : undefined}
      onClick={() => { navigate(entry.id) }}
      title={collapsed ? entry.label : undefined}
      data-nav-item={entry.id}
    >
      <span className={css.navIcon}>{entry.icon}</span>
      <span className={css.navText}>{entry.label}</span>
      {entry.badge === undefined ? null : <span className={css.navBadge}>{entry.badge}</span>}
    </button>
  )

  const activeLabel = [...primary, ...secondary].find(entry => entry.id === route)?.label ?? ''

  return (
    <div className={css.shell} data-collapsed={collapsed || undefined}>
      <a className={css.skipLink} href="#aria-main">{t('topbar.skipToContent')}</a>

      {drawerOpen ? (
        <button
          type="button"
          className={css.scrim}
          aria-label={t('common.close')}
          tabIndex={-1}
          onClick={() => { setDrawerOpen(false) }}
        />
      ) : null}

      <aside
        className={css.rail}
        data-collapsed={collapsed || undefined}
        data-open={drawerOpen || undefined}
        aria-label={t('nav.sectionPrimary')}
      >
        <div className={css.brandRow}>
          <button
            type="button"
            className={css.brandButton}
            onClick={() => { navigate('overview') }}
            aria-label={t('app.name')}
          >
            <AriaLockup compact={collapsed} tagline={collapsed ? undefined : t('app.descriptor')} />
          </button>
          <button
            type="button"
            className={css.railToggle}
            onClick={() => { setCollapsed(value => !value) }}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!collapsed}
          >
            <IconPanelLeftOutlineRegular size={15} />
          </button>
        </div>

        <nav className={css.nav} aria-label={t('nav.sectionPrimary')}>
          <div className={css.navSection}>
            {collapsed ? null : <span className={css.navLabel}>{t('nav.sectionPrimary')}</span>}
            {primary.map(renderEntry)}
          </div>
          <div className={css.navSection}>
            {collapsed ? null : <span className={css.navLabel}>{t('nav.sectionSecondary')}</span>}
            {secondary.map(renderEntry)}
          </div>
        </nav>

        <div className={css.railSpacer} />

        <div className={css.railFooter}>
          <span className={css.prototypeTag} title={t('app.prototypeNotice')}>
            <span>{t('app.prototypeBadge')}</span>
          </span>
          <div className={css.operator}>
            <span className={css.avatar} aria-hidden="true">{workspace.operatorInitials}</span>
            <span className={css.operatorText}>
              <span className={css.operatorName}>{workspace.operator}</span>
              <span className={css.operatorWorkspace}>{workspace.name}</span>
            </span>
          </div>
        </div>
      </aside>

      <div className={css.main}>
        <header className={css.topbar}>
          <button
            ref={menuButton}
            type="button"
            className={css.menuButton}
            aria-label={t('nav.openMenu')}
            aria-expanded={drawerOpen}
            onClick={() => { setDrawerOpen(value => !value) }}
          >
            <GlyphMenu size={18} />
          </button>
          <nav className={css.crumbs} aria-label={t('app.name')}>
            <span>{workspace.name}</span>
            <span className={css.crumbSeparator} aria-hidden="true">/</span>
            <span className={css.crumbCurrent} aria-current="page">{activeLabel}</span>
          </nav>
          <div className={css.topbarGrow} />
          <div className={css.topbarActions}>
            <SystemIndicator
              state={workspace.status.state}
              label={t('status.nominal')}
              load={workspace.status.load}
              queue={workspace.status.queue}
              t={t}
            />
            <button type="button" className={css.searchTrigger} onClick={onOpenSearch} aria-label={t('topbar.search')}>
              <GlyphSearch size={14} />
              <span className={css.searchTriggerText}>{t('topbar.search')}</span>
              <kbd className={css.visuallyHidden}>{t('topbar.searchShortcut')}</kbd>
            </button>
            <button type="button" className={css.iconButton} aria-label={t('topbar.notifications')}>
              <GlyphBell size={16} />
              {awaitingCount > 0 ? <span className={css.unread} aria-hidden="true" /> : null}
            </button>
          </div>
        </header>

        <main className={clsx(css.content)} id="aria-main" ref={contentRef} tabIndex={-1}>
          <div className={css.contentInner}>{children}</div>
        </main>
      </div>
    </div>
  )
}
