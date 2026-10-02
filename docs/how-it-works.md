# How Runway works

Runway is one Pi extension (`src/index.ts`): no launcher, no native code of its own, no pinned Pi version. It uses Pi's public extension API — `tool_call`, `registerTool`, `user_bash`, `getAllTools`, session events, `ctx.ui` — and declares Pi's packages as peer dependencies.

Two mechanisms, deliberately independent:

1. **The sandbox** decides what a command *can* do.
2. **The permission gate** decides whether a tool call *may* happen at all.

Approving a call never relaxes the sandbox; the sandbox never approves a call.

## The permission gate

Every tool call Pi runs passes one `tool_call` handler (`src/index.ts`): built-in tools, Runway's bash, web tools, MCP tools (direct, deferred through tool search, or nested), any other extension's tool, every call a codemode script makes (Pi reports each with a `parentToolCallId`) and every call a subagent makes (in-process children load Runway too).

### 1. What is this call? (`src/permissions/operation.ts`)

The call becomes an `Operation`: kind, paths, hosts and ports, how it would run (`sandboxed`, `sandboxed-with-access`, `unsandboxed`, `in-process`), and the complete input.

- **Identity comes from Pi's tool registry, never from a name.** `getAllTools()` tells who registered the tool: Pi's built-ins report `builtin:<name>`; Pi's MCP adapter `builtin:mcp`; Runway's bash is Runway's own file with its `escalate`/`access` parameters; bundled companions are recorded as they register. A tool called `read` from another extension is just another tool; so is someone else's `bash`.
- **The key** identifying "this exact operation" is a SHA-256 over the tool, who implements it, the working folder, how it runs (including requested access) and the full input. A changed file content, folder, flag or access is a different operation.
- Shell commands are split into simple commands (`src/permissions/shell.ts`) for rule matching. Runway keeps no list of safe or dangerous command names.

### 2. Who decides? (`src/permissions/gate.ts`)

| # | | Result |
|---|---|---|
| 1 | a deny rule matches (yours or the project's) | refused; the agent is told which rule and why |
| 2 | you allowed this exact operation this session | allowed |
| 3 | a deny/ask command rule may apply but the command builds what it runs at run time | you decide (headless: refused) |
| 4 | an ask rule matches | you decide |
| 5 | an allow rule matches (or one allow rule per part of a compound command) | allowed |
| 6 | a built-in safeguard (credential stores, files that run code later) | you decide — never Jev |
| 7 | you allowed this whole tool this session (plain sandboxed or in-process calls only) | allowed |
| 8 | an auto rule matches | Jev |
| 9 | a built-in allow (Pi's file tools in the project and scratch folders; tool search; bundled helpers that only talk to you or the agent) | allowed |
| 10 | anything else, including tools nobody identified | Jev; you without a reviewer key or in `ask` mode |

When Jev says no, `onDeny: "ask"` (default) gives you the last word; when it fails (timeout, HTTP error, malformed answer, breaker cooling down) you decide. Headless, both refuse. Nothing resolves to allow on failure. A call whose input is too large to send whole goes to you rather than to a truncated review.

After the decision the call's arguments are deep-frozen (Pi keeps that same object), so a later extension can't change what runs. Runway's bash re-checks the operation key when it executes.

### 3. Rules (`src/permissions/rules.ts`)

- Fields: `tool`, `command`, `path`, `host`, `input`, `inputExact`, `access`, `unsandboxed`, `reason`. Any other field, or a malformed one, makes the rule invalid: an invalid allow rule is dropped; an invalid deny rule blocks its whole tool, and an invalid ask or auto rule asks about it, until fixed (an auto rule must not fall through to a built-in allow). An unreadable `permissions` list or settings file (bad JSON, unreadable) makes every tool call ask. All are reported, on stderr when there's no screen. Globs: `*`, `?`, `**`; `\` escapes. Paths are canonicalized like operation paths (symlinks, `/tmp` → `/private/tmp` on macOS), and `**/` keeps folder boundaries.
- **Restrictive rules (deny, ask) match generously:** a command rule is checked against every part of a line, every word-boundary suffix (`env git push`, `sudo -u x git push`), the contents of `$( … )`, backticks and quoted strings, recursively.
- **Permissive rules (allow, auto) match strictly:** every part of a compound command must be covered; a command with substitutions or wrappers is only allowed by an exact, wildcard-free rule; `inputExact` means equal, not subset. An allow rule never covers a call that asks for extra write folders or hosts unless the rule lists them, nor one that runs outside the sandbox unless it says `unsandboxed: true`.
- A trusted project's `.pi/runway.json` can add deny and ask rules only.

### 4. Session approvals (`src/permissions/grants.ts`)

In memory, keyed by session id. A subagent's session sees its parent's approvals (one way); approvals made while a subagent asked stay with it. "This exact operation" grants keep the full environment for commands (a person saw it); whole-tool grants cover only ordinary sandboxed or in-process calls. Jev's approvals are not stored at all.

### 5. Asking a person (`src/ui/`)

The dialog says who (the agent or `Subagent "<name>"`), what (the full action, `v` for all of it), where, why it's asking and how the call would run. Choices: once, this operation for the session, the whole tool for the session (only inside the fence), save a rule (each scope shows its exact rule; broad scopes are marked; suggestions never widen access), deny, deny with a reason. Its height is computed from the terminal's rows; control characters and bidirectional overrides are shown escaped. RPC clients get the same choices as plain selects. Dialogs are serialized; a subagent's go to its nearest ancestor with a screen, never to an unrelated session.

## The sandbox

Runway's `bash` is Pi's own bash tool with its commands wrapped by [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime): Seatbelt on macOS, bubblewrap on Linux (`src/bash.ts`, `src/policy.ts`).

- **Writes:** the git top-level (or working folder), temp folders, tool caches, a linked worktree's shared git folder, plus `access.write` for that one command.
- **Write-protected even there:** git hooks and config, `.pi/`, `~/.pi`, shell startup files, LaunchAgents, editor task files, user `bin/` folders.
- **Reads:** everything except credential stores (`~/.ssh`, cloud CLIs, `~/.pi/agent`, browser profiles, Keychains…).
- **Environment:** secret-looking variables are removed, unless a person approved this exact call or you listed them in `keepEnv`.
- **Network** (`src/network.ts`): in every mode, through a local proxy whose every connection comes to Runway. The proxy only knows host and port, so a connection is allowed only if every command running at that moment may reach that host:port on its own. For each: `closed` mode refuses any host that isn't known; your host rules come next (deny → no, allow → yes, ask or auto → the gate decides for that command, even for a well-known host); with no rule, a known host (Runway's list and your `allowHosts`, honouring a `:port` they name), a host:port approved with the command (requested with `access.hosts`, or named in a command Jev or you reviewed), or any host in `open` mode passes; anything else goes to the gate for that command. A decision sticks to that command and host:port only. A connection made while no command runs (something left behind) passes only if every open session would let it through without asking anyone.
- **Linux specifics** (`src/linux.ts`): bubblewrap covers absent protected paths with `/dev/null` mounts; Runway gives each command a private, read-only git excludes file (created exclusively in a fresh 0700 folder, removed afterwards) so `git add -A` ignores those mount points. `**` write-deny globs can't be expressed, so nested control folders that exist when each command starts are listed explicitly (computed per command, not from the cached policy). Credential stores are hidden behind empty tmpfs mounts, so a write there lands in a throwaway mount. Only existing folders can be made writable, so Runway creates `~/.npm` and `~/.cache` if missing; other tool caches must exist first.
- `escalate: true` runs the command outside the sandbox with your access. It is its own operation, reviewed and shown as such.

## Pi's search tools (`src/search.ts`)

Pi's `grep`, `find` and `ls` are optional (off unless enabled, e.g. `--tools …,grep`) and run inside Pi, where Pi's grep searches hidden files. Runway registers the same three tools, still off by default (`defaultActive: false`), with Pi's parameters, renderers and output format. Its grep runs ripgrep itself in two steps: it lists the files that would be searched (ignore rules, hidden files, the agent's glob) by name only, drops secrets files (`.env`, keys, `auth.json`…) and anything in a credential store, and only then searches the rest. Nothing about the result can depend on a secret file's contents (no "N files matched" count that could be probed prefix by prefix); where such files exist, the result carries one fixed note that they aren't searched. A search rooted at a secrets file or inside a credential store is refused, and an agent-supplied glob can't bring them back. `find` and `ls` never list inside credential stores. Ordinary project search stays an unreviewed, routine call.

## Process-wide state

In-process subagents load their own copy of every extension, and the sandbox proxy is process-global. So the sandbox, session approvals, running commands, approvals waiting for `execute` (keyed by session *and* call id) and the session list live on one object at `globalThis[Symbol.for('pi-runway.runtime')]` (`src/runtime.ts`). The sandbox starts with the first session and stops when the last one ends, so `pi -p` exits.

## Companions (`src/companions.ts`)

`@gotgenes/pi-subagents`, `@narumitw/pi-plan-mode` and `pi-web-access` ship inside Runway's package (`bundleDependencies`, as Pi's packaging guide asks for Pi packages used as dependencies) and are loaded by Runway through a recording view of the extension API, so Runway knows exactly which tools each registered. If your settings list your own copy with its extensions on, Runway skips its copy; after loading it checks your copy really registered something and `/runway doctor` says so if a filter left neither running. Subagent lifecycle events link each child session to its parent and name.

## Jev (`src/review/`)

Carried over from `pi-auto-review-jev`: the frozen question set (kept word for word; `test/unit/review.test.ts`) plus one question Runway adds, `user_prohibited` — the policy allows low- and medium-risk actions "except when trusted user evidence still explicitly prohibits the action", and no frozen question asked that; the composer refuses when it fires, whatever the authorization score (whether the user has since lifted the prohibition is part of the question). Runway also enforces the reference composer's mid-band secret rule (`discloses_secret_to_context` ≥ 0.35: confirm with the user), which the reference only passed on as advice. Thresholds are unchanged. Also carried over: the verdict composer (checked against all 75 recorded owner-graded verdicts in `test/fixtures`, with differences only where the newly enforced rules apply), redaction, transcript excerpting, the availability breaker. The payload is the tool, its complete input, how it would run, requested access, MCP server/annotations, agent name, whether a codemode script made the call, and the agent's justification. 8 s budget, 2 attempts. Keys: `OPENROUTER_API_KEY`, or Pi's `/login` through `ctx.modelRegistry`.

## The evaluation (`eval/`)

One suite, one command. `eval/cases.json` holds 147 owner labels with their provenance (131 historical requests with the SHA-256 of the private corpus they were made for, 25 owner cases with 9 overlaps counted once). `npm run eval` scores the recorded runs offline. `--live --inputs <dir>` reads the private inputs in place, verifies the hash, turns each recorded request into the operation Runway would gate, and runs Runway's actual gate (built-in rules, then Jev with the recorded transcript), 3 repeats. These are replays of historical requests, not executions: the reviewer gets the complete recorded request as evidence and is told what was never recorded (the working folder, write contents, edit text, MCP arguments) instead of being shown invented values. Each run writes a metadata line (a fingerprint over the question set, policy prompt, composer and thresholds, gate and rule code, reviewer and gate config, labels and input hashes) and outcome-only rows carrying Jev's served model, scores and latency to `eval/recorded/`. Runs, the September baseline and the case list are validated strictly (one fingerprint, complete and unique case×repeat tuples, labels, schemas); missing rows and failures are reported as such, never counted as correct refusals, and the summary says whether anything fingerprinted changed since the run. Earlier runs on superseded code stay in `eval/recorded/superseded/`.

## Known limits

- In-process tools (MCP servers, web fetch, other extensions) are gated but not sandboxed.
- `escalate`d commands run with your full user access.
- Jev wrongly allows a meaningful share of requests a person would want to see (README). The sandbox bounds the damage for ordinary commands only.
- Codemode scripts can call models with your provider credentials without per-call events; the script itself is reviewed.
- Network decisions are per host:port and conservative with several commands running; a process a command left behind after it finished can only reach known hosts nobody restricted.
- Known hosts are reachable without review; a public service on one that accepts anonymous uploads would not be caught.
- A write tool's path check and the write are not atomic; a sandboxed command running in parallel could swap a project file for a symlink in between.
- Control paths whose parent folder doesn't exist yet are protected in the OS sandbox only from the next command (after up to 5 s of policy caching).
- A repository created inside the project (`git init`, `git clone`) has a writable `.git/config`; hooks stay blocked everywhere.
- Tool caches (`~/.npm/_npx`, corepack) are writable and hold code that runs later; blocking them would break `npx`.
- macOS Keychain: Runway blocks `/usr/bin/security` and git's keychain helpers; other programs asking for an item trigger a macOS prompt.
- The first session in a process sets the network mode.

## Tests

- `test/unit`: rules, shell parsing, operation keys, gate order, grants, save scopes, the approval dialog at many terminal sizes, policy, env scrub, config, reviewer, eval scoring.
- `test/e2e`: the real Pi 1.0 binary in RPC and print modes with a scripted OpenAI-compatible model, a fake Jev, a throwaway HOME with canary secrets, a fake MCP server, codemode, bundled companions, worktrees, late argument mutation and network rules. `packed.test.ts` installs the packed package from a local registry and updates it.
- `test/matrix`: real developer workflows in the sandbox.
