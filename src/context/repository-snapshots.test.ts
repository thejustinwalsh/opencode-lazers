import { afterEach, expect, test } from "bun:test"
import {
  closeSync,
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
import { RepositorySnapshotStore, type RepositorySnapshotWorker } from "./repository-snapshots.ts"
import { processRepositorySnapshot } from "./repo-processor.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture(worker: RepositorySnapshotWorker) {
  const root = mkdtempSync(join(tmpdir(), "lazers-repo-snapshot-"))
  const repository = new TaskRepository(join(root, "tasks.sqlite"), root)
  const store = new RepositorySnapshotStore(
    join(root, "context", "repositories"),
    repository,
    worker,
  )
  cleanups.push(() => {
    store.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, store }
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
