import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanupWorkerOwnershipMatches,
  sameCanonicalProjectDirectory,
} from "./canonical-ownership.ts"

test("canonical cleanup ownership requires exact worker bindings and a matching native repository", () => {
  const projectDirectory = mkdtempSync(join(tmpdir(), "lazers-cleanup-owner-"))
  const foreignDirectory = mkdtempSync(join(tmpdir(), "lazers-cleanup-foreign-"))
  const alias = `${projectDirectory}-alias`
  symlinkSync(projectDirectory, alias)

  try {
    const evidence = {
      expectedProjectID: "project-before-drift",
      observedProjectID: "project-after-drift",
      expectedProjectDirectory: projectDirectory,
      observedProjectDirectory: alias,
      attemptProjectDirectory: projectDirectory,
      expectedSessionID: "session-worker",
      observedSessionID: "session-worker",
      expectedAttemptID: "attempt-owned",
      effectAttemptID: "attempt-owned",
      observedAttemptID: "attempt-owned",
      expectedWorkspace: `${projectDirectory}.worktrees/attempt-owned`,
      attemptWorkspace: `${projectDirectory}.worktrees/attempt-owned`,
      observedWorkspace: `${projectDirectory}.worktrees/attempt-owned`,
    }

    expect(sameCanonicalProjectDirectory(projectDirectory, alias)).toBe(true)
    expect(cleanupWorkerOwnershipMatches(evidence)).toBe(true)
    expect(
      cleanupWorkerOwnershipMatches({ ...evidence, observedProjectID: evidence.expectedProjectID }),
    ).toBe(true)
    expect(
      cleanupWorkerOwnershipMatches({ ...evidence, observedProjectDirectory: foreignDirectory }),
    ).toBe(false)
    expect(
      cleanupWorkerOwnershipMatches({ ...evidence, observedProjectDirectory: undefined }),
    ).toBe(false)
    expect(cleanupWorkerOwnershipMatches({ ...evidence, attemptProjectDirectory: undefined })).toBe(
      false,
    )
    expect(cleanupWorkerOwnershipMatches({ ...evidence, observedSessionID: "other-session" })).toBe(
      false,
    )
    expect(cleanupWorkerOwnershipMatches({ ...evidence, observedAttemptID: "other-attempt" })).toBe(
      false,
    )
    expect(
      cleanupWorkerOwnershipMatches({ ...evidence, observedWorkspace: "/moved/worktree" }),
    ).toBe(false)
  } finally {
    rmSync(alias, { force: true })
    rmSync(projectDirectory, { recursive: true, force: true })
    rmSync(foreignDirectory, { recursive: true, force: true })
  }
})
