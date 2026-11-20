import { afterEach, expect, test } from "bun:test"
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRemoteAction } from "repomix"
import type { CliOptions } from "repomix"
import { TaskRepository } from "../storage.ts"
import {
  RepositorySnapshotStore,
  runRepositoryWorker,
  type RepositorySnapshotWorker,
} from "./repository-snapshots.ts"
import { processRepositorySnapshot } from "./repo-processor.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture(worker: RepositorySnapshotWorker, cacheLimitBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "lazers-repo-snapshot-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const store = new RepositorySnapshotStore(
    join(root, "context", "repositories"),
    repository,
    worker,
    cacheLimitBytes,
  )
  cleanups.push(() => {
    store.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, store }
}

async function waitForStagedSource(directory: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const filename = readdirSync(directory).find((name) => name.startsWith(".source-"))
    // The staging file exists empty before the worker writes into it; wait for its content.
    if (filename && readFileSync(join(directory, filename), "utf8") !== "")
      return join(directory, filename)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Background worker did not stage its source file")
}

test("external snapshots keep full source, selection and omitted-file provenance while bounding tool output", async () => {
  const source = `## Compressed source\n${"export const answer = 42;\n".repeat(12_000)}`
  let seenOptions: CliOptions | undefined
  const remote: typeof runRemoteAction = async (_repository, options) => {
    seenOptions = options
    writeFileSync(options.output!, source)
    const processedFiles = Array.from({ length: 5001 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      content: "export const answer = 42;",
      level: "compress" as const,
    }))
    return {
      packResult: {
        processedFiles,
        skippedFiles: [{ path: "assets/large-map.json", reason: "size-limit" }],
        totalCharacters: source.length,
        totalTokens: 75_000,
      } as unknown as Awaited<ReturnType<typeof runRemoteAction>>["packResult"],
      config: {} as Awaited<ReturnType<typeof runRemoteAction>>["config"],
    }
  }
  const f = fixture((input, signal) =>
    processRepositorySnapshot(input, remote).then(() => {
      signal?.throwIfAborted()
    }),
  )
  const include = Array.from({ length: 25 }, (_, index) => `src/group-${index}/**/*.ts`)
  const result = await f.store.create({
    repository: "owner/project",
    ref: "release/2026",
    include,
    exclude: ["docs/generated/**"],
  })

  expect(seenOptions).toMatchObject({
    remoteBranch: "release/2026",
    compress: true,
    style: "markdown",
    skipLocalConfig: true,
    skipGlobalConfig: true,
    remoteTrustConfig: false,
    enableFileProcessors: false,
    confineToBaseDir: true,
  })
  expect(seenOptions?.include).toBe(include.join(","))
  expect(result.repository).toBe("https://github.com/owner/project.git")
  expect(result.requestedRef).toBe("release/2026")
  expect(result.refSelection).toBe("argument")
  expect(result.resolvedRevision).toBeNull()
  expect(result.selection.totalFiles).toBe(5001)
  expect(result.selection.files).toHaveLength(100)
  expect(result.selection.filesTruncated).toBe(true)
  expect(result.selection.include).toEqual(include)
  expect(result.selection.omittedFiles).toEqual([
    { path: "assets/large-map.json", reason: "size-limit" },
  ])
  expect(result.sourceTruncated).toBe(true)
  expect(Buffer.byteLength(result.source)).toBeLessThanOrEqual(128 * 1024)
  expect(result.sourceBytes).toBe(Buffer.byteLength(source))
  expect(result.reused).toBe(false)

  const artifact = readFileSync(result.snapshotFile, "utf8")
  const headerStart = "<!-- LAZERS repository source snapshot v1\n".length
  const headerEnd = artifact.indexOf("\n-->\n")
  const metadata = JSON.parse(artifact.slice(headerStart, headerEnd)) as {
    selection: { files: string[]; skippedFiles: { path: string; reason: string }[] }
  }
  expect(metadata.selection.files).toHaveLength(5001)
  expect(metadata.selection.skippedFiles).toEqual([
    { path: "assets/large-map.json", reason: "size-limit" },
  ])
  expect(artifact.slice(headerEnd + "\n-->\n".length)).toBe(source)

  const reused = f.store.read(result.snapshotID)
  expect(reused).toMatchObject({
    snapshotID: result.snapshotID,
    snapshotFile: result.snapshotFile,
    source: result.source,
    sourceBytes: result.sourceBytes,
    sourceTruncated: true,
    reused: true,
  })
})

test("URL refs with slashes reach Repomix intact and ref provenance distinguishes URL, argument, and default", async () => {
  const calls: { repository: string; remoteBranch: string | undefined }[] = []
  const source = "## Compressed selection\nexport const selected = true;\n"
  const remote: typeof runRemoteAction = async (repository, options) => {
    calls.push({ repository, remoteBranch: options.remoteBranch })
    writeFileSync(options.output!, source)
    return {
      packResult: {
        processedFiles: [
          { path: "src/selected.ts", content: "export const selected = true;", level: "compress" },
        ],
        skippedFiles: [],
        totalCharacters: source.length,
        totalTokens: 12,
      } as unknown as Awaited<ReturnType<typeof runRemoteAction>>["packResult"],
      config: {} as Awaited<ReturnType<typeof runRemoteAction>>["config"],
    }
  }
  const f = fixture((input) => processRepositorySnapshot(input, remote))
  const treeURL = "https://github.com/owner/project/tree/release/2026"
  const tree = await f.store.create({ repository: treeURL, include: ["src/**"], exclude: [] })
  const explicit = await f.store.create({
    repository: treeURL,
    ref: "hotfix/explicit",
    include: ["src/**"],
    exclude: [],
  })
  const defaultRef = await f.store.create({
    repository: "owner/default",
    include: ["src/**"],
    exclude: [],
  })

  expect(calls).toEqual([
    { repository: treeURL, remoteBranch: "release/2026" },
    { repository: treeURL, remoteBranch: "hotfix/explicit" },
    { repository: "owner/default", remoteBranch: undefined },
  ])
  expect(tree).toMatchObject({
    repository: "https://github.com/owner/project.git",
    requestedRef: "release/2026",
    refSelection: "repository-url",
    resolvedRevision: null,
    source: expect.stringContaining("export const selected = true"),
  })
  expect(explicit).toMatchObject({ requestedRef: "hotfix/explicit", refSelection: "argument" })
  expect(defaultRef).toMatchObject({ requestedRef: null, refSelection: "default" })
})

test("long POSIX backslash paths in omission metadata do not discard useful source", async () => {
  const source = "## Compressed source\nexport const available = true;\n"
  const omittedPath = `assets/${"nested".repeat(180)}\\large-map.json`
  const remote: typeof runRemoteAction = async (_repository, options) => {
    writeFileSync(options.output!, source)
    return {
      packResult: {
        processedFiles: [
          {
            path: "src/available.ts",
            content: "export const available = true;",
            level: "compress",
          },
        ],
        skippedFiles: [{ path: omittedPath, reason: "size-limit" }],
        totalCharacters: source.length,
        totalTokens: 12,
      } as unknown as Awaited<ReturnType<typeof runRemoteAction>>["packResult"],
      config: {} as Awaited<ReturnType<typeof runRemoteAction>>["config"],
    }
  }
  const f = fixture((input) => processRepositorySnapshot(input, remote))
  const result = await f.store.create({ repository: "owner/project", include: [], exclude: [] })

  expect(omittedPath.length).toBeGreaterThan(1024)
  expect(result.source).toContain("export const available = true")
  expect(result.selection.omittedFiles).toEqual([{ path: omittedPath, reason: "size-limit" }])
  expect(f.store.read(result.snapshotID).selection.omittedFiles).toEqual(
    result.selection.omittedFiles,
  )
})

test("cache pressure expires older snapshots instead of rejecting later useful output", async () => {
  const source = "## Compressed source\nexport const retained = true;\n"
  const remote: typeof runRemoteAction = async (_repository, options) => {
    writeFileSync(options.output!, source)
    return {
      packResult: {
        processedFiles: [
          { path: "src/retained.ts", content: "export const retained = true;", level: "compress" },
        ],
        skippedFiles: [],
        totalCharacters: source.length,
        totalTokens: 12,
      } as unknown as Awaited<ReturnType<typeof runRemoteAction>>["packResult"],
      config: {} as Awaited<ReturnType<typeof runRemoteAction>>["config"],
    }
  }
  const f = fixture((input) => processRepositorySnapshot(input, remote), 1)
  const request = { repository: "owner/project", include: [], exclude: [] }
  const first = await f.store.create(request)
  const second = await f.store.create(request)

  expect(second.source).toContain("export const retained = true")
  expect(f.store.read(second.snapshotID).source).toBe(second.source)
  expect(() => f.store.read(first.snapshotID)).toThrow("Repository snapshot is unavailable")
  expect(
    readdirSync(join(f.root, "context", "repositories")).filter((name) =>
      /^repo-[a-f0-9-]{36}\.json\.md$/.test(name),
    ),
  ).toHaveLength(1)
})

test("remote failures and cancellation never publish partial snapshots or hide the earlier artifact", async () => {
  const source = "## Existing complete snapshot\nexport const stable = true;\n"
  let shouldFail = false
  const remote: typeof runRemoteAction = async (_repository, options) => {
    if (shouldFail) throw new Error("upstream unavailable")
    writeFileSync(options.output!, source)
    return {
      packResult: {
        processedFiles: [
          { path: "src/stable.ts", content: "export const stable = true;", level: "compress" },
        ],
        skippedFiles: [],
        totalCharacters: source.length,
        totalTokens: 12,
      } as unknown as Awaited<ReturnType<typeof runRemoteAction>>["packResult"],
      config: {} as Awaited<ReturnType<typeof runRemoteAction>>["config"],
    }
  }
  const f = fixture((input) => processRepositorySnapshot(input, remote))
  const request = { repository: "owner/project", include: [], exclude: [] }
  const original = await f.store.create(request)
  shouldFail = true
  await expect(f.store.create(request)).rejects.toThrow("upstream unavailable")
  expect(f.store.read(original.snapshotID).source).toContain("Existing complete snapshot")
  expect(
    readdirSync(join(f.root, "context", "repositories")).filter((name) =>
      name.endsWith(".json.md"),
    ),
  ).toHaveLength(1)

  let entered!: () => void
  const waiting = new Promise<void>((resolve) => (entered = resolve))
  const cancelledRepository = new TaskRepository(join(f.root, "cancelled.sqlite"), f.root)
  const cancelledStore = new RepositorySnapshotStore(
    join(f.root, "cancelled", "repositories"),
    cancelledRepository,
    async (input, signal) => {
      writeFileSync(input.sourceFile, "unpublished partial source")
      entered()
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      })
    },
  )
  cleanups.push(() => {
    cancelledStore.close()
    cancelledRepository.close()
  })
  const controller = new AbortController()
  const pending = cancelledStore.create(request, controller.signal)
  await waiting
  controller.abort()
  await expect(pending).rejects.toThrow("cancelled")
  expect(readdirSync(join(f.root, "cancelled", "repositories"))).toEqual([])
})

test("actual background cancellation terminates the worker and removes partial staging", async () => {
  const f = fixture((input, signal, workers) =>
    runRepositoryWorker(input, signal, workers, {
      workerURL: new URL("./repository-snapshot-worker-fixture.ts", import.meta.url),
      timeoutMs: 10_000,
    }),
  )
  const directory = join(f.root, "context", "repositories")
  const controller = new AbortController()
  const pending = f.store.create(
    { repository: "owner/project", include: [], exclude: [] },
    controller.signal,
  )
  const stagedSource = await waitForStagedSource(directory)

  expect(readFileSync(stagedSource, "utf8")).toBe("unpublished partial source")
  controller.abort(new Error("background cancellation"))
  await expect(pending).rejects.toThrow("background cancellation")
  expect(readdirSync(directory)).toEqual([])
})

test("actual background timeout removes staging and publishes no artifact", async () => {
  const f = fixture((input, signal, workers) =>
    runRepositoryWorker(input, signal, workers, {
      workerURL: new URL("./repository-snapshot-worker-fixture.ts", import.meta.url),
      timeoutMs: 100,
    }),
  )
  const directory = join(f.root, "context", "repositories")
  await expect(
    f.store.create({ repository: "owner/project", include: [], exclude: [] }),
  ).rejects.toThrow("Remote Repomix research exceeded 100ms")
  expect(readdirSync(directory)).toEqual([])
})

test("background processing ignores inherited remote trust and disables repository config execution", async () => {
  const f = fixture((input, signal, workers) =>
    runRepositoryWorker(input, signal, workers, {
      workerURL: new URL("./repository-snapshot-policy-worker-fixture.ts", import.meta.url),
    }),
  )
  const previousTrust = process.env.REPOMIX_REMOTE_TRUST_CONFIG
  const previousMarker = process.env.LAZERS_REPO_SNAPSHOT_CONFIG_MARKER
  const marker = join(f.root, "remote-config-executed")
  process.env.REPOMIX_REMOTE_TRUST_CONFIG = "true"
  process.env.LAZERS_REPO_SNAPSHOT_CONFIG_MARKER = marker
  try {
    const result = await f.store.create({
      repository: "owner/project",
      include: [],
      exclude: [],
    })
    expect(result.source).toContain("export const safe = true")
    expect(existsSync(marker)).toBe(false)
    expect(result.snapshotFile.startsWith(`${f.store.cacheDirectory}/`)).toBe(true)
    expect(f.store.read(result.snapshotID).source).toBe(result.source)
  } finally {
    if (previousTrust === undefined) delete process.env.REPOMIX_REMOTE_TRUST_CONFIG
    else process.env.REPOMIX_REMOTE_TRUST_CONFIG = previousTrust
    if (previousMarker === undefined) delete process.env.LAZERS_REPO_SNAPSHOT_CONFIG_MARKER
    else process.env.LAZERS_REPO_SNAPSHOT_CONFIG_MARKER = previousMarker
  }
})

test("source beyond prior 32/64 MiB gates is streamed completely and reusable beyond the bounded preview", async () => {
  const sourceBytes = 64 * 1024 * 1024 + 1
  let runs = 0
  const remote: typeof runRemoteAction = async (_repository, options) => {
    runs++
    writeFileSync(options.output!, Buffer.alloc(sourceBytes, 0x41))
    return {
      packResult: {
        processedFiles: [
          { path: "src/large.ts", content: "export const value = true;", level: "compress" },
        ],
        skippedFiles: [],
        totalCharacters: sourceBytes,
        totalTokens: 1,
      } as unknown as Awaited<ReturnType<typeof runRemoteAction>>["packResult"],
      config: {} as Awaited<ReturnType<typeof runRemoteAction>>["config"],
    }
  }
  const f = fixture((input) => processRepositorySnapshot(input, remote))
  const result = await f.store.create({ repository: "owner/project", include: [], exclude: [] })
  expect(runs).toBe(1)
  expect(result.sourceTruncated).toBe(true)
  expect(result.sourceBytes).toBe(sourceBytes)
  expect(Buffer.byteLength(result.source)).toBe(128 * 1024)
  expect(statSync(result.snapshotFile).size).toBeGreaterThan(64 * 1024 * 1024)

  const fd = openSync(result.snapshotFile, "r")
  try {
    const header = Buffer.alloc(64 * 1024)
    const bytesRead = readSync(fd, header, 0, header.length, 0)
    const bodyOffset =
      header.subarray(0, bytesRead).indexOf(Buffer.from("\n-->\n")) + "\n-->\n".length
    const finalByte = Buffer.alloc(1)
    readSync(fd, finalByte, 0, 1, statSync(result.snapshotFile).size - 1)
    expect(bodyOffset).toBeGreaterThan(0)
    expect(finalByte[0]).toBe(0x41)
  } finally {
    closeSync(fd)
  }

  const reread = f.store.read(result.snapshotID)
  expect(reread.source).toBe(result.source)
  expect(reread.sourceBytes).toBe(sourceBytes)
  expect(reread.reused).toBe(true)
  expect(runs).toBe(1)
})

test("an empty Repomix selection is an explicit failure and publishes no artifact", async () => {
  const remote: typeof runRemoteAction = async (_repository, options) => {
    writeFileSync(options.output!, "Repomix summary without files")
    return {
      packResult: {
        processedFiles: [],
        skippedFiles: [],
        totalCharacters: 0,
        totalTokens: 0,
      } as unknown as Awaited<ReturnType<typeof runRemoteAction>>["packResult"],
      config: {} as Awaited<ReturnType<typeof runRemoteAction>>["config"],
    }
  }
  const f = fixture((input) => processRepositorySnapshot(input, remote))
  await expect(
    f.store.create({ repository: "owner/project", include: ["missing/**"], exclude: [] }),
  ).rejects.toThrow("no source files")
  expect(readdirSync(join(f.root, "context", "repositories"))).toEqual([])
})
