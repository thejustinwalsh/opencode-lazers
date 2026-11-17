import { expect, test } from "bun:test"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { ProgressRecorder, lightMessagesSignature } from "./recorder.ts"
import { registerProgressReconstruction } from "./reconstruction.ts"
import { SESSION_OWNER_NEGATIVE_TTL_MS } from "./session-owners.ts"

const workerSession = "ses-failed"

function textEvent(sessionID: string, onTextRead: () => void) {
  return {
    id: `evt-${crypto.randomUUID()}`,
    type: "session.text.ended",
    created: 1_000,
    data: {
      sessionID,
      assistantMessageID: "msg-1",
      ordinal: 0,
      get text() {
        onTextRead()
        return "visible text"
      },
    },
  }
}

test("unowned-session native events do no fact building, transaction or write", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const before = fixture.store.progressFacts([firstAttemptID]).length
    let atomicCalls = 0
    const atomic = fixture.store.atomic.bind(fixture.store)
    fixture.store.atomic = ((run: Parameters<typeof atomic>[0]) => {
      atomicCalls++
      return atomic(run)
    }) as typeof fixture.store.atomic

    let textReads = 0
    // First event resolves ownership with a single read-only lookup.
    for (let index = 0; index < 100; index++)
      recorder.recordNativeEvent(textEvent("ses-unrelated", () => textReads++))

    expect(textReads).toBe(0)
    expect(atomicCalls).toBe(0)
    const unchanged = fixture.store.progressFacts([firstAttemptID]).length === before
    expect(unchanged).toBe(true)

    // An owned session still records.
    recorder.recordNativeEvent(textEvent(workerSession, () => textReads++))
    expect(textReads).toBeGreaterThan(0)
    expect(atomicCalls).toBeGreaterThan(0)
  } finally {
    fixture.close()
  }
})

test("negative ownership expires so a newly inserted assignment is observed", async () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    expect(recorder.mayBeAssigned("ses-not-yet")).toBe(false)
    fixture.store.atomic((db) =>
      db.run("UPDATE runner_attempts SET session_id=? WHERE id=?", ["ses-not-yet", firstAttemptID]),
    )
    await Bun.sleep(SESSION_OWNER_NEGATIVE_TTL_MS + 50)
    expect(recorder.mayBeAssigned("ses-not-yet")).toBe(true)
  } finally {
    fixture.close()
  }
})

test("a burst of native nudges coalesces into at most one reconstruction per session", async () => {
  const fixture = makeFixture()
  let reconstructions = 0
  let lookups = 0
  const assignment = {
    projectID: "project",
    taskID: "task",
    planID: "plan",
    attemptID: "attempt",
    attemptState: "running",
    sessionID: "ses-owned",
    assignedMessageID: "msg",
    workspace: fixture.directory,
  }
  const registration = registerProgressReconstruction({
    databasePath: fixture.store.repository.path,
    projectDirectory: fixture.directory,
    projectID: "project-burst",
    pollIntervalMs: 60_000,
    terminalRefreshMs: 60_000,
    changedDebounceMs: 100,
    participant: {
      assignments: () => [assignment],
      assignmentForSession: (sessionID) => {
        lookups++
        return sessionID === assignment.sessionID ? assignment : undefined
      },
      mayOwn: (sessionID) => sessionID === assignment.sessionID,
      reconstruct: async () => {
        reconstructions++
        return "complete"
      },
    },
  })
  try {
    await Bun.sleep(30)
    reconstructions = 0
    lookups = 0
    for (let index = 0; index < 100; index++) registration.changed("ses-owned")
    for (let index = 0; index < 100; index++) registration.changed("ses-unowned")
    await Bun.sleep(250)
    expect(reconstructions).toBeLessThanOrEqual(2)
    expect(lookups).toBeLessThanOrEqual(2)
  } finally {
    registration.dispose()
    fixture.close()
  }
})

test("light message signature tracks structure and tail changes, never runs accessors", () => {
  const message = {
    id: "m1",
    type: "assistant",
    time: { created: 1 },
    content: [{ type: "text", text: "x".repeat(5_000) }],
  }
  const base = lightMessagesSignature([message], false)!
  expect(lightMessagesSignature([structuredClone(message)], false)).toBe(base)
  expect(lightMessagesSignature([message], true)).not.toBe(base)
  expect(lightMessagesSignature([message, { id: "m2", type: "user" }], false)).not.toBe(base)
  expect(
    lightMessagesSignature(
      [{ ...message, content: [{ type: "text", text: "x".repeat(5_000) + "y" }] }],
      false,
    ),
  ).not.toBe(base)
  let touched = false
  const hostile = {
    id: "m",
    get text() {
      touched = true
      return "x"
    },
  }
  expect(lightMessagesSignature([hostile], false)).toBeUndefined()
  expect(touched).toBe(false)
})

test("unchanged retained messages skip the full fingerprint and rewrite nothing", () => {
  const fixture = makeFixture()
  try {
    const recorder = new ProgressRecorder(fixture.store, "project")
    const messages = Array.from({ length: 2_000 }, (_, index) => ({
      id: `msg-${index}`,
      type: "assistant",
      time: { created: 1_000 + index },
      content: [{ type: "text", text: `line ${index}` }],
    }))
    recorder.reconcileMessages(workerSession, messages)
    const rows = fixture.store.progressFacts([firstAttemptID]).length
    const memo = (
      recorder as unknown as { recoveryMemos: Map<string, { light?: string; fingerprint: string }> }
    ).recoveryMemos.get(workerSession)!
    expect(memo.light).toBeDefined()
    const fingerprint = memo.fingerprint

    let atomicWrites = 0
    const run = fixture.store.atomic.bind(fixture.store)
    fixture.store.atomic = ((fn: Parameters<typeof run>[0]) => {
      atomicWrites++
      return run(fn)
    }) as typeof fixture.store.atomic
    recorder.reconcileMessages(workerSession, structuredClone(messages))

    expect(fixture.store.progressFacts([firstAttemptID]).length).toBe(rows)
    expect(
      (
        recorder as unknown as { recoveryMemos: Map<string, { fingerprint: string }> }
      ).recoveryMemos.get(workerSession)!.fingerprint,
    ).toBe(fingerprint)
    expect(atomicWrites).toBeGreaterThan(0)
  } finally {
    fixture.close()
  }
})
