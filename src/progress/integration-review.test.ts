import { expect, test } from "bun:test"
import { makeFixture, firstAttemptID } from "../../test/trajectory/fixture.ts"
import { TaskRepository } from "../storage.ts"
import { RunnerStore } from "../runner/store.ts"
import { ProgressRecorder } from "./recorder.ts"
import { projectProgressFact } from "./projection.ts"

const sessionID = "ses-failed"

test("structured context, reasoning and full inputs are omitted at durable write and legacy read", () => {
  const f = makeFixture()
  try {
    const recorder = new ProgressRecorder(f.store, "project")
    const hidden = {
      messages: [
        { type: "assistant", content: [{ type: "reasoning", text: "PRIVATE_CONTEXT_CANARY" }] },
      ],
      nested: { state: { input: "FULL_INPUT_CANARY" } },
    }
    recorder.recordToolHook({
      tool: "example",
      sessionID,
      agent: "lazers-implementor",
      messageID: "msg_hook",
      callID: "call_hook",
      status: "completed",
      result: { content: [{ type: "text", text: "Public completion" }], output: hidden },
    })
    recorder.recordNativeEvent({
      id: "evt_tool",
      type: "session.tool.success",
      created: 10,
      data: {
        sessionID,
        id: "call_native",
        content: [{ type: "text", text: JSON.stringify(hidden) }],
      },
    })
    recorder.reconcileMessages(sessionID, [
      {
        id: "msg_recovered",
        type: "assistant",
        time: { created: 10 },
        content: [
          {
            type: "tool",
            id: "call_recovered",
            name: "example",
            state: {
              status: "completed",
              input: hidden,
              content: [{ type: "text", text: JSON.stringify(hidden) }],
              output: hidden,
            },
          },
        ],
      },
    ])
    const rows = f.store.progressFacts([firstAttemptID])
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain("PRIVATE_CONTEXT_CANARY")
    expect(serialized).not.toContain("FULL_INPUT_CANARY")
    expect(serialized).toContain("Public completion")
    const tool = rows.find((row) => row.call_id === "call_hook")!
    expect(JSON.parse(tool.payload).output).toBeUndefined()
    const legacy = {
      ...tool,
      payload: JSON.stringify({
        tool: "example",
        status: "succeeded",
        content: JSON.stringify(hidden),
        output: hidden,
        error: { type: "Error", message: "Public error", ...hidden },
      }),
    }
    const view = projectProgressFact(legacy)
    expect(view.output).toBeUndefined()
    expect(view.error).toEqual({ type: "Error", message: "Public error" })
    expect(JSON.stringify(view)).not.toContain("PRIVATE_CONTEXT_CANARY")
    expect(JSON.stringify(view)).not.toContain("FULL_INPUT_CANARY")
  } finally {
    f.close()
  }
})

test("older recovery cannot overwrite a newer cumulative payload while provenance merges", () => {
  const f = makeFixture()
  let reopened: TaskRepository | undefined
  try {
    const recorder = new ProgressRecorder(f.store, "project")
    recorder.recordNativeEvent({
      id: "evt_usage_new",
      type: "session.usage.updated",
      created: 5000,
      data: { sessionID, tokens: { input: 20, output: 8 }, cost: 0.75 },
    })
    recorder.recordSessionSnapshot(sessionID, {
      time: { updated: 4000 },
      tokens: { input: 10, output: 4 },
      cost: 0.5,
    })
    const row = f.store
      .progressFacts([firstAttemptID])
      .find((row) => row.kind === "usage-snapshot")!
    expect(row.at).toBe(5000)
    expect(JSON.parse(row.payload).usage).toMatchObject({ input: 20, output: 8, costUSD: 0.75 })
    expect(JSON.parse(row.sources_json)).toEqual(["native-event", "recovery"])
    const path = f.repository.path
    f.repository.close()
    reopened = new TaskRepository(path, f.directory)
    const store = new RunnerStore(reopened)
    const recovered = new ProgressRecorder(store, "project")
    recovered.recordSessionSnapshot(sessionID, {
      time: { updated: 4500 },
      tokens: { input: 15 },
      cost: 0.6,
    })
    const after = store
      .progressFacts([firstAttemptID])
      .filter((row) => row.kind === "usage-snapshot")
    expect(after).toHaveLength(1)
    expect(after[0]!.at).toBe(5000)
    expect(JSON.parse(after[0]!.payload).usage.costUSD).toBe(0.75)
    expect(projectProgressFact(after[0]!).additive).toBe(false)
  } finally {
    reopened?.close()
    f.close()
  }
})

test("native terminal and retained marker coalesce; session outcome snapshots are explicitly non-additive", () => {
  const f = makeFixture()
  let reopened: TaskRepository | undefined
  try {
    const recorder = new ProgressRecorder(f.store, "project")
    const terminal = {
      id: "evt_terminal1",
      type: "session.execution.interrupted",
      created: 6000,
      data: { sessionID },
    }
    recorder.recordNativeEvent(terminal)
    recorder.reconcileMessages(sessionID, [
      { id: "msg_terminal1", type: "idle", time: { created: 6000 }, outcome: "interrupted" },
    ])
    recorder.recordSessionOutcome(sessionID, {
      time: { idle: 6000, updated: 7000 },
      outcome: "interrupted",
    })
    recorder.recordSessionOutcome(sessionID, {
      time: { idle: 6000, updated: 9000 },
      outcome: "interrupted",
    })
    let rows = f.store.progressFacts([firstAttemptID])
    const outcomes = rows.filter((row) => row.kind === "execution-outcome")
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.message_id).toBe("msg_terminal1")
    expect(JSON.parse(outcomes[0]!.sources_json)).toEqual(["native-event", "recovery"])
    const snapshot = rows.find((row) => row.kind === "outcome-snapshot")!
    expect(snapshot.at).toBe(6000)
    expect(projectProgressFact(snapshot)).toMatchObject({
      additive: false,
      turnIdentity: "unavailable",
    })

    // Distinct terminal IDs can occur in one millisecond. Never merge by time alone.
    recorder.recordNativeEvent({ ...terminal, id: "evt_terminal2" })
    recorder.reconcileMessages(sessionID, [
      { id: "msg_terminal2", type: "idle", time: { created: 6000 }, outcome: "interrupted" },
    ])
    recorder.recordSessionOutcome(sessionID, {
      time: { idle: 6001, updated: 9000 },
      outcome: "interrupted",
    })
    rows = f.store.progressFacts([firstAttemptID])
    expect(rows.filter((row) => row.kind === "execution-outcome")).toHaveLength(2)
    expect(rows.filter((row) => row.kind === "outcome-snapshot")).toHaveLength(1)
    const path = f.repository.path
    f.repository.close()
    reopened = new TaskRepository(path, f.directory)
    const store = new RunnerStore(reopened)
    const recovered = new ProgressRecorder(store, "project")
    recovered.recordNativeEvent(terminal)
    recovered.recordSessionOutcome(sessionID, {
      time: { idle: 6001, updated: 10000 },
      outcome: "interrupted",
    })
    recovered.recordSessionOutcome(sessionID, {
      time: { idle: 6000, updated: 11000 },
      outcome: "failed",
    })
    const after = store.progressFacts([firstAttemptID])
    expect(after.filter((row) => row.kind === "execution-outcome")).toHaveLength(2)
    expect(after.filter((row) => row.kind === "outcome-snapshot")).toHaveLength(1)
    expect(after.find((row) => row.kind === "outcome-snapshot")!.at).toBe(6001)
    expect(JSON.parse(after.find((row) => row.kind === "outcome-snapshot")!.payload).outcome).toBe(
      "interrupted",
    )
  } finally {
    reopened?.close()
    f.close()
  }
})
