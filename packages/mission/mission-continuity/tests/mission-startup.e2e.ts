/**
 * Automatic mission recovery during a real DSH startup.
 *
 * Every process here boots the shipped `headless` profile — the `base` bundle
 * plus `headless` — through the same profile loader, patch stack, and Cordis
 * Loader the `dsh` launcher uses. The only test-owned input is an overlay that
 * swaps the model route for a keyless adapter, so there is no API key and no
 * external cost, and nothing replaces real startup with a direct call into the
 * recovery package.
 *
 * Stage A creates a mission with an objective and completion criteria,
 * checkpoints it durably, starts a turn, and is `SIGKILL`ed while the model
 * request is still open. Stage B boots a fresh process over the same durable
 * home with the same default configuration, sends no message, and calls no
 * recovery API: it only boots and reports what startup did on its own.
 *
 * The negative case boots the same world with `sweepOnStartup: false` and must
 * show the interrupted mission left untouched.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '../../../test-support/loader-smoke/src/index.ts'

const childScript = fileURLToPath(new URL('./fixtures/mission-startup-child.ts', import.meta.url))
const overlay = fileURLToPath(new URL('./fixtures/mission-startup.patch.yml', import.meta.url))
const disabledOverlay = fileURLToPath(new URL('./fixtures/mission-startup-no-sweep.patch.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

const OBJECTIVE = 'finish the durable mission across a real restart'
const CRITERION = 'the recovered turn reaches the model without a new user message'

/** One running DSH process and everything captured from it. */
interface Child {
  readonly process: ChildProcessByStdio<null, Readable, Readable>
  /** Complete stdout captured so far. */
  output(): string
  /** Complete stderr captured so far. */
  errors(): string
  /** Resolves once the process is gone, however it went. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** First JSON line of the given `type`, or `undefined` before it appears. */
  line(type: string): Record<string, unknown> | undefined
  /** Wait for a JSON line of the given `type`; fails with captured output. */
  waitForLine(type: string, timeoutMs?: number): Promise<Record<string, unknown>>
}

const running: Child[] = []

/** Start one DSH process booting the shipped headless profile. */
function start(
  mode: 'crash' | 'resume' | 'resume-disabled',
  overlayPath: string,
  cwd: string,
  env: Record<string, string>,
): Child {
  const launch = resolveExampleLaunch({
    // Both processes always boot from source through tsx, so this proof needs no
    // build products; the built-bin keyless smoke owns artifact resolution.
    srcBin: childScript,
    mode: 'src',
    tsconfigPath,
    configArgs: [mode, overlayPath],
    env,
  })
  const spawned = spawn(launch.command, launch.args, {
    cwd,
    env: { ...process.env, ...launch.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  spawned.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  spawned.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    spawned.once('exit', (code, signal) => resolve({ code, signal })))
  const line = (type: string): Record<string, unknown> | undefined => stdout
    .split('\n')
    .flatMap((entry) => {
      if (!entry.startsWith('{')) return []
      const parsed = JSON.parse(entry) as Record<string, unknown>
      return parsed['type'] === type ? [parsed] : []
    })
    .at(-1)
  const child: Child = {
    process: spawned,
    exited,
    output: () => stdout,
    errors: () => stderr,
    line,
    async waitForLine(type, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = line(type)
        if (found !== undefined) return found
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for a "${type}" line\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    },
  }
  running.push(child)
  return child
}

/** Wait until the keyless adapter recorded at least one model request. */
async function waitForRequests(path: string, timeoutMs = 120_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lines = await readFile(path, 'utf8').catch(() => '')
    if (lines.trim().length > 0) return lines.trim().split('\n')
    if (Date.now() > deadline) throw new Error(`timed out waiting for a model request in ${path}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Overlay configuration for one process, keyed to one durable home. */
function environment(home: string, logName: string, mockMode: 'hang' | 'answer', extra: Record<string, string> = {}) {
  return {
    DSH_HOME: join(home, '.dsh'),
    MISSION_MOCK_LOG: join(home, logName),
    MISSION_MOCK_MODE: mockMode,
    ...extra,
  }
}

describe('mission continuity at real DSH startup', () => {
  it('recovers an interrupted mission during startup, without a message or a manual call', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mission-startup-'))
    try {
      // Stage A — a real boot creates the mission, then dies abruptly.
      const crashLog = join(home, 'crash-requests.jsonl')
      const crash = start('crash', overlay, home, environment(home, 'crash-requests.jsonl', 'hang'))
      const ready = await crash.waitForLine('ready')
      expect(ready['sessionId']).toBeTypeOf('string')
      expect(ready['settled']).toBe(false)
      expect(ready['criteria']).toEqual([CRITERION])
      // The turn is in flight when the process dies: a real crash, not a clean stop.
      const crashRequests = await waitForRequests(crashLog)
      expect(crashRequests.some(line => line.includes('<mission_recovery'))).toBe(false)
      crash.process.kill('SIGKILL')
      const crashed = await crash.exited
      expect(crashed.signal).toBe('SIGKILL')

      // Stage B — a fresh boot over the same durable home and default config.
      // Nothing here calls sweep(), resume(), or any mission API, and no user
      // message exists to trigger recovery.
      const resumeLog = join(home, 'resume-requests.jsonl')
      const resume = start('resume', overlay, home, environment(home, 'resume-requests.jsonl', 'answer', {
        MISSION_SESSION_ID: String(ready['sessionId']),
      }))
      const report = await resume.waitForLine('report')
      const finished = await resume.exited
      expect(report['error']).toBeUndefined()
      expect(finished.code).toBe(0)
      // Every entry the shipped tree mounts must load: a mission row that could
      // not be imported would fail this check, as it did before the alias fix.
      expect(resume.errors()).not.toContain('failed to import')

      // Startup waited for recovery: the Agent and the attempt are already there
      // when boot() resolves, before this process could do anything else.
      expect(report['liveAgentAtBoot']).toBe(true)
      expect(report['attemptAtBoot']).toBe(1)
      expect(report['interruptionAtBoot']).toBe('process-restart')
      expect(report['checkpointAtBoot']).toMatchObject({ seq: expect.any(Number) })
      expect((report['checkpointAtBoot'] as { seq: number }).seq).toBeGreaterThan(0)
      expect(report['objectiveAtBoot']).toBe(OBJECTIVE)

      // Exactly one recovery: one attempt, one notice, one discovery row.
      expect(report['attempts']).toBe(1)
      expect(report['notices']).toBe(1)
      expect(report['rowsAtBoot']).toHaveLength(1)
      expect(report['rowsAtBoot']).toMatchObject([{
        sessionId: ready['sessionId'],
        attempts: 1,
        state: 'armed',
      }])

      // The recovered Agent actually reached the model and kept working: the
      // objective is armed again and the driver admitted the next round.
      expect(report['objective']).toBe(OBJECTIVE)
      // Recovery re-armed the durable objective before this process ran any turn,
      // and the driver then admitted exactly one further round.
      expect(report['activationAtBoot']).toBe('armed')
      expect(report['roundsStartedAtBoot']).toBeLessThan(2)
      expect(report['roundsStarted']).toBe(2)
      // Recovery is not completion: nothing claims the objective was met.
      expect(report['settled']).toBe(false)

      // The model read a recovery notice carrying the durable mission facts.
      const resumeRequests = (await readFile(resumeLog, 'utf8')).trim().split('\n')
      const notices = resumeRequests.filter(line => line.includes('<mission_recovery'))
      expect(notices).toHaveLength(1)
      const notice = notices[0] ?? ''
      expect(notice).toContain(OBJECTIVE)
      expect(notice).toContain(CRITERION)
      expect(notice).toContain('Interruption being recovered: process-restart')
      expect(notice).toContain('Last consistent checkpoint')

      // Who spoke in the durable conversation: exactly one recovery notice, and
      // nothing from a human after it. Recovery never needed a new user message.
      const messages = report['userSources'] as { source: string; notice: boolean }[]
      const noticeIndex = messages.findIndex(message => message.notice)
      expect(noticeIndex).toBeGreaterThanOrEqual(0)
      expect(messages.filter(message => message.notice)).toHaveLength(1)
      expect(messages.slice(noticeIndex).filter(message => message.source === 'user')).toHaveLength(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 240_000)

  it('leaves the interrupted mission untouched when sweepOnStartup is off', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mission-startup-off-'))
    try {
      const crash = start('crash', overlay, home, environment(home, 'crash-requests.jsonl', 'hang'))
      const ready = await crash.waitForLine('ready')
      await waitForRequests(join(home, 'crash-requests.jsonl'))
      crash.process.kill('SIGKILL')
      expect((await crash.exited).signal).toBe('SIGKILL')

      const resumeLog = join(home, 'resume-requests.jsonl')
      const resume = start('resume-disabled', disabledOverlay, home, environment(home, 'resume-requests.jsonl', 'answer', {
        MISSION_SESSION_ID: String(ready['sessionId']),
      }))
      const report = await resume.waitForLine('report')
      expect((await resume.exited).code).toBe(0)
      expect(resume.errors()).not.toContain('failed to import')

      // Normal startup, and no automatic recovery of any kind.
      expect(report['liveAgentAtBoot']).toBe(false)
      expect(report['liveAgentLater']).toBe(false)
      expect(report['attempts']).toBeUndefined()
      expect(report['notices']).toBe(0)
      const messages = report['userSources'] as { source: string; notice: boolean }[]
      expect(messages.filter(message => message.notice)).toHaveLength(0)
      expect(messages.map(message => message.source)).not.toContain('mission')
      // The mission survives, still armed, with its attempt budget untouched.
      expect(report['rowsAtBoot']).toMatchObject([{
        sessionId: ready['sessionId'],
        attempts: 0,
        state: 'armed',
      }])
      // Nothing reached the model, so nothing was falsely marked complete either.
      expect(await readFile(resumeLog, 'utf8').catch(() => '')).toBe('')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 240_000)
})

// Any process that outlived a failed expectation must not survive the worker.
process.once('exit', () => {
  for (const child of running) child.process.kill('SIGKILL')
})
