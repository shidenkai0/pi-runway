// Just enough shell understanding to apply rules to a command line.
//
// Used only to apply *your* command rules. A command is split into its simple
// commands at top-level `;`, `&&`, `||`, `|`, `&` and newlines (quotes and
// escapes respected), so a deny rule for `git push --force*` also catches
// `npm test && git push --force`. Constructs whose effect cannot be read off
// the text — command substitution, `eval`, `bash -c`, `xargs` and friends —
// mark the command opaque: your allow rules then only match the command as a
// whole, and anything undecided goes to the reviewer. Runway has no built-in
// list of "safe" or "dangerous" command names: a name says little about what
// a command does (`./bin/ls` can be anything).

export interface ShellAnalysis {
  /** The simple commands, trimmed, with leading `VAR=value` assignments removed. */
  segments: string[]
  /** True when some part of the command cannot be judged from its text. */
  opaque: boolean
  /** Why the command is opaque (for the reviewer and the approval dialog). */
  opaqueReasons: string[]
  /**
   * Some of what it runs only exists at run time (`eval "$X"`, `$CMD push`,
   * `python -c …`, a script fed to `sh` on stdin), so no reading of the text —
   * not even the forms in commandCandidates — can say whether a deny or ask
   * rule applies.
   */
  dynamic: boolean
  /** Segments that redirect output into a file (`> f`, `>> f`, `tee f`). */
  writesFiles: boolean
  /** Hosts named in the command (URLs, scp-style `user@host:` and `git@host:`). */
  hosts: string[]
}

const OPAQUE_WORDS = /^(eval|exec|source|\.|xargs|parallel|watch|nohup|time|timeout|nice|sudo|doas|su|env|command|builtin)$/
const SHELL_DASH_C = /^(ba|z|k|da|fi|c|tc)?sh$|^pwsh$|^powershell$|^python[0-9.]*$|^node$|^perl$|^ruby$|^bun$|^deno$|^osascript$/

/** Split a command line into simple commands. Never throws; unbalanced quotes make it opaque. */
export function analyzeShell(command: string): ShellAnalysis {
  const segments: string[] = []
  const reasons = new Set<string>()
  let current = ''
  let quote: '"' | "'" | undefined
  let writesFiles = false
  const push = () => {
    const seg = current.trim()
    if (seg) segments.push(seg)
    current = ''
  }
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!
    const next = command[i + 1]
    if (quote === "'") {
      current += c
      if (c === "'") quote = undefined
      continue
    }
    if (c === '\\') {
      current += c + (next ?? '')
      i += 1
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === '`' || (c === '$' && next === '(')) reasons.add('command substitution')
      current += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      current += c
      continue
    }
    if (c === '`' || (c === '$' && next === '(')) reasons.add('command substitution')
    if ((c === '<' || c === '>') && next === '(') reasons.add('process substitution')
    if (c === '<' && next === '<') reasons.add('here-document')
    if (c === ';' || c === '\n') {
      push()
      continue
    }
    if (c === '&' && next === '&') {
      push()
      i += 1
      continue
    }
    if (c === '|' && next === '|') {
      push()
      i += 1
      continue
    }
    if (c === '|') {
      push()
      continue
    }
    if (c === '&' && next !== '>' && command[i - 1] !== '>' && command[i - 1] !== '<') {
      push()
      continue
    }
    if (c === '>') {
      // `2>&1`, `>&2`, `>/dev/null` and `2>/dev/null` don't write files.
      const rest = command.slice(i + 1).replace(/^>/, '').trimStart()
      if (!rest.startsWith('&') && !rest.startsWith('/dev/null') && !rest.startsWith('/dev/stderr') && !rest.startsWith('/dev/stdout')) writesFiles = true
    }
    current += c
  }
  if (quote) reasons.add('unbalanced quotes')
  push()

  const cleaned = segments.map(stripAssignments).filter(Boolean)
  let dynamic = quote !== undefined
  for (const seg of cleaned) {
    const words = splitWords(seg)
    const first = words[0] ?? ''
    const base = first.split('/').pop() ?? first
    // The command word itself comes from a variable or substitution, directly or behind a wrapper.
    const rawWords = seg.split(/\s+/)
    const commandWords = [rawWords[0] ?? '', ...rawWords.slice(1).filter((_, i) => OPAQUE_WORDS.test((rawWords[i] ?? '').split('/').pop() ?? ''))]
    if (commandWords.some(w => /[$`]/.test(w))) {
      reasons.add('the command name is chosen at run time')
      dynamic = true
    }
    if (OPAQUE_WORDS.test(base)) reasons.add(`runs another command through \`${base}\``)
    if (/^(eval|source|\.|xargs|parallel|su)$/.test(base)) dynamic = true
    if (SHELL_DASH_C.test(base) && words.some(w => w === '-c' || w === '-e' || w === '--eval' || w === '-Command')) {
      reasons.add(`runs inline code with \`${base}\``)
      // A shell's own -c string is read like any command, unless it is built from variables; other languages can't be read.
      if (!/sh$/.test(base) || /\$/.test(seg.replace(/'[^']*'/g, ''))) dynamic = true
    }
    if (SHELL_DASH_C.test(base) && (seg.includes('<<') || (command.includes('|') && !words.slice(1).some(w => !w.startsWith('-'))))) {
      // A script fed on stdin (`bash <<EOF`, `curl … | sh`).
      reasons.add(`runs a script from its input with \`${base}\``)
      dynamic = true
    }
    if (base === 'tee') writesFiles = true
    if (base === 'find' && words.some(w => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(w))) reasons.add('`find` runs or deletes')
  }
  return { segments: cleaned, opaque: reasons.size > 0, opaqueReasons: [...reasons], dynamic, writesFiles, hosts: extractHosts(command) }
}

function stripAssignments(segment: string): string {
  let s = segment.trim()
  // FOO=bar BAZ="x y" cmd …  → cmd …
  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s]*)\s+/.exec(s)
    if (!m) return s
    s = s.slice(m[0].length)
  }
}

/** Whitespace-split respecting quotes (quotes are kept off the words). */
export function splitWords(segment: string): string[] {
  const words: string[] = []
  let w = ''
  let quote: string | undefined
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else w += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '\\' && i + 1 < segment.length) {
      w += segment[i + 1]
      i += 1
      continue
    }
    if (/\s/.test(c)) {
      if (w) words.push(w)
      w = ''
      continue
    }
    w += c
  }
  if (w) words.push(w)
  return words
}

export function extractHosts(text: string): string[] {
  const hosts = new Set<string>()
  for (const m of text.matchAll(/\b(?:https?|wss?|ftp|ssh|git):\/\/(?:[^\s/@'"]*@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})/g)) hosts.add(m[1]!.toLowerCase())
  for (const m of text.matchAll(/(?:^|[\s'"])[\w.-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,}):/g)) hosts.add(m[1]!.toLowerCase())
  return [...hosts]
}

// ---------- what an explicit deny/ask rule must look at ----------

const MAX_CANDIDATES = 400

/** Contents of `$( … )`, backticks and `<( … )`/`>( … )`, with nesting respected. */
function substitutions(command: string): string[] {
  const out: string[] = []
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]
    if (c === '\\') {
      i += 1
      continue
    }
    if ((c === '$' || c === '<' || c === '>') && command[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < command.length && depth > 0; j += 1) {
        if (command[j] === '\\') j += 1
        else if (command[j] === '(') depth += 1
        else if (command[j] === ')') depth -= 1
      }
      out.push(command.slice(i + 2, j - 1))
      i = j - 1
    } else if (c === '`') {
      const end = command.indexOf('`', i + 1)
      if (end < 0) {
        out.push(command.slice(i + 1))
        break
      }
      out.push(command.slice(i + 1, end))
      i = end
    }
  }
  return out
}

/** Contents of quoted strings: `bash -c "…"`, `sh -c '…'` and similar carry whole commands. */
function quoted(segment: string): string[] {
  const out: string[] = []
  for (const m of segment.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)) {
    const body = (m[1] ?? m[2] ?? '').trim()
    if (body.includes(' ')) out.push(body)
  }
  return out
}

/**
 * Every command form an explicit deny or ask rule should be checked against:
 * each simple command, every word-boundary suffix of it (so `env git push`,
 * `sudo -u x git push` and `xargs git push` contain `git push`), the
 * contents of command and process substitutions and of quoted strings, all
 * recursively. This is syntax, not a list of command names; it errs towards
 * matching too much, which for deny/ask rules is the safe direction.
 */
export function commandCandidates(command: string, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 4 || out.size > MAX_CANDIDATES) return out
  const add = (s: string) => {
    const t = s.trim()
    if (t && out.size <= MAX_CANDIDATES) out.add(t)
  }
  add(command)
  for (const segment of analyzeShell(command).segments) {
    const words = splitWords(segment)
    for (let i = 0; i < words.length; i += 1) add(words.slice(i).join(' '))
    add(segment)
    for (const inner of quoted(segment)) commandCandidates(inner, depth + 1, out)
  }
  for (const inner of substitutions(command)) commandCandidates(inner, depth + 1, out)
  return out
}
