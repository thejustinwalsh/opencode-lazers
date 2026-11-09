import { runRemoteAction, parseRemoteValue, setLogLevel } from "repomix"
import type { CliOptions } from "repomix"
import { createReadStream, createWriteStream, statSync, unlinkSync } from "node:fs"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { isAbsolute, posix } from "node:path"

export type RepoProcessingInput = {
  snapshotID: string
  repository: string
  ref?: string
  include: string[]
  exclude: string[]
  requestedAt: number
  sourceFile: string
  artifactFile: string
}

export type RepositorySnapshotMetadata = {
  schemaVersion: 1
  snapshotID: string
  repository: string
  requestedRef: string | null
  refSelection: "argument" | "repository-url" | "default"
  resolvedRevision: null
  requestedAt: number
  fetchedAt: number
  durationMs: number
  repomix: "1.18.1"
  compression: "Tree-sitter"
  encoding: "o200k_base"
  sourceBytes: number
  selection: {
    include: string[]
    exclude: string[]
    defaultIgnorePatterns: true
    repositoryIgnoreFiles: true
    files: string[]
    skippedFiles: { path: string; reason: string }[]
  }
  metrics: { files: number; characters: number; tokens: number }
}

type RemoteResult = Awaited<ReturnType<typeof runRemoteAction>>
type RemoteRunner = (repository: string, options: CliOptions) => Promise<RemoteResult>

const artifactHeader = "<!-- LAZERS repository source snapshot v1\n"
const artifactHeaderEnd = "\n-->\n"

function safeRepositoryIdentity(value: string) {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return value.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]+@/i, "$1").split(/[?#]/, 1)[0]!
  }
}

function validRepositoryPath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === ".." || part === ".") &&
    !path.split("/").some((part) => part.length === 0)
  )
}

function repositoryUrlRef(value: string) {
  try {
    const url = new URL(value)
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return undefined
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length >= 4 && (parts[2] === "tree" || parts[2] === "commit"))
      return parts.slice(3).join("/")
  } catch {
    // Other accepted Git remote forms are resolved by Repomix's parser.
  }
  return undefined
}

function validOmittedRepositoryPath(path: string) {
  return (
    path.length > 0 &&
    !posix.isAbsolute(path) &&
    !path.split("/").some((part) => part === ".." || part === "." || part.length === 0)
  )
}

function assertPatterns(patterns: string[]) {
  for (const pattern of patterns) {
    const hasControlCharacter = [...pattern].some((character) => {
      const code = character.charCodeAt(0)
      return (code >= 0 && code <= 31) || (code >= 127 && code <= 159)
    })
    if (
      !pattern ||
      pattern.length > 512 ||
      pattern.includes(",") ||
      pattern.includes("\\") ||
      pattern.startsWith("!") ||
      pattern.split("/").some((part) => part === ".." || part === ".") ||
      hasControlCharacter ||
      pattern.startsWith("/")
    )
      throw new Error(`Invalid repository-relative path pattern: ${pattern}`)
  }
}

function removeIfPresent(path: string) {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export async function processRepositorySnapshot(
  input: RepoProcessingInput,
  runRemote: RemoteRunner = runRemoteAction,
) {
  const started = Date.now()
  setLogLevel(-1)
  assertPatterns(input.include)
  assertPatterns(input.exclude)
  const parsed = parseRemoteValue(input.repository)
  const urlRef = repositoryUrlRef(input.repository) ?? parsed.remoteBranch
  const selectedRef = input.ref ?? urlRef
  const refSelection = input.ref ? "argument" : urlRef ? "repository-url" : "default"
  const options: CliOptions = {
    remoteBranch: selectedRef,
    output: input.sourceFile,
    style: "markdown",
    compress: true,
    include: input.include.length ? input.include.join(",") : undefined,
    ignore: input.exclude.length ? input.exclude.join(",") : undefined,
    outputShowLineNumbers: false,
    fileSummary: true,
    directoryStructure: true,
    files: true,
    gitignore: true,
    defaultPatterns: true,
    skipLocalConfig: true,
    skipGlobalConfig: true,
    remoteTrustConfig: false,
    enableFileProcessors: false,
    confineToBaseDir: true,
    securityCheck: true,
    skipMigration: true,
    quiet: true,
  }

  try {
    // Keep URL-embedded refs intact; Repomix's remote action resolves tree URLs,
    // including refs containing slashes, before reducing them to a repository URL.
    const result = await runRemote(input.repository, options)
    const packed = result.packResult
    const sourceFilePaths = packed.processedFiles.map((file) => file.path)
    const unsafePaths = sourceFilePaths.filter((path) => !validRepositoryPath(path))
    if (unsafePaths.length)
      throw new Error("Repomix returned a path outside the selected repository")
    if (sourceFilePaths.length === 0)
      throw new Error("Repository selection contains no source files")

    const sourceStat = statSync(input.sourceFile)
    if (!sourceStat.isFile() || sourceStat.size === 0)
      throw new Error("Repomix returned an empty repository snapshot")
    const skippedFiles: { path: string; reason: string }[] = packed.skippedFiles.map((file) => {
      if (!validOmittedRepositoryPath(file.path))
        throw new Error("Repomix returned a skipped path outside the selected repository")
      return { path: file.path, reason: file.reason }
    })
    for (const file of packed.suspiciousFilesResults ?? []) {
      if (file.type !== "file") continue
      if (!validOmittedRepositoryPath(file.filePath))
        throw new Error("Repomix returned a security-omitted path outside the selected repository")
      skippedFiles.push({ path: file.filePath, reason: "security-check" })
    }
    const metadata: RepositorySnapshotMetadata = {
      schemaVersion: 1,
      snapshotID: input.snapshotID,
      repository: safeRepositoryIdentity(parsed.repoUrl),
      requestedRef: selectedRef ?? null,
      refSelection,
      resolvedRevision: null,
      requestedAt: input.requestedAt,
      fetchedAt: Date.now(),
      durationMs: Date.now() - started,
      repomix: "1.18.1",
      compression: "Tree-sitter",
      encoding: "o200k_base",
      sourceBytes: sourceStat.size,
      selection: {
        include: [...input.include],
        exclude: [...input.exclude],
        defaultIgnorePatterns: true,
        repositoryIgnoreFiles: true,
        files: sourceFilePaths,
        skippedFiles,
      },
      metrics: {
        files: sourceFilePaths.length,
        characters: packed.totalCharacters,
        tokens: packed.totalTokens,
      },
    }
    const header = `${artifactHeader}${JSON.stringify(metadata)}${artifactHeaderEnd}`
    const content = Readable.from(
      (async function* () {
        yield Buffer.from(header)
        for await (const chunk of createReadStream(input.sourceFile)) yield chunk
      })(),
    )
    await pipeline(content, createWriteStream(input.artifactFile, { flags: "wx", mode: 0o600 }))
    const artifactStat = statSync(input.artifactFile)
    if (artifactStat.size !== Buffer.byteLength(header) + sourceStat.size)
      throw new Error("Repomix output changed while saving")
  } finally {
    removeIfPresent(input.sourceFile)
  }
}
