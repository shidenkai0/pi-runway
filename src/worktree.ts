import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { clearGitCache, detectGit } from './policy.ts'

// /worktree <name>: start parallel work on a new branch in its own linked
// worktree, next to the main checkout, and move this conversation there.
// The sandbox already treats a linked worktree as the project (and lets git
// write the shared object store), so nothing else needs configuring.

export function worktreeName(input: string): string | undefined {
  const name = input.trim().replace(/\s+/g, '-')
  if (!name || name.length > 80) return undefined
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-') || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) return undefined
  return name
}

export function worktreePath(mainToplevel: string, name: string): string {
  return join(dirname(mainToplevel), `${basename(mainToplevel)}-${name.replace(/\//g, '-')}`)
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim()
}

export function registerWorktree(pi: ExtensionAPI): void {
  pi.registerCommand('worktree', {
    description: 'Create a git worktree on a new branch and continue this conversation there: /worktree <branch-name>',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = worktreeName(args)
      if (!name) {
        ctx.ui.notify('Usage: /worktree <branch-name> (letters, digits, . _ - /)', 'warning')
        return
      }
      const layout = detectGit(ctx.cwd)
      if (!layout) {
        ctx.ui.notify('/worktree needs a git repository.', 'warning')
        return
      }
      // The main checkout is the parent of the shared git dir (…/repo/.git → …/repo).
      const mainTop = basename(layout.commonDir) === '.git' ? dirname(layout.commonDir) : layout.toplevel
      const target = worktreePath(mainTop, name)
      if (existsSync(target)) {
        ctx.ui.notify(`${target} already exists.`, 'warning')
        return
      }
      try {
        let branchExists = true
        try {
          git(ctx.cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
        } catch {
          branchExists = false
        }
        git(ctx.cwd, branchExists ? ['worktree', 'add', target, name] : ['worktree', 'add', '-b', name, target])
      } catch (error) {
        const detail = error instanceof Error && 'stderr' in error ? String((error as { stderr: unknown }).stderr).trim() : String(error)
        ctx.ui.notify(`Could not create the worktree: ${detail}`, 'error')
        return
      }
      clearGitCache()
      await ctx.waitForIdle()
      const current = ctx.sessionManager.getSessionFile()
      let file: string | undefined
      try {
        if (current && existsSync(current)) {
          file = SessionManager.forkFrom(current, target).getSessionFile()
        }
      } catch {
        file = undefined
      }
      if (!file || !existsSync(file)) {
        const fresh = SessionManager.create(target)
        file = fresh.getSessionFile()
        if (file && !existsSync(file)) writeFileSync(file, `${JSON.stringify(fresh.getHeader())}\n`)
      }
      if (!file) {
        ctx.ui.notify(`Worktree ready at ${target}. Start Pi there with: cd ${JSON.stringify(target)} && pi`, 'info')
        return
      }
      const result = await ctx.switchSession(file, {
        withSession: async next => {
          next.ui.notify(`Now working in ${target} on branch ${name}. The main checkout is untouched.`, 'info')
        },
      })
      if (result.cancelled) ctx.ui.notify(`Worktree ready at ${target}. Start Pi there with: cd ${JSON.stringify(target)} && pi`, 'info')
    },
  })
}
