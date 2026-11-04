import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { TaskRepository } from "../storage.ts"
import { NativeIdleStore } from "./native-idle.ts"
import type { NativeIdleBinding } from "./native-idle.ts"
import { makeFixture } from "../../test/trajectory/fixture.ts"

function confirmZero(store: NativeIdleStore, binding: NativeIdleBinding) {
  const started = store.observeEvent(binding, "session.execution.started", 10)
  if (started.status !== "changed") throw new Error("Expected a new execution start")
  expect(
    store.recordIdle(
      binding,
      {
        observedAt: 123,
        inputID: binding.assignedMessageID,
        executionStartSequence: 10,
        eventSequence: 10,
        count: 0,
        kinds: { shell: 0, subagent: 0, image: 0 },
      },
      started.revision,
    ),
  ).toBe(true)
  const success = store.observeEvent(
    binding,
    "session.execution.succeeded",
    11,
    "evt_terminal",
    "msg_terminal",
  )
  if (success.status !== "terminal-pending") throw new Error("Expected a pending terminal")
  expect(
    store.confirmSuccess(
      binding,
      binding.assignedMessageID,
      { sequence: 11, eventID: "evt_terminal", messageID: "msg_terminal" },
      success.revision,
    ),
  ).toBe(true)
}

test("zero background is unknown until exact terminal success and a newer execution invalidates it", () => {
  const fixture = makeFixture()
  const repository = fixture.repository
  const store = new NativeIdleStore(repository)
  const binding = store.assignmentForSession("ses-accepted")!
  try {
    expect(store.background(binding)).toMatchObject({ state: "unknown" })
    const started = store.observeEvent(binding, "session.execution.started", 10)
    expect(started.status).toBe("changed")
    expect(
      store.recordIdle(
        binding,
        {
          observedAt: 123,
          inputID: binding.assignedMessageID,
          executionStartSequence: 10,
          eventSequence: 10,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        started.status === "changed" ? started.revision : -1,
      ),
    ).toBe(true)
    expect(store.background(binding)).toMatchObject({
      state: "unknown",
      reason: "Zero-background idle report has no matching confirmed native success",
    })

    const success = store.observeEvent(
      binding,
      "session.execution.succeeded",
      11,
      "evt_terminal",
      "msg_terminal",
    )
    expect(success.status).toBe("terminal-pending")
    expect(
      store.confirmSuccess(
        binding,
        binding.assignedMessageID,
        { sequence: 11, eventID: "evt_terminal", messageID: "msg_terminal" },
        success.status === "terminal-pending" ? success.revision : -1,
      ),
    ).toBe(true)
    expect(store.background(binding)).toMatchObject({
      state: "observed",
      inputID: binding.assignedMessageID,
      observedAt: 123,
      terminalSequence: 11,
      terminalEventID: "evt_terminal",
      terminalMessageID: "msg_terminal",
    })

    expect(store.observeEvent(binding, "session.execution.started", 9).status).toBe("stale")
    expect(store.background(binding)).toMatchObject({ state: "observed", terminalSequence: 11 })
    expect(store.observeEvent(binding, "session.execution.started", 12).status).toBe("changed")
    expect(store.background(binding)).toMatchObject({
      state: "unknown",
      reason: "A newer native foreground execution started after the last experimental.idle report",
    })
  } finally {
    fixture.close()
  }
})

test("positive native background survives store reopen even when external shell inventory may be empty", () => {
  const fixture = makeFixture()
  const repository = fixture.repository
  const path = repository.path
  const store = new NativeIdleStore(repository)
  const binding = store.assignmentForSession("ses-accepted")!
  let reopened: TaskRepository | undefined
  try {
    const started = store.observeEvent(binding, "session.execution.started", 20)
    if (started.status !== "changed") throw new Error("Expected a new execution start")
    expect(
      store.recordIdle(
        binding,
        {
          observedAt: 456,
          inputID: binding.assignedMessageID,
          executionStartSequence: 20,
          eventSequence: 20,
          count: 1,
          kinds: { shell: 1, subagent: 0, image: 0 },
        },
        started.revision,
      ),
    ).toBe(true)
    expect(store.background(binding)).toMatchObject({
      state: "observed",
      count: 1,
      kinds: { shell: 1, subagent: 0, image: 0 },
      workspace: binding.workspace,
    })
    repository.close()
    reopened = new TaskRepository(path, binding.projectDirectory)
    expect(new NativeIdleStore(reopened).background(binding)).toMatchObject({
      state: "observed",
      count: 1,
      kinds: { shell: 1, subagent: 0, image: 0 },
    })
  } finally {
    reopened?.close()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test("late idle callbacks are revision-fenced and corrupt persisted evidence fails closed", () => {
  const fixture = makeFixture()
  const repository = fixture.repository
  const store = new NativeIdleStore(repository)
  const binding = store.assignmentForSession("ses-accepted")!
  try {
    const started = store.observeEvent(binding, "session.execution.started", 30)
    if (started.status !== "changed") throw new Error("Expected a new execution start")
    const staleRevision = started.revision
    expect(store.observeEvent(binding, "session.execution.started", 31).status).toBe("changed")
    expect(
      store.recordIdle(
        binding,
        {
          observedAt: 500,
          inputID: binding.assignedMessageID,
          executionStartSequence: 30,
          eventSequence: 30,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        staleRevision,
      ),
    ).toBe(false)
    expect(store.background(binding)).toMatchObject({ state: "unknown" })

    repository.atomic((db) =>
      db
        .query("UPDATE runner_native_idle SET body='not-json' WHERE session_id=?")
        .run(binding.sessionID),
    )
    expect(() => store.read(binding)).toThrow("Native idle persistence is corrupt")
    expect(() => store.background(binding)).toThrow("Native idle persistence is corrupt")
  } finally {
    fixture.close()
  }
})

test("confirmed zero-background identity survives SQLite reopen in a separate Bun process", () => {
  const fixture = makeFixture()
  const repository = fixture.repository
  const path = repository.path
  const binding = new NativeIdleStore(repository).assignmentForSession("ses-accepted")!
  try {
    confirmZero(new NativeIdleStore(repository), binding)
  } finally {
    repository.close()
  }

  const storageURL = new URL("../storage.ts", import.meta.url).href
  const idleURL = new URL("./native-idle.ts", import.meta.url).href
  const script = `
    import { TaskRepository } from ${JSON.stringify(storageURL)}
    import { NativeIdleStore } from ${JSON.stringify(idleURL)}
    const repository = new TaskRepository(process.env.LAZERS_DB, process.env.LAZERS_PROJECT)
    const store = new NativeIdleStore(repository)
    const binding = JSON.parse(process.env.LAZERS_BINDING)
    const background = store.background(binding)
    console.log(JSON.stringify(background))
    repository.close()
  `
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      LAZERS_DB: path,
      LAZERS_PROJECT: binding.projectDirectory,
      LAZERS_BINDING: JSON.stringify(binding),
    },
  })
  try {
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      state: "observed",
      count: 0,
      inputID: binding.assignedMessageID,
      projectID: binding.projectID,
      attemptID: binding.attemptID,
      sessionID: binding.sessionID,
      workspace: binding.workspace,
      assignedMessageID: binding.assignedMessageID,
      observedAt: 123,
      terminalEventID: "evt_terminal",
      terminalMessageID: "msg_terminal",
      terminalSequence: 11,
    })
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test("same-attempt input reassignment invalidates old zero, accepts a fresh turn, and fences old callbacks", () => {
  const fixture = makeFixture()
  const repository = fixture.repository
  const store = new NativeIdleStore(repository)
  const originalBinding = store.assignmentForSession("ses-accepted")!
  try {
    confirmZero(store, originalBinding)
    expect(store.background(originalBinding)).toMatchObject({ state: "observed", count: 0 })

    const assignedMessageID = "msg_resumed_owned"
    repository.atomic((db) =>
      db
        .query("UPDATE runner_attempts SET message_id=? WHERE id=?")
        .run(assignedMessageID, originalBinding.attemptID),
    )
    const currentBinding = store.assignmentForSession("ses-accepted")!
    expect(currentBinding).toMatchObject({
      ...originalBinding,
      assignedMessageID,
    })
    expect(store.background(currentBinding)).toMatchObject({
      state: "unknown",
      reason: "Assigned native worker input changed; previous idle evidence is stale",
    })

    const start = store.observeEvent(currentBinding, "session.execution.started", 12)
    expect(start.status).toBe("changed")
    expect(
      store.recordIdle(
        currentBinding,
        {
          observedAt: 456,
          inputID: assignedMessageID,
          executionStartSequence: 12,
          eventSequence: 12,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        start.status === "changed" ? start.revision : -1,
      ),
    ).toBe(true)
    const terminal = store.observeEvent(
      currentBinding,
      "session.execution.succeeded",
      13,
      "evt_resumed",
      "msg_resumed",
    )
    expect(terminal.status).toBe("terminal-pending")
    expect(
      store.confirmSuccess(
        currentBinding,
        assignedMessageID,
        { sequence: 13, eventID: "evt_resumed", messageID: "msg_resumed" },
        terminal.status === "terminal-pending" ? terminal.revision : -1,
      ),
    ).toBe(true)
    expect(store.background(currentBinding)).toMatchObject({
      state: "observed",
      inputID: assignedMessageID,
      terminalSequence: 13,
      attemptID: originalBinding.attemptID,
      workspace: originalBinding.workspace,
    })
    const confirmed = store.read(currentBinding)!
    expect(
      store.recordIdle(
        currentBinding,
        {
          observedAt: 999,
          inputID: assignedMessageID,
          executionStartSequence: 12,
          eventSequence: 13,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        confirmed.revision,
      ),
    ).toBe(false)

    expect(() =>
      store.recordIdle(
        originalBinding,
        {
          observedAt: 999,
          inputID: originalBinding.assignedMessageID,
          executionStartSequence: 10,
          eventSequence: 10,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        1,
      ),
    ).toThrow("Native idle binding is stale")
    expect(store.background(currentBinding)).toMatchObject({
      state: "observed",
      inputID: assignedMessageID,
      terminalSequence: 13,
    })
  } finally {
    fixture.close()
  }
})

test("a duplicate start cannot carry execution lineage across assigned-input changes", () => {
  const fixture = makeFixture()
  const store = new NativeIdleStore(fixture.repository)
  const originalBinding = store.assignmentForSession("ses-accepted")!
  try {
    const started = store.observeEvent(originalBinding, "session.execution.started", 20)
    expect(started.status).toBe("changed")

    const nextInputID = "msg_reassigned_input"
    fixture.repository.atomic((db) =>
      db
        .query("UPDATE runner_attempts SET message_id=? WHERE id=?")
        .run(nextInputID, originalBinding.attemptID),
    )
    const currentBinding = store.assignmentForSession("ses-accepted")!
    expect(currentBinding.assignedMessageID).toBe(nextInputID)
    expect(store.observeEvent(currentBinding, "session.execution.started", 20).status).toBe("seen")
    expect(store.read(currentBinding)).toMatchObject({
      binding: currentBinding,
      lastEventSequence: 20,
      executionStartSequence: null,
      invalidation: {
        reason: "Assigned native worker input changed; previous idle evidence is stale",
      },
    })
    expect(store.background(currentBinding)).toMatchObject({ state: "unknown" })
    expect(
      store.recordIdle(
        currentBinding,
        {
          observedAt: 456,
          inputID: nextInputID,
          executionStartSequence: 20,
          eventSequence: 20,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        store.read(currentBinding)!.revision,
      ),
    ).toBe(false)
  } finally {
    fixture.close()
  }
})

test("fresh idle hook after delivered input can replace an invalidated report in the same execution", () => {
  const fixture = makeFixture()
  const store = new NativeIdleStore(fixture.repository)
  const binding = store.assignmentForSession("ses-accepted")!
  try {
    const start = store.observeEvent(binding, "session.execution.started", 20)
    expect(start.status).toBe("changed")
    expect(
      store.recordIdle(
        binding,
        {
          observedAt: 100,
          inputID: binding.assignedMessageID,
          executionStartSequence: 20,
          eventSequence: 20,
          count: 1,
          kinds: { shell: 1, subagent: 0, image: 0 },
        },
        start.status === "changed" ? start.revision : -1,
      ),
    ).toBe(true)
    const delivered = store.observeEvent(binding, "session.inbox.delivered", 21)
    expect(delivered.status).toBe("changed")
    if (delivered.status !== "changed") throw new Error("Expected delivered input invalidation")
    expect(store.background(binding)).toMatchObject({ state: "unknown" })
    expect(
      store.recordIdle(
        binding,
        {
          observedAt: 200,
          inputID: binding.assignedMessageID,
          executionStartSequence: 20,
          eventSequence: 21,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        delivered.revision,
      ),
    ).toBe(true)
    expect(store.read(binding)?.report).toMatchObject({
      inputID: binding.assignedMessageID,
      executionStartSequence: 20,
      eventSequence: 21,
      observedAt: 200,
      count: 0,
    })
  } finally {
    fixture.close()
  }
})

test("an invalidly ordered input event destroys execution lineage instead of reviving stale reports", () => {
  const fixture = makeFixture()
  const store = new NativeIdleStore(fixture.repository)
  const binding = store.assignmentForSession("ses-accepted")!
  try {
    const start = store.observeEvent(binding, "session.execution.started", 30)
    expect(start.status).toBe("changed")
    const unsequenced = store.observeEvent(binding, "session.synthetic", undefined)
    expect(unsequenced.status).toBe("changed")
    const state = store.read(binding)
    expect(state).toMatchObject({
      executionStartSequence: null,
      invalidation: {
        reason: "Native session.synthetic had no trustworthy durable session sequence",
      },
    })
    expect(
      store.recordIdle(
        binding,
        {
          observedAt: 300,
          inputID: binding.assignedMessageID,
          executionStartSequence: 30,
          eventSequence: 30,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        unsequenced.status === "changed" ? unsequenced.revision : -1,
      ),
    ).toBe(false)
    expect(store.background(binding)).toMatchObject({ state: "unknown" })
  } finally {
    fixture.close()
  }
})

test("benign stale-event diagnostics do not strand pending success but newer activity still rejects", () => {
  const fixture = makeFixture()
  const repository = fixture.repository
  const store = new NativeIdleStore(repository)
  const binding = store.assignmentForSession("ses-accepted")!
  try {
    const start = store.observeEvent(binding, "session.execution.started", 10)
    expect(start.status).toBe("changed")
    expect(
      store.recordIdle(
        binding,
        {
          observedAt: 123,
          inputID: binding.assignedMessageID,
          executionStartSequence: 10,
          eventSequence: 10,
          count: 0,
          kinds: { shell: 0, subagent: 0, image: 0 },
        },
        start.status === "changed" ? start.revision : -1,
      ),
    ).toBe(true)
    const pending = store.observeEvent(
      binding,
      "session.execution.succeeded",
      20,
      "evt_terminal",
      "msg_terminal",
    )
    expect(pending.status).toBe("terminal-pending")
    const secondStore = new NativeIdleStore(repository)
    expect(secondStore.observeEvent(binding, "session.execution.started", 5).status).toBe("stale")
    expect(store.read(binding)?.revision).toBe(pending.revision)
    expect(
      store.confirmSuccess(
        binding,
        binding.assignedMessageID,
        { sequence: 20, eventID: "evt_terminal", messageID: "msg_terminal" },
        pending.status === "terminal-pending" ? pending.revision : -1,
      ),
    ).toBe(true)
    expect(store.background(binding)).toMatchObject({ state: "observed", terminalSequence: 20 })

    expect(store.observeEvent(binding, "session.execution.started", 21).status).toBe("changed")
    expect(store.background(binding)).toMatchObject({
      state: "unknown",
      reason: "A newer native foreground execution started after the last experimental.idle report",
    })
  } finally {
    fixture.close()
  }
})
