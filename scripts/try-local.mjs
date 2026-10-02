#!/usr/bin/env node
// Try Runway without touching your normal Pi setup.
//
//   node scripts/try-local.mjs [trial-folder]      (default: ../runway-trial next to this repo)
//
// The trial folder must be new, empty, or a trial folder this script created
// earlier (it carries a `.runway-trial` marker). Anything else is refused
// without writing a single file. Inside it:
//   agent/     a separate Pi settings folder whose only package is this checkout
//   project/   a scratch git project (created once, never modified afterwards)
// Your ~/.pi (settings, logins, extensions, sessions) is never read or written.
// Signing in to a model provider is up to you, inside the trial.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKER = '.runway-trial'
const OWNED_ENTRIES = new Set([MARKER, 'agent', 'project', '.DS_Store'])

/** realpath of the nearest existing ancestor, plus the not-yet-existing rest. */
export function canonical(path) {
  const abs = resolve(path)
  const rest = []
  let current = abs
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return abs
      rest.push(basename(current))
      current = parent
    }
  }
}

function within(path, root) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const fold = p => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * Why this canonical path cannot be a trial folder, or undefined if it can.
 * Pure apart from reading the environment's home and temp locations.
 */
export function refusal(target, { home = homedir(), temp = tmpdir(), repo } = {}) {
  const t = fold(target)
  const h = fold(canonical(home))
  const temps = [temp, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map(p => fold(canonical(p)))
  if (t === '/' || /^\/[^/]+$/.test(t)) return `${target} is a top-level system folder`
  if (t === h || within(h, t)) return `${target} is your home folder or contains it`
  if (within(t, fold(join(canonical(home), '.pi')))) return `${target} is inside your Pi settings (~/.pi)`
  if (temps.some(tp => within(t, tp))) return `${target} is inside the system temp folder, which the sandbox can write to by design, so the trial would not show what containment looks like`
  if (repo && within(fold(canonical(repo)), t)) return `${target} is this checkout or contains it`
  return undefined
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** 'new' | 'empty' | 'owned' | a refusal reason. */
export function ownership(target) {
  if (!existsSync(target)) return 'new'
  const stat = lstatSync(target)
  if (!stat.isDirectory()) return `${target} exists and is not a folder`
  const entries = readdirSync(target)
  if (entries.length === 0) return 'empty'
  if (!entries.includes(MARKER)) return `${target} already has content that this script did not create; choose a new or empty folder`
  const foreign = entries.filter(e => !OWNED_ENTRIES.has(e))
  if (foreign.length) return `${target} has a trial marker but also other content (${foreign.slice(0, 3).join(', ')}); refusing to touch it`
  // Writes go into agent/ (and project/ is only ever created); neither may point elsewhere.
  for (const entry of ['agent', 'project', MARKER, join('agent', 'settings.json')]) {
    const path = join(target, entry)
    if (!existsSync(path) && !isLink(path)) continue
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return `${path} is a symbolic link; refusing to write through it`
    if (entry !== MARKER && !entry.endsWith('.json') && !st.isDirectory()) return `${path} is not a folder`
  }
  return 'owned'
}

/** Quote a value for a POSIX shell, so paths with spaces or quotes paste safely. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function ensureSettings(agent, repo) {
  const path = join(agent, 'settings.json')
  let settings = {}
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8'))
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {}
    } catch {
      settings = {}
    }
  }
  // The trial loads this checkout and nothing else.
  settings.packages = [repo]
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
}

function createProject(project) {
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), '# Runway trial\n\nA scratch project for trying Runway.\n')
  writeFileSync(join(project, 'index.js'), 'console.log("hello from the trial")\n')
  const git = args => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
  git(['init', '-q', '-b', 'main'])
  git(['add', 'README.md', 'index.js'])
  git(['-c', 'user.name=runway trial', '-c', 'user.email=trial@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'trial project'])
}

export function prepareTrial(requested, { repo, home, temp, installDeps = true } = {}) {
  const target = canonical(requested)
  const refused = refusal(target, { home, temp, repo })
  if (refused) return { ok: false, reason: refused }
  const state = ownership(target)
  if (!['new', 'empty', 'owned'].includes(state)) return { ok: false, reason: state }
  if (state === 'new' && !existsSync(dirname(target))) return { ok: false, reason: `the parent folder ${dirname(target)} does not exist` }

  if (installDeps && !existsSync(join(repo, 'node_modules', '@anthropic-ai', 'sandbox-runtime'))) {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: repo, stdio: 'ignore' })
  }
  if (state !== 'owned') {
    if (state === 'new') mkdirSync(target)
    writeFileSync(join(target, MARKER), `${JSON.stringify({ createdBy: 'pi-runway scripts/try-local.mjs', repo }, null, 2)}\n`)
  }
  const agent = join(target, 'agent')
  const project = join(target, 'project')
  if (!existsSync(agent)) mkdirSync(agent)
  ensureSettings(agent, repo)
  const warnings = []
  if (existsSync(join(agent, 'extensions')) && readdirSync(join(agent, 'extensions')).length) {
    warnings.push(`Extensions in ${join(agent, 'extensions')} will also load in this trial.`)
  }
  let projectNote = 'created'
  if (!existsSync(project)) createProject(project)
  else projectNote = 'kept as is'
  return { ok: true, target, agent, project, created: state !== 'owned', projectNote, warnings }
}

function main() {
  const repo = canonical(join(dirname(fileURLToPath(import.meta.url)), '..'))
  const requested = process.argv[2] ?? join(dirname(repo), 'runway-trial')
  const result = prepareTrial(requested, { repo })
  if (!result.ok) {
    console.error(`Not creating a trial: ${result.reason}.`)
    process.exit(1)
  }
  const q = shellQuote
  console.log(`Trial ${result.created ? 'created' : 'reused'}.
  Pi settings (separate from ~/.pi): ${result.agent}
  Scratch project (${result.projectNote}):  ${result.project}
${result.warnings.map(w => `  Note: ${w}\n`).join('')}
Start Pi in the trial:
  cd ${q(result.project)} && PI_CODING_AGENT_DIR=${q(result.agent)} pi

Inside Pi:
  /login              sign in to the model provider you want to use (stored in the trial folder only)
  /runway doctor      check the sandbox, the reviewer and tool ownership
Optional, for automatic reviews (otherwise escalations ask you):
  export OPENROUTER_API_KEY=...   before starting Pi, or /login to OpenRouter inside the trial

To remove the trial later, delete the folder ${result.target}
(it contains only the trial: ${MARKER}, agent/ and project/).`)
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) main()
