import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NoCapabilityProviderError } from "../core/capabilities.ts"
import { TaskRepository } from "../storage.ts"
import type { ArchitectSourceResult } from "./host.ts"

import { RunnerStore } from "./store.ts"
import {
  TaskRuntime,
  cleanup,
  fixture,
  holdInterruptedAttempt,
  prepareIdleArchitect,
  transitions,
  useRuntimeFixtureCleanup,
} from "./runtime.fixture.ts"

useRuntimeFixtureCleanup()

test("F-S3-1 archived sources leave polling while their history and native-event recovery survive", async () => {
  const now = 2_000_000_519_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "source-retirement.txt" }],
  })
  let reads = 0
  const read = f.host.architectInputPage!.bind(f.host)
  f.host.architectInputPage = (...args) => {
    reads++
    return read(...args)
  }
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  await f.runtime.tick()
  expect(f.store.architectSource("owner")).toMatchObject({
    state: "retired",
    scan_complete_at: now,
  })
  const scans = reads
  const revision = f.store.architectSource("owner")!.revision
  const inputTimes = () =>
    f.repository.read((db) =>
      db
        .query(
          "SELECT message_id,observed_at,updated_at FROM runner_architect_inputs WHERE session_id='owner' ORDER BY message_id",
        )
        .all(),
    )
  const before = inputTimes()
  for (let tick = 0; tick < 4; tick++) await f.runtime.tick()
  expect(reads).toBe(scans)
  expect(f.store.architectSources()).toEqual([])
  expect(f.store.architectSourceJournalPage(f.receipt.planID, 100).records).not.toHaveLength(0)
  f.runtime.observeArchitectSourceEvent("owner")
  f.runtime.flushSourceInvalidations()
  expect(f.store.architectSource("owner")!.state).toBe("active")
  await f.runtime.tick()
  expect(reads).toBe(scans + 1)
  expect(f.store.architectSource("owner")).toMatchObject({ state: "retired", revision })
  expect(inputTimes()).toEqual(before)
  // A resync (reload) verifies a retired source once without reactivating or rescanning it.
  f.runtime.observeArchitectSourceEvent()
  f.runtime.flushSourceInvalidations()
  expect(f.store.architectSource("owner")!.state).toBe("retired")
  await f.runtime.tick()
  expect(reads).toBe(scans + 2)
  expect(f.store.architectSource("owner")).toMatchObject({ state: "retired", revision })
  await f.runtime.tick()
  expect(reads).toBe(scans + 2)
  expect(new RunnerStore(f.repository).architectSources()).toEqual([])
})

test("F-S3-1 activity during a source read keeps it scheduled for a fresh pass", async () => {
  const now = 2_000_000_519_500
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "source-race.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  await f.runtime.tick()
  f.runtime.observeArchitectSourceEvent("owner")
  f.runtime.flushSourceInvalidations()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const read = f.host.architectInputPage!.bind(f.host)
  let held = true
  f.host.architectInputPage = async (...args) => {
    const page = await read(...args)
    if (held) {
      started.resolve()
      await release.promise
    }
    return page
  }
  const tick = f.runtime.tick()
  await started.promise
  f.runtime.observeArchitectSourceEvent("owner")
  f.runtime.flushSourceInvalidations()
  held = false
  release.resolve()
  await tick
  expect(f.store.architectSource("owner")).toMatchObject({
    state: "active",
    scan_complete_at: null,
  })
  await f.runtime.tick()
  expect(f.store.architectSource("owner")!.state).toBe("retired")
})

test("late and mutable assistant tool results update the source journal without notifying the Architect", async () => {
  const now = 2_000_000_520_000
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "mutable-source-result.txt" }],
  })
  const attempt = await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("committed")

  const privateCanary = "RAW_TOOL_ARGUMENTS_AND_REASONING_MUST_NOT_ESCAPE"
  let result: ArchitectSourceResult = {
    state: "running" as const,
    finish: null,
    toolCounts: { running: 1, completed: 0, failed: 0, other: 0 },
  }
  f.host.architectInputPage = async () => ({
    inbox: [],
    messages: [
      {
        id: "msg_late_tool_result",
        type: "assistant",
        metadata: { private: privateCanary },
        result,
      },
    ],
    nextCursor: null,
  })

  await f.runtime.tick()
  result = {
    state: "completed",
    finish: "stop",
    toolCounts: { running: 0, completed: 1, failed: 0, other: 0 },
  }
  // F-S3-1: the native tool completion invalidates a retired source without polling it forever.
  f.runtime.observeArchitectSourceEvent(renewal.previous_session_id)
  f.runtime.flushSourceInvalidations()
  await f.runtime.tick()

  const stored = f.store.atomic((db) =>
    db
      .query<
        {
          state: string
          result_revision: number
          referenced_revision: number
          result_fingerprint: string
        },
        [string, string]
      >(
        `SELECT state,result_revision,referenced_revision,result_fingerprint
         FROM runner_architect_source_results WHERE session_id=? AND message_id=?`,
      )
      .get("owner", "msg_late_tool_result"),
  )!
  expect(stored).toMatchObject({
    state: "completed",
    result_revision: 2,
    referenced_revision: expect.any(Number),
  })
  // The late result is a journal fact only; nothing tells the Architect that the journal changed.
  const notices = (f.store.detail(f.receipt.planID).delivery as { payload: string }[])
    .map((row) => JSON.parse(row.payload))
    .filter((payload) => String(payload.status).startsWith("architect-source"))
  expect(notices).toHaveLength(0)
  const journal = f.store.architectSourceJournalPage(f.receipt.planID, 100)
  expect(journal.records).toContainEqual(
    expect.objectContaining({
      kind: "result",
      messageID: "msg_late_tool_result",
      state: "completed",
      resultRevision: 2,
    }),
  )
  expect(f.notifications.filter((notice) => notice.text.includes("source changed"))).toHaveLength(0)
  expect(JSON.stringify(notices)).not.toContain(privateCanary)
  expect(f.store.attempts(f.receipt.planID)[0]?.session_id).toBe(attempt.session_id)
  expect(f.sessions.get(attempt.session_id)?.busy).toBe(true)
})

test("shared-database renewal recovery is invisible to a different canonical project", async () => {
  const now = 2_000_000_540_000
  const f = fixture({
    shared: true,
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "project-isolation.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  const update = f.host.updateSession!
  f.host.updateSession = async (input) => {
    if (input.sessionID === "owner" && input.archived)
      throw new Error("foreign scheduler must not retry this archive")
    await update(input)
  }
  await f.runtime.tick()
  const renewal = f.store.architectRenewalForPlan(f.receipt.planID)!
  expect(renewal.state).toBe("archiving")

  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "lazers-other-project-")))
  const otherRepository = new TaskRepository(f.repository.path, otherRoot)
  const otherStore = new RunnerStore(otherRepository)
  const otherRuntime = new TaskRuntime(otherStore, f.host, "other-project", undefined, {
    now: () => now,
    architectPromptHook: true,
  })
  cleanup.unshift(() => {
    void otherRuntime.stop()
    otherRepository.close()
    rmSync(otherRoot, { recursive: true, force: true })
  })
  let foreignSessionReads = 0
  const session = f.host.session
  f.host.session = async (id, options) => {
    foreignSessionReads++
    return session(id, options)
  }

  await otherRuntime.tick()

  expect(foreignSessionReads).toBe(0)
  expect(otherStore.architectRenewalsNeedingRecovery()).toEqual([])
  expect(otherStore.architectSources()).toEqual([])
  expect(otherStore.architectRenewal(renewal.id)).toBeNull()
  expect(otherStore.architectRenewalForSource("owner")).toBeNull()
  expect(otherStore.architectSource("owner")).toBeNull()
  expect(otherStore.architectSourceInputs("owner")).toEqual([])
  expect(
    otherStore.observeArchitectInput("owner", "foreign-user-input", now, {
      type: "user",
      userPrompt: true,
    }),
  ).toMatchObject({ renewal: null, state: null })
  expect(f.store.architectRenewal(renewal.id)).toMatchObject({
    state: "archiving",
    error: "foreign scheduler must not retry this archive",
  })
})

test.each(["workspace", "baseline"] as const)(
  "terminal continuation preserves the retained assignment against %s changes",
  async (change) => {
    const f = fixture({ delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt } = await holdInterruptedAttempt(f)
    await expect(
      f.runtime.command(
        {
          requestID: `preserve-terminal-${change}`,
          planID,
          action: "resume",
          taskID: attempt.task_id,
          attemptID: attempt.id,
          ...(change === "workspace"
            ? { workspaceMode: "shared" }
            : { baseCommit: "f".repeat(40) }),
          reason: "Continue the retained assignment",
        },
        "owner",
      ),
    ).rejects.toThrow("preserves its workspace and baseline")
    expect(f.store.attempts(planID)[0]).toEqual(attempt)
    expect(f.events.filter((event) => event.startsWith("prompt:"))).toHaveLength(1)
  },
)

test.each([false, true])(
  "terminal continuation retains a redundant workspace selection (shared=%s)",
  async (shared) => {
    const f = fixture({ shared, delayed: true, taskFiles: [{ name: "a", path: "a.txt" }] })
    const { planID, attempt } = await holdInterruptedAttempt(f)
    await f.runtime.command(
      {
        requestID: "preserve-terminal-redundant",
        planID,
        action: "resume",
        taskID: attempt.task_id,
        attemptID: attempt.id,
        workspaceMode: shared ? "shared" : "isolated",
        baseCommit: attempt.base_commit,
        reason: "Continue the same workspace and baseline",
      },
      "owner",
    )
    expect(f.store.attempts(planID)[0]).toMatchObject({
      id: attempt.id,
      workspace: attempt.workspace,
      base_commit: attempt.base_commit,
      state: "preparing",
    })
    expect(
      f.store
        .activity(planID, attempt.task_id)
        .filter((entry) => entry.event === "WORKSPACE_SELECTED"),
    ).toHaveLength(0)
  },
)

test("a persistent Architect source scan failure records once per distinct cause, not per tick", async () => {
  const now = 2_000_000_519_700
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "source-scan-failure.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  await f.runtime.tick()
  let cause = "Native outcome inbox target is not a same-project Architect session"
  let reads = 0
  f.host.architectInputPage = async () => {
    reads++
    throw new Error(cause)
  }
  const failures = () =>
    f.repository.read((db) =>
      db
        .query<{ payload: string }, []>(
          "SELECT payload FROM runner_transitions WHERE event='ARCHITECT_SOURCE_SCAN_FAILED' ORDER BY id",
        )
        .all()
        .map((row) => JSON.parse(row.payload) as { error: string }),
    )
  const baseline = failures().length
  f.runtime.observeArchitectSourceEvent("owner")
  f.runtime.flushSourceInvalidations()
  for (let tick = 0; tick < 5; tick++) await f.runtime.tick()
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(failures().length).toBe(baseline + 1)
  cause = "a different cause"
  for (let tick = 0; tick < 3; tick++) await f.runtime.tick()
  expect(failures().length).toBe(baseline + 2)
  expect(failures().at(-1)?.error).toBe("a different cause")
})

test("a missing live location is not an Architect source scan failure", async () => {
  const now = 2_000_000_519_700
  const f = fixture({
    delayed: true,
    architectPromptHook: true,
    architectIdleWindowMs: 1_000,
    now: () => now,
    taskFiles: [{ name: "a", path: "source-scan-no-location.txt" }],
  })
  await prepareIdleArchitect(f, now, 1_000)
  await f.runtime.tick()
  await f.runtime.tick()
  let reads = 0
  f.host.architectInputPage = async () => {
    reads++
    throw new NoCapabilityProviderError("native")
  }
  const failures = () =>
    f.repository.read(
      (db) =>
        db
          .query<{ n: number }, []>(
            "SELECT count(*) AS n FROM runner_transitions WHERE event='ARCHITECT_SOURCE_SCAN_FAILED'",
          )
          .get()!.n,
    )
  const baseline = failures()
  f.runtime.observeArchitectSourceEvent("owner")
  f.runtime.flushSourceInvalidations()
  for (let tick = 0; tick < 5; tick++) await f.runtime.tick()
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(failures()).toBe(baseline)
})

test("source scan failures are recorded once per source even when sources interleave on one plan", () => {
  const f = fixture({ taskFiles: [{ name: "a", path: "a.txt" }] })
  const plan = f.receipt.planID
  const fail = (source: string, error: string) =>
    f.store.recordSourceScanFailure(plan, {
      renewalID: `r-${source}`,
      sourceSessionID: source,
      error,
    })
  expect(fail("s1", "boom")).toBe(true)
  expect(fail("s2", "boom")).toBe(true)
  // A process restart replays both sources; neither is a new fact.
  expect(fail("s1", "boom")).toBe(false)
  expect(fail("s2", "boom")).toBe(false)
  expect(fail("s1", "other")).toBe(true)
  expect(transitions(f, plan, "ARCHITECT_SOURCE_SCAN_FAILED")).toHaveLength(3)
})
