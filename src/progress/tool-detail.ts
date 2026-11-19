import { privacyStats, safeText } from "../trajectory/privacy.ts"

/** One short line saying what a tool call did: its command, file, pattern or inner tools. */
export const TOOL_DETAIL_LIMIT = 200

type Args = Record<string, unknown>

const args = (value: unknown): Args =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Args) : {}

const own = (value: Args, key: string) =>
  Object.hasOwn(value, key) && typeof value[key] === "string" ? (value[key] as string) : undefined

const first = (value: Args, ...keys: string[]) => {
  for (const key of keys) {
    const found = own(value, key)
    if (found !== undefined && found.trim().length > 0) return found
  }
  return undefined
}

/**
 * Environment-style assignments keep their name and lose their value (`FOO=secret cmd` becomes
 * `FOO=… cmd`), and flags that take a credential lose the credential. This runs before the shared
 * secret patterns, which then catch tokens, bearer headers, URLs and `key=value` secrets.
 */
export function redactCommand(command: string) {
  return command
    .replace(/(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;&|)]*)/g, "$1$2=…")
    .replace(
      /(--?[A-Za-z0-9-]*(?:token|password|passwd|secret|api-?key|auth|credential)[A-Za-z0-9-]*)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|)]+)/gi,
      "$1 …",
    )
}

/** Where a call ran, so paths can be shown without the machine-specific prefix. */
export type PathScope = {
  /** Working directories: the session's workspace, the project root. Longest match wins. */
  roots?: readonly string[]
  /** Parent of per-task worktrees: `<project>.worktrees`; every child counts as a root. */
  worktreesBase?: string
  /** The person's home directory, shown as `~` for paths outside every root. */
  home?: string
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const trimSlash = (value: string) => value.replace(/\/+$/, "")

function isRoot(path: string, scope: PathScope) {
  const clean = trimSlash(path)
  return (
    (scope.roots ?? []).some((root) => trimSlash(root) === clean) ||
    (scope.worktreesBase !== undefined &&
      new RegExp(`^${escapeRegExp(trimSlash(scope.worktreesBase))}/[^/]+$`).test(clean))
  )
}

/**
 * Remove the workspace root wherever it appears (`/root/src/a.ts` becomes `src/a.ts`, a bare root
 * becomes `.`), and show other paths under the home directory as `~/...`. Used when recording and
 * again when reading, so rows stored with absolute paths read the same.
 */
export function relativize(value: string, scope: PathScope) {
  let output = value
  const prefixes = [
    ...(scope.worktreesBase
      ? [`${escapeRegExp(trimSlash(scope.worktreesBase))}/[^/\\s"'\`]+`]
      : []),
    ...(scope.roots ?? [])
      .filter((root) => root.length > 1)
      .map((root) => escapeRegExp(trimSlash(root))),
  ].toSorted((left, right) => right.length - left.length)
  for (const prefix of prefixes)
    output = output
      .replace(new RegExp(`${prefix}/`, "g"), "")
      .replace(new RegExp(`${prefix}(?![\\w./-])`, "g"), ".")
  if (scope.home && scope.home.length > 1)
    output = output.replace(new RegExp(`${escapeRegExp(trimSlash(scope.home))}/`, "g"), "~/")
  return output
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function bounded(value: string) {
  const points = Array.from(value)
  return points.length > TOOL_DETAIL_LIMIT
    ? `${points.slice(0, TOOL_DETAIL_LIMIT - 1).join("")}…`
    : value
}

function patchFiles(patchText: string) {
  const files = [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  )
  const paths = files.length
    ? files
    : [...patchText.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)].map((match) => match[1]!)
  return paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` +${paths.length - 3}` : "")
}

function urlSummary(value: string) {
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`
  } catch {
    return undefined
  }
}

/**
 * Tools a code-mode script calls, in order of first appearance: `tools.read(`, `tools["lz-x"](`,
 * and bare hyphenated project tool names. When none is found the script's first non-empty line
 * stands in, so an execute call is never blank.
 */
function scriptTools(source: string) {
  const names: string[] = []
  for (const match of source.matchAll(
    /\btools\s*\.\s*([A-Za-z_][\w-]*)\s*\(|\btools\s*\[\s*["'`]([^"'`]+)["'`]\s*\]\s*\(|\b(lz-[a-z0-9][a-z0-9-]*)\b/g,
  )) {
    const name = match[1] ?? match[2] ?? match[3]
    if (name && !names.includes(name)) names.push(name)
  }
  if (names.length > 0) return names.slice(0, 5).join(" · ")
  return (
    source
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  )
}

function raw(tool: string, input: unknown, scope: PathScope): string | undefined {
  const value = args(input)
  const name = tool.toLowerCase()
  if (/^(bash|shell|sh|zsh|exec|run|command)$/.test(name)) {
    const command = first(value, "command", "cmd")
    return command === undefined ? undefined : redactCommand(command)
  }
  if (/^(read|view|cat|edit|write|multiedit)$/.test(name))
    return first(value, "filePath", "file_path", "path")
  if (/patch/.test(name)) {
    const text = first(value, "patchText", "patch")
    return text === undefined ? first(value, "filePath", "path") : patchFiles(text)
  }
  if (name === "grep") {
    const pattern = first(value, "pattern", "query")
    if (pattern === undefined) return undefined
    const where = first(value, "path", "include")
    return `"${pattern}"${where && !isRoot(where, scope) ? ` ${where}` : ""}`
  }
  if (name === "glob" || name === "list" || name === "ls") {
    const pattern = first(value, "pattern", "path")
    const where = name === "glob" ? first(value, "path") : undefined
    return pattern === undefined
      ? undefined
      : `${pattern}${where && !isRoot(where, scope) ? ` ${where}` : ""}`
  }
  if (name === "webfetch" || name === "fetch") {
    const url = first(value, "url")
    return url === undefined ? undefined : (urlSummary(url) ?? undefined)
  }
  if (name === "websearch" || name === "search") return first(value, "query")
  if (/^(task|subagent|agent)$/.test(name)) return first(value, "description", "name")
  if (name === "execute") {
    const source = first(value, "code", "script", "source", "program", "input")
    return source === undefined ? first(value, "description") : scriptTools(source) || undefined
  }
  return first(value, "description", "filePath", "path", "pattern", "query", "command")
}

/**
 * A bounded single-line summary of one tool call, or null when the call carries nothing worth
 * showing. Redaction runs before truncation; whitespace is collapsed and newlines removed.
 */
export function toolDetail(tool: string, input: unknown, scope: PathScope = {}): string | null {
  let summary: string | undefined
  try {
    summary = raw(tool, input, scope)
  } catch {
    return null
  }
  if (summary === undefined) return null
  const line = oneLine(relativize(summary, scope))
  if (!line) return null
  return bounded(oneLine(safeText(line, privacyStats(), 4_000))) || null
}
