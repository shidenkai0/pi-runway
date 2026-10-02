// Workflow matrix: how often does everyday developer work need to leave the
// sandbox? Runs real tool commands (real registries, free) through Runway's
// sandboxed bash operations, in a throwaway HOME. No model, no reviewer.
//
//   node test/matrix/run.ts            # all workflows available on this machine
//   node test/matrix/run.ts npm cargo  # a subset
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const realHome = homedir()
const root = resolve(import.meta.dirname, '..', '..', '.e2e')
mkdirSync(root, { recursive: true })
const base = realpathSync(mkdtempSync(join(root, 'matrix-')))
const fakeHome = join(base, 'home')
mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true })
// A real macOS home always has these; tools expect to create caches inside them.
if (process.platform === 'darwin') mkdirSync(join(fakeHome, 'Library', 'Caches'), { recursive: true })
process.env.HOME = fakeHome
process.env.RUSTUP_HOME = process.env.RUSTUP_HOME ?? join(realHome, '.rustup')
process.env.HOMEBREW_NO_AUTO_UPDATE = '1'
process.env.PATH = [join(realHome, '.cargo', 'bin'), join(realHome, '.bun', 'bin'), join(realHome, '.deno', 'bin'), process.env.PATH].join(':')

const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
const { Runtime } = await import('../../src/runtime.ts')
const { buildPolicy, clearGitCache } = await import('../../src/policy.ts')
const { DEFAULT_CONFIG } = await import('../../src/config.ts')
const { sandboxedOperations } = await import('../../src/bash.ts')

interface Workflow {
  name: string
  needs: string
  command: string
  /** Expected to need an escalation (documented limitation), not a smoothness failure. */
  expectEscalation?: boolean
}

const WORKFLOWS: Workflow[] = [
  { name: 'npm install + run', needs: 'npm', command: 'npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7 2>&1 | tail -1 && node -e "console.log(require(\'is-number\')(5))"' },
  { name: 'npm test (node --test)', needs: 'node', command: "printf \"const t=require('node:test');t('x',()=>{})\" > a.test.cjs && node --test a.test.cjs 2>&1 | grep -E 'pass [0-9]'" },
  { name: 'npx one-off tool', needs: 'npx', command: 'npx --yes cowsay@1.6.0 hi | tail -2' },
  { name: 'npx typescript', needs: 'npx', command: 'npx --yes -p typescript@5.9.3 tsc --version' },
  { name: 'pnpm add', needs: 'pnpm', command: 'printf "{\\"name\\":\\"x\\",\\"version\\":\\"1.0.0\\"}" > package.json && pnpm add is-number@7 2>&1 | tail -2 && node -e "require(\'is-number\')"' },
  { name: 'yarn add', needs: 'yarn', command: 'yarn init -y >/dev/null && yarn add is-number@7 2>&1 | tail -1' },
  { name: 'bun add', needs: 'bun', command: 'bun init -y >/dev/null 2>&1; bun add is-number@7 2>&1 | tail -1' },
  { name: 'python venv + pip', needs: 'python3', command: 'python3 -m venv .venv && .venv/bin/pip install -q --disable-pip-version-check six && .venv/bin/python -c "import six; print(six.__name__)"' },
  { name: 'uv project', needs: 'uv', command: 'uv init -q --no-workspace --name demo . && uv add -q six && uv run -q python -c "import six; print(six.__name__)"' },
  { name: 'cargo build with a crate', needs: 'cargo', command: 'cargo init -q --name hello && cargo add -q itoa@1 && cargo build -q && ./target/debug/hello' },
  { name: 'deno', needs: 'deno', command: 'deno eval "console.log(40 + 2)"' },
  { name: 'deno jsr import', needs: 'deno', command: 'deno eval "import { toCamelCase } from \'jsr:@std/text@1\'; console.log(toCamelCase(\'a-b\'))"' },
  { name: 'swiftc build', needs: 'swiftc', command: 'echo \'print("hi")\' > m.swift && swiftc m.swift -o m 2>&1 | tail -2 && ./m' },
  { name: 'C with make', needs: 'make', command: "printf 'int main(){return 0;}' > a.c && make -s a && ./a && echo built" },
  { name: 'git clone over https', needs: 'git', command: 'git clone -q --depth 1 https://github.com/octocat/Hello-World.git hw && ls hw' },
  { name: 'git local workflow', needs: 'git', command: 'git init -q -b main && echo a > a && git add a && git -c user.email=t@e -c user.name=t commit -qm a && git checkout -qb f && echo b >> a && git -c user.email=t@e -c user.name=t commit -qam b && git checkout -q main && git merge -q f && git log --oneline | wc -l' },
  { name: 'local dev server + curl', needs: 'python3', command: 'python3 -m http.server 18765 >/dev/null 2>&1 & sleep 1; curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:18765/; kill %1' },
  { name: 'node server + fetch', needs: 'node', command: "node -e \"const s=require('http').createServer((q,r)=>r.end('ok')).listen(18766,async()=>{const t=await (await fetch('http://localhost:18766')).text();console.log(t);s.close()})\"" },
  { name: 'playwright cli', needs: 'npx', command: 'npx --yes playwright@1.56.0 --version' },
  { name: 'gh api (needs login)', needs: 'gh', command: 'gh api repos/cli/cli --jq .name', expectEscalation: true },
  { name: 'docker ps (host socket)', needs: 'docker', command: 'docker ps', expectEscalation: true },
  { name: 'git clone into project', needs: 'git', command: 'git init -q -b main && git clone -q --depth 1 https://github.com/octocat/Hello-World.git vendor/hw && ls vendor/hw && git status --short | head -3' },
  { name: 'unknown host', needs: 'curl', command: 'curl -sS -m 5 -o /dev/null https://example.com/ 2>&1', expectEscalation: true },
]

function has(tool: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${tool}`], { stdio: 'ignore', env: process.env })
    return true
  } catch {
    return false
  }
}

const only = process.argv.slice(2)
const selected = WORKFLOWS.filter(w => (only.length === 0 || only.some(o => w.name.includes(o) || w.needs === o)) && has(w.needs))
const skipped = WORKFLOWS.filter(w => !selected.includes(w) && (only.length === 0 || only.some(o => w.name.includes(o) || w.needs === o)))

const rt = new Runtime(SandboxManager)
rt.agentDir = join(fakeHome, '.pi', 'agent')
const asked: string[] = []
rt.networkAsk = async (host, port) => {
  asked.push(`${host}:${port}`)
  return false
}
const firstDir = join(fakeHome, 'work', 'first')
mkdirSync(firstDir, { recursive: true })
await rt.ensureSandbox(DEFAULT_CONFIG, buildPolicy(firstDir, DEFAULT_CONFIG, rt.agentDir))
if (!rt.sandboxReady()) throw new Error(`sandbox did not start: ${rt.sandboxError}`)

const fakeCtx = { sessionManager: { getSessionId: () => 'matrix' } } as never
const rows: { name: string; result: string; ms: number; detail: string }[] = []
for (const [i, w] of selected.entries()) {
  const dir = join(fakeHome, 'work', `w${i}`)
  mkdirSync(dir, { recursive: true })
  clearGitCache()
  const before = asked.length
  const ops = sandboxedOperations(rt, `m${i}`, fakeCtx, cwd => buildPolicy(cwd, DEFAULT_CONFIG, rt.agentDir), [])
  let out = ''
  const started = Date.now()
  let code: number | null = null
  try {
    const r = await ops.exec(`set -o pipefail; ${w.command}`, dir, { onData: d => (out += d.toString()), timeout: 240, env: process.env })
    code = r.exitCode
  } catch (error) {
    out += `\n${error instanceof Error ? error.message : String(error)}`
  }
  const ms = Date.now() - started
  const blocked = /<sandbox_violations>/.test(out) || asked.length > before || (w.expectEscalation === true && code !== 0)
  const result = code === 0 && !/<sandbox_violations>/.test(out) ? 'ok' : blocked ? (w.expectEscalation ? 'escalates (expected)' : 'BLOCKED') : 'failed'
  const hosts = asked.slice(before)
  const violations = (out.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/)?.[1] ?? '').trim().split('\n').filter(Boolean).slice(0, 3)
  const detail = [hosts.length ? `hosts: ${[...new Set(hosts)].join(', ')}` : '', ...violations.map(v => v.replace(fakeHome, '~').slice(0, 140)), result === 'failed' ? out.trim().split('\n').slice(-2).join(' | ').slice(0, 200) : ''].filter(Boolean).join(' ; ')
  rows.push({ name: w.name, result, ms, detail })
  console.log(`${result.padEnd(22)} ${String(ms).padStart(6)} ms  ${w.name}${detail ? `\n${' '.repeat(33)}${detail}` : ''}`)
}
await rt.sandbox.reset()
const routine = rows.filter(r => !WORKFLOWS.find(w => w.name === r.name)?.expectEscalation)
const smooth = routine.filter(r => r.result === 'ok').length
console.log(`\nroutine workflows without escalation: ${smooth}/${routine.length}`)
if (skipped.length) console.log(`skipped (tool not installed): ${skipped.map(s => s.name).join(', ')}`)
if (!process.env.KEEP) rmSync(base, { recursive: true, force: true })
