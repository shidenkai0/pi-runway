import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ENV_CANARY, makeHome, runPrint, runRpc, sequence, startFakeServer } from '../support/harness.ts'
import type { FakeServer, PiEvent } from '../support/harness.ts'

let server: FakeServer
before(async () => {
  server = await startFakeServer()
})
after(async () => {
  await server.close()
})

const dialogs = (events: PiEvent[]) => events.filter(e => e.type === 'extension_ui_request' && e.method === 'select')

test('auto: Jev approves an escalation; it runs outside the sandbox, still without secrets', async () => {
  const h = makeHome(server)
  try {
    const before = server.jevRequests.length
    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'echo done > ../sibling.txt && echo "canary=[$RUNWAY_TEST_API_TOKEN]"', escalate: true, justification: 'the task writes a report next to the repo' } },
    ]))
    const r = await runRpc(h, ['write the sibling report'], () => {
      throw new Error('no dialog expected')
    })
    assert.equal(r.toolResults[0]!.isError, false, r.toolResults[0]!.text)
    assert.match(r.toolResults[0]!.text, /canary=\[\]/)
    assert.ok(existsSync(join(h.project, '..', 'sibling.txt')))
    const review = server.jevRequests.slice(before)
    assert.equal(review.length, 1)
    assert.match(String(review[0]!.action.command), /sibling/)
    assert.equal(review[0]!.action.agentJustification, 'the task writes a report next to the repo')
    assert.ok(Array.isArray(review[0]!.transcript) && review[0]!.transcript.length > 0, 'the reviewer sees the conversation')
    assert.match(JSON.stringify(review[0]!.transcript), /write the sibling report/)
    const log = readFileSync(join(h.agentDir, 'runway', 'decisions.jsonl'), 'utf8')
    assert.match(log, /"decision":"allowed","by":"reviewer"/)
  } finally {
    h.cleanup()
  }
})

test('auto: Jev declines; the agent is told why and nothing runs; onDeny=ask lets you overrule', async () => {
  const h = makeHome(server)
  try {
    server.setJev(() => ({ allow: false }))
    server.setScript(sequence([{ tool: 'bash', args: { command: 'touch ../declined.txt', escalate: true, justification: 'x' } }]))
    const r = await runRpc(h, ['go'], () => {
      throw new Error('no dialog expected with onDeny=block')
    })
    assert.ok(r.toolResults[0]!.isError)
    assert.match(r.toolResults[0]!.text, /safety reviewer/)
    assert.match(r.toolResults[0]!.text, /ask them to confirm in chat/)
    assert.ok(!existsSync(join(h.project, '..', 'declined.txt')))
  } finally {
    h.cleanup()
  }
  const h2 = makeHome(server, { runwayConfig: { onDeny: 'ask' } })
  try {
    server.setScript(sequence([{ tool: 'bash', args: { command: 'touch ../overruled.txt', escalate: true, justification: 'x' } }]))
    const r = await runRpc(h2, ['go'], req => {
      assert.match(String(req.title), /reviewer said no/)
      return { value: 'Allow once' }
    })
    assert.equal(r.toolResults[0]!.isError, false, r.toolResults[0]!.text)
    assert.ok(existsSync(join(h2.project, '..', 'overruled.txt')))
  } finally {
    h2.cleanup()
  }
})

test('floor: always asks a person; a person-approved command gets the full environment', async () => {
  const h = makeHome(server)
  try {
    const before = server.jevRequests.length
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'echo "publishing canary=[$RUNWAY_TEST_API_TOKEN]" # npm publish', escalate: true, justification: 'release' } },
      { tool: 'bash', args: { command: 'echo deleting # rm -rf ~/', escalate: true, justification: 'cleanup' } },
    ]))
    let n = 0
    const r = await runRpc(h, ['release it'], req => {
      n += 1
      assert.match(String(req.title), /always asks a person/)
      return { value: n === 1 ? 'Allow once' : 'Deny' }
    })
    assert.equal(n, 2)
    assert.equal(server.jevRequests.length, before, 'floor never goes to Jev')
    assert.equal(r.toolResults[0]!.isError, false)
    assert.match(r.toolResults[0]!.text, new RegExp(`canary=\\[${ENV_CANARY}\\]`))
    assert.ok(r.toolResults[1]!.isError)
    assert.match(r.toolResults[1]!.text, /user declined/)
  } finally {
    h.cleanup()
  }
})

test('headless: floor refuses, Jev still approves ordinary escalations', async () => {
  const h = makeHome(server)
  try {
    server.setJev(() => ({ allow: true }))
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'sudo true', escalate: true, justification: 'x' } },
      { tool: 'bash', args: { command: 'echo ok > ../headless.txt', escalate: true, justification: 'x' } },
      { tool: 'read', args: { path: '~/.aws/credentials' } },
    ]))
    const r = await runPrint(h, 'go')
    assert.equal(r.exitCode, 0)
    assert.ok(r.toolResults[0]!.isError)
    assert.match(r.toolResults[0]!.text, /no one is available to ask/)
    assert.equal(r.toolResults[1]!.isError, false)
    assert.ok(r.toolResults[2]!.isError)
    assert.ok(!r.toolResults[2]!.text.includes('CANARY'))
  } finally {
    h.cleanup()
  }
})

test('reviewer failures fall back to a person, then refuse when nobody is there', async () => {
  const h = makeHome(server, { runwayConfig: { reviewer: { timeoutMs: 1000, maxAttempts: 1 } } })
  try {
    server.setJev(() => ({ allow: true, delayMs: 3000 }))
    server.setScript(sequence([{ tool: 'bash', args: { command: 'echo slow > ../slow.txt', escalate: true, justification: 'x' } }]))
    const r = await runRpc(h, ['go'], req => {
      assert.match(String(req.title), /reviewer could not decide/)
      return { value: 'Deny' }
    })
    assert.ok(r.toolResults[0]!.isError)
    assert.equal(dialogs(r.events).length, 1)
    server.setJev(() => ({ allow: true, status: 500 }))
    const p = await runPrint(h, 'go')
    assert.ok(p.toolResults[0]!.isError)
    assert.match(p.toolResults[0]!.text, /reviewer could not decide/)
    assert.ok(!existsSync(join(h.project, '..', 'slow.txt')))
  } finally {
    h.cleanup()
  }
})

test('no reviewer key: ask mode, you review escalations', async () => {
  const h = makeHome(server, { reviewerKey: false })
  try {
    const before = server.jevRequests.length
    server.setScript(sequence([{ tool: 'bash', args: { command: 'echo hi > ../nokey.txt', escalate: true, justification: 'x' } }]))
    const r = await runRpc(h, ['go'], req => {
      assert.match(String(req.title), /asked to run this command outside the sandbox/)
      return { value: 'Allow once' }
    })
    assert.equal(r.toolResults[0]!.isError, false)
    assert.equal(server.jevRequests.length, before)
    const status = r.events.find(e => e.type === 'extension_ui_request' && e.method === 'setStatus')
    assert.match(String(status?.statusText), /runway ask/)
  } finally {
    h.cleanup()
  }
})

test('network: unknown hosts are reviewed once per session; declined hosts get a 403', async () => {
  const h = makeHome(server)
  try {
    const before = server.jevRequests.length
    server.setJev(state => ({ allow: String(state.action.target).startsWith('allowed.invalid') }))
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null https://blocked.invalid/ 2>&1; echo code=$?' } },
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null https://allowed.invalid/ 2>&1; echo code=$?' } },
      { tool: 'bash', args: { command: 'curl -sS -m 5 -o /dev/null https://allowed.invalid/again 2>&1; echo code=$?' } },
    ]))
    const r = await runRpc(h, ['fetch'])
    assert.match(r.toolResults[0]!.text, /403/)
    // Allowed: the proxy lets it through; with no real DNS for .invalid the upstream fails differently.
    assert.doesNotMatch(r.toolResults[1]!.text, /403/)
    const reviews = server.jevRequests.slice(before).map(j => String(j.action.target))
    assert.deepEqual(reviews, ['blocked.invalid:443', 'allowed.invalid:443'], 'second connection to an approved host is not re-reviewed')
  } finally {
    h.cleanup()
  }
})

test('off: no sandbox and no reviews (explicit only)', async () => {
  const h = makeHome(server, { runwayConfig: { mode: 'off' } })
  try {
    server.setScript(sequence([{ tool: 'bash', args: { command: 'echo x > ../off.txt && echo "c=[$RUNWAY_TEST_API_TOKEN]"' } }]))
    const r = await runPrint(h, 'go')
    assert.equal(r.toolResults[0]!.isError, false)
    assert.match(r.toolResults[0]!.text, new RegExp(ENV_CANARY))
  } finally {
    h.cleanup()
  }
})

test('outward actions ask a person even inside the sandbox; everyday commands do not', async () => {
  const h = makeHome(server)
  try {
    const before = server.jevRequests.length
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'echo "would publish" # npm publish' } },
      { tool: 'bash', args: { command: 'echo "would deploy" # terraform apply -auto-approve' } },
      { tool: 'bash', args: { command: 'git push origin main 2>&1; echo pushed-exit=$?' } },
    ]))
    const titles: string[] = []
    const r = await runRpc(h, ['ship it'], req => {
      titles.push(String(req.title))
      return { value: titles.length === 1 ? 'Allow once' : 'Deny' }
    })
    assert.equal(titles.length, 2, `dialogs: ${JSON.stringify(titles)}`)
    assert.match(titles[0]!, /effect lands outside this machine/)
    assert.match(titles[0]!, /cannot be taken back/)
    assert.equal(r.toolResults[0]!.isError, false)
    assert.match(r.toolResults[0]!.text, /would publish/)
    assert.ok(r.toolResults[1]!.isError)
    assert.match(r.toolResults[1]!.text, /user declined/)
    assert.match(r.toolResults[2]!.text, /pushed-exit=/, 'a plain push is left to the sandbox, no dialog')
    assert.equal(server.jevRequests.length, before, 'outward actions never go to Jev')
    server.setScript(sequence([{ tool: 'bash', args: { command: 'echo "would publish" # npm publish' } }]))
    const p = await runPrint(h, 'ship it')
    assert.ok(p.toolResults[0]!.isError)
    assert.match(p.toolResults[0]!.text, /no one is available to ask/)
  } finally {
    h.cleanup()
  }
})
