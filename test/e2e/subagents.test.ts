import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { makeHome, PACKAGE_ROOT, runRpc, SECRET_CANARY, startFakeServer } from '../support/harness.ts'
import type { ChatRequest, FakeServer, Reply } from '../support/harness.ts'

// Requires a local copy of @gotgenes/pi-subagents (npm run e2e:deps).
const SUBAGENTS = join(PACKAGE_ROOT, '.e2e', 'deps', 'node_modules', '@gotgenes', 'pi-subagents')

let server: FakeServer
before(async () => {
  server = await startFakeServer()
})
after(async () => {
  await server.close()
})

function isChild(req: ChatRequest): boolean {
  return req.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD TASK'))
}

function toolResultsIn(req: ChatRequest): string[] {
  return req.messages.filter(m => m.role === 'tool').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
}

test('subagents: sandboxed, per-agent model honoured, escalations reach the parent screen', { skip: !existsSync(SUBAGENTS) && 'pi-subagents not installed in .e2e/deps' }, async () => {
  const h = makeHome(server, { extraPackages: [SUBAGENTS], models: ['fake-model', 'fake-small'] })
  try {
    mkdirSync(join(h.agentDir, 'agents'), { recursive: true })
    writeFileSync(join(h.agentDir, 'agents', 'worker.md'), '---\ndescription: Does small chores\ntools: read, bash, write, edit\nmodel: fake/fake-small\n---\nYou are a worker.\n')
    const childSteps: Reply[] = [
      { tool: 'bash', args: { command: 'cat ~/.ssh/id_ed25519' } },
      { tool: 'bash', args: { command: 'echo child > child.txt && echo wrote' } },
      { tool: 'bash', args: { command: 'echo "sudo would go here"; # sudo reboot', escalate: true, justification: 'test floor from a child' } },
      { text: 'child finished' },
    ]
    server.setScript((req, turn) => {
      if (isChild(req)) {
        const childTurn = req.messages.filter(m => m.role === 'assistant').length
        return childSteps[childTurn] ?? { text: 'child finished' }
      }
      if (turn === 0) return { tool: 'subagent', args: { prompt: 'CHILD TASK: do chores', description: 'chores', subagent_type: 'worker' } }
      if (turn === 1) return { tool: 'bash', args: { command: 'cat ~/.ssh/id_ed25519; echo parent-after-child > parent.txt; cat parent.txt' } }
      return { text: 'parent done' }
    })
    const dialogs: string[] = []
    const r = await runRpc(h, ['delegate'], req => {
      dialogs.push(String(req.title))
      return { value: 'Deny' }
    }, 90_000)
    const childRequests = server.requests.filter(isChild)
    assert.ok(childRequests.length >= 3, `child ran (${childRequests.length} requests)`)
    assert.ok(childRequests.every(q => q.model === 'fake-small'), `per-agent model: ${[...new Set(childRequests.map(q => q.model))]}`)
    assert.ok(server.requests.filter(q => !isChild(q)).every(q => q.model === 'fake-model'))
    const childResults = toolResultsIn(childRequests.at(-1)!)
    assert.ok(childResults.length >= 3, JSON.stringify(childResults))
    assert.match(childResults[0]!, /Operation not permitted/, 'child bash is sandboxed')
    assert.ok(!childResults.join('\n').includes(SECRET_CANARY))
    assert.match(childResults[1]!, /wrote/)
    assert.ok(existsSync(join(h.project, 'child.txt')))
    assert.equal(dialogs.length, 1, `one dialog: ${JSON.stringify(dialogs)}`)
    assert.match(dialogs[0]!, /A subagent wants to leave the sandbox/)
    assert.match(childResults[2]!, /user declined/)
    const parentAfter = r.toolResults.find(t => t.toolName === 'bash')
    assert.ok(parentAfter, 'parent ran a command after the child finished')
    assert.match(parentAfter.text, /Operation not permitted/, 'parent sandbox survived the child shutting down')
    assert.match(parentAfter.text, /parent-after-child/)
  } finally {
    h.cleanup()
  }
})
