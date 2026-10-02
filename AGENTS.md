# Working on Runway

- Product: one Pi package. Contain by default (sandbox), review only escalations (floor, then Jev or a person). Read README.md, then docs/how-it-works.md.
- Keep it small and on Pi's public extension API. Never pin or patch Pi.
- Security rules: decisions fail closed. Reviewer failure never means allow. A project config can only tighten. Secrets never go into logs or fixtures.
- Tests: `npm test` (unit, offline), `npm run test:e2e` (installed `pi` + fake provider + fake Jev; no real keys), `npm run test:matrix` (real toolchains, network). Temporary homes live under `.e2e/`, not the system temp folder: temp is writable from the sandbox by design.
- Local trial without touching the user's Pi: `scripts/try-local.sh` → `scripts/try-local.mjs` (separate PI_CODING_AGENT_DIR + scratch project; refuses non-empty, broad or temp folders; covered by test/unit/try-local.test.ts).
- Do not touch the user's real ~/.pi or credentials. Do not publish or push without the owner's instruction.
