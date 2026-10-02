import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { failSafeRule, parseRules, serializeRule } from './permissions/rules.ts'
import type { Rule } from './permissions/rules.ts'

// Runway settings. Everything is optional; the defaults are the product.
//
//   ~/.pi/agent/runway.json          personal settings
//   <project>/.pi/runway.json        project settings (trusted projects only, can only tighten)

export type Mode = 'auto' | 'ask' | 'off'
export type NetworkMode = 'reviewed' | 'open' | 'closed'
export type OnDeny = 'block' | 'ask'
export type ReviewerRoute = 'openrouter' | 'typesafe-direct'

export interface RunwayConfig {
  /** auto: Jev reviews escalations. ask: you review them. off: no containment. Default: auto when a reviewer key exists, else ask. */
  mode?: Mode
  /** reviewed: known dev hosts pass, new hosts are reviewed. open: any host. closed: known dev hosts only. */
  network: NetworkMode
  /** When the reviewer says no. ask: you get the final word (when someone is at the screen). block: the agent is told why and adapts. */
  onDeny: OnDeny
  /** Your permission rules (personal) plus the project's deny/ask rules. */
  permissions: Rule[]
  /** Bundled companions; each can be switched off. */
  companions: { subagents: boolean; web: boolean; plan: boolean }
  /** Extra hosts that never need review (e.g. "api.mycompany.dev", "*.internal.example"). */
  allowHosts: string[]
  /** Extra folders commands may write to without review. */
  allowWrite: string[]
  /** Extra paths commands can never read. */
  denyRead: string[]
  /** Exceptions inside the protected credential folders (e.g. "~/.codex/sessions"). */
  allowRead: string[]
  /** Environment variables that should stay visible to commands even though they look secret. */
  keepEnv: string[]
  /** Sandbox commands you type yourself with `!`. */
  sandboxUserCommands: boolean
  reviewer: {
    route: ReviewerRoute
    model: string
    modelDirect: string
    timeoutMs: number
    maxAttempts: number
  }
}

export const DEFAULT_CONFIG: RunwayConfig = {
  network: 'reviewed',
  onDeny: 'ask',
  permissions: [],
  companions: { subagents: true, web: true, plan: true },
  allowHosts: [],
  allowWrite: [],
  denyRead: [],
  allowRead: [],
  keepEnv: [],
  sandboxUserCommands: false,
  reviewer: {
    route: 'openrouter',
    model: 'typesafe/jev-1.13',
    modelDirect: 'jev-1.13.0',
    timeoutMs: 8_000,
    maxAttempts: 2,
  },
}

export interface LoadedConfig {
  config: RunwayConfig
  problems: string[]
  sources: string[]
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

export function personalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), 'runway.json')
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.pi', 'runway.json')
}

const MODES: readonly Mode[] = ['auto', 'ask', 'off']
const NETWORK: readonly NetworkMode[] = ['reviewed', 'open', 'closed']
const ON_DENY: readonly OnDeny[] = ['block', 'ask']
const ROUTES: readonly ReviewerRoute[] = ['openrouter', 'typesafe-direct']

function readJson(path: string): { value?: unknown; error?: string } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { error: `${path}: can't be read (${(error as NodeJS.ErrnoException).code ?? String(error)})` }
  }
  try {
    return { value: JSON.parse(text) }
  } catch (error) {
    return { error: `${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
}

function stringList(value: unknown, key: string, path: string, problems: string[]): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value as string[]
  problems.push(`${path}: "${key}" must be a list of strings`)
  return undefined
}

function oneOf<T extends string>(value: unknown, options: readonly T[], key: string, path: string, problems: string[]): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T
  problems.push(`${path}: "${key}" must be one of ${options.join(', ')}`)
  return undefined
}

type Partial1 = Partial<Omit<RunwayConfig, 'reviewer' | 'companions'>> & { reviewer?: Partial<RunwayConfig['reviewer']>; companions?: Partial<RunwayConfig['companions']> }

const KNOWN_KEYS = new Set(['mode', 'network', 'onDeny', 'permissions', 'companions', 'allowHosts', 'allowWrite', 'denyRead', 'allowRead', 'keepEnv', 'sandboxUserCommands', 'reviewer', '$schema'])

export function parseConfig(value: unknown, path: string, problems: string[], source: 'personal' | 'project' = 'personal'): Partial1 {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`${path}: expected a JSON object`)
    return {}
  }
  const raw = value as Record<string, unknown>
  const out: Partial1 = {}
  for (const key of Object.keys(raw)) {
    if (key === 'trustedCommands') problems.push(`${path}: "trustedCommands" is no longer used. Write those commands as "permissions" rules, e.g. { "action": "allow", "command": "npm test*" }`)
    else if (!KNOWN_KEYS.has(key)) problems.push(`${path}: unknown setting "${key}" (ignored)`)
  }
  const mode = oneOf(raw.mode, MODES, 'mode', path, problems)
  if (mode) out.mode = mode
  const network = oneOf(raw.network, NETWORK, 'network', path, problems)
  if (network) out.network = network
  const onDeny = oneOf(raw.onDeny, ON_DENY, 'onDeny', path, problems)
  if (onDeny) out.onDeny = onDeny
  for (const key of ['allowHosts', 'allowWrite', 'denyRead', 'allowRead', 'keepEnv'] as const) {
    const list = stringList(raw[key], key, path, problems)
    if (list) out[key] = list
  }
  if (raw.permissions !== undefined) out.permissions = parseRules(raw.permissions, source, path, problems)
  if (raw.companions !== undefined) {
    if (!raw.companions || typeof raw.companions !== 'object' || Array.isArray(raw.companions)) problems.push(`${path}: "companions" must be an object`)
    else {
      const c = raw.companions as Record<string, unknown>
      const companions: Partial<RunwayConfig['companions']> = {}
      for (const key of ['subagents', 'web', 'plan'] as const) {
        if (c[key] === undefined) continue
        if (typeof c[key] === 'boolean') companions[key] = c[key] as boolean
        else problems.push(`${path}: "companions.${key}" must be true or false`)
      }
      out.companions = companions
    }
  }
  if (raw.sandboxUserCommands !== undefined) {
    if (typeof raw.sandboxUserCommands === 'boolean') out.sandboxUserCommands = raw.sandboxUserCommands
    else problems.push(`${path}: "sandboxUserCommands" must be true or false`)
  }
  if (raw.reviewer !== undefined) {
    if (typeof raw.reviewer !== 'object' || raw.reviewer === null) {
      problems.push(`${path}: "reviewer" must be an object`)
    } else {
      const r = raw.reviewer as Record<string, unknown>
      const reviewer: Partial<RunwayConfig['reviewer']> = {}
      const route = oneOf(r.route, ROUTES, 'reviewer.route', path, problems)
      if (route) reviewer.route = route
      for (const key of ['model', 'modelDirect'] as const) {
        if (r[key] === undefined) continue
        if (typeof r[key] === 'string' && r[key]) reviewer[key] = r[key] as string
        else problems.push(`${path}: "reviewer.${key}" must be a string`)
      }
      if (r.timeoutMs !== undefined) {
        if (typeof r.timeoutMs === 'number' && r.timeoutMs >= 1_000 && r.timeoutMs <= 60_000) reviewer.timeoutMs = r.timeoutMs
        else problems.push(`${path}: "reviewer.timeoutMs" must be between 1000 and 60000`)
      }
      if (r.maxAttempts !== undefined) {
        if (typeof r.maxAttempts === 'number' && Number.isInteger(r.maxAttempts) && r.maxAttempts >= 1 && r.maxAttempts <= 4) reviewer.maxAttempts = r.maxAttempts
        else problems.push(`${path}: "reviewer.maxAttempts" must be an integer from 1 to 4`)
      }
      out.reviewer = reviewer
    }
  }
  return out
}

const NETWORK_STRICTNESS: Record<NetworkMode, number> = { open: 0, reviewed: 1, closed: 2 }

/**
 * A project can make Runway stricter, never looser: a cloned repository must not
 * be able to open the network or turn containment off for you.
 */
export function applyProjectTightening(base: RunwayConfig, project: Partial1): RunwayConfig {
  const next: RunwayConfig = { ...base, reviewer: { ...base.reviewer } }
  // "ask" is the only mode that is stricter than every other one.
  if (project.mode === 'ask') next.mode = 'ask'
  if (project.network && NETWORK_STRICTNESS[project.network] > NETWORK_STRICTNESS[base.network]) next.network = project.network
  if (project.onDeny === 'ask') next.onDeny = 'ask'
  if (project.denyRead) next.denyRead = [...base.denyRead, ...project.denyRead]
  // parseRules already dropped any project allow/auto rule.
  if (project.permissions) next.permissions = [...base.permissions, ...project.permissions]
  return next
}

export function loadConfig(cwd: string, options: { projectTrusted: boolean; env?: NodeJS.ProcessEnv } = { projectTrusted: false }): LoadedConfig {
  const problems: string[] = []
  const sources: string[] = []
  const personalPath = personalConfigPath(options.env)
  const personal = readJson(personalPath)
  // A settings file that exists but can't be read may hold restrictions: until it's fixed, everything asks.
  const unreadable = (path: string, source: 'personal' | 'project', error: string): Rule => {
    problems.push(`${error}; until it is fixed, every tool call asks you (headless: refused)`)
    return failSafeRule(source === 'personal' ? 'p0' : 'r0', 'ask', source, path, undefined, error.replace(`${path}: `, ''))
  }
  const personalFallback = personal.error ? [unreadable(personalPath, 'personal', personal.error)] : personal.value !== undefined && (typeof personal.value !== 'object' || personal.value === null || Array.isArray(personal.value)) ? [unreadable(personalPath, 'personal', `${personalPath}: not a JSON object`)] : []
  if (personal.value !== undefined) sources.push(personalPath)
  const parsed = parseConfig(personal.value, personalPath, problems)
  let config: RunwayConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    permissions: [...personalFallback, ...(parsed.permissions ?? [])],
    companions: { ...DEFAULT_CONFIG.companions, ...parsed.companions },
    reviewer: { ...DEFAULT_CONFIG.reviewer, ...parsed.reviewer },
  }
  if (options.projectTrusted) {
    const projectPath = projectConfigPath(cwd)
    const project = readJson(projectPath)
    if (project.error) config = { ...config, permissions: [...config.permissions, unreadable(projectPath, 'project', project.error)] }
    else if (project.value !== undefined && (typeof project.value !== 'object' || project.value === null || Array.isArray(project.value))) {
      config = { ...config, permissions: [...config.permissions, unreadable(projectPath, 'project', `${projectPath}: not a JSON object`)] }
    }
    if (project.value !== undefined) {
      sources.push(projectPath)
      config = applyProjectTightening(config, parseConfig(project.value, projectPath, problems, 'project'))
    }
  }
  const envMode = (options.env ?? process.env).PI_RUNWAY_MODE
  if (envMode !== undefined) {
    if ((MODES as readonly string[]).includes(envMode)) config.mode = envMode as Mode
    else problems.push(`PI_RUNWAY_MODE must be one of ${MODES.join(', ')}`)
  }
  return { config, problems, sources }
}

// ---------- saving rules ----------

function readObject(path: string): Record<string, unknown> {
  const { value, error } = readJson(path)
  if (error) throw new Error(`${error}; fix it before saving rules`)
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a JSON object`)
  return value as Record<string, unknown>
}

function writeObject(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/** Append an allow/deny/ask/auto rule to your personal settings. Other settings are kept as they are. */
export function savePersonalRule(rule: Omit<Rule, 'id' | 'source'>, env: NodeJS.ProcessEnv = process.env): string {
  const path = personalConfigPath(env)
  const obj = readObject(path)
  if (obj.permissions !== undefined && !Array.isArray(obj.permissions)) throw new Error(`"permissions" in ${path} is not a list; fix it before saving rules`)
  const list = Array.isArray(obj.permissions) ? [...obj.permissions] : []
  list.push(serializeRule({ ...rule, id: '', source: 'personal' }))
  obj.permissions = list
  writeObject(path, obj)
  return path
}

/** Remove personal rule number `index` (0-based, as listed). */
export function removePersonalRule(index: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const path = personalConfigPath(env)
  const obj = readObject(path)
  if (!Array.isArray(obj.permissions) || index < 0 || index >= obj.permissions.length) return false
  obj.permissions = obj.permissions.filter((_, i) => i !== index)
  writeObject(path, obj)
  return true
}
