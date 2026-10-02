import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyProjectTightening, DEFAULT_CONFIG, loadConfig } from '../../src/config.ts'
import { isSecretEnvName, scrubEnv } from '../../src/env.ts'

test('scrubs credential-looking variables and values, keeps ordinary ones', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/Users/x', PWD: '/p', LANG: 'en', TERM: 'xterm', SSH_AUTH_SOCK: '/tmp/sock', NODE_ENV: 'test', AWS_REGION: 'eu-west-1',
    OPENROUTER_API_KEY: 'sk-or-v1-abc', ANTHROPIC_API_KEY: 'x', GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'x', AWS_ACCESS_KEY_ID: 'AKIA...',
    DATABASE_URL: 'postgres://u:p@h/db', STRIPE_SECRET: 'x', MY_SERVICE_PASSWORD: 'x', NPM_TOKEN: 'x', SESSION_COOKIE: 'x',
    SOME_VALUE: 'ghp_abcdefghijklmnopqrstuvwxyz', OTHER: 'https://user:pass@example.com/', ZAI_API_KEY: 'x', PI_SESSION_ID: 'abc',
    PGPASSWORD: 'x', MYSQL_PWD: 'x', SSHPASS: 'x', BW_SESSION: 'x', OP_SESSION_my: 'x', GPG_PASSPHRASE: 'x', FASTLANE_SESSION: 'x', CI_JOB_JWT: 'x',
    XDG_SESSION_TYPE: 'wayland', TERM_SESSION_ID: 'w0',
  }
  const { env: out, removed } = scrubEnv(env)
  for (const keep of ['PATH', 'HOME', 'PWD', 'LANG', 'TERM', 'SSH_AUTH_SOCK', 'NODE_ENV', 'AWS_REGION', 'PI_SESSION_ID', 'XDG_SESSION_TYPE', 'TERM_SESSION_ID']) assert.ok(keep in out, `kept ${keep}`)
  for (const gone of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'DATABASE_URL', 'STRIPE_SECRET', 'MY_SERVICE_PASSWORD', 'NPM_TOKEN', 'SESSION_COOKIE', 'SOME_VALUE', 'OTHER', 'ZAI_API_KEY', 'PGPASSWORD', 'MYSQL_PWD', 'SSHPASS', 'BW_SESSION', 'OP_SESSION_my', 'GPG_PASSPHRASE', 'FASTLANE_SESSION', 'CI_JOB_JWT']) {
    assert.ok(!(gone in out), `removed ${gone}`)
    assert.ok(removed.includes(gone))
  }
  assert.ok('NPM_TOKEN' in scrubEnv(env, ['NPM_TOKEN']).env, 'keepEnv wins')
  assert.equal(isSecretEnvName('KEYBOARD_LAYOUT'), false)
  assert.equal(isSecretEnvName('BYPASS_CACHE'), false)
})

function tempAgent(): { dir: string; agent: string; project: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'runway-cfg-'))
  const agent = join(dir, 'agent')
  const project = join(dir, 'project')
  mkdirSync(agent, { recursive: true })
  mkdirSync(join(project, '.pi'), { recursive: true })
  return { dir, agent, project, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('defaults need no file; bad settings are reported, not fatal', () => {
  const t = tempAgent()
  try {
    const none = loadConfig(t.project, { projectTrusted: true, env: { PI_CODING_AGENT_DIR: t.agent } })
    assert.deepEqual(none.problems, [])
    assert.equal(none.config.network, 'reviewed')
    assert.equal(none.config.onDeny, 'block')
    assert.equal(none.config.mode, undefined)
    writeFileSync(join(t.agent, 'runway.json'), JSON.stringify({ mode: 'yolo', network: 'open', allowHosts: 'x' }))
    const bad = loadConfig(t.project, { projectTrusted: true, env: { PI_CODING_AGENT_DIR: t.agent } })
    assert.equal(bad.config.network, 'open')
    assert.equal(bad.problems.length, 2)
    writeFileSync(join(t.agent, 'runway.json'), '{ nope')
    assert.equal(loadConfig(t.project, { projectTrusted: true, env: { PI_CODING_AGENT_DIR: t.agent } }).problems.length, 1)
  } finally {
    t.done()
  }
})

test('a project can tighten but never loosen', () => {
  const base = { ...DEFAULT_CONFIG, mode: 'auto' as const, network: 'reviewed' as const }
  const loosened = applyProjectTightening(base, { mode: 'off', network: 'open', onDeny: 'block', allowHosts: ['evil.test'], allowWrite: ['/'] })
  assert.equal(loosened.mode, 'auto')
  assert.equal(loosened.network, 'reviewed')
  assert.deepEqual(loosened.allowHosts, [])
  assert.deepEqual(loosened.allowWrite, [])
  const tightened = applyProjectTightening(base, { mode: 'ask', network: 'closed', onDeny: 'ask', denyRead: ['secrets/'] })
  assert.equal(tightened.mode, 'ask')
  assert.equal(tightened.network, 'closed')
  assert.equal(tightened.onDeny, 'ask')
  assert.deepEqual(tightened.denyRead, ['secrets/'])
})

test('untrusted project settings are ignored; env override applies', () => {
  const t = tempAgent()
  try {
    writeFileSync(join(t.project, '.pi', 'runway.json'), JSON.stringify({ network: 'closed' }))
    assert.equal(loadConfig(t.project, { projectTrusted: false, env: { PI_CODING_AGENT_DIR: t.agent } }).config.network, 'reviewed')
    assert.equal(loadConfig(t.project, { projectTrusted: true, env: { PI_CODING_AGENT_DIR: t.agent } }).config.network, 'closed')
    assert.equal(loadConfig(t.project, { projectTrusted: false, env: { PI_CODING_AGENT_DIR: t.agent, PI_RUNWAY_MODE: 'ask' } }).config.mode, 'ask')
  } finally {
    t.done()
  }
})
