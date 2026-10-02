import { posix } from 'node:path'

// The always-ask floor. A small, fixed list of actions that are either
// irreversible, reach outside the machine in a way that is hard to take back,
// or hand the agent authority beyond this task. They never go to the automatic
// reviewer: a person decides (headless runs refuse). Everything else that
// leaves the sandbox is reviewed by Jev.
//
// This is deliberately a short list of high-signal patterns rather than a
// parser; it only ever applies to commands that already asked to leave the
// sandbox, so a miss falls back to the reviewer, not to silent execution.

export interface FloorHit {
  id: string
  reason: string
}

interface Rule {
  id: string
  reason: string
  test: RegExp
}

const HOME = String.raw`(?:~|\$HOME|\$\{HOME\})`

// Boundaries: a command word starts the line or follows a separator, a path, or sudo/env.
const START = String.raw`(?:^|[\s;&|(\x60$/])`
const ARGS = String.raw`[^\n;&|]*`
const PATH_PREFIX = String.raw`(?:^|[\s'"=:(<>])(?:(?:${HOME}|/Users/[^/\s]+|/home/[^/\s]+|/root)/)?`

const RULES: Rule[] = [
  { id: 'remote-shell', reason: 'opens a shell or copies files on another machine', test: new RegExp(String.raw`${START}(ssh|scp|sftp)\s|\brsync\b[^\n]*\s[\w.-]+@?[\w.-]*:[^\s]*`) },
  { id: 'privilege', reason: 'runs with elevated privileges', test: new RegExp(String.raw`${START}(sudo|doas|su|pkexec)(\s|$)`) },
  { id: 'pipe-to-shell', reason: 'pipes downloaded code straight into an interpreter', test: /\b(curl|wget|fetch|iwr|irm)\b[^\n|]*\|\s*(sudo\s+)?((ba|z|da|k|fi)?sh|python[0-9.]*|node|perl|ruby|bun|deno)\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)/ },
  { id: 'publish', reason: 'publishes a package or release for other people to use', test: new RegExp(String.raw`\b(npm|pnpm|bun|cargo|poetry|uv|vsce)\b${ARGS}\spublish(\s|$)|\byarn\b${ARGS}\s(npm\s+)?publish(\s|$)|\btwine\s+upload\b|\bgem\s+push\b|\b(docker|podman)\b${ARGS}\spush\b|\bgh\b${ARGS}\srelease\s+(create|upload|edit|delete)\b|\bpod\s+trunk\s+push\b`) },
  { id: 'deploy', reason: 'deploys to or changes live infrastructure', test: new RegExp(String.raw`\b(terraform|tofu|pulumi)\b${ARGS}\s(apply|destroy|up|import)\b|\bkubectl\b${ARGS}\s(apply|delete|replace|patch|scale|rollout|drain|cordon|create)\b|\bhelm\b${ARGS}\s(install|upgrade|uninstall|rollback)\b|\b(vercel|netlify)\b[^\n]*--prod\b|\bfly(ctl)?\b${ARGS}\sdeploy\b|\bheroku\b[^\n]*\b(releases:rollback|ps:scale|config:set|destroy)\b|\bgcloud\b[^\n]*\s(deploy|delete)\b|\baws\s+[a-z0-9-]+\s+(delete|terminate|put|create|update|deploy|rm|rb)[a-z-]*\b|\bwrangler\b${ARGS}\s(deploy|publish|delete)\b|\bsst\s+deploy\b|\bserverless\s+deploy\b`) },
  { id: 'history-rewrite', reason: 'rewrites or deletes history on a shared remote', test: new RegExp(String.raw`\bgit\b${ARGS}\spush\b${ARGS}(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--mirror\b|\s--delete\b|\s-d\s|\s:[\w/.-]+|\s\+[\w/.-]+)`) },
  { id: 'disk', reason: 'can wipe disks or change the system', test: new RegExp(String.raw`\b(mkfs(\.\w+)?|fdisk|diskutil\s+(erase\w*|partition\w*|zero\w*|secureErase|apfs\s+delete\w*)|dd\b[^\n]*\bof=/dev/|launchctl\s+(load|bootstrap|enable|submit)|systemctl\s+(enable|start|restart|stop|disable|mask)|crontab\s+(-r|-e|[^-\s])|nvram|csrutil|spctl|tmutil\s+delete)\b|${START}(shutdown|reboot|halt|poweroff)(\s|$)`) },
  { id: 'security-settings', reason: 'weakens a security setting', test: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/|\bchmod\s+[ug]?\+s\b|\bsecurity\s+(delete|add|import|set)-|\bdefaults\s+write\b|\bsetfacl\b|\bufw\s+(disable|allow)\b|\biptables\s+-F\b|\bgit\b[^\n;&|]*\sconfig\s+--(global|system)\b|\bnpm\s+config\s+set\b/ },
  { id: 'credentials', reason: 'reads or uses stored credentials', test: new RegExp(String.raw`${PATH_PREFIX}\.(ssh|aws|gnupg|netrc|git-credentials|docker/config\.json|kube|config/gh|config/gcloud|azure|npmrc|pypirc|vault-token)(/|\s|$|['"])|\bid_(rsa|dsa|ecdsa|ed25519)\b|\bauth\.json\b|\.pi/agent\b|\bsecurity\s+find-(generic|internet)-password\b|\bgh\s+auth\s+token\b|\bgcloud\s+auth\s+print-access-token\b|\baws\s+configure\s+get\b|\bop\s+(read|item\s+get)\b|\bprintenv\b|(^|[\s;&|])env(\s*$|\s*[|>;&])|\bset\s*\|\s*grep\b|\bexport\s+-p\b|\bcompgen\s+-e\b`) },
  { id: 'control-files', reason: 'changes files that later run outside the sandbox (shell startup, git hooks, Pi settings, login items)', test: new RegExp(String.raw`(?:^|[\s'"=:(<>/])\.(bashrc|bash_profile|zshrc|zshenv|zprofile|profile|gitconfig)\b|\.git/(hooks|config)\b|\bcore\.hooksPath\b|${HOME}/\.pi\b|\.pi/(extensions|settings\.json|runway\.json)|\.(vscode|claude)/|Library/LaunchAgents|/etc/(hosts|sudoers|profile|paths)`) },
  { id: 'containers', reason: 'runs a container with host-level access', test: /\b(docker|podman|nerdctl)\s+(run|exec|create)\b[^\n]*(--privileged|-v\s+\/:|--volume[= ]\/:|--pid[= ]host|--network[= ]host|\/var\/run\/docker\.sock)/ },
]

const SAFE_ABSOLUTE = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)./

/** A recursive rm whose target is the disk, a home folder, a parent folder, a bare glob, or an absolute path outside temp. */
export function wideDelete(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/)
    const at = words.findIndex(w => w === 'rm' || w.endsWith('/rm'))
    if (at < 0) continue
    const args = words.slice(at + 1)
    const recursive = args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
    if (!recursive) continue
    for (const raw of args.filter(a => !a.startsWith('-'))) {
      const target = raw.replace(/^["']|["']$/g, '')
      if (target === '/' || target === '/*' || target === '*' || target === '.*') return true
      if (/^(~|\$HOME|\$\{HOME\})(\/|$)/.test(target)) return true
      if (target === '..' || target.startsWith('../')) return true
      if (target.startsWith('/') && !SAFE_ABSOLUTE.test(posix.normalize(target))) return true
      if (!target.startsWith('/') && posix.normalize(target).startsWith('..')) return true
    }
  }
  return false
}

/**
 * Floor rules whose effect lands on another machine (a registry, a cluster, a
 * shared remote). The sandbox cannot contain those if a credential happens to
 * be reachable from the project (a token in `.npmrc` or a remote URL, a
 * variable in `keepEnv`), so they ask a person even when the command would run
 * inside the sandbox. Everything else on the floor is contained by the sandbox
 * and only matters once a command asks to leave it.
 */
export const OUTWARD_RULE_IDS: ReadonlySet<string> = new Set(['publish', 'deploy', 'history-rewrite', 'remote-shell'])

/** Floor rule ids, for docs and `trustedCommands` messages. */
export const FLOOR_RULE_IDS = [...RULES.map(rule => rule.id), 'wide-delete']

export function checkFloor(command: string, trusted: readonly string[] = []): FloorHit | undefined {
  // A trusted pattern must match the whole command, so it cannot excuse whatever is chained after it.
  for (const pattern of trusted) {
    try {
      if (new RegExp(`^(?:${pattern})$`).test(command.trim())) return undefined
    } catch {
      // invalid patterns are reported by config loading
    }
  }
  for (const rule of RULES) {
    if (rule.test.test(command)) return { id: rule.id, reason: rule.reason }
  }
  if (wideDelete(command)) return { id: 'wide-delete', reason: 'deletes outside the project or across the whole disk' }
  return undefined
}
