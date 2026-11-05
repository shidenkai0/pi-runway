import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { Runtime } from '../../src/runtime.ts'
import { normalize } from '../../src/permissions/operation.ts'
import { permissionFailureHint } from '../../src/bash.ts'

test('sandbox controls belong to a session, inherit downwards, and can be re-enabled', () => {
  const rt = new Runtime(SandboxManager)
  rt.grants.setParent('child', 'parent')
  rt.grants.setParent('grandchild', 'child')
  assert.equal(rt.sandboxEnabled('parent'), true)
  rt.sandboxOverrides.set('parent', false)
  assert.equal(rt.sandboxEnabled('grandchild'), false)
  assert.equal(rt.sandboxEnabled('unrelated'), true)
  rt.sandboxOverrides.set('child', true)
  assert.equal(rt.sandboxEnabled('grandchild'), true)
  assert.equal(rt.sandboxEnabled('parent'), false)
  rt.sandboxOverrides.set('parent', true)
  assert.equal(rt.sandboxEnabled('parent'), true)
  rt.sandboxDefaultEnabled = false
  assert.equal(rt.sandboxEnabled('new-session'), false)
  assert.equal(rt.sandboxEnabled('parent'), true, 'explicit on overrides the startup flag')
})

test('sandbox off changes the real execution envelope, not the tool arguments or identity', () => {
  const args = { tool: 'bash', input: { command: 'echo hello' }, cwd: '/project', toolCallId: 'c', meta: { identity: { kind: 'runway' as const }, source: 'builtin' as const } }
  const contained = normalize(args)
  const direct = normalize({ ...args, sandboxDisabled: true })
  assert.equal(direct.execution, 'unsandboxed')
  assert.notEqual(direct.key, contained.key, 'contained grants cannot authorize uncontained execution')
  assert.deepEqual(direct.input, args.input)
  assert.equal(normalize({ ...args, sandboxDisabled: true, meta: { identity: { kind: 'unknown' }, source: 'unknown' } }).execution, 'in-process')
})

test('permission failures offer scoped access or reviewed escalation without asserting an unproven cause', () => {
  const generic = permissionFailureHint('PermissionError: [Errno 1] Operation not permitted', [])!
  assert.match(generic, /may be.*sandbox|sandbox.*may be/)
  assert.match(generic, /"access"/)
  assert.match(generic, /"escalate": true/)
  assert.match(generic, /partially completed/)
  assert.match(generic, /\/runway sandbox off/)
  assert.equal(permissionFailureHint('SyntaxError: invalid syntax', []), undefined)
  assert.match(permissionFailureHint('', ['deny network-outbound target'])!, /sandbox blocked/)
})
