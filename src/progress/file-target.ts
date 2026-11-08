import { isAbsolute, relative, resolve, sep } from "node:path"

export const FILE_TARGET_LIMITS = {
  inputBytes: 16_384,
  pathBytes: 4_096,
  outputPathBytes: 512,
  targets: 8,
  outputBytes: 4_096,
} as const

export type FileTargetOperation = "read" | "edit" | "patch"
export type FileTargetCoverage = "observed" | "partial" | "omitted"

export type FileTargetObservation = {
  coverage: FileTargetCoverage
  operation: FileTargetOperation
  paths: string[]
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function ownData(value: JsonObject | undefined, key: string): unknown {
  if (!value) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function utf8Bytes(value: string, maximum: number): number | undefined {
  if (value.length > maximum) return undefined
  const bytes = new TextEncoder().encode(value).byteLength
  return bytes <= maximum ? bytes : undefined
}

function hasControlCharacters(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function workspaceRelative(workspace: string, candidate: unknown): string | undefined {
  if (
    typeof candidate !== "string" ||
    !candidate ||
    !utf8Bytes(candidate, FILE_TARGET_LIMITS.pathBytes) ||
    candidate.includes("\\") ||
    hasControlCharacters(candidate) ||
    /^[a-z][a-z\d+.-]*:/iu.test(candidate) ||
    candidate.startsWith("~") ||
    candidate.split("/").includes("..")
  )
    return undefined

  if (!isAbsolute(workspace) || !workspace || hasControlCharacters(workspace)) return undefined

  const root = resolve(workspace)
  const absolute = resolve(root, candidate)
  const relativePath = relative(root, absolute)
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    return undefined

  const normalized = relativePath.split(sep).join("/")
  return utf8Bytes(normalized, FILE_TARGET_LIMITS.outputPathBytes) ? normalized : undefined
}

type PatchParse = { paths: string[]; malformed: boolean }

function patchPaths(patchText: string): PatchParse {
  const lines = patchText.split(/\r\n|\n|\r/u)
  if (lines[0] === "*** Begin Patch") {
    if (lines.at(-1) !== "*** End Patch") return { paths: [], malformed: true }
    const paths: string[] = []
    for (const line of lines.slice(1, -1)) {
      const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line)
      if (match) {
        paths.push(match[2]!)
        continue
      }
      if (line.startsWith("*** ") && line !== "*** End of File")
        return { paths: [], malformed: true }
    }
    return { paths, malformed: paths.length === 0 }
  }

  const paths: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith("diff --git ")) {
      // Git's quoted-path grammar is intentionally not interpreted. Only simple
      // unquoted headers are accepted so patch text can never become a path.
      const match = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(line)
      if (!match) return { paths: [], malformed: true }
      let oldPath: string | undefined
      let newPath: string | undefined
      index++
      while (
        index < lines.length &&
        !lines[index]!.startsWith("diff --git ") &&
        !lines[index]!.startsWith("@@")
      ) {
        const header = lines[index]!
        if (header.startsWith("--- ")) oldPath = parseUnifiedPath(header.slice(4))
        if (header.startsWith("+++ ")) newPath = parseUnifiedPath(header.slice(4))
        index++
      }
      if (oldPath === undefined || newPath === undefined) return { paths: [], malformed: true }
      paths.push(newPath === "/dev/null" ? oldPath : newPath)
      continue
    }
    if (line.startsWith("--- ")) {
      const oldPath = parseUnifiedPath(line.slice(4))
      const next = lines[index + 1]
      if (oldPath === undefined || !next?.startsWith("+++ ")) return { paths: [], malformed: true }
      const newPath = parseUnifiedPath(next.slice(4))
      if (newPath === undefined) return { paths: [], malformed: true }
      paths.push(newPath === "/dev/null" ? oldPath : newPath)
      index += 2
      continue
    }
    index++
  }
  return { paths, malformed: paths.length === 0 }
}

function parseUnifiedPath(value: string): string | undefined {
  const path = value.split("\t", 1)[0]
  if (!path || path.includes('"')) return undefined
  if (path === "/dev/null") return path
  if (path.startsWith("a/")) return path.slice(2)
  if (path.startsWith("b/")) return path.slice(2)
  return path
}

function boundedObservation(
  operation: FileTargetOperation,
  candidates: readonly unknown[],
  malformed: boolean,
  workspace: string,
): FileTargetObservation {
  const paths: string[] = []
  const unique = new Set<string>()
  let omitted = malformed
  for (const candidate of candidates) {
    const path = workspaceRelative(workspace, candidate)
    if (!path) {
      omitted = true
      continue
    }
    if (unique.has(path)) continue
    if (paths.length >= FILE_TARGET_LIMITS.targets) {
      omitted = true
      continue
    }
    unique.add(path)
    paths.push(path)
  }

  let outputBytes = new TextEncoder().encode(JSON.stringify(paths)).byteLength
  while (paths.length && outputBytes > FILE_TARGET_LIMITS.outputBytes) {
    paths.pop()
    omitted = true
    outputBytes = new TextEncoder().encode(JSON.stringify(paths)).byteLength
  }
  return {
    coverage: paths.length === 0 ? "omitted" : omitted ? "partial" : "observed",
    operation,
    paths,
  }
}

/** Extract only registered tool path fields; raw arguments and patch bodies are never returned. */
export function observeFileTargets(
  tool: string,
  input: unknown,
  workspace: string,
): FileTargetObservation | undefined {
  const args = object(input)
  if (tool === "read" || tool === "edit") {
    const path = ownData(args, "path")
    return boundedObservation(tool, [path], path === undefined, workspace)
  }
  if (tool !== "patch") return undefined

  const patchText = ownData(args, "patchText")
  if (typeof patchText !== "string" || !utf8Bytes(patchText, FILE_TARGET_LIMITS.inputBytes))
    return boundedObservation("patch", [], true, workspace)

  const parsed = patchPaths(patchText)
  return boundedObservation("patch", parsed.paths, parsed.malformed, workspace)
}
