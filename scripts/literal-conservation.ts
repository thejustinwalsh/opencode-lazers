import { readFileSync } from "node:fs"

/**
 * `bun scripts/literal-conservation.ts [--base <ref>] [--source <path>] <module.ts>...`
 *
 * String-literal conservation check for the `runtime.ts` split. The multiset of string and
 * template-literal fragments across the current `<source>` plus the listed modules must equal
 * the multiset in `<base>:<source>`. Import and export specifiers and the index in a type such
 * as `RuntimeJournal["hold"]` (a capitalised name before `[`) are ignored. Event names, effect kinds, section names, hold
 * reasons, request-ID formats and SQL text all move with their code, so any difference is a
 * rewrite.
 */

type Token = { kind: "word" | "punct" | "string" | "regex"; text: string }

/**
 * A small lexer for TypeScript: it returns every string literal and template fragment in source
 * order. It does not use the compiler API (the repo's TypeScript is the native port, which has
 * none). Regex literals are told apart from division by the previous token.
 */
export function literals(text: string): string[] {
  const found: string[] = []
  const tokens: Token[] = []
  const templates: number[] = [] // brace depth at which each open `${` resumes its template
  let depth = 0
  let i = 0
  const previous = () => tokens[tokens.length - 1]
  const readTemplate = () => {
    // Called just after a backtick or the closing brace of `${}`; reads one fragment.
    let fragment = ""
    while (i < text.length) {
      const ch = text[i] as string
      if (ch === "\\") {
        fragment += text.slice(i, i + 2)
        i += 2
      } else if (ch === "`") {
        i++
        found.push(fragment)
        return
      } else if (ch === "$" && text[i + 1] === "{") {
        i += 2
        found.push(fragment)
        templates.push(depth)
        depth++
        return
      } else {
        fragment += ch
        i++
      }
    }
  }
  while (i < text.length) {
    const ch = text[i] as string
    const next = text[i + 1]
    if (/\s/.test(ch)) i++
    else if (ch === "/" && next === "/")
      i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i)
    else if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2)
      i = close < 0 ? text.length : close + 2
    } else if (ch === '"' || ch === "'") {
      let value = ""
      i++
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") {
          value += text.slice(i, i + 2)
          i += 2
        } else value += text[i++]
      }
      i++
      const before = tokens[tokens.length - 1]
      const beforeThat = tokens[tokens.length - 2]
      const specifier =
        before?.text === "from" ||
        (before?.text === "import" && beforeThat?.text !== ".") ||
        (before?.text === "(" && beforeThat?.text === "import") ||
        // `Type["member"]`: an indexed access type, never runtime data.
        (before?.text === "[" && /^[A-Z]\w*$/.test(beforeThat?.text ?? ""))
      if (!specifier) found.push(value)
      tokens.push({ kind: "string", text: value })
    } else if (ch === "`") {
      i++
      readTemplate()
      tokens.push({ kind: "string", text: "`" })
    } else if (ch === "{") {
      depth++
      tokens.push({ kind: "punct", text: ch })
      i++
    } else if (ch === "}") {
      depth--
      i++
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop()
        readTemplate()
        tokens.push({ kind: "string", text: "`" })
      } else tokens.push({ kind: "punct", text: ch })
    } else if (ch === "/") {
      const last = previous()
      const regex =
        !last ||
        (last.kind === "punct" && !/^[)\]}]$/.test(last.text)) ||
        (last.kind === "word" &&
          /^(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(last.text))
      if (regex) {
        let inClass = false
        i++
        while (i < text.length && (inClass || text[i] !== "/")) {
          if (text[i] === "\\") i++
          else if (text[i] === "[") inClass = true
          else if (text[i] === "]") inClass = false
          i++
        }
        i++
        while (/[a-z]/.test(text[i] ?? "")) i++
        tokens.push({ kind: "regex", text: "/" })
      } else {
        tokens.push({ kind: "punct", text: ch })
        i++
      }
    } else if (/[\w$#]/.test(ch)) {
      const match = /^[\w$#]+/.exec(text.slice(i, i + 200)) as RegExpExecArray
      tokens.push({ kind: "word", text: match[0] })
      i += match[0].length
    } else {
      tokens.push({ kind: "punct", text: ch })
      i++
    }
  }
  return found
}

function tally(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let ref = "main"
  let source = "src/runner/runtime.ts"
  const modules: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === "--base") ref = args[++i] ?? ref
    else if (arg === "--source") source = args[++i] ?? source
    else modules.push(arg)
  }
  const shown = Bun.spawnSync(["git", "show", `${ref}:${source}`])
  if (shown.exitCode !== 0) {
    console.error(`git show ${ref}:${source} failed: ${shown.stderr.toString()}`)
    process.exit(2)
  }
  const before = tally(literals(shown.stdout.toString()))
  // A module that already existed on the base (such as `runtime-helpers.ts`) counts as it was.
  const existing = modules.filter(
    (path) => Bun.spawnSync(["git", "cat-file", "-e", `${ref}:${path}`]).exitCode === 0,
  )
  for (const path of existing) {
    const content = Bun.spawnSync(["git", "show", `${ref}:${path}`]).stdout.toString()
    for (const value of literals(content)) before.set(value, (before.get(value) ?? 0) + 1)
  }
  const after = tally([source, ...modules].flatMap((path) => literals(readFileSync(path, "utf8"))))
  let differences = 0
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key) ?? 0
    const now = after.get(key) ?? 0
    if (was === now) continue
    differences++
    console.log(`${now - was > 0 ? "+" : ""}${now - was}  ${JSON.stringify(key).slice(0, 160)}`)
  }
  const total = (counts: Map<string, number>) => [...counts.values()].reduce((a, b) => a + b, 0)
  console.log(
    `literals: ${total(before)} on ${ref}, ${total(after)} now, ${differences} differing fragments`,
  )
  process.exit(differences === 0 ? 0 : 1)
}
