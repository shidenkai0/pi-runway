import { homedir } from 'node:os'
import { dirname, relative } from 'node:path'
import { isWithin } from '../policy.ts'
import type { Operation } from './operation.ts'
import { describeRule, literalPattern } from './rules.ts'
import type { Rule } from './rules.ts'
import { splitWords } from './shell.ts'

// "Always allow…" offers a few concrete scopes, narrowest first, each shown
// with the exact rule it will save. A saved scope never covers more access
// than the call it was offered for: a command that asked for extra write
// folders or hosts saves exactly those, and one that ran outside the sandbox
// says so. Only the explicitly broad "any … command" scope drops them, and it
// then covers commands in the normal sandbox only.

export interface ScopeChoice {
  label: string
  rule: Omit<Rule, 'id' | 'source'>
  /** Broad scopes are marked in the dialog. */
  broad: boolean
}

function shortPath(path: string, workspace: string): string {
  if (isWithin(path, workspace) && path !== workspace) return relative(workspace, path)
  const home = homedir()
  return isWithin(path, home) ? `~/${relative(home, path)}` : path
}

export function saveScopes(op: Operation, workspace: string): ScopeChoice[] {
  const out: ScopeChoice[] = []
  const add = (label: string, rule: ScopeChoice['rule'], broad = false) => {
    const text = describeRule({ ...rule, id: '', source: 'personal' })
    if (!out.some(c => describeRule({ ...c.rule, id: '', source: 'personal' }) === text)) out.push({ label, rule, broad })
  }
  if (op.kind === 'shell' && op.command) {
    // Exactly the access this call was approved with.
    const same: Partial<Rule> = {}
    if (op.execution === 'unsandboxed') same.unsandboxed = true
    if (op.access) same.access = { write: op.access.write.length ? [...op.access.write] : undefined, hosts: op.access.hosts.length ? [...op.access.hosts] : undefined }
    const where = op.execution === 'unsandboxed' ? ' (outside the sandbox)' : op.access ? ' (with the same extra access)' : ''
    add(`This exact command, in any project${where}`, { action: 'allow', tool: op.tool, command: literalPattern(op.command), ...same })
    const segments = op.shell?.segments ?? []
    if (segments.length === 1 && !op.shell?.opaque) {
      const words = splitWords(segments[0]!)
      // No list of command names, just the shape of the line: the program and
      // its first argument when there are more (`git push origin` → `git push*`,
      // `npx --yes wrangler@3 deploy` → `npx --yes wrangler@3*`), else the program
      // alone, which is marked broad. Flags ride along, they don't count.
      const plain = words.map((w, i) => ({ w, i })).filter(x => !x.w.startsWith('-'))
      const wanted = plain.length >= 3 ? 2 : 1
      const end = plain[wanted - 1] ? plain[wanted - 1]!.i + 1 : 0
      const lead = words.slice(0, end)
      if (end > 0 && end < words.length && lead.every(w => /^[\w@./:=+-]+$/.test(w))) {
        add(`Commands starting with \`${lead.join(' ')}\`${where}`, { action: 'allow', tool: op.tool, command: `${literalPattern(lead.join(' '))}*`, ...same }, wanted === 1)
      }
    }
    add(`Any ${op.tool} command that stays in the sandbox`, { action: 'allow', tool: op.tool }, true)
    return out
  }
  if (op.kind === 'read' || op.kind === 'write' || op.kind === 'search') {
    const p = op.paths[0]?.path
    if (p) {
      add(`This ${op.kind === 'search' ? 'folder' : 'file'}: ${shortPath(p, workspace)}`, { action: 'allow', tool: op.tool, path: literalPattern(shortPath(p, workspace)) })
      const dir = op.kind === 'search' ? p : dirname(p)
      add(`Everything in ${shortPath(dir, workspace)}/`, { action: 'allow', tool: op.tool, path: `${literalPattern(shortPath(dir, workspace))}/**` }, dir === homedir() || dir === '/')
    }
    add(`Any ${op.tool} call`, { action: 'allow', tool: op.tool }, true)
    return out
  }
  if (op.kind === 'network' || (op.kind === 'web' && op.hosts.length)) {
    for (const host of op.hosts.slice(0, 2)) {
      add(`${op.kind === 'network' ? 'Connections' : 'Fetching'} to ${host}`, { action: 'allow', tool: op.tool, host })
      // Subdomains of this exact host, never a parent domain (`*.co.uk` would be anyone's).
      add(`Any subdomain of ${host}`, { action: 'allow', tool: op.tool, host: `*.${host}` })
    }
    if (op.kind === 'web') add(`Any ${op.tool} call`, { action: 'allow', tool: op.tool }, true)
    return out
  }
  if (op.kind === 'mcp' && op.mcp) {
    add(`${op.mcp.server} / ${op.mcp.tool} with exactly these arguments`, { action: 'allow', tool: op.tool, inputExact: structuredClone(op.input) })
    add(`${op.mcp.server} / ${op.mcp.tool}, any arguments`, { action: 'allow', tool: op.tool }, true)
    const ns = op.meta.namespace ?? `mcp__${op.mcp.server}`
    add(`Every tool of the ${op.mcp.server} server`, { action: 'allow', tool: `${ns}__*` }, true)
    return out
  }
  add(`${op.tool} with exactly these arguments`, { action: 'allow', tool: op.tool, inputExact: structuredClone(op.input) })
  add(`${op.tool}, any arguments`, { action: 'allow', tool: op.tool }, true)
  return out
}

/** What "Allow this for the rest of the session" says, kept short. */
export function sessionOpLabel(op: Operation): string {
  const text = op.kind === 'shell' ? op.command ?? op.summary : op.summary
  const one = text.replace(/\s+/g, ' ').trim()
  const clipped = one.length > 60 ? `${one.slice(0, 59)}…` : one
  if (op.execution === 'unsandboxed') return `${clipped} (outside the sandbox)`
  if (op.access) return `${clipped} (with this extra access)`
  return clipped
}
