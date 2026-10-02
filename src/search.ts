import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, DEFAULT_MAX_BYTES, formatSize, getAgentDir, truncateHead, truncateLine } from '@earendil-works/pi-coding-agent'
import { checkRead, isWithin, realpathLoose, resolveToolPath } from './policy.ts'
import type { Policy } from './policy.ts'

// Pi's optional search tools (grep, find, ls — off unless you enable them,
// e.g. `--tools …,grep`) run inside Pi, not in the sandbox, and Pi's grep
// searches hidden files. Runway supplies the same three tools, still off by
// default, with the same parameters and output, except that nothing inside a
// secrets file (.env, keys, auth.json…) or a credential store is ever read or
// shown: such files are excluded before their contents are searched, and the
// result carries a fixed note. Ordinary code search works as before.

export const GUARDED_SEARCH_TOOLS = new Set(['grep', 'find', 'ls'])

const DEFAULT_LIMIT = 100

/** Whether Runway may show this file's contents (grep) or name (find/ls inside a credential store). */
function readable(path: string, policy: Policy): boolean {
  return checkRead(realpathLoose(path), policy).ok
}

function insideCredentialStore(path: string, policy: Policy): boolean {
  const real = realpathLoose(path)
  if (policy.allowRead.some(a => isWithin(real, a))) return false
  return policy.denyRead.some(d => isWithin(real, d))
}

let rgPath: string | undefined

/** ripgrep, where Pi keeps it (its bin folder) or on PATH; Pi's own grep downloads it on first use. */
async function ripgrep(cwd: string, ctx: ExtensionContext | undefined): Promise<string> {
  const local = join(getAgentDir(), 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
  const find = () => (existsSync(local) ? local : spawnSync('rg', ['--version'], { stdio: 'ignore' }).error ? undefined : 'rg')
  rgPath ??= find()
  if (rgPath) return rgPath
  // Let Pi's grep fetch it, searching an empty folder.
  const empty = mkdtempSync(join(tmpdir(), 'runway-rg-'))
  try {
    await createGrepToolDefinition(cwd).execute('runway-rg', { pattern: 'x', path: empty }, undefined, undefined, ctx as never)
  } catch {
    // reported below
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
  rgPath = find()
  if (!rgPath) throw new Error('ripgrep (rg) is not available and could not be downloaded')
  return rgPath
}

/** Run ripgrep, feeding stdout lines to `onLine` (which may stop it early). Resolves with the exit code. */
function runRg(rg: string, args: string[], onLine: (line: string, stop: () => void) => void, signal?: AbortSignal): Promise<number | null> {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(new Error('Operation aborted'))
    const child = spawn(rg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const rl = createInterface({ input: child.stdout })
    let stopped = false
    const stop = () => {
      stopped = true
      child.kill()
    }
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.resume()
    rl.on('line', line => {
      if (!stopped && line.trim()) onLine(line, stop)
    })
    child.on('error', error => fail(new Error(`Failed to run ripgrep: ${error.message}`)))
    child.on('close', code => {
      rl.close()
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return fail(new Error('Operation aborted'))
      done(stopped ? 0 : code)
    })
  })
}

interface GrepParams { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }

export async function guardedGrep(params: GrepParams, cwd: string, policy: Policy, signal?: AbortSignal, ctx?: ExtensionContext): Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown> | undefined }> {
  const searchPath = resolveToolPath(params.path || '.', cwd)
  let isDirectory: boolean
  try {
    isDirectory = statSync(searchPath).isDirectory()
  } catch {
    throw new Error(`Path not found: ${searchPath}`)
  }
  if (!readable(searchPath, policy) && (!isDirectory || insideCredentialStore(searchPath, policy))) {
    throw new Error(`Runway: ${searchPath} holds secrets, so it is not searched. Search the code that uses them instead.`)
  }
  const rg = await ripgrep(cwd, ctx)
  const contextLines = params.context && params.context > 0 ? params.context : 0
  const limit = Math.max(1, params.limit ?? DEFAULT_LIMIT)

  const formatPath = (file: string) => {
    if (isDirectory) {
      const rel = relative(searchPath, file)
      if (rel && !rel.startsWith('..')) return rel.replace(/\\/g, '/')
    }
    return file.split(/[\\/]/).pop() ?? file
  }

  // 1. Which files would be searched (ignore rules, hidden files, the agent's glob), by name only.
  //    Secrets files and credential stores are dropped here, before any content is matched, so
  //    nothing about the result can depend on what they contain.
  let candidates: string[]
  if (isDirectory) {
    const listed: string[] = []
    const listArgs = ['--files', '--hidden', '--color=never', ...(params.glob ? ['--glob', params.glob] : []), '--', searchPath]
    const code = await runRg(rg, listArgs, line => void listed.push(line), signal)
    if (code !== 0 && code !== 1) throw new Error(`ripgrep exited with code ${code}`)
    candidates = listed
  } else {
    candidates = [searchPath]
  }
  const searchable = candidates.filter(f => readable(resolve(searchPath, f), policy))
  const excludedSome = searchable.length < candidates.length

  // 2. Search only those, in batches, until the match limit.
  const matches: { file: string; line: number; text?: string }[] = []
  let limitReached = false
  const args = ['--json', '--line-number', '--color=never', '--no-ignore', '--hidden']
  if (params.ignoreCase) args.push('--ignore-case')
  if (params.literal) args.push('--fixed-strings')
  for (let i = 0; i < searchable.length && !limitReached; i += 200) {
    const batch = searchable.slice(i, i + 200)
    const code = await runRg(rg, [...args, '--', params.pattern, ...batch], (line, stop) => {
      let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type !== 'match') return
      const file = event.data?.path?.text
      const lineNumber = event.data?.line_number
      if (!file || typeof lineNumber !== 'number') return
      matches.push({ file: resolve(searchPath, file), line: lineNumber, text: event.data?.lines?.text })
      if (matches.length >= limit) {
        limitReached = true
        stop()
      }
    }, signal)
    if (!limitReached && code !== 0 && code !== 1) throw new Error(`ripgrep exited with code ${code}`)
  }

  const notices: string[] = []
  const details: Record<string, unknown> = {}
  // Says only that such files exist here, never whether they would have matched.
  if (excludedSome) notices.push('Runway does not search files that hold secrets (such as .env, keys or credential stores)')
  if (matches.length === 0) return { content: [{ type: 'text', text: notices.length ? `No matches found\n\n[${notices.join('. ')}]` : 'No matches found' }], details: undefined }

  let linesTruncated = false
  const cache = new Map<string, string[]>()
  const linesOf = (file: string) => {
    let lines = cache.get(file)
    if (!lines) {
      try {
        lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
      } catch {
        lines = []
      }
      cache.set(file, lines)
    }
    return lines
  }
  const out: string[] = []
  for (const m of matches) {
    const rel = formatPath(m.file)
    if (contextLines === 0 && m.text !== undefined) {
      const t = truncateLine(m.text.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n$/, ''))
      if (t.wasTruncated) linesTruncated = true
      out.push(`${rel}:${m.line}: ${t.text}`)
      continue
    }
    const lines = linesOf(m.file)
    if (!lines.length) {
      out.push(`${rel}:${m.line}: (unable to read file)`)
      continue
    }
    for (let n = Math.max(1, m.line - contextLines); n <= Math.min(lines.length, m.line + contextLines); n += 1) {
      const t = truncateLine((lines[n - 1] ?? '').replace(/\r/g, ''))
      if (t.wasTruncated) linesTruncated = true
      out.push(n === m.line ? `${rel}:${n}: ${t.text}` : `${rel}-${n}- ${t.text}`)
    }
  }
  const truncation = truncateHead(out.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
  let text = truncation.content
  if (limitReached) {
    notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`)
    details.matchLimitReached = limit
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
    details.truncation = truncation
  }
  if (linesTruncated) {
    notices.push('Some lines truncated. Use read tool to see full lines')
    details.linesTruncated = true
  }
  if (notices.length) text += `\n\n[${notices.join('. ')}]`
  return { content: [{ type: 'text', text }], details: Object.keys(details).length ? details : undefined }
}

/** Drop result lines (paths relative to the search root) that lie inside a credential store. */
function withoutCredentialStores(text: string, root: string, policy: Policy): { text: string; dropped: number } {
  const [body = '', ...rest] = text.split('\n\n[')
  let dropped = 0
  const kept = body.split('\n').filter(line => {
    if (!line || line === 'No files found matching pattern' || line === '(empty directory)') return true
    const inside = insideCredentialStore(resolve(root, line.replace(/\/$/, '')), policy)
    if (inside) dropped += 1
    return !inside
  })
  const notice = dropped ? [`Runway hid ${dropped} entr${dropped === 1 ? 'y' : 'ies'} inside credential stores]`] : []
  const tail = [...rest.map(r => `[${r}`), ...notice.map(n => `[${n}`)]
  return { text: [kept.join('\n'), ...tail].join('\n\n'), dropped }
}

type PolicyFor = (cwd: string, ctx: ExtensionContext) => Policy

/** Pi's grep, find and ls with the guard above; registered off by default, like Pi's own. */
export function guardedSearchTools(policyFor: PolicyFor): ToolDefinition[] {
  const cwd = process.cwd()
  const grep = createGrepToolDefinition(cwd)
  const find = createFindToolDefinition(cwd)
  const ls = createLsToolDefinition(cwd)
  const note = ' Files that hold secrets (.env, keys, credential stores) are skipped.'
  return [
    {
      ...grep,
      description: `${grep.description}${note}`,
      defaultActive: false,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const here = ctx?.cwd ?? cwd
        return guardedGrep(params as GrepParams, here, policyFor(here, ctx), signal ?? undefined, ctx) as never
      },
    } as ToolDefinition,
    {
      ...find,
      description: `${find.description}${note}`,
      defaultActive: false,
      async execute(id, params, signal, onUpdate, ctx) {
        const here = ctx?.cwd ?? cwd
        const policy = policyFor(here, ctx)
        const root = resolveToolPath((params as { path?: string }).path || '.', here)
        if (insideCredentialStore(root, policy)) throw new Error(`Runway: ${root} is a credential store, so it is not listed.`)
        const result = await createFindToolDefinition(here).execute(id, params as never, signal, onUpdate, ctx)
        const first = result.content[0]
        if (first?.type !== 'text') return result
        return { ...result, content: [{ type: 'text', text: withoutCredentialStores(first.text, root, policy).text }, ...result.content.slice(1)] }
      },
    } as ToolDefinition,
    {
      ...ls,
      description: `${ls.description}${note}`,
      defaultActive: false,
      async execute(id, params, signal, onUpdate, ctx) {
        const here = ctx?.cwd ?? cwd
        const policy = policyFor(here, ctx)
        const root = resolveToolPath((params as { path?: string }).path || '.', here)
        if (insideCredentialStore(root, policy)) throw new Error(`Runway: ${root} is a credential store, so it is not listed.`)
        return createLsToolDefinition(here, {
          operations: {
            exists: p => existsSync(p),
            stat: p => statSync(p),
            readdir: p => (insideCredentialStore(p, policy) ? [] : readdirSync(p)),
          },
        }).execute(id, params as never, signal, onUpdate, ctx)
      },
    } as ToolDefinition,
  ]
}
