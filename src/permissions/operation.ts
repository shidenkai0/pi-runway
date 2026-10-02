import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { resolveToolPath } from '../policy.ts'
import { analyzeShell } from './shell.ts'
import type { ShellAnalysis } from './shell.ts'

// Every tool call, whatever its source (built-in, bash, web, MCP, another
// extension, a codemode script, a subagent), becomes one Operation: what is
// being done, to which paths/hosts, how it would run, and the keys that
// "same operation" and "whole tool" approvals are stored under.

export type OperationKind = 'shell' | 'read' | 'write' | 'search' | 'web' | 'mcp' | 'subagent' | 'codemode' | 'network' | 'meta' | 'tool'

export type Execution =
  /** Bash inside the OS sandbox. */
  | 'sandboxed'
  /** Bash inside the OS sandbox with extra, named write paths or hosts. */
  | 'sandboxed-with-access'
  /** Bash outside the OS sandbox: the user's full access. */
  | 'unsandboxed'
  /** Runs inside Pi itself (file tools, web tools, MCP clients, other extensions). */
  | 'in-process'

/**
 * Who actually implements the tool, from Pi's own registry (never from the
 * tool's name alone). Defaults only ever apply to tools whose identity is
 * known: Pi's built-in tools, Pi's built-in MCP/codemode/tool-search
 * extensions, Runway's own bash, and the companions Runway loaded itself.
 */
export type ToolIdentity =
  | { kind: 'pi-builtin'; name: string }
  | { kind: 'pi-extension'; name: 'codemode' | 'tool-search' | 'mcp' | string }
  | { kind: 'runway' }
  | { kind: 'companion'; companion: 'subagents' | 'web' | 'plan' }
  | { kind: 'extension'; path: string }
  | { kind: 'unknown' }

export interface ToolMeta {
  identity: ToolIdentity
  source: 'builtin' | 'mcp' | 'extension' | 'unknown'
  sourcePath?: string
  namespace?: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  description?: string
}

export interface Endpoint {
  host: string
  port?: number
}

export interface PathAccess {
  path: string
  access: 'read' | 'write'
}

export interface Operation {
  tool: string
  kind: OperationKind
  /** One line for people: `npm test`, `read src/a.ts`, `github / create_issue`. */
  summary: string
  /** The call's actual parameters (what the reviewer sees, after redaction). */
  input: Record<string, unknown>
  command?: string
  shell?: ShellAnalysis
  paths: PathAccess[]
  hosts: string[]
  /** Hosts with the port a URL named (undefined: the scheme's default port). */
  endpoints: Endpoint[]
  mcp?: { server: string; tool: string }
  execution: Execution
  /** Extra sandbox access requested by a bash call. */
  access?: { write: string[]; hosts: string[] }
  meta: ToolMeta
  cwd: string
  toolCallId: string
  parentToolCallId?: string
  /**
   * Identity of the exact operation: a hash over the tool and who implements
   * it, the working folder, how it runs (including any extra sandbox access)
   * and the complete input. "Allow this for the session" is stored under it,
   * so a changed file content, folder, flag or access never reuses an approval.
   */
  key: string
}

const PATH_KEY = /(^|_)(path|paths|file|files|filename|filepath|dir|directory|folder|cwd|dest|destination|target|src|source|output|outfile)$/i
const WRITE_KEY = /(dest|destination|target|output|outfile|save|write)/i

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function scanHosts(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 4) return
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\bhttps?:\/\/(?:[^\s/@'"]*@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})/g)) out.add(m[1]!.toLowerCase())
  } else if (Array.isArray(value)) for (const v of value) scanHosts(v, out, depth + 1)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) scanHosts(v, out, depth + 1)
}

function scanPaths(input: Record<string, unknown>, cwd: string, out: PathAccess[], depth = 0): void {
  if (depth > 3) return
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && PATH_KEY.test(k) && v.length < 1024 && !/^[a-z]+:\/\//i.test(v)) {
      out.push({ path: resolveToolPath(v, cwd), access: WRITE_KEY.test(k) ? 'write' : 'read' })
    } else if (Array.isArray(v) && PATH_KEY.test(k)) {
      for (const item of v) if (typeof item === 'string' && item.length < 1024) out.push({ path: resolveToolPath(item, cwd), access: WRITE_KEY.test(k) ? 'write' : 'read' })
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      scanPaths(v as Record<string, unknown>, cwd, out, depth + 1)
    }
  }
}

function clip(text: string, n = 120): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

export interface NormalizeArgs {
  tool: string
  input: Record<string, unknown>
  cwd: string
  toolCallId: string
  parentToolCallId?: string
  meta: ToolMeta
}

function buildOp(a: NormalizeArgs): Omit<Operation, 'key' | 'endpoints'> & { key?: string; endpoints?: Endpoint[] } {
  const { tool, input, cwd } = a
  const base = { tool, input, cwd, toolCallId: a.toolCallId, parentToolCallId: a.parentToolCallId, meta: a.meta }
  const hosts = new Set<string>()
  const id = a.meta.identity
  const builtin = (name: string) => id.kind === 'pi-builtin' && id.name === name

  // Runway's own bash (sandboxed); someone else's bash is just another tool.
  if (tool === 'bash' && id.kind === 'runway') {
    const command = str(input.command) ?? ''
    const shell = analyzeShell(command)
    for (const h of shell.hosts) hosts.add(h)
    const raw = (input.access ?? {}) as { write?: unknown; hosts?: unknown }
    const access = {
      write: Array.isArray(raw.write) ? raw.write.filter((p): p is string => typeof p === 'string').map(p => resolveToolPath(p, cwd)) : [],
      hosts: Array.isArray(raw.hosts) ? raw.hosts.filter((h): h is string => typeof h === 'string').map(h => h.toLowerCase()) : [],
    }
    for (const h of access.hosts) hosts.add(h)
    const escalate = input.escalate === true
    const endpoints = [...endpointsIn(command), ...access.hosts.map(h => parseHostPort(h))]
    const execution: Execution = escalate ? 'unsandboxed' : access.write.length || access.hosts.length ? 'sandboxed-with-access' : 'sandboxed'
    const extra = access.write.length > 0 || access.hosts.length > 0
    return {
      ...base, kind: 'shell', summary: clip(command, 200), command, shell,
      paths: access.write.map(path => ({ path, access: 'write' as const })), hosts: [...hosts],
      execution, access: extra ? access : undefined, endpoints,
    }
  }

  if ((tool === 'read' || tool === 'write' || tool === 'edit') && builtin(tool)) {
    const path = resolveToolPath(str(input.path) ?? '.', cwd)
    const access = tool === 'read' ? 'read' : 'write'
    return { ...base, kind: tool === 'read' ? 'read' : 'write', summary: `${tool} ${path}`, paths: [{ path, access }], hosts: [], execution: 'in-process' }
  }

  if ((tool === 'grep' || tool === 'find' || tool === 'ls') && (builtin(tool) || id.kind === 'runway')) {
    const path = resolveToolPath(str(input.path) ?? '.', cwd)
    const what = str(input.pattern) ? ` ${clip(String(input.pattern), 60)}` : ''
    return { ...base, kind: 'search', summary: `${tool}${what} in ${path}`, paths: [{ path, access: 'read' }], hosts: [], execution: 'in-process' }
  }

  if (id.kind === 'pi-extension' && id.name === 'mcp') {
    const parts = tool.slice('mcp__'.length).split('__')
    const server = a.meta.namespace?.replace(/^mcp__/, '') ?? parts[0] ?? '?'
    const mcpTool = parts.slice(1).join('__') || tool
    scanHosts(input, hosts)
    const paths: PathAccess[] = []
    scanPaths(input, cwd, paths)
    return { ...base, kind: 'mcp', summary: `${server} / ${mcpTool}`, paths, hosts: [...hosts], mcp: { server, tool: mcpTool }, execution: 'in-process' }
  }

  if (tool === 'codemode' && id.kind === 'pi-extension' && id.name === 'codemode') {
    const code = str(input.code) ?? ''
    scanHosts(input, hosts)
    return { ...base, kind: 'codemode', summary: `codemode script (${code.split('\n').length} lines)`, paths: [], hosts: [...hosts], execution: 'in-process' }
  }

  if (tool === 'subagent' && id.kind === 'companion' && id.companion === 'subagents') {
    const type = str(input.subagent_type) ?? 'agent'
    return { ...base, kind: 'subagent', summary: `start subagent "${type}": ${clip(str(input.description) ?? str(input.prompt) ?? '', 80)}`, paths: [], hosts: [], execution: 'in-process' }
  }

  if (tool === 'fetch_content' && id.kind === 'companion' && id.companion === 'web') {
    scanHosts(input, hosts)
    const urls = [str(input.url), ...(Array.isArray(input.urls) ? input.urls : [])].filter((u): u is string => typeof u === 'string')
    return { ...base, kind: 'web', summary: `fetch ${clip(urls.join(', ') || [...hosts].join(', '), 140)}`, paths: [], hosts: [...hosts], execution: 'in-process' }
  }

  if ((tool === 'web_search' || tool === 'code_search' || tool === 'get_search_content') && id.kind === 'companion' && id.companion === 'web') {
    const q = str(input.query) ?? (Array.isArray(input.queries) ? input.queries.join(' · ') : '') ?? ''
    scanHosts(input, hosts)
    return { ...base, kind: 'web', summary: `${tool === 'get_search_content' ? 'open search result' : 'search the web'}${q ? `: ${clip(String(q), 100)}` : ''}`, paths: [], hosts: [...hosts], execution: 'in-process' }
  }

  // Any other tool: an extension's, a plugin's, or one we have never seen.
  scanHosts(input, hosts)
  const paths: PathAccess[] = []
  scanPaths(input, cwd, paths)
  const kind: OperationKind = isCoordination(tool, id) ? 'meta' : 'tool'
  const detail = clip(stable(input), 100)
  return { ...base, kind, summary: `${tool} ${detail === '{}' ? '' : detail}`.trim(), paths, hosts: [...hosts], execution: 'in-process' }
}

export function envelopeKey(op: Pick<Operation, 'tool' | 'meta' | 'cwd' | 'execution' | 'access' | 'input'>): string {
  const id = op.meta.identity
  const identity = id.kind === 'extension' ? { kind: id.kind, path: id.path } : id
  const access = op.access ? { write: [...op.access.write].sort(), hosts: [...op.access.hosts].sort() } : undefined
  const envelope = stable({ v: 1, tool: op.tool, identity, cwd: op.cwd, execution: op.execution, access, input: op.input })
  return `${op.tool}#${createHash('sha256').update(envelope).digest('hex')}`
}

export function normalize(a: NormalizeArgs): Operation {
  const op = buildOp(a)
  const endpoints = op.endpoints ?? endpointsIn(op.kind === 'shell' ? op.command ?? '' : op.input)
  return { ...op, endpoints, key: envelopeKey(op) } as Operation
}

/** Hosts (and explicit ports) named by URLs or scp-style remotes anywhere in a value. */
export function endpointsIn(value: unknown, depth = 0, out: Endpoint[] = []): Endpoint[] {
  if (depth > 6) return out
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\b(?:https?|wss?|ftp|ssh|git):\/\/(?:[^\s/@'"]*@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/g)) {
      out.push({ host: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : undefined })
    }
    for (const m of value.matchAll(/(?:^|[\s'"])[\w.-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,}):/g)) out.push({ host: m[1]!.toLowerCase(), port: 22 })
  } else if (Array.isArray(value)) for (const v of value) endpointsIn(v, depth + 1, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) endpointsIn(v, depth + 1, out)
  return out
}

/**
 * Tools that only coordinate: they talk to the user or the agent, or hand out
 * work whose every call is checked on its own. Identified by who registered
 * them, not by name.
 */
function isCoordination(tool: string, id: ToolIdentity): boolean {
  if (id.kind === 'pi-extension' && id.name === 'tool-search') return true
  if (id.kind === 'companion' && id.companion === 'plan') return tool === 'plan_mode_question' || tool === 'plan_mode_complete'
  if (id.kind === 'companion' && id.companion === 'subagents') return tool === 'get_subagent_result' || tool === 'steer_subagent'
  // pi-web-access's switch that only makes its web tools available; the web calls themselves are reviewed.
  if (id.kind === 'companion' && id.companion === 'web') return tool === 'web_enable'
  return false
}

/** A network connection a sandboxed command makes to a host the policy doesn't know. */
export function networkOperation(host: string, port: number | undefined, cwd: string, commands: string[]): Operation {
  return {
    tool: 'network', kind: 'network', summary: `connect to ${host}${port && port !== 443 && port !== 80 ? `:${port}` : ''}`,
    input: { host, port, commands }, paths: [], hosts: [host], endpoints: [{ host, port }], execution: 'sandboxed', meta: { identity: { kind: 'runway' }, source: 'builtin' },
    cwd, toolCallId: `network:${host}:${port ?? ''}`, key: `network#${host}:${port ?? ''}`,
  }
}

/** "Allow every … call this session" is only offered (and only applies) inside the normal fence. */
export function toolGrantable(op: Operation): boolean {
  return (op.execution === 'sandboxed' || op.execution === 'in-process') && op.kind !== 'network'
}

/** "api.example.com" or "api.example.com:8443". */
export function parseHostPort(text: string): Endpoint {
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(text.trim().toLowerCase())
  return { host: m?.[1] ?? text, port: m?.[2] ? Number(m[2]) : undefined }
}

/** Does an endpoint someone approved cover a connection to host:port? A URL without a port covers 80 and 443. */
export function endpointCovers(e: Endpoint, host: string, port: number | undefined): boolean {
  if (e.host !== host.toLowerCase()) return false
  if (e.port === undefined) return port === undefined || port === 443 || port === 80
  return e.port === port
}

export function directoryOf(path: string): string {
  return dirname(path)
}
