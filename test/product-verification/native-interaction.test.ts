import { describe, expect, test } from "bun:test"
import { dirname } from "node:path"
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
  verificationBase: dirname(root),
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
    {
      root,
      verificationBase: binding.verificationBase,
      servicePID: binding.service.process.pid,
      version: binding.service.version,
    },
    () => currentTime,
  )
  return { value, advance: (milliseconds: number) => (currentTime += milliseconds) }
}

const snapshotOperation: NativeOperation = { kind: "snapshot", window: windowRef }
const deliveredResult: NativeActionResult = { delivery: "delivered" }
const modifiedKeyOperation: NativeOperation = {
  kind: "key",
  window: windowRef,
  snapshotID: "snapshot-1",
  key: "Ctrl+T",
}

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
    expect(() =>
      value.attach({
        binding: { ...binding, verificationBase: "/Users/tjw/.local/state/opencode" },
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
    expect(value.result(binding, "bfc30312-7715-4a1a-a12f-2bb8e53f17c5")).toEqual({
      state: "unknown",
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
    expect(value.enqueue({ binding, requestID, operation: stale })).toEqual({ state: "completed" })
    expect(value.result(binding, requestID)).toMatchObject({
      state: "completed",
      result: { delivery: "not-delivered", message: expect.stringContaining("stale") },
    })
    expect(value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })).toBeNull()
    const unfocused: NativeOperation = {
      kind: "key",
      window: { ...windowRef, focused: false },
      snapshotID: "snapshot-1",
      key: "Enter",
    }
    const unfocusedID = "9fc30312-7715-4a1a-a12f-2bb8e53f17c3"
    value.attach({ binding, adapterID: "adapter-1", windows: [{ ...windowRef, focused: false }] })
    expect(value.enqueue({ binding, requestID: unfocusedID, operation: unfocused })).toEqual({
      state: "completed",
    })
    expect(value.result(binding, unfocusedID)).toMatchObject({
      state: "completed",
      result: { delivery: "not-delivered", message: expect.stringContaining("Focus the owned") },
    })
    expect(value.enqueue({ binding, requestID: unfocusedID, operation: unfocused })).toEqual({
      state: "existing",
    })
    expect(
      value.enqueue({
        binding,
        requestID: "afc30312-7715-4a1a-a12f-2bb8e53f17c4",
        operation: { kind: "focus", window: unfocused.window },
      }),
    ).toEqual({ state: "queued" })
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

  test("refuses modified shortcuts from a legacy adapter without delivering them", () => {
    const { value } = broker()
    value.attach({ binding, adapterID: "legacy-adapter", windows: [windowRef] })
    expect(value.status(binding)).toMatchObject({
      ready: true,
      capabilities: { modifiedKeys: false },
    })
    const requestID = "afc30312-7715-4a1a-a12f-2bb8e53f17c4"
    expect(value.enqueue({ binding, requestID, operation: modifiedKeyOperation })).toEqual({
      state: "completed",
    })
    expect(value.poll({ binding, adapterID: "legacy-adapter", windows: [windowRef] })).toBeNull()
    expect(value.result(binding, requestID)).toMatchObject({
      state: "completed",
      result: {
        delivery: "not-delivered",
        message: expect.stringContaining("does not support modified key"),
      },
    })
    expect(value.status(binding).blocked).toBe(false)
  })

  test("rechecks modified-key capability at dispatch after admission", () => {
    const { value } = broker()
    value.attach({
      binding,
      adapterID: "adapter-1",
      windows: [windowRef],
      capabilities: { modifiedKeys: true },
    })
    const requestID = "bfc30312-7715-4a1a-a12f-2bb8e53f17c5"
    expect(value.enqueue({ binding, requestID, operation: modifiedKeyOperation })).toEqual({
      state: "queued",
    })

    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    expect(value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })).toBeNull()
    expect(value.result(binding, requestID)).toMatchObject({
      state: "completed",
      result: {
        delivery: "not-delivered",
        message: expect.stringContaining("does not support modified key"),
      },
    })
    expect(value.status(binding).blocked).toBe(false)
  })

  test("binds clean-clip dictation completion to the armed session, clip, and window generation", () => {
    const { value } = broker()
    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    const requestID = "afc30312-7715-4a1a-a12f-2bb8e53f17c4"
    const operation: NativeOperation = {
      kind: "dictation-fixture",
      window: windowRef,
      sessionID: "owned-session",
      fixtureID: "quick-brown-fox",
    }
    expect(value.enqueue({ binding, requestID, operation })).toEqual({ state: "queued" })
    value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })
    value.complete({ binding, adapterID: "adapter-1", requestID, result: deliveredResult })

    expect(() =>
      value.observeAudio({
        binding,
        adapterID: "adapter-1",
        observation: {
          requestID,
          sessionID: "other-session",
          window: windowRef,
          event: { kind: "dictation-start", fixtureID: "quick-brown-fox", route: "runntime" },
        },
      }),
    ).toThrow("unknown or stale")
    expect(() =>
      value.observeAudio({
        binding,
        adapterID: "adapter-old",
        observation: {
          requestID,
          sessionID: "owned-session",
          window: windowRef,
          event: { kind: "dictation-start", fixtureID: "quick-brown-fox", route: "runntime" },
        },
      }),
    ).toThrow("stale")
    expect(() =>
      value.observeAudio({
        binding,
        adapterID: "adapter-1",
        observation: {
          requestID,
          sessionID: "owned-session",
          window: { ...windowRef, generation: windowRef.generation + 1 },
          event: { kind: "dictation-start", fixtureID: "quick-brown-fox", route: "runntime" },
        },
      }),
    ).toThrow("unknown or stale")
    expect(() =>
      value.observeAudio({
        binding,
        adapterID: "adapter-1",
        observation: {
          requestID,
          sessionID: "owned-session",
          window: windowRef,
          event: {
            kind: "dictation-start",
            fixtureID: "turn-left-next-street",
            route: "runntime",
          },
        },
      }),
    ).toThrow("does not match")

    value.observeAudio({
      binding,
      adapterID: "adapter-1",
      observation: {
        requestID,
        sessionID: "owned-session",
        window: windowRef,
        event: { kind: "dictation-start", fixtureID: "quick-brown-fox", route: "runntime" },
      },
    })
    value.observeAudio({
      binding,
      adapterID: "adapter-1",
      observation: {
        requestID,
        sessionID: "owned-session",
        window: windowRef,
        event: {
          kind: "dictation-complete",
          fixtureID: "quick-brown-fox",
          matchesExpected: true,
          insertedExactlyOnce: true,
          insertionCalls: 2,
          insertedChars: 45,
          submitted: false,
        },
      },
    })
    expect(value.audioResult(binding, requestID)).toMatchObject({
      kind: "dictation",
      fixtureID: "quick-brown-fox",
      sessionID: "owned-session",
      appCompleted: true,
      events: [{ event: { kind: "dictation-start" } }, { event: { kind: "dictation-complete" } }],
    })
  })

  test("records real playback starts and natural ends separately from intelligibility", () => {
    const { value } = broker()
    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    const requestID = "bfc30312-7715-4a1a-a12f-2bb8e53f17c5"
    const expectedTextHash = "a".repeat(64)
    const textHash = "b".repeat(64)
    const operation: NativeOperation = {
      kind: "playback-plan",
      window: windowRef,
      sessionID: "owned-session",
      expectedTextHash,
      segmentHashes: [textHash],
    }
    value.enqueue({ binding, requestID, operation })
    value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })
    value.complete({ binding, adapterID: "adapter-1", requestID, result: deliveredResult })
    const send = (event: Parameters<typeof value.observeAudio>[0]["observation"]["event"]) =>
      value.observeAudio({
        binding,
        adapterID: "adapter-1",
        observation: { requestID, sessionID: "owned-session", window: windowRef, event },
      })

    expect(() => send({ kind: "playback-complete" })).toThrow("before every expected")
    send({
      kind: "playback-start",
      route: "runntime",
      expectedTextHash,
      segmentHashes: [textHash],
    })
    const segment = {
      segmentIndex: 0,
      textHash,
      sampleRate: 24_000 as const,
      frames: 4_800,
      durationMs: 200,
    }
    send({ kind: "playback-segment-start", ...segment })
    expect(() => send({ kind: "playback-segment-end", ...segment, frames: 4_799 })).toThrow(
      "did not end naturally",
    )
    send({ kind: "playback-segment-end", ...segment })
    send({ kind: "playback-complete" })
    expect(value.audioResult(binding, requestID)).toMatchObject({
      kind: "playback",
      appCompleted: true,
    })
    send({ kind: "intelligibility", value: "unknown" })
    expect(value.audioResult(binding, requestID)).toMatchObject({
      appCompleted: true,
      intelligibility: "unknown",
    })
    expect(() => send({ kind: "playback-failed" })).toThrow("unknown or stale")
  })

  test("cancellation and route mismatch produce terminal but unsuccessful audio receipts", () => {
    const { value } = broker()
    value.attach({ binding, adapterID: "adapter-1", windows: [windowRef] })
    const requestID = "cfc30312-7715-4a1a-a12f-2bb8e53f17c6"
    const fixtureOperation: NativeOperation = {
      kind: "dictation-fixture",
      window: windowRef,
      sessionID: "owned-session",
      fixtureID: "turn-left-next-street",
    }
    value.enqueue({ binding, requestID, operation: fixtureOperation })
    value.poll({ binding, adapterID: "adapter-1", windows: [windowRef] })
    value.complete({ binding, adapterID: "adapter-1", requestID, result: deliveredResult })
    value.observeAudio({
      binding,
      adapterID: "adapter-1",
      observation: {
        requestID,
        sessionID: "owned-session",
        window: windowRef,
        event: { kind: "dictation-failed", fixtureID: "turn-left-next-street" },
      },
    })
    expect(value.audioResult(binding, requestID)).toMatchObject({
      kind: "dictation",
      appCompleted: false,
      events: [{ event: { kind: "dictation-failed" } }],
    })
  })
})
