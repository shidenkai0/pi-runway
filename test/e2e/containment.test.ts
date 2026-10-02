import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ENV_CANARY, makeHome, READ_BLOCKED, runPrint, runRpc, SECRET_CANARY, sequence, startFakeServer } from '../support/harness.ts'
import type { FakeServer } from '../support/harness.ts'

let server: FakeServer
before(async () => {
  server = await startFakeServer()
})
after(async () => {
  await server.close()
})

test('ordinary work runs without permission prompts; commands are reviewed', async () => {
  const h = makeHome(server)
  try {
    writeFileSync(join(h.project, 'sum.test.js'), "const test = require('node:test'); const assert = require('node:assert'); test('sum', () => assert.equal(1 + 1, 2))\n")
    server.setScript(sequence([
      { tool: 'write', args: { path: 'src/util.js', content: 'module.exports = x => x * 2\n' } },
      { tool: 'edit', args: { path: 'index.js', edits: [{ oldText: '42', newText: '43' }] } },
      { tool: 'bash', args: { command: 'node -e "console.log(require(\'./src/util.js\')(21))"' } },
      { tool: 'bash', args: { command: "node --test sum.test.js 2>&1 | grep -E '(pass|fail) [0-9]'" } },
      { tool: 'bash', args: { command: 'mkdir -p build && echo ok > build/out.txt && ls build && echo tmp > /tmp/runway-e2e-scratch.txt && cat /tmp/runway-e2e-scratch.txt' } },
      { tool: 'bash', args: { command: 'git add -A && git commit -qm "work" && git log --oneline | head -1' } },
      { tool: 'read', args: { path: 'package.json' } },
      { tool: 'bash', args: { command: 'grep -rn exports --include=*.js . | head -5' } },
    ]))
    const r = await runRpc(h, ['work'], () => {
      throw new Error('no dialog expected')
    })
    const errors = r.toolResults.filter(t => t.isError)
    assert.deepEqual(errors, [], 'no tool errors')
    assert.equal(r.toolResults.length, 8)
    assert.match(r.toolResults[2]!.text, /42/)
    assert.match(r.toolResults[3]!.text, /pass 1/)
    assert.match(r.toolResults[5]!.text, /work/)
    // Every command was reviewed (the fake reviewer approves); Pi's own file tools in the project were not.
    assert.ok(server.jevRequests.every(j => j.action.toolName === 'bash'), 'only commands were reviewed')
    assert.equal(r.uiRequests.filter(u => u.method === 'select' || u.method === 'confirm').length, 0)
  } finally {
    h.cleanup()
  }
})

test('secrets stay out of reach of commands', async () => {
  const h = makeHome(server)
  try {
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'cat ~/.ssh/id_ed25519' } },
      { tool: 'bash', args: { command: 'cat ~/.aws/credentials' } },
      { tool: 'bash', args: { command: 'cat ~/.pi/agent/auth.json' } },
      { tool: 'bash', args: { command: 'env' } },
      { tool: 'bash', args: { command: 'tar czf - ~/.ssh 2>&1 | head -c 200 | base64' } },
      { tool: 'bash', args: { command: 'cp -r ~/.ssh ./stolen 2>&1; ls stolen 2>&1' } },
    ]))
    const r = await runRpc(h, ['look'])
    const all = r.toolResults.map(t => t.text).join('\n')
    assert.ok(!all.includes(SECRET_CANARY), 'secret file contents never appear')
    assert.ok(!all.includes(ENV_CANARY), 'secret env never appears')
    assert.ok(!all.includes('sk-or-fake-reviewer-key'), 'reviewer key never appears')
    assert.ok(!all.includes('fake-provider-key'), 'provider key never appears')
    assert.match(r.toolResults[0]!.text, READ_BLOCKED)
    assert.ok(r.toolResults[0]!.isError, 'the read failed')
    if (process.platform === 'darwin') {
      // Seatbelt reports violations, so the agent is told how to ask for more.
      assert.match(r.toolResults[0]!.text, /<sandbox_violations>/)
      assert.match(r.toolResults[0]!.text, /escalate/)
    }
    assert.ok(!existsSync(join(h.project, 'stolen', 'id_ed25519')), 'the folder could not be copied out either')
    assert.match(r.toolResults[3]!.text, /PATH=/, 'env still works')
  } finally {
    h.cleanup()
  }
})

test('files that run code later cannot be planted', async () => {
  const h = makeHome(server)
  try {
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'echo "echo pwned" > .git/hooks/pre-commit' } },
      { tool: 'bash', args: { command: 'git config core.hooksPath .hooks' } },
      { tool: 'bash', args: { command: 'mkdir -p .pi/extensions && echo "x" > .pi/extensions/evil.ts' } },
      { tool: 'bash', args: { command: 'echo "alias ls=rm" >> ~/.zshrc' } },
      { tool: 'bash', args: { command: 'mkdir -p ~/.pi/agent/extensions && echo x > ~/.pi/agent/extensions/evil.ts' } },
      { tool: 'bash', args: { command: 'ln -s ~/.zshrc rc && ls -la rc' } },
      { tool: 'write', args: { path: 'rc', content: 'alias ls=rm\n' } },
      { tool: 'write', args: { path: '.pi/extensions/evil.ts', content: 'export default () => {}' } },
      { tool: 'write', args: { path: '.PI/extensions/evil.ts', content: 'export default () => {}' } },
      { tool: 'write', args: { path: '.GIT/hooks/pre-commit', content: 'echo pwned' } },
      { tool: 'write', args: { path: '.vscode/tasks.json', content: '{}' } },
      { tool: 'bash', args: { command: 'mkdir -p sub/.vscode && echo {} > sub/.vscode/tasks.json' } },
      { tool: 'bash', args: { command: 'security find-generic-password -s anything -w 2>&1; git credential-osxkeychain get </dev/null 2>&1; echo done' } },
      { tool: 'bash', args: { command: 'mkdir -p .vscode && echo {} > .vscode/tasks.json' } },
      { tool: 'bash', args: { command: 'mkdir -p sub2/.vscode 2>&1; echo made' } },
      { tool: 'bash', args: { command: 'echo {} > sub2/.vscode/tasks.json' } },
    ]))
    const r = await runPrint(h, 'plant')
    const [hook, hooksPath, piExt, zshrc, agentExt, link, writeLink, writePi, writePiCase, writeGitCase, writeVscode, bashVscode, keychain, rootVscode, , existingNestedVscode] = r.toolResults
    if (process.platform === 'darwin') assert.ok(writePiCase!.isError && /Blocked by Runway/.test(writePiCase!.text), 'case variant of .pi is still .pi (case-insensitive file system)')
    else assert.ok(!existsSync(join(h.project, '.pi', 'extensions', 'evil.ts')), 'on a case-sensitive file system .PI is a different folder; .pi stays untouched')
    if (process.platform === 'darwin') assert.ok(writeGitCase!.isError && /Blocked by Runway/.test(writeGitCase!.text), 'case variant of .git/hooks (case-insensitive file system)')
    else assert.ok(!existsSync(join(h.project, '.git', 'hooks', 'pre-commit')), 'on a case-sensitive file system .GIT is a different folder; .git/hooks stays untouched')
    assert.ok(writeVscode!.isError && /Blocked by Runway/.test(writeVscode!.text), '.vscode via write tool')
    assert.ok(rootVscode!.isError && !existsSync(join(h.project, '.vscode', 'tasks.json')), 'project .vscode via bash')
    assert.ok(existingNestedVscode!.isError && !existsSync(join(h.project, 'sub2', '.vscode', 'tasks.json')), 'a nested .vscode that exists when the command starts')
    // bubblewrap can't express `**` write denies: on Linux a nested control folder created and written by
    // the same command isn't covered (documented limit); Seatbelt covers it.
    if (process.platform === 'darwin') assert.ok(bashVscode!.isError, 'nested .vscode created and written in one command')
    if (process.platform === 'darwin') {
      assert.match(keychain!.text, /security: (command not found|Operation not permitted)/, 'the security tool cannot run in the sandbox')
      assert.match(keychain!.text, /not a git command|not permitted/, 'the git keychain helper cannot run in the sandbox')
    }
    assert.ok(hook!.isError && /not permitted|Read-only file system|Permission denied/.test(hook!.text), `git hook write: ${hook!.text}`)
    assert.ok(hooksPath!.isError, `git config write denied: ${hooksPath!.text}`)
    assert.ok(piExt!.isError, `.pi via bash: ${piExt!.text}`)
    assert.ok(zshrc!.isError, `~/.zshrc via bash: ${zshrc!.text}`)
    // Seatbelt refuses the write. bubblewrap hides ~/.pi/agent (a credential store) behind an empty
    // tmpfs, so the write lands in that throwaway mount; the real folder is checked below either way.
    if (process.platform === 'darwin') assert.ok(agentExt!.isError, `~/.pi/agent via bash: ${agentExt!.text}`)
    assert.ok(!link!.isError, 'making a symlink inside the project is fine')
    assert.ok(writeLink!.isError && /Blocked by Runway/.test(writeLink!.text), 'write through symlink to ~/.zshrc is stopped')
    assert.ok(writePi!.isError && /Blocked by Runway/.test(writePi!.text))
    assert.ok(!existsSync(join(h.project, '.git', 'hooks', 'pre-commit')))
    assert.ok(!existsSync(join(h.project, '.pi', 'extensions', 'evil.ts')))
    assert.ok(!existsSync(join(h.home, '.zshrc')))
    assert.ok(!existsSync(join(h.agentDir, 'extensions', 'evil.ts')))
    assert.equal(r.exitCode, 0)
  } finally {
    h.cleanup()
  }
})

test('linked worktree: commits work inside the sandbox; the main checkout is off limits', async () => {
  const h = makeHome(server)
  try {
    const wt = join(h.home, 'code', 'app-feature')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: h.project, env: h.env })
    server.setScript(sequence([
      { tool: 'bash', args: { command: 'echo feature > feature.txt && git add feature.txt && git commit -qm feature && git log --oneline -1 && git status --short | wc -l' } },
      { tool: 'bash', args: { command: 'git stash list; git branch --show-current' } },
      { tool: 'bash', args: { command: 'echo nope > ../app/index.js' } },
      { tool: 'bash', args: { command: 'echo x > "$(git rev-parse --git-common-dir)/hooks/post-checkout"' } },
    ]))
    const r = await runPrint({ ...h, project: wt }, 'feature work')
    const [commit, branch, main, hook] = r.toolResults
    assert.ok(!commit!.isError, commit!.text)
    assert.match(commit!.text, /feature/)
    assert.match(branch!.text, /feature/)
    assert.ok(main!.isError, 'main checkout not writable')
    assert.equal(readFileSync(join(h.project, 'index.js'), 'utf8'), 'module.exports = 42\n')
    assert.ok(hook!.isError, 'shared hooks not writable')
    const log = execFileSync('git', ['log', '--oneline', 'feature', '-1'], { cwd: h.project, encoding: 'utf8' })
    assert.match(log, /feature/)
  } finally {
    h.cleanup()
  }
})

test('optional search tools enabled with --tools: code search works, secrets files are never shown', async () => {
  const h = makeHome(server, { piArgs: ['--tools', 'read,bash,edit,write,grep,find,ls'] })
  try {
    writeFileSync(join(h.project, 'config.js'), 'module.exports = { token: process.env.API_TOKEN }\n')
    writeFileSync(join(h.project, 'secrets.pem'), `-----BEGIN PRIVATE KEY-----\nAPI_TOKEN ${SECRET_CANARY}\n`)
    const before = server.jevRequests.length
    server.setScript(sequence([
      { tool: 'grep', args: { pattern: 'API_TOKEN', path: '.' } },
      { tool: 'grep', args: { pattern: 'API_TOKEN', path: '.', context: 2 } },
      { tool: 'grep', args: { pattern: 'API_TOKEN', path: '.env' } },
      { tool: 'find', args: { pattern: '*' } },
      { tool: 'ls', args: {} },
    ]))
    const r = await runRpc(h, ['find where API_TOKEN is used'])
    assert.deepEqual(server.requests.at(-1)?.tools?.map(t => t.function.name).filter(n => ['grep', 'find', 'ls'].includes(n)), ['grep', 'find', 'ls'], 'the tools were offered')
    const [plain, withContext, direct, found, listed] = r.toolResults
    assert.match(plain!.text, /config\.js:1: module\.exports = \{ token: process\.env\.API_TOKEN \}/, 'ordinary matches are shown')
    assert.match(plain!.text, /Runway does not search files that hold secrets/)
    assert.match(withContext!.text, /config\.js:1:/)
    assert.ok(direct!.isError && /holds secrets/.test(direct!.text), direct!.text)
    // Pi's find needs fd; where it's missing and can't be downloaded, Pi says so (nothing to guard).
    if (!/fd is not available/.test(found!.text)) assert.match(found!.text, /config\.js/)
    assert.match(listed!.text, /config\.js/)
    for (const t of r.toolResults) {
      assert.ok(!t.text.includes(SECRET_CANARY), `${t.toolName} never shows the secret value`)
      assert.doesNotMatch(t.text, /^\.env:\d+:|^secrets\.pem:\d+:/m, `${t.toolName} shows no line of a secrets file`)
    }
    assert.ok(!JSON.stringify(r.events).includes(SECRET_CANARY))
    assert.ok(!JSON.stringify(server.requests).includes(SECRET_CANARY), 'the canary never reaches the model')
    const reviews = server.jevRequests.slice(before)
    assert.deepEqual(reviews.map(j => (j.action.input as { path?: string }).path), ['.env'], 'project search is routine; only the search aimed at a secrets file is reviewed (and still shows nothing)')
  } finally {
    h.cleanup()
  }
})
