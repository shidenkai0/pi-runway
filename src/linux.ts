import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DANGEROUS_FILES, getDangerousDirectories } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js'
import { isWithin } from './policy.ts'

// Linux-only adjustments around sandbox-runtime's bubblewrap backend.
//
// 1. To block creation of protected files that don't exist yet, bubblewrap
//    binds /dev/null over each absent path (shell startup files, .gitconfig,
//    .vscode, .pi…). Those character devices are visible inside the command,
//    and `git add -A` refuses them ("unable to index file"). Runway gives that
//    one command a temporary git excludes file listing exactly those absent
//    paths, merged with your own excludes. The file lives in a private folder
//    created for the command (read-only inside the sandbox) and is removed
//    when the command ends. Nothing in the project or your git config is
//    changed, and the protective mounts stay in place.
//    Upstream: anthropics/sandbox-runtime#139.
// 2. bubblewrap can't express `**` write-deny globs, and sandbox-runtime drops
//    them. Runway lists nested control folders that already exist (nested
//    repositories' .git/hooks, .vscode, …) as concrete paths instead. A folder
//    created and then written within the same command is not covered.
// 3. bubblewrap can only make existing folders writable. A tool cache that
//    doesn't exist yet stays read-only, so a first `npm install` fails. Runway
//    creates the two conventional cache folders, ~/.npm and ~/.cache, when
//    they are missing (empty folders; nothing else in your home is created).

function absent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch {
    return true
  }
}

function gitOut(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000 }).trim() || undefined
  } catch {
    return undefined
  }
}

/** Paths bubblewrap will cover with /dev/null for this command: sandbox-runtime's own list (at Pi's working directory) plus Runway's literal write denies. */
export function devNullMountTargets(denyWrite: readonly string[], processCwd = process.cwd()): string[] {
  const library = [...DANGEROUS_FILES, ...getDangerousDirectories()].map(p => join(processCwd, p))
  const literal = denyWrite.filter(p => !p.includes('*'))
  return [...new Set([...library, ...literal])].filter(absent)
}

export interface GitExcludes {
  /** Environment additions pointing git at the excludes file. */
  env: Record<string, string>
  /** The private folder holding it: keep it read-only in the sandbox. */
  dir: string
  /** Remove the folder once the command has finished. */
  cleanup(): void
}

/**
 * Make git ignore the /dev/null mount points of absent protected paths, for
 * one command. Undefined when nothing is needed.
 */
export function gitExcludeEnv(cwd: string, denyWrite: readonly string[], env: NodeJS.ProcessEnv, processCwd = process.cwd()): GitExcludes | undefined {
  if (process.platform !== 'linux') return undefined
  const top = gitOut(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) return undefined
  const targets = devNullMountTargets(denyWrite, processCwd).filter(p => isWithin(p, top) && p !== top)
  if (targets.length === 0) return undefined

  // Keep whatever excludes file git would have used.
  let existing = ''
  const configured = gitOut(cwd, ['config', '--get', 'core.excludesFile'])
  const base = configured
    ? configured.replace(/^~(?=\/|$)/, homedir())
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'ignore')
  try {
    existing = readFileSync(base, 'utf8')
  } catch {
    existing = ''
  }
  const lines = targets.map(p => `/${relative(top, p).split('\\').join('/')}`)
  const content = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}# Added by Runway for one sandboxed command: protective mount points of absent files\n${lines.join('\n')}\n`
  // A fresh private folder (0700, unpredictable name) and an exclusively created file: nothing shared, nothing followed.
  const dir = mkdtempSync(join(tmpdir(), 'pi-runway-git-'))
  const file = join(dir, 'excludes')
  try {
    writeFileSync(file, content, { flag: 'wx', mode: 0o600 })
  } catch {
    rmSync(dir, { recursive: true, force: true })
    return undefined
  }
  const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0
  return {
    env: {
      GIT_CONFIG_COUNT: String(index + 1),
      [`GIT_CONFIG_KEY_${index}`]: 'core.excludesFile',
      [`GIT_CONFIG_VALUE_${index}`]: file,
    },
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const CONTROL_DIRS = new Set(['.vscode', '.idea', '.husky', '.pi'])
const SKIP = new Set(['node_modules', '.venv', 'venv', 'target', 'dist', 'build', '.next', '.cache'])

/** Existing nested control folders under the project (bounded walk), for Linux where `**` denies can't be used. */
export function nestedControlPaths(workspace: string, maxDirs = 4_000, maxDepth = 6): string[] {
  const found: string[] = []
  let visited = 0
  const walk = (dir: string, depth: number) => {
    if (visited++ > maxDirs || depth > maxDepth) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = join(dir, e.name)
      if (e.name === '.git') {
        if (dir !== workspace) found.push(join(p, 'hooks'), join(p, 'config'))
        continue
      }
      if (CONTROL_DIRS.has(e.name)) {
        if (dir !== workspace) found.push(p)
        continue
      }
      if (e.name === '.claude') {
        found.push(join(p, 'commands'), join(p, 'agents'), join(p, 'settings.json'), join(p, 'settings.local.json'))
        continue
      }
      if (SKIP.has(e.name)) continue
      walk(p, depth + 1)
    }
  }
  walk(workspace, 0)
  return found.filter(p => !absent(p))
}

/** Create ~/.npm and ~/.cache if missing, so the sandbox can make them writable (Linux only). */
export function ensureCommonCaches(home: string = homedir()): void {
  if (process.platform !== 'linux') return
  for (const dir of [join(home, '.npm'), join(home, '.cache')]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 })
    } catch {
      // best effort: the command then reports the cache as unwritable
    }
  }
}
