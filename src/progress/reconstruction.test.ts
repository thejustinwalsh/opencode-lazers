import { expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { join } from "node:path"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import type { ProgressAssignment } from "./recorder.ts"
import type { ReconstructionParticipant } from "./reconstruction.ts"
import {
  progressReconstructionDiagnostics,
  progressReconstructionKey,
  registerProgressReconstruction,
  sameProgressAssignment,
} from "./reconstruction.ts"

type ReconstructionModule = typeof import("./reconstruction.ts")
type LocalLoader = {
  read(entrypoint: string): Promise<{ module: unknown }>
  dispose(): void
}

function assignment(
  index: number,
  projectID = "project",
  attemptState = "running",
): ProgressAssignment {
  const number = index.toString().padStart(3, "0")
  return {
    projectID,
    taskID: `task-${number}`,
    planID: `plan-${number}`,
    attemptID: `attempt-${number}`,
    attemptState,
    sessionID: `ses-recovery-${number}`,
    assignedMessageID: `msg-assigned-${number}`,
    workspace: `/workspace/${number}`,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Progress reconstruction condition was not reached")
}

function participantFor(
  assignments: () => ProgressAssignment[],
  reconstruct: ReconstructionParticipant["reconstruct"],
) {
  const current = (sessionID: string) =>
    assignments().find((value) => value.sessionID === sessionID)
  return {
    assignments,
    assignmentForSession: current,
    reconstruct,
  }
}

test("54 registrations across pinned loader generations share one 97-session baseline", async () => {
  const fixture = makeFixture()
  const registrations: ReturnType<typeof registerProgressReconstruction>[] = []
  const firstGate = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  let firstSession = true
  let gets = 0
  let contexts = 0
  let activeReads = 0
  let maxActiveReads = 0
  let assignmentReads = 0
  const assignments = Array.from({ length: 94 }, (_, index) => assignment(index + 1))

  try {
    const source = (await import(
      new URL("./source.js", import.meta.resolve("@opencode/plugin/host")).href
    )) as { createPluginSources(watch: (file: string) => Promise<void>): LocalLoader }
    const firstLoader = source.createPluginSources(async () => {})
    const secondLoader = source.createPluginSources(async () => {})
    try {
      const entrypoint = new URL("./reconstruction.ts", import.meta.url).href
      const first = (await firstLoader.read(entrypoint)).module as ReconstructionModule
      const second = (await secondLoader.read(entrypoint)).module as ReconstructionModule
      expect(first).not.toBe(second)

      const makeParticipant = () =>
        participantFor(
          () => {
            assignmentReads++
            return assignments.map((value) => ({ ...value }))
          },
          async (value, isCurrent) => {
            gets++
            activeReads++
            maxActiveReads = Math.max(maxActiveReads, activeReads)
            try {
              if (value.sessionID === "ses-recovery-001" && firstSession) {
                firstSession = false
                firstGate.resolve()
                await releaseFirst.promise
              }
              if (!isCurrent()) return "stale"
              contexts++
              return "complete"
            } finally {
              activeReads--
            }
          },
        )
      const options = () => ({
        databasePath: fixture.store.repository.path,
        projectDirectory: fixture.directory,
        projectID: "project",
        participant: makeParticipant(),
        pollIntervalMs: 60_000,
      })
      registrations.push(first.registerProgressReconstruction(options()))
      await firstGate.promise
      for (let index = 1; index < 54; index++) {
        const module = index < 27 ? first : second
        registrations.push(module.registerProgressReconstruction(options()))
      }

      assignments.push(assignment(95), assignment(96))
      registrations[1]!.changed("ses-recovery-095")
      registrations[53]!.changed("ses-recovery-096")
      releaseFirst.resolve()
      await waitFor(() => contexts === 96)

      assignments.push(assignment(97))
      registrations[53]!.changed("ses-recovery-097")
      await waitFor(() => contexts === 97)

      expect(registrations).toHaveLength(54)
      expect(gets).toBe(97)
      expect(contexts).toBe(97)
      expect(maxActiveReads).toBe(1)

      const beforeDiagnostics = assignmentReads
      const firstDiagnostics = first.progressReconstructionDiagnostics(
        fixture.store.repository.path,
        fixture.directory,
        "project",
      )
      const secondDiagnostics = second.progressReconstructionDiagnostics(
        fixture.store.repository.path,
        fixture.directory,
        "project",
      )
      expect(firstDiagnostics.moduleGenerationID).not.toBe(secondDiagnostics.moduleGenerationID)
      expect(firstDiagnostics.implementationID).toBe("lazers.progress.reconstruction.v1")
      expect(firstDiagnostics.coordinator.participantCount).toBe(54)
      expect(
        firstDiagnostics.coordinator.participantGenerations.map((group) => group.participantCount),
      ).toEqual([27, 27])
      expect(firstDiagnostics.coordinator.assignments.cachedCount).toBe(97)
      expect(firstDiagnostics.coordinator.nativeReads).toMatchObject({
        get: { invocations: 0, succeeded: 0, failed: 0, pending: 0 },
        context: { invocations: 0, succeeded: 0, failed: 0, pending: 0 },
      })
      expect(assignmentReads).toBe(beforeDiagnostics)
      expect(JSON.stringify(firstDiagnostics)).not.toContain("ses-recovery-001")
      expect(JSON.stringify(firstDiagnostics)).not.toContain("task-001")
      expect(JSON.stringify(firstDiagnostics)).not.toContain(fixture.directory)
    } finally {
      releaseFirst.resolve()
      for (const registration of registrations) registration.dispose()
      firstLoader.dispose()
      secondLoader.dispose()
    }
  } finally {
    fixture.close()
  }
})

test("diagnostics are lookup-only for absent and initialized project coordinators", async () => {
  const fixture = makeFixture()
  const projectID = "diagnostics-read-only-project"
  let assignmentCalls = 0
  let reconstructionCalls = 0
  const absent = progressReconstructionDiagnostics(
    `${fixture.store.repository.path}.absent`,
    fixture.directory,
    projectID,
  )
  const absentAgain = progressReconstructionDiagnostics(
    `${fixture.store.repository.path}.absent`,
    fixture.directory,
    projectID,
  )
  const registration = registerProgressReconstruction({
    databasePath: fixture.store.repository.path,
    projectDirectory: fixture.directory,
    projectID,
    pollIntervalMs: 60_000,
    participant: participantFor(
      () => {
        assignmentCalls++
        return [assignment(1, projectID)]
      },
      async () => {
        reconstructionCalls++
        return "complete"
      },
    ),
  })

  try {
    expect(absent.state).toBe("absent")
    expect(absentAgain.state).toBe("absent")
    expect(absent.coordinator.participantCount).toBe(0)
    expect(absent.coordinator.nativeReads).toBeNull()
    await waitFor(() => reconstructionCalls === 1)

    const before = progressReconstructionDiagnostics(
      fixture.store.repository.path,
      fixture.directory,
      projectID,
    )
    const readsBeforeSnapshots = assignmentCalls
    const after = progressReconstructionDiagnostics(
      fixture.store.repository.path,
      fixture.directory,
      projectID,
    )
    expect(before.state).toBe("initialized")
    expect(before.coordinator.assignments).toMatchObject({
      baselineCaptured: true,
      cachedCount: 1,
      activeCount: 1,
      terminalCount: 0,
    })
    expect(before.coordinator.assignments.asOf).not.toBeNull()
    expect(after.coordinator).toEqual(before.coordinator)
    expect(assignmentCalls).toBe(readsBeforeSnapshots)
    expect(reconstructionCalls).toBe(1)
  } finally {
    registration.dispose()
    fixture.close()
  }
})

test("retired native reads remain visible until settlement without reclaiming queue ownership", async () => {
  const fixture = makeFixture()
  const projectID = "diagnostics-retired-read-project"
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let retiredReadFinished: ((outcome: "succeeded" | "failed") => void) | undefined
  const oldRegistration = registerProgressReconstruction({
    databasePath: fixture.store.repository.path,
    projectDirectory: fixture.directory,
    projectID,
    pollIntervalMs: 60_000,
    participant: {
      assignments: () => [assignment(1, projectID)],
      assignmentForSession: (sessionID) =>
        sessionID === assignment(1, projectID).sessionID ? assignment(1, projectID) : undefined,
      reconstruct: async (_value, _isCurrent, readStarted) => {
        retiredReadFinished = readStarted("get")
        entered.resolve()
        await release.promise
        return "stale"
      },
    },
  })
  let successor: ReturnType<typeof registerProgressReconstruction> | undefined

  try {
    await entered.promise
    const pending = progressReconstructionDiagnostics(
      fixture.store.repository.path,
      fixture.directory,
      projectID,
    )
    expect(pending.coordinator.nativeReads?.get).toMatchObject({
      invocations: 1,
      pending: 1,
      succeeded: 0,
      failed: 0,
    })

    oldRegistration.dispose()
    successor = registerProgressReconstruction({
      databasePath: fixture.store.repository.path,
      projectDirectory: fixture.directory,
      projectID,
      pollIntervalMs: 60_000,
      participant: participantFor(
        () => [assignment(1, projectID)],
        async () => "complete",
      ),
    })
    await waitFor(() => {
      const current = progressReconstructionDiagnostics(
        fixture.store.repository.path,
        fixture.directory,
        projectID,
      )
      return (
        current.coordinator.nativeReads?.get.pending === 1 &&
        !current.coordinator.work.reconstructionActive
      )
    })
    const beforeLateSettlement = progressReconstructionDiagnostics(
      fixture.store.repository.path,
      fixture.directory,
      projectID,
    )
    expect(beforeLateSettlement.coordinator.work).toMatchObject({
      outstandingRetiredReads: 1,
      reconstructionActive: false,
      drainOwned: false,
    })
    expect(beforeLateSettlement.coordinator.nativeReads?.get.pending).toBe(1)

    release.resolve()
    retiredReadFinished!("succeeded")
    await waitFor(() => {
      const settled = progressReconstructionDiagnostics(
        fixture.store.repository.path,
        fixture.directory,
        projectID,
      )
      return settled.coordinator.nativeReads?.get.pending === 0
    })
    const afterLateSettlement = progressReconstructionDiagnostics(
      fixture.store.repository.path,
      fixture.directory,
      projectID,
    )
    expect(afterLateSettlement.coordinator.nativeReads?.get).toMatchObject({
      invocations: 1,
      pending: 0,
      succeeded: 1,
      failed: 0,
    })
    expect(afterLateSettlement.coordinator.work).toMatchObject({
      queuedCount: beforeLateSettlement.coordinator.work.queuedCount,
      delayedCount: beforeLateSettlement.coordinator.work.delayedCount,
      dirtyCount: beforeLateSettlement.coordinator.work.dirtyCount,
      reconstructionActive: false,
      drainOwned: false,
    })
  } finally {
    release.resolve()
    oldRegistration.dispose()
    successor?.dispose()
    fixture.close()
  }
})

test("canonical aliases share ownership while different database and project keys isolate", async () => {
  const fixture = makeFixture()
  const registrations: ReturnType<typeof registerProgressReconstruction>[] = []
  try {
    const databaseAlias = join(fixture.directory, "tasks-alias.sqlite")
    symlinkSync(fixture.store.repository.path, databaseAlias)
    expect(
      progressReconstructionKey(fixture.store.repository.path, fixture.directory, "project"),
    ).toBe(progressReconstructionKey(databaseAlias, fixture.directory, "project"))

    let sharedReads = 0
    let differentProjectReads = 0
    let differentDatabaseReads = 0
    const add = (
      databasePath: string,
      projectID: string,
      value: ProgressAssignment,
      increment: () => void,
      location = fixture.directory,
    ) =>
      registerProgressReconstruction({
        databasePath,
        projectDirectory: fixture.directory,
        projectID,
        location,
        pollIntervalMs: 60_000,
        participant: participantFor(
          () => [{ ...value }],
          async (_assignment, isCurrent) => {
            expect(isCurrent()).toBe(true)
            increment()
            return "complete"
          },
        ),
      })

    registrations.push(
      add(fixture.store.repository.path, "project", assignment(1), () => sharedReads++),
      add(
        databaseAlias,
        "project",
        assignment(1),
        () => sharedReads++,
        join(fixture.directory, "alternate-location"),
      ),
      add(
        fixture.store.repository.path,
        "different-project",
        assignment(2, "different-project"),
        () => differentProjectReads++,
      ),
      add(
        join(fixture.directory, "other.sqlite"),
        "project",
        assignment(3),
        () => differentDatabaseReads++,
      ),
    )

    await waitFor(() => sharedReads + differentProjectReads + differentDatabaseReads === 3)
    expect(sharedReads).toBe(1)
    expect(differentProjectReads).toBe(1)
    expect(differentDatabaseReads).toBe(1)
    const sharedDiagnostics = progressReconstructionDiagnostics(
      fixture.store.repository.path,
      fixture.directory,
      "project",
    )
    expect(sharedDiagnostics.coordinator.participantCount).toBe(2)
    expect(sharedDiagnostics.coordinator.locationCount).toBe(2)
    expect(sharedDiagnostics.coordinator.locationParticipantCounts).toEqual([1, 1])
    expect(JSON.stringify(sharedDiagnostics)).not.toContain("alternate-location")
    expect(
      progressReconstructionDiagnostics(
        fixture.store.repository.path,
        fixture.directory,
        "different-project",
      ).coordinator.participantCount,
    ).toBe(1)
    expect(
      progressReconstructionDiagnostics(
        join(fixture.directory, "other.sqlite"),
        fixture.directory,
        "project",
      ).coordinator.participantCount,
    ).toBe(1)
  } finally {
    for (const registration of registrations) registration.dispose()
    fixture.close()
  }
})

test("suspended changes coalesce, assignment changes are polled, and stale reads refetch", async () => {
  const fixture = makeFixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let latest = assignment(1)
  let contentRevision = 1
  let calls = 0
  let active = 0
  let maxActive = 0
  const seen: ProgressAssignment[] = []
  const seenContent: number[] = []
  const registration = registerProgressReconstruction({
    databasePath: fixture.store.repository.path,
    projectDirectory: fixture.directory,
    projectID: "project",
    pollIntervalMs: 10,
    participant: participantFor(
      () => [{ ...latest }],
      async (value, isCurrent) => {
        calls++
        active++
        maxActive = Math.max(maxActive, active)
        seen.push(value)
        const contentAtRead = contentRevision
        try {
          if (calls === 1) {
            started.resolve()
            await release.promise
          }
          if (!isCurrent()) return "stale"
          seenContent.push(contentAtRead)
          return "complete"
        } finally {
          active--
        }
      },
    ),
  })

  try {
    await started.promise
    contentRevision = 2
    expect(sameProgressAssignment(latest, seen[0])).toBe(true)
    registration.changed(latest.sessionID)
    registration.changed(latest.sessionID)
    registration.changed(latest.sessionID)
    release.resolve()
    await waitFor(() => calls === 2)
    expect(seenContent).toEqual([1, 2])
    expect(maxActive).toBe(1)

    latest = { ...latest, assignedMessageID: "msg-updated", workspace: "/workspace/updated" }
    await waitFor(() => calls === 3)
    expect(seen[2]).toMatchObject({
      assignedMessageID: "msg-updated",
      workspace: "/workspace/updated",
    })

    latest = { ...latest, attemptState: "failed" }
    await waitFor(() => calls === 4)
    expect(seen[3]?.attemptState).toBe("failed")

    await waitFor(() => active === 0)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    registration.changed(latest.sessionID)
    await waitFor(() => calls === 5)
    expect(calls).toBe(5)
  } finally {
    release.resolve()
    registration.dispose()
    fixture.close()
  }
})

test("all-participant disposal preserves unfinished recovery without replaying completed sessions", async () => {
  const fixture = makeFixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const retiredSettled = Promise.withResolvers<void>()
  let released = false
  const assignments = [assignment(1), assignment(2), assignment(3)]
  const oldWrites: string[] = []
  const newWrites: string[] = []
  let registration = registerProgressReconstruction({
    databasePath: fixture.store.repository.path,
    projectDirectory: fixture.directory,
    projectID: "project",
    pollIntervalMs: 60_000,
    participant: participantFor(
      () => assignments.map((value) => ({ ...value })),
      async (value, isCurrent) => {
        if (value.sessionID === assignments[1]!.sessionID) {
          entered.resolve()
          await release.promise
          if (!isCurrent()) {
            retiredSettled.resolve()
            return "stale"
          }
        }
        if (!isCurrent()) return "stale"
        oldWrites.push(value.sessionID)
        return "complete"
      },
    ),
  })

  try {
    await entered.promise
    expect(oldWrites).toEqual([assignments[0]!.sessionID])
    registration.dispose()
    registration = registerProgressReconstruction({
      databasePath: fixture.store.repository.path,
      projectDirectory: fixture.directory,
      projectID: "project",
      pollIntervalMs: 60_000,
      participant: participantFor(
        () => assignments.map((value) => ({ ...value })),
        async (value, isCurrent) => {
          if (!isCurrent()) return "stale"
          newWrites.push(value.sessionID)
          return "complete"
        },
      ),
    })

    await waitFor(() => newWrites.length === 2)
    expect(released).toBe(false)
    expect(oldWrites).toEqual([assignments[0]!.sessionID])
    expect(newWrites.sort()).toEqual([assignments[1]!.sessionID, assignments[2]!.sessionID].sort())
    released = true
    release.resolve()
    await retiredSettled.promise
  } finally {
    release.resolve()
    registration.dispose()
    fixture.close()
  }
})

test("unavailable reconstruction remains queued and retries until it recovers", async () => {
  const fixture = makeFixture()
  let calls = 0
  const registration = registerProgressReconstruction({
    databasePath: fixture.store.repository.path,
    projectDirectory: fixture.directory,
    projectID: "project",
    pollIntervalMs: 60_000,
    participant: participantFor(
      () => [assignment(1)],
      async (_value, isCurrent) => {
        if (!isCurrent()) return "stale"
        calls++
        return calls === 1 ? "retry" : "complete"
      },
    ),
  })

  try {
    await waitFor(() => calls === 2, 5_000)
    expect(calls).toBe(2)
  } finally {
    registration.dispose()
    fixture.close()
  }
})
