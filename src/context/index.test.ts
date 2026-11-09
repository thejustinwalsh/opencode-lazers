import { afterEach, expect, test } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskRepository } from "../storage.ts"
import { git } from "../runner/artifacts.ts"
import { ProjectIndex, WorkspaceIndexUnavailable } from "./index.ts"
import { validProposal } from "../../test/proposal.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lazers-index-"))
  git(root, ["init", "--initial-branch=main"])
  mkdirSync(join(root, "src"))
  writeFileSync(
    join(root, "src", "feature.ts"),
    "/** Current policy. */\nexport function feature(input: string): string {\n const value = input.trim();\n return value.toUpperCase();\n}\n",
  )
  writeFileSync(join(root, ".gitignore"), "ignored/\ncache/\ndata/\n")
  mkdirSync(join(root, "ignored"))
  writeFileSync(join(root, "ignored", "never.txt"), "never collect")
  writeFileSync(join(root, ".repomixignore"), "custom.txt\n")
  writeFileSync(join(root, "custom.txt"), "custom ignored")
  writeFileSync(join(root, ".env"), "SECRET=never")
  writeFileSync(join(root, "denied.txt"), "private")
  writeFileSync(join(root, "untracked.txt"), "dirty source")
  symlinkSync("/etc/passwd", join(root, "escape.txt"))
  const repository = new TaskRepository(join(root, "data", "tasks.sqlite"), root)
  const denied = new Map<string, Set<string>>(),
    permissionChecks: { path: string; agent: string }[] = [],
    cacheDirectory = join(root, "cache")
  const allow = async (path: string, principal: { agent: string }) => {
    permissionChecks.push({ path, agent: principal.agent })
    return !denied.get(principal.agent)?.has(path)
  }
  let index = new ProjectIndex(root, cacheDirectory, repository, allow)
  cleanups.push(() => {
    index.close()
    repository.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    repository,
    cacheDirectory,
    allow,
    denied,
    permissionChecks,
    get index() {
      return index
    },
    set index(value: ProjectIndex) {
      index = value
    },
  }
}

const architect = { sessionID: "architect-session", agent: "architect" }
const worker = { sessionID: "worker-session", agent: "lazers-implementor" }

test("index refresh supports native process worker observers", async () => {
  const f = fixture()
  let observed = 0
  let observerError: unknown
  const observe: Parameters<typeof process.on<"worker">>[1] = (thread) => {
    observed++
    try {
      thread.on("message", () => {})
      thread.once("exit", () => {})
    } catch (error) {
      observerError = error
    }
  }
  process.on("worker", observe)
  try {
    await f.index.refresh(architect)
    expect(observed).toBeGreaterThan(0)
    expect(observerError).toBeUndefined()
    expect(
      (await f.index.manifest(architect)).files.some((file) => file.path === "src/feature.ts"),
    ).toBe(true)
  } finally {
    process.off("worker", observe)
  }
})

function cacheState(f: ReturnType<typeof fixture>) {
  return {
    files: readdirSync(f.cacheDirectory)
      .sort()
      .map((name) => {
        const stat = statSync(join(f.cacheDirectory, name))
        return [name, stat.size, stat.mtimeMs]
      }),
    row: f.repository.atomic((db) =>
      db
        .query<{ stamp: string; file: string }, [string, string]>(
          "SELECT stamp,file FROM context_cache WHERE workspace=? AND selection=?",
        )
        .get(f.index.root, "$workspace"),
    ),
  }
}

function disableIndexWork(index: ProjectIndex) {
  const fail = () => {
    throw new Error("Read queries must not collect or process the workspace")
  }
  Reflect.set(index, "collectWorkspace", fail)
  Reflect.set(index, "processWorkspace", fail)
}

test("explicit refresh uses pinned Repomix and preserves ignore, secret, permission, and symlink protections", async () => {
  const f = fixture()
  f.denied.set(architect.agent, new Set(["denied.txt"]))
  const built = await f.index.refresh(architect)
  const manifest = await f.index.manifest(architect)
  const paths = manifest.files.map((file) => file.path)
  expect(paths).toContain("src/feature.ts")
  expect(paths).toContain("untracked.txt")
  for (const name of ["ignored/never.txt", ".env", "custom.txt", "denied.txt", "escape.txt"])
    expect(paths).not.toContain(name)
  expect(manifest.repomix).toBe("1.18.1")
  expect(manifest.snapshotID).toBe(built.id)
  expect(manifest.freshness).toBe("as-of-refresh")
  expect(manifest.refreshedAt).toBe(built.createdAt)

  const full = await f.index.evidence(architect, {
    paths: ["src/feature.ts"],
    level: "full",
    startLine: 2,
    endLine: 5,
  })
  const outline = await f.index.evidence(architect, { paths: ["src/feature.ts"], level: "outline" })
  expect(full.sources[0]!.text).toContain("toUpperCase")
  expect(outline.sources[0]!.text).toContain("feature")
  expect(outline.sources[0]!.text).not.toContain("toUpperCase")
  expect(full.snapshotID).toBe(manifest.snapshotID)
  expect(full.sources[0]!.revision).toBeNull()

  writeFileSync(join(f.root, "unrelated.txt"), "Other work proceeds")
  writeFileSync(join(f.root, "src", "feature.ts"), "export const changed = true\n")
  const unchanged = await f.index.evidence(architect, { paths: ["src/feature.ts"] })
  expect(unchanged.snapshotID).toBe(built.id)
  expect(unchanged.sources[0]!.text).toContain("toUpperCase")

  const refreshed = await f.index.refresh(architect)
  const changed = await f.index.evidence(architect, { paths: ["src/feature.ts"] })
  expect(refreshed.id).not.toBe(built.id)
  expect(changed.snapshotID).toBe(refreshed.id)
  expect(changed.sources[0]!.text).toContain("changed")
  expect((await f.index.manifest(architect)).files.map((file) => file.path)).toContain(
    "unrelated.txt",
  )
})

test("read selections and service reopen reuse one snapshot without collection, processing, or cache writes", async () => {
  const f = fixture()
  await expect(f.index.evidence(worker, { paths: ["src/feature.ts"] })).rejects.toBeInstanceOf(
    WorkspaceIndexUnavailable,
  )
  await expect(f.index.manifest(worker)).rejects.toThrow("Architect must refresh")
  expect(cacheState(f).files).toEqual([])

  const built = await f.index.refresh(architect)
  const before = cacheState(f)
  disableIndexWork(f.index)
  const manifestA = await f.index.manifest(worker, ["src"])
  const manifestB = await f.index.manifest(worker, ["untracked.txt"])
  const specialist = await f.index.manifest(
    { sessionID: "specialist-session", agent: "lazers-investigator" },
    ["src/feature.ts"],
  )
  const full = await f.index.evidence(worker, { paths: ["src/feature.ts"], level: "full" })
  const outline = await f.index.evidence(worker, { paths: ["src/feature.ts"], level: "outline" })
  const searched = await f.index.evidence(worker, { search: "dirty source", level: "structure" })
  expect([
    manifestA.snapshotID,
    manifestB.snapshotID,
    specialist.snapshotID,
    full.snapshotID,
    outline.snapshotID,
  ]).toEqual([built.id, built.id, built.id, built.id, built.id])
  expect(searched.sources.map((source) => source.path)).toEqual(["untracked.txt"])
  expect(manifestA.freshness).toBe("as-of-refresh")
  expect(cacheState(f)).toEqual(before)

  f.index.close()
  f.index = new ProjectIndex(f.root, f.cacheDirectory, f.repository, f.allow)
  disableIndexWork(f.index)
  const reopened = await f.index.evidence(worker, { paths: ["src/feature.ts"], level: "outline" })
  expect(reopened.snapshotID).toBe(built.id)
  expect(cacheState(f)).toEqual(before)
})

test("readers and later permission revocations are checked against cached files on every read", async () => {
  const f = fixture()
  await f.index.refresh(architect)
  const workerDenied = new Set(["src/feature.ts", "untracked.txt"])
  f.denied.set(worker.agent, workerDenied)
  const deniedManifest = await f.index.manifest(worker)
  const deniedRead = await f.index.evidence(worker, { search: "dirty source" })
  expect(deniedManifest.files.map((file) => file.path)).not.toContain("src/feature.ts")
  expect(deniedManifest.files.map((file) => file.path)).not.toContain("untracked.txt")
  expect(deniedRead.sources).toEqual([])

  workerDenied.delete("src/feature.ts")
  const allowed = await f.index.evidence(worker, { paths: ["src/feature.ts"] })
  expect(allowed.sources[0]!.text).toContain("toUpperCase")
  workerDenied.add("src/feature.ts")
  expect((await f.index.evidence(worker, { paths: ["src/feature.ts"] })).sources).toEqual([])
  expect(allowed.snapshotID).toBe((await f.index.manifest(architect)).snapshotID)
  expect(f.permissionChecks.some((check) => check.agent === worker.agent)).toBe(true)
})

test("focused reads authorize only distinct path/search matches in snapshot order", async () => {
  const f = fixture()
  for (let number = 0; number < 125; number++)
    writeFileSync(join(f.root, `unrelated-${number}.txt`), `unrelated ${number}`)
  writeFileSync(join(f.root, "candidate-a.txt"), "needle match A")
  writeFileSync(join(f.root, "candidate-b.txt"), "needle match B")
  writeFileSync(join(f.root, "candidate-c.txt"), "different content")
  const snapshot = await f.index.refresh(architect)
  const candidatePaths = snapshot.files
    .filter((file) => file.path.startsWith("candidate-"))
    .map((file) => file.path)
  expect(snapshot.files.length).toBeGreaterThan(125)
  f.denied.set(worker.agent, new Set(["candidate-b.txt"]))

  f.permissionChecks.length = 0
  const manifest = await f.index.manifest(worker, ["candidate-*", "candidate-b.txt"])
  expect(f.permissionChecks).toEqual(candidatePaths.map((path) => ({ path, agent: worker.agent })))
  expect(manifest.totalFiles).toBe(2)
  expect(manifest.files.map((file) => file.path)).toEqual(["candidate-a.txt", "candidate-c.txt"])
  expect(manifest.truncated).toBe(false)

  f.permissionChecks.length = 0
  const evidence = await f.index.evidence(worker, {
    paths: ["candidate-*"],
    search: "NEEDLE",
    level: "structure",
  })
  expect(f.permissionChecks).toEqual(
    candidatePaths
      .filter((path) => path !== "candidate-c.txt")
      .map((path) => ({ path, agent: worker.agent })),
  )
  expect(evidence.sources.map((source) => source.path)).toEqual(["candidate-a.txt"])
  expect(JSON.stringify(evidence)).not.toContain("candidate-b.txt")
  expect(JSON.stringify(evidence)).not.toContain("needle match B")

  f.permissionChecks.length = 0
  const noMatch = await f.index.evidence(worker, {
    paths: ["candidate-*"],
    search: "not present",
  })
  expect(f.permissionChecks).toEqual([])
  expect(noMatch.sources).toEqual([])
})

test("focused result totals and truncation use authorized matches before response limits", async () => {
  const f = fixture()
  for (let number = 0; number < 105; number++)
    writeFileSync(
      join(f.root, `focus-${number.toString().padStart(3, "0")}.txt`),
      "selected source",
    )
  const snapshot = await f.index.refresh(architect)
  const candidatePaths = snapshot.files
    .filter((file) => file.path.startsWith("focus-"))
    .map((file) => file.path)
  const denied = new Set(candidatePaths.slice(0, 55))
  f.denied.set(worker.agent, denied)

  f.permissionChecks.length = 0
  const manifest = await f.index.manifest(worker, ["focus-*"])
  expect(f.permissionChecks.map(({ path }) => path)).toEqual(candidatePaths)
  expect(manifest.totalFiles).toBe(50)
  expect(manifest.files).toHaveLength(50)
  expect(manifest.truncated).toBe(false)

  f.permissionChecks.length = 0
  const evidence = await f.index.evidence(worker, { paths: ["focus-*"], search: "SELECTED" })
  expect(f.permissionChecks.map(({ path }) => path)).toEqual(candidatePaths)
  expect(evidence.sources).toHaveLength(50)
  expect(evidence.truncated).toBe(false)

  denied.clear()
  f.permissionChecks.length = 0
  const allManifest = await f.index.manifest(worker, ["focus-*"])
  expect(f.permissionChecks.map(({ path }) => path)).toEqual(candidatePaths)
  expect(allManifest.totalFiles).toBe(105)
  expect(allManifest.files).toHaveLength(100)
  expect(allManifest.truncated).toBe(true)

  f.permissionChecks.length = 0
  const allEvidence = await f.index.evidence(worker, { paths: ["focus-*"], search: "selected" })
  expect(f.permissionChecks.map(({ path }) => path)).toEqual(candidatePaths)
  expect(allEvidence.sources).toHaveLength(50)
  expect(allEvidence.truncated).toBe(true)
})

test("failed refresh leaves the published snapshot intact; refresh updates changed, added, deleted, and ignored files atomically", async () => {
  const f = fixture()
  const built = await f.index.refresh(architect)
  const before = cacheState(f)
  writeFileSync(join(f.root, ".repomixignore"), "")
  writeFileSync(join(f.root, "custom.txt"), "now included")
  writeFileSync(join(f.root, "added.txt"), "added source")
  writeFileSync(join(f.root, "src", "feature.ts"), "export const refreshed = true\n")
  rmSync(join(f.root, "untracked.txt"))

  const process = Reflect.get(f.index, "processWorkspace") as (
    ...args: unknown[]
  ) => Promise<unknown>
  Reflect.set(f.index, "processWorkspace", async () => {
    throw new Error("simulated Repomix failure")
  })
  await expect(f.index.refresh(architect)).rejects.toThrow("simulated Repomix failure")
  expect(cacheState(f)).toEqual(before)
  const afterFailure = await f.index.evidence(architect, { paths: ["src/feature.ts"] })
  expect(afterFailure.snapshotID).toBe(built.id)
  expect(afterFailure.sources[0]!.text).toContain("toUpperCase")
  Reflect.set(f.index, "processWorkspace", process)

  const atomic = f.repository.atomic.bind(f.repository)
  let transactionCalls = 0
  Reflect.set(f.repository, "atomic", (run: Parameters<TaskRepository["atomic"]>[0]) => {
    transactionCalls++
    if (transactionCalls === 2) throw new Error("simulated snapshot pointer failure")
    return atomic(run)
  })
  await expect(f.index.refresh(architect)).rejects.toThrow("simulated snapshot pointer failure")
  expect(cacheState(f)).toEqual(before)
  expect((await f.index.evidence(architect, { paths: ["src/feature.ts"] })).snapshotID).toBe(
    built.id,
  )
  Reflect.set(f.repository, "atomic", atomic)

  const refreshed = await f.index.refresh(architect)
  expect(refreshed.id).not.toBe(built.id)
  const paths = (await f.index.manifest(architect)).files.map((file) => file.path)
  expect(paths).toContain("custom.txt")
  expect(paths).toContain("added.txt")
  expect(paths).not.toContain("untracked.txt")
  expect(
    (await f.index.evidence(architect, { paths: ["src/feature.ts"] })).sources[0]!.text,
  ).toContain("refreshed")
})

test("queries during a refresh see the prior complete snapshot until atomic publication", async () => {
  const f = fixture()
  const built = await f.index.refresh(architect)
  writeFileSync(join(f.root, "src", "feature.ts"), "export const atomic = true\n")

  const process = Reflect.get(f.index, "processWorkspace") as (
    ...args: unknown[]
  ) => Promise<unknown>
  let entered!: () => void
  let release!: () => void
  const processing = new Promise<void>((resolve) => (entered = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  let activeProcessors = 0
  let maximumProcessors = 0
  let calls = 0
  Reflect.set(f.index, "processWorkspace", async (...args: unknown[]) => {
    calls++
    activeProcessors++
    maximumProcessors = Math.max(maximumProcessors, activeProcessors)
    const result = await process.apply(f.index, args)
    if (calls === 1) {
      entered()
      await gate
    }
    activeProcessors--
    return result
  })

  const refresh = f.index.refresh(architect)
  await processing
  const queuedRefresh = f.index.refresh(architect)
  const lastRefresh = f.index.refresh(architect)
  const during = await f.index.evidence(worker, { paths: ["src/feature.ts"] })
  expect(during.snapshotID).toBe(built.id)
  expect(during.sources[0]!.text).toContain("toUpperCase")
  release()
  const [completed, queued, last] = await Promise.all([refresh, queuedRefresh, lastRefresh])
  expect(new Set([completed.id, queued.id, last.id]).size).toBe(3)
  expect(calls).toBe(3)
  expect(maximumProcessors).toBe(1)
  const after = await f.index.evidence(worker, { paths: ["src/feature.ts"] })
  expect(after.snapshotID).toBe(last.id)
  expect(after.sources[0]!.text).toContain("atomic")
})

test("cross-process publication and eviction cannot remove bytes selected by an in-flight reader", async () => {
  const f = fixture()
  const first = await f.index.refresh(architect)
  const oldPointer = cacheState(f).row!
  writeFileSync(join(f.root, "src", "feature.ts"), "export const replacement = true\n")
  const second = await f.index.refresh(architect)
  const newPointer = cacheState(f).row!
  // Stage a complete replacement, then restore the old pointer to schedule the
  // writer exactly after the reader's transaction. Neither cache is synthetic.
  f.repository.atomic((db) =>
    db
      .query("UPDATE context_cache SET file=?,stamp=? WHERE workspace=? AND selection=?")
      .run(oldPointer.file, oldPointer.stamp, f.index.root, "$workspace"),
  )
  const old = new Date(Date.now() - 120_000)
  utimesSync(join(f.cacheDirectory, oldPointer.file), old, old)
  const atomic = f.repository.atomic.bind(f.repository)
  let injected = false
  Reflect.set(f.repository, "atomic", (run: Parameters<TaskRepository["atomic"]>[0]) => {
    const result = atomic(run)
    if (!injected) {
      injected = true
      const script = `
        import { TaskRepository } from ${JSON.stringify(join(import.meta.dir, "../storage.ts"))};
        import { ProjectIndex } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
        const root=${JSON.stringify(f.index.root)};
        const repository=new TaskRepository(${JSON.stringify(join(f.root, "data/tasks.sqlite"))},root);
        const index=new ProjectIndex(root,${JSON.stringify(f.cacheDirectory)},repository,async()=>true);
        repository.atomic(db=>db.query("UPDATE context_cache SET file=?,stamp=? WHERE workspace=? AND selection=?").run(${JSON.stringify(newPointer.file)},${JSON.stringify(newPointer.stamp)},root,"$workspace"));
        Reflect.get(index,"evict").call(index);
        index.close(); repository.close();
      `
      const writer = Bun.spawnSync([process.execPath, "-e", script])
      expect(writer.exitCode).toBe(0)
      expect(writer.stderr.toString()).toBe("")
      expect(readdirSync(f.cacheDirectory)).not.toContain(oldPointer.file)
    }
    return result
  })
  disableIndexWork(f.index)
  const selected = await f.index.evidence(worker, { paths: ["src/feature.ts"] })
  expect(selected.snapshotID).toBe(first.id)
  expect(selected.sources[0]!.text).toContain("toUpperCase")
  const before = cacheState(f)
  const current = await f.index.evidence(worker, { paths: ["src/feature.ts"] })
  expect(current.snapshotID).toBe(second.id)
  expect(current.sources[0]!.text).toContain("replacement")
  expect(cacheState(f)).toEqual(before)
})

test("refresh requires Architect authority and foreign workspaces do not inherit another index", async () => {
  const f = fixture()
  await expect(f.index.refresh(worker)).rejects.toThrow("Only Architect")
  expect(cacheState(f).files).toEqual([])
  await f.index.refresh(architect)

  const otherRoot = mkdtempSync(join(tmpdir(), "lazers-foreign-index-"))
  const otherRepository = new TaskRepository(join(otherRoot, "tasks.sqlite"), otherRoot)
  const otherIndex = new ProjectIndex(otherRoot, join(otherRoot, "cache"), otherRepository, f.allow)
  try {
    await expect(otherIndex.manifest(worker)).rejects.toBeInstanceOf(WorkspaceIndexUnavailable)
    expect(await f.index.manifest(architect)).toMatchObject({ workspace: f.index.root })
  } finally {
    otherIndex.close()
    otherRepository.close()
    rmSync(otherRoot, { recursive: true, force: true })
  }
})

test("focused multi-file reads return complete source beyond the former response cap", async () => {
  const f = fixture()
  const first = `${"first ".repeat(5000)}\nFIRST_FILE_END`,
    second = `${"second ".repeat(5000)}\nSECOND_FILE_END`
  writeFileSync(join(f.root, "first.txt"), first)
  writeFileSync(join(f.root, "second.txt"), second)
  await f.index.refresh(architect)
  const result = await f.index.evidence(architect, {
    paths: ["first.txt", "second.txt"],
  })
  expect(result.sources.map((source) => [source.path, source.text])).toEqual([
    ["first.txt", first],
    ["second.txt", second],
  ])
  expect(result.sources.map((source) => [source.startLine, source.endLine])).toEqual([
    [1, 2],
    [1, 2],
  ])
  expect(result.truncated).toBe(false)
})

test("manifest and evidence retain their source-count response bounds", async () => {
  const f = fixture()
  for (let number = 0; number < 105; number++)
    writeFileSync(join(f.root, `source-${number}.txt`), `content ${number}`)
  await f.index.refresh(architect)
  const manifest = await f.index.manifest(architect)
  const evidence = await f.index.evidence(architect, { search: "content" })
  expect(manifest.files).toHaveLength(100)
  expect(manifest.truncated).toBe(true)
  expect(manifest.totalFiles).toBeGreaterThan(100)
  expect(evidence.sources).toHaveLength(50)
  expect(evidence.truncated).toBe(true)
})

test("worker packets use the reusable snapshot, cited ranges, and bounded source deferral", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "AGENTS.md"), "Use strict TypeScript. No worker delegation.")
  writeFileSync(join(f.root, "README.md"), "Implement the scoped feature and run its tests.")
  writeFileSync(
    join(f.root, "guide.md"),
    "outside-range\nRelevant contract.\nRelevant procedure.\n" +
      "unrelated guide prose ".repeat(5000),
  )
  writeFileSync(join(f.root, "oversized.md"), "large context source ".repeat(20000))
  await f.index.refresh(architect)
  const proposal = validProposal()
  proposal.context = [
    { reference: "guide.md:2-3: relevant integration", revision: null },
    { reference: "oversized.md", revision: null },
  ]
  proposal.limits.maxTokens = 4000
  const delivered = await f.index.taskContext(architect, proposal)
  expect(delivered.entries.find((entry: { path: string }) => entry.path === "guide.md")!.text).toBe(
    "[Lines 2-3]\nRelevant contract.\nRelevant procedure.",
  )
  expect(JSON.stringify(delivered)).not.toContain("outside-range")
  expect(JSON.stringify(delivered)).not.toContain("unrelated guide prose")
  expect(delivered.deferred).toContain("oversized.md")
  expect(delivered.tokens).toBeLessThanOrEqual(24000)
  expect(delivered.entries.some((entry: { path: string }) => entry.path === "AGENTS.md")).toBe(
    false,
  )
  expect(delivered.freshness).toBe("as-of-refresh")
})
