/**
 * Route state, navigation and the new-mission flow.
 *
 * These specs drive the real application component: they mount `AriaPrototype`,
 * click the same controls a reader clicks, and assert on what the browser would
 * show. Nothing is stubbed except the two browser APIs jsdom lacks (see
 * `setup.ts`), so a passing run is evidence that the interaction works, not that
 * a mock was called.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AriaPrototype } from '../src/App.tsx'
import { DEMO_WORKSPACE } from '../src/fixtures.ts'
import { formatLocation, parseLocation } from '../src/routes.ts'

/** Reset the hash between specs so each one starts from the overview. */
beforeEach(() => {
  window.history.replaceState(null, '', '#/overview')
})

describe('routing', () => {
  it('parses and formats a location round-trip', () => {
    const location = parseLocation('#/missions?mission=mis-q4-supply')
    expect(location.route).toBe('missions')
    expect(location.query.mission).toBe('mis-q4-supply')
    expect(formatLocation(location)).toBe('#/missions?mission=mis-q4-supply')
  })

  it('falls back to the overview for an unknown route', () => {
    expect(parseLocation('#/nope').route).toBe('overview')
    expect(parseLocation('').route).toBe('overview')
  })

  it('renders the overview first and moves the hash on navigation', async () => {
    render(<AriaPrototype />)
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy()

    fireEvent.click(document.querySelector('[data-nav-item="missions"]') as HTMLElement)
    await waitFor(() => { expect(window.location.hash).toBe('#/missions') })
    expect(screen.getByRole('heading', { level: 1, name: 'Missions' })).toBeTruthy()

    fireEvent.click(document.querySelector('[data-nav-item="activity"]') as HTMLElement)
    await waitFor(() => { expect(window.location.hash).toBe('#/activity') })
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeTruthy()
  })

  it('opens a screen directly from the hash', () => {
    window.history.replaceState(null, '', '#/settings')
    render(<AriaPrototype />)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy()
  })
})

describe('mission detail', () => {
  it('opens from a mission card and closes with Escape', async () => {
    window.history.replaceState(null, '', '#/missions')
    render(<AriaPrototype />)

    const cards = screen.getAllByRole('button', { name: new RegExp(DEMO_WORKSPACE.missions[0]?.title ?? '') })
    fireEvent.click(cards[0] as HTMLElement)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading', { name: DEMO_WORKSPACE.missions[0]?.title ?? '' })).toBeTruthy()
    // The objective, the plan and the review status are all present.
    expect(within(dialog).getByRole('heading', { name: 'Objective' })).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: 'Execution plan' })).toBeTruthy()
    // "Review status" labels the section and the badge inside it; the heading is the section.
    expect(within(dialog).getAllByText('Review status').length).toBeGreaterThan(0)

    fireEvent.keyDown(document.querySelector('[role="dialog"]') as HTMLElement, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
})

describe('mission filters', () => {
  it('narrows the register and can be cleared from the empty state', async () => {
    window.history.replaceState(null, '', '#/missions')
    render(<AriaPrototype />)

    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    const failed = DEMO_WORKSPACE.missions.filter(mission => mission.status === 'failed')
    expect(failed.length).toBeGreaterThan(0)
    expect(screen.getByText(`${failed.length} of ${DEMO_WORKSPACE.missions.length} missions`)).toBeTruthy()

    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'zzzz no such mission' } })
    expect(await screen.findByText('No mission matches this filter')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.queryByText('No mission matches this filter')).toBeNull()
  })
})

describe('new mission', () => {
  it('requires an objective before it will create anything', async () => {
    render(<AriaPrototype />)

    fireEvent.click(screen.getByRole('button', { name: /New mission/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create mission' }))
    expect(await within(dialog).findByText('An objective is required.')).toBeTruthy()
  })

  it('adds a demonstration mission to local state and opens it', async () => {
    render(<AriaPrototype />)

    fireEvent.click(screen.getByRole('button', { name: /New mission/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Objective'), { target: { value: 'Audit the northern freight surcharge' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create mission' }))

    // The dialog reports a planning step, then the register opens on the new mission.
    await waitFor(() => { expect(window.location.hash).toContain('#/missions?mission=mis-demo-') }, { timeout: 4000 })
    const drawer = await screen.findByRole('dialog')
    // The new mission's title is the drawer heading; its objective repeats in the body.
    expect(within(drawer).getAllByText(/Audit the northern freight surcharge/).length).toBeGreaterThan(0)
    expect(within(drawer).getByText('Execution plan')).toBeTruthy()
    expect(window.location.hash).toMatch(/^#\/missions\?mission=mis-demo-/)
  })
})

describe('agents', () => {
  it('filters the roster and opens an agent', async () => {
    window.history.replaceState(null, '', '#/agents')
    render(<AriaPrototype />)

    fireEvent.click(screen.getByRole('button', { name: /^Engaged/ }))
    const engaged = DEMO_WORKSPACE.agents.filter(agent => agent.availability === 'engaged')
    for (const agent of DEMO_WORKSPACE.agents) {
      const heading = screen.queryByText(agent.name)
      if (engaged.some(item => item.id === agent.id)) expect(heading).toBeTruthy()
      else expect(heading).toBeNull()
    }

    fireEvent.click(screen.getByText(engaged[0]?.name ?? ''))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('Capabilities')).toBeTruthy()
    expect(within(drawer).getByText('Current assignments')).toBeTruthy()
  })
})

describe('knowledge', () => {
  it('searches resources and shows the empty state', async () => {
    window.history.replaceState(null, '', '#/knowledge')
    render(<AriaPrototype />)

    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'halden' } })
    expect(screen.getByText('Halden Systems — master services agreement')).toBeTruthy()
    expect(screen.queryByText('Replenishment planning playbook')).toBeNull()

    fireEvent.change(search, { target: { value: '' } })
    fireEvent.change(search, { target: { value: 'nothing matches this' } })
    expect(await screen.findByText('No resource matches this search')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByText('Replenishment planning playbook')).toBeTruthy()
  })
})

describe('activity', () => {
  it('filters by outcome and opens an event', async () => {
    window.history.replaceState(null, '', '#/activity')
    render(<AriaPrototype />)

    fireEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    const failed = DEMO_WORKSPACE.activity.filter(entry => entry.outcome === 'failure')
    expect(failed.length).toBeGreaterThan(0)
    const rows = screen.getAllByRole('button', { name: new RegExp(failed[0]?.title ?? '') })
    fireEvent.click(rows[0] as HTMLElement)
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('Scope')).toBeTruthy()
    expect(within(drawer).getByText('Outcome')).toBeTruthy()
  })
})
