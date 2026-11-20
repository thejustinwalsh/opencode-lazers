import { createHash } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The repository map: one small, stable orientation text made of file paths and exported names
 * only, over the project's own source files. Plain path order; no ranking and no entry cut, so the
 * same tree yields the same bytes and the map can sit in a cached prompt prefix.
 *
 * Exports are found with a small lexical scan, not a parser. Tree-sitter compress output (RepoMix)
 * drops or rewrites `export { a } from`, `export *` and type-only re-exports, and Bun's
 * `Transpiler.scan` erases type exports before reporting; the scan below reads every statement
 * form directly.
 */

export type SourceDefinition = { include: string[]; exclude: string[] }
export type ExportKind = "fn" | "class" | "type" | "const" | "re" | "default"
export type ExportedName = { kind: ExportKind; name: string }
export type RepoMap = {
  text: string
  /** SHA-256 of `text`. */
  hash: string
  /** o200k_base tokens of `text`. */
  tokens: number
  files: number
  names: number
}

const kindOrder: ExportKind[] = ["fn", "class", "type", "const", "re", "default"]
const sourceExtension = /\.(?:[cm]?ts|tsx)$/

// ---------------------------------------------------------------------------------------------
// Lexing

type Token = {
  kind: "word" | "punct" | "str" | "other"
  text: string
  /** Bracket depth before this token (closers report the depth they return to). */
  depth: number
  /** A line break separates this token from the previous one. */
  nl: boolean
}

const wordChar = /[\p{L}\p{N}_$]/u
const regexAfterWord = new Set([
  "return",
  "typeof",
  "case",
  "of",
  "in",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "yield",
  "await",
  "instanceof",
])

function skipString(source: string, start: number): number {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    const c = source[i]
    if (c === "\\") i += 2
    else if (c === quote) return i + 1
    else if (c === "\n") return i
    else i++
  }
  return i
}

function skipTemplate(source: string, start: number): number {
  let i = start + 1
  while (i < source.length) {
    const c = source[i]
    if (c === "\\") i += 2
    else if (c === "`") return i + 1
    else if (c === "$" && source[i + 1] === "{") {
      i += 2
      let depth = 1
      while (i < source.length && depth > 0) {
        const d = source[i]
        if (d === "{") depth++
        else if (d === "}") depth--
        else if (d === "'" || d === '"') {
          i = skipString(source, i)
          continue
        } else if (d === "`") {
          i = skipTemplate(source, i)
          continue
        }
        i++
      }
    } else i++
  }
  return i
}

function skipRegex(source: string, start: number): number | undefined {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const c = source[i]
    if (c === "\n") return undefined
    if (c === "\\") i += 2
    else {
      if (c === "[") inClass = true
      else if (c === "]") inClass = false
      else if (c === "/" && !inClass) {
        i++
        while (i < source.length && wordChar.test(source[i]!)) i++
        return i
      }
      i++
    }
  }
  return undefined
}

function lex(source: string): Token[] {
  const tokens: Token[] = []
  let depth = 0
  let i = 0
  let nl = false
  const push = (kind: Token["kind"], text: string, at = depth) => {
    tokens.push({ kind, text, depth: at, nl })
    nl = false
  }
  while (i < source.length) {
    const c = source[i]!
    if (c === "\n") {
      nl = true
      i++
    } else if (c === " " || c === "\t" || c === "\r") i++
    else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end < 0 ? source.length : end + 2
      if (source.slice(i, stop).includes("\n")) nl = true
      i = stop
    } else if (c === "'" || c === '"') {
      const end = skipString(source, i)
      push("str", source.slice(i + 1, source[end - 1] === c ? end - 1 : end))
      i = end
    } else if (c === "`") {
      i = skipTemplate(source, i)
      push("other", "`")
    } else if (c === "/") {
      const previous = tokens[tokens.length - 1]
      const regexAllowed =
        !previous ||
        (previous.kind === "punct" && ![")", "]", "}"].includes(previous.text)) ||
        (previous.kind === "word" && regexAfterWord.has(previous.text))
      const end = regexAllowed ? skipRegex(source, i) : undefined
      if (end === undefined) {
        push("punct", "/")
        i++
      } else {
        push("other", "/re/")
        i = end
      }
    } else if (wordChar.test(c)) {
      let end = i + 1
      while (end < source.length && wordChar.test(source[end]!)) end++
      push("word", source.slice(i, end))
      i = end
    } else if (c === "=" && source[i + 1] === ">") {
      push("punct", "=>")
      i += 2
    } else {
      if (c === "{" || c === "(" || c === "[") {
        push("punct", c)
        depth++
      } else if (c === "}" || c === ")" || c === "]") {
        depth = Math.max(0, depth - 1)
        push("punct", c)
      } else push("punct", c)
      i++
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------------------------
// Export scan

const modifiers = new Set(["declare", "abstract", "async"])
const statementWords = new Set([
  "export",
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "import",
  "declare",
  "async",
  "abstract",
  "namespace",
  "module",
])
const continues = new Set(["=", ",", ".", "(", "?", ":", "+", "-", "*", "/", "&", "|", "<", "=>"])

type Declaration = { names: ExportedName[]; next: number }

function matching(tokens: Token[], open: number): number {
  const base = tokens[open]!.depth
  let i = open + 1
  while (
    i < tokens.length &&
    !(tokens[i]!.depth === base && tokens[i]!.kind === "punct" && ")]}".includes(tokens[i]!.text))
  )
    i++
  return i
}

function initializerKind(tokens: Token[], at: number): "fn" | "const" {
  let i = at
  const first = tokens[i]
  if (!first) return "const"
  if (first.kind === "word" && first.text === "async") i++
  const head = tokens[i]
  if (!head) return "const"
  if (head.kind === "word" && head.text === "function") return "fn"
  if (head.kind === "punct" && head.text === "<") return "fn"
  if (head.kind === "word" && tokens[i + 1]?.text === "=>") return "fn"
  if (head.kind === "punct" && head.text === "(") {
    const close = matching(tokens, i)
    const after = tokens[close + 1]
    if (after && after.kind === "punct" && (after.text === "=>" || after.text === ":")) return "fn"
  }
  return "const"
}

function patternNames(tokens: Token[], open: number): { names: string[]; next: number } {
  const close = matching(tokens, open)
  const names: string[] = []
  let skipping: number | undefined
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i]!
    if (skipping !== undefined) {
      if (token.depth < skipping || (token.depth === skipping && token.text === ","))
        skipping = undefined
      else continue
    }
    if (token.kind === "punct" && token.text === "=") skipping = token.depth
    else if (token.kind === "word" && [",", "}", "]", "="].includes(tokens[i + 1]?.text ?? ""))
      names.push(token.text)
  }
  return { names: [...new Set(names)], next: close + 1 }
}

function declarators(tokens: Token[], start: number): Declaration {
  const names: ExportedName[] = []
  const base = tokens[start]?.depth ?? 0
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]!
    let bound: string[] = []
    if (token.kind === "word") {
      bound = [token.text]
      i++
    } else if (token.kind === "punct" && (token.text === "{" || token.text === "[")) {
      const pattern = patternNames(tokens, i)
      bound = pattern.names
      i = pattern.next
    } else break
    // Optional definite assignment and type annotation, up to `=`, `,` or the end of the statement.
    let angle = 0
    let kind: "fn" | "const" = "const"
    while (i < tokens.length && tokens[i]!.depth >= base) {
      const t = tokens[i]!
      if (t.depth === base && t.kind === "punct") {
        if (t.text === "<") angle++
        else if (t.text === ">") angle = Math.max(0, angle - 1)
        else if (angle === 0 && (t.text === "=" || t.text === "," || t.text === ";")) break
      }
      if (t.depth === base && t.nl && statementWords.has(t.text) && t.kind === "word") break
      i++
    }
    if (tokens[i]?.text === "=" && tokens[i]!.kind === "punct") {
      kind = initializerKind(tokens, i + 1)
      i++
    }
    for (const name of bound) names.push({ kind, name })
    // Skip the initializer to the next declarator or the end of the statement.
    let next = false
    while (i < tokens.length) {
      const t = tokens[i]!
      if (t.depth < base) break
      if (t.depth === base) {
        if (t.kind === "punct" && t.text === ";") {
          i++
          break
        }
        if (
          t.kind === "word" &&
          t.nl &&
          statementWords.has(t.text) &&
          !continues.has(tokens[i - 1]?.text ?? "")
        )
          break
        if (t.kind === "punct" && t.text === ",") {
          const after = tokens[i + 1]
          const follower = tokens[i + 2]
          const startsDeclarator =
            after !== undefined &&
            ((after.kind === "word" &&
              (follower === undefined ||
                follower.nl ||
                (follower.kind === "punct" &&
                  ["=", ":", ",", ";", "!"].includes(follower.text)))) ||
              (after.kind === "punct" && (after.text === "{" || after.text === "[")))
          if (startsDeclarator) {
            i++
            next = true
            break
          }
        }
      }
      i++
    }
    if (!next) break
  }
  return { names, next: i }
}

function declaration(tokens: Token[], start: number): Declaration | undefined {
  let i = start
  while (
    tokens[i]?.kind === "word" &&
    modifiers.has(tokens[i]!.text) &&
    tokens[i + 1]?.kind === "word"
  )
    i++
  const word = tokens[i]
  if (!word || word.kind !== "word") return undefined
  const named = (kind: ExportKind, at: number): Declaration | undefined => {
    const name = tokens[at]
    return name?.kind === "word" ? { names: [{ kind, name: name.text }], next: at + 1 } : undefined
  }
  switch (word.text) {
    case "function":
      return named("fn", tokens[i + 1]?.text === "*" ? i + 2 : i + 1)
    case "class":
      return named("class", i + 1)
    case "interface":
      return named("type", i + 1)
    case "type":
      return named("type", i + 1)
    case "enum":
      return named("type", i + 1)
    case "namespace":
    case "module":
      return named("type", i + 1)
    case "const":
      if (tokens[i + 1]?.text === "enum") return named("type", i + 2)
      return declarators(tokens, i + 1)
    case "let":
    case "var":
      return declarators(tokens, i + 1)
    default:
      return undefined
  }
}

function localKinds(tokens: Token[]): Map<string, ExportKind> {
  const kinds = new Map<string, ExportKind>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.depth !== 0 || token.kind !== "word" || tokens[i - 1]?.text === ".") continue
    if (token.text === "type" && !["=", "<"].includes(tokens[i + 2]?.text ?? "")) continue
    if (
      !["function", "class", "interface", "type", "enum", "const", "let", "var"].includes(
        token.text,
      ) &&
      !modifiers.has(token.text)
    )
      continue
    if (modifiers.has(token.text) && tokens[i - 1]?.text !== "export" && !token.nl) continue
    const found = declaration(tokens, i)
    if (found) for (const { kind, name } of found.names) if (!kinds.has(name)) kinds.set(name, kind)
  }
  return kinds
}

/** The exported names of one TypeScript or TSX source file, in source order. */
export function scanExports(source: string): ExportedName[] {
  const tokens = lex(source)
  const locals = localKinds(tokens)
  const out: ExportedName[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.depth !== 0 || token.kind !== "word" || token.text !== "export") continue
    if (tokens[i - 1]?.text === ".") continue
    let j = i + 1
    const head = tokens[j]
    if (!head) break
    if (head.kind === "word" && head.text === "default") {
      out.push({ kind: "default", name: "default" })
      continue
    }
    const typeOnly =
      head.kind === "word" && head.text === "type" && ["{", "*"].includes(tokens[j + 1]?.text ?? "")
    if (typeOnly) j++
    const open = tokens[j]!
    if (open.kind === "punct" && open.text === "*") {
      let k = j + 1
      let alias: string | undefined
      if (tokens[k]?.text === "as" && tokens[k + 1]?.kind === "word") {
        alias = tokens[k + 1]!.text
        k += 2
      }
      const from = tokens[k]?.text === "from" ? tokens[k + 1] : undefined
      out.push({ kind: "re", name: alias ?? `*${from?.kind === "str" ? from.text : ""}` })
      continue
    }
    if (open.kind === "punct" && open.text === "{") {
      const close = matching(tokens, j)
      const from = tokens[close + 1]?.text === "from"
      let k = j + 1
      while (k < close) {
        let inlineType = false
        if (
          tokens[k]?.text === "type" &&
          tokens[k + 1]?.kind === "word" &&
          tokens[k + 1]?.text !== "as"
        ) {
          inlineType = true
          k++
        }
        const local = tokens[k]
        let exported = local
        if (tokens[k + 1]?.text === "as" && tokens[k + 2]?.kind === "word") {
          exported = tokens[k + 2]
          k += 2
        }
        if (local && exported && exported.kind === "word") {
          const kind: ExportKind =
            typeOnly || inlineType ? "type" : from ? "re" : (locals.get(local.text) ?? "re")
          out.push({ kind, name: exported.text })
        }
        k++
        while (k < close && tokens[k]!.text !== ",") k++
        k++
      }
      continue
    }
    if (open.kind === "punct") continue
    const found = declaration(tokens, j)
    if (found) out.push(...found.names)
  }
  const seen = new Set<string>()
  return out.filter((entry) => {
    const key = `${entry.kind}\0${entry.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** One map line: the path, then exported names grouped by kind in a fixed kind order. */
export function mapLine(path: string, exports: ExportedName[]): string {
  const groups: string[] = []
  for (const kind of kindOrder) {
    const names = exports.filter((entry) => entry.kind === kind).map((entry) => entry.name)
    if (!names.length) continue
    groups.push(kind === "default" ? "default" : `${kind} ${names.join(" ")}`)
  }
  return groups.length ? `${path}: ${groups.join("; ")}` : path
}

// ---------------------------------------------------------------------------------------------
// Source definition

const testAndFixtureExcludes = [
  "**/*.d.ts",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/__fixtures__/**",
  "**/fixtures/**",
  "**/*.fixture.ts",
  "**/*.fixture.tsx",
  "**/*.fixtures.ts",
  "**/*-fixture.ts",
  "**/*-fixtures.ts",
]
const vendoredExcludes = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/third_party/**",
  "**/dist/**",
  "**/build/**",
  "**/.cache/**",
]
const nonSourceFolders = new Set([
  "test",
  "tests",
  "e2e",
  "spec",
  "script",
  "scripts",
  "tool",
  "tools",
  "bench",
  "benchmark",
  "benchmarks",
  "doc",
  "docs",
  "example",
  "examples",
])

async function gitFiles(root: string): Promise<string[] | undefined> {
  try {
    const run = Bun.spawn(["git", "ls-files", "-z", "-co", "--exclude-standard"], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    })
    const [status, output] = await Promise.all([run.exited, new Response(run.stdout).text()])
    if (status !== 0) return undefined
    return [...new Set(output.split("\0").filter(Boolean))].sort()
  } catch {
    return undefined
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const glob = new Bun.Glob("**/*.{ts,tsx,mts,cts}")
  for await (const path of glob.scan({ cwd: root, onlyFiles: true, dot: false }))
    if (!path.split("/").includes("node_modules")) found.push(path)
  return found.sort()
}

/** Every file in the checkout that git would track, or a directory walk outside a repository. */
export async function trackedFiles(root: string): Promise<string[]> {
  return await checkoutFiles(root)
}

async function checkoutFiles(root: string): Promise<string[]> {
  return (await gitFiles(root)) ?? (await walkFiles(root))
}

function fallowIgnorePatterns(root: string): string[] {
  try {
    const config = JSON.parse(readFileSync(join(root, ".fallowrc.json"), "utf8")) as {
      ignorePatterns?: unknown
    }
    return Array.isArray(config.ignorePatterns)
      ? config.ignorePatterns.filter((pattern): pattern is string => typeof pattern === "string")
      : []
  } catch {
    return []
  }
}

const globMatches = (patterns: string[], path: string) =>
  patterns.some((pattern) => new Bun.Glob(pattern).match(path))

/**
 * The default source definition for a checkout: the folders holding the project's own TypeScript,
 * minus tests, fixtures, declaration files, vendored or generated folders and the paths the
 * project's Fallow configuration ignores. It is the default while no profile is confirmed (a
 * stored source filter, until a profile replaces it, takes precedence); a confirmed profile's
 * `source` replaces both.
 *
 * Source roots, in order of preference: a top-level `src`; else every nested `src` folder
 * (a monorepo's packages); else each top-level folder that is not tooling or documentation.
 */
export async function deriveSourceDefinition(root: string): Promise<SourceDefinition> {
  const exclude = [...testAndFixtureExcludes, ...vendoredExcludes, ...fallowIgnorePatterns(root)]
  const survivors = (await checkoutFiles(root)).filter(
    (path) => sourceExtension.test(path) && !globMatches(exclude, path),
  )
  const roots = new Set<string>()
  if (survivors.some((path) => path.startsWith("src/"))) roots.add("src")
  else {
    for (const path of survivors) {
      const parts = path.split("/")
      const at = parts.indexOf("src")
      if (at > 0) roots.add(parts.slice(0, at + 1).join("/"))
    }
    if (!roots.size)
      for (const path of survivors) {
        const [top] = path.split("/")
        if (path.includes("/") && top && !nonSourceFolders.has(top.toLowerCase())) roots.add(top)
      }
  }
  const include = roots.size
    ? [...roots].sort().flatMap((folder) => [`${folder}/**/*.ts`, `${folder}/**/*.tsx`])
    : ["*.ts", "*.tsx"]
  return { include, exclude }
}

/**
 * The source files a definition selects, in plain path order. `anyExtension` (a profile's source)
 * selects files of any language; without it only TypeScript files qualify, as before.
 */
export async function sourceFiles(
  root: string,
  definition: SourceDefinition,
  options: { anyExtension?: boolean } = {},
): Promise<string[]> {
  const files = (await checkoutFiles(root)).filter(
    (path) =>
      (options.anyExtension || sourceExtension.test(path)) &&
      globMatches(definition.include, path) &&
      !globMatches(definition.exclude, path),
  )
  return files.filter((path) => {
    try {
      const stat = lstatSync(join(root, path))
      return stat.isFile() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Rendering

function folderTree(topLevel: string[], files: string[]): string[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const at = file.lastIndexOf("/")
    const folder = at < 0 ? "" : file.slice(0, at)
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  const folders = new Set<string>(topLevel)
  for (const folder of counts.keys()) {
    const parts = folder.split("/").filter(Boolean)
    for (let n = 1; n <= parts.length; n++) folders.add(parts.slice(0, n).join("/"))
  }
  const lines = ["./"]
  for (const folder of [...folders].sort()) {
    const depth = folder.split("/").length
    const count = counts.get(folder)
    lines.push(`${"  ".repeat(depth)}${folder.split("/").at(-1)}/${count ? ` (${count})` : ""}`)
  }
  return lines
}

async function countTokens(text: string): Promise<number> {
  const { TokenCounter } = await import("repomix")
  const counter = new TokenCounter("o200k_base")
  try {
    await counter.init()
    return counter.countTokens(text)
  } finally {
    counter.free()
  }
}

/**
 * Build the map for a checkout. `topLevel` names the checkout's top-level folders (documentation
 * folders appear only here, by name); by default they are read from the checkout's file list.
 */
export async function buildRepoMap(
  root: string,
  definition: SourceDefinition,
  options: { topLevel?: string[]; anyExtension?: boolean } = {},
): Promise<RepoMap> {
  const files = await sourceFiles(root, definition, {
    ...(options.anyExtension ? { anyExtension: true } : {}),
  })
  const all = options.topLevel ? [] : await checkoutFiles(root)
  const topLevel =
    options.topLevel ??
    [...new Set(all.filter((path) => path.includes("/")).map((path) => path.split("/")[0]!))].sort()
  const lines: string[] = []
  let names = 0
  for (let at = 0; at < files.length; at += 64) {
    const batch = files.slice(at, at + 64)
    const scanned = await Promise.all(
      batch.map(async (path) => {
        // Exported names are read for TypeScript only; other files are listed by path.
        if (!sourceExtension.test(path)) return []
        try {
          return scanExports(await Bun.file(join(root, path)).text())
        } catch {
          return []
        }
      }),
    )
    batch.forEach((path, index) => {
      names += scanned[index]!.length
      lines.push(mapLine(path, scanned[index]!))
    })
  }
  const text = [
    "Repository map. Source files by path, each with its exported names in source order.",
    "Kinds: fn function, class, type type/interface/enum, const, re re-export (*module is export *), default.",
    "",
    "Folders (parentheses: source files directly inside):",
    ...folderTree(topLevel, files),
    "",
    "Source files:",
    ...lines,
    "",
  ].join("\n")
  return {
    text,
    hash: createHash("sha256").update(text).digest("hex"),
    tokens: await countTokens(text),
    files: files.length,
    names,
  }
}
