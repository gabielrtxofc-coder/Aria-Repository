/**
 * Verify that a `pnpm deploy` staging closure does not ship a drifted
 * override or an unverified workspace package.
 *
 * `pnpm deploy --legacy` re-resolves every open range at deploy time,
 * so a transitive `^` range can pick up a patch published after the lock
 * was written. The workspace pins such ranges with `pnpm-workspace.yaml#
 * overrides` — the regression was `@swc/helpers@0.5.24` shipping while the
 * lock held `0.5.23`. An override is only useful while the deployed closure
 * is actually checked: this verifier reads every `package.json` under the
 * staging `node_modules`, and fails when a deployed workspace package does
 * not match its manifest version, when a deployed override does not match
 * the pinned version, or when a reviewed archive lacks SHA-512 integrity.
 *
 * Non-overridden transitive drifts are not failed here: they are either
 * covered by the office sidecar's own `runtimeNpmArchive` integrity check
 * or bundled directly by `pkg` without a lock download. The structural
 * risk that motivated this script is the silent override bypass, and the
 * `pnpm` version drift that re-resolved `^0.5.12` differently under v12.
 */

import { globSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { load as parseYaml } from 'js-yaml'
import { readWorkspacePackages } from './local-bundle-registry.ts'

/** One package as the deployed closure holds it. */
export interface DeployedPackage {
  /** Published or workspace name. */
  readonly name: string
  /** Version the deployed closure actually contains. */
  readonly version: string
  /** Path of the package directory inside the deploy staging. */
  readonly directory: string
}

/** One package the workspace lock reviewed. */
export interface LockedPackage {
  /** Archive identity recorded by the lock, including workspace links. */
  readonly versions: readonly string[]
  /** Whether the lock records a SHA-512 integrity for it. */
  readonly integrity: boolean
}

/** Difference between the closure that shipped and the closure the lock reviewed. */
export interface DeployClosureDrift {
  /** Packages the deploy resolved to a version the lock does not review. */
  readonly unlocked: readonly { readonly name: string; readonly deployed: string; readonly locked: readonly string[] }[]
  /** Locked registry packages that lack a SHA-512 integrity. */
  readonly unverified: readonly string[]
}

/** Shape of the parts of `pnpm-lock.yaml` this verifier reads. */
export interface DeployLock {
  /** Resolved registry and workspace entries. */
  readonly packages: Record<string, { readonly resolution?: { readonly integrity?: unknown } }>
  /** Deploy-visible snapshots, which carry the peer-specialized variants. */
  readonly snapshots?: Record<string, unknown>
}

export function lockedVersions(lock: DeployLock): Map<string, LockedPackage> {
  const reviewed = new Map<string, { versions: Set<string>; integrity: boolean }>()
  const record = (name: string, version: string, integrity: boolean): void => {
    if (name === '' || version === '') return
    const entry = reviewed.get(name) ?? { versions: new Set<string>(), integrity: false }
    entry.versions.add(version)
    entry.integrity ||= integrity
    reviewed.set(name, entry)
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    const integrity = typeof entry?.resolution?.integrity === 'string'
      && entry.resolution.integrity.startsWith('sha512-')
    const parsed = /^(?<name>(?:@[^/@]+\/)?[^@]+)(?:@(?<version>.+))?$/u.exec(key)
    const name = parsed?.groups?.['name']
    const version = parsed?.groups?.['version']
    if (name === undefined) continue
    if (version !== undefined) record(name, version, integrity)
    else if (!integrity) record(name, '*', false)
  }
  for (const key of Object.keys(lock.snapshots ?? {})) {
    const parsed = /^(?<name>(?:@[^/@]+\/)?[^@]+)@(?<version>[^()]+)/u.exec(key)
    const name = parsed?.groups?.['name']
    const version = parsed?.groups?.['version']
    if (name !== undefined && version !== undefined) record(name, version, true)
  }
  return new Map([...reviewed].map(([name, entry]) => [name, {
    versions: [...entry.versions].sort(),
    integrity: entry.integrity,
  }]))
}

/**
 * Compare a deployed closure against workspace manifests and pinned overrides.
 * @param deployed - packages found inside the deploy staging.
 * @param locked - reviewed versions from {@link lockedVersions}.
 * @param workspace - workspace package names and their manifest versions.
 * @param overrides - pinned versions from `pnpm-workspace.yaml` / `pnpm-lock.yaml`.
 * @returns the drift, empty when every override and workspace package is clean.
 */
export function deployClosureDrift(
  deployed: readonly DeployedPackage[],
  locked: ReadonlyMap<string, LockedPackage>,
  workspace: ReadonlyMap<string, string>,
  overrides: ReadonlyMap<string, string> = new Map(),
): DeployClosureDrift {
  const unlocked: { name: string; deployed: string; locked: string[] }[] = []
  const unverified: string[] = []
  const seen = new Set<string>()
  for (const pkg of deployed) {
    if (seen.has(pkg.name)) continue
    seen.add(pkg.name)
    const workspaceVersion = workspace.get(pkg.name)
    if (workspaceVersion !== undefined) {
      if (workspaceVersion !== pkg.version) {
        unlocked.push({ name: pkg.name, deployed: pkg.version, locked: [workspaceVersion] })
      }
      continue
    }
    const pinned = overrides.get(pkg.name)
    if (pinned !== undefined) {
      if (pinned !== pkg.version) {
        const entry = locked.get(pkg.name)
        unlocked.push({ name: pkg.name, deployed: pkg.version, locked: entry ? [...entry.versions] : [pinned] })
      } else {
        const entry = locked.get(pkg.name)
        if (entry && !entry.versions.includes(pkg.version)) {
          unlocked.push({ name: pkg.name, deployed: pkg.version, locked: [...entry.versions] })
        } else if (entry && !entry.integrity) {
          unverified.push(pkg.name)
        } else if (!entry) {
          // Pinned but no lock entry — the lock is stale (e.g. `pnpm install`
          // was not run after adding the override). Report as unlocked so the
          // engineer runs the install and commits the mirrored
          // `pnpm-lock.yaml#overrides`.
          unlocked.push({ name: pkg.name, deployed: pkg.version, locked: [pinned] })
        }
      }
      continue
    }
    // Non-overridden transitive dependencies are allowed to float with the
    // registry: `pnpm deploy --legacy` intentionally re-resolves `^` ranges.
    // When the exact deployed version is in the lock, its integrity must be
    // SHA-512 so that office sidecar downloads can be verified.
    const entry = locked.get(pkg.name)
    if (entry && entry.versions.includes(pkg.version) && !entry.integrity) {
      unverified.push(pkg.name)
    }
  }
  return { unlocked, unverified }
}

export async function readDeployedPackages(staging: string): Promise<DeployedPackage[]> {
  const packages: DeployedPackage[] = []
  const manifests = globSync('node_modules/**/package.json', {
    cwd: staging,
    exclude: path => path.replaceAll('\\', '/').includes('/node_modules/.pnpm/'),
  })
  for (const manifestPath of manifests) {
    let manifest: unknown
    try {
      manifest = JSON.parse(await readFile(join(staging, manifestPath), 'utf8'))
    } catch {
      continue
    }
    if (typeof manifest !== 'object' || manifest === null) continue
    const { name, version } = manifest as { name?: unknown; version?: unknown }
    if (typeof name !== 'string' || typeof version !== 'string') continue
    packages.push({ name, version, directory: manifestPath.replaceAll('\\', '/').replace(/\/package\.json$/u, '') })
  }
  return packages.sort((a, b) => a.directory.localeCompare(b.directory))
}

export function describeDeployDrift(drift: DeployClosureDrift): string[] {
  const failures = drift.unlocked.map(({ name, deployed, locked }) => locked.length === 0
    ? `verify-deploy-closure: ${name}@${deployed} is not in pnpm-lock.yaml — the deploy resolved a version the lock never reviewed`
    : `verify-deploy-closure: ${name}@${deployed} is not in pnpm-lock.yaml — reviewed versions: ${locked.join(', ')}`)
  return [...failures, ...drift.unverified.map(name =>
    `verify-deploy-closure: ${name} has no SHA-512 integrity in pnpm-lock.yaml`)]
}

/**
 * Read the `overrides` mapping of one workspace YAML file.
 *
 * A missing file contributes nothing — not every workspace declares overrides —
 * but a file that exists and cannot be read or parsed is a hard error: silently
 * returning an empty map would drop every pin this verifier exists to enforce.
 * @param path - absolute path of `pnpm-workspace.yaml` or `pnpm-lock.yaml`.
 * @returns the override entries, or `undefined` when the file does not exist.
 */
function readOverrideSection(path: string): Record<string, string> | undefined {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`verify-deploy-closure: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = parseYaml(source)
  } catch (error) {
    throw new Error(`verify-deploy-closure: cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const overrides = (parsed as { overrides?: unknown } | null | undefined)?.overrides
  if (overrides === undefined || overrides === null) return {}
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`verify-deploy-closure: ${path} has a non-mapping "overrides" section`)
  }
  return overrides as Record<string, string>
}

/**
 * Pinned versions declared by `pnpm-workspace.yaml` and `pnpm-lock.yaml`.
 *
 * Keys may be scoped (`parent>child`). A hoisted closure holds one version per
 * package name, so a scoped pin is enforced against its child name; two
 * different pins for the same child are a conflict this verifier cannot resolve
 * and it fails rather than guessing. `link:` pins address a workspace directory
 * instead of a registry version, so they are not version pins here — the
 * workspace comparison already covers those packages.
 * @param root - repository root holding both workspace files.
 * @returns package name to the single version it must resolve to.
 */
export function readPinnedOverrides(root: string): Map<string, string> {
  const merged = {
    ...readOverrideSection(join(root, 'pnpm-workspace.yaml')),
    ...readOverrideSection(join(root, 'pnpm-lock.yaml')),
  }
  const pinned = new Map<string, string>()
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== 'string') continue
    if (value.startsWith('link:')) continue
    const name = key.includes('>') ? key.slice(key.lastIndexOf('>') + 1) : key
    const previous = pinned.get(name)
    if (previous !== undefined && previous !== value) {
      throw new Error(
        `verify-deploy-closure: conflicting pins for ${name} (${previous} and ${value} from "${key}"); `
        + 'a hoisted closure holds one version per package, so this pin cannot be verified',
      )
    }
    pinned.set(name, value)
  }
  return pinned
}

export async function verifyDeployClosureVersions(root: string, staging: string): Promise<number> {
  const lock = parseYaml(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')) as DeployLock
  const workspace = new Map([...readWorkspacePackages(root)].map(([name, entry]) => {
    const version = entry.manifest['version']
    return [name, typeof version === 'string' ? version : ''] as const
  }))
  const deployed = await readDeployedPackages(staging)
  if (deployed.length === 0) {
    throw new Error(`verify-deploy-closure: no package manifests found in ${staging}`)
  }
  const drift = deployClosureDrift(deployed, lockedVersions(lock), workspace, readPinnedOverrides(root))
  const failures = describeDeployDrift(drift)
  if (failures.length > 0) throw new Error(failures.join('\n'))
  return deployed.length
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: { staging: { type: 'string' } },
  })
  const root = resolve(import.meta.dirname, '..')
  const staging = resolve(values.staging ?? join(root, 'python', 'sdk-runtime', 'node'))
  try {
    const count = await verifyDeployClosureVersions(root, staging)
    console.log(`verify-deploy-closure: ${String(count)} package(s) match pnpm-lock.yaml.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
