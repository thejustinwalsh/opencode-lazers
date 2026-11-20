import { readFileSync } from "node:fs"

/**
 * `bun scripts/moved-members.ts [--base <ref>] [--source <path>] [--allow <member>]... <module.ts>...`
 *
 * Moved-member check for the `runtime.ts` split. Every class member of each module that also
 * exists in `<base>:<source>` (default `main:src/runner/runtime.ts`) must have identical text,
 * from its declaration line to its closing line. Members are cut by indentation, which is stable
 * under the formatter: a member starts at a two-space-indented line and runs until the next
 * line at two spaces that does not close a bracket. Leading comments are not part of a member.
 *
 * A moved member may drop its `private` modifier, because the coordinator now calls it from
 * outside the class; nothing else on the declaration line may change. `--allow <member>` lists
 * a member whose difference the PR description explains. `--moved a,b,c` names the members that
 * must be present and identical, so a member that was dropped or renamed fails. Members that
 * exist only in the module (constructor, dependency aliases) are listed and not failures.
 */

export type Member = { key: string; text: string }

const MODIFIERS = new Set([
  "private",
  "public",
  "protected",
  "static",
  "readonly",
  "async",
  "override",
  "abstract",
  "declare",
  "accessor",
])

export function memberKey(line: string): string | undefined {
  let rest = line.trim()
  for (;;) {
    const word = /^([a-z]+)\b/.exec(rest)?.[1]
    if (!word || !MODIFIERS.has(word)) break
    // A field literally named like a modifier is followed by `(`, `:`, `=` or `;`.
    if (/^[a-z]+\s*[(:=;?!]/.test(rest)) break
    rest = rest.slice(word.length).trimStart()
  }
  const accessor = /^(get|set)\s+(?=[#\w$])/.exec(rest)
  const prefix = accessor ? `${accessor[1]} ` : ""
  if (accessor) rest = rest.slice(accessor[0].length)
  rest = rest.replace(/^\*\s*/, "")
  const name = /^(#?[\w$]+|\[[^\]]+\])/.exec(rest)?.[1]
  return name ? prefix + name : undefined
}

export function classMembers(source: string): Member[] {
  const lines = source.split("\n")
  const members: Member[] = []
  const seen = new Map<string, number>()
  let inClass = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    if (!inClass) {
      inClass = /^(export )?(abstract )?class \w/.test(line) && line.trimEnd().endsWith("{")
      i++
      continue
    }
    if (line === "}") {
      inClass = false
      i++
      continue
    }
    const starts = /^ {2}\S/.test(line) && !/^ {2}(\/|\*|[})\]@])/.test(line)
    const key = starts ? memberKey(line) : undefined
    if (!key) {
      i++
      continue
    }
    let end = i
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? ""
      if (next.trim() === "") continue
      const indent = next.length - next.trimStart().length
      if (indent > 2) {
        end = j
        continue
      }
      // A parameter list closes at two spaces and still opens the body: `  ): Row {`.
      if (indent === 2 && /^ {2}[})\]>]/.test(next)) {
        end = j
        if (next.trimEnd().endsWith("{")) continue
      }
      break
    }
    const text = lines.slice(i, end + 1)
    text[0] = (text[0] as string).replace(/^( {2})private /, "$1")
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    members.push({ key: count === 0 ? key : `${key}#${count + 1}`, text: text.join("\n") })
    i = end + 1
  }
  return members
}

export function compareMembers(
  base: Member[],
  module: Member[],
  allowed: ReadonlySet<string>,
  required: readonly string[] = [],
) {
  const baseByKey = new Map(base.map((member) => [member.key, member.text]))
  const moved: string[] = []
  const changed: string[] = []
  const added: string[] = []
  for (const member of module) {
    const original = baseByKey.get(member.key)
    if (original === undefined) added.push(member.key)
    else if (original === member.text) moved.push(member.key)
    else if (allowed.has(member.key)) moved.push(`${member.key} (allowed difference)`)
    else changed.push(member.key)
  }
  const present = new Set(module.map((member) => member.key))
  const missing = required.filter((key) => !present.has(key))
  return { moved, changed, added, missing }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let ref = "main"
  let source = "src/runner/runtime.ts"
  const allowed = new Set<string>()
  const modules: string[] = []
  let required: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === "--base") ref = args[++i] ?? ref
    else if (arg === "--source") source = args[++i] ?? source
    else if (arg === "--allow") allowed.add(args[++i] ?? "")
    else if (arg === "--moved") required = (args[++i] ?? "").split(",").filter(Boolean)
    else modules.push(arg)
  }
  if (modules.length === 0) {
    console.error("usage: bun scripts/moved-members.ts [--base ref] [--allow member] module.ts...")
    process.exit(2)
  }
  const shown = Bun.spawnSync(["git", "show", `${ref}:${source}`])
  if (shown.exitCode !== 0) {
    console.error(`git show ${ref}:${source} failed: ${shown.stderr.toString()}`)
    process.exit(2)
  }
  const base = classMembers(shown.stdout.toString())
  let failed = false
  for (const path of modules) {
    const { moved, changed, added, missing } = compareMembers(
      base,
      classMembers(readFileSync(path, "utf8")),
      allowed,
      required,
    )
    console.log(
      `${path}: ${moved.length} moved identical, ${added.length} new, ${changed.length} changed`,
    )
    if (added.length) console.log(`  new (not in ${ref}): ${added.join(", ")}`)
    for (const key of changed) console.log(`  CHANGED: ${key}`)
    for (const key of missing) console.log(`  MISSING: ${key}`)
    if (changed.length || missing.length) failed = true
  }
  process.exit(failed ? 1 : 0)
}
