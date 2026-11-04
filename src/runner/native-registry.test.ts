import { expect, test } from "bun:test"
import { makeFixture } from "../../test/trajectory/fixture.ts"
import { TaskRepository } from "../storage.ts"

type NativeIdleModule = typeof import("./native-idle.ts")
type LocalLoader = {
  read(entrypoint: string): Promise<{ module: unknown }>
  dispose(): void
}

test("durable native idle evidence survives separate pinned local-loader generations", async () => {
  // Exercise the pinned host loader only in this integration test, never in plugin code.
  const source = (await import(
    new URL("./source.js", import.meta.resolve("@opencode/plugin/host")).href
  )) as { createPluginSources(watch: (file: string) => Promise<void>): LocalLoader }
  const first = source.createPluginSources(async () => {})
  const second = source.createPluginSources(async () => {})
  const entrypoint = new URL("./native-idle.ts", import.meta.url).href
  const fixture = makeFixture()
  const path = fixture.repository.path
  const projectDirectory = fixture.repository.projectDirectory
  let a: NativeIdleModule | undefined
  let b: NativeIdleModule | undefined
  let firstRepository: TaskRepository | undefined
  let secondRepository: TaskRepository | undefined
  try {
    a = (await first.read(entrypoint)).module as NativeIdleModule
    b = (await second.read(entrypoint)).module as NativeIdleModule
    expect(b).not.toBe(a)
    firstRepository = new TaskRepository(path, projectDirectory)
    secondRepository = new TaskRepository(path, projectDirectory)
    const firstStore = new a.NativeIdleStore(firstRepository)
    const secondStore = new b.NativeIdleStore(secondRepository)
    const binding = firstStore.assignmentForSession("ses-accepted")!
    const started = firstStore.observeEvent(binding, "session.execution.started", 40)
    expect(started.status).toBe("changed")
    const report = firstStore.recordIdle(
      binding,
      {
        observedAt: 123,
        inputID: binding.assignedMessageID,
        executionStartSequence: 40,
        eventSequence: 40,
        count: 0,
        kinds: { shell: 0, subagent: 0, image: 0 },
      },
      started.status === "changed" ? started.revision : -1,
    )
    expect(report).toBe(true)
    const success = firstStore.observeEvent(
      binding,
      "session.execution.succeeded",
      41,
      "evt_terminal",
      "msg_terminal",
    )
    expect(success.status).toBe("terminal-pending")
    expect(
      firstStore.confirmSuccess(
        binding,
        binding.assignedMessageID,
        { sequence: 41, eventID: "evt_terminal", messageID: "msg_terminal" },
        success.status === "terminal-pending" ? success.revision : -1,
      ),
    ).toBe(true)

    const stored = secondStore.read(binding)
    expect(stored?.report).toMatchObject({
      observedAt: 123,
      inputID: binding.assignedMessageID,
      executionStartSequence: 40,
      eventSequence: 40,
      count: 0,
    })
    expect(stored?.terminal).toEqual({
      sequence: 41,
      eventID: "evt_terminal",
      messageID: "msg_terminal",
    })
    expect(secondStore.background(binding, stored)).toMatchObject({
      state: "observed",
      observedAt: 123,
      inputID: binding.assignedMessageID,
      terminalSequence: 41,
      terminalEventID: "evt_terminal",
      terminalMessageID: "msg_terminal",
      attemptID: binding.attemptID,
      workspace: binding.workspace,
    })

    const stale = secondStore.observeEvent(binding, "session.execution.started", 39)
    expect(stale.status).toBe("stale")
    expect(firstStore.background(binding)).toMatchObject({
      state: "observed",
      terminalSequence: 41,
    })
    expect(firstStore.read(binding)?.revision).toBe(stored?.revision)

    expect(secondStore.observeEvent(binding, "session.execution.started", 42).status).toBe(
      "changed",
    )
    expect(firstStore.invalidate(binding, "late callback", stored?.revision)).toBe(false)
    expect(firstStore.background(binding)).toMatchObject({
      state: "unknown",
      reason: "A newer native foreground execution started after the last experimental.idle report",
    })
  } finally {
    firstRepository?.close()
    secondRepository?.close()
    first.dispose()
    second.dispose()
    fixture.close()
  }
})
