/**
 * The deployed closure must not bypass a pinned override.
 *
 * `pnpm deploy --legacy` re-resolves open ranges instead of replaying the lock,
 * so the shipped closure can carry a version no lock entry covers. The python
 * runtime hit exactly that (`@swc/helpers@0.5.24` against a lock holding
 * `0.5.23`), and the failure only appeared while packaging. An override pins
 * such a range, and this verifier ensures the deployed closure actually honors
 * it — without re-introducing a whole-closure version lock that would fail on
 * every unrelated transitive patch.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deployClosureDrift,
  describeDeployDrift,
  lockedVersions,
  readDeployedPackages,
  readPinnedOverrides,
  verifyDeployClosureVersions,
  type DeployLock,
  type DeployedPackage,
  type LockedPackage,
} from './verify-deploy-closure-versions.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function lockReviewing(name: string, version: string): DeployLock {
  return {
    packages: {
      [`${name}@${version}`]: {
        resolution: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      },
    },
  }
}

function deployed(name: string, version: string): DeployedPackage {
  return { name, version, directory: `node_modules/${name}` }
}

describe('deploy closure versions', () => {
  it('blocks the closure that bypassed the @swc/helpers pin', () => {
    // The regression: the lock reviewed 0.5.23 and the deploy resolved 0.5.24,
    // because `fontkit` declares `@swc/helpers: ^0.5.12` as an open range.
    // The workspace override `0.5.23` is what keeps the deployed closure on the
    // reviewed archive, and the verifier must fail when it drifts.
    const locked = lockedVersions(lockReviewing('@swc/helpers', '0.5.23'))
    const overrides = new Map([['@swc/helpers', '0.5.23']])
    const drift = deployClosureDrift([deployed('@swc/helpers', '0.5.24')], locked, new Map(), overrides)
    expect(describeDeployDrift(drift)).toEqual([
      'verify-deploy-closure: @swc/helpers@0.5.24 is not in pnpm-lock.yaml — reviewed versions: 0.5.23',
    ])
  })

  it('accepts the closure pinned to the reviewed version', () => {
    const locked = lockedVersions(lockReviewing('@swc/helpers', '0.5.23'))
    const overrides = new Map([['@swc/helpers', '0.5.23']])
    const drift = deployClosureDrift([deployed('@swc/helpers', '0.5.23')], locked, new Map(), overrides)
    expect(describeDeployDrift(drift)).toEqual([])
  })

  it('allows unrelated transitive drifts that are not pinned', () => {
    // `pnpm deploy --legacy` always re-resolves `^` ranges to the latest
    // registry publish. Failing the whole closure on every such patch would
    // make the gate flaky; only pinned overrides and workspace packages are
    // structural.
    const locked = lockedVersions(lockReviewing('@aws-sdk/core', '3.978.1'))
    const drift = deployClosureDrift([deployed('@aws-sdk/core', '3.980.0')], locked, new Map(), new Map())
    expect(describeDeployDrift(drift)).toEqual([])
  })

  it('normalizes peer-specialized and scoped lock keys', () => {
    const locked = lockedVersions({
      packages: {
        '@scope/pkg@1.2.3': { resolution: { integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}` } },
        'plain@2.0.0': { resolution: { integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}` } },
      },
      snapshots: {
        '@scope/pkg@1.2.3(peer@4.5.6)': {},
        'plain@2.0.0': {},
      },
    })
    expect(locked.get('@scope/pkg')).toEqual({ versions: ['1.2.3'], integrity: true })
    expect(locked.get('plain')).toEqual({ versions: ['2.0.0'], integrity: true })
  })

  it('requires SHA-512 for a pinned override that the closure ships', () => {
    const locked: ReadonlyMap<string, LockedPackage> = new Map([
      ['unpinned', { versions: ['1.0.0'], integrity: false }],
    ])
    const drift = deployClosureDrift(
      [deployed('unpinned', '1.0.0')], locked, new Map(), new Map([['unpinned', '1.0.0']]),
    )
    expect(describeDeployDrift(drift)).toEqual([
      'verify-deploy-closure: unpinned has no SHA-512 integrity in pnpm-lock.yaml',
    ])
  })

  it('compares a workspace package against its own manifest version', () => {
    const drift = deployClosureDrift(
      [deployed('@deepseek-ai/dsh-acp', '2.0.0'), deployed('@deepseek-ai/dsh-session', '1.0.0')],
      new Map(),
      new Map([
        ['@deepseek-ai/dsh-acp', '1.0.0'],
        ['@deepseek-ai/dsh-session', '1.0.0'],
      ]),
    )
    expect(describeDeployDrift(drift)).toEqual([
      'verify-deploy-closure: @deepseek-ai/dsh-acp@2.0.0 is not in pnpm-lock.yaml — reviewed versions: 1.0.0',
    ])
  })
})

describe('verifyDeployClosureVersions', () => {
  async function fixture(deploy: readonly DeployedPackage[]): Promise<{ root: string; staging: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deploy-closure-'))
    roots.push(root)
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\noverrides:\n  \"@swc/helpers\": 0.5.23\n')
    await mkdir(join(root, 'packages', 'acp'), { recursive: true })
    await writeFile(join(root, 'packages', 'acp', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-acp', version: '1.0.0' }))
    await writeFile(join(root, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'overrides:',
      "  '@swc/helpers': 0.5.23",
      'packages:',
      "  '@swc/helpers@0.5.23':",
      `    resolution: {integrity: sha512-${Buffer.alloc(64, 4).toString('base64')}}`,
      'snapshots:',
      "  '@swc/helpers@0.5.23': {}",
      '',
    ].join('\n'))
    const staging = join(root, 'staging')
    for (const pkg of deploy) {
      const directory = join(staging, pkg.directory)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version }))
    }
    return { root, staging }
  }

  it('reads every hoisted manifest and ignores the virtual store', async () => {
    const { staging } = await fixture([
      { name: 'a', version: '1.0.0', directory: 'node_modules/a' },
      { name: 'a', version: '1.0.0', directory: 'node_modules/.pnpm/a@1.0.0/node_modules/a' },
    ])
    const packages = await readDeployedPackages(staging)
    expect(packages.map(pkg => pkg.directory)).toEqual(['node_modules/a'])
  })

  it('passes the reviewed closure and counts every package', async () => {
    const { root, staging } = await fixture([
      { name: '@swc/helpers', version: '0.5.23', directory: 'node_modules/@swc/helpers' },
      { name: '@deepseek-ai/dsh-acp', version: '1.0.0', directory: 'node_modules/@deepseek-ai/dsh-acp' },
    ])
    expect(await verifyDeployClosureVersions(root, staging)).toBe(2)
  })

  it('fails the drifted closure before packaging runs', async () => {
    const { root, staging } = await fixture([
      { name: '@swc/helpers', version: '0.5.24', directory: 'node_modules/@swc/helpers' },
    ])
    await expect(verifyDeployClosureVersions(root, staging)).rejects.toThrow(
      'verify-deploy-closure: @swc/helpers@0.5.24 is not in pnpm-lock.yaml — reviewed versions: 0.5.23',
    )
  })

  it('fails an empty staging instead of reporting success', async () => {
    const { root, staging } = await fixture([])
    await expect(verifyDeployClosureVersions(root, staging)).rejects.toThrow('no package manifests found')
  })
})

describe('verify-deploy-closure CLI invocation', () => {
  const script = join(import.meta.dirname, 'verify-deploy-closure-versions.ts')
  // The real closure is verified against the repository lockfile, so the
  // fixtures use the identity this verifier was built to police: the pinned
  // `@swc/helpers` version the lock reviews (0.5.23) and the drifted one (0.5.24).
  const reviewed = '0.5.23'
  const drifted = '0.5.24'

  async function stagingWith(version: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deploy-cli-'))
    roots.push(root)
    const packageDirectory = join(root, 'staging', 'node_modules', '@swc', 'helpers')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@swc/helpers', version }))
    return join(root, 'staging')
  }

  function runCli(args: readonly string[], staging: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  it('runs the call the builder really makes and passes a reviewed closure', async () => {
    const staging = await stagingWith(reviewed)
    // Exactly what pnpm delivers for `deployClosureRunArgs`: the flag, no separator.
    const result = runCli(['--staging', staging], staging)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('1 package(s) match pnpm-lock.yaml')
    expect(result.status).toBe(0)
  }, 60_000)

  it('fails the build when the deployed closure drifts from the pin', async () => {
    const staging = await stagingWith(drifted)
    const result = runCli(['--staging', staging], staging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`@swc/helpers@${drifted} is not in pnpm-lock.yaml`)
    expect(result.stderr).toContain(`reviewed versions: ${reviewed}`)
  }, 60_000)

  it('still works when a caller leaves a bare separator in argv', async () => {
    // Defence in depth: an older builder, a manual run, or a future pnpm that
    // stops stripping `--` must not turn the check into a crash.
    const staging = await stagingWith(drifted)
    const result = runCli(['--', '--staging', staging], staging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is not in pnpm-lock.yaml')
  }, 60_000)
})

describe('readPinnedOverrides', () => {
  async function workspace(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-deploy-pins-'))
    roots.push(root)
    for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body)
    return root
  }

  it('enforces the child of a scoped override', () => {
    // `extract-zip>yauzl: 3.4.0` is a real pin in this workspace; a hoisted
    // closure holds one yauzl, so the child name is what can be checked.
    const pinned = readPinnedOverrides(process.cwd())
    expect(pinned.get('yauzl')).toBe('3.4.0')
    expect(pinned.get('@swc/helpers')).toBe('0.5.23')
  })

  it('reads a scoped override from a fixture workspace', async () => {
    const root = await workspace({ 'pnpm-workspace.yaml': 'overrides:\n  "parent>child": 1.2.3\n' })
    expect([...readPinnedOverrides(root)]).toEqual([['child', '1.2.3']])
  })

  it('refuses two different pins for one package instead of guessing', async () => {
    const root = await workspace({
      'pnpm-workspace.yaml': 'overrides:\n  "a>shared": 1.0.0\n  "b>shared": 2.0.0\n',
    })
    expect(() => readPinnedOverrides(root)).toThrow('conflicting pins for shared')
  })

  it('fails closed when the workspace file cannot be parsed', async () => {
    const root = await workspace({ 'pnpm-workspace.yaml': 'overrides: [unclosed\n' })
    expect(() => readPinnedOverrides(root)).toThrow('cannot parse')
  })

  it('ignores link: pins, which address a directory rather than a version', async () => {
    const root = await workspace({
      'pnpm-workspace.yaml': 'overrides:\n  "@scope/local": "link:vendor/local"\n  pinned: 4.5.6\n',
    })
    expect([...readPinnedOverrides(root)]).toEqual([['pinned', '4.5.6']])
  })

  it('treats absent workspace files as having no overrides', async () => {
    const root = await workspace({})
    expect([...readPinnedOverrides(root)]).toEqual([])
  })
})

describe('scoped overrides in the drift check', () => {
  it('blocks a child that ignored its scoped pin', () => {
    const overrides = new Map([['yauzl', '3.4.0']])
    const drift = deployClosureDrift([deployed('yauzl', '3.3.0')], new Map(), new Map(), overrides)
    expect(describeDeployDrift(drift)).toEqual([
      'verify-deploy-closure: yauzl@3.3.0 is not in pnpm-lock.yaml — reviewed versions: 3.4.0',
    ])
  })
})
