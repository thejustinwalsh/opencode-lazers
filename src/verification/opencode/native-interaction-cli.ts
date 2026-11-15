import { OpenCode } from "@opencode/client"
import { lstat, mkdir, open } from "node:fs/promises"
import { join, resolve } from "node:path"
import { speechSegments } from "../../webgpu/speech.ts"
import { sha256Text } from "./audio-fixture-contract.ts"
import {
  beginNativeInteraction,
  nativeBindingFromManifest,
  resolveNativeInteraction,
  verifyOwnedLaunch,
  verifyOwnedSidecar,
} from "./owned-launch.ts"
import {
  NATIVE_KEYS,
  NativeInteraction,
  nativeKeyUsesModifiers,
  parseNativeKey,
  type NativeOperation,
  type NativeWindowReference,
} from "./native-interaction-contract.ts"

const REQUEST_TIMEOUT_MS = 30_000
const RPC_TIMEOUT_MS = 3_000
const POLL_INTERVAL_MS = 200
const AUDIO_OBSERVATION_TIMEOUT_MS = 120_000

type NativeKind =
  | "snapshot"
  | "capture"
  | "focus"
  | "click"
  | "type"
  | "key"
  | "dictation-fixture"
  | "playback-plan"

export type NativeCommandInput = {
  root: string
  kind: NativeKind
  windowID?: number
  snapshotID?: string
  elementRef?: string
  text?: string
  key?: string
  output?: string
  confirmSafePage?: boolean
  sessionID?: string
  fixtureID?: string
  expected?: string
}

export type NativeInteractionCliDependencies = {
  verifyOwnedLaunch: typeof verifyOwnedLaunch
  beginNativeInteraction: typeof beginNativeInteraction
  makeClient: typeof makeClient
  verifyOwnedSidecar?: typeof verifyOwnedSidecar
  resolveNativeInteraction?: typeof resolveNativeInteraction
}

const nativeInteractionDependencies: NativeInteractionCliDependencies = {
  verifyOwnedLaunch,
  beginNativeInteraction,
  makeClient,
}

function makeClient(registration: { url: string; password: string }) {
  const authorization = `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}`
  return OpenCode.make({ baseUrl: registration.url, headers: { authorization } })
}

function nativeWindow(
  windows: ReadonlyArray<NativeWindowReference>,
  windowID?: number,
): NativeWindowReference {
  const candidates = windows.filter((window) => window.visible)
  const selected =
    windowID === undefined
      ? (candidates.find((window) => window.focused) ?? candidates[0])
      : candidates.find((window) => window.windowID === windowID)
  if (selected === undefined)
    throw new Error("No matching visible owned Desktop window is attached")
  return selected
}

async function operation(
  input: NativeCommandInput,
  window: NativeWindowReference,
): Promise<NativeOperation> {
  if (input.kind === "snapshot" || input.kind === "capture" || input.kind === "focus") {
    return { kind: input.kind, window }
  }
  if (input.kind === "dictation-fixture") {
    if (
      input.sessionID === undefined ||
      input.sessionID.length === 0 ||
      input.sessionID.length > 160
    )
      throw new Error("Dictation fixture requires a bounded target session ID")
    if (input.fixtureID !== "quick-brown-fox" && input.fixtureID !== "turn-left-next-street")
      throw new Error("Frozen clip must be quick-brown-fox or turn-left-next-street")
    return {
      kind: "dictation-fixture",
      window,
      sessionID: input.sessionID,
      fixtureID: input.fixtureID,
    }
  }
  if (input.kind === "playback-plan") {
    if (
      input.sessionID === undefined ||
      input.sessionID.length === 0 ||
      input.sessionID.length > 160
    )
      throw new Error("Playback plan requires a bounded target session ID")
    if (
      input.expected === undefined ||
      input.expected.length === 0 ||
      input.expected.length > 4_000
    )
      throw new Error("Playback plan requires expected speech text (1–4000 characters)")
    const segments = speechSegments(input.expected)
    if (segments.length === 0 || segments.length > 32)
      throw new Error("Expected speech must produce 1–32 bounded segments")
    return {
      kind: "playback-plan",
      window,
      sessionID: input.sessionID,
      expectedTextHash: await sha256Text(segments.join("\n")),
      segmentHashes: await Promise.all(segments.map(sha256Text)),
    }
  }
  const snapshotID = input.snapshotID
  if (snapshotID === undefined || snapshotID.length === 0) {
    throw new Error("Native input requires the ID of a fresh snapshot")
  }
  if (input.kind === "click") {
    if (input.elementRef === undefined || input.elementRef.length === 0) {
      throw new Error("Native click requires a rendered element reference")
    }
    return { kind: "click", window, snapshotID, elementRef: input.elementRef }
  }
  if (input.kind === "type") {
    if (input.elementRef === undefined || input.elementRef.length === 0) {
      throw new Error("Native text entry requires a rendered element reference")
    }
    if (input.text === undefined || input.text.length === 0 || input.text.length > 2_000) {
      throw new Error("Native text entry must contain 1–2000 characters")
    }
    return { kind: "type", window, snapshotID, elementRef: input.elementRef, text: input.text }
  }
  const key = parseNativeKey(input.key)
  if (key === undefined) {
    throw new Error(`Native key must be one of ${NATIVE_KEYS.join(", ")}`)
  }
  return { kind: "key", window, snapshotID, key }
}

function printResult(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

export async function nativeInteractionStatus(root: string): Promise<void> {
  const proof = await verifyOwnedSidecar(root, { allowInteractionRecovery: true })
  const client = makeClient(proof.registration)
  const info = await client.server.info({ signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  if (info.pid !== proof.health.pid || info.version !== proof.health.version) {
    throw new Error("Authenticated owned sidecar identity changed")
  }
  const binding = nativeBindingFromManifest(proof.manifest)
  const status = await client
    .rpc(NativeInteraction)
    .status({ binding }, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  printResult({
    ready: status.ready,
    blocked: status.blocked,
    windows: status.windows,
    adapterID: status.adapterID,
    capabilities: status.capabilities,
    interaction: proof.manifest.nativeInteraction ?? { state: "idle" },
    candidate: {
      workspace: proof.manifest.candidate.workspace,
      revision: proof.manifest.candidate.revision,
      dirtyPaths: proof.manifest.candidate.dirtyPaths,
    },
    service: { pid: proof.health.pid, version: proof.health.version, url: proof.registration.url },
  })
}

export async function runNativeInteraction(
  input: NativeCommandInput,
  dependencies: NativeInteractionCliDependencies = nativeInteractionDependencies,
): Promise<void> {
  if (input.kind === "capture" && (input.output === undefined || !input.confirmSafePage)) {
    throw new Error("Rendered screenshots require --output <name.png> and --confirm-safe-page yes")
  }
  const preflight = await dependencies.verifyOwnedLaunch(input.root)
  const requestID = crypto.randomUUID()
  const lease = await dependencies.beginNativeInteraction(input.root, requestID, input.kind)
  let mayHaveReachedSidecar = false
  let finishAttempted = false
  try {
    const proof = await dependencies.verifyOwnedLaunch(input.root, {
      allowPendingInteraction: true,
    })
    const client = dependencies.makeClient(proof.registration)
    const info = await client.server.info({ signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    if (info.pid !== proof.health.pid || info.version !== proof.health.version) {
      throw new Error("Authenticated owned sidecar identity changed")
    }
    const binding = nativeBindingFromManifest(proof.manifest)
    const rpc = client.rpc(NativeInteraction)
    const status = await rpc.status({ binding }, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    if (!status.ready || status.blocked) {
      throw new Error(
        status.blocked
          ? "Owned native adapter is blocked by an ambiguous action"
          : "Owned native adapter is unavailable",
      )
    }
    const target = nativeWindow(status.windows, input.windowID)
    const command = await operation(input, target)
    if (
      command.kind === "key" &&
      nativeKeyUsesModifiers(command.key) &&
      status.capabilities?.modifiedKeys !== true
    ) {
      throw new Error("Owned native adapter does not support modified key shortcuts")
    }
    if (!["snapshot", "capture", "focus"].includes(input.kind) && !target.focused) {
      throw new Error("Focus the owned Desktop window before native input")
    }
    mayHaveReachedSidecar = true
    await rpc.enqueue(
      { binding, requestID, operation: command },
      { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
    )

    const deadline = Date.now() + REQUEST_TIMEOUT_MS
    let result: Awaited<ReturnType<typeof rpc.result>> | undefined
    while (Date.now() < deadline) {
      try {
        const current = await rpc.result(
          { binding, requestID },
          { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
        )
        if (current.state === "completed") {
          result = current
          break
        }
        if (current.state === "unknown") {
          throw new Error("Owned sidecar no longer knows this request")
        }
      } catch {
        // Read-only result polling can be repeated; the native command is never re-enqueued.
      }
      await delay(POLL_INTERVAL_MS)
    }
    if (result === undefined || result.result === undefined) {
      finishAttempted = true
      await lease.finish({
        state: "ambiguous",
        message: "No final result was observed before the deadline",
      })
      throw new Error(
        `Native delivery is ambiguous; do not replay request ${requestID}. Resolve it with native-resolve.`,
      )
    }
    if (result.result.delivery === "ambiguous") {
      finishAttempted = true
      await lease.finish({
        state: "ambiguous",
        message: result.result.message ?? "Native delivery was ambiguous",
      })
      throw new Error(
        `Native delivery is ambiguous; do not replay request ${requestID}. Resolve it with native-resolve.`,
      )
    }
    finishAttempted = true
    await lease.finish({ state: "idle", message: `Completed as ${result.result.delivery}` })
    if (
      (input.kind === "dictation-fixture" || input.kind === "playback-plan") &&
      result.result.delivery !== "delivered"
    ) {
      throw new Error(result.result.message ?? "Owned audio operation could not be armed")
    }
    if (input.kind === "capture" && result.result.screenshotBase64 !== undefined) {
      const path = await saveScreenshot(
        preflight.manifest.candidate.workspace,
        input.output!,
        result.result.screenshotBase64,
      )
      printResult({
        requestID,
        delivery: result.result.delivery,
        snapshot: result.result.snapshot,
        screenshot: path,
      })
      return
    }
    if (input.kind === "capture") throw new Error("Owned adapter returned no bounded screenshot")
    printResult({ requestID, ...result.result })
  } catch (error) {
    if (mayHaveReachedSidecar && !finishAttempted) {
      await lease.finish({
        state: "ambiguous",
        message: "Sidecar response was not conclusively observed",
      })
      throw new Error(
        `Native delivery is ambiguous; do not replay request ${requestID}. Resolve it with native-resolve.`,
        { cause: error },
      )
    }
    if (!finishAttempted) {
      await lease.finish({ state: "idle", message: "Preflight ended before request delivery" })
    }
    throw error
  }
}

export async function resolveNativeInteractionResult(
  root: string,
  requestID: string,
  dependencies: Pick<NativeInteractionCliDependencies, "makeClient"> &
    Partial<
      Pick<NativeInteractionCliDependencies, "verifyOwnedSidecar" | "resolveNativeInteraction">
    > = nativeInteractionDependencies,
): Promise<void> {
  const proof = await (dependencies.verifyOwnedSidecar ?? verifyOwnedSidecar)(root, {
    allowInteractionRecovery: true,
  })
  if (proof.manifest.nativeInteraction?.requestID !== requestID) {
    throw new Error("Request ID does not match the unresolved native interaction")
  }
  const client = dependencies.makeClient(proof.registration)
  const binding = nativeBindingFromManifest(proof.manifest)
  const result = await client
    .rpc(NativeInteraction)
    .result({ binding, requestID }, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  if (result.state !== "completed" || result.result === undefined) {
    printResult({ requestID, state: result.state, resolved: false, replayed: false })
    return
  }
  if (result.result.delivery === "ambiguous") {
    printResult({
      requestID,
      state: result.state,
      delivery: "ambiguous",
      resolved: false,
      replayed: false,
    })
    return
  }
  const manifest = await (dependencies.resolveNativeInteraction ?? resolveNativeInteraction)(
    root,
    requestID,
    result.result.delivery,
  )
  printResult({
    requestID,
    state: result.state,
    delivery: result.result.delivery,
    resolved: manifest.nativeInteraction?.state === "idle",
    replayed: false,
    snapshot: result.result.snapshot,
  })
}

export async function nativeAudioObservations(
  root: string,
  requestID: string,
  intelligibility?: "pass" | "fail" | "unknown",
): Promise<void> {
  const proof = await verifyOwnedSidecar(root, { allowInteractionRecovery: true })
  const client = makeClient(proof.registration)
  const info = await client.server.info({ signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  if (info.pid !== proof.health.pid || info.version !== proof.health.version)
    throw new Error("Authenticated owned sidecar identity changed")
  const binding = nativeBindingFromManifest(proof.manifest)
  const rpc = client.rpc(NativeInteraction)
  const deadline = Date.now() + AUDIO_OBSERVATION_TIMEOUT_MS
  let record = await rpc.audioResult(
    { binding, requestID },
    { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
  )
  if (record === null) throw new Error("No audio observation exists for this owned request")
  const isTerminal = () =>
    record?.events.some(({ event }) =>
      [
        "dictation-complete",
        "dictation-cancelled",
        "dictation-failed",
        "playback-complete",
        "playback-cancelled",
        "playback-failed",
      ].includes(event.kind),
    ) === true
  while (!isTerminal() && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS)
    record = await rpc.audioResult(
      { binding, requestID },
      { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
    )
    if (record === null) throw new Error("Audio observation disappeared while waiting")
  }
  if (!isTerminal())
    throw new Error("Timed out waiting for the owned app audio operation to finish")
  if (intelligibility !== undefined) {
    if (!record.appCompleted || record.kind !== "playback")
      throw new Error("Record intelligibility only after all real app playback segments finish")
    const status = await rpc.status({ binding }, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    if (!status.ready || !status.adapterID)
      throw new Error("Owned native adapter is unavailable for the intelligibility note")
    await rpc.audioObserve(
      {
        binding,
        adapterID: status.adapterID,
        observation: {
          requestID,
          sessionID: record.sessionID,
          window: record.window,
          event: { kind: "intelligibility", value: intelligibility },
        },
      },
      { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
    )
    record = await rpc.audioResult(
      { binding, requestID },
      { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
    )
    if (record === null) throw new Error("Audio observation disappeared after intelligibility note")
  }
  const complete = record.appCompleted
  printResult({
    requestID: record.requestID,
    sessionID: record.sessionID,
    kind: record.kind,
    fixtureID: record.fixtureID,
    route: record.route,
    expectedTextHash: record.expectedTextHash,
    expectedSegments: record.segmentHashes?.length,
    observedEvents: record.events.length,
    observedNaturalEnds: record.events.filter((item) => item.event.kind === "playback-segment-end")
      .length,
    appCompleted: complete,
    intelligibility: record.intelligibility ?? "not-recorded",
    observations: record.events,
    passed: complete,
  })
  if (!complete) throw new Error("Owned audio request did not complete successfully")
}

async function saveScreenshot(
  workspace: string,
  filename: string,
  base64: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png$/.test(filename)) {
    throw new Error("Screenshot output must be a simple .png filename")
  }
  const directory = join(
    resolve(workspace),
    ".agents",
    "docs",
    "evidence",
    "full-instance-qualification",
  )
  const rootInfo = await lstat(join(resolve(workspace), ".agents"))
  const docsInfo = await lstat(join(resolve(workspace), ".agents", "docs"))
  const evidenceInfo = await lstat(join(resolve(workspace), ".agents", "docs", "evidence"))
  if (
    [rootInfo, docsInfo, evidenceInfo].some((item) => !item.isDirectory() || item.isSymbolicLink())
  ) {
    throw new Error("Screenshot evidence directory is not a real workspace directory")
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const outputInfo = await lstat(directory)
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new Error("Screenshot evidence output directory is not a real workspace directory")
  }
  const path = join(directory, filename)
  const bytes = Buffer.from(base64, "base64")
  if (bytes.length === 0 || bytes.length > 3_000_000)
    throw new Error("Screenshot exceeds the evidence size limit")
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(Buffer.from(base64, "base64"))
    await handle.sync()
  } catch (error) {
    await handle.close()
    throw error
  }
  await handle.close()
  return path
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
