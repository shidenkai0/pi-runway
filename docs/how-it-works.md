# How Runway works

Runway is one Pi extension (`src/index.ts`) with no launcher, no native code of its own and no pinned Pi version. It uses Pi's public extension API: `registerTool`, `tool_call`, `user_bash`, session events, `ctx.ui`, and `ctx.modelRegistry`.

## The one idea

**Contain by default, review only what leaves the container.**

1. **Sandbox (`src/bash.ts`, `src/policy.ts`, `src/runtime.ts`).**
   - Runway replaces Pi's `bash` tool with the same tool, whose commands are wrapped by [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime): Seatbelt on macOS, bubblewrap on Linux.
   - The rules are computed per command from the session's working directory. Commands may:
     - write to the git top-level (or cwd), temp folders, tool caches, and a linked worktree's shared git dir;
     - read everything except credential stores;
     - reach known package and code hosts through a local proxy.
   - Secret-looking environment variables are removed (`src/env.ts`).
   - Control files are write-protected, both by the OS sandbox and in Runway's own checks. These are the files that turn a write into code that runs later outside the sandbox: git hooks and config, `.pi/`, `~/.pi`, shell rc files, LaunchAgents, tool `bin/` folders.
2. **Pi's own file tools (`tool_call` in `src/index.ts`).**
   - `read`, `write`, `edit`, `grep`, `find` and `ls` run inside Pi, not in the sandbox.
   - Their paths are resolved (including dangling symlinks) and checked against the same policy. A violation becomes an escalation.
3. **Escalation (`src/escalate.ts`).** Anything that wants out is one `Escalation`:
   - a bash call with `escalate: true` and a `justification`;
   - a connection to an unknown host (the proxy's ask callback);
   - a file-tool path outside the policy.

   A few floor rules are *outward*: publish, deploy, history rewrite and remote shells. These take effect on another machine. If a credential is reachable from inside the project (a token in a project `.npmrc` or a git remote URL, a variable in `keepEnv`), the sandbox cannot contain them. So they ask a person even when the command would run inside the sandbox. The rest of the floor applies only once a command asks to leave the sandbox, because inside it the sandbox already limits the effect.

   The decision order:
   1. **The floor (`src/floor.ts`)** always goes to a person: privilege, pipe-to-shell, publish, deploy, history rewrite, wide deletes, disk/system changes, security settings, credential access, control files, privileged containers and remote shells. It never goes to the reviewer. Headless runs refuse.
   2. **`ask` mode:** a person decides.
   3. **`auto` mode:** Jev decides (`src/review/`).
      - **Allow:** the command runs outside the sandbox, still without secret environment variables. A person-approved command gets the full environment.
      - **Deny:** by default the action is blocked and the model gets a plain reason and instructions to ask the user in chat. `onDeny: "ask"` lets a person overrule instead.
      - **Reviewer failure** (no key, timeout, HTTP error, malformed answer, cooldown after repeated failures): a person decides, or the action is refused headless. It never resolves to allow.
4. **People (`src/runtime.ts`).**
   - A dialog is shown in the session's own UI. For an in-process subagent with no UI, it goes to the most recent session that has one.
   - Dialogs are serialized.
   - With nobody to ask, the answer is no.

## Process-wide state

In-process subagents (`@gotgenes/pi-subagents`) load their own copy of every extension, and sandbox-runtime's network proxy is process-global. So the sandbox, session grants, the running-command registry and the list of sessions live on one object at `globalThis[Symbol.for('pi-runway.runtime')]`.
- The sandbox starts on the first session.
- It stops when the last session ends; without that, `pi -p` would never exit.
- It is never reset by a child session.

## Jev

`src/review/` is carried over from `pi-auto-review-jev`:
- the frozen question set (byte-identical to the evaluated one; `test/unit/review.test.ts` checks it);
- the verdict composer (reproduces all 75 recorded owner-graded verdicts);
- redaction, transcript excerpting, the availability breaker, and the Codex-derived policy prompt.

What changed is the glue:
- no permission-engine dependency;
- an 8 s budget with 2 attempts;
- the reviewer sees the child's own transcript for subagent escalations.

Keys are found through `OPENROUTER_API_KEY`, `ctx.modelRegistry.getApiKeyForProvider('openrouter')` (Pi's `/login`, `auth.json`, `!command`), or `auth.json`.

## Known limits

- **An approved escalation runs outside the sandbox with the user's full access.** It can read files, use credential helpers and reach any host. Only secret environment variables are removed, and only for reviewer-approved runs. This boundary is stated in the dialog, in the notification, in the reviewer payload and in the README. A narrower "wider sandbox" tier (writes anywhere, credentials still unreadable) is possible, but would mean two escalations for pushes and similar actions; not built.
- **Reviewer figures are historical.** They come from Jev on permission prompts from an earlier setup (`eval/historical`, `node eval/summary.ts`), not from Runway's escalations, which have not been evaluated.

- In-process tools of other extensions (web fetch, MCP) are not sandboxed.
- `tool_call` input can be mutated by extensions that run after Runway. Bash decisions are made inside `execute`, where arguments are final. File-tool checks are not.
- Known hosts are reachable without review. Exfiltration to them needs credentials that commands cannot see, but a public service that accepts anonymous uploads on a known host would not be caught.
- A write tool's path check and the write itself are not atomic.
- Control paths whose parent folder does not exist yet are protected in Pi's file tools immediately. In the OS sandbox they are protected only from the next command (after at most 5 s of policy caching), not within the command that creates the parent. This is needed so tools can create `~/.cargo` and similar folders on first use.
- A new repository created inside the project (`git init`, `git clone`) has a writable `.git/config`. Hooks stay blocked everywhere, and the repository you work in keeps its config protected.
- A `pi` started from inside the sandbox cannot read Pi's credentials. Use in-process subagents.
- **Keychain (macOS):** the sandbox cannot stop commands from talking to the Keychain service. Runway blocks the programs that tokens usually trust without prompting: `/usr/bin/security`, and git's osxkeychain and Credential Manager helpers. Other programs asking for a Keychain item make macOS show a prompt.
- **Session approvals** (hosts; Pi's file tools for a folder) are shared by a session and its in-process subagents, and cleared when the last session ends. They never widen what sandboxed commands may write.
- **Network mode** is set by the first session in the process; later sessions do not restart or loosen the proxy.
- **Read race:** a sandboxed command running in parallel could swap a project file for a symlink between Runway's check and Pi's read tool opening it.
- **Tool caches are writable:** `~/.npm/_npx`, the corepack cache and similar folders hold code that runs later. Blocking them would break `npx`. pnpm's global bin folder (`PNPM_HOME`) is not writable; only its store is.
- **Mid-band secret signal:** Jev's "possible secret disclosure" signal between 0.35 and 0.7 does not block on its own. In the recorded evaluation, the only case in that band is the owner-graded allow for using a key through an environment variable without printing it.
- **Always-ask list:** it is a fixed list of patterns, not a shell parser. Commands it does not recognise still go to the reviewer; they never run silently.

## Tests

- `test/unit`: policy, floor table (130+ commands), env scrub, config, reviewer (including eval replay).
- `test/e2e`: the installed `pi` in RPC and print modes. It uses a scripted OpenAI-compatible fake provider, a fake Jev endpoint, a throwaway HOME with canary secrets, and optionally a local copy of `@gotgenes/pi-subagents` (`npm run e2e:deps`).
- `test/matrix`: real developer workflows in the sandbox, reporting which ones would need an escalation.
