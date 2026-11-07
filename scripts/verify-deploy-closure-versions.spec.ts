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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deployClosureDrift,
  describeDeployDrift,
  lockedVersions,
  readDeployedPackages,
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
