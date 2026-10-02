# Runway for Pi

**Let Pi work on its own, with a safety net.**

With Runway, [Pi](https://pi.dev) can edit, build, test, install packages and commit without stopping to ask you every few seconds. Every command it runs is fenced into your project: it can't read your keys, can't touch the rest of your machine, and can only reach well-known package and code hosts.

When the agent needs to go past that fence, it has to ask:
- **Commands:** if it asks to run a command outside the fence, a safety reviewer (Jev) decides. **An approved command runs with your full user access.**
- **Consequential actions:** publishing, deploying, force-pushing, `sudo` and a few others come to you.
- **Your choice:** you can have every request come to you instead of the reviewer.

You keep your models, providers, subscriptions and other Pi packages. Runway adds the fence and the reviewer.

> **Status: prototype, not published yet.** Try it locally with the steps below. Once published, installing will be `pi install npm:pi-runway`.

## Try it

You need macOS (Linux support is built in but not yet tested), Node and Pi. This checkout needs `npm install` once; the trial script runs it for you.

```bash
scripts/try-local.sh              # or: scripts/try-local.sh <new-or-empty-folder>
```

The script creates `../runway-trial` next to this checkout. It holds a separate Pi settings folder (`agent/`, whose only package is this checkout) and a scratch git project (`project/`). It then prints the exact command to start Pi there.

The trial folder must be new, empty, or a trial the script made before. It refuses anything else without writing a file, including your home folder, `~/.pi`, temp folders, and folders with existing content, however the path is spelled.

Your normal Pi setup (settings, logins, extensions, sessions) is not loaded or changed. Inside the trial:
1. Run `/login` to sign in to a model provider (stored only in the trial folder).
2. Run `/runway doctor`.

For automatic reviews, also set `OPENROUTER_API_KEY` before starting Pi, or `/login` to OpenRouter. Without it, you are asked instead.

---

## What changes

| The agent wants to… | What happens |
|---|---|
| Edit files, run tests, build, start a dev server | Just happens, inside the fence |
| Install packages from npm, PyPI, crates.io, JSR… or clone from GitHub | Just happens, inside the fence |
| Commit, branch, rebase — including in a linked git worktree | Just happens, inside the fence |
| Read your SSH keys, cloud credentials or Pi logins | Blocked. Commands can't see them, and secret-looking environment variables are removed |
| Plant a git hook, edit shell startup files, editor tasks or Pi's own settings | Blocked |
| Reach a website it hasn't used before | Reviewed once, then allowed for the session (or blocked) |
| Run a command outside the fence (for example `git push` with your credentials, `gh pr create`, `docker compose up`) | Reviewed. **If approved, it runs with your full user access.** Only secret environment variables stay removed |
| Publish, deploy, force-push, open a remote shell | **Asks you**, even inside the fence |
| Use `sudo`, delete outside the project, touch credentials, outside the fence | **Asks you** |

When the reviewer says no, the agent is told why and adapts, usually by finding another way or by asking you in the chat. If you confirm there, the reviewer sees your confirmation next time.

The "asks you" rows come from a fixed list of command patterns, not from understanding every command. A risky command the list doesn't recognise:
- inside the fence, is limited by the fence;
- outside the fence, goes to the reviewer.

## The reviewer

Automatic reviews use **Jev**, a small safety model from [TypeSafe](https://typesafe.ai), through [OpenRouter](https://openrouter.ai). It answers a fixed set of questions about the one action in front of it, such as:
- does this send sensitive data somewhere?
- is it destructive?
- did the user ask for it?

Runway turns the answers into a decision with fixed rules, so Jev can't talk its way into an approval.

It's fast and cheap, and it makes mistakes, as a recorded evaluation shows (September 2026, reproducible with `node eval/summary.ts`):
- **Coverage:** 441 reviews of real and curated permission requests from an earlier setup, 147 cases × 3 repeats.
- **Speed and cost:** median 369 ms (95th percentile 527 ms), about $0.0006 per review.
- **Missed asks:** in 84 attempts where a careful person would have asked first (28 cases × 3), Jev approved 40, across 14 distinct cases.
- **False alarms:** it wrongly asked in 20 of 357 attempts that should have been allowed.

Those requests are not the same as Runway's escalations, and Runway's own review traffic has not been measured yet. That is why the fence, not the reviewer, is the main protection. It is also why the most consequential actions come to you, and why `ask` mode is one keypress away.

- **Setup:** Runway uses `OPENROUTER_API_KEY` or your OpenRouter login in Pi.
- **No key?** Everything still works: requests to leave the fence come to you (`runway ask`).

## Everyday controls

| | |
|---|---|
| Status line | `runway auto` (Jev reviews), `runway ask` (you review), `runway off` |
| `ctrl+shift+a` | Switch between auto and ask |
| `/runway` | What's allowed right now, and the last few decisions |
| `/runway log` | Everything that left the fence, who decided, and why |
| `/runway doctor` | Check the setup and spot conflicting packages |
| `/runway off` | No fence, no reviews, until you turn it back on (asks first) |
| `/worktree <branch>` | Start a new branch in its own folder next to your repo and move the conversation there |

## Subagents

Runway works with [`@gotgenes/pi-subagents`](https://www.npmjs.com/package/@gotgenes/pi-subagents). Subagents run inside the same fence; if one needs your approval, the question appears in your main session. To give a subagent its own model, set `model:` in its definition (any `provider/model` from `pi --list-models`), e.g. `~/.pi/agent/agents/scout.md`:

```markdown
---
description: Reads code and reports back
tools: read, bash
model: openrouter/<a-cheaper-model>
---
You explore the codebase and summarize what you find.
```

## Settings (optional)

Everything works without a settings file. To adjust, create `runway.json` in your Pi settings folder (`~/.pi/agent/`, or the trial's `agent/` folder):

```json
{
  "network": "reviewed",
  "allowHosts": ["api.mycompany.dev"],
  "allowWrite": ["~/datasets"],
  "onDeny": "block"
}
```

| Setting | Default | |
|---|---|---|
| `mode` | `auto` with a reviewer key, else `ask` | `auto`, `ask` or `off` |
| `network` | `reviewed` | `reviewed`: known package/code hosts pass, new ones are reviewed. `open`: any host. `closed`: known hosts only |
| `onDeny` | `block` | `block`: the agent is told no and adapts. `ask`: you get to overrule the reviewer |
| `allowHosts` | – | Hosts that never need review (`*.example.com` works) |
| `allowWrite` | – | Extra folders commands may write to |
| `denyRead` / `allowRead` | – | Extra secret paths / exceptions inside the protected ones (e.g. `~/.codex/sessions`) |
| `keepEnv` | – | Environment variables commands may still see (e.g. `NPM_TOKEN`). Anything kept here is usable inside the fence |
| `trustedCommands` | – | Regexes for whole commands that skip the "asks you" list (they're still reviewed when they leave the fence) |
| `sandboxUserCommands` | `false` | Also fence commands you type yourself with `!` |

A project can add `.pi/runway.json` to make Runway **stricter** for that repository, never looser.

## What the fence covers — and what it doesn't

Runway is designed so that a confused or manipulated agent can't quietly do lasting damage. It is not a virtual machine.

**Covered:**
- **Commands** run under the operating system's own sandbox (Seatbelt on macOS; bubblewrap on Linux, untested).
- **Writes** only to your project, temporary folders and package caches.
- **Reads:** no credential stores; on macOS, no Keychain tools.
- **Network:** no website outside the known list without a review.
- **Pi's own file tools** (read, write, edit) are checked against the same rules, including through symlinks and letter-case tricks.

**Not covered:**
- **Approved commands outside the fence.** A command the reviewer (or you) approved to leave the fence runs with your full user access: it can read your files, use your credential helpers and reach any host. Only secret environment variables are removed, and only when the reviewer approved it.
- **Pi itself and other extensions' tools.** Web fetch, MCP servers and similar tools run outside the fence.
- **Your project.** It is readable and writable, including any `.env` files and any credentials stored inside it (for example a token in a project `.npmrc` or a git remote URL). Commands inside the fence can use those.
- **Known package and code hosts.** They are reachable without review.
- **Session approvals.** Approvals "for this session" also apply to that session's subagents. The first session in a Pi process sets the network mode for all of them.

## What is sent to the reviewer

Only when the agent asks to leave the fence, Runway sends Jev (through OpenRouter):
- **The action:** the command, path or host, and the agent's stated reason.
- **The conversation:** an excerpt of up to roughly 20,000 tokens of recent messages and tool output. For a short conversation, that can be all of it.

Before sending, Runway replaces text that looks like a key, token, password or private key. This matching is pattern-based and can miss secrets written in unusual forms. Runway never adds your model-provider keys to the request; if one appears in the conversation itself, only the redaction stands between it and the reviewer. The OpenRouter key is used only to authenticate the review.

Decisions are logged on your machine in the Pi settings folder, under `runway/decisions.jsonl`.

## Coming from…

- **`@gotgenes/pi-permission-system`:** Runway replaces approval prompts with a fence. If you keep the permission system, its `ask` rules still prompt before Runway sees a command. Set its bash rule to `allow`, or remove it.
- **Pi's example `sandbox` extension:** remove it. Runway runs the `bash` tool, and `/runway doctor` tells you if another extension took it over.
- **`pi-auto-review-jev`:** Jev review is built in. Remove the separate package.

## Updating

Once published, `pi update --extensions` updates Runway. Runway doesn't pin your Pi version; it uses Pi's public extension API. It has been tested with Pi 0.87.1 on macOS.

## Development

```bash
npm install
npm test              # unit tests (offline)
npm run test:e2e      # drives your installed `pi` with a scripted fake model and a fake reviewer; no real keys
npm run test:matrix   # runs real npm/pnpm/bun/pip/uv/cargo/deno/git/swift workflows in the sandbox (uses the network)
node eval/summary.ts  # the historical reviewer figures quoted above
```

See [docs/how-it-works.md](docs/how-it-works.md) for the design and its known limits.

MIT licensed. See [NOTICE](NOTICE) for included work.
