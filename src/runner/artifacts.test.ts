import { expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  artifactExists,
  checkResourcesSettled,
  canonicalCombinedArtifact,
  combineArtifacts,
  combinedArtifactsMatch,
  commitIsAncestor,
  commitArtifact,
  git,
  gitAsync,
  runCheck,
  runDeclaredCheck,
  verificationEnvironmentIdentity,
} from "./artifacts.ts"
import { checkSucceeded } from "./checks.ts"

const only = (...allowed: string[]) => ({ protected: ["**"], released: allowed })

test("F-S5-11 a slow Git observation leaves timers responsive and preserves command failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-async-git-"))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    git(root, ["init", "--initial-branch=main"])
    let ticked = false
    const running = gitAsync(root, ["-c", "alias.lz-slow=!sleep 0.1; printf ready", "lz-slow"])
    timer = setTimeout(() => {
      ticked = true
    }, 0)
    expect(await running).toBe("ready")
    expect(ticked).toBe(true)
    await expect(gitAsync(root, ["rev-parse", "absent-reference"])).rejects.toThrow(
      "git rev-parse failed:",
    )
  } finally {
    clearTimeout(timer)
    rmSync(root, { recursive: true, force: true })
  }
})

test("declared quality phases preserve all output and share the hard deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-phases-"))
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          first: "printf first; sleep 0.08",
          second: "printf second; sleep 0.08",
        },
      }),
    )
    const command = "bun run first && bun run second"
    const passed = await runDeclaredCheck(
      root,
      "candidate",
      { id: "output", command, timeoutMs: 2000 },
      join(root, "output.json"),
    )
    expect(passed.stdout).toBe("firstsecond")
    expect(passed.exitCode).toBe(0)
    expect(passed.phasesComplete).toBe(true)
    const timedOut = await runDeclaredCheck(
      root,
      "candidate",
      { id: "deadline", command, inactivityTimeoutMs: 120, hardTimeoutMs: 130 },
      join(root, "deadline.json"),
    )
    expect(timedOut.timedOut).toBe(true)
    expect(checkSucceeded(timedOut)).toBe(false)
    expect(timedOut.stdout).toContain("first")
    expect(JSON.parse(readFileSync(join(root, "deadline.json"), "utf8"))).toMatchObject({
      exitCode: timedOut.exitCode,
      timedOut: true,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("silent recognized phases share one inactivity deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-silent-phases-"))
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { first: "sleep 0.35", second: "sleep 0.35" } }),
    )
    const receipt = await runDeclaredCheck(
      root,
      "candidate",
      {
        id: "silent-phases",
        command: "bun run --silent first && bun run --silent second",
        inactivityTimeoutMs: 550,
        hardTimeoutMs: 2_000,
      },
      join(root, "silent-phases.json"),
    )
    expect(receipt.timedOut).toBe(true)
    expect(receipt.stopCause).toBe("inactivity")
    expect(receipt.phases).toHaveLength(2)
    expect(receipt.phases?.[0]).toMatchObject({ exitCode: 0, timedOut: false })
    expect(receipt.phases?.[1]).toMatchObject({ stopCause: "inactivity", timedOut: true })
    expect(receipt.phasesComplete).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("verification identity records stable runtime metadata without hashing unrelated credentials", () => {
  const identity = verificationEnvironmentIdentity()
  const previous = process.env.LAZERS_IDENTITY_SECRET_CANARY
  const previousLanguage = process.env.LANG
  process.env.LAZERS_IDENTITY_SECRET_CANARY = "must-not-be-persisted-or-hashed"
  try {
    expect(verificationEnvironmentIdentity()).toBe(identity)
    expect(JSON.parse(identity)).toMatchObject({
      bunRevision: Bun.revision,
      platform: process.platform,
    })
    expect(identity).not.toContain("must-not-be-persisted-or-hashed")
    process.env.LANG = `${previousLanguage ?? ""}.lazers-test`
    expect(verificationEnvironmentIdentity()).not.toBe(identity)
  } finally {
    if (previous === undefined) delete process.env.LAZERS_IDENTITY_SECRET_CANARY
    else process.env.LAZERS_IDENTITY_SECRET_CANARY = previous
    if (previousLanguage === undefined) delete process.env.LANG
    else process.env.LANG = previousLanguage
  }
})

test("exit-zero verification keeps its result when owned subprocess cleanup is uncertain", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-cleanup-"))
  let groupID: number | undefined
  const originalKill = process.kill.bind(process)
  const mockedKill = spyOn(process, "kill").mockImplementation(((pid, signal) => {
    if (typeof pid === "number" && groupID !== undefined && pid === -groupID) {
      if (signal === 0 || signal === "SIGKILL") return true
    }
    return originalKill(pid, signal)
  }) as typeof process.kill)
  try {
    const receiptPromise = runCheck(
      root,
      "candidate",
      {
        id: "leaked-child",
        command:
          'printf "%s" "$$" > leader.pid; sleep 30 >/dev/null 2>&1 & printf "%s" "$!" > child.pid; exit 0',
        inactivityTimeoutMs: 2000,
        hardTimeoutMs: 5000,
      },
      join(root, "receipt.json"),
    )
    const marker = join(root, "leader.pid")
    const deadline = Date.now() + 5000
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(marker)).toBe(true)
    groupID = Number(readFileSync(marker, "utf8"))
    const receipt = await receiptPromise
    expect(receipt.exitCode).toBe(0)
    expect(receipt.timedOut).toBe(false)
    expect(receipt.processCleanup).toMatchObject({
      state: "uncertain",
      capability: "process-group",
    })
    expect(checkSucceeded(receipt)).toBe(true)
    expect(checkResourcesSettled(receipt)).toBe(false)
  } finally {
    mockedKill.mockRestore()
    if (groupID !== undefined) {
      try {
        originalKill(-groupID, "SIGKILL")
      } catch {
        // The process group may have exited while the receipt was being written.
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

test("failed and timed-out checks retain their actual outcomes independently of cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-outcomes-"))
  try {
    const failed = await runCheck(
      root,
      "candidate",
      { id: "failed", command: "exit 7", timeoutMs: 2000 },
      join(root, "failed.json"),
    )
    expect(failed.exitCode).toBe(7)
    expect(failed.timedOut).toBe(false)
    expect(checkSucceeded(failed)).toBe(false)
    expect(checkResourcesSettled(failed)).toBe(true)

    const timedOut = await runCheck(
      root,
      "candidate",
      { id: "timed-out", command: "sleep 30", inactivityTimeoutMs: 50, hardTimeoutMs: 2000 },
      join(root, "timed-out.json"),
    )
    expect(timedOut.timedOut).toBe(true)
    expect(timedOut.stopCause).toBe("inactivity")
    expect(checkSucceeded(timedOut)).toBe(false)
    expect(checkResourcesSettled(timedOut)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

test("the Windows process-tree adapter distinguishes child exit from remaining descendants", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-process-tree-adapter-"))
  const originalKill = process.kill.bind(process)
  let processGroupID: number | undefined
  let observations = 0
  const adapter = {
    hasDescendants: async (pid: number) => {
      processGroupID = pid
      observations++
      return observations > 1
    },
    terminate: async () => {
      throw new Error("simulated native tree termination could not be confirmed")
    },
  }
  try {
    const empty = await runCheck(
      root,
      "candidate",
      { id: "empty-tree", command: "exit 0", inactivityTimeoutMs: 2000, hardTimeoutMs: 5000 },
      join(root, "empty.json"),
      { processTreeAdapter: adapter },
    )
    expect(empty.exitCode).toBe(0)
    expect(empty.processCleanup).toMatchObject({
      state: "settled",
      capability: "windows-process-tree",
    })
    expect(Number.isSafeInteger(empty.processCleanup?.rootPID)).toBe(true)
    expect(checkResourcesSettled(empty)).toBe(true)

    const remaining = await runCheck(
      root,
      "candidate",
      {
        id: "remaining-descendant",
        command: "sleep 30 >/dev/null 2>&1 & exit 0",
        inactivityTimeoutMs: 2000,
        hardTimeoutMs: 5000,
      },
      join(root, "remaining.json"),
      { processTreeAdapter: adapter },
    )
    expect(remaining.exitCode).toBe(0)
    expect(remaining.timedOut).toBe(false)
    expect(remaining.processCleanup).toMatchObject({
      state: "uncertain",
      capability: "windows-process-tree",
    })
    expect(Number.isSafeInteger(remaining.processCleanup?.rootPID)).toBe(true)
    expect(checkSucceeded(remaining)).toBe(true)
    expect(checkResourcesSettled(remaining)).toBe(false)
  } finally {
    if (processGroupID !== undefined) {
      try {
        originalKill(-processGroupID, "SIGKILL")
      } catch {
        // The process tree may have exited while the receipt was written.
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

test("historical wall limits do not stop a quiet check inside current inactivity defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-quiet-defaults-"))
  try {
    const receipt = await runCheck(
      root,
      "candidate",
      {
        id: "quiet",
        command: "sleep 0.12; printf done",
        timeoutMs: 20,
        inactivityTimeoutMs: 300,
        hardTimeoutMs: 600,
      },
      join(root, "quiet.json"),
    )
    expect(receipt.exitCode).toBe(0)
    expect(receipt.timedOut).toBe(false)
    expect(receipt.stdout).toBe("done")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(["stdout", "stderr"] as const)(
  "%s progress resets inactivity after bounded output capture truncates",
  async (stream) => {
    const root = mkdtempSync(join(tmpdir(), `lazers-check-${stream}-progress-`))
    try {
      const emit = stream === "stdout" ? "printf '%04000d' 1" : "printf '%04000d' 1 >&2"
      const receipt = await runCheck(
        root,
        "candidate",
        {
          id: stream,
          command: `for i in 1 2 3 4 5 6 7 8 9 10; do ${emit}; sleep 0.04; done`,
          inactivityTimeoutMs: 100,
          hardTimeoutMs: 1200,
        },
        join(root, `${stream}.json`),
      )
      expect(receipt.exitCode).toBe(0)
      expect(receipt.timedOut).toBe(false)
      expect(receipt[stream]).toMatch(/\[\.\.\. \d+ bytes omitted \.\.\.\]/)
      expect(Date.now() - receipt.startedAt).toBeGreaterThan(250)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test("continuous recognized phases share the total hard backstop and cancellation stays prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-shared-hard-timeout-"))
  const controller = new AbortController()
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          first: "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf x; sleep 0.04; done",
          second: "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do printf y; sleep 0.04; done",
        },
      }),
    )
    const noisy = await runDeclaredCheck(
      root,
      "candidate",
      {
        id: "shared-hard-timeout",
        command: "bun run first && bun run second",
        inactivityTimeoutMs: 300,
        hardTimeoutMs: 800,
      },
      join(root, "noisy.json"),
    )
    expect(noisy.timedOut).toBe(true)
    expect(noisy.stopCause).toBe("hard-backstop")
    expect(noisy.phases).toHaveLength(2)
    expect(noisy.phasesComplete).toBe(false)
    expect(noisy.stdout.length).toBeGreaterThan(0)

    const running = runCheck(
      root,
      "candidate",
      {
        id: "cancelled",
        command: "sleep 30",
        inactivityTimeoutMs: 5000,
        hardTimeoutMs: 10_000,
      },
      join(root, "cancelled.json"),
      { signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 50)
    const cancelled = await running
    expect(cancelled.aborted).toBe(true)
    expect(cancelled.stopCause).toBe("cancelled")
    expect(cancelled.timedOut).toBe(false)
    expect(checkResourcesSettled(cancelled)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

test("identical check modules retain the same environment identity across reload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lazers-check-reload-"))
  try {
    const source = readFileSync(new URL("./artifacts.ts", import.meta.url), "utf8")
      .replace(
        '"../identity.ts"',
        JSON.stringify(fileURLToPath(new URL("../identity.ts", import.meta.url))),
      )
      .replace(
        '"../task.ts"',
        JSON.stringify(fileURLToPath(new URL("../task.ts", import.meta.url))),
      )
      .replace(
        '"./checks.ts"',
        JSON.stringify(fileURLToPath(new URL("./checks.ts", import.meta.url))),
      )
      .replace(
        '"./quality-failure.ts"',
        JSON.stringify(fileURLToPath(new URL("./quality-failure.ts", import.meta.url))),
      )
      .replace(
        '"./scope.ts"',
        JSON.stringify(fileURLToPath(new URL("./scope.ts", import.meta.url))),
      )
      .replace(
        '"./verification-timeout.ts"',
        JSON.stringify(fileURLToPath(new URL("./verification-timeout.ts", import.meta.url))),
      )
    const paths = [join(directory, "first.ts"), join(directory, "second.ts")]
    for (const path of paths) writeFileSync(path, source)
    const first = (await import(pathToFileURL(paths[0]!).href)) as typeof import("./artifacts.ts")
    const second = (await import(pathToFileURL(paths[1]!).href)) as typeof import("./artifacts.ts")
    expect(first.verificationEnvironmentIdentity()).toBe(second.verificationEnvironmentIdentity())
    expect(first.verificationEnvironmentIdentity()).toBe(verificationEnvironmentIdentity())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function initRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  git(root, ["init", "--initial-branch=main"])
  git(root, ["config", "user.name", "fixture"])
  git(root, ["config", "user.email", "test@example.invalid"])
  return root
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "--all"])
  git(root, ["commit", "-m", message])
  return git(root, ["rev-parse", "HEAD"])
}

test("commit ancestry distinguishes non-ancestor evidence from unavailable Git state", async () => {
  const root = initRepository("lazers-commit-ancestry-")
  try {
    writeFileSync(join(root, "base.txt"), "base")
    const base = commitAll(root, "base")
    writeFileSync(join(root, "next.txt"), "next")
    const next = commitAll(root, "next")
    expect(await commitIsAncestor(root, base, next)).toBe(true)
    expect(await commitIsAncestor(root, next, base)).toBe(false)
    await expect(commitIsAncestor(root, "f".repeat(40), next)).rejects.toThrow(
      "git merge-base --is-ancestor failed",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function divergentBaselineFixture() {
  const root = initRepository("lazers-divergent-artifact-")
  try {
    writeFileSync(join(root, "origin.txt"), "shared origin")
    const origin = commitAll(root, "common origin")

    git(root, ["checkout", "-b", "admitted", origin])
    writeFileSync(join(root, "prerequisite.txt"), "admitted prerequisite")
    const base = commitAll(root, "admitted prerequisite baseline")

    git(root, ["checkout", "-b", "reviewed", origin])
    writeFileSync(join(root, "reviewed.txt"), "reviewed contribution")
    const incorporated = commitAll(root, "reviewed contribution")
    writeFileSync(join(root, "review-tail.txt"), "not merged into worker")
    const reviewedHead = commitAll(root, "unmerged reviewed tail")

    git(root, ["checkout", "-b", "worker", base])
    git(root, ["merge", "--no-ff", "--no-edit", incorporated])
    const workerHead = git(root, ["rev-parse", "HEAD"])
    return { root, origin, base, incorporated, reviewedHead, workerHead }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function treeHasPath(root: string, tree: string, path: string): boolean {
  try {
    git(root, ["cat-file", "-e", `${tree}:${path}`])
    return true
  } catch {
    return false
  }
}

test("artifact evidence accepts regular files and non-empty workspace-contained directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-artifact-evidence-"))
  try {
    const lz37 = join(root, ".agents", "docs", "evidence", "037-artifact-evidence")
    mkdirSync(lz37, { recursive: true })
    writeFileSync(join(lz37, "verification.md"), "")
    expect(await artifactExists(root, ".agents/docs/evidence/037-artifact-evidence")).toBe(true)
    expect(await artifactExists(root, ".agents/docs/evidence/037-artifact-evidence/")).toBe(true)
    expect(
      await artifactExists(root, ".agents/docs/evidence/037-artifact-evidence/verification.md"),
    ).toBe(true)

    const nested = join(root, "nested", "one", "two")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "empty.txt"), "")
    expect(await artifactExists(root, "nested")).toBe(true)
    expect(await artifactExists(root, "nested/")).toBe(true)
    expect(await artifactExists(root, "nested/one/two/empty.txt")).toBe(true)

    mkdirSync(join(root, "empty"))
    mkdirSync(join(root, "empty-tree", "nested"), { recursive: true })
    expect(await artifactExists(root, "empty")).toBe(false)
    expect(await artifactExists(root, "empty-tree")).toBe(false)
    expect(await artifactExists(root, "missing")).toBe(false)
    expect(await artifactExists(root, "")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("artifact evidence never uses paths outside the workspace or follows symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-artifact-safe-"))
  const outside = mkdtempSync(join(tmpdir(), "lazers-artifact-outside-"))
  try {
    const outsideFile = join(outside, "proof.txt")
    writeFileSync(outsideFile, "proof")
    symlinkSync(outside, join(root, "ancestor-link"))
    symlinkSync(outsideFile, join(root, "leaf-link"))
    const linkedTree = join(root, "linked-tree")
    mkdirSync(linkedTree)
    symlinkSync(outsideFile, join(linkedTree, "proof.txt"))
    const linkedDirectoryTree = join(root, "linked-directory-tree")
    mkdirSync(linkedDirectoryTree)
    symlinkSync(outside, join(linkedDirectoryTree, "external-directory"))
    const mixedTree = join(root, "mixed-tree")
    mkdirSync(mixedTree)
    symlinkSync(outsideFile, join(mixedTree, "external.txt"))
    writeFileSync(join(mixedTree, "local.txt"), "")

    expect(await artifactExists(root, "ancestor-link/proof.txt")).toBe(false)
    expect(await artifactExists(root, "leaf-link")).toBe(false)
    expect(await artifactExists(root, "linked-tree")).toBe(false)
    expect(await artifactExists(root, "linked-directory-tree")).toBe(false)
    expect(await artifactExists(root, "mixed-tree")).toBe(true)
    expect(await artifactExists(root, outsideFile)).toBe(false)
    expect(await artifactExists(root, "../outside/proof.txt")).toBe(false)
    expect(await artifactExists(root, "https://example.invalid/proof.txt")).toBe(false)
    expect(await artifactExists(root, "file:/outside/proof.txt")).toBe(false)
    expect(await artifactExists(root, "C:/outside/proof.txt")).toBe(false)
    expect(await artifactExists(root, "\\\\server\\share\\proof.txt")).toBe(false)

    const specialTree = join(root, "special-tree")
    mkdirSync(specialTree)
    const fifo = join(specialTree, "pipe")
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0)
    expect(await artifactExists(root, "special-tree")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("worker commits are retained and their committed changes remain subject to scope checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-worker-commit-"))
  try {
    git(root, ["init", "--initial-branch=main"])
    const commit = (message: string) =>
      git(root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        message,
      ])
    writeFileSync(join(root, "source.txt"), "baseline")
    git(root, ["add", "source.txt"])
    commit("baseline")
    const base = git(root, ["rev-parse", "HEAD"])
    writeFileSync(join(root, "source.txt"), "implemented")
    git(root, ["add", "source.txt"])
    commit("worker implementation")
    const head = git(root, ["rev-parse", "HEAD"])
    const artifact = await commitArtifact(root, base, only("source.txt"))
    expect(artifact.commit).toBe(head)
    expect(artifact.paths).toEqual(["source.txt"])
    await expect(commitArtifact(root, base, only("other.txt"))).rejects.toThrow("Out-of-scope")
    writeFileSync(join(root, "source.txt"), "repair")
    const dirty = await commitArtifact(root, base, only("source.txt"))
    expect(git(root, ["rev-parse", `${dirty.commit}^`])).toBe(head)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("isolated rebases exclude reviewed main changes while retaining worker scope checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-rebased-worker-"))
  try {
    git(root, ["init", "--initial-branch=main"])
    const commit = (message: string) => {
      git(root, ["add", "--all"])
      git(root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        message,
      ])
      return git(root, ["rev-parse", "HEAD"])
    }
    writeFileSync(join(root, "source.txt"), "baseline")
    const base = commit("baseline")
    git(root, ["checkout", "-b", "worker"])
    writeFileSync(join(root, "source.txt"), "worker implementation")
    commit("worker change")
    git(root, ["checkout", "main"])
    writeFileSync(join(root, "reviewed-other.txt"), "independent reviewed integration")
    const reviewed = commit("reviewed main change")
    git(root, ["checkout", "worker"])
    git(root, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=test@example.invalid",
      "rebase",
      "main",
    ])
    const candidate = git(root, ["rev-parse", "HEAD"])
    expect(await commitArtifact(root, base, only("source.txt"), true, reviewed)).toEqual({
      commit: candidate,
      identity: candidate,
      paths: ["source.txt"],
      scopeBase: reviewed,
    })
    // Shared execution still compares against its admitted baseline.
    await expect(commitArtifact(root, base, only("source.txt"), false, reviewed)).rejects.toThrow(
      "Out-of-scope",
    )
    expect((await commitArtifact(root, reviewed, only("source.txt"), true, base)).scopeBase).toBe(
      reviewed,
    )
    writeFileSync(join(root, "escape.txt"), "unreviewed worker edit")
    await expect(commitArtifact(root, base, only("source.txt"), true, reviewed)).rejects.toThrow(
      "escape.txt",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("divergent isolated repairs compare against the safe merge of admitted and incorporated work", async () => {
  const fixture = divergentBaselineFixture()
  const { root, base, incorporated, reviewedHead, workerHead } = fixture
  try {
    expect(git(root, ["merge-base", workerHead, reviewedHead])).toBe(incorporated)
    expect(git(root, ["merge-base", base, incorporated])).toBe(fixture.origin)

    // Shared execution still measures from the admitted base, not isolated review ancestry.
    await expect(
      commitArtifact(root, base, only("repair/fix.ts"), false, reviewedHead),
    ).rejects.toThrow("reviewed.txt")

    mkdirSync(join(root, "repair"), { recursive: true })
    writeFileSync(join(root, "repair", "fix.ts"), "repair")
    const artifact = await commitArtifact(root, base, only("repair/fix.ts"), true, reviewedHead)

    expect(artifact.paths).toEqual(["repair/fix.ts"])
    expect(artifact.commit).toBe(artifact.identity)
    expect(git(root, ["rev-parse", `${artifact.commit}^`])).toBe(workerHead)
    expect(git(root, ["cat-file", "-t", artifact.scopeBase])).toBe("tree")
    expect(treeHasPath(root, artifact.scopeBase, "prerequisite.txt")).toBe(true)
    expect(treeHasPath(root, artifact.scopeBase, "reviewed.txt")).toBe(true)
    expect(treeHasPath(root, artifact.scopeBase, "review-tail.txt")).toBe(false)
    expect(treeHasPath(root, workerHead, "review-tail.txt")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("edits to reviewed paths and unauthorized files remain violations in every Git state", async () => {
  const variants = ["committed", "staged", "unstaged", "untracked"] as const
  for (const variant of variants) {
    const fixture = divergentBaselineFixture()
    const { root, base, reviewedHead, workerHead } = fixture
    try {
      if (variant === "untracked") {
        writeFileSync(join(root, "unauthorized.txt"), "untracked worker change")
      } else {
        writeFileSync(join(root, "reviewed.txt"), `worker edit: ${variant}`)
        if (variant === "staged") git(root, ["add", "reviewed.txt"])
        if (variant === "committed") commitAll(root, "unauthorized reviewed-path edit")
      }

      const violation = variant === "untracked" ? "unauthorized.txt" : "reviewed.txt"
      await expect(
        commitArtifact(root, base, only("repair/fix.ts"), true, reviewedHead),
      ).rejects.toThrow(violation)
      if (variant === "committed") {
        expect(git(root, ["rev-parse", "HEAD"])).not.toBe(workerHead)
      } else {
        expect(git(root, ["rev-parse", "HEAD"])).toBe(workerHead)
      }
      if (variant === "staged")
        expect(git(root, ["diff", "--cached", "--name-only"])).toBe("reviewed.txt")
      if (variant === "unstaged") expect(git(root, ["diff", "--name-only"])).toBe("reviewed.txt")
      if (variant === "untracked")
        expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("unauthorized.txt")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test("reviewed content copied without shared ancestry is not exempted", async () => {
  const root = initRepository("lazers-copied-reviewed-artifact-")
  try {
    writeFileSync(join(root, "origin.txt"), "shared origin")
    const origin = commitAll(root, "common origin")
    git(root, ["checkout", "-b", "admitted", origin])
    writeFileSync(join(root, "prerequisite.txt"), "admitted prerequisite")
    const base = commitAll(root, "admitted prerequisite")
    git(root, ["checkout", "-b", "reviewed", origin])
    writeFileSync(join(root, "copied.txt"), "main content")
    const reviewedHead = commitAll(root, "reviewed main content")
    git(root, ["checkout", "-b", "worker", base])
    writeFileSync(join(root, "copied.txt"), "main content")
    const workerHead = commitAll(root, "copy reviewed content without ancestry")

    expect(git(root, ["merge-base", workerHead, reviewedHead])).toBe(origin)
    await expect(
      commitArtifact(root, base, only("repair/fix.ts"), true, reviewedHead),
    ).rejects.toThrow("copied.txt")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("conflicting virtual baselines fail before staging even when the worker resolved its merge", async () => {
  const root = initRepository("lazers-conflicting-artifact-baseline-")
  try {
    writeFileSync(join(root, "conflict.txt"), "origin")
    const origin = commitAll(root, "common origin")
    git(root, ["checkout", "-b", "admitted", origin])
    writeFileSync(join(root, "conflict.txt"), "admitted")
    const base = commitAll(root, "admitted conflict side")
    git(root, ["checkout", "-b", "reviewed", origin])
    writeFileSync(join(root, "conflict.txt"), "reviewed")
    const reviewedHead = commitAll(root, "reviewed conflict side")

    git(root, ["checkout", "-b", "worker", base])
    expect(() => git(root, ["merge", "--no-ff", "--no-commit", reviewedHead])).toThrow()
    writeFileSync(join(root, "conflict.txt"), "worker-resolved merge")
    git(root, ["add", "conflict.txt"])
    git(root, ["commit", "-m", "worker resolved the conflict"])
    const workerHead = git(root, ["rev-parse", "HEAD"])
    mkdirSync(join(root, "repair"), { recursive: true })
    writeFileSync(join(root, "repair", "allowed.ts"), "must remain unstaged")

    await expect(
      commitArtifact(root, base, only("repair/fix.ts"), true, reviewedHead),
    ).rejects.toThrow("conflict-free reviewed artifact baseline")
    expect(git(root, ["rev-parse", "HEAD"])).toBe(workerHead)
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("")
    expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("repair/allowed.ts")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ambiguous reviewed ancestry fails closed before staging", async () => {
  const root = initRepository("lazers-ambiguous-artifact-baseline-")
  try {
    writeFileSync(join(root, "origin.txt"), "origin")
    const origin = commitAll(root, "common origin")
    git(root, ["checkout", "-b", "first", origin])
    writeFileSync(join(root, "first.txt"), "first")
    const first = commitAll(root, "first side")
    git(root, ["checkout", "-b", "second", origin])
    writeFileSync(join(root, "second.txt"), "second")
    const second = commitAll(root, "second side")

    git(root, ["checkout", "first"])
    git(root, ["merge", "--no-ff", "--no-edit", second])
    const workerHead = git(root, ["rev-parse", "HEAD"])
    git(root, ["checkout", "second"])
    git(root, ["merge", "--no-ff", "--no-edit", first])
    const reviewedHead = git(root, ["rev-parse", "HEAD"])
    expect(git(root, ["merge-base", "--all", workerHead, reviewedHead]).split("\n")).toHaveLength(2)

    git(root, ["checkout", "first"])
    mkdirSync(join(root, "repair"), { recursive: true })
    writeFileSync(join(root, "repair", "allowed.ts"), "must remain unstaged")
    await expect(
      commitArtifact(root, origin, only("repair/fix.ts"), true, reviewedHead),
    ).rejects.toThrow("unique merge base")
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("")
    expect(git(root, ["ls-files", "--others", "--exclude-standard"])).toBe("repair/allowed.ts")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("combined artifacts and verified candidates use the configured identity and stay stable", async () => {
  const root = initRepository("lazers-identity-")
  try {
    git(root, ["config", "user.name", "Configured Person"])
    git(root, ["config", "user.email", "person@example.com"])
    git(root, ["config", "commit.gpgsign", "false"])
    const commitAt = (message: string, date: string) => {
      git(root, ["add", "--all"])
      git(root, ["commit", "-m", message], undefined, {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      })
      return git(root, ["rev-parse", "HEAD"])
    }
    writeFileSync(join(root, "origin.txt"), "origin")
    const origin = commitAt("origin", "2024-03-01T10:00:00+02:00")
    git(root, ["checkout", "-b", "first", origin])
    writeFileSync(join(root, "first.txt"), "first")
    const first = commitAt("first", "2024-03-02T10:00:00+00:00")
    git(root, ["checkout", "-b", "second", origin])
    writeFileSync(join(root, "second.txt"), "second")
    const second = commitAt("second", "2024-03-05T08:30:00-05:00")

    const combined = await combineArtifacts(root, origin, [first, second])
    expect(await combineArtifacts(root, origin, [first, second])).toBe(combined)
    expect(git(root, ["show", "-s", "--format=%an <%ae>|%cn <%ce>", combined])).toBe(
      "Configured Person <person@example.com>|Configured Person <person@example.com>",
    )
    expect(git(root, ["show", "-s", "--format=%cI", combined])).toBe("2024-03-05T08:30:00-05:00")
    expect(git(root, ["rev-list", "--parents", "-n", "1", combined]).split(" ").slice(1)).toEqual([
      first,
      second,
    ])
    expect(git(root, ["show", "-s", "--format=%B", combined])).not.toContain("lazers.invalid")

    // Signing (non-reproducible commits) still yields one SHA per tree and parents.
    git(root, ["config", "commit.gpgsign", "true"])
    const signer = join(root, "..", `fake-signer-${Date.now()}.sh`)
    writeFileSync(
      signer,
      '#!/bin/sh\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED " >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\n\\n%s\\n-----END PGP SIGNATURE-----\\n" "$(date +%s)$$$RANDOM"\n',
      { mode: 0o755 },
    )
    git(root, ["config", "gpg.program", signer])
    const third = await combineArtifacts(root, origin, [second, first])
    expect(await combineArtifacts(root, origin, [second, first])).toBe(third)
    expect(git(root, ["cat-file", "commit", third])).toContain("gpgsig")
    rmSync(signer)

    git(root, ["config", "commit.gpgsign", "false"])
    writeFileSync(join(root, "second.txt"), "dirty")
    const candidate = await commitArtifact(root, origin, only("second.txt"))
    expect(git(root, ["show", "-s", "--format=%an <%ae>", candidate.commit])).toBe(
      "Configured Person <person@example.com>",
    )
    expect(git(root, ["show", "-s", "--format=%cI", candidate.commit])).not.toStartWith("2000-")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("combined artifact comparison uses tree OID and ordered parents, not the commit SHA", async () => {
  const root = initRepository("lazers-combined-match-")
  try {
    git(root, ["config", "commit.gpgsign", "false"])
    writeFileSync(join(root, "origin.txt"), "origin")
    const origin = commitAll(root, "origin")
    git(root, ["checkout", "-b", "first", origin])
    writeFileSync(join(root, "first.txt"), "first")
    const first = commitAll(root, "first")
    git(root, ["checkout", "-b", "second", origin])
    writeFileSync(join(root, "second.txt"), "second")
    const second = commitAll(root, "second")
    const stored = await combineArtifacts(root, origin, [first, second])
    const tree = git(root, ["rev-parse", `${stored}^{tree}`])
    const sibling = (parents: string[], commitTree = tree, message = "other") =>
      git(root, ["commit-tree", commitTree, ...parents.flatMap((p) => ["-p", p])], message)

    // A re-signed or re-authored recompute: new SHA, same tree and parents.
    const recomputed = sibling([first, second], tree, "different signature and author")
    expect(recomputed).not.toBe(stored)
    expect(await combinedArtifactsMatch(root, recomputed, stored)).toBe(true)
    expect(await canonicalCombinedArtifact(root, recomputed, [undefined, stored])).toBe(stored)

    // Different tree is rejected.
    const otherTree = git(root, ["rev-parse", `${first}^{tree}`])
    expect(await combinedArtifactsMatch(root, sibling([first, second], otherTree), stored)).toBe(
      false,
    )
    // Different parent order is rejected.
    expect(await combinedArtifactsMatch(root, sibling([second, first]), stored)).toBe(false)
    // Unreadable commit is a failure.
    expect(await combinedArtifactsMatch(root, "0".repeat(40), stored)).toBe(false)
    // Rewritten parents match through the mapping.
    const map = (parent: string) =>
      parent === first ? "first" : parent === second ? "second" : parent
    const rewritten = sibling([second, first].toReversed())
    expect(await combinedArtifactsMatch(root, rewritten, stored, map)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("captured output keeps the head and the true end once it exceeds the limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazers-check-capture-"))
  try {
    const run = (id: string, total: number) =>
      runCheck(
        root,
        "candidate",
        {
          id,
          command: `bun -e 'process.stdout.write("H".repeat(100) + "x".repeat(${total} - 110) + "TAIL-END!!")'`,
          inactivityTimeoutMs: 20_000,
          hardTimeoutMs: 30_000,
        },
        join(root, `${id}.json`),
      )
    const small = await run("small", 32_768)
    expect(small.stdout).toHaveLength(32_768)
    expect(small.stdout).not.toContain("bytes omitted")
    const large = await run("large", 100_000)
    expect(large.stdout.startsWith("H".repeat(100))).toBe(true)
    expect(large.stdout).toMatch(/\n\[\.\.\. 67232 bytes omitted \.\.\.\]\n/)
    expect(large.stdout.endsWith("TAIL-END!!")).toBe(true)
    expect(large.stdout.length).toBeLessThan(32_768 + 64)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
