import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { checkRead, checkWrite, isWithin, realpathLoose } from '../policy.ts'
import type { Policy } from '../policy.ts'
import type { Operation } from './operation.ts'
import { analyzeShell, commandCandidates, extractHosts } from './shell.ts'

// Permission rules. Four actions:
//   allow — run without asking
//   auto  — let the reviewer (Jev) decide; you are asked if it says no or can't decide
//   ask   — always ask you
//   deny  — never, and the agent is told which rule said so
// A rule names a tool (glob) and optionally narrows it by command, path, host
// or tool input. Rules come from your settings, from the project (deny/ask
// only — a repository can tighten, never loosen), and from Runway's built-in
// defaults, which are shown alongside yours in /runway permissions.

export type Action = 'allow' | 'auto' | 'ask' | 'deny'
export type RuleSource = 'personal' | 'project' | 'default'

export interface Rule {
  id: string
  action: Action
  source: RuleSource
  tool?: string
  command?: string
  path?: string
  host?: string
  /** Named parameters must match these patterns (other parameters may be anything). */
  input?: Record<string, string>
  /** The tool's whole input must equal this exactly (no more, no fewer parameters). */
  inputExact?: Record<string, unknown>
  /** Extra sandbox access an allow/auto rule also covers. Without it, those rules only cover commands that stay in the normal sandbox. */
  access?: { write?: string[]; hosts?: string[] }
  reason?: string
  /** Allow/auto rules apply to commands that run outside the sandbox only when this is true. */
  unsandboxed?: boolean
  /** Set when the rule as written couldn't be read; it then restricts its whole tool (see parseRules). */
  invalid?: string
  /** Built-in rules: a sentence instead of patterns. */
  description?: string
  /** Built-in rules: a short form for compact lists. */
  summary?: string
  test?: (op: Operation, ctx: RuleContext) => boolean
}

export interface RuleContext {
  policy: Policy
}

export const ACTIONS: readonly Action[] = ['allow', 'auto', 'ask', 'deny']
const RULE_KEYS = new Set(['action', 'tool', 'command', 'path', 'host', 'input', 'inputExact', 'access', 'reason', 'unsandboxed'])

// ---------- globs ----------

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type GlobKind = 'text' | 'path' | 'host'
const cache = new Map<string, RegExp>()

export function globToRegExp(pattern: string, kind: GlobKind): RegExp {
  const key = `${kind}\u0000${pattern}`
  const hit = cache.get(key)
  if (hit) return hit
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRe(pattern[i + 1]!)
      i += 1
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (kind === 'path' && pattern[i + 1] === '/') {
          // `a/**/b`: zero or more whole folders, never part of a name.
          out += '(?:.*/)?'
          i += 1
        } else if (kind === 'path' && out.endsWith('/')) {
          // `a/**` at the end: the folder itself or anything under it.
          out = `${out.slice(0, -1)}(?:/.*)?`
        } else out += '.*'
      } else out += kind === 'path' ? '[^/]*' : '.*'
    } else if (c === '?') out += kind === 'path' ? '[^/]' : '.'
    else out += escapeRe(c)
  }
  const re = new RegExp(`^${out}$`, kind === 'host' || process.platform === 'darwin' && kind === 'path' ? 'i' : '')
  cache.set(key, re)
  return re
}

function hasGlob(pattern: string): boolean {
  return /(?<!\\)[*?]/.test(pattern)
}

/** Escape a literal so it can be saved as an exact-match pattern. */
export function literalPattern(text: string): string {
  return text.replace(/[\\*?]/g, '\\$&')
}

export function matchText(pattern: string, value: string): boolean {
  return globToRegExp(pattern.trim(), 'text').test(value.trim())
}

export function matchTool(pattern: string, tool: string): boolean {
  return globToRegExp(pattern, 'text').test(tool)
}

export function matchHost(pattern: string, host: string): boolean {
  return globToRegExp(pattern.toLowerCase(), 'host').test(host.toLowerCase())
}

function unescape(text: string): string {
  return text.replace(/\\(.)/g, '$1')
}

/**
 * Resolve a path pattern's literal part the same way tool paths are resolved
 * (so `/tmp/**` covers `/private/tmp/…`). Returns either a literal path or a glob.
 */
function canonicalPattern(pattern: string): { literal: string } | { glob: string } {
  const parts = pattern.split('/')
  const firstGlob = parts.findIndex(part => hasGlob(part))
  if (firstGlob < 0) return { literal: realpathLoose(unescape(pattern)) }
  const prefix = realpathLoose(unescape(parts.slice(0, firstGlob).join('/')) || '/')
  return { glob: [literalPattern(prefix === '/' ? '' : prefix), ...parts.slice(firstGlob)].join('/') }
}

/**
 * Path patterns: absolute, `~/…`, or relative to the project. A pattern
 * without wildcards covers everything under it.
 */
export function matchPath(pattern: string, path: string, workspace: string): boolean {
  let p = pattern.trim()
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1))
  else if (!isAbsolute(p)) p = join(workspace, p)
  if (p.length > 1 && p.endsWith('/')) p = `${p}**`
  const c = canonicalPattern(p)
  if ('literal' in c) return isWithin(path, c.literal)
  return globToRegExp(c.glob, 'path').test(path)
}

// ---------- matching ----------

const RESTRICTIVE: Record<Action, number> = { allow: 0, auto: 1, ask: 2, deny: 3 }

function fieldMatches<T>(values: T[], restrictive: boolean, test: (v: T) => boolean): boolean {
  if (values.length === 0) return false
  // A rule that would deny or ask applies if any part matches; one that would let it
  // through only if every part does.
  return restrictive ? values.some(test) : values.every(test)
}

/** Does a rule's `access` cover the extra access this command asks for? */
function accessCovered(rule: Rule, op: Operation, ctx: RuleContext): boolean {
  const want = op.access
  if (!want) return true
  const write = rule.access?.write ?? []
  const hosts = rule.access?.hosts ?? []
  return want.write.every(w => write.some(p => matchPath(p, w, ctx.policy.workspace))) && want.hosts.every(h => hosts.some(p => matchHost(p, h.replace(/:\d+$/, '')) && (!/:\d+$/.test(p) || p === h)))
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`
}

export function ruleMatches(rule: Rule, op: Operation, ctx: RuleContext): boolean {
  if (rule.test) return rule.test(op, ctx)
  if (rule.tool && !matchTool(rule.tool, op.tool)) return false
  const restrictive = RESTRICTIVE[rule.action] >= RESTRICTIVE.ask
  if (!restrictive) {
    // Letting a tool run never widens the fence by itself: running outside the
    // sandbox, or with extra write folders or hosts, needs a rule that says so.
    if (op.execution === 'unsandboxed' && rule.unsandboxed !== true) return false
    if (op.execution === 'sandboxed-with-access' && !accessCovered(rule, op, ctx)) return false
  }
  if (rule.command !== undefined) {
    if (op.kind !== 'shell' || !op.command || !op.shell) return false
    if (restrictive) {
      // Any way the command could run it: parts, wrappers, substitutions, quoted code.
      if (![...commandCandidates(op.command)].some(c => matchText(rule.command!, c))) return false
    } else if (op.shell.opaque) {
      // Can't see what it really runs: only an exact, wildcard-free rule for this whole command lets it through.
      if (hasGlob(rule.command) || unescape(rule.command.trim()) !== op.command.trim()) return false
    } else if (!fieldMatches(op.shell.segments, false, s => matchText(rule.command!, s))) {
      // Every part of `a && b | c` must be allowed on its own; `npm test*` never covers `npm test && git push`.
      return false
    }
  }
  if (rule.path !== undefined && !fieldMatches(op.paths, restrictive, p => matchPath(rule.path!, p.path, ctx.policy.workspace))) return false
  if (rule.host !== undefined && !fieldMatches(op.hosts, restrictive, h => matchHost(rule.host!, h))) return false
  if (rule.input) {
    for (const [k, pattern] of Object.entries(rule.input)) {
      const v = op.input[k]
      if (v === undefined) return false
      if (!matchText(pattern, typeof v === 'string' ? v : JSON.stringify(v))) return false
    }
  }
  if (rule.inputExact !== undefined && stableJson(rule.inputExact) !== stableJson(op.input)) return false
  return true
}

/**
 * Explicit deny/ask command rules that can't be settled for this command:
 * part of what it runs only exists at run time (`eval "$X"`, `$CMD push`,
 * `python -c …`), so none of the forms Runway can read is the whole story.
 * A person decides those, never an allow rule or grant.
 */
export function uncertainRestrictive(rules: readonly Rule[], op: Operation): Rule | undefined {
  if (op.kind !== 'shell' || !op.shell?.dynamic) return undefined
  return rules.find(r => (r.action === 'deny' || r.action === 'ask') && r.command !== undefined && (!r.tool || matchTool(r.tool, op.tool)))
}

/**
 * `npm test && npm run lint` with one allow rule for each part: every part is
 * allowed by some allow rule. Only for commands Runway can read in full.
 * Returns the rules used, or undefined.
 */
export function allowedPartByPart(rules: readonly Rule[], op: Operation, ctx: RuleContext): Rule[] | undefined {
  if (op.kind !== 'shell' || !op.shell || op.shell.opaque || op.shell.segments.length < 2) return undefined
  const used: Rule[] = []
  for (const segment of op.shell.segments) {
    const part: Operation = { ...op, command: segment, shell: analyzeShell(segment), hosts: extractHosts(segment) }
    const rule = rules.find(r => r.action === 'allow' && r.command !== undefined && ruleMatches(r, part, ctx))
    if (!rule) return undefined
    used.push(rule)
  }
  return used
}

/** The strongest matching rule (deny > ask > auto > allow), or undefined. */
export function strongestMatch(rules: readonly Rule[], op: Operation, ctx: RuleContext, actions: readonly Action[] = ACTIONS): Rule | undefined {
  let best: Rule | undefined
  for (const rule of rules) {
    if (!actions.includes(rule.action)) continue
    if (best && RESTRICTIVE[rule.action] <= RESTRICTIVE[best.action]) continue
    if (ruleMatches(rule, op, ctx)) best = rule
  }
  return best
}

// ---------- parsing ----------

/**
 * Your rules, from runway.json. A rule Runway can't read never turns into a
 * wider permission and never silently disappears if it was meant to restrict:
 *  - a broken allow rule is dropped (that only narrows what's allowed);
 *  - any other broken rule, or one whose action can't be read, still
 *    restricts: it covers every call of its tool (every tool call if the tool
 *    can't be read either) — deny stays deny, anything else asks you (a
 *    broken auto rule must not let a built-in allow through) — until you fix
 *    it. Each one is reported as a settings problem.
 */
export function failSafeRule(id: string, action: 'deny' | 'ask', source: Exclude<RuleSource, 'default'>, where: string, tool: string | undefined, problem: string): Rule {
  return {
    id, action, source, tool, invalid: problem,
    reason: `Runway can't read ${id.endsWith('0') && !tool ? 'the settings' : 'this rule'} in ${where} (${problem}), so it ${action === 'deny' ? 'blocks' : 'asks about'} ${tool ? `every ${tool} call` : 'every tool call'} until that is fixed`,
  }
}

export function parseRules(value: unknown, source: Exclude<RuleSource, 'default'>, where: string, problems: string[]): Rule[] {
  if (value === undefined) return []
  const failSafe = (id: string, action: 'deny' | 'ask', tool: string | undefined, problem: string): Rule => failSafeRule(id, action, source, where, tool, problem)
  if (!Array.isArray(value)) {
    const problem = '"permissions" must be a list of rules'
    problems.push(`${where}: ${problem}; until it is fixed, every tool call asks you`)
    return [failSafe(`${source === 'personal' ? 'p' : 'r'}0`, 'ask', undefined, problem)]
  }
  const rules: Rule[] = []
  value.forEach((raw, i) => {
    const label = `${where}: permissions[${i}]`
    const id = `${source === 'personal' ? 'p' : 'r'}${i + 1}`
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
    const action = typeof r?.action === 'string' && (ACTIONS as readonly string[]).includes(r.action) ? (r.action as Action) : undefined
    const broken = (problem: string): void => {
      if (action === 'allow') {
        problems.push(`${label}: ${problem}; this allow rule is ignored until fixed`)
        return
      }
      const tool = typeof r?.tool === 'string' && r.tool.trim() ? r.tool.trim() : undefined
      const strict = action === 'deny' ? 'deny' : 'ask'
      problems.push(`${label}: ${problem}; until fixed it ${strict === 'deny' ? 'blocks' : 'asks you about'} ${tool ? `every ${tool} call` : 'every tool call'}`)
      rules.push(failSafe(id, strict, tool, problem))
    }
    if (!r) return broken('a rule must be an object')
    if (!action) return broken(`"action" must be one of ${ACTIONS.join(', ')}`)
    const unknown = Object.keys(r).filter(k => !RULE_KEYS.has(k))
    if (unknown.length) return broken(`unknown field ${unknown.map(k => `"${k}"`).join(', ')}`)
    if (source === 'project' && (action === 'allow' || action === 'auto')) {
      problems.push(`${label}: a project can only add "deny" or "ask" rules; this "${action}" rule is ignored`)
      return
    }
    const rule: Rule = { id, action, source }
    for (const key of ['tool', 'command', 'path', 'host', 'reason'] as const) {
      if (r[key] === undefined) continue
      if (typeof r[key] !== 'string' || !(r[key] as string).trim()) return broken(`"${key}" must be a non-empty string`)
      rule[key] = (r[key] as string).trim()
    }
    if (r.input !== undefined) {
      if (!r.input || typeof r.input !== 'object' || Array.isArray(r.input) || !Object.values(r.input).every(v => typeof v === 'string')) return broken('"input" must map parameter names to patterns')
      rule.input = r.input as Record<string, string>
    }
    if (r.inputExact !== undefined) {
      if (!r.inputExact || typeof r.inputExact !== 'object' || Array.isArray(r.inputExact)) return broken('"inputExact" must be an object')
      rule.inputExact = r.inputExact as Record<string, unknown>
    }
    if (r.access !== undefined) {
      const a = r.access as Record<string, unknown>
      const list = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim()))
      if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => k !== 'write' && k !== 'hosts') || !list(a.write) || !list(a.hosts)) {
        return broken('"access" must be { "write"?: [paths], "hosts"?: [hosts] } and nothing else')
      }
      rule.access = { write: a.write as string[] | undefined, hosts: a.hosts as string[] | undefined }
    }
    if (r.unsandboxed !== undefined) {
      if (typeof r.unsandboxed !== 'boolean') return broken('"unsandboxed" must be true or false')
      rule.unsandboxed = r.unsandboxed
    }
    if (!rule.tool && !rule.command && !rule.path && !rule.host && !rule.input && rule.inputExact === undefined) {
      return broken('a rule needs at least one of tool, command, path, host, input or inputExact')
    }
    if (rule.command && !rule.tool) rule.tool = 'bash'
    rules.push(rule)
  })
  return rules
}

/** How a rule reads in lists and dialogs: `deny bash "git push --force*"`. */
export function describeRule(rule: Rule): string {
  if (rule.description) return rule.description
  if (rule.invalid) return `${rule.tool ?? 'every tool'} · unreadable rule (${rule.invalid})`
  const parts = [rule.tool ?? '*']
  if (rule.command) parts.push(`command ${JSON.stringify(rule.command)}`)
  if (rule.path) parts.push(`path ${JSON.stringify(rule.path)}`)
  if (rule.host) parts.push(`host ${JSON.stringify(rule.host)}`)
  if (rule.input) parts.push(`input ${JSON.stringify(rule.input)}`)
  if (rule.inputExact) parts.push(`exactly ${JSON.stringify(rule.inputExact)}`)
  if (rule.access?.write?.length) parts.push(`may also write ${rule.access.write.join(', ')}`)
  if (rule.access?.hosts?.length) parts.push(`may also reach ${rule.access.hosts.join(', ')}`)
  if (rule.unsandboxed) parts.push('outside the sandbox')
  return parts.join(' · ')
}

export function serializeRule(rule: Rule): Record<string, unknown> {
  const out: Record<string, unknown> = { action: rule.action }
  for (const key of ['tool', 'command', 'path', 'host', 'input', 'inputExact', 'access', 'reason', 'unsandboxed'] as const) if (rule[key] !== undefined) out[key] = rule[key]
  return out
}

// ---------- built-in defaults ----------

function within(paths: Operation['paths'], test: (p: Operation['paths'][number]) => boolean): boolean {
  return paths.length > 0 && paths.every(test)
}

/**
 * Runway's defaults. There is deliberately no list of "safe" or "dangerous"
 * commands or tool names here: every command, web, MCP and unknown tool call
 * that your own rules don't decide goes to the reviewer. The only built-in
 * decisions are about where Pi's own file tools may read and write — the same
 * boundary the sandbox enforces for commands — and about coordination tools
 * whose identity Runway can verify and whose calls are each checked anyway.
 */
export function defaultRules(): Rule[] {
  return [
    {
      id: 'd-secrets', action: 'ask', source: 'default',
      summary: 'credential stores, read by any tool',
      description: 'Ask before a tool reads a credential store (~/.ssh, cloud CLIs, Pi logins, Keychains)',
      test: (op, { policy }) => op.kind !== 'shell' && op.paths.some(p => p.access === 'read' && !policy.allowRead.some(a => isWithin(p.path, a)) && policy.denyRead.some(d => isWithin(p.path, d))),
    },
    {
      id: 'd-control', action: 'ask', source: 'default',
      summary: 'files that run code later, written by any tool',
      description: 'Ask before a tool changes files that run code later (git hooks, .pi, shell startup, editor tasks)',
      test: (op, { policy }) => op.kind !== 'shell' && op.paths.some(p => {
        if (p.access !== 'write') return false
        const v = checkWrite(p.path, policy)
        return !v.ok && v.control
      }),
    },
    {
      id: 'd-read', action: 'allow', source: 'default',
      summary: "Pi's read/grep/find/ls in the project, Pi resources, temp",
      description: "Pi's read, grep, find and ls: allowed in the project, Pi resources and temp folders. Reading a secrets file such as .env is not covered here, and Runway's grep never shows lines from one",
      test: (op, { policy }) => (op.kind === 'read' || op.kind === 'search') && within(op.paths, p => checkRead(p.path, policy).ok && (isWithin(p.path, policy.workspace) || policy.allowRead.some(a => isWithin(p.path, a)) || policy.allowWrite.some(a => isWithin(p.path, a)))),
    },
    {
      id: 'd-write', action: 'allow', source: 'default',
      summary: "Pi's write/edit in the project and scratch folders",
      description: "Pi's write and edit: allowed in the project and scratch folders",
      test: (op, { policy }) => op.kind === 'write' && within(op.paths, p => checkWrite(p.path, policy).ok),
    },
    {
      id: 'd-coordination', action: 'allow', source: 'default',
      summary: 'tool search and bundled helpers that only talk to you or the agent',
      description: "Pi's tool search and Runway's bundled plan-question, subagent-result and web-enable helpers (identified by who registered them): they only talk to you or the agent. Codemode scripts and starting a subagent are reviewed, and so is every call they make",
      test: op => op.kind === 'meta',
    },
    {
      id: 'd-review', action: 'auto', source: 'default',
      summary: 'everything else: Jev reviews, you have the last word',
      description: 'Everything else goes to the reviewer (Jev): every command, codemode script, subagent, web and MCP call, and any other tool. You get the last word if it says no or cannot decide',
      test: () => true,
    },
  ]
}

export function relativeTo(path: string, root: string): string {
  const rel = relative(root, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}
