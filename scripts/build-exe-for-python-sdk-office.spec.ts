import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { c as tar } from 'tar'
import { load as parseYaml } from 'js-yaml'
import { downloadOfficeSidecar, runtimeNpmArchive } from './build-exe-for-python-sdk-office.ts'

import { officePackageDirectories } from './libreoffice-packages.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-python-office-'))
  temporaryDirectories.push(root)
  const staging = join(root, 'staging')
  const destination = join(root, 'runtime-office')
  async function packageAt(name: string, fields: Record<string, unknown> = {}, parent = staging) {
    const directory = join(parent, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...fields }))
    return directory
  }
  return { root, staging, destination, packageAt }
}

it('locates installed target optionals and leaves other platforms and absent optionals out', async () => {
  const { staging, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', {
    optionalDependencies: { native: '1', foreign: '1', absent: '1' },
  })
  await packageAt('@deepseek-ai/libreoffice-kit-wasm')
  await packageAt('native', { os: ['linux'], cpu: ['x64'] })
  await packageAt('foreign', { os: ['darwin'], cpu: ['arm64'] })

  const packages = await officePackageDirectories(staging, { platform: 'linux', arch: 'x64' })

  expect(packages.map(path => path.slice(staging.length + 1).replaceAll('\\', '/'))).toEqual([
    'node_modules/@deepseek-ai/libreoffice-kit',
    'node_modules/@deepseek-ai/libreoffice-kit-wasm',
    'node_modules/native',
  ])
})

it('rejects a missing required dependency in the deployed closure', async () => {
  const { staging, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { dependencies: { 'dsh-missing-office-fixture': '1' } })

  await expect(officePackageDirectories(staging, { platform: 'linux', arch: 'x64' }))
    .rejects.toThrow('dsh-missing-office-fixture required by @deepseek-ai/libreoffice-kit is missing')
})

it('rejects an incomplete installed optional instead of omitting it', async () => {
  const { staging, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { optionalDependencies: { broken: '1' } })
  await mkdir(join(staging, 'node_modules/broken'), { recursive: true })

  await expect(officePackageDirectories(staging, { platform: 'linux', arch: 'x64' }))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects an ancestor dependency outside the deployed closure', async () => {
  const { root, staging, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { dependencies: { 'ancestor-office-fixture': '1' } })
  await packageAt('ancestor-office-fixture', {}, root)

  await expect(officePackageDirectories(staging, { platform: 'linux', arch: 'x64' }))
    .rejects.toThrow('outside the deployed closure')
})

it.each([true, false])('requires a staged WASM engine when declared=%s even when an ancestor has one', async (declared) => {
  const { root, staging, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', declared ? { optionalDependencies: { '@deepseek-ai/libreoffice-kit-wasm': '0.0.1' } } : {})
  await packageAt('@deepseek-ai/libreoffice-kit-wasm', {}, root)
  await expect(officePackageDirectories(staging, { platform: 'linux', arch: 'x64' }))
    .rejects.toThrow('Office engine @deepseek-ai/libreoffice-kit-wasm required for linux/x64 is missing.')
})

it.each([
  ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64'],
  ['win32', 'arm64', 'win32-arm64'], ['win32', 'x64', 'win32-x64'],
  ['linux', 'x64', 'linux-x64'], ['linux', 'arm64', 'wasm'], ['freebsd', 'x64', 'wasm'],
])('locates only the %s/%s engine even when other engines are staged', async (platform, arch, selected) => {
  const { staging, packageAt } = await fixture()
  const targets = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-x64', 'wasm']
  const names = targets.map(target => `@deepseek-ai/libreoffice-kit-${target}`)
  await packageAt('@deepseek-ai/libreoffice-kit', { optionalDependencies: Object.fromEntries(names.map(name => [name, '0.0.1'])) })
  for (const name of names) await packageAt(name)
  const expected = `@deepseek-ai/libreoffice-kit-${selected}`
  const packages = await officePackageDirectories(staging, { platform, arch })
  expect(packages.map(path => path.slice(staging.length + 1).replaceAll('\\', '/'))).toEqual([
    'node_modules/@deepseek-ai/libreoffice-kit', `node_modules/${expected}`,
  ])
})

it.each(['darwin', 'win32', 'linux'])('%s requires its native package even when WASM is staged', async (platform) => {
  const { staging, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { optionalDependencies: {
    '@deepseek-ai/libreoffice-kit-wasm': '0.0.1', [`@deepseek-ai/libreoffice-kit-${platform}-arm64`]: '0.0.1',
  } })
  await packageAt('@deepseek-ai/libreoffice-kit-wasm')
  await expect(officePackageDirectories(staging, { platform, arch: 'arm64' }))
    .rejects.toThrow(`Office engine @deepseek-ai/libreoffice-kit-${platform}-arm64 required for ${platform}/arm64 is missing.`)
})

it('downloads pinned npm packages into the sidecar without resolving or executing package scripts', async () => {
  const { root, destination } = await fixture()
  const source = join(root, 'package')
  await mkdir(source)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { install: 'must-not-run' } }))
  await writeFile(join(source, 'worker.js'), 'worker')
  const archive = join(root, 'package.tgz')
  await tar({ file: archive, cwd: root, gzip: true }, ['package'])
  const bytes = await readFile(archive)
  const checksum = createHash('sha512').update(bytes).digest()
  const cache = join(root, 'archives')
  await mkdir(cache)
  await writeFile(join(cache, checksum.toString('hex')), bytes)
  const artifact = { name: 'fixture', version: '1.0.0', directory: 'node_modules/fixture',
    url: 'https://unused.invalid/fixture.tgz', integrity: `sha512-${checksum.toString('base64')}` }
  await downloadOfficeSidecar([artifact], destination, cache)
  expect(await readFile(join(destination, 'node_modules/fixture/worker.js'), 'utf8')).toBe('worker')
  await expect(downloadOfficeSidecar([{ ...artifact, directory: 'node_modules/../../outside' }], destination, cache))
    .rejects.toThrow('invalid package directory')
  await expect(downloadOfficeSidecar([{ ...artifact, version: '2.0.0' }], destination, cache))
    .rejects.toThrow('package identity mismatch')
  await writeFile(join(cache, checksum.toString('hex')), 'corrupted archive')
  await expect(downloadOfficeSidecar([artifact], destination, cache)).rejects.toThrow('checksum mismatch')
})


it('takes npm integrity from the workspace lock without querying registry metadata', async () => {
  const { root } = await fixture()
  const lockfile = join(root, 'pnpm-lock.yaml')
  const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
  await writeFile(lockfile, JSON.stringify({ packages: { '@scope/fixture@1.2.3': { resolution: { integrity } } } }))
  expect(await runtimeNpmArchive('@scope/fixture', '1.2.3', lockfile)).toEqual({
    name: '@scope/fixture', version: '1.2.3', integrity,
    url: 'https://registry.npmjs.org/@scope/fixture/-/fixture-1.2.3.tgz',
  })
  await expect(runtimeNpmArchive('@scope/fixture', '1.2.4', lockfile)).rejects.toThrow('missing SHA-512 integrity')
  await writeFile(lockfile, JSON.stringify({ packages: { '@scope/fixture@1.2.3': { resolution: { integrity: 'sha256-invalid' } } } }))
  await expect(runtimeNpmArchive('@scope/fixture', '1.2.3', lockfile)).rejects.toThrow('missing SHA-512 integrity')
})

it('pins the open ranges a deploy would otherwise re-resolve', async () => {
  // Regressions for the python-runtime failures
  //   "runtime npm lock: missing SHA-512 integrity for @swc/helpers@0.5.24"
  //   "runtime npm lock: missing SHA-512 integrity for tslib@2.9.1".
  // `fontkit` declares `@swc/helpers: ^0.5.12` and the sidecar chain declares
  // `tslib: ^2.x`. The workspace lock reviewed 0.5.23 and 2.8.1, but `pnpm
  // deploy` replays the ranges instead of the lock (it runs with a
  // configuration that cannot read one), so the deployed closure picked up
  // 0.5.24 and 2.9.1 the day they were published. The overrides in
  // pnpm-workspace.yaml (mirrored into pnpm-lock.yaml) are what keep the
  // deployed closure on the reviewed archives.
  const expected: Record<string, string> = { '@swc/helpers': '0.5.23', tslib: '2.8.1' }
  const workspace = parseYaml(await readFile(join(import.meta.dirname, '../pnpm-workspace.yaml'), 'utf8')) as {
    overrides?: Record<string, string>
  }
  // pnpm stores the workspace overrides in the lock header; a lock without the
  // mirror is reported as out of date on --frozen-lockfile.
  const lock = parseYaml(await readFile(join(import.meta.dirname, '../pnpm-lock.yaml'), 'utf8')) as {
    overrides?: Record<string, string>
    packages?: Record<string, { resolution?: { integrity?: string } }>
  }
  for (const [name, version] of Object.entries(expected)) {
    expect(workspace.overrides?.[name], `pnpm-workspace.yaml override for ${name}`).toBe(version)
    expect(lock.overrides?.[name], `pnpm-lock.yaml override for ${name}`).toBe(version)
    // An override pointing at a version the lock never reviewed would trade the
    // "not in pnpm-lock.yaml" failure for the "missing SHA-512 integrity" one.
    expect(lock.packages?.[`${name}@${version}`]?.resolution?.integrity, `reviewed archive for ${name}@${version}`)
      .toMatch(/^sha512-/)
  }
})
