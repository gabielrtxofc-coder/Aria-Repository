/**
 * The real process boundary: a child process is SIGKILLed mid-request, and a
 * second child process recovers the mission from the durable artifacts alone.
 * Nothing here shares memory with the crashed composition.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it, vi } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const childScript = fileURLToPath(new URL('./fixtures/mission-child.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const roots: string[] = []
const CHILD_TIMEOUT_MS = 60_000

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/**
 * Run one child composition mode.
 * @param mode - composition mode the child runs.
 * @param root - durable root both children share.
 * @param marker - failpoint path the crash child publishes.
 * @returns the child process handle.
 */
function spawnChild(mode: 'crash' | 'recover', root: string, marker: string) {
  return execa(process.execPath, ['--import', tsxLoader, childScript, mode, root, marker], {
    cwd: repoRoot,
    env: { TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json') },
    stdin: 'ignore',
    reject: false,
  })
}

describe('mission continuity across a real process restart', () => {
  it('recovers a mission after the owning process is killed mid-request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mission-crash-'))
    roots.push(root)
    const marker = join(root, 'failpoint')
    await writeFile(marker, '')

    const crashing = spawnChild('crash', root, marker)
    await vi.waitFor(async () => {
      const current = await readFile(marker, 'utf8')
      if (current !== 'turn-dispatched') throw new Error(`crash child has not dispatched its turn: ${current}`)
    }, { interval: 20, timeout: CHILD_TIMEOUT_MS })
    crashing.kill('SIGKILL')
    const crashed = await crashing
    expect({ code: crashed.exitCode ?? null, signal: crashed.signal ?? null })
      .toEqual({ code: null, signal: 'SIGKILL' })

    const recovery = spawnChild('recover', root, marker)
    const finished = await recovery
    expect(finished.exitCode).toBe(0)
    const report = JSON.parse(finished.stdout.trim().split('\n').at(-1)!) as {
      report: Record<string, number>
      attempts: number
      interruption: string
      objective: string
      activations: string[]
      requests: number
      notices: number
    }
    expect(report.report).toMatchObject({ considered: 1, resumed: 1, failed: 0 })
    expect(report.attempts).toBe(1)
    expect(report.interruption).toBe('process-restart')
    expect(report.objective).toBe('survive a machine crash')
    // Recovery re-armed the objective: the activation edge is recorded as it
    // happened, because the continuation rounds move the objective afterwards.
    expect(report.activations).toContain('armed')
    expect(report.notices).toBe(1)
    expect(report.requests).toBeGreaterThan(0)
  }, CHILD_TIMEOUT_MS * 2)
})
