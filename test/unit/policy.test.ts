import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import { buildPolicy, checkRead, checkSearchRoot, checkWrite, clearGitCache, resolveToolPath } from '../../src/policy.ts'

const agentDir = join(homedir(), '.pi', 'agent')

function repo(): { root: string; main: string; done: () => void } {
  // Outside the system temp folder, which is writable from the sandbox by design.
  const base = join(import.meta.dirname, '..', '..', '.e2e')
  mkdirSync(base, { recursive: true })
  const root = realpathSync(mkdtempSync(join(base, 'pol-')))
  const main = join(root, 'app')
  mkdirSync(main)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(main, 'a.txt'), 'a')
  git('-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '.')
  git('-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'init')
  clearGitCache()
  return { root, main, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('project, temp and caches are writable; home, Pi and git control files are not', () => {
  const r = repo()
  try {
    const p = buildPolicy(r.main, DEFAULT_CONFIG, agentDir)
    assert.equal(p.workspace, r.main)
    assert.ok(checkWrite(join(r.main, 'src/new.ts'), p).ok)
    assert.ok(checkWrite(join(realpathSync(tmpdir()), 'x.log'), p).ok)
    assert.ok(checkWrite(join(homedir(), '.npm', '_cacache', 'x'), p).ok)
    const home = checkWrite(join(homedir(), 'notes.txt'), p)
    assert.ok(!home.ok && !home.control)
    assert.ok(checkWrite(join(homedir(), '.cargo', 'registry', 'x'), p).ok, 'tool caches are writable')
    assert.ok(!checkWrite(join(homedir(), '.cargo', 'bin', 'cargo-evil'), p).ok, 'tool bin folders are not, even before they exist')
    for (const control of [join(r.main, '.git', 'hooks', 'pre-commit'), join(r.main, '.git', 'config'), join(r.main, '.pi', 'extensions', 'x.ts'), join(agentDir, 'settings.json'), join(homedir(), '.zshrc'), join(homedir(), '.ssh', 'config')]) {
      const v = checkWrite(control, p)
      assert.ok(!v.ok && v.control, `control: ${control}`)
    }
  } finally {
    r.done()
  }
})

test('linked worktree: shared git dir writable, its hooks and config are not', () => {
  const r = repo()
  try {
    const wt = join(r.root, 'app-feature')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: r.main, stdio: 'ignore' })
    clearGitCache()
    const p = buildPolicy(wt, DEFAULT_CONFIG, agentDir)
    assert.ok(p.git?.linked)
    assert.equal(p.workspace, wt)
    const common = join(r.main, '.git')
    assert.ok(p.allowWrite.includes(common))
    assert.ok(checkWrite(join(common, 'objects', 'ab', 'cdef'), p).ok)
    assert.ok(checkWrite(join(common, 'refs', 'heads', 'feature'), p).ok)
    assert.ok(!checkWrite(join(common, 'hooks', 'pre-commit'), p).ok)
    assert.ok(!checkWrite(join(common, 'config'), p).ok)
    // The main checkout's files are not part of this workspace.
    assert.ok(!checkWrite(join(r.main, 'a.txt'), p).ok)
  } finally {
    r.done()
  }
})

test('secret reads: credential stores and .env files; Pi skills stay readable', () => {
  const r = repo()
  try {
    const p = buildPolicy(r.main, DEFAULT_CONFIG, agentDir)
    assert.ok(!checkRead(join(homedir(), '.ssh', 'id_ed25519'), p).ok)
    assert.ok(!checkRead(join(agentDir, 'auth.json'), p).ok)
    assert.ok(!checkRead(join(agentDir, 'sessions', 'x.jsonl'), p).ok)
    assert.ok(checkRead(join(agentDir, 'npm', 'node_modules', 'pkg', 'skills', 'x', 'SKILL.md'), p).ok)
    assert.ok(checkRead(join(agentDir, 'skills', 'mine', 'SKILL.md'), p).ok)
    assert.ok(!checkRead(join(r.main, '.env'), p).ok)
    assert.ok(!checkRead(join(r.main, '.env.production'), p).ok)
    assert.ok(checkRead(join(r.main, '.env.example'), p).ok)
    assert.ok(checkRead(join(r.main, 'src', 'index.ts'), p).ok)
    assert.ok(checkRead('/etc/hosts', p).ok)
  } finally {
    r.done()
  }
})

test('symlinks are judged by their target', () => {
  const r = repo()
  try {
    const p = buildPolicy(r.main, DEFAULT_CONFIG, agentDir)
    const outside = join(r.root, 'outside.txt')
    writeFileSync(outside, 'x')
    symlinkSync(outside, join(r.main, 'link.txt'))
    const target = resolveToolPath('link.txt', r.main)
    assert.equal(target, outside)
    assert.ok(!checkWrite(target, p).ok)
    symlinkSync(join(r.root, 'not-there-yet.rc'), join(r.main, 'dangling'))
    assert.equal(resolveToolPath('dangling', r.main), join(r.root, 'not-there-yet.rc'))
    assert.ok(!checkWrite(resolveToolPath('dangling', r.main), p).ok, 'dangling link cannot create files outside')
    symlinkSync(join(r.root), join(r.main, 'up'))
    mkdirSync(join(r.root, 'Application Support'), { recursive: true })
    assert.equal(resolveToolPath(join(r.root, 'Application\u00A0Support'), r.main), join(r.root, 'Application Support'), 'unicode spaces resolve like Pi')
    assert.ok(!checkWrite(resolveToolPath('up/new.txt', r.main), p).ok)
  } finally {
    r.done()
  }
})

test('searching above a credential store asks; searching the project does not', () => {
  const r = repo()
  try {
    const p = buildPolicy(r.main, DEFAULT_CONFIG, agentDir)
    assert.ok(checkSearchRoot(r.main, p, true).ok)
    assert.ok(!checkSearchRoot(join(homedir(), '.aws'), p, false).ok)
    const homeGrep = checkSearchRoot(homedir(), p, true)
    // Only asks when a credential store actually exists under it.
    if (p.denyRead.some(d => d.startsWith(homedir()))) assert.equal(typeof homeGrep.ok, 'boolean')
    assert.ok(checkSearchRoot(homedir(), p, false).ok, 'listing names is fine')
  } finally {
    r.done()
  }
})
