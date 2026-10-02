import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RunwayConfig } from './config.ts'

// The containment policy, as plain data. One function turns (cwd, config) into
// the sandbox rules for a command; the same rules decide whether Pi's own
// file tools may touch a path. Pure except for git/realpath lookups.

export interface GitLayout {
  /** Top of the working tree. */
  toplevel: string
  /** This checkout's git dir (…/.git or …/.git/worktrees/<name>). */
  gitDir: string
  /** Shared git dir (same as gitDir unless this is a linked worktree). */
  commonDir: string
  linked: boolean
}

export interface Policy {
  workspace: string
  git: GitLayout | undefined
  allowWrite: string[]
  /** Sandbox write denies (only paths whose parent exists; see buildPolicy). */
  denyWrite: string[]
  /** Every protected control path, existing or not; used by Pi's own file tools. */
  protectedPaths: string[]
  denyRead: string[]
  /** Exceptions inside denyRead. */
  allowRead: string[]
  /** Hosts that never need review. */
  allowHosts: string[]
  deniedHosts: string[]
}

/** Registries and code hosts that everyday installs and builds need. */
export const DEFAULT_HOSTS = [
  // JavaScript
  'registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'npm.pkg.github.com', 'nodejs.org',
  'bun.sh', 'jsr.io', 'deno.land', 'dl.deno.land',
  // Python
  'pypi.org', 'files.pythonhosted.org', 'pypi.python.org',
  // Rust
  'crates.io', 'index.crates.io', 'static.crates.io', 'static.rust-lang.org',
  // Go
  'proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com', 'go.dev', 'golang.org',
  // Java / Ruby / PHP / .NET / Swift
  'repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org',
  'rubygems.org', 'index.rubygems.org', 'repo.packagist.org', 'api.nuget.org', 'swiftpackageindex.com',
  // Code hosts (reads; pushes need credentials, which commands cannot see)
  'github.com', '*.github.com', '*.githubusercontent.com', 'codeload.github.com',
  'gitlab.com', 'bitbucket.org',
  // Browser test binaries
  'playwright.azureedge.net', 'playwright.download.prss.microsoft.com', 'cdn.playwright.dev',
  'storage.googleapis.com',
]

/** Cloud metadata endpoints are never reachable from commands. */
export const DENIED_HOSTS = ['169.254.169.254', 'metadata.google.internal', 'metadata.goog', '100.100.100.200', 'fd00:ec2::254']

function home(): string {
  return homedir()
}

export function expandHome(path: string, cwd?: string): string {
  let out = path
  if (out === '~') out = home()
  else if (out.startsWith('~/')) out = join(home(), out.slice(2))
  if (!isAbsolute(out) && cwd) out = resolve(cwd, out)
  return out
}

/** realpath that tolerates missing leaves: resolves the nearest existing ancestor. */
export function realpathLoose(path: string): string {
  const abs = resolve(path)
  const tail: string[] = []
  let current = abs
  for (;;) {
    try {
      // .native returns the on-disk spelling (letter case) on macOS.
      const real = realpathSync.native(current)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return abs
      tail.push(basename(current))
      current = parent
    }
  }
}

/** Both the literal and the resolved spelling, so rules match however a tool names a path (/tmp vs /private/tmp). */
function spellings(path: string): string[] {
  const real = realpathLoose(path)
  return real === path ? [path] : [path, real]
}

/** macOS volumes are case-insensitive by default: `.PI/x` is `.pi/x`. */
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'

function fold(path: string): string {
  return FOLD_CASE ? path.toLowerCase() : path
}

export function isWithin(path: string, root: string): boolean {
  path = fold(path)
  root = fold(root)
  if (path === root) return true
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

const gitCache = new Map<string, { at: number; layout: GitLayout | undefined }>()

export function detectGit(cwd: string): GitLayout | undefined {
  const cached = gitCache.get(cwd)
  if (cached && Date.now() - cached.at < 30_000) return cached.layout
  let layout: GitLayout | undefined
  try {
    const out = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000 },
    )
    const [toplevel, gitDir, commonDir] = out.trim().split('\n')
    if (toplevel && gitDir && commonDir) {
      const g = realpathLoose(gitDir)
      const c = realpathLoose(commonDir)
      layout = { toplevel: realpathLoose(toplevel), gitDir: g, commonDir: c, linked: g !== c }
    }
  } catch {
    layout = undefined
  }
  gitCache.set(cwd, { at: Date.now(), layout })
  return layout
}

export function clearGitCache(): void {
  gitCache.clear()
}

/**
 * Folders that package managers and build tools write to. Low risk, high
 * friction if blocked. Tool homes are writable as a whole (so a first run can
 * create them), except the parts that run code later: see controlPaths().
 */
export function toolCaches(): string[] {
  const h = home()
  const caches = [
    '.npm', '.cache', '.pnpm-store', '.yarn', '.bun', '.deno', '.cargo', '.rustup/tmp', '.rustup/downloads',
    'go', '.gradle', '.m2/repository', '.nuget/packages', '.local/share/pnpm/store', '.local/share/uv', '.local/state',
    '.node-gyp', '.npm-global/_cacache', '.swiftpm',
  ]
  // Not PNPM_HOME itself (~/Library/pnpm): global pnpm binaries live there, on PATH.
  if (process.platform === 'darwin') caches.push('Library/Caches', 'Library/pnpm/store', 'Library/Developer/Xcode/DerivedData', 'Library/org.swift.swiftpm')
  return caches.map(c => join(h, c))
}

/** Places where a written file turns into code that runs later, outside the sandbox. */
export function controlPaths(workspace: string, cwd: string, agentDir: string, git: GitLayout | undefined): string[] {
  const h = home()
  const paths = [
    join(h, '.pi'), agentDir,
    join(workspace, '.pi'), join(cwd, '.pi'),
    join(h, '.gitconfig'), join(h, '.config', 'git'),
    join(h, '.ssh'), join(h, '.gnupg'),
    join(h, '.bashrc'), join(h, '.bash_profile'), join(h, '.bash_login'), join(h, '.profile'),
    join(h, '.zshrc'), join(h, '.zshenv'), join(h, '.zprofile'), join(h, '.zlogin'),
    join(h, '.config', 'fish'), join(h, '.config', 'nushell'),
    join(h, '.local', 'bin'), join(h, 'bin'), join(h, '.npmrc'), join(h, '.yarnrc.yml'),
    // Inside writable tool homes: binaries on PATH, config that can run code, credentials.
    join(h, '.cargo', 'bin'), join(h, '.cargo', 'config'), join(h, '.cargo', 'config.toml'), join(h, '.cargo', 'env'),
    join(h, '.cargo', 'credentials'), join(h, '.cargo', 'credentials.toml'),
    join(h, 'go', 'bin'), join(h, '.bun', 'bin'), join(h, '.bunfig.toml'), join(h, '.deno', 'bin'),
    join(h, '.gradle', 'init.d'), join(h, '.gradle', 'init.gradle'), join(h, '.gradle', 'init.gradle.kts'), join(h, '.gradle', 'gradle.properties'),
    join(h, '.yarn', 'bin'), join(h, '.config', 'yarn'), join(h, '.cache', 'pre-commit'),
  ]
  if (process.platform === 'darwin') paths.push(join(h, 'Library', 'LaunchAgents'))
  if (git) {
    for (const dir of new Set([git.gitDir, git.commonDir])) {
      paths.push(join(dir, 'hooks'), join(dir, 'config'), join(dir, 'config.worktree'))
    }
  }
  return paths
}

/**
 * Pi's own folders hold credentials (auth.json, models.json, sessions) next to
 * code and skills the model legitimately reads. Deny the folders, re-allow the
 * code/skill subtrees.
 */
export function piReadableSubtrees(agentDir: string): string[] {
  return ['npm', 'git', 'skills', 'agents', 'prompts', 'themes', 'extensions', 'local', 'AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md', 'keybindings.json', 'settings.json']
    .map(p => join(agentDir, p))
}

/**
 * Programs that hand out Keychain secrets without a prompt, because stored
 * tokens trust them (gh via /usr/bin/security, git via its osxkeychain helper).
 * The sandbox cannot block the Keychain service itself, so it blocks these.
 */
export function keychainTools(): string[] {
  if (process.platform !== 'darwin') return []
  return [
    '/usr/bin/security',
    '/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain',
    '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git-credential-osxkeychain',
    '/opt/homebrew/opt/git/libexec/git-core/git-credential-osxkeychain',
    '/usr/local/opt/git/libexec/git-core/git-credential-osxkeychain',
    '/opt/homebrew/bin/git-credential-osxkeychain',
    '/usr/local/share/gcm-core',
    '/usr/local/bin/git-credential-manager',
    '/opt/homebrew/bin/git-credential-manager',
  ]
}

/** Credential stores. Commands can never read these; Pi's read tool must ask first. */
export function secretPaths(agentDir: string): string[] {
  const h = home()
  const paths = [
    '.ssh', '.aws', '.gnupg', '.config/gh', '.config/hub', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
    '.docker/config.json', '.kube', '.config/gcloud', '.azure', '.oci', '.cargo/credentials', '.cargo/credentials.toml',
    '.m2/settings.xml', '.gem/credentials', '.terraform.d/credentials.tfrc.json', '.vault-token',
    '.codex/auth.json', '.codex/config.toml', '.claude.json', '.claude/.credentials.json', '.config/op', '.password-store',
    '.bash_history', '.zsh_history', '.local/share/fish/fish_history', '.python_history', '.node_repl_history', '.psql_history',
  ].map(p => join(h, p))
  paths.push(join(h, '.pi'), agentDir)
  if (process.platform === 'darwin') {
    paths.push(
      join(h, 'Library', 'Keychains'),
      join(h, 'Library', 'Cookies'),
      join(h, 'Library', 'Application Support', 'Google', 'Chrome'),
      join(h, 'Library', 'Application Support', 'Firefox'),
      join(h, 'Library', 'Application Support', 'BraveSoftware'),
      join(h, 'Library', 'Application Support', 'Arc'),
      join(h, 'Library', 'Safari'),
      join(h, 'Library', 'Messages'),
      join(h, 'Library', 'Mail'),
    )
  } else {
    paths.push(join(h, '.mozilla'), join(h, '.config', 'google-chrome'), join(h, '.config', 'chromium'), join(h, '.local', 'share', 'keyrings'))
  }
  return paths
}

export function tempRoots(): string[] {
  const roots = new Set<string>(['/tmp', realpathLoose('/tmp'), tmpdir(), realpathLoose(tmpdir())])
  // macOS keeps a per-user cache folder next to the per-user temp folder (…/T → …/C).
  if (process.platform === 'darwin' && basename(tmpdir().replace(/\/$/, '')) === 'T') {
    const cache = join(dirname(tmpdir().replace(/\/$/, '')), 'C')
    roots.add(cache)
    roots.add(realpathLoose(cache))
  }
  return [...roots]
}

export function isBroadRoot(path: string): boolean {
  const h = realpathLoose(home())
  return fold(path) === fold(h) || path === '/' || fold(path) === fold(dirname(h)) || /^\/(Users|home|Volumes|private|var|opt|usr|System|Library)\/?$/.test(path)
}

export function buildPolicy(cwd: string, config: RunwayConfig, agentDir: string): Policy {
  const realCwd = realpathLoose(cwd)
  const git = detectGit(realCwd)
  // The project is the repository you started Pi in, or the folder itself.
  const workspace = git ? git.toplevel : realCwd
  // Started in your home folder or at the disk root: that is not a project, so
  // it is not made writable as one (temp and caches still are).
  const broad = isBroadRoot(workspace)
  const allowWrite = new Set<string>([...(broad ? [] : [workspace, realCwd]), ...tempRoots(), ...toolCaches()])
  // A linked worktree commits into the shared git dir of the main checkout.
  if (git && !isWithin(git.commonDir, workspace)) allowWrite.add(git.commonDir)
  if (git && !isWithin(git.gitDir, workspace)) allowWrite.add(git.gitDir)
  for (const extra of config.allowWrite) allowWrite.add(realpathLoose(expandHome(extra, realCwd)))
  const denyWrite = new Set<string>()
  const protectedPaths = new Set<string>()
  for (const p of controlPaths(workspace, realCwd, agentDir, git)) for (const s of spellings(p)) protectedPaths.add(s)
  // On macOS a write rule for a path that does not exist yet also blocks creating
  // its parent folders, which would stop tools from creating their home (~/.cargo)
  // on first run. Protect paths whose parent exists; the policy is rebuilt every
  // few seconds, so a folder created later is protected from then on.
  for (const p of controlPaths(workspace, realCwd, agentDir, git)) {
    if (!existsSync(dirname(p))) continue
    for (const s of spellings(p)) denyWrite.add(s)
  }
  // sandbox-runtime blocks these only beneath the folder Pi was started in; cover
  // the actual project too (it differs after /worktree or in a subagent's worktree).
  if (!broad) {
    for (const glob of ['**/.git/hooks', '**/.vscode', '**/.idea', '**/.claude/commands', '**/.claude/agents', '**/.claude/settings.json', '**/.claude/settings.local.json']) {
      denyWrite.add(`${workspace}/${glob}`)
    }
  }
  const denyRead = new Set<string>()
  for (const p of [...secretPaths(agentDir), ...keychainTools(), ...config.denyRead.map(p => expandHome(p, realCwd))]) {
    for (const s of spellings(p)) denyRead.add(s)
  }
  const allowRead = new Set<string>()
  for (const p of [...piReadableSubtrees(agentDir), ...config.allowRead.map(p => expandHome(p, realCwd))]) {
    for (const s of spellings(p)) allowRead.add(s)
  }
  return {
    workspace,
    git,
    allowWrite: [...allowWrite],
    denyWrite: [...denyWrite],
    protectedPaths: [...protectedPaths],
    denyRead: [...denyRead],
    allowRead: [...allowRead],
    allowHosts: [...new Set([...DEFAULT_HOSTS, ...config.allowHosts])],
    deniedHosts: DENIED_HOSTS,
  }
}

// ---------- checks for Pi's in-process file tools ----------

const SECRET_FILE_NAMES = [/^\.env$/, /^\.env\.(?!example$|sample$|template$|dist$|defaults$).+$/, /^id_(rsa|dsa|ecdsa|ed25519)$/, /\.(pem|key|p12|pfx)$/, /^auth\.json$/, /^credentials(\.json)?$/, /^\.netrc$/]
const MANDATORY_WRITE_DENY_NAMES = new Set(['.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.zshenv', '.profile', '.gitconfig', '.gitmodules', '.ripgreprc', '.mcp.json'])
/** Folders anywhere in a path whose contents run later outside the sandbox (editors, agents, git hooks, Pi). */
const CONTROL_SEGMENTS = ['.vscode', '.idea', '.claude', '.husky', '.pi']

function hasControlSegment(path: string): boolean {
  const parts = fold(path).split(sep)
  if (parts.some(part => CONTROL_SEGMENTS.includes(part))) return true
  const git = parts.indexOf('.git')
  return git >= 0 && (parts[git + 1] === 'hooks' || parts[git + 1] === 'config')
}

/** Resolve a tool path argument the way Pi does (relative to cwd, ~ expanded, leading @ stripped), then follow symlinks. */
// Pi's file tools rewrite unusual spaces and, for a missing path, try a few
// spelling variants (NFD, curly apostrophe, macOS screenshot AM/PM). Judge the
// same file Pi will open.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

function piSpelling(abs: string): string {
  if (existsSync(abs)) return abs
  const nfd = abs.normalize('NFD')
  const variants = [abs.replace(/ (AM|PM)\./gi, '\u202F$1.'), nfd, abs.replace(/'/g, '\u2019'), nfd.replace(/'/g, '\u2019')]
  return variants.find(v => v !== abs && existsSync(v)) ?? abs
}

export function resolveToolPath(raw: string, cwd: string): string {
  const spaced = raw.replace(UNICODE_SPACES, ' ')
  const cleaned = spaced.startsWith('@') ? spaced.slice(1) : spaced
  let current = realpathLoose(piSpelling(expandHome(cleaned, cwd)))
  // Follow a final-component symlink by hand: realpath fails on dangling links,
  // and a dangling link is exactly how a write would create a file elsewhere.
  for (let hops = 0; hops < 40; hops += 1) {
    let target: string
    try {
      if (!lstatSync(current).isSymbolicLink()) return current
      target = readlinkSync(current)
    } catch {
      return current
    }
    current = realpathLoose(resolve(dirname(current), target))
  }
  return current
}

export type PathVerdict = { ok: true } | { ok: false; reason: string; secret: boolean; control: boolean }

export function checkRead(path: string, policy: Policy): PathVerdict {
  const reAllowed = policy.allowRead.some(a => isWithin(path, a))
  for (const denied of reAllowed ? [] : policy.denyRead) {
    if (isWithin(path, denied)) return { ok: false, reason: `${path} is inside a protected credential store (${denied})`, secret: true, control: false }
  }
  const name = fold(basename(path))
  if (SECRET_FILE_NAMES.some(re => re.test(name))) {
    return { ok: false, reason: `${name} looks like a secrets file; reading it would put its values into the conversation`, secret: true, control: false }
  }
  return { ok: true }
}

/** For search tools: a search rooted above a credential store would walk into it. */
export function checkSearchRoot(path: string, policy: Policy, returnsContent: boolean): PathVerdict {
  const direct = checkRead(path, policy)
  if (!direct.ok && direct.secret && policy.denyRead.some(d => isWithin(path, d)) && !policy.allowRead.some(a => isWithin(path, a))) return direct
  if (returnsContent) {
    const covered = policy.denyRead.filter(d => isWithin(d, path) && d !== path && existsSync(d))
    if (covered.length > 0 && (!isWithin(path, policy.workspace) || isBroadRoot(policy.workspace))) {
      return { ok: false, reason: `searching ${path} would read inside protected credential stores (${covered.slice(0, 3).join(', ')})`, secret: true, control: false }
    }
  }
  return { ok: true }
}

export function checkWrite(path: string, policy: Policy): PathVerdict {
  for (const denied of policy.protectedPaths) {
    if (isWithin(path, denied)) return { ok: false, reason: `${path} is a protected control path (${denied}); writing it could run code outside the sandbox later`, secret: false, control: true }
  }
  if (MANDATORY_WRITE_DENY_NAMES.has(fold(basename(path))) || hasControlSegment(path)) {
    return { ok: false, reason: `${path} is a shell, git, editor, agent or tool configuration file`, secret: false, control: true }
  }
  if (!policy.allowWrite.some(root => isWithin(path, root))) {
    return { ok: false, reason: `${path} is outside the project and the usual scratch folders`, secret: false, control: false }
  }
  return { ok: true }
}
