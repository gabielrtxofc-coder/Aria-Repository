/**
 * An interrupted external operation, across a real process boundary.
 *
 * Stage A boots the shipped `headless` profile, starts a mission, and lets the
 * keyless model ask for `external_effect` — a simulated non-idempotent tool whose
 * effect lands in a file outside the process and whose body never settles. The
 * parent `SIGKILL`s the process once the effect is visible, so the durable log
 * holds a recorded call with no result while the external world has already
 * changed. That is the exact situation a retry cannot be safe in.
 *
 * Stage B boots a fresh process over the same durable home and default config.
 * Startup must not resume the mission: the report must show a `held` row with the
 * uncertainty code, an unconsumed attempt budget, a durable pending authorization,
 * and no model request. A third process plays the human: it reads that record,
 * clears the authorization, and sweeps. Only then does the mission resume — once,
 * with a notice that names the uncertain call — and the external effect still
 * happened exactly once, because nothing re-invoked the tool.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { expectLaneEntry, startProfileChild } from './fixtures/profile-child.ts'
import type { ProfileChild } from './fixtures/profile-child.ts'

const childScript = fileURLToPath(new URL('./fixtures/mission-uncertain-child.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/mission-startup.patch.yml', import.meta.url))

const running: ProfileChild[] = []

afterEach(() => {
  for (const child of running.splice(0)) child.process.kill('SIGKILL')
})

/** Start one process booting the shipped headless profile over the shared home. */
function start(
  mode: 'crash' | 'held' | 'authorize' | 'authorize-quiet',
  home: string,
  sessionId: string | undefined,
  mockMode: 'tool-call' | 'answer',
  effectMode?: 'before',
): ProfileChild {
  const child = startProfileChild({
    script: childScript,
    args: [mode, overlay],
    cwd: home,
    env: {
      DSH_HOME: join(home, '.dsh'),
      MISSION_MOCK_LOG: join(home, `${mode}-requests.jsonl`),
      MISSION_MOCK_MODE: mockMode,
      MISSION_EFFECT_FILE: join(home, 'external-effects.jsonl'),
      MISSION_EFFECT_FAILPOINT: join(home, 'effect-failpoint'),
      ...effectMode === undefined ? {} : { MISSION_EFFECT_MODE: effectMode },
      ...sessionId === undefined ? {} : { MISSION_SESSION_ID: sessionId },
    },
  })
  running.push(child)
  return child
}

/** Wait until the effect failpoint published by the tool body appears. */
async function waitForEffect(path: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const seen = await readFile(path, 'utf8').catch(() => '')
    if (seen.trim().length > 0) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for the effect failpoint at ${path}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('an interrupted external operation', () => {
  it('is never repeated automatically and is reported as unknown before recovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mission-uncertain-'))
    try {
      // Stage A — the process records the call, changes the external world, and
      // dies before any result becomes durable.
      const crash = start('crash', home, undefined, 'tool-call')
      const ready = await crash.waitForLine('ready')
      expectLaneEntry(ready['missionEntry'], 'crash stage')
      const sessionId = String(ready['sessionId'])
      expect(ready['effects']).toBe(0)
      await waitForEffect(join(home, 'effect-failpoint'))
      const effectFile = join(home, 'external-effects.jsonl')
      const effectsAfterCrash = (await readFile(effectFile, 'utf8')).trim().split('\n')
      expect(effectsAfterCrash).toHaveLength(1)
      crash.process.kill('SIGKILL')
      expect((await crash.exited).signal).toBe('SIGKILL')

      // Stage B — normal startup over the same durable home. It must not resume.
      const held = start('held', home, sessionId, 'answer')
      const heldReport = await held.waitForLine('report')
      expectLaneEntry(heldReport['missionEntry'], 'held stage')
      expect((await held.exited).code).toBe(0)
      expect(held.errors()).not.toContain('failed to import')

      // The interrupted call is durable knowledge: startup recorded it as
      // uncertain and stopped, instead of guessing that it had failed.
      expect(heldReport['liveAgent']).toBe(false)
      // No Agent means no attempt was consumed and no resume ran.
      expect(heldReport['attempts']).toBeUndefined()
      const heldRows = heldReport['rows'] as { state: string; lastError?: { code: string }; attempts: number }[]
      expect(heldRows).toHaveLength(1)
      expect(heldRows[0]).toMatchObject({ state: 'held', attempts: 0, lastError: { code: 'uncertain-operations' } })
      // Nothing reached the model, so nothing could repeat the call or claim it
      // finished.
      expect(heldReport['requests']).toBe(0)
      expect(heldReport['effects']).toHaveLength(1)

      // Stage C — the human path. A reader saw the held row, cleared the
      // authorization, and the ordinary sweep resumed the mission.
      const authorized = start('authorize', home, sessionId, 'answer')
      const report = await authorized.waitForLine('report')
      expectLaneEntry(report['missionEntry'], 'authorize stage')
      expect((await authorized.exited).code).toBe(0)
      // The hold a previous process raised is durable: this process reads the
      // pending authorization from the log before clearing it.
      expect(report['authorizationBefore']).toMatchObject({ code: 'uncertain-operations' })
      expect(report['attemptsBefore']).toBe(0)
      expect(report['uncertainBefore']).toEqual([{ callId: 'call-external-effect', name: 'external_effect' }])
      expect(report['attempts']).toBe(1)
      expect(report['authorization']).toBeUndefined()
      expect(report['report']).toMatchObject({ resumed: 1 })
      // The recovery notice tells the model the truth about the call. It is one
      // durable notice, and the first request the model saw — the mission then
      // keeps running the objective's ordinary rounds, so the raw request count
      // is not fixed and asserting it made this proof race the next round.
      expect(report['notices']).toBe(1)
      const requests = report['requests'] as string[]
      expect(requests[0]).toContain('<mission_recovery')
      expect(requests[0]).toContain('external_effect')
      expect(requests[0]).toContain('outcome is unknown')
      // The tool was not re-invoked by recovery: the external world still holds
      // exactly the one effect the crashed process produced.
      expect(report['effects']).toHaveLength(1)
      expect((await readFile(effectFile, 'utf8')).trim().split('\n')).toHaveLength(1)
      // What the recovery itself wrote, read before the objective's next round
      // can move the row; the round's own outcome is asserted separately below.
      expect(report['rowsAfterResume']).toMatchObject([{ state: 'armed', attempts: 1 }])
      const rows = report['rows'] as { state: string; attempts: number }[]
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ attempts: 1 })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 300_000)

  it('is not assumed to have failed when the process died before the tool ran', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mission-uncertain-before-'))
    try {
      // Stage A — the call is durably recorded and dispatched; the process dies
      // at the top of the tool body, so the external world is untouched.
      const crash = start('crash', home, undefined, 'tool-call', 'before')
      const ready = await crash.waitForLine('ready')
      expectLaneEntry(ready['missionEntry'], 'crash stage')
      const sessionId = String(ready['sessionId'])
      expect(ready['effects']).toBe(0)
      expect((await crash.exited).signal).toBe('SIGKILL')
      const effectFile = join(home, 'external-effects.jsonl')
      expect(await readFile(effectFile, 'utf8').catch(() => '')).toBe('')
      expect(await readFile(join(home, 'effect-failpoint'), 'utf8').catch(() => '')).toBe('')

      // Stage B — no effect on disk is not evidence of failure. Startup must
      // hold the mission and refuse to run the call again on its own.
      const held = start('held', home, sessionId, 'answer')
      const heldReport = await held.waitForLine('report')
      expectLaneEntry(heldReport['missionEntry'], 'held stage')
      expect((await held.exited).code).toBe(0)
      expect(heldReport['liveAgent']).toBe(false)
      expect(heldReport['attempts']).toBeUndefined()
      const heldRows = heldReport['rows'] as { state: string; lastError?: { code: string; message: string }; attempts: number }[]
      expect(heldRows).toHaveLength(1)
      expect(heldRows[0]).toMatchObject({ state: 'held', attempts: 0, lastError: { code: 'uncertain-operations' } })
      expect(heldRows[0]?.lastError?.message).toContain('external_effect')
      expect(heldReport['requests']).toBe(0)
      expect(heldReport['effects']).toEqual([])

      // Stage C — the human path still works, and still does not re-run the call.
      const authorized = start('authorize', home, sessionId, 'answer')
      const report = await authorized.waitForLine('report')
      expect((await authorized.exited).code).toBe(0)
      expect(report['uncertainBefore']).toEqual([{ callId: 'call-external-effect', name: 'external_effect' }])
      expect(report['report']).toMatchObject({ resumed: 1 })
      // One interruption, one recovery: exactly one durable notice, which is
      // what the model read first. Later requests are the mission's own rounds.
      expect(report['notices']).toBe(1)
      const requests = report['requests'] as string[]
      expect(requests[0]).toContain('outcome is unknown')
      expect(report['effects']).toEqual([])
      expect(await readFile(effectFile, 'utf8').catch(() => '')).toBe('')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 300_000)

  it('keeps exactly one recovery notice when the objective runs its next round', async () => {
    // The failure this test guards: after the human clears the doubt, the
    // mission continues its ordinary rounds, so a second model request can
    // legitimately follow the recovery. Counting requests made that a race —
    // observed once in the compiled lane as "expected [ …(2) ] to have a length
    // of 1 but got 2". This stage waits for the second request and the
    // objective's round limit, so that traffic is present every time, and
    // asserts the invariant that does hold: one interruption produces exactly
    // one recovery notice.
    const home = await mkdtemp(join(tmpdir(), 'mission-uncertain-rounds-'))
    try {
      const crash = start('crash', home, undefined, 'tool-call', 'before')
      const ready = await crash.waitForLine('ready')
      expectLaneEntry(ready['missionEntry'], 'crash stage')
      const sessionId = String(ready['sessionId'])
      expect((await crash.exited).signal).toBe('SIGKILL')

      // The `held` boot is part of the scenario: without it the mission is still
      // armed, and the startup sweep would resume it on its own.
      const held = start('held', home, sessionId, 'answer')
      const heldReport = await held.waitForLine('report')
      expect(heldReport['requests']).toBe(0)
      expect((await held.exited).code).toBe(0)

      const authorized = start('authorize-quiet', home, sessionId, 'answer')
      const report = await authorized.waitForLine('report')
      expectLaneEntry(report['missionEntry'], 'authorize stage')
      expect((await authorized.exited).code).toBe(0)

      // The condition that used to fail the assertion is present here by
      // construction: the objective's second round ran.
      const requests = report['requests'] as string[]
      expect(requests.length).toBeGreaterThanOrEqual(2)
      // Yet there is one recovery, one attempt, one row, and one notice.
      expect(report['report']).toMatchObject({ resumed: 1 })
      expect(report['attempts']).toBe(1)
      expect(report['notices']).toBe(1)
      expect(requests[0]).toContain('<mission_recovery')
      expect(requests[0]).toContain('outcome is unknown')
      const rows = report['rows'] as { attempts: number; state: string; lastError?: { code: string } }[]
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ attempts: 1, state: 'held', lastError: { code: 'round-limit' } })
      // Recovery never re-ran the interrupted call.
      expect(report['effects']).toEqual([])
      expect(await readFile(join(home, 'external-effects.jsonl'), 'utf8').catch(() => '')).toBe('')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 300_000)
})
