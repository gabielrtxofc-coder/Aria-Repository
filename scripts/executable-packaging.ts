/** Shared production-deploy preparation for the SDK and SSH executable carriers. */
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'

/**
 * Describe the mismatch between the workspace's pinned pnpm and the one that
 * will run the deploy, or `null` when the majors agree.
 *
 * `pnpm deploy --legacy` re-resolves open ranges with the running resolver, so
 * a different major can produce a closure the lock never reviewed — that is how
 * `@swc/helpers ^0.5.12` reached packaging as 0.5.24 while the lock held 0.5.23.
 * @param expectedVersion - `packageManager` version from the workspace manifest.
 * @param actualVersion - version reported by the pnpm that will run the deploy.
 * @returns the mismatch message, or `null` when the majors match.
 */
export function pnpmVersionMismatch(expectedVersion: string, actualVersion: string): string | null {
  const expectedMajor = expectedVersion.split('.')[0]
  if (actualVersion !== '' && actualVersion.startsWith(`${expectedMajor}.`)) return null
  return `pnpm ${actualVersion === '' ? '(unknown version)' : actualVersion} does not match workspace packageManager `
    + `pnpm@${expectedVersion} (expected major ${expectedMajor}); run with pnpm@${expectedVersion} `
    + `(e.g. npx pnpm@${expectedVersion} --filter dsh-python-runtime-closure deploy)`
}

/**
 * Argument vector for the `pnpm run` invocation that checks a deployed closure.
 *
 * Deliberately without a `--` separator: pnpm 11.28.5 forwards that separator
 * to the script verbatim, where `parseArgs` reads a bare `--` as end-of-options
 * and rejects `--staging` as a positional argument — that aborted the Python
 * runtime build on Linux and Windows before the closure was ever compared. The
 * verifier's CLI also drops a stray separator, so both forms work.
 * @param staging - deploy directory to verify.
 * @returns pnpm arguments, with the staging path last.
 */
export function deployClosureRunArgs(staging: string): string[] {
  return ['run', 'verify-deploy-closure', '--staging', staging]
}

/**
 * Resolve pnpm without invoking a command shell, including Windows shims.
 * @param args - pnpm arguments.
 * @returns the executable and its argument vector.
 */
export function pnpmInvocation(args: string[]): [command: string, args: string[]] {
  const entrypoint = process.env.npm_execpath?.trim()
  if (entrypoint !== undefined && entrypoint !== '') {
    const extension = extname(entrypoint).toLowerCase()
    if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
      return [process.execPath, [entrypoint, ...args]]
    }
    if (extension !== '.cmd') return [entrypoint, args]
  }
  const home = process.env.PNPM_HOME?.trim()
  if (home !== undefined && home !== '') {
    const packageBin = resolve(home, '..', 'pnpm', 'bin')
    for (const filename of ['pnpm.mjs', 'pnpm.cjs']) {
      const candidate = resolve(packageBin, filename)
      if (existsSync(candidate)) return [process.execPath, [candidate, ...args]]
    }
  }
  if (process.platform === 'win32') {
    throw new Error('executable-packaging: pnpm must expose a JavaScript entrypoint through npm_execpath or PNPM_HOME on Windows.')
  }
  return ['pnpm', args]
}

/**
 * Restore direct dependencies omitted by pnpm's legacy hoister, excluding nested module trees.
 * @param staging - deployed runtime root.
 * @param sourceNodeModules - deploy source's installed dependencies.
 * @returns names restored from the source installation.
 */
export async function restoreLegacyHoists(staging: string, sourceNodeModules: string): Promise<string[]> {
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(
        `executable-packaging: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(dependency)
  }
  const stillMissing = Object.keys(manifest.dependencies ?? {})
    .filter(dependency => !existsSync(join(staging, 'node_modules', dependency)))
  if (stillMissing.length > 0) {
    throw new Error(`executable-packaging: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
  }
  return restored
}
