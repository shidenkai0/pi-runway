import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import { buildPolicy } from '../../src/policy.ts'
import { guardedGrep, guardedSearchTools } from '../../src/search.ts'

// Runway's grep/find/ls: useful search, and never a line of a secrets file.

const CANARY = 'CANARY-SEARCH-51d0'
const base = join(import.meta.dirname, '..', '..', '.e2e')
mkdirSync(base, { recursive: true })
const root = realpathSync(mkdtempSync(join(base, 'search-')))
after(() => rmSync(root, { recursive: true, force: true }))
const project = join(root, 'app')
const store = join(root, 'vault')
mkdirSync(join(project, 'src'), { recursive: true })
mkdirSync(join(project, 'keys'))
mkdirSync(store)
writeFileSync(join(project, 'src', 'config.ts'), 'line one\nexport const token = process.env.API_TOKEN\nline three\n')
writeFileSync(join(project, '.env'), `API_TOKEN=${CANARY}\n`)
writeFileSync(join(project, '.env.local'), `API_TOKEN=${CANARY}\n`)
writeFileSync(join(project, '.env.example'), 'API_TOKEN=put-yours-here\n')
writeFileSync(join(project, 'keys', 'id_ed25519'), `API_TOKEN ${CANARY}\n`)
writeFileSync(join(store, 'notes'), `API_TOKEN ${CANARY}\n`)
symlinkSync(join(project, '.env'), join(project, 'innocent.txt'))
const policy = buildPolicy(project, { ...DEFAULT_CONFIG, denyRead: [store] }, join(homedir(), '.pi', 'agent'))

const text = (r: { content: { text: string }[] }) => r.content.map(c => c.text).join('\n')

test('grep finds code and skips secrets files without showing a byte of them', async () => {
  const r = await guardedGrep({ pattern: 'API_TOKEN', path: '.' }, project, policy)
  const out = text(r)
  assert.match(out, /src\/config\.ts:2: export const token = process\.env\.API_TOKEN/)
  assert.match(out, /\.env\.example:1: API_TOKEN=put-yours-here/, 'templates are not secrets')
  assert.match(out, /Runway does not search files that hold secrets/)
  assert.ok(!out.includes(CANARY))
  assert.doesNotMatch(out, /^\.env:|^\.env\.local:|id_ed25519:|innocent\.txt:/m)
})

test('no oracle: a secret\'s right and wrong prefixes give identical results, globs can\'t reach secrets files', async () => {
  for (const [right, wrong] of [[CANARY, `${CANARY}-x`], ['CANARY-SEARCH-5', 'CANARY-SEARCH-6'], ['^API_TOKEN=CANARY', '^API_TOKEN=WRONG']]) {
    const a = await guardedGrep({ pattern: right, path: '.' }, project, policy)
    const b = await guardedGrep({ pattern: wrong, path: '.' }, project, policy)
    assert.deepEqual(a, b, `${right} vs ${wrong}`)
  }
  for (const glob of ['.env', '.env*', '**/id_ed25519', '*']) {
    const out = text(await guardedGrep({ pattern: 'API_TOKEN', path: '.', glob }, project, policy))
    assert.ok(!out.includes(CANARY), glob)
    assert.doesNotMatch(out, /^\.env:|^\.env\.local:|id_ed25519:/m, glob)
  }
  const withContext = text(await guardedGrep({ pattern: 'export', path: '.', context: 5 }, project, policy))
  assert.ok(!withContext.includes(CANARY))
})

test('context lines, globs and case-insensitive search behave like Pi grep', async () => {
  const withContext = text(await guardedGrep({ pattern: 'api_token', path: '.', ignoreCase: true, context: 1, glob: '*.ts' }, project, policy))
  assert.match(withContext, /src\/config\.ts-1- line one\nsrc\/config\.ts:2: export const token/)
  assert.match(withContext, /src\/config\.ts-3- line three/)
  assert.ok(!withContext.includes(CANARY))
  assert.match(text(await guardedGrep({ pattern: 'nothing-like-this', path: '.' }, project, policy)), /^No matches found\n\n\[Runway does not search files that hold secrets/)
  assert.equal(text(await guardedGrep({ pattern: 'nothing-like-this', path: 'src' }, project, policy)), 'No matches found', 'no notice where there are no secrets files')
})

test('a search rooted at a secrets file or inside a credential store is refused; above one, its files are skipped', async () => {
  await assert.rejects(guardedGrep({ pattern: 'API', path: '.env' }, project, policy), /holds secrets/)
  await assert.rejects(guardedGrep({ pattern: 'API', path: store }, project, policy), /holds secrets/)
  const above = text(await guardedGrep({ pattern: 'API_TOKEN', path: root }, project, policy))
  assert.match(above, /app\/src\/config\.ts:2:/)
  assert.ok(!above.includes(CANARY))
})

test('ls never lists inside a credential store', async () => {
  const ls = guardedSearchTools(() => policy).find(t => t.name === 'ls')!
  assert.equal(ls.defaultActive, false, 'off unless the user enables it, like Pi’s own')
  await assert.rejects(ls.execute('x', { path: store } as never, undefined, undefined, { cwd: project } as never), /credential store/)
  const listed = await ls.execute('x', { path: root } as never, undefined, undefined, { cwd: project } as never)
  assert.match(text(listed as never), /app\//)
})
