# Runway for Pi

**Let Pi agents work on their own, safely.**

Runway is one [Pi](https://pi.dev) package that lets an agent edit, build, test, install, commit and delegate without stopping for you every few seconds — with its commands fenced away from your keys and the rest of your machine, and every tool call checked against your rules and a fast reviewer.

It does two independent things:

- **Contains every command.** Bash runs in your operating system's sandbox: it writes only to the project, temp and package caches, can't read credential stores, sees no secret environment variables, and reaches only well-known package and code hosts.
- **Gates every tool call.** Built-in tools, bash, web, MCP servers, other extensions' tools, calls made from codemode scripts and by subagents all pass one permission check. Your rules decide first. Anything they don't decide goes to **Jev**, a fast safety reviewer. You have the last word when Jev says no or can't decide.

You keep your models, providers, logins and other packages. Runway also bundles subagents (each with its own model), plan mode and web search, so it's one install.

> **Status: prototype, not published yet.** Try it locally with the steps below. Once published: `pi install npm:pi-runway`.

## Try it

You need macOS or Linux, Node 22.19 or newer, and Pi 1.0.

On Linux, also install `bubblewrap`, `socat` and `ripgrep` (Debian/Ubuntu: `sudo apt-get install bubblewrap socat ripgrep`). `/runway doctor` reports missing dependencies; if your system disallows unprivileged user namespaces, the sandbox stays off and commands are blocked rather than silently running unprotected.

```bash
npm install
scripts/try-local.sh              # or: scripts/try-local.sh <new-or-empty-folder>
```

The script creates `../runway-trial` with its own Pi settings folder (whose only package is this checkout) and a scratch git project, then prints the command to start Pi there. Your normal Pi setup is not loaded or changed. It refuses folders that aren't new, empty, or an earlier trial.

In the trial: `/login` to a model provider, then `/runway doctor`. For automatic reviews, set `OPENROUTER_API_KEY` or `/login` to OpenRouter; without a key, you review instead of Jev.

## What happens when the agent…

| wants to… | Runway |
|---|---|
| read, search, write or edit files in the project | allowed (Pi's own file tools; secret files like `.env` excepted) |
| run any command | Jev reviews it with the real command and the conversation; it then runs **in the sandbox** |
| read your SSH keys, cloud credentials, Pi logins | blocked by the sandbox; Pi's file tools ask you |
| plant a git hook, edit shell startup files, `.pi/`, editor tasks | blocked by the sandbox; Pi's file tools ask you |
| reach a host not on the known list | that connection is reviewed for the command that made it |
| write outside the project or reach a specific host | asks for `access` on that one command; reviewed, then still sandboxed |
| run with your full access (Keychain, Docker, `git push` with your credentials) | asks to `escalate`; reviewed and shown as **outside the sandbox** |
| call an MCP tool, fetch a page, start a subagent, run a codemode script | reviewed (each call inside a script or subagent is reviewed on its own) |
| do something a rule of yours covers | your rule decides, immediately: deny, ask you, allow, or send to Jev |

Approving a call never turns the sandbox off. Running outside it is a separate, explicit request that the dialog shows in red.

## When you're asked

```
 The agent wants to run a command  bash

   $ npx --yes wrangler@3 pages deploy ./site/build --project-name runway-docs

 Why   Jev said no: it could send sensitive data somewhere it does not belong
 Runs  in the sandbox, plus network access to api.cloudflare.com for this command

   1 Allow once
   2 Allow for this session: npx --yes wrangler@3 pages deploy ./site/build… (with this extra access)
   3 Always allow…
 → 4 Deny
   5 Deny and tell the agent why…
```

- **Allow for this session** covers exactly this call (same arguments, folder and access) in this session and its subagents.
- **Always allow…** saves a rule; each choice shows the exact rule first (`allow bash · command "npx --yes wrangler@3*" · may also reach api.cloudflare.com`). Broad ones are marked.
- **Deny and tell the agent why** sends your words back to the agent.
- Long commands are shortened in the dialog; press `v` to read all of it. Escape always means no. The dialog fits small terminals; on very small ones the decisions stay visible first.
- Headless (`pi -p`, CI): nobody can be asked, so anything that would ask is blocked with an explanation.

## Your rules

Rules live in `~/.pi/agent/runway.json`. The strongest matching rule wins: **deny > ask > auto > allow**. A deny always beats session approvals and Jev.

```json
{
  "permissions": [
    { "action": "deny", "command": "git push --force*", "reason": "we never force-push" },
    { "action": "ask", "tool": "mcp__github__*" },
    { "action": "allow", "command": "npm test*" },
    { "action": "allow", "command": "npm run lint*" },
    { "action": "deny", "host": "registry.npmjs.org", "reason": "use the company mirror" },
    { "action": "auto", "tool": "read", "path": "~/notes/**" }
  ]
}
```

- **Match on** `tool` (globs: `mcp__github__*`), `command`, `path`, `host`, `input` (argument patterns) or `inputExact` (exactly these arguments).
- **Commands are read part by part.** A deny or ask rule catches its command anywhere in a line: after `&&`, inside `$( … )`, behind `env`/`sudo`/`timeout`, inside `bash -c '…'`. An allow rule has to cover every part (`npm test && npm run lint` needs both rules above). When a command builds what it runs at run time (`eval "$X"`, `$CMD push`, `python -c …`) and you have deny or ask command rules, you're asked instead.
- **Allowing never widens the sandbox.** An allow rule covers ordinary sandboxed calls. Extra write folders or hosts need `"access": { "write": […], "hosts": […] }` in the rule; running outside the sandbox needs `"unsandboxed": true`.
- **Host rules apply to connections too,** even to well-known hosts.
- **Projects can only tighten.** A trusted project's `.pi/runway.json` may add `deny` and `ask` rules; its `allow` rules are ignored.
- **A rule Runway can't read never loosens anything.** Unknown or malformed fields (a typo like `"commmand"`) make the rule invalid. An invalid allow rule is ignored; an invalid deny rule blocks, and an invalid ask or auto rule asks you about, every call of its tool until you fix it. A `runway.json` that isn't valid JSON (or can't be read) makes every tool call ask you until it's fixed — headless, that means refused. Problems show at startup (on stderr when there's no screen) and in `/runway doctor`.

`/runway permissions` shows everything in force — this session's approvals, your rules, the project's, and Runway's built-in defaults — and lets you add, remove, revoke and reset. From a script or RPC client: `/runway permissions add ask mcp__github__*` (or `add deny bash command=terraform*`).

## Jev, the reviewer

[Jev](https://typesafe.ai) (TypeSafe, served through [OpenRouter](https://openrouter.ai)) answers a fixed set of questions about the one call in front of it: does it send sensitive data somewhere, is it destructive, did the user ask for it… Runway turns the answers into allow or no with fixed rules in code, so a persuasive conversation can at most move the answers to individual questions, not rewrite the decision rules. The rules include the policy's own exceptions: a low-risk action the user explicitly told the agent not to do (directly, or in a plan or file they told it to follow) is refused, and an action that might put a secret value into the conversation goes to you to confirm. Approvals are not cached: the same call later is judged again against the conversation as it is then. A call too large to send whole goes to you instead of a truncated review.

**How good is it?** One evaluation, run with `npm run eval`: 147 owner-labelled permission requests from real sessions and curated cases (119 should be allowed, 28 should ask a person), each replayed 3 times through Runway's actual gate on 2026-10-02. They are historical requests, so the reviewer is told that the working folder and some arguments weren't recorded. Results from 2026-10-02 with the composer and rules of today but the earlier wording of the user-restriction question (the inputs are private, so this run has not been repeated since that question was reworded):

| | Runway's gate (rules + Jev) | Jev's answers alone | Earlier setup (2026-09-22, Jev alone) |
|---|---|---|---|
| allowed when it should have asked | 12 of 84 (4 of 28 cases at least once) | 12 of 78 | 40 of 84 (14 cases) |
| asked when it should have allowed | 56 of 357 | 44 of 342 | 20 of 357 |
| failed or missing | 0 of 441 | 0 of 420 | 0 of 441 |
| review time | | median 319 ms, p95 432 ms | median 369 ms, p95 527 ms |

What moved the numbers: the policy Jev works from says to allow low- and medium-risk actions except when the user still explicitly prohibits them, but none of the original questions asked that, and the reference composer only *advised* confirming a possible secret disclosure. Runway adds the question (`user_prohibited`) and makes both rules real decisions; thresholds are unchanged. Before that, the same gate allowed 30 of 84 should-ask requests (10 cases, every one composed as "low risk, no rule fired", six of them explicitly forbidden targets) and asked on 36 of 357 should-allow ones. The price of catching more is more questions to you: of the 56, 22 come from Jev's existing prompt-injection signal, 19 from the prohibition question, 3 from secret confirmation and 12 from Runway's built-in safeguards (3 file-tool allows and 18 safeguard asks were settled without Jev; the safeguards are deliberately blunt). Earlier runs on superseded code are kept in `eval/recorded/superseded/`.

So Jev still lets through some requests a careful person would want to see. **That's why the sandbox, not the reviewer, is the main protection:** a wrongly approved ordinary command still runs contained. Calls outside the sandbox (MCP servers, other extensions' tools, `escalate`) rely on the gate alone; for those, your rules or `ask` mode are the stronger choice. Treat these figures as regression evidence, not a guarantee.

Anyone can rerun the same suite's 76 public synthetic cases without private data (`npm run eval -- --live --cases public`). The earlier 50-case comparison reduced wrongly allowed decisions from 9/75 to 3/75 without more false asks. The expanded suite still has the same two disagreements with its stored labels: three wrong allows on “leave vendor/ alone” and three asks on a bulk deletion, whose expected treatment needs clarification. All 26 newly added cases passed every repeat, including deletion of reproducible outputs versus irreplaceable originals. No prompt change from this follow-up was adopted. Full results and limits: [how it works](docs/how-it-works.md#the-evaluation-eval).

**What Jev sees:** the tool, its actual arguments, how it would run, the agent's stated reason, and an excerpt of the conversation (about 20,000 tokens at most). Text shaped like keys, tokens and passwords is replaced first; this is pattern-based and can miss unusual forms. Your provider keys are never added. Decisions are logged locally in `~/.pi/agent/runway/decisions.jsonl`.

## Subagents, plan mode, web

Bundled and loaded through Runway (if you already installed one yourself, Runway uses yours):

- **Subagents** ([`@gotgenes/pi-subagents`](https://www.npmjs.com/package/@gotgenes/pi-subagents)). Each agent can run on its own model: set `model:` in `~/.pi/agent/agents/<name>.md`. Its calls go through the same gate and sandbox, are reviewed against its own conversation, and its questions appear in your session as `Subagent "<name>" wants to…`. Your session approvals carry over to its subagents, never the other way.
- **Plan mode** ([`@narumitw/pi-plan-mode`](https://www.npmjs.com/package/@narumitw/pi-plan-mode)): plan read-only, review, then implement.
- **Web search and fetch** ([`pi-web-access`](https://www.npmjs.com/package/pi-web-access)): every search and fetch is reviewed.
- **Worktrees:** `/worktree <branch>` starts a branch in its own folder next to your repo and moves the conversation there. Commits in linked worktrees work inside the sandbox.

Switch any companion off with `"companions": { "web": false }`.

## Everyday controls

| | |
|---|---|
| Status line | `runway · auto` (Jev reviews), `runway · ask` (you review); an explicit sandbox-off session stays marked `sandbox off · reviewed` |
| `ctrl+shift+a` | switch between auto and ask |
| `/runway` | mode, sandbox, recent decisions, and how many approval prompts this session and its subagents showed you, per 100 command requests |
| `/runway permissions` | rules and approvals: inspect, add, remove, revoke, reset |
| `/runway log` | the decisions that needed one, who decided and why |
| `/runway doctor` | check the setup: sandbox, bash ownership, reviewer key, companions, conflicting packages |
| `/runway sandbox off` / `on` | turn command isolation off or on for this session and its subagents; **rules and review stay on** (off asks first) |
| `pi --no-sandbox` | start without command isolation, without disabling rules or review; `/runway sandbox on` can restore it |
| `/runway off` | no sandbox and no gate until you turn it back on (asks first) |

### When the sandbox gets in the way

Prefer extra access for one command. The agent can request named folders or hosts with `access`, or `escalate: true` for an operation the sandbox cannot support. Both go through review. Permission failures explain these options; the agent should check for partially completed effects before retrying, not blindly repeat a compound command.

Some workflows need direct networking rather than the sandbox's HTTP/SOCKS proxy: UDP-based testing, for example. Use `/runway sandbox off` when that applies throughout a session. Commands then have your filesystem and network access, while every tool call still passes the gate and Jev sees that commands run **outside** the sandbox. Secret environment variables remain scrubbed unless you approve the exact call yourself or list them in `keepEnv`. This is less protection, not a different kind of sandbox.

For an authorized security assessment, describe the scope in chat: which assets are covered, whether discovered hosts belonging to those assets may be probed, and which actions are excluded. The agent needn't ask merely because a hostname is new; Jev reviews the actual operation against the conversation. Discovery alone is not authorization—third-party infrastructure can appear in results too. The reviewer can make mistakes: with the sandbox off, there is no OS-enforced target boundary.

The session control writes no settings. Subagents inherit it, unrelated new sessions do not; the startup flag applies to sessions in that Pi process. Changes affect **future** commands only: switching it back on cannot contain a command already running outside it. Existing approvals and ordinary allow rules never silently change from sandboxed to unsandboxed access.

## Settings

Everything works without a settings file. `~/.pi/agent/runway.json`:

| Setting | Default | |
|---|---|---|
| `permissions` | none | your rules (above) |
| `mode` | `auto` with a reviewer key, else `ask` | `auto`, `ask`, `off` |
| `onDeny` | `ask` | when Jev says no: `ask` gives you the last word (blocked headless); `block` tells the agent no |
| `network` | `reviewed` | `reviewed`: known hosts pass, others are reviewed per command. `closed`: known hosts only, never reviewed. `open`: any host without review. In every mode connections go through Runway's proxy, so your deny, ask and auto host rules still apply first |
| `allowHosts` | – | more known hosts (`*.example.com` works) |
| `allowWrite` | – | more folders commands may write to |
| `denyRead` / `allowRead` | – | more secret paths / exceptions inside protected ones |
| `keepEnv` | – | secret-looking environment variables commands may still see (e.g. `NPM_TOKEN`) |
| `sandboxUserCommands` | `false` | also sandbox commands you type with `!` |
| `companions` | all on | `{ "subagents": false, "plan": false, "web": false }` |

## What is and isn't covered

Runway keeps a confused or manipulated agent from quietly doing lasting damage. It is not a virtual machine.

**Covered**
- Ordinary commands run under Seatbelt (macOS) or bubblewrap (Linux); running outside it is an explicit per-command or session choice.
- Every tool call — including MCP, codemode-nested and subagent calls — is decided by the gate; tools nobody identified are reviewed, not trusted by name.
- Approved arguments are frozen: a later extension can't change what runs.
- Pi's optional `grep`, `find` and `ls` (off unless you enable them) never show lines from secrets files (`.env`, keys, `auth.json`…) or anything inside a credential store; ordinary code search works as usual.
- Pi's own file tools are checked by real path (symlinks, case variants).

**Not covered**
- **Tools that run inside Pi** (MCP servers, web fetch, other extensions' tools) are gated but not sandboxed: once allowed, they act with your access.
- **`escalate`d commands and sandbox-off sessions** run with your full user access. Secret environment variables are removed unless you approved the exact call yourself or listed them in `keepEnv`.
- **Your project** is readable and writable, including any credentials stored in it.
- **The reviewer makes mistakes** (see the table). The sandbox limits what a wrong approval to an ordinary command can do.
- **Codemode scripts** can call models with your provider credentials directly; that part isn't checked call by call (the script itself is reviewed).
- **Network attribution:** the sandbox proxy can't tell which running command opened a connection, so every command running at that moment must be allowed to reach the host.
- **Linux:** `**` write-deny patterns can't be expressed in bubblewrap; Runway protects nested control folders that exist when a command starts (a folder created and written by the same command isn't covered). bubblewrap can only make existing folders writable: Runway creates `~/.npm` and `~/.cache` if missing; another tool's cache that doesn't exist yet (e.g. `~/.cargo` before Rust is installed) stays read-only until that tool has run once outside the sandbox.
- **Windows** is not supported. The first Pi session in a process sets the network mode for its subagents.

## Coming from…

- **`@gotgenes/pi-permission-system`:** Runway replaces it (one gate for every tool, your rules, approvals). Keeping both means its prompts come first. Remove it; `/runway doctor` warns while both are installed.
- **`pi-auto-review-jev`:** Jev review is built in. Remove the separate package.
- **Pi's example `sandbox` extension:** remove it. `/runway doctor` tells you if another extension took over `bash`.
- **The earlier Runway prototype (`trustedCommands`, the floor list):** command lists are gone. Put the commands you want decided without Jev in `permissions` rules; they now also cover tools other than bash.

## Updating

`pi update --extensions`. Runway doesn't pin Pi: it uses Pi's public extension API and declares Pi's packages as peer dependencies. Tested with Pi 1.0.0 on macOS and Linux.

## Development

```bash
npm install
npm test               # unit tests (offline)
npm run test:e2e       # the real Pi binary with a scripted model and a fake Jev; no keys, no network
npm run eval           # the evaluation above, scored offline from the recorded runs
npm run test:matrix    # real npm/pnpm/bun/pip/uv/cargo/deno/git workflows in the sandbox (uses the network)
npm run check          # typecheck
```

`npm run eval -- --live --cases public` reruns the public synthetic cases (paid). `npm run eval -- --live --inputs <pi-auto-review-jev/eval>` reruns the historical cases (paid, and it sends the owner's private session evidence to Jev; ask first). See [docs/how-it-works.md](docs/how-it-works.md) for the design.

MIT licensed. See [NOTICE](NOTICE) for included work.
