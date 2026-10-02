import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'
// @ts-expect-error plain JS module without types
import { canonical, MARKER, prepareTrial, refusal, shellQuote } from '../../scripts/try-local.mjs'

// All fixtures live under .e2e/ in this checkout. Nothing here touches the real
// home folder, the filesystem root or any real repository: "home" is a fixture.

const repo = realpathSync(join(import.meta.dirname, '..', '..'))
const script = join(repo, 'scripts', 'try-local.mjs')
mkdirSync(join(repo, '.e2e'), { recursive: true })
const base = realpathSync(mkdtempSync(join(repo, '.e2e', 'try-local-')))
const fakeHome = join(base, 'home')
mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true })
writeFileSync(join(fakeHome, '.pi', 'agent', 'settings.json'), '{"packages":["npm:something"]}\n')
writeFileSync(join(fakeHome, 'notes.txt'), 'keep me\n')
after(() => rmSync(base, { recursive: true, force: true }))

/** Every path, type, link target and file hash under a folder (links are not followed). */
function snapshot(root: string): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const st = lstatSync(p)
      const rel = relative(root, p)
      if (st.isSymbolicLink()) out.push(`L ${rel} -> ${readlinkSync(p)}`)
      else if (st.isDirectory()) {
        out.push(`D ${rel}`)
        walk(p)
      } else out.push(`F ${rel} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
    }
  }
  walk(root)
  return out.join('\n')
}

function cli(args: string[], cwd = base) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' })
}

const opts = { repo, home: fakeHome, installDeps: false }

test('a fresh folder with spaces and quotes becomes a trial that loads only this checkout', () => {
  const target = join(base, `it's a "trial" folder`)
  const r = prepareTrial(target, opts)
  assert.equal(r.ok, true, r.reason)
  assert.deepEqual(readdirSync(target).sort(), [MARKER, 'agent', 'project'].sort())
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'agent', 'settings.json'), 'utf8')), { packages: [repo] })
  assert.match(execFileSync('git', ['log', '--oneline'], { cwd: join(target, 'project'), encoding: 'utf8' }), /trial project/)
  // The printed command survives a real shell, quotes and all.
  const quoted = shellQuote(target)
  assert.equal(execFileSync('bash', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' }), target)
})

test('re-running reuses the trial: settings reset to only Runway, the project is never touched', () => {
  const target = join(base, 'reuse')
  assert.equal(prepareTrial(target, opts).ok, true)
  const settingsPath = join(target, 'agent', 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ packages: ['npm:other', repo], defaultProvider: 'x' }))
  writeFileSync(join(target, 'project', 'work.txt'), 'user work\n')
  const projectBefore = snapshot(join(target, 'project'))
  const again = prepareTrial(target, opts)
  assert.equal(again.ok, true, again.reason)
  assert.equal(again.created, false)
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { packages: [repo], defaultProvider: 'x' })
  assert.equal(snapshot(join(target, 'project')), projectBefore)
})

test('existing unrelated content is refused and left untouched', () => {
  const plain = join(base, 'someone-elses-folder')
  mkdirSync(plain)
  writeFileSync(join(plain, 'README.md'), 'original readme\n')
  writeFileSync(join(plain, 'index.js'), 'original()\n')
  writeFileSync(join(plain, 'secret-notes.txt'), 'private\n')
  const repoDir = join(base, 'a-user-repo')
  mkdirSync(repoDir)
  writeFileSync(join(repoDir, 'app.js'), 'x\n')
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  for (const dir of [plain, repoDir]) {
    const before = snapshot(dir)
    const r = prepareTrial(dir, opts)
    assert.equal(r.ok, false)
    assert.match(r.reason, /content that this script did not create/)
    assert.equal(snapshot(dir), before)
    const c = cli([dir])
    assert.equal(c.status, 1)
    assert.match(c.stderr, /Not creating a trial/)
    assert.equal(snapshot(dir), before)
  }
})

test('home, its parents and its Pi folder are refused under every spelling, without changes', () => {
  const before = snapshot(fakeHome)
  const link = join(base, 'link-to-home')
  symlinkSync(fakeHome, link)
  const spellings = [fakeHome, link, `${fakeHome}/.`, join(fakeHome, 'sub', '..'), base, join(fakeHome, '.pi', 'agent'), join(fakeHome, '.pi', 'agent', 'trial')]
  for (const spelling of spellings) {
    const r = prepareTrial(spelling, { ...opts, repo })
    assert.equal(r.ok, false, `accepted ${spelling}`)
    const c = cli([spelling])
    assert.equal(c.status, 1, `cli accepted ${spelling}`)
  }
  // Relative spellings resolve against the folder the command is run from.
  for (const spelling of ['home', './home/', 'link-to-home', 'home/.pi']) {
    const c = cli([spelling], base)
    assert.equal(c.status, 1, `cli accepted relative ${spelling}`)
  }
  assert.equal(snapshot(fakeHome), before)
  assert.ok(!readdirSync(base).includes(MARKER))
})

test('the system temp folder is refused even behind a symlink, without changes', () => {
  const inTemp = realpathSync(mkdtempSync(join(tmpdir(), 'runway-trial-test-')))
  try {
    const link = join(base, 'looks-local')
    symlinkSync(inTemp, link)
    assert.equal(canonical(link), inTemp)
    for (const spelling of [inTemp, link, join(link, 'new-trial')]) {
      const r = prepareTrial(spelling, opts)
      assert.equal(r.ok, false, `accepted ${spelling}`)
      assert.match(r.reason, /temp folder/)
    }
    assert.deepEqual(readdirSync(inTemp), [])
  } finally {
    rmSync(inTemp, { recursive: true, force: true })
  }
})

test('pure checks: filesystem root, top-level folders and this checkout are refused', () => {
  // Evaluated as strings only; nothing is created or read under these paths.
  for (const path of ['/', '/Users', '/home', '/opt', '/etc']) assert.ok(refusal(path, { home: fakeHome, repo }), path)
  assert.ok(refusal(repo, { home: fakeHome, repo }))
  assert.ok(refusal(join(repo, '..'), { home: fakeHome, repo }))
  assert.equal(refusal(join(base, 'fine'), { home: fakeHome, repo }), undefined)
})

test('a forged or tampered marker folder is refused, and nothing is written through symlinks', () => {
  const forged = join(base, 'forged')
  mkdirSync(forged)
  writeFileSync(join(forged, MARKER), '{}')
  writeFileSync(join(forged, 'important.txt'), 'x')
  let before = snapshot(forged)
  assert.equal(prepareTrial(forged, opts).ok, false)
  assert.equal(snapshot(forged), before)

  const victim = join(base, 'victim')
  mkdirSync(victim)
  writeFileSync(join(victim, 'settings.json'), '{"packages":["npm:mine"]}')
  const tampered = join(base, 'tampered')
  mkdirSync(tampered)
  writeFileSync(join(tampered, MARKER), '{}')
  symlinkSync(victim, join(tampered, 'agent'))
  before = snapshot(victim)
  const r = prepareTrial(tampered, opts)
  assert.equal(r.ok, false)
  assert.match(r.reason, /symbolic link/)
  assert.equal(snapshot(victim), before)
})

test('an empty folder is accepted; a missing parent is refused without creating it', () => {
  const empty = join(base, 'empty')
  mkdirSync(empty)
  assert.equal(prepareTrial(empty, opts).ok, true)
  const deep = join(base, 'missing-parent', 'trial')
  const r = prepareTrial(deep, opts)
  assert.equal(r.ok, false)
  assert.ok(!readdirSync(base).includes('missing-parent'))
})

test('cli prints a paste-safe start command and no recursive delete', () => {
  const target = join(base, "cli trial's")
  const c = cli([target])
  assert.equal(c.status, 0, c.stderr)
  assert.ok(c.stdout.includes(`cd ${shellQuote(join(target, 'project'))} && PI_CODING_AGENT_DIR=${shellQuote(join(target, 'agent'))} pi`))
  assert.doesNotMatch(c.stdout, /rm -rf/)
})
