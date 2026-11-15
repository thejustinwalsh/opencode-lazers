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

  const now = () => Date.now()
  const broker = new NativeInteractionBroker(
    {
      root,
      verificationBase: manifest.baseDirectory!,
      servicePID: registration.pid,
      version: registration.version,
    },
    now,
  )
  const desktopRPC = {
    attach: async (input: Parameters<NativeInteractionBroker["attach"]>[0]) => {
      broker.attach(input)
      return {}
    },
    poll: async (input: Parameters<NativeInteractionBroker["poll"]>[0]) => broker.poll(input),
    complete: async (input: Parameters<NativeInteractionBroker["complete"]>[0]) => {
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
  Object.defineProperty(adapter, "verifyRuntime", { value: async () => binding })
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
  let leaseState: "idle" | "ambiguous" | undefined
  let leaseFinishes = 0
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
      const result = broker.enqueue(validation.value)
      if (options.loseEnqueueReply) throw new Error("fixture lost the enqueue reply")
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
    beginNativeInteraction: async () => ({
      manifest,
      finish: async ({ state }) => {
        leaseFinishes++
        leaseState = state
      },
    }),
    makeClient: () => client,
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
    enqueueCount: () => enqueueCount,
    leaseState: () => leaseState,
    leaseFinishes: () => leaseFinishes,
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

async function runCLI(
  args: string[],
  dependencies: NativeInteractionCliDependencies,
): Promise<void> {
  const output = spyOn(console, "log").mockImplementation(() => undefined)
  try {
    await verificationCLI(args, dependencies)
  } finally {
    output.mockRestore()
  }
}

async function freshSnapshot(value: Awaited<ReturnType<typeof pipeline>>): Promise<string> {
  const result = await value.adapter.perform({ kind: "snapshot", window: value.windowReference })
  if (result.snapshot === undefined) throw new Error("Fixture snapshot was not returned")
  return result.snapshot.snapshotID
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
    } finally {
      value.close()
    }
  })
})
