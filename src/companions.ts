import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { RunwayConfig } from './config.ts'

// Runway installs as one package but reuses maintained Pi packages for the
// rest of the workflow, bundled with it:
//   subagents  @gotgenes/pi-subagents   delegate work to agents with their own model
//   plan       @narumitw/pi-plan-mode   plan read-only, review, then implement
//   web        pi-web-access            search the web and fetch pages
// They are loaded through Runway so that (1) a copy you installed yourself
// wins and Runway's copy stays out of the way, and (2) Runway knows exactly
// which tools each one registered — tool identity comes from that record,
// never from a tool's name.

export type CompanionId = 'subagents' | 'plan' | 'web'

export interface CompanionStatus {
  id: CompanionId
  label: string
  pkg: string
  version?: string
  state: 'loaded' | 'yours' | 'inactive' | 'off' | 'missing' | 'failed'
  detail?: string
  tools: string[]
  commands: string[]
}

export const COMPANIONS: { id: CompanionId; label: string; pkg: string }[] = [
  { id: 'subagents', label: 'Subagents', pkg: '@gotgenes/pi-subagents' },
  { id: 'plan', label: 'Plan mode', pkg: '@narumitw/pi-plan-mode' },
  { id: 'web', label: 'Web search and fetch', pkg: 'pi-web-access' },
]

export interface ListedPackage {
  name: string
  /** Where its code lives, to recognise what it registered: a folder, or `/node_modules/<name>/` for npm installs. */
  where: string
  /** Its extensions load, as far as the settings say (an `extensions: []` filter switches them off). */
  extensionsOn: boolean
}

function readPackages(file: string): unknown[] {
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { packages?: unknown[] }
    return Array.isArray(settings.packages) ? settings.packages : []
  } catch {
    return []
  }
}

function describeEntry(entry: unknown, file: string): (ListedPackage & { autoload: boolean }) | undefined {
  const obj = entry && typeof entry === 'object' ? (entry as { source?: unknown; extensions?: unknown; autoload?: unknown }) : undefined
  const source = typeof entry === 'string' ? entry : typeof obj?.source === 'string' ? obj.source : ''
  if (!source) return undefined
  // `extensions: []` loads none. Any other filter may load something; verifyCompanions checks what actually did.
  const filter = obj?.extensions
  const extensionsOn = !Array.isArray(filter) || filter.length > 0
  const autoload = obj?.autoload !== false
  if (source.startsWith('npm:')) {
    const spec = source.slice(4)
    const at = spec.lastIndexOf('@')
    const name = at > 0 ? spec.slice(0, at) : spec
    return { name, where: `/node_modules/${name}/`, extensionsOn, autoload }
  }
  if (source.startsWith('git:') || /^https?:/.test(source)) return undefined
  const dir = isAbsolute(source) ? source : resolve(dirname(file), source)
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    return pkg.name ? { name: pkg.name, where: dir, extensionsOn, autoload } : undefined
  } catch {
    return undefined
  }
}

/**
 * Packages listed in Pi settings, personal then project, with Pi's scoping: a
 * project entry replaces the personal one, unless it has `autoload: false`,
 * in which case it only narrows it. Project settings count only when the
 * project is trusted.
 */
export function listedPackages(agentDir: string, cwd: string, projectTrusted = true): Map<string, ListedPackage> {
  const out = new Map<string, ListedPackage>()
  const personal = join(agentDir, 'settings.json')
  for (const entry of readPackages(personal)) {
    const d = describeEntry(entry, personal)
    if (d) out.set(d.name, { name: d.name, where: d.where, extensionsOn: d.extensionsOn })
  }
  if (!projectTrusted) return out
  const project = join(cwd, '.pi', 'settings.json')
  for (const entry of readPackages(project)) {
    const d = describeEntry(entry, project)
    if (!d) continue
    const base = out.get(d.name)
    if (!d.autoload && base) out.set(d.name, { ...base, extensionsOn: base.extensionsOn && d.extensionsOn })
    else if (d.autoload) out.set(d.name, { name: d.name, where: d.where, extensionsOn: d.extensionsOn })
  }
  return out
}

/** Names of listed packages whose extensions are switched on. */
export function installedPackageNames(agentDir: string, cwd: string, projectTrusted = true): Set<string> {
  return new Set([...listedPackages(agentDir, cwd, projectTrusted).values()].filter(p => p.extensionsOn).map(p => p.name))
}

/**
 * After everything loaded: is a companion you installed yourself really
 * active? Settings can list a package whose extension is filtered out or
 * failed to load; then neither copy runs, and doctor says so.
 */
export function verifyCompanions(statuses: CompanionStatus[], listed: Map<string, ListedPackage>, registered: { sourceInfo?: { path?: string } }[]): void {
  for (const status of statuses) {
    if (status.state !== 'yours' && status.state !== 'inactive') continue
    const where = listed.get(status.pkg)?.where
    const active = where !== undefined && registered.some(r => {
      const path = r.sourceInfo?.path ?? ''
      return where.startsWith('/node_modules/') ? path.includes(where) : path.startsWith(where)
    })
    status.state = active ? 'yours' : 'inactive'
    status.detail = active
      ? 'you installed it separately; Runway uses yours'
      : 'listed in your Pi settings, but none of its tools or commands are loaded (filtered out or failed), so it is not available. Remove the filter, or remove the package so Runway loads its bundled copy.'
  }
}

function entryOf(pkgDir: string): { entry: string; version?: string } | undefined {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string; pi?: { extensions?: string[] } }
  const rel = pkg.pi?.extensions?.[0]
  if (!rel) return undefined
  let entry = resolve(pkgDir, rel)
  if (!existsSync(entry) || !/\.[cm]?[jt]s$/.test(entry)) {
    for (const name of ['index.ts', 'index.js']) {
      if (existsSync(join(entry, name))) {
        entry = join(entry, name)
        break
      }
    }
  }
  return existsSync(entry) ? { entry, version: pkg.version } : undefined
}

/** A view of `pi` that records what a companion registers. */
function recordingApi(pi: ExtensionAPI, tools: string[], commands: string[]): ExtensionAPI {
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (def: { name: string }) => {
          tools.push(def.name)
          return target.registerTool(def as never)
        }
      }
      if (prop === 'registerCommand') {
        return (name: string, options: unknown) => {
          commands.push(name)
          return target.registerCommand(name, options as never)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export async function loadCompanions(
  pi: ExtensionAPI,
  config: RunwayConfig,
  installed: Set<string>,
  owners: Map<string, CompanionId>,
  importer: (path: string) => Promise<unknown> = path => import(path),
): Promise<CompanionStatus[]> {
  const require = createRequire(import.meta.url)
  const out: CompanionStatus[] = []
  for (const c of COMPANIONS) {
    const status: CompanionStatus = { ...c, state: 'missing', tools: [], commands: [] }
    out.push(status)
    if (!config.companions[c.id]) {
      status.state = 'off'
      continue
    }
    if (installed.has(c.pkg)) {
      status.state = 'yours'
      status.detail = 'you installed it separately; Runway uses yours'
      continue
    }
    // Packages with an `exports` map can hide package.json from require.resolve, so look in node_modules directly.
    const pkgDir = (require.resolve.paths(c.pkg) ?? []).map(dir => join(dir, c.pkg)).find(dir => existsSync(join(dir, 'package.json')))
    if (!pkgDir) {
      status.detail = 'not bundled in this install'
      continue
    }
    const found = entryOf(pkgDir)
    if (!found) {
      status.state = 'failed'
      status.detail = 'no extension entry point'
      continue
    }
    status.version = found.version
    try {
      const mod = (await importer(found.entry)) as { default?: (pi: ExtensionAPI) => unknown }
      const factory = typeof mod.default === 'function' ? mod.default : (mod as unknown as (pi: ExtensionAPI) => unknown)
      if (typeof factory !== 'function') throw new Error('no default export')
      await factory(recordingApi(pi, status.tools, status.commands))
      for (const tool of status.tools) owners.set(tool, c.id)
      status.state = 'loaded'
    } catch (error) {
      status.state = 'failed'
      status.detail = error instanceof Error ? error.message : String(error)
    }
  }
  return out
}
