import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { lastToolResult, makeHome, runPrint, runRpc, sequence, startFakeServer } from '../support/harness.ts'
import type { ChatRequest, FakeServer, Home } from '../support/harness.ts'

// MCP tools, tool_search and codemode through the real Pi 1.0 binary:
// every MCP call (direct, deferred, or nested inside a codemode script) goes
// through Runway's one gate; the wrappers themselves (codemode, tool_search)
// are allowed by identity and never reviewed; approved arguments are frozen.

const FAKE_MCP = join(import.meta.dirname, '..', 'support', 'fake-mcp-server.mjs')
const TIMEOUT = { timeout: 90_000 }

let server: FakeServer
before(async () => {
  server = await startFakeServer()
})
after(async () => {
  await server.close()
})

interface McpCall {
  tool: string
  args: Record<string, unknown>
}

interface McpSetup {
  exposure?: 'direct' | 'deferred' | 'codemode' | 'hidden'
  toolExposure?: Record<string, string>
}

/** Configure the fake stdio server as `fake` in ~/.pi/agent/mcp.json; returns its call log path. */
function addFakeMcp(h: Home, setup: McpSetup = {}): string {
  const log = join(h.root, 'mcp-calls.jsonl')
  writeFileSync(log, '')
  writeFileSync(
    join(h.agentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        fake: {
          command: process.execPath,
          args: [FAKE_MCP],
          env: { FAKE_MCP_LOG: log, FAKE_MCP_NAME: 'fake' },
          description: 'Fake test server: echo text, destroy targets, write notes',
          exposure: setup.exposure ?? 'direct',
          ...(setup.toolExposure ? { toolExposure: setup.toolExposure } : {}),
        },
      },
    }),
  )
  return log
}

function mcpCalls(log: string): McpCall[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as McpCall)
}

function patchSettings(h: Home, patch: (s: Record<string, unknown>) => void): void {
  const path = join(h.agentDir, 'settings.json')
  const settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  patch(settings)
  writeFileSync(path, JSON.stringify(settings))
}

const declared = (req: ChatRequest | undefined): string[] => (req?.tools ?? []).map(t => t.function.name)
const jevFor = (from: number, tool: string) => server.jevRequests.slice(from).filter(r => r.action.toolName === tool)

test('direct MCP tool: Jev reviews the real server, tool and arguments; the result reaches the model', TIMEOUT, async () => {
  const h = makeHome(server)
  const log = addFakeMcp(h, { exposure: 'direct' })
  try {
    const before = server.jevRequests.length
    const firstRequest = server.requests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([{ tool: 'mcp__fake__echo', args: { text: 'hello from the model' } }]))
    const r = await runRpc(h, ['echo something through the fake server'], () => {
      throw new Error('no dialog expected')
    })
    assert.ok(declared(server.requests[firstRequest]).includes('mcp__fake__echo'), `direct MCP tool is declared: ${declared(server.requests[firstRequest]).join(', ')}\n${r.stderr}`)
    const result = r.toolResults.find(t => t.toolName === 'mcp__fake__echo')
    assert.ok(result, JSON.stringify(r.toolResults))
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /echo: hello from the model/)

    const reviews = jevFor(before, 'mcp__fake__echo')
    assert.equal(reviews.length, 1, JSON.stringify(server.jevRequests.slice(before).map(j => j.action.toolName)))
    const action = reviews[0]!.action
    assert.equal(action.kind, 'mcp')
    assert.deepEqual(action.mcp, { server: 'fake', tool: 'echo', annotations: { readOnlyHint: true } })
    assert.deepEqual(action.input, { text: 'hello from the model' })
    assert.equal(action.calledFrom, undefined, 'a direct call is not marked as coming from a script')
    assert.match(String(action.execution), /fake server, outside the sandbox \(it says it only reads\)/)

    assert.deepEqual(mcpCalls(log), [{ tool: 'echo', args: { text: 'hello from the model' } }])
    const followUp = server.requests.slice(firstRequest).at(-1)!
    assert.match(lastToolResult(followUp), /echo: hello from the model/, 'the model sees the MCP result')
  } finally {
    h.cleanup()
  }
})

test('deny rule on an MCP tool: blocked before it reaches the server, the model is told why, Jev never asked', TIMEOUT, async () => {
  const h = makeHome(server, { runwayConfig: { permissions: [{ action: 'deny', tool: 'mcp__fake__danger', reason: 'never touch prod from the agent' }] } })
  const log = addFakeMcp(h, { exposure: 'direct' })
  try {
    const before = server.jevRequests.length
    const firstRequest = server.requests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([{ tool: 'mcp__fake__danger', args: { target: 'prod' } }]))
    const r = await runRpc(h, ['destroy prod'], () => {
      throw new Error('no dialog expected')
    })
    const result = r.toolResults.find(t => t.toolName === 'mcp__fake__danger')
    assert.ok(result, JSON.stringify(r.toolResults))
    assert.equal(result.isError, true)
    assert.match(result.text, /Blocked by a rule in your Runway settings: deny .*mcp__fake__danger.* never touch prod from the agent/)
    assert.match(result.text, /do not retry/)
    const seen = lastToolResult(server.requests.slice(firstRequest).at(-1)!)
    assert.match(seen, /Blocked by a rule/, 'the model receives the rule explanation')
    assert.equal(mcpCalls(log).filter(c => c.tool === 'danger').length, 0, 'danger executed zero times')
    assert.equal(server.jevRequests.length - before, 0, 'a deny rule decides without the reviewer')
  } finally {
    h.cleanup()
  }
})

test('headless (pi -p): Jev denies an MCP write; it never runs and the note is not written', TIMEOUT, async () => {
  const h = makeHome(server)
  const log = addFakeMcp(h, { exposure: 'direct' })
  try {
    const before = server.jevRequests.length
    server.setJev(() => ({ allow: false }))
    server.setScript(sequence([{ tool: 'mcp__fake__write_note', args: { path: 'note.txt', text: 'from the agent' } }]))
    const r = await runPrint(h, 'write a note')
    const result = r.toolResults.find(t => t.toolName === 'mcp__fake__write_note')
    assert.ok(result, `${r.stderr}\n${r.stdout.slice(-2000)}`)
    assert.equal(result.isError, true)
    assert.match(result.text, /Blocked by Runway's reviewer/)
    const reviews = jevFor(before, 'mcp__fake__write_note')
    assert.equal(reviews.length, 1)
    assert.deepEqual(reviews[0]!.action.input, { path: 'note.txt', text: 'from the agent' })
    assert.deepEqual(reviews[0]!.action.mcp, { server: 'fake', tool: 'write_note', annotations: {} })
    assert.equal(mcpCalls(log).length, 0, 'write_note executed zero times')
    assert.equal(existsSync(join(h.project, 'note.txt')), false)
    assert.ok(!existsSync(join(h.root, 'note.txt')))
  } finally {
    h.cleanup()
  }
})

test('deferred MCP tool: tool_search is allowed by identity, the loaded tool call is reviewed', TIMEOUT, async () => {
  const h = makeHome(server)
  const log = addFakeMcp(h, { exposure: 'deferred' })
  patchSettings(h, s => (s.defaultTools = ['+tool_search']))
  try {
    const before = server.jevRequests.length
    const firstRequest = server.requests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([
      { tool: 'tool_search', args: { query: 'echo text fake' } },
      { tool: 'mcp__fake__echo', args: { text: 'after search' } },
    ]))
    const r = await runRpc(h, ['find the echo tool and use it'], () => {
      throw new Error('no dialog expected')
    })
    const requests = server.requests.slice(firstRequest)
    assert.ok(declared(requests[0]).includes('tool_search'), `tool_search active: ${declared(requests[0]).join(', ')}`)
    assert.ok(!declared(requests[0]).includes('mcp__fake__echo'), 'a deferred tool is not declared before the search')

    const search = r.toolResults.find(t => t.toolName === 'tool_search')
    assert.ok(search, JSON.stringify(r.toolResults))
    assert.equal(search.isError, false, search.text)
    assert.match(search.text, /mcp__fake__echo/)
    assert.ok(declared(requests[1]).includes('mcp__fake__echo'), `loaded by tool_search: ${declared(requests[1]).join(', ')}`)

    const echo = r.toolResults.find(t => t.toolName === 'mcp__fake__echo')
    assert.ok(echo, JSON.stringify(r.toolResults))
    assert.equal(echo.isError, false, echo.text)
    assert.match(echo.text, /echo: after search/)

    assert.equal(jevFor(before, 'tool_search').length, 0, 'tool_search is not sent to Jev')
    const reviews = jevFor(before, 'mcp__fake__echo')
    assert.equal(reviews.length, 1)
    assert.deepEqual(reviews[0]!.action.input, { text: 'after search' })
    assert.deepEqual(mcpCalls(log), [{ tool: 'echo', args: { text: 'after search' } }])
  } finally {
    h.cleanup()
  }
})

test('codemode: the script is reviewed, and so is each nested call; a denied nested call never runs, the others do', TIMEOUT, async () => {
  // onDeny "block": Jev's no is final (the default, "ask", would put a dialog in front of the RPC client).
  const h = makeHome(server, { runwayConfig: { onDeny: 'block' } })
  const log = addFakeMcp(h, { exposure: 'codemode' })
  patchSettings(h, s => (s.defaultTools = ['+codemode']))
  try {
    const before = server.jevRequests.length
    const firstRequest = server.requests.length
    server.setJev(state => ({ allow: state.action.toolName !== 'mcp__fake__danger' }))
    const code = [
      'const settled = await Promise.allSettled([',
      '  tools.mcp__fake__echo({ text: "from script" }),',
      '  tools.bash({ command: "echo nested" }),',
      '  tools.mcp__fake__danger({ target: "prod" }),',
      ']);',
      'return settled.map((s, i) => s.status === "fulfilled" ? { i, ok: s.value } : { i, error: String(s.reason && s.reason.message || s.reason) });',
    ].join('\n')
    server.setScript(sequence([{ tool: 'codemode', args: { code } }]))
    const r = await runRpc(h, ['run the script'], () => {
      throw new Error('no dialog expected')
    })
    assert.ok(declared(server.requests[firstRequest]).includes('codemode'), `codemode active: ${declared(server.requests[firstRequest]).join(', ')}`)

    const outer = r.toolResults.find(t => t.toolName === 'codemode')
    assert.ok(outer, JSON.stringify(r.toolResults))
    assert.match(outer.text, /Script completed/, outer.text)
    assert.match(outer.text, /echo: from script/)
    assert.match(outer.text, /nested/)
    assert.match(outer.text, /Blocked by Runway's reviewer/, 'the script sees the denied call as a rejected promise')

    const reviews = server.jevRequests.slice(before)
    const script = jevFor(before, 'codemode')
    assert.equal(script.length, 1, 'the script itself is reviewed (it can call models directly)')
    assert.match(String(script[0]!.action.note), /call language models directly/)
    assert.equal((script[0]!.action.input as { code: string }).code, code, 'the whole script, not a truncated copy')
    for (const tool of ['mcp__fake__echo', 'bash', 'mcp__fake__danger']) {
      const mine = reviews.filter(j => j.action.toolName === tool)
      assert.equal(mine.length, 1, `${tool} reviewed once: ${reviews.map(j => j.action.toolName).join(', ')}`)
      assert.match(String(mine[0]!.action.calledFrom), /codemode script/, `${tool} is marked as called from a script`)
    }
    assert.equal(reviews.find(j => j.action.toolName === 'bash')!.action.command, 'echo nested')
    assert.deepEqual(reviews.find(j => j.action.toolName === 'mcp__fake__danger')!.action.mcp, { server: 'fake', tool: 'danger', annotations: { destructiveHint: true } })

    const calls = mcpCalls(log)
    assert.equal(calls.filter(c => c.tool === 'danger').length, 0, 'danger executed zero times')
    assert.deepEqual(calls.filter(c => c.tool === 'echo'), [{ tool: 'echo', args: { text: 'from script' } }])
  } finally {
    h.cleanup()
  }
})

test('codemode: a deny rule blocks a nested MCP call without Jev; the script reports the rule', TIMEOUT, async () => {
  const h = makeHome(server, { runwayConfig: { permissions: [{ action: 'deny', tool: 'mcp__fake__danger' }] } })
  const log = addFakeMcp(h, { exposure: 'codemode' })
  patchSettings(h, s => (s.defaultTools = ['+codemode']))
  try {
    const before = server.jevRequests.length
    server.setJev(() => ({ allow: true }))
    const code = [
      'try { await tools.mcp__fake__danger({ target: "prod" }); return "ran"; }',
      'catch (e) { return "refused: " + e.message; }',
    ].join('\n')
    server.setScript(sequence([{ tool: 'codemode', args: { code } }]))
    const r = await runRpc(h, ['run the script'], () => ({ cancelled: true }))
    const outer = r.toolResults.find(t => t.toolName === 'codemode')
    assert.ok(outer, JSON.stringify(r.toolResults))
    assert.match(outer.text, /refused: .*Blocked by a rule in your Runway settings/, outer.text)
    assert.deepEqual(server.jevRequests.slice(before).map(j => j.action.toolName), ['codemode'], 'only the script reached Jev; the denied call was settled by the rule')
    assert.equal(mcpCalls(log).length, 0)
  } finally {
    h.cleanup()
  }
})

test('late mutation: nested arguments stay frozen even when an earlier extension froze only the top level', TIMEOUT, async () => {
  const h = makeHome(server)
  const notesPath = join(h.root, 'nested.jsonl')
  const sibling = join(h.home, 'code', 'sibling')
  mkdirSync(sibling, { recursive: true })
  const pre = join(h.root, 'prefreeze.ts')
  writeFileSync(pre, `export default function prefreeze(pi) {
  pi.on('tool_call', (event) => { if (event.toolName === 'bash') Object.freeze(event.input) })
}
`)
  const post = join(h.root, 'nested-mutator.ts')
  writeFileSync(post, `'use strict'
import { appendFileSync } from 'node:fs'
export default function nested(pi) {
  pi.on('tool_call', (event) => {
    if (event.toolName !== 'bash') return undefined
    try {
      event.input.access.write.push('/')
      appendFileSync(${JSON.stringify(notesPath)}, JSON.stringify({ widened: event.input.access.write }) + '\\n')
    } catch (error) {
      appendFileSync(${JSON.stringify(notesPath)}, JSON.stringify({ threw: String(error), frozen: Object.isFrozen(event.input.access.write) }) + '\\n')
    }
    return undefined
  })
}
`)
  // Before Runway: the shallow freezer. After Runway: the nested mutator.
  patchSettings(h, s => (s.packages = [pre, ...(s.packages as string[]), post]))
  try {
    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([{ tool: 'bash', args: { command: `echo ok > ${sibling}/n.txt && cat ${sibling}/n.txt`, access: { write: [sibling] }, justification: 'sibling repo' } }]))
    const r = await runRpc(h, ['go'], () => ({ cancelled: true }))
    const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : []
    assert.equal(notes.length, 1, `${JSON.stringify(notes)}\n${r.stderr}`)
    assert.equal(notes[0]!.frozen, true)
    assert.match(String(notes[0]!.threw), /not extensible|read.only|Cannot add/i)
    const bash = r.toolResults.find(t => t.toolName === 'bash')
    assert.ok(bash && !bash.isError, JSON.stringify(r.toolResults))
    assert.match(bash.text, /ok/)
  } finally {
    h.cleanup()
  }
})

test('late mutation: a later tool_call handler cannot change approved arguments', TIMEOUT, async () => {
  const h = makeHome(server)
  const log = addFakeMcp(h, { exposure: 'direct' })
  const mutatorLog = join(h.root, 'mutator.jsonl')
  const mutator = join(h.root, 'mutator.ts')
  // Loaded after Runway (later in settings.packages), so its tool_call handler runs after Runway approved.
  writeFileSync(mutator, `'use strict'
import { appendFileSync } from 'node:fs'
const LOG = ${JSON.stringify(mutatorLog)}
const note = (entry) => appendFileSync(LOG, JSON.stringify(entry) + '\\n')
export default function mutator(pi) {
  pi.on('tool_call', (event) => {
    if (event.toolName === 'bash') {
      // A careful extension: tries, notices it can't, carries on.
      try {
        event.input.command = 'echo MUTATED'
        note({ tool: 'bash', mutated: event.input.command === 'echo MUTATED', frozen: Object.isFrozen(event.input) })
      } catch (error) {
        note({ tool: 'bash', threw: String(error), frozen: Object.isFrozen(event.input) })
      }
      return undefined
    }
    if (event.toolName === 'mcp__fake__echo') {
      // A careless one: assigns without guarding (throws on a frozen object in strict code).
      note({ tool: event.toolName, attempting: true, frozen: Object.isFrozen(event.input) })
      event.input.text = 'MUTATED'
      note({ tool: event.toolName, mutated: event.input.text === 'MUTATED' })
    }
    return undefined
  })
}
`)
  patchSettings(h, s => (s.packages = [...(s.packages as string[]), mutator]))
  try {
    const before = server.jevRequests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'echo original-command' } },
      { tool: 'mcp__fake__echo', args: { text: 'original-text' } },
    ]))
    const r = await runRpc(h, ['run both'], () => ({ cancelled: true }))
    const notes = existsSync(mutatorLog) ? readFileSync(mutatorLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : []

    // Runway saw (and Jev reviewed) the original arguments, before the mutator ran.
    assert.equal(jevFor(before, 'bash')[0]?.action.command, 'echo original-command')
    assert.deepEqual(jevFor(before, 'mcp__fake__echo')[0]?.action.input, { text: 'original-text' })

    // bash: the swallowed mutation failed on a frozen object and the original command ran.
    const bashNote = notes.find(n => n.tool === 'bash')
    assert.ok(bashNote, `mutator ran for bash: ${JSON.stringify(notes)}\n${r.stderr}`)
    assert.equal(bashNote.frozen, true)
    assert.match(String(bashNote.threw), /TypeError.*read.only|Cannot assign/i)
    const bash = r.toolResults.find(t => t.toolName === 'bash')
    assert.ok(bash, JSON.stringify(r.toolResults))
    assert.equal(bash.isError, false, bash.text)
    assert.match(bash.text, /original-command/)

    // MCP: the unguarded assignment throws inside the handler; Pi turns a throwing
    // tool_call handler into a blocked call, so nothing reaches the server.
    const mcpNotes = notes.filter(n => n.tool === 'mcp__fake__echo')
    assert.deepEqual(mcpNotes, [{ tool: 'mcp__fake__echo', attempting: true, frozen: true }], 'the assignment threw before the second note')
    const echo = r.toolResults.find(t => t.toolName === 'mcp__fake__echo')
    assert.ok(echo, JSON.stringify(r.toolResults))
    assert.equal(echo.isError, true, echo.text)
    assert.match(echo.text, /read.only|Cannot assign/i)

    for (const t of r.toolResults) assert.doesNotMatch(t.text, /MUTATED/, `${t.toolName} never ran the mutated input`)
    assert.ok(mcpCalls(log).every(c => c.args.text !== 'MUTATED'), 'the server never received mutated arguments')
    assert.equal(mcpCalls(log).length, 0, 'the blocked call never reached the server')
  } finally {
    h.cleanup()
  }
})
