import { describe, expect, test } from "bun:test"
import { NativeInteractionBroker } from "../../src/verification/opencode/native-interaction-server.ts"
import type {
  NativeActionResult,
  NativeBinding,
  NativeOperation,
  NativeWindowReference,
} from "../../src/verification/opencode/native-interaction-contract.ts"

const root = "/private/tmp/lazers-full-instance-native-test"
const candidatePath = "/workspace/candidate"
const windowRef: NativeWindowReference = {
  windowID: 12,
  webContentsID: 42,
  rendererPID: 30001,
  generation: 3,
  visible: true,
  focused: true,
}
const binding: NativeBinding = {
  ownerID: "owner-12",
  createdAt: "2026-11-01T12:00:00.000Z",
  root,
  candidate: {
    workspace: candidatePath,
    revision: "a".repeat(40),
    dirtyPaths: ["src/gui.tsx"],
    pluginEntry: `${candidatePath}/src/index.ts`,
    guiEntry: `${candidatePath}/dist/gui-experimental.cjs`,
    guiEntryBytes: 1234,
    guiEntryModifiedAt: "2026-11-01T12:00:00.000Z",
    architectDescription: "Defines scoped tasks and acceptance evidence",
  },
  target: {
    desktopBundle: "/Applications/OpenCode.app",
    bundleID: "ai.opencode.desktop",
    version: "2.2.5",
    cliPath: "/Applications/OpenCode.app/Contents/Resources/opencode-cli",
    cliVersion: "2.2.5",
    workspace: candidatePath,
    effectiveStateHome: `${root}/state`,
    serviceRegistrationPath: `${root}/state/opencode/service.json`,
  },
  service: {
    process: {
      pid: 24001,
      startedAt: "Sun Nov  1 12:00:00 2026",
      command: "/owned/opencode-cli serve --service --port 52123",
    },
    id: "owned-service",
    version: "2.2.5",
    url: "http://127.0.0.1:52123",
  },
  desktop: {
    pid: 24002,
    startedAt: "Sun Nov  1 12:01:00 2026",
    command: "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
  },
}

function broker(now = 1_000) {
  let currentTime = now
  const value = new NativeInteractionBroker(
    { root, servicePID: binding.service.process.pid, version: binding.service.version },
    () => currentTime,
  )
  return { value, advance: (milliseconds: number) => (currentTime += milliseconds) }
}

const snapshotOperation: NativeOperation = { kind: "snapshot", window: windowRef }
const deliveredResult: NativeActionResult = { delivery: "delivered" }

describe("owned native interaction broker", () => {
  test("requires the exact owned service, root, version and adapter generation", () => {
    const { value } = broker()
    expect(() =>
      value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] }),
    ).not.toThrow()
    expect(() =>
      value.attach({
        binding: { ...binding, root: "/Users/tjw/.local/state/opencode" },
        adapterID: "adapter-2",
        windows: [windowRef],
      }),
    ).toThrow("does not match the owned sidecar")
    expect(() =>
      value.attach({
        binding: {
          ...binding,
          target: { ...binding.target, effectiveStateHome: "/Users/tjw/.local/state/opencode" },
        },
        adapterID: "adapter-1",
        windows: [windowRef],
      }),
    ).toThrow("does not match the owned sidecar")
    expect(() =>
      value.attach({
        binding: {
          ...binding,
          desktop: {
            ...binding.desktop,
            command: "/Applications/Other.app/Contents/MacOS/OpenCode",
          },
        },
        adapterID: "adapter-1",
        windows: [windowRef],
      }),
    ).toThrow("does not match the owned sidecar")
    expect(() => value.attach({ binding, adapterID: "adapter-2", windows: [windowRef] })).toThrow(
      "different native adapter generation",
    )
  })

  test("delivers each request at most once and returns the completed observation by ID", () => {
    const { value } = broker()
    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    const requestID = "8fc30312-7715-4a1a-a12f-2bb8e53f17c2"
    expect(value.enqueue({ binding, requestID, operation: snapshotOperation })).toEqual({
      state: "queued",
    })
    expect(value.enqueue({ binding, requestID, operation: snapshotOperation })).toEqual({
      state: "existing",
    })
    expect(value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })).toEqual({
      requestID,
      operation: snapshotOperation,
    })
    expect(value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })).toBeNull()
    value.complete({ binding, adapterID: "adapter-1", requestID, result: deliveredResult })
    expect(value.result(binding, requestID)).toEqual({
      state: "completed",
      result: deliveredResult,
    })
    expect(() =>
      value.enqueue({
        binding,
        requestID,
        operation: { kind: "capture", window: windowRef },
      }),
    ).toThrow("already used for a different operation")
  })

  test("rejects stale window generations, hidden targets and unfocused native input", () => {
    const { value } = broker()
    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    const requestID = "8fc30312-7715-4a1a-a12f-2bb8e53f17c2"
    const stale: NativeOperation = {
      kind: "click",
      window: { ...windowRef, generation: windowRef.generation - 1 },
      snapshotID: "snapshot-1",
      elementRef: "e1",
    }
    expect(() => value.enqueue({ binding, requestID, operation: stale })).toThrow("stale")
    const unfocused: NativeOperation = {
      kind: "key",
      window: { ...windowRef, focused: false },
      snapshotID: "snapshot-1",
      key: "Enter",
    }
    expect(() => value.enqueue({ binding, requestID, operation: unfocused })).toThrow("stale")
    value.attach({ binding, adapterID: "adapter-1", windows: [{ ...windowRef, focused: false }] })
    expect(() => value.enqueue({ binding, requestID, operation: unfocused })).toThrow(
      "Focus the owned",
    )
  })

  test("fails closed on ambiguous delivery and stale completion", () => {
    const { value } = broker()
    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    const requestID = "8fc30312-7715-4a1a-a12f-2bb8e53f17c2"
    value.enqueue({ binding, requestID, operation: snapshotOperation })
    value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })
    expect(() =>
      value.complete({
        binding,
        adapterID: "adapter-old",
        requestID,
        result: deliveredResult,
      }),
    ).toThrow("stale adapter")
    value.complete({
      binding,
      adapterID: "adapter-1",
      requestID,
      result: { delivery: "ambiguous", message: "Fresh observation was unavailable" },
    })
    expect(value.status(binding).blocked).toBe(true)
    expect(() =>
      value.enqueue({
        binding,
        requestID: "9fc30312-7715-4a1a-a12f-2bb8e53f17c3",
        operation: snapshotOperation,
      }),
    ).toThrow("ambiguous native action")
  })

  test("turns a delivered request into an ambiguous result when the adapter detaches", () => {
    const { value } = broker()
    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    const requestID = "8fc30312-7715-4a1a-a12f-2bb8e53f17c2"
    value.enqueue({ binding, requestID, operation: snapshotOperation })
    value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })
    value.detach(binding, "adapter-1")
    expect(value.result(binding, requestID)).toEqual({
      state: "completed",
      result: { delivery: "ambiguous", message: "Desktop adapter stopped after dispatch" },
    })
    expect(value.status(binding).ready).toBe(false)
  })

  test("expires stale adapter heartbeats rather than dispatching to a dead window", () => {
    const { value, advance } = broker()
    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    advance(2_001)
    expect(value.status(binding).ready).toBe(false)
    expect(() =>
      value.enqueue({
        binding,
        requestID: "8fc30312-7715-4a1a-a12f-2bb8e53f17c2",
        operation: snapshotOperation,
      }),
    ).toThrow("not freshly attached")
  })
})
