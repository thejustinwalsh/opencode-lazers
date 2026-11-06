import { fingerprint } from "../../identity.ts"

const runtimeVariables = {
  HOME: "home",
  TMPDIR: "tmp",
  TMP: "tmp",
  TEMP: "tmp",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  LAZERS_VERIFICATION_SQLITE: "database",
} as const

export type RetainedProcedureResource = (typeof runtimeVariables)[keyof typeof runtimeVariables]

export type RetainedProcedureBinding = {
  schemaVersion: 1
  kind: "read-only" | "owned-shell-resources" | "private-sqlite-smoke"
  commandFingerprint: string
  resources: RetainedProcedureResource[]
}

export type RetainedProcedureBindingResult =
  | { status: "supported"; binding: RetainedProcedureBinding }
  | { status: "unsupported"; reason: string }

function splitAndChain(command: string): string[] | undefined {
  const segments: string[] = []
  let segment = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!
    const next = command[index + 1]
    if (escaped) {
      segment += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      segment += character
      escaped = true
      continue
    }
    if (quote) {
      segment += character
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      segment += character
      continue
    }
    if (character === "`" || (character === "$" && next === "(") || character === "\n")
      return undefined
    if (character === "&" && next === "&") {
      if (!segment.trim()) return undefined
      segments.push(segment.trim())
      segment = ""
      index++
      continue
    }
    if (character === ";" || character === "|" || character === "<" || character === "(")
      return undefined
    segment += character
  }
  if (quote || escaped || !segment.trim()) return undefined
  segments.push(segment.trim())
  return segments
}

function resourceForVariable(variable: string): RetainedProcedureResource | undefined {
  return runtimeVariables[variable as keyof typeof runtimeVariables]
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    /^[A-Za-z0-9._/-]+$/.test(path)
  )
}

function sqliteSmokeCheck(segment: string): boolean {
  const wrapper = /^bun -e '(.*)'$/.exec(segment)
  if (!wrapper) return false
  const source = wrapper[1]!
  const script =
    /^import \{ Database \} from "bun:sqlite"; const db = new Database\(process\.env\.LAZERS_VERIFICATION_SQLITE\); db\.exec\("CREATE TABLE IF NOT EXISTS ([a-z][a-z0-9_]*)\(value TEXT\); INSERT INTO \1 VALUES \(char\(([0-9]{1,3}(?:,[0-9]{1,3})*)\)\)"\); db\.close\(\)$/.exec(
      source,
    )
  return Boolean(script && script[2]!.split(",").every((code) => Number(code) <= 255))
}

function segmentResources(segment: string): RetainedProcedureResource[] | undefined {
  if (segment === "true") return []
  if (sqliteSmokeCheck(segment)) return ["database"]

  const mkdir =
    /^mkdir -p "\$(HOME|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME)\/([^"$]+)"$/.exec(
      segment,
    )
  if (mkdir && safeRelativePath(mkdir[2]!)) {
    const resource = resourceForVariable(mkdir[1]!)
    return resource ? [resource] : undefined
  }

  const append =
    /^printf '(?:[^']*)' >> "\$(HOME|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME)\/([^"$]+)"$/.exec(
      segment,
    )
  if (append && safeRelativePath(append[2]!)) {
    const resource = resourceForVariable(append[1]!)
    return resource ? [resource] : undefined
  }

  const touch =
    /^touch "\$(HOME|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME)\/([^"$]+)"$/.exec(
      segment,
    )
  if (touch && safeRelativePath(touch[2]!)) {
    const resource = resourceForVariable(touch[1]!)
    return resource ? [resource] : undefined
  }

  if (/^sleep (?:[1-9]|[1-5][0-9]|60)$/.test(segment)) return []

  const test =
    /^test -(?:n|e|d) "\$(HOME|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME|LAZERS_VERIFICATION_SQLITE)(?:\/([^"$]+))?"$/.exec(
      segment,
    )
  if (test && (!test[2] || safeRelativePath(test[2]))) {
    const resource = resourceForVariable(test[1]!)
    return resource ? [resource] : undefined
  }

  const stdout =
    /^printf '(?:[^']*)'(?: "\$(HOME|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME|LAZERS_VERIFICATION_SQLITE)")*$/.exec(
      segment,
    )
  if (stdout) {
    const variables = [...segment.matchAll(/"\$([A-Z_]+)"/g)].map((match) => match[1]!)
    return variables.flatMap((variable) => {
      const resource = resourceForVariable(variable)
      return resource ? [resource] : []
    })
  }
  return undefined
}

/**
 * Bind only a small, inspectable shell subset to runtime-owned resources.
 * Opaque script/test runners are deliberately held: their transitive I/O cannot
 * be inferred from their command-line string.
 */
export function bindRetainedCheckProcedure(command: string): RetainedProcedureBindingResult {
  const segments = splitAndChain(command)
  if (!segments)
    return {
      status: "unsupported",
      reason: "uses shell composition whose mutable resources cannot be proven",
    }
  const names = new Set<RetainedProcedureResource>()
  let usedSQLiteSmoke = false
  for (const segment of segments) {
    const bound = segmentResources(segment)
    if (!bound)
      return {
        status: "unsupported",
        reason:
          "invokes an indirect script or unsupported command whose mutable resources are unknown",
      }
    for (const name of bound) names.add(name)
    if (sqliteSmokeCheck(segment)) usedSQLiteSmoke = true
  }
  const resources = [...names].sort()
  const kind = usedSQLiteSmoke
    ? "private-sqlite-smoke"
    : resources.length
      ? "owned-shell-resources"
      : "read-only"
  return {
    status: "supported",
    binding: {
      schemaVersion: 1,
      kind,
      commandFingerprint: fingerprint(command),
      resources,
    },
  }
}
