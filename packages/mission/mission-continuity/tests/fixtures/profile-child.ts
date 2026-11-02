/**
 * One DSH child process for the mission proofs, and the JSON lines it reports.
 *
 * The launch lane comes from the environment, like every other example smoke:
 * the ordinary lane boots the child from source through tsx, and the built lane
 * (`DSH_EXAMPLE_MODE=lib`) boots the same child under plain Node, where every
 * package resolves through its `exports` map into built `lib/`. The child itself
 * stays a TypeScript fixture in both lanes, so the only difference between them
 * is where the composition's packages come from.
 * @module profile-child
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  resolveExampleLaunch,
  resolveExampleMode,
} from '../../../../test-support/loader-smoke/src/index.ts'

// Five levels up: this fixture lives under `<package>/tests/fixtures/`.
const tsconfigPath = fileURLToPath(new URL('../../../../../tsconfig.json', import.meta.url))

/** One running DSH process and everything captured from it. */
export interface ProfileChild {
  /** The spawned process, for signals. */
  readonly process: ChildProcessByStdio<null, Readable, Readable>
  /** Complete stdout captured so far. */
  output(): string
  /** Complete stderr captured so far. */
  errors(): string
  /** Resolves once the process is gone, however it went. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Last JSON line of the given `type`, or `undefined` before it appears. */
  line(type: string): Record<string, unknown> | undefined
  /** Wait for a JSON line of the given `type`; fails with captured output. */
  waitForLine(type: string, timeoutMs?: number): Promise<Record<string, unknown>>
}

/** Inputs for {@link startProfileChild}. */
export interface ProfileChildOptions {
  /** Absolute child fixture entry. */
  readonly script: string
  /** Arguments the fixture reads as its own mode and paths. */
  readonly args: readonly string[]
  /** Process working directory the composition boots in. */
  readonly cwd: string
  /** Environment layered over the parent's. */
  readonly env: Record<string, string>
}

/**
 * Start one profile child in the lane's launch mode.
 * @param options - child entry, arguments, cwd, and environment.
 * @returns the running child with its JSON line reader.
 */
export function startProfileChild(options: ProfileChildOptions): ProfileChild {
  const launch = resolveExampleLaunch({
    srcBin: options.script,
    libBin: options.script,
    mode: resolveExampleMode(),
    tsconfigPath,
    configArgs: [...options.args],
    env: options.env,
  })
  const spawned = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: { ...process.env, ...launch.env, ...options.env },
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
  return {
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
}

/**
 * Assert the lane actually loaded the artifact it claims to load.
 * @param entry - `import.meta.resolve` result the child reported.
 * @param where - child label for the failure message.
 */
export function expectLaneEntry(entry: unknown, where: string): void {
  const mode = resolveExampleMode()
  const resolved = String(entry)
  const expected = mode === 'lib' ? '/lib/' : '/src/'
  if (!resolved.includes(expected)) {
    throw new Error(`${where}: ${mode} lane loaded "${resolved}", which is not a ${expected} artifact`)
  }
}
