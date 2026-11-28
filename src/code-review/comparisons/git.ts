import { Buffer } from "node:buffer"

export type GitFile = {
  path: string
  mode: string
  objectID: string
  size: number | null
  kind: "text" | "binary" | "symlink" | "submodule" | "unknown"
}

export type GitHunk = {
  baseStart: number
  baseEnd: number
  headStart: number
  headEnd: number
}

export type GitIndexFile = { path: string; mode: string; objectID: string; stage: number }

function pathText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

export function nulStrings(bytes: Uint8Array): string[] {
  const result: string[] = []
  let start = 0
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 0) continue
    if (index > start) result.push(pathText(bytes.subarray(start, index)))
    start = index + 1
  }
  return result
}

export function indexFiles(bytes: Uint8Array): GitIndexFile[] {
  return nulStrings(bytes).flatMap((entry) => {
    const tab = entry.indexOf("\t")
    if (tab < 0) throw new Error("Git returned a malformed index entry")
    const [mode, objectID, stageText] = entry.slice(0, tab).split(" ")
    if (!mode || !objectID || stageText === undefined)
      throw new Error("Git returned an incomplete index entry")
    return [{ path: entry.slice(tab + 1), mode, objectID, stage: Number(stageText) }]
  })
}

export async function gitBytes(
  directory: string,
  args: readonly string[],
  signal?: AbortSignal,
  input?: string,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  const child = Bun.spawn(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : "pipe",
    ...(signal ? { signal } : {}),
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  })
  if (input !== undefined) {
    child.stdin!.write(input)
    child.stdin!.end()
  }
  const stdout = new Response(child.stdout).arrayBuffer()
  const stderr = new Response(child.stderr).text()
  const [output, error, exitCode] = await Promise.all([stdout, stderr, child.exited])
  signal?.throwIfAborted()
  if (exitCode !== 0)
    throw new Error(
      `git ${args[0]} failed: ${(error || "unknown Git error").trim().slice(0, 1200)}`,
    )
  return new Uint8Array(output)
}

export async function blobBatch(
  directory: string,
  objectIDs: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  const unique = [...new Set(objectIDs)]
  if (unique.length === 0) return new Map()
  if (unique.some((id) => !/^[0-9a-f]{40,64}$/.test(id)))
    throw new Error("Invalid Git blob identity")
  const output = await gitBytes(
    directory,
    ["cat-file", "--batch"],
    signal,
    `${unique.join("\n")}\n`,
  )
  const result = new Map<string, Uint8Array>()
  let cursor = 0
  for (const requested of unique) {
    const lineEnd = output.indexOf(10, cursor)
    if (lineEnd < 0) throw new Error("Git returned a truncated blob batch")
    const header = new TextDecoder().decode(output.subarray(cursor, lineEnd)).split(" ")
    if (header[1] !== "blob") throw new Error(`Git object ${requested} is unavailable as a blob`)
    const size = Number(header[2])
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("Git returned an invalid blob size")
    cursor = lineEnd + 1
    if (cursor + size > output.length) throw new Error("Git returned a truncated blob")
    result.set(requested, output.slice(cursor, cursor + size))
    cursor += size
    if (output[cursor] !== 10) throw new Error("Git returned a malformed blob boundary")
    cursor++
  }
  return result
}

export async function blobSizes(
  directory: string,
  objectIDs: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const unique = [...new Set(objectIDs)]
  if (unique.length === 0) return new Map()
  if (unique.some((id) => !/^[0-9a-f]{40,64}$/.test(id)))
    throw new Error("Invalid Git object identity")
  const output = await gitBytes(
    directory,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    signal,
    `${unique.join("\n")}\n`,
  )
  const result = new Map<string, number>()
  for (const line of new TextDecoder().decode(output).trimEnd().split("\n")) {
    const [objectID, type, size] = line.split(" ")
    const parsed = Number(size)
    if (!objectID || type !== "blob" || !Number.isSafeInteger(parsed) || parsed < 0)
      throw new Error("Git returned an invalid object size")
    result.set(objectID, parsed)
  }
  if (result.size !== unique.length) throw new Error("Git returned an incomplete object-size batch")
  return result
}

export async function gitText(
  directory: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return new TextDecoder().decode(await gitBytes(directory, args, signal))
}

export async function requireCommit(
  directory: string,
  revision: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision))
    throw new Error("The selected revision is not a full Git object ID")
  const resolved = (
    await gitText(directory, ["rev-parse", "--verify", `${revision}^{commit}`], signal)
  ).trim()
  if (resolved !== revision) throw new Error("The selected revision is unavailable")
  return resolved
}

export async function commitIsAncestor(
  directory: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ancestor) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(descendant)
  )
    throw new Error("The selected baseline is not a full Git commit")
  signal?.throwIfAborted()
  const child = Bun.spawn(
    ["git", "-C", directory, "merge-base", "--is-ancestor", ancestor, descendant],
    {
      stdout: "ignore",
      stderr: "pipe",
      ...(signal ? { signal } : {}),
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    },
  )
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  signal?.throwIfAborted()
  if (exitCode === 0) return true
  if (exitCode === 1) return false
  throw new Error(`git merge-base failed: ${(stderr || "unknown Git error").trim().slice(0, 1200)}`)
}

export async function treeFiles(
  directory: string,
  revision: string,
  signal?: AbortSignal,
): Promise<Map<string, GitFile>> {
  await requireCommit(directory, revision, signal)
  const bytes = await gitBytes(
    directory,
    ["ls-tree", "-r", "-l", "-z", "--full-tree", revision],
    signal,
  )
  return parseTreeFiles(bytes)
}

function nulRecords(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = []
  let start = 0
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 0) continue
    if (index > start) records.push(bytes.subarray(start, index))
    start = index + 1
  }
  return records
}

function treeFile(row: Uint8Array): GitFile {
  const entry = treeEntry(row)
  return {
    path: entry.path,
    mode: entry.mode,
    objectID: entry.objectID,
    size: entry.size,
    kind: treeFileKind(entry.path, entry.mode),
  }
}

function treeEntry(row: Uint8Array): {
  path: string
  mode: string
  objectID: string
  size: number | null
} {
  const tab = row.indexOf(9)
  if (tab < 0) throw new Error("Git returned a malformed tree entry")
  const metadata = pathText(row.subarray(0, tab)).trim().split(/\s+/)
  const [mode, type, objectID, sizeText, ...extra] = metadata
  if (!mode || !type || !objectID || sizeText === undefined || extra.length > 0)
    throw new Error("Git returned an incomplete tree entry")
  return {
    path: pathText(row.subarray(tab + 1)),
    mode,
    objectID,
    size: treeEntrySize(sizeText),
  }
}

function treeEntrySize(value: string): number | null {
  if (value === "-") return null
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error("Git returned an invalid tree-entry size")
  return size
}

function treeFileKind(path: string, mode: string): GitFile["kind"] {
  if (mode === "120000") return "symlink"
  if (mode === "160000") return "submodule"
  if (isConfidentialSourcePath(path)) return "unknown"
  if (isKnownBinaryPath(path)) return "binary"
  if (isSourcePath(path)) return "text"
  return "unknown"
}

function parseTreeFiles(bytes: Uint8Array): Map<string, GitFile> {
  const files = new Map<string, GitFile>()
  for (const row of nulRecords(bytes)) {
    const file = treeFile(row)
    files.set(file.path, file)
  }
  return files
}

export async function diffHunks(
  directory: string,
  base: string,
  head: string,
  signal?: AbortSignal,
): Promise<Map<string, GitHunk[]>> {
  const output = await gitText(
    directory,
    ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--unified=0", base, head, "--"],
    signal,
  )
  return diffHunksFromText(output)
}

export async function diffPaths(
  directory: string,
  base: string,
  head: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const output = await gitBytes(
    directory,
    ["diff", "--name-only", "-z", "--no-renames", base, head, "--"],
    signal,
  )
  return nulStrings(output)
}

function filePathFromHeader(value: string, prefix: string): string | undefined {
  const path = unquoteGitPath(value)
  return path === "/dev/null" ? undefined : stripPrefix(path, prefix)
}

function parseHunkHeader(line: string): GitHunk | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (!match) return undefined
  const baseStart = Number(match[1])
  const baseCount = Number(match[2] ?? 1)
  const headStart = Number(match[3])
  const headCount = Number(match[4] ?? 1)
  return {
    baseStart,
    baseEnd: baseCount === 0 ? baseStart : baseStart + baseCount - 1,
    headStart,
    headEnd: headCount === 0 ? headStart : headStart + headCount - 1,
  }
}

export function diffHunksFromText(output: string): Map<string, GitHunk[]> {
  const hunks = new Map<string, GitHunk[]>()
  let path: string | undefined
  let removedPath: string | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("--- ")) {
      removedPath = filePathFromHeader(line.slice(4), "a/")
      continue
    }
    if (line.startsWith("+++ ")) {
      path = filePathFromHeader(line.slice(4), "b/") ?? removedPath
      continue
    }
    const hunk = parseHunkHeader(line)
    if (!hunk || !path) continue
    const entries = hunks.get(path) ?? []
    entries.push(hunk)
    hunks.set(path, entries)
  }
  return hunks
}

export async function blobBytes(
  directory: string,
  objectID: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!/^[0-9a-f]{40,64}$/.test(objectID)) throw new Error("Invalid Git blob identity")
  return gitBytes(directory, ["cat-file", "blob", objectID], signal)
}

export function isSourcePath(path: string): boolean {
  const base = path.split("/").at(-1)!.toLowerCase()
  if (
    [
      ".dockerignore",
      ".editorconfig",
      ".eslintignore",
      ".gitignore",
      ".gitattributes",
      ".gitmodules",
      ".fallowignore",
      ".npmrc",
      ".npmignore",
      ".prettierignore",
      ".yarnrc",
      ".ignore",
      ".node-version",
      ".python-version",
      ".tool-versions",
      "dockerfile",
      "codeowners",
      "gemfile",
      "justfile",
      "makefile",
      "pipfile",
      "procfile",
      "bun.lock",
      "package.json",
      "cargo.lock",
      "composer.lock",
      "gemfile.lock",
      "gopkg.lock",
      "go.sum",
      "pipfile.lock",
      "poetry.lock",
      "uv.lock",
      "yarn.lock",
      "pnpm-lock.yaml",
      "mix.lock",
      "flake.lock",
      "tsconfig.json",
      "bunfig.toml",
      "cargo.toml",
      "go.mod",
      "pyproject.toml",
    ].includes(base)
  )
    return true
  if (base !== ".envrc" && /^\.[a-z0-9._-]+rc(?:\.(?:json|ya?ml|toml|[cm]?js))?$/i.test(base))
    return true
  return /\.(?:c|cc|cpp|cs|css|dart|ex|exs|go|graphql|h|hpp|html|java|js|jsx|json|jsonc|kt|lua|md|mjs|mts|php|proto|py|rb|rs|scss|sh|sql|svelte|swift|ts|tsx|vue|xml|yaml|yml|toml|txt|svg)$/i.test(
    path,
  )
}

/** Mirrors the source-context exclusions; these paths remain inventory-only in code review. */
export function isConfidentialSourcePath(path: string): boolean {
  return (
    /(^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/i.test(
      path,
    ) && !/(?:^|\/)\.env\.example$/.test(path)
  )
}

export function isKnownBinaryPath(path: string): boolean {
  return /\.(?:7z|a|avif|bin|bmp|class|dylib|eot|exe|gif|gz|ico|jpeg|jpg|lockb|mp3|mp4|o|pdf|png|so|sqlite|wasm|webp|woff2?|zip)$/i.test(
    path,
  )
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"')) return value
  const output: number[] = []
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index]!
    if (char !== "\\") {
      output.push(...new TextEncoder().encode(char))
      continue
    }
    const next = value[++index]
    if (next === undefined) break
    const escaped: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      "\\": 92,
      '"': 34,
    }
    if (next in escaped) {
      output.push(escaped[next]!)
      continue
    }
    const octal = next + value.slice(index + 1, index + 3)
    if (/^[0-7]{3}$/.test(octal)) {
      output.push(Number.parseInt(octal, 8))
      index += 2
      continue
    }
    output.push(...new TextEncoder().encode(next))
  }
  return Buffer.from(output).toString("utf8")
}

export function bytesAreText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}
