import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'

// End-to-end harness: the real installed `pi`, a scripted fake model
// provider, a fake Jev endpoint, and a throwaway HOME with canary secrets.
// No real credentials, no paid calls.

export const PACKAGE_ROOT = resolve(import.meta.dirname, '..', '..')
/** The Pi under test: the package's own dev dependency (Pi 1.x), never the global install. Override with PI_BIN. */
export const PI_BIN = process.env.PI_BIN || join(PACKAGE_ROOT, 'node_modules', '.bin', 'pi')
export const SECRET_CANARY = 'CANARY-SECRET-7f3a91'
export const ENV_CANARY = 'CANARY-ENV-4b2c88'
/**
 * How a sandboxed read of a credential path fails: Seatbelt refuses it
 * ("Operation not permitted"); bubblewrap hides it, so it doesn't exist.
 */
export const READ_BLOCKED = process.platform === 'linux' ? /No such file or directory|Permission denied|Operation not permitted/ : /Operation not permitted/

export type Reply = { text: string } | { tool: string; args: Record<string, unknown> } | { tools: { tool: string; args: Record<string, unknown> }[] }

export interface ChatRequest {
  model: string
  messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] }[]
  tools?: { function: { name: string; parameters: unknown } }[]
}

/** Given the request (whole conversation so far), return the next reply. */
export type Script = (req: ChatRequest, turn: number) => Reply

export interface JevAnswerSpec {
  allow?: boolean
  /** Probabilities for specific questions (0..1). */
  nouls?: Record<string, number>
  risk?: number
  authorization?: number
  status?: number
  delayMs?: number
}

export type JevScript = (body: { action: Record<string, unknown>; transcript: unknown[] }, n: number) => JevAnswerSpec

export function jevAnswers(spec: JevAnswerSpec): Record<string, unknown> {
  const allow = spec.allow !== false
  const nouls: Record<string, number> = {
    sensitive_egress: allow ? 0.05 : 0.9,
    destructive: 0.05,
    credential_probing: 0.05,
    security_weakening: 0.05,
    discloses_secret_to_context: 0.05,
    user_prohibited: 0.05,
    untrusted_instructed: 0.05,
    task_related: 0.95,
    narrowly_scoped: 0.9,
    ...spec.nouls,
  }
  const answers: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nouls)) answers[k] = { noul: v }
  answers.risk = { score: spec.risk ?? (allow ? 0.2 : 2.0), probabilities: {} }
  answers.authorization = { score: spec.authorization ?? (allow ? 2.2 : 0.2), probabilities: {} }
  return answers
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(res => {
    let data = ''
    req.on('data', c => (data += c))
    req.on('end', () => res(data))
  })
}

function sse(res: ServerResponse, reply: Reply, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model }
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  if ('text' in reply) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  } else {
    const calls = 'tools' in reply ? reply.tools : [reply]
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] })
    calls.forEach((call, index) => {
      send({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${Date.now()}_${index}`, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }],
      })
    })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

export interface FakeServer {
  url: string
  requests: ChatRequest[]
  jevRequests: { action: Record<string, unknown>; transcript: unknown[] }[]
  setScript(script: Script): void
  setJev(script: JevScript): void
  close(): Promise<void>
}

export async function startFakeServer(): Promise<FakeServer> {
  let script: Script = () => ({ text: 'done' })
  let jev: JevScript = () => ({ allow: true })
  const requests: ChatRequest[] = []
  const jevRequests: FakeServer['jevRequests'] = []
  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req)
    if (req.url?.endsWith('/chat/completions')) {
      const parsed = JSON.parse(body) as ChatRequest
      requests.push(parsed)
      const turn = parsed.messages.filter(m => m.role === 'assistant').length
      let reply: Reply
      try {
        reply = script(parsed, turn)
      } catch (error) {
        reply = { text: `script error: ${error instanceof Error ? error.message : String(error)}` }
      }
      sse(res, reply, parsed.model)
      return
    }
    if (req.url?.includes('decisions')) {
      const parsed = JSON.parse(body) as { state: { action: Record<string, unknown>; transcript: unknown[] } }
      jevRequests.push(parsed.state)
      const spec = jev(parsed.state, jevRequests.length)
      if (spec.delayMs) await new Promise(r => setTimeout(r, spec.delayMs))
      if (spec.status && spec.status !== 200) {
        res.writeHead(spec.status).end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: 'typesafe/jev-fake', answers: jevAnswers(spec) }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    jevRequests,
    setScript: s => (script = s),
    setJev: s => (jev = s),
    close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

export interface Home {
  root: string
  home: string
  agentDir: string
  project: string
  env: NodeJS.ProcessEnv
  piArgs: string[]
  cleanup(): void
}

export interface HomeOptions {
  runwayConfig?: Record<string, unknown>
  reviewerKey?: boolean
  extraPackages?: string[]
  models?: string[]
  git?: boolean
  /** Extra Pi command-line arguments, e.g. ['--tools', 'read,bash,grep']. */
  piArgs?: string[]
}

export function makeHome(server: FakeServer, options: HomeOptions = {}): Home {
  // Not under the system temp folder: that is writable from the sandbox by design,
  // so a fake HOME there would make "outside the project" writes look allowed.
  mkdirSync(join(PACKAGE_ROOT, '.e2e'), { recursive: true })
  const root = realpathSync(mkdtempSync(join(PACKAGE_ROOT, '.e2e', 'run-')))
  const home = join(root, 'home')
  const agentDir = join(home, '.pi', 'agent')
  const project = join(home, 'code', 'app')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'id_ed25519'), `-----BEGIN OPENSSH PRIVATE KEY-----\n${SECRET_CANARY}\n-----END OPENSSH PRIVATE KEY-----\n`)
  mkdirSync(join(home, '.aws'), { recursive: true })
  writeFileSync(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${SECRET_CANARY}\n`)
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ fake: { type: 'api_key', key: 'fake-provider-key' } }))
  const models = options.models ?? ['fake-model']
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({ providers: { fake: { baseUrl: `${server.url}/v1`, api: 'openai-completions', apiKey: 'fake-provider-key', models: models.map(id => ({ id, contextWindow: 128000, maxTokens: 4096 })) } } }),
  )
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'fake',
      defaultModel: models[0],
      packages: [PACKAGE_ROOT, ...(options.extraPackages ?? [])],
      enableInstallTelemetry: false,
      defaultProjectTrust: 'always',
    }),
  )
  if (options.runwayConfig) writeFileSync(join(agentDir, 'runway.json'), JSON.stringify(options.runwayConfig))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: 'node --test' } }))
  writeFileSync(join(project, 'index.js'), 'module.exports = 42\n')
  writeFileSync(join(project, '.env'), `API_TOKEN=${SECRET_CANARY}\n`)
  if (options.git !== false) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project })
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd: project })
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: project })
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER,
    SHELL: '/bin/bash',
    TERM: 'dumb',
    LANG: 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    RUNWAY_TEST_API_TOKEN: ENV_CANARY,
    PI_RUNWAY_REVIEWER_URL: `${server.url}/api/alpha/decisions`,
  }
  if (options.reviewerKey !== false) env.OPENROUTER_API_KEY = 'sk-or-fake-reviewer-key-000000000000'
  return { root, home, agentDir, project, env, piArgs: options.piArgs ?? [], cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export interface PiEvent {
  type: string
  [key: string]: unknown
}

export interface RunResult {
  events: PiEvent[]
  toolResults: { toolName: string; isError: boolean; text: string; args?: unknown }[]
  uiRequests: PiEvent[]
  stderr: string
  exitCode: number | null
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content
  if (Array.isArray(content)) return content.map(c => c.text ?? '').join('')
  return typeof result === 'string' ? result : JSON.stringify(result ?? '')
}

export type UiHandler = (req: PiEvent) => Record<string, unknown> | undefined

/** Drive `pi --mode rpc`: send prompts, answer dialogs, collect events until Pi settles. */
/** A prompt, a slash command, or a raw RPC command such as { type: 'new_session' }. */
export type RpcStep = string | { rpc: Record<string, unknown> } | ((events: PiEvent[]) => string | { rpc: Record<string, unknown> })

export async function runRpc(h: Home, prompts: RpcStep[], onUi: UiHandler = () => ({ cancelled: true }), timeoutMs = 60_000): Promise<RunResult> {
  const child = spawn(PI_BIN, [...h.piArgs, '--mode', 'rpc'], { cwd: h.project, env: h.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const events: PiEvent[] = []
  const uiRequests: PiEvent[] = []
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  let buffer = ''
  let settledCount = 0
  let resolveSettled: (() => void) | undefined
  const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`)
  child.stdout.on('data', chunk => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let event: PiEvent
      try {
        event = JSON.parse(line) as PiEvent
      } catch {
        continue
      }
      events.push(event)
      if (event.type === 'extension_ui_request') {
        uiRequests.push(event)
        if (['select', 'confirm', 'input', 'editor'].includes(String(event.method))) {
          const answer = onUi(event) ?? { cancelled: true }
          send({ type: 'extension_ui_response', id: event.id, ...answer })
        }
      }
      if (event.type === 'agent_settled' || (event.type === 'response' && event.command === 'prompt' && event.success === false)) {
        settledCount += 1
        resolveSettled?.()
      }
      // Slash commands answer the prompt without starting an agent run.
      if (event.type === 'response' && event.success !== false && String(event.id ?? '').startsWith('cmd')) {
        settledCount += 1
        resolveSettled?.()
      }
    }
  })
  const waitSettled = (n: number) =>
    new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`pi did not settle in ${timeoutMs} ms\n${stderr}\n${JSON.stringify(events.slice(-5))}`)), timeoutMs)
      const check = () => {
        if (settledCount >= n) {
          clearTimeout(timer)
          res()
        }
      }
      resolveSettled = check
      check()
    })
  try {
    for (let i = 0; i < prompts.length; i += 1) {
      const raw = prompts[i]!
      const step = typeof raw === 'function' ? raw(events) : raw
      if (typeof step !== 'string') {
        send({ id: `cmd${i}`, ...step.rpc })
        await waitSettled(i + 1)
        await new Promise(r => setTimeout(r, 300))
        continue
      }
      const isCommand = step.startsWith('/')
      send({ id: `${isCommand ? 'cmd' : 'p'}${i}`, type: 'prompt', message: step })
      await waitSettled(i + 1)
      // Give fire-and-forget UI (notify) from a command a moment to arrive.
      if (isCommand) await new Promise(r => setTimeout(r, 300))
    }
  } finally {
    child.stdin.end()
    child.kill('SIGTERM')
  }
  const exitCode = await new Promise<number | null>(res => child.on('close', code => res(code)))
  const toolResults = events
    .filter(e => e.type === 'tool_execution_end')
    .map(e => ({ toolName: String(e.toolName), isError: Boolean(e.isError), text: textOf(e.result), args: e.args }))
  return { events, toolResults, uiRequests, stderr, exitCode }
}

/** Headless: `pi -p`, no UI at all. */
export async function runPrint(h: Home, prompt: string, timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; exitCode: number | null; events: PiEvent[]; toolResults: RunResult['toolResults'] }> {
  const child = spawn(PI_BIN, [...h.piArgs, '-p', '--mode', 'json', prompt], { cwd: h.project, env: h.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => (stdout += d))
  child.stderr.on('data', d => (stderr += d))
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const exitCode = await new Promise<number | null>(res => child.on('close', code => res(code)))
  clearTimeout(timer)
  const events = stdout.split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line) as PiEvent]
    } catch {
      return []
    }
  })
  const toolResults = events
    .filter(e => e.type === 'tool_execution_end')
    .map(e => ({ toolName: String(e.toolName), isError: Boolean(e.isError), text: textOf(e.result), args: e.args }))
  return { stdout, stderr, exitCode, events, toolResults }
}

/** Script helper: run these tool calls in order, one per turn, then say done. */
export function sequence(steps: Reply[]): Script {
  return (_req, turn) => steps[turn] ?? { text: 'done' }
}

/** Last tool result text seen by the model in this request. */
export function lastToolResult(req: ChatRequest): string {
  const tool = [...req.messages].reverse().find(m => m.role === 'tool')
  if (!tool) return ''
  return typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content)
}
