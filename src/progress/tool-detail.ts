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

/** Names of the project tools a code-mode script calls, in order of first appearance. */
function scriptTools(source: string) {
  const names: string[] = []
  for (const match of source.matchAll(
    /\b(lz-[a-z0-9][a-z0-9-]*|search|query|fetch|read|glob|grep)\b(?=\s*[([\s,])/g,
  )) {
    const name = match[1]!
    if (!names.includes(name)) names.push(name)
  }
  return names.slice(0, 5).join(" · ")
}

function raw(tool: string, input: unknown): string | undefined {
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
    return `"${pattern}"${where ? ` ${where}` : ""}`
  }
  if (name === "glob" || name === "list" || name === "ls") {
    const pattern = first(value, "pattern", "path")
    const where = name === "glob" ? first(value, "path") : undefined
    return pattern === undefined ? undefined : `${pattern}${where ? ` ${where}` : ""}`
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
export function toolDetail(tool: string, input: unknown): string | null {
  let summary: string | undefined
  try {
    summary = raw(tool, input)
  } catch {
    return null
  }
  if (summary === undefined) return null
  const line = oneLine(summary)
  if (!line) return null
  return bounded(oneLine(safeText(line, privacyStats(), 4_000))) || null
}
