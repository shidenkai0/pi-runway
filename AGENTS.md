# Working on Runway

- Product: one Pi package for safe autonomy. Two independent layers: an OS sandbox for every command, and one permission gate for every tool call (your rules, then Jev, then a person). Read README.md, then docs/how-it-works.md.
- Keep it small and on Pi's public extension API. Never pin or patch Pi.
- No lists of command or tool names that decide safety. Tool identity comes from Pi's registry (`getAllTools().sourceInfo`) and Runway's own records; commands are parsed only to apply the user's rules.
- Security rules: decisions fail closed; reviewer failure never means allow; approving never relaxes the sandbox; a project config can only tighten; secrets never go into logs or fixtures; private eval inputs are read in place, never copied; notes or summaries derived from them stay in the gitignored `eval/private/`.
- Tests: `npm test` (unit, offline), `npm run test:e2e` (local Pi 1.0 + fake model + fake Jev; no real keys), `npm run eval` (offline scoring), `npm run test:matrix` (real toolchains, network). Temporary homes live under `.e2e/`, not the system temp folder: temp is writable from the sandbox by design.
- Local trial without touching the user's Pi: `scripts/try-local.sh`.
- Do not touch the user's real ~/.pi or credentials. Do not publish or push without the owner's instruction.
