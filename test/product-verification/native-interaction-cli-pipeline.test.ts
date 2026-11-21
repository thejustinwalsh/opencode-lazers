import { describe, expect, spyOn, test } from "bun:test"
import type { MainContext } from "@opencode/plugin/gui/main"
import { NativeInteractionBroker } from "../../src/verification/opencode/native-interaction-server.ts"
import {
  NativeInteractionMainAdapter,
  type NativeInputEvent,
  type NativeWebContents,
  type NativeWindow,
} from "../../src/verification/opencode/native-interaction-main.ts"
import {
  NativeInteraction,
  type NativeActionResult,
  type NativeBinding,
  type NativeOperation,
} from "../../src/verification/opencode/native-interaction-contract.ts"
import { main as verificationCLI } from "../../src/verification/opencode/cli.ts"
import type { NativeInteractionCliDependencies } from "../../src/verification/opencode/native-interaction-cli.ts"
import type { OwnedLaunchManifest } from "../../src/verification/opencode/owned-launch.ts"
import type {
  AudioFixtureDelivery,
  FrozenAudioFixtureID,
} from "../../src/verification/opencode/audio-fixture-contract.ts"

const root = "/private/tmp/lazers-native-interaction-cli-pipeline"
const candidatePath = "/workspace/candidate"
const port = 52123
const registration = {
  id: "owned-service",
  version: "2.2.5",
  url: `http://127.0.0.1:${port}`,
  pid: 24_001,
  password: "test-only-password",
}
const manifest: OwnedLaunchManifest = {
  schemaVersion: 1,
  ownerID: "owner-12",
  status: "ready",
  createdAt: "2026-11-01T12:00:00.000Z",
  root,
  baseDirectory: "/private/tmp",
  candidate: {
    workspace: candidatePath,
    revision: "a".repeat(40),
    dirtyPaths: ["src/index.ts"],
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
  protocolHandlerBaseline: null,
  service: {
    process: {
      pid: registration.pid,
      startedAt: "Sun Nov  1 12:00:00 2026",
      command: `/owned/opencode-cli serve --service --port ${port}`,
    },
    id: registration.id,
    version: registration.version,
    url: registration.url,
  },
  desktop: {
    pid: 24_002,
    startedAt: "Sun Nov  1 12:01:00 2026",
    command: "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
  },
  observations: [],
}
const binding: NativeBinding = {
  ownerID: manifest.ownerID,
  createdAt: manifest.createdAt,
  root: manifest.root,
  verificationBase: manifest.baseDirectory!,
  candidate: manifest.candidate,
  target: manifest.target,
  service: manifest.service!,
  desktop: manifest.desktop!,
}
const proof = {
  manifest,
  registration,
  health: { pid: registration.pid, version: registration.version },
} as unknown as Awaited<ReturnType<NativeInteractionCliDependencies["verifyOwnedLaunch"]>>

const rawSnapshot = {
  title: "Owned qualification fixture",
  text: "Disposable no-secret fixture",
  elements: [],
  truncated: false,
}

type PipelineOptions = {
  legacyAdapter?: boolean
  legacyStatus?: boolean
  failKeyUp?: boolean
  loseEnqueueReply?: boolean
  mismatchAdmissionRefusal?: boolean
  loadFixture?: (
    verificationBase: string,
    fixtureID: FrozenAudioFixtureID,
  ) => Promise<AudioFixtureDelivery>
}

async function pipeline(options: PipelineOptions = {}) {
  const events: NativeInputEvent[] = []
  const insertedText: string[] = []
  let rendererPID = 30_001
  const windowListeners = new Map<string, (...args: unknown[]) => void>()
  const contentsListeners = new Map<string, (...args: unknown[]) => void>()
  let focused = true
  const webContents: NativeWebContents = {
    id: 42,
    isDestroyed: () => false,
    getOSProcessId: () => rendererPID,
    getURL: () => "oc://renderer/index.html",
    executeJavaScript: async () => rawSnapshot,
    capturePage: async () => ({ toPNG: () => Buffer.from("png-fixture") }),
    sendInputEvent: (event) => {
      if (options.failKeyUp && event.type === "keyUp") throw new Error("fixture key-up failure")
      events.push(event)
    },
    insertText: (text) => insertedText.push(text),
    on: (name, listener) => contentsListeners.set(name, listener),
    removeListener: (name) => contentsListeners.delete(name),
  }
  const window: NativeWindow = {
    id: 12,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => focused,
    show: () => undefined,
    focus: () => {
      focused = true
    },
    webContents,
    on: (name, listener) => windowListeners.set(name, listener),
    removeListener: (name) => windowListeners.delete(name),
  }

  let brokerTime = Date.now()
  const broker = new NativeInteractionBroker(
    {
      root,
      verificationBase: manifest.baseDirectory!,
      servicePID: registration.pid,
      version: registration.version,
    },
    () => brokerTime,
  )
  let attachCount = 0
  let completeCount = 0
  let rejectHeartbeatAttachments = false
  let adapterPollingPaused = false
  const failedAttachmentStatuses: Array<ReturnType<typeof broker.status>> = []
  const desktopRPC = {
    attach: async (input: Parameters<NativeInteractionBroker["attach"]>[0]) => {
      attachCount++
      if (rejectHeartbeatAttachments) throw new Error("fixture lost native owner heartbeat")
      try {
        broker.attach(input)
      } catch (error) {
        failedAttachmentStatuses.push(broker.status(input.binding))
        throw error
      }
      return {}
    },
    poll: async (input: Parameters<NativeInteractionBroker["poll"]>[0]) =>
      adapterPollingPaused ? null : broker.poll(input),
    complete: async (input: Parameters<NativeInteractionBroker["complete"]>[0]) => {
      completeCount++
      broker.complete(input)
      return {}
    },
    detach: async (input: { binding: NativeBinding; adapterID: string }) => {
      broker.detach(input.binding, input.adapterID)
      return {}
    },
  }
  const windows = [window]
  const context = {
    app: { version: registration.version },
    signal: new AbortController().signal,
    windows: {
      list: () => windows,
      focused: () => (focused ? window : undefined),
      on: () => () => undefined,
    },
    client: {
      rpc: () => desktopRPC,
    },
  } as unknown as MainContext
  const adapter = new NativeInteractionMainAdapter(
    context,
    root,
    () => 123,
    () => undefined,
    options.loadFixture,
  )
  const runtimeAllowPending: boolean[] = []
  const installRuntimeVerification = (target: NativeInteractionMainAdapter) =>
    Object.defineProperty(target, "verifyRuntime", {
      value: async (allowPending: boolean) => {
        runtimeAllowPending.push(allowPending)
        return binding
      },
    })
  installRuntimeVerification(adapter)
  adapter.trackWindow(window)
  const windowReference = adapter.currentWindowReferences()[0]!
  if (options.legacyAdapter) {
    broker.attach({ binding, adapterID: "legacy-adapter", windows: [windowReference] })
  } else {
    await adapter.start()
  }

  const requestIDs: string[] = []
  const acceptedOperations: NativeOperation[] = []
  let enqueueCount = 0
  let loseEnqueueReply = options.loseEnqueueReply === true
  let leaseState: "idle" | "pending" | "ambiguous" | undefined
  let leaseRequestID: string | undefined
  let leaseFinishes = 0
  let leaseMessage: string | undefined
  const rpc = {
    status: async ({ binding: requestedBinding }: { binding: NativeBinding }) => {
      const status = broker.status(requestedBinding)
      if (!options.legacyStatus) return status
      const { capabilities: _capabilities, ...legacyStatus } = status
      return legacyStatus
    },
    enqueue: async (input: Parameters<NativeInteractionBroker["enqueue"]>[0]) => {
      const validation = await NativeInteraction.methods.enqueue.input["~standard"].validate(input)
      if ("issues" in validation) throw new Error("Native RPC enqueue validation failed")
      enqueueCount++
      requestIDs.push(input.requestID)
      acceptedOperations.push(validation.value.operation)
      let result = broker.enqueue(validation.value)
      if (options.mismatchAdmissionRefusal && result.state === "refused") {
        result = {
          ...result,
          refusal: { ...result.refusal, requestID: "different-request" },
        }
      }
      if (loseEnqueueReply) {
        loseEnqueueReply = false
        throw new Error("fixture lost the enqueue reply")
      }
      return result
    },
    result: async ({
      binding: requestedBinding,
      requestID,
    }: {
      binding: NativeBinding
      requestID: string
    }) => broker.result(requestedBinding, requestID),
  }
  const client = {
    server: { info: async () => ({ pid: registration.pid, version: registration.version }) },
    rpc: () => rpc,
  } as unknown as ReturnType<NativeInteractionCliDependencies["makeClient"]>
  const dependencies: NativeInteractionCliDependencies = {
    verifyOwnedLaunch: async () => proof,
    beginNativeInteraction: async (_root, requestID) => {
      if (leaseState === "pending" || leaseState === "ambiguous")
        throw new Error(
          "A previous native interaction is unresolved; inspect its request without replay",
        )
      leaseRequestID = requestID
      leaseState = "pending"
      manifest.nativeInteraction = { state: "pending", requestID, kind: "key" }
      return {
        manifest,
        finish: async ({ state, message }) => {
          leaseFinishes++
          if (leaseRequestID !== requestID || leaseState !== "pending")
            throw new Error("Native interaction lease changed while a request was pending")
          leaseState = state
          leaseMessage = message
          manifest.nativeInteraction = {
            state,
            requestID,
            kind: "key",
            ...(message === undefined ? {} : { message }),
          }
          if (state === "ambiguous") manifest.status = "cleanup-blocked"
        },
      }
    },
    makeClient: () => client,
    verifyOwnedSidecar: async () => proof as never,
    resolveNativeInteraction: async (_root, requestID, _delivery, message) => {
      if (leaseRequestID !== requestID || (leaseState !== "pending" && leaseState !== "ambiguous"))
        throw new Error("Native interaction resolution does not match the pending request")
      leaseState = "idle"
      manifest.status = "ready"
      leaseMessage = message
      manifest.nativeInteraction = {
        state: "idle",
        requestID,
        kind: "key",
        ...(message === undefined ? {} : { message }),
      }
      return { ...manifest, nativeInteraction: { state: "idle", requestID } }
    },
  }

  return {
    adapter,
    broker,
    dependencies,
    events,
    insertedText,
    windowReference,
    setRendererPID: (pid: number) => (rendererPID = pid),
    requestIDs,
    acceptedOperations,
    runtimeAllowPending: () => runtimeAllowPending,
    attachCount: () => attachCount,
    completeCount: () => completeCount,
    failedAttachmentStatuses,
    enqueueCount: () => enqueueCount,
    leaseState: () => leaseState,
    leaseMessage: () => leaseMessage,
    leaseFinishes: () => leaseFinishes,
    advanceBrokerClock: (milliseconds: number) => (brokerTime += milliseconds),
    setHeartbeatAttachmentFailure: (value: boolean) => (rejectHeartbeatAttachments = value),
    setAdapterPollingPaused: (value: boolean) => (adapterPollingPaused = value),
    setExecute: (
      execute: (operation: NativeOperation, requestID?: string) => Promise<NativeActionResult>,
    ) => Reflect.set(adapter, "execute", execute),
    makeAdapter: () => {
      const replacement = new NativeInteractionMainAdapter(
        context,
        root,
        () => 123,
        () => undefined,
      )
      installRuntimeVerification(replacement)
      return replacement
    },
    seedPendingRequest: (requestID: string, operation: NativeOperation) => {
      leaseRequestID = requestID
      leaseState = "pending"
      manifest.nativeInteraction = { state: "pending", requestID, kind: "key" }
      return broker.enqueue({ binding, requestID, operation })
    },
    seedBrokerRequest: (requestID: string, operation: NativeOperation) =>
      broker.enqueue({ binding, requestID, operation }),
    abandonAdapter: () => {
      // Simulate a process exit: do not invoke detach, which would settle the lease itself.
      Reflect.set(adapter, "stopped", true)
    },
    close: () => adapter.stop(),
  }
}

function nativeArgs(key: string, snapshotID: string): string[] {
  return [
    "native",
    "--root",
    root,
    "--kind",
    "key",
    "--window",
    "12",
    "--snapshot",
    snapshotID,
    "--key",
    key,
  ]
}

function seedActiveRequest(value: Awaited<ReturnType<typeof pipeline>>, requestID: string): void {
  value.setAdapterPollingPaused(true)
  expect(
    value.seedBrokerRequest(requestID, {
      kind: "snapshot",
      window: value.windowReference,
    }),
  ).toEqual({ state: "queued" })
}

function settleActiveRequest(value: Awaited<ReturnType<typeof pipeline>>, requestID: string): void {
  const status = value.broker.status(binding)
  if (status.adapterID === undefined) throw new Error("Fixture adapter disappeared")
  expect(
    value.broker.poll({
      binding,
      adapterID: status.adapterID,
      windows: [value.windowReference],
    }),
  ).toMatchObject({ requestID })
  value.broker.complete({
    binding,
    adapterID: status.adapterID,
    requestID,
    result: { delivery: "delivered" },
  })
  value.setAdapterPollingPaused(false)
}

async function runCLI(
  args: string[],
  dependencies: NativeInteractionCliDependencies,
): Promise<string[]> {
  const lines: string[] = []
  const output = spyOn(console, "log").mockImplementation((...values) => {
    lines.push(values.map(String).join(" "))
  })
  try {
    await verificationCLI(args, dependencies)
    return lines
  } finally {
    output.mockRestore()
  }
}

async function freshSnapshot(value: Awaited<ReturnType<typeof pipeline>>): Promise<string> {
  const result = await value.adapter.perform({ kind: "snapshot", window: value.windowReference })
  if (result.snapshot === undefined) throw new Error("Fixture snapshot was not returned")
  return result.snapshot.snapshotID
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  }
  throw new Error(`Timed out waiting for ${message}`)
}

describe("owned native interaction CLI-to-Main pipeline", () => {
  test("arms dictation fixtures and playback plans without a DOM snapshot", async () => {
    const fixture: AudioFixtureDelivery = {
      requestID: "pending",
      fixtureID: "quick-brown-fox",
      transcript: "The quick brown fox jumps over the lazy dog.",
      sampleRate: 16_000,
      durationMs: 2_671,
      sha256: "0497e70d431e9d827c10bbaff120c9cbabf0834a747107f83cb161dc1f759880",
      audioBase64: "AA==",
    }
    const dictation = await pipeline({ loadFixture: async () => fixture })
    const output = spyOn(console, "log").mockImplementation(() => undefined)
    try {
      await verificationCLI(
        [
          "audio-fixture",
          "--root",
          root,
          "--window",
          "12",
          "--session",
          "owned-session",
          "--clip",
          "quick-brown-fox",
        ],
        dictation.dependencies,
      )
      expect(dictation.acceptedOperations[0]).toMatchObject({
        kind: "dictation-fixture",
        sessionID: "owned-session",
        fixtureID: "quick-brown-fox",
      })
      expect(dictation.leaseState()).toBe("idle")
      const requestID = dictation.requestIDs[0]!
      const delivery = await dictation.adapter.takeDictationFixture("owned-session", 12)
      expect(delivery?.requestID).toBe(requestID)
      expect(
        await dictation.adapter.audioFixtureEnabled({ requestID, sessionID: "owned-session" }, 12),
      ).toBe(true)
      await expect(
        dictation.adapter.audioFixtureEnabled(
          { requestID: "different-request", sessionID: "owned-session" },
          12,
        ),
      ).rejects.toThrow("target changed")
      dictation.setRendererPID(30_002)
      dictation.adapter.currentWindowReferences()
      await expect(
        dictation.adapter.audioFixtureEnabled({ requestID, sessionID: "owned-session" }, 12),
      ).rejects.toThrow("no longer armed")
    } finally {
      output.mockRestore()
      dictation.close()
    }

    const playback = await pipeline()
    const playbackOutput = spyOn(console, "log").mockImplementation(() => undefined)
    try {
      await verificationCLI(
        [
          "audio-playback",
          "--root",
          root,
          "--window",
          "12",
          "--session",
          "owned-session",
          "--expected",
          "The last completed answer.",
        ],
        playback.dependencies,
      )
      expect(playback.acceptedOperations[0]).toMatchObject({
        kind: "playback-plan",
        sessionID: "owned-session",
        segmentHashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      })
      expect(playback.leaseState()).toBe("idle")
    } finally {
      playbackOutput.mockRestore()
      playback.close()
    }
  })

  test("audio fixtures accept only fixed clip IDs and expose no caller-supplied path option", async () => {
    await expect(
      verificationCLI([
        "audio-fixture",
        "--root",
        root,
        "--window",
        "12",
        "--session",
        "owned-session",
        "--clip",
        "/etc/passwd",
      ]),
    ).rejects.toThrow("--clip must be quick-brown-fox or turn-left-next-street")
    await expect(
      verificationCLI([
        "audio-fixture",
        "--root",
        root,
        "--window",
        "12",
        "--session",
        "owned-session",
        "--clip",
        "quick-brown-fox",
        "--path",
        "/etc/passwd",
      ]),
    ).rejects.toThrow()
  })

  test("parses and admits Ctrl+T through the RPC schema and dispatches control key events", async () => {
    const value = await pipeline()
    try {
      expect(value.runtimeAllowPending()[0]).toBe(true)
      expect(value.broker.status(binding)).toMatchObject({
        ready: true,
        capabilities: { modifiedKeys: true },
      })
      const snapshotID = await freshSnapshot(value)
      await runCLI(nativeArgs("Ctrl+T", snapshotID), value.dependencies)

      expect(value.acceptedOperations).toHaveLength(1)
      expect(value.acceptedOperations[0]).toMatchObject({ kind: "key", key: "Ctrl+T" })
      expect(value.events).toEqual([
        { type: "keyDown", keyCode: "T", modifiers: ["control"] },
        { type: "keyUp", keyCode: "T", modifiers: ["control"] },
      ])
      expect(value.insertedText).toEqual([])
      expect(value.enqueueCount()).toBe(1)
      expect(value.leaseState()).toBe("idle")
    } finally {
      value.close()
    }
  })

  test("keeps existing bare-key requests unchanged", async () => {
    const value = await pipeline()
    try {
      const snapshotID = await freshSnapshot(value)
      await runCLI(nativeArgs("Enter", snapshotID), value.dependencies)

      expect(value.events).toEqual([
        { type: "keyDown", keyCode: "Enter" },
        { type: "keyUp", keyCode: "Enter" },
      ])
      expect(value.insertedText).toEqual([])
    } finally {
      value.close()
    }
  })

  test("rejects invalid modifier syntax before RPC admission or native input", async () => {
    const value = await pipeline()
    try {
      const snapshotID = await freshSnapshot(value)
      await expect(
        runCLI(nativeArgs("Ctrl+Shift+T", snapshotID), value.dependencies),
      ).rejects.toThrow("Native key must be one of")
      expect(value.enqueueCount()).toBe(0)
      expect(value.events).toEqual([])
      expect(value.leaseState()).toBe("idle")

      const invalidRPCInput = await NativeInteraction.methods.enqueue.input["~standard"].validate({
        binding,
        requestID: "8fc30312-7715-4a1a-a12f-2bb8e53f17c2",
        operation: {
          kind: "key",
          window: value.windowReference,
          snapshotID,
          key: "Ctrl+Shift+T",
        },
      })
      expect("issues" in invalidRPCInput).toBe(true)
    } finally {
      value.close()
    }
  })

  test("refuses modified input for legacy or capability-unknown live adapters", async () => {
    for (const options of [{ legacyAdapter: true }, { legacyStatus: true }]) {
      const value = await pipeline(options)
      try {
        const snapshotID = await freshSnapshot(value)
        await expect(runCLI(nativeArgs("Ctrl+T", snapshotID), value.dependencies)).rejects.toThrow(
          "does not support modified key shortcuts",
        )
        expect(value.enqueueCount()).toBe(0)
        expect(value.events).toEqual([])
        expect(value.leaseState()).toBe("idle")
      } finally {
        value.close()
      }
    }
  })

  test("finishes its matching lease idle after a request-bound admission refusal", async () => {
    const value = await pipeline()
    try {
      const snapshotID = await freshSnapshot(value)
      const activeRequestID = "8fc30312-7715-4a1a-a12f-2bb8e53f17c2"
      const refusalMessage = "A native interaction is already pending; inspect it without replay"
      seedActiveRequest(value, activeRequestID)
      await expect(runCLI(nativeArgs("Enter", snapshotID), value.dependencies)).rejects.toThrow(
        refusalMessage,
      )

      expect(value.events).toEqual([])
      expect(value.enqueueCount()).toBe(1)
      expect(value.leaseState()).toBe("idle")
      expect(value.leaseFinishes()).toBe(1)
      expect(value.leaseMessage()).toBe(refusalMessage)
      expect(manifest.nativeInteraction).toMatchObject({
        state: "idle",
        requestID: value.requestIDs[0],
        message: refusalMessage,
      })
      expect(value.broker.result(binding, value.requestIDs[0]!)).toMatchObject({
        state: "completed",
        result: { delivery: "not-delivered", message: refusalMessage },
        refusal: {
          requestID: value.requestIDs[0],
          operation: value.acceptedOperations[0],
          delivery: "not-delivered",
          message: refusalMessage,
        },
      })
      expect(value.broker.status(binding).blocked).toBe(false)
      expect(value.broker.result(binding, activeRequestID)).toEqual({ state: "queued" })
      settleActiveRequest(value, activeRequestID)
      await runCLI(nativeArgs("Enter", await freshSnapshot(value)), value.dependencies)
      expect(value.enqueueCount()).toBe(2)
      expect(value.events).toEqual([
        { type: "keyDown", keyCode: "Enter" },
        { type: "keyUp", keyCode: "Enter" },
      ])
      expect(value.leaseState()).toBe("idle")
      expect(value.leaseFinishes()).toBe(2)
    } finally {
      value.close()
    }
  })

  test("keeps a malformed refusal response ambiguous rather than releasing the lease", async () => {
    const value = await pipeline({
      mismatchAdmissionRefusal: true,
    })
    try {
      seedActiveRequest(value, "8fc30312-7715-4a1a-a12f-2bb8e53f17c2")
      await expect(
        runCLI(nativeArgs("Enter", await freshSnapshot(value)), value.dependencies),
      ).rejects.toThrow("Native delivery is ambiguous; do not replay")
      expect(value.events).toEqual([])
      expect(value.enqueueCount()).toBe(1)
      expect(value.leaseState()).toBe("ambiguous")
      expect(value.leaseFinishes()).toBe(1)
      expect(value.broker.result(binding, value.requestIDs[0]!)).toMatchObject({
        refusal: {
          requestID: value.requestIDs[0],
          delivery: "not-delivered",
        },
      })
    } finally {
      value.close()
    }
  })

  test("reports partial modified-key delivery as ambiguous and does not replay it", async () => {
    const value = await pipeline({ failKeyUp: true })
    try {
      const snapshotID = await freshSnapshot(value)
      await expect(runCLI(nativeArgs("Ctrl+T", snapshotID), value.dependencies)).rejects.toThrow(
        "Native delivery is ambiguous; do not replay",
      )
      expect(value.events).toEqual([{ type: "keyDown", keyCode: "T", modifiers: ["control"] }])
      expect(value.enqueueCount()).toBe(1)
      expect(value.leaseState()).toBe("ambiguous")
      expect(value.broker.status(binding).blocked).toBe(true)
    } finally {
      value.close()
    }
  })

  test("keeps a lost enqueue reply ambiguous while the accepted shortcut runs once", async () => {
    const value = await pipeline({ loseEnqueueReply: true })
    try {
      const snapshotID = await freshSnapshot(value)
      await expect(runCLI(nativeArgs("Ctrl+T", snapshotID), value.dependencies)).rejects.toThrow(
        "Native delivery is ambiguous; do not replay",
      )
      expect(value.leaseState()).toBe("ambiguous")
      expect(value.enqueueCount()).toBe(1)

      const requestID = value.requestIDs[0]!
      let result = value.broker.result(binding, requestID)
      for (let attempt = 0; attempt < 30 && result.state !== "completed"; attempt++) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
        result = value.broker.result(binding, requestID)
      }
      expect(result).toMatchObject({
        state: "completed",
        result: { delivery: "delivered" },
      })
      expect(value.events).toEqual([
        { type: "keyDown", keyCode: "T", modifiers: ["control"] },
        { type: "keyUp", keyCode: "T", modifiers: ["control"] },
      ])
      expect(value.enqueueCount()).toBe(1)
      await expect(
        runCLI(nativeArgs("Enter", "snapshot-before-resolution"), value.dependencies),
      ).rejects.toThrow("previous native interaction is unresolved")
      expect(value.enqueueCount()).toBe(1)

      await runCLI(["native-resolve", "--root", root, "--request", requestID], value.dependencies)
      expect(value.leaseState()).toBe("idle")
      const nextSnapshotID = await freshSnapshot(value)
      await runCLI(nativeArgs("Enter", nextSnapshotID), value.dependencies)
      expect(value.enqueueCount()).toBe(2)
      expect(value.acceptedOperations).toHaveLength(2)
      expect(value.events).toEqual([
        { type: "keyDown", keyCode: "T", modifiers: ["control"] },
        { type: "keyUp", keyCode: "T", modifiers: ["control"] },
        { type: "keyDown", keyCode: "Enter" },
        { type: "keyUp", keyCode: "Enter" },
      ])
      expect(value.leaseState()).toBe("idle")
    } finally {
      value.close()
    }
  })

  test("recovers a lost negative admission receipt read-only without re-enqueueing", async () => {
    const value = await pipeline({ loseEnqueueReply: true })
    try {
      const activeRequestID = "8fc30312-7715-4a1a-a12f-2bb8e53f17c2"
      const refusalMessage = "A native interaction is already pending; inspect it without replay"
      seedActiveRequest(value, activeRequestID)
      await expect(
        runCLI(nativeArgs("Enter", await freshSnapshot(value)), value.dependencies),
      ).rejects.toThrow("Native delivery is ambiguous; do not replay")

      const requestID = value.requestIDs[0]!
      expect(value.leaseState()).toBe("ambiguous")
      expect(value.leaseFinishes()).toBe(1)
      expect(value.events).toEqual([])
      expect(value.enqueueCount()).toBe(1)
      expect(value.broker.result(binding, requestID)).toMatchObject({
        state: "completed",
        result: { delivery: "not-delivered", message: refusalMessage },
        refusal: {
          requestID,
          operation: value.acceptedOperations[0],
          delivery: "not-delivered",
          message: refusalMessage,
        },
      })

      const resolutionOutput = await runCLI(
        ["native-resolve", "--root", root, "--request", requestID],
        value.dependencies,
      )
      expect(JSON.parse(resolutionOutput.at(-1)!)).toMatchObject({
        requestID,
        state: "completed",
        delivery: "not-delivered",
        resolved: true,
        replayed: false,
        message: refusalMessage,
        admissionRefusal: {
          requestID,
          operation: value.acceptedOperations[0],
          delivery: "not-delivered",
          message: refusalMessage,
        },
      })
      expect(value.enqueueCount()).toBe(1)
      expect(value.leaseState()).toBe("idle")
      expect(value.leaseFinishes()).toBe(1)
      expect(value.leaseMessage()).toBe(refusalMessage)
      expect(manifest.nativeInteraction).toMatchObject({
        state: "idle",
        requestID,
        message: refusalMessage,
      })
      expect(value.events).toEqual([])

      expect(value.broker.result(binding, activeRequestID)).toEqual({ state: "queued" })
      settleActiveRequest(value, activeRequestID)
      await runCLI(nativeArgs("Enter", await freshSnapshot(value)), value.dependencies)
      expect(value.enqueueCount()).toBe(2)
      expect(value.events).toEqual([
        { type: "keyDown", keyCode: "Enter" },
        { type: "keyUp", keyCode: "Enter" },
      ])
    } finally {
      value.close()
    }
  })

  test("recovers a stale pending request only after explicit resolution, then dispatches once", async () => {
    const value = await pipeline()
    try {
      value.abandonAdapter()
      const staleRequestID = "8fc30312-7715-4a1a-a12f-2bb8e53f17c2"
      const staleOperation: NativeOperation = {
        kind: "key",
        window: value.windowReference,
        snapshotID: "snapshot-before-crash",
        key: "Enter",
      }
      expect(value.seedPendingRequest(staleRequestID, staleOperation)).toEqual({ state: "queued" })
      value.advanceBrokerClock(2_001)

      const replacementID = "replacement-adapter"
      value.broker.attach({
        binding,
        adapterID: replacementID,
        windows: [value.windowReference],
        capabilities: { modifiedKeys: true },
      })
      expect(value.broker.status(binding)).toMatchObject({ ready: true, adapterID: replacementID })
      expect(value.broker.result(binding, staleRequestID)).toEqual({
        state: "completed",
        result: {
          delivery: "not-delivered",
          message: "Desktop adapter heartbeat expired before dispatch",
        },
      })
      expect(
        value.broker.poll({
          binding,
          adapterID: replacementID,
          windows: [value.windowReference],
        }),
      ).toBeNull()
      await expect(
        runCLI(nativeArgs("Enter", "snapshot-before-resolution"), value.dependencies),
      ).rejects.toThrow("previous native interaction is unresolved")
      expect(value.enqueueCount()).toBe(0)

      await runCLI(
        ["native-resolve", "--root", root, "--request", staleRequestID],
        value.dependencies,
      )
      expect(value.leaseState()).toBe("idle")

      const requestCountBefore = value.enqueueCount()
      const nextRequest = runCLI(nativeArgs("Enter", "fresh-snapshot"), value.dependencies)
      for (
        let attempt = 0;
        attempt < 100 && value.enqueueCount() === requestCountBefore;
        attempt++
      ) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
      }
      expect(value.enqueueCount()).toBe(requestCountBefore + 1)
      const command = value.broker.poll({
        binding,
        adapterID: replacementID,
        windows: [value.windowReference],
      })
      expect(command).toMatchObject({ operation: { kind: "key", key: "Enter" } })
      if (command === null) throw new Error("Fresh request was not dispatched")
      value.broker.complete({
        binding,
        adapterID: replacementID,
        requestID: command.requestID,
        result: { delivery: "delivered" },
      })
      await nextRequest
      expect(value.enqueueCount()).toBe(requestCountBefore + 1)
      expect(value.leaseState()).toBe("idle")
    } finally {
      value.close()
    }
  })

  test("retries replacement attachment until the prior fresh owner expires", async () => {
    const value = await pipeline()
    let replacement: NativeInteractionMainAdapter | undefined
    try {
      const priorOwner = value.broker.status(binding).adapterID
      expect(priorOwner).toBeDefined()
      const attachCount = value.attachCount()
      value.abandonAdapter()
      replacement = value.makeAdapter()
      Reflect.set(replacement, "delay", async (milliseconds: number) => {
        value.advanceBrokerClock(milliseconds)
      })
      Reflect.set(replacement, "poll", async () => undefined)

      await replacement.start()

      expect(value.attachCount()).toBeGreaterThan(attachCount + 1)
      expect(value.failedAttachmentStatuses.length).toBeGreaterThan(0)
      expect(
        value.failedAttachmentStatuses.every(
          (status) => status.ready && status.adapterID === priorOwner,
        ),
      ).toBe(true)
      expect(value.broker.status(binding)).toMatchObject({ ready: true })
      expect(value.broker.status(binding).adapterID).not.toBe(priorOwner)
      replacement.stop()
      await waitFor(() => !value.broker.status(binding).ready, "normal replacement detach")
      replacement = undefined
    } finally {
      replacement?.stop()
      value.close()
    }
  })

  test("keeps the active lease fresh during a slow healthy execution without redispatch", async () => {
    const value = await pipeline()
    try {
      const snapshotID = await freshSnapshot(value)
      let executionCount = 0
      let finishExecution!: (result: NativeActionResult) => void
      const execution = new Promise<NativeActionResult>((resolvePromise) => {
        finishExecution = resolvePromise
      })
      value.setExecute(async () => {
        executionCount++
        return execution
      })
      const request = runCLI(nativeArgs("Enter", snapshotID), value.dependencies)
      await waitFor(() => executionCount === 1, "the native operation to start")

      let lastHeartbeat = value.attachCount()
      for (let index = 0; index < 4; index++) {
        await waitFor(() => value.attachCount() > lastHeartbeat, "a native adapter heartbeat")
        lastHeartbeat = value.attachCount()
        value.advanceBrokerClock(750)
      }
      finishExecution({ delivery: "delivered" })
      await request

      expect(executionCount).toBe(1)
      expect(value.attachCount()).toBeGreaterThanOrEqual(5)
      expect(value.completeCount()).toBe(1)
      expect(value.broker.result(binding, value.requestIDs[0]!)).toMatchObject({
        state: "completed",
        result: { delivery: "delivered" },
      })
      expect(value.broker.status(binding)).toMatchObject({ ready: true, blocked: false })
    } finally {
      value.close()
    }
  })

  test("turns real owner loss during execution ambiguous without replay or stale completion", async () => {
    const value = await pipeline()
    try {
      const snapshotID = await freshSnapshot(value)
      let executionCount = 0
      let finishExecution!: (result: NativeActionResult) => void
      const execution = new Promise<NativeActionResult>((resolvePromise) => {
        finishExecution = resolvePromise
      })
      value.setExecute(async () => {
        executionCount++
        return execution
      })
      const request = runCLI(nativeArgs("Enter", snapshotID), value.dependencies)
      await waitFor(() => executionCount === 1, "the native operation to start")
      value.setHeartbeatAttachmentFailure(true)
      const previousAttachCount = value.attachCount()
      await waitFor(() => value.attachCount() > previousAttachCount, "the failing owner heartbeat")

      value.advanceBrokerClock(2_001)
      expect(value.broker.status(binding)).toMatchObject({ ready: false, windows: [] })
      value.broker.attach({
        binding,
        adapterID: "replacement-after-owner-loss",
        windows: [value.windowReference],
        capabilities: { modifiedKeys: true },
      })
      expect(value.broker.status(binding)).toMatchObject({
        ready: true,
        blocked: true,
        adapterID: "replacement-after-owner-loss",
      })
      finishExecution({ delivery: "delivered" })

      await expect(request).rejects.toThrow("Native delivery is ambiguous; do not replay")
      expect(executionCount).toBe(1)
      expect(value.enqueueCount()).toBe(1)
      expect(value.completeCount()).toBe(1)
      expect(value.broker.result(binding, value.requestIDs[0]!)).toMatchObject({
        state: "completed",
        result: { delivery: "ambiguous" },
      })
      await expect(
        runCLI(nativeArgs("Enter", "snapshot-after-owner-loss"), value.dependencies),
      ).rejects.toThrow("previous native interaction is unresolved")
      expect(value.enqueueCount()).toBe(1)
      value.broker.detach(binding, "replacement-after-owner-loss")
      expect(value.broker.status(binding)).toMatchObject({ ready: false, blocked: true })
    } finally {
      value.close()
    }
  })
})
