import { OpenCode } from "@opencode/client"
import { lstat, mkdir, open } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  beginNativeInteraction,
  nativeBindingFromManifest,
  resolveNativeInteraction,
  verifyOwnedLaunch,
  verifyOwnedSidecar,
} from "./owned-launch.ts"
import {
  NativeInteraction,
  type NativeOperation,
  type NativeWindowReference,
} from "./native-interaction-contract.ts"

const REQUEST_TIMEOUT_MS = 30_000
const RPC_TIMEOUT_MS = 3_000
const POLL_INTERVAL_MS = 200
const allowedKeys = new Set(["Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown"])
type NativeKey = "Enter" | "Escape" | "Tab" | "Backspace" | "ArrowUp" | "ArrowDown"

type NativeKind = "snapshot" | "capture" | "click" | "type" | "key"

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

function operation(input: NativeCommandInput, window: NativeWindowReference): NativeOperation {
  if (input.kind === "snapshot" || input.kind === "capture") {
    return { kind: input.kind, window }
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
  if (input.key === undefined || !allowedKeys.has(input.key)) {
    throw new Error("Native key must be one of Enter, Escape, Tab, Backspace, ArrowUp or ArrowDown")
  }
  return { kind: "key", window, snapshotID, key: input.key as NativeKey }
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
    interaction: proof.manifest.nativeInteraction ?? { state: "idle" },
    candidate: {
      workspace: proof.manifest.candidate.workspace,
      revision: proof.manifest.candidate.revision,
      dirtyPaths: proof.manifest.candidate.dirtyPaths,
    },
    service: { pid: proof.health.pid, version: proof.health.version, url: proof.registration.url },
  })
}

export async function runNativeInteraction(input: NativeCommandInput): Promise<void> {
  if (input.kind === "capture" && (input.output === undefined || !input.confirmSafePage)) {
    throw new Error("Rendered screenshots require --output <name.png> and --confirm-safe-page yes")
  }
  const preflight = await verifyOwnedLaunch(input.root)
  const requestID = crypto.randomUUID()
  const lease = await beginNativeInteraction(input.root, requestID, input.kind)
  let mayHaveReachedSidecar = false
  let finishAttempted = false
  try {
    const proof = await verifyOwnedLaunch(input.root, { allowPendingInteraction: true })
    const client = makeClient(proof.registration)
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
    const command = operation(input, target)
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
): Promise<void> {
  const proof = await verifyOwnedSidecar(root, { allowInteractionRecovery: true })
  if (proof.manifest.nativeInteraction?.requestID !== requestID) {
    throw new Error("Request ID does not match the unresolved native interaction")
  }
  const client = makeClient(proof.registration)
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
  const manifest = await resolveNativeInteraction(root, requestID, result.result.delivery)
  printResult({
    requestID,
    state: result.state,
    delivery: result.result.delivery,
    resolved: manifest.nativeInteraction?.state === "idle",
    replayed: false,
    snapshot: result.result.snapshot,
  })
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
