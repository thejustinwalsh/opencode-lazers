import type { MainContext } from "@opencode/plugin/gui/main"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { nativeBindingFromManifest, verifyOwnedLaunch } from "./owned-launch.ts"
import {
  NativeInteraction,
  type NativeActionResult,
  type NativeBinding,
  type NativeElement,
  type NativeOperation,
  type NativeSnapshot,
  type NativeWindowReference,
} from "./native-interaction-contract.ts"

export const BOUNDED_DOM_SNAPSHOT_SCRIPT = `(() => {
  const MAX_TEXT = 3000;
  const MAX_ELEMENTS = 100;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
      style.visibility !== "hidden" && Number(style.opacity) !== 0;
  };
  const clean = (value, limit) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, limit);
  const controls = Array.from(document.querySelectorAll(
    "button,[role=button],input,textarea,select,[contenteditable=true]"
  ));
  const elements = controls.filter((element) =>
    visible(element) && !(element.tagName === "A" && element.hasAttribute("href"))
  ).slice(0, MAX_ELEMENTS).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const role = clean(element.getAttribute("role") || tag, 40);
    const name = clean(element.getAttribute("aria-label") || element.getAttribute("title") ||
      element.getAttribute("placeholder") || element.innerText || element.textContent, 160);
    return {
      ref: "e" + index,
      role,
      tag,
      name,
      text: clean(element.innerText || element.textContent, 160),
      inputType: tag === "input" ? clean(element.getAttribute("type") || "text", 40) : "",
      editable: tag === "input" || tag === "textarea" ||
        element.getAttribute("contenteditable") === "true",
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  });
  return {
    title: clean(document.title, 160),
    text: clean(document.body?.innerText || "", MAX_TEXT),
    elements,
    truncated: controls.length > MAX_ELEMENTS || (document.body?.innerText || "").length > MAX_TEXT,
  };
})()`

const ADAPTER_STARTUP_TIMEOUT_MS = 30_000

export type NativeInputEvent =
  | { type: "mouseDown" | "mouseUp"; x: number; y: number; button: "left"; clickCount: 1 }
  | { type: "keyDown" | "keyUp"; keyCode: string }

export type NativeWebContents = {
  readonly id: number
  isDestroyed(): boolean
  getOSProcessId(): number
  getURL(): string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  capturePage(): Promise<{ toPNG(): Buffer }>
  sendInputEvent(event: NativeInputEvent): void
  insertText(text: string): void
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
}

export type NativeWindow = {
  readonly id: number
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  show(): void
  focus(): void
  readonly webContents: NativeWebContents
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
}

type WindowTracker = {
  window: NativeWindow
  contents: NativeWebContents
  generation: number
  rendererPID: number
  onNavigation: (...args: unknown[]) => void
  onRendererGone: (...args: unknown[]) => void
  onClosed: (...args: unknown[]) => void
}

type SnapshotRecord = {
  snapshot: NativeSnapshot
  digest: string
  sensitiveVisible: boolean
}

export function redactVisibleText(value: string): string {
  return value
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi,
      "[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /\b((?:authorization|password|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:token|password|secret|key|api_key)=)[^&\s]*/gi, "$1[REDACTED]")
}

function stringField(value: unknown, max: number): string {
  return typeof value === "string" ? redactVisibleText(value.slice(0, max)) : ""
}

function rawElement(value: unknown): NativeElement | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const element = value as Record<string, unknown>
  const numbers = [element.x, element.y, element.width, element.height]
  if (numbers.some((number) => typeof number !== "number" || !Number.isFinite(number)))
    return undefined
  return {
    ref: stringField(element.ref, 32),
    role: stringField(element.role, 40),
    tag: stringField(element.tag, 24),
    name: stringField(element.name, 160),
    text: stringField(element.text, 160),
    inputType: stringField(element.inputType, 40),
    editable: element.editable === true,
    x: element.x as number,
    y: element.y as number,
    width: element.width as number,
    height: element.height as number,
  }
}

function stableSnapshot(snapshot: {
  title: string
  text: string
  elements: NativeElement[]
  truncated: boolean
}): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
}

export function nativeSnapshotMatches(
  previousSnapshot: NativeSnapshot | undefined,
  previousDigest: string | undefined,
  operation: Extract<NativeOperation, { kind: "click" | "type" | "key" }>,
  currentDigest: string,
  currentWindow: NativeWindowReference,
): boolean {
  return (
    previousSnapshot !== undefined &&
    previousDigest !== undefined &&
    previousSnapshot.snapshotID === operation.snapshotID &&
    sameWindow(previousSnapshot.window, operation.window) &&
    sameWindow(currentWindow, operation.window) &&
    previousDigest === currentDigest
  )
}

export function nativeAdapterFailureCategory(error: unknown): string {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    messages.push(current.message)
    current = current.cause
  }
  const patterns: Array<[RegExp, string]> = [
    [/candidate source or built gui identity/i, "candidate-identity-mismatch"],
    [
      /service registration path|service registration (?:is not a regular file|no longer matches)/i,
      "service-registration-mismatch",
    ],
    [/owned service process identity/i, "service-process-identity-mismatch"],
    [/owned desktop process identity/i, "desktop-process-identity-mismatch"],
    [/desktop is not using its isolated test-root profile/i, "desktop-profile-mismatch"],
    [/not in a ready verification state/i, "launch-not-ready"],
    [/native desktop process identity check failed/i, "desktop-runtime-identity-check-failed"],
    [/owned launch verification failed/i, "owned-launch-verification-failed"],
    [
      /native adapter is not running in the owned desktop process/i,
      "desktop-runtime-identity-mismatch",
    ],
    [/sidecar endpoint lookup failed/i, "sidecar-endpoint-lookup-failed"],
    [
      /sidecar endpoint is unavailable|sidecar endpoint is not local/i,
      "sidecar-endpoint-unavailable",
    ],
    [
      /sidecar endpoint does not match|not connected to the owned sidecar/i,
      "sidecar-endpoint-mismatch",
    ],
    [/sidecar authentication probe failed/i, "sidecar-authentication-probe-failed"],
    [/authenticated desktop sidecar identity changed/i, "sidecar-authentication-mismatch"],
    [/native (?:adapter )?rpc attachment failed/i, "sidecar-rpc-attach-failed"],
    [/different native adapter generation/i, "adapter-generation-conflict"],
  ]
  for (const [pattern, category] of patterns) {
    if (messages.some((message) => pattern.test(message))) return category
  }
  return "adapter-readiness-check-failed"
}

export function nativeAdapterFailureHint(error: unknown): string {
  let message = ""
  let current: unknown = error
  for (let depth = 0; depth < 6; depth++) {
    if (current instanceof Error) {
      if (current.message.length > 0) message = current.message
      current = current.cause
      continue
    }
    if (typeof current === "object" && current !== null && "message" in current) {
      const candidate = (current as { message?: unknown }).message
      if (typeof candidate === "string" && candidate.length > 0) message = candidate
    }
    break
  }
  if (message.length === 0) return "No safe startup error detail was available"
  return redactVisibleText(message)
    .replace(/\b(?:https?|file):\/\/[^\s)'"<>]+/gi, "[endpoint]")
    .replace(
      /(?:^|\s)(\/?(?:Users|private|Applications|Library|opt|var|tmp|System|Volumes)\/[^\s,'";)]+)/g,
      " [path]",
    )
    .replace(
      /\b((?:authorization|password|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]?\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^A-Za-z0-9 .,:;_(){}-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
}

export function dispatchNativeInput(
  webContents: NativeWebContents,
  operation: Extract<NativeOperation, { kind: "click" | "type" | "key" }>,
  element?: NativeElement,
): void {
  if (operation.kind === "click" || operation.kind === "type") {
    if (element === undefined || element.width <= 0 || element.height <= 0) {
      throw new Error("Rendered native target is unavailable")
    }
    if (
      operation.kind === "type" &&
      (!element.editable || sensitiveInput(element) || hasLikelyCredential(operation.text))
    ) {
      throw new Error("Native text target or content is not allowed")
    }
    const x = Math.round(element.x + element.width / 2)
    const y = Math.round(element.y + element.height / 2)
    webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 })
    webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 })
    if (operation.kind === "type") webContents.insertText(operation.text)
    return
  }
  webContents.sendInputEvent({ type: "keyDown", keyCode: operation.key })
  webContents.sendInputEvent({ type: "keyUp", keyCode: operation.key })
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined"
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
    .join(",")}}`
}

function allowedRendererURL(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === "oc:" &&
      url.host === "renderer" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    )
  } catch {
    return false
  }
}

export class NativeInteractionMainAdapter {
  private readonly adapterID = crypto.randomUUID()
  private readonly windows = new Map<number, WindowTracker>()
  private readonly snapshots = new Map<number, SnapshotRecord>()
  private binding?: NativeBinding
  private stopped = false
  private unwatchOpen?: () => void
  private unwatchClose?: () => void

  constructor(
    private readonly ctx: MainContext,
    private readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly activate: () => void = () => {
      const electron = createRequire(join(root, "native-focus.cjs"))("electron") as {
        app: { focus(options: { steal: boolean }): void }
      }
      electron.app.focus({ steal: true })
    },
  ) {}

  async start(): Promise<void> {
    const deadline = Date.now() + ADAPTER_STARTUP_TIMEOUT_MS
    let binding: NativeBinding | undefined
    let lastError: unknown
    while (!this.stopped && !this.ctx.signal.aborted && Date.now() < deadline) {
      try {
        binding = await this.verifyRuntime(false)
        break
      } catch (error) {
        lastError = error
      }
      await this.delay(250)
    }
    if (binding === undefined) {
      if (this.stopped || this.ctx.signal.aborted) return
      throw new Error("Owned Desktop native adapter did not become ready", { cause: lastError })
    }
    this.binding = binding
    for (const window of this.ctx.windows.list()) this.track(window as unknown as NativeWindow)
    this.unwatchOpen = this.ctx.windows.on("open", (window) =>
      this.track(window as unknown as NativeWindow),
    )
    this.unwatchClose = this.ctx.windows.on("close", (window) => this.forget(window.id))
    try {
      await this.rpc().attach({
        binding,
        adapterID: this.adapterID,
        windows: this.windowReferences(),
      })
    } catch (error) {
      throw new Error("Native adapter RPC attachment failed", { cause: error })
    }
    void this.poll()
  }

  trackWindow(window: NativeWindow): void {
    this.track(window)
  }

  currentWindowReferences(): NativeWindowReference[] {
    return this.windowReferences()
  }

  perform(operation: NativeOperation): Promise<NativeActionResult> {
    return this.execute(operation)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.unwatchOpen?.()
    this.unwatchClose?.()
    this.unwatchOpen = undefined
    this.unwatchClose = undefined
    for (const id of this.windows.keys()) this.forget(id)
    const binding = this.binding
    if (binding !== undefined) {
      void this.rpc()
        .detach({ binding, adapterID: this.adapterID })
        .catch(() => undefined)
    }
  }

  private rpc() {
    return this.ctx.client.rpc(NativeInteraction)
  }

  private async verifyRuntime(allowPending: boolean): Promise<NativeBinding> {
    let proof: Awaited<ReturnType<typeof verifyOwnedLaunch>>
    try {
      proof = await verifyOwnedLaunch(this.root, { allowPendingInteraction: allowPending })
    } catch (error) {
      throw new Error("Owned launch verification failed", { cause: error })
    }
    let ownedDesktopProcess: boolean
    try {
      ownedDesktopProcess =
        this.ctx.app.version === proof.manifest.target.version &&
        process.pid === proof.manifest.desktop?.pid &&
        (await realpath(process.execPath)) ===
          (await realpath(
            join(proof.manifest.target.desktopBundle, "Contents", "MacOS", "OpenCode"),
          ))
    } catch (error) {
      throw new Error("Native Desktop process identity check failed", { cause: error })
    }
    if (!ownedDesktopProcess) {
      throw new Error("Native adapter is not running in the owned Desktop process")
    }
    let endpoint
    try {
      endpoint = this.ctx.serverEndpoints.get("sidecar")
    } catch (error) {
      throw new Error("Native sidecar endpoint lookup failed", { cause: error })
    }
    if (endpoint === undefined) throw new Error("Native sidecar endpoint is unavailable")
    if (!endpoint.sameMachine) throw new Error("Native sidecar endpoint is not local")
    if (endpoint.url !== proof.registration.url) {
      throw new Error("Native adapter is not connected to the owned sidecar")
    }
    let info
    try {
      info = await this.ctx.client.server.info()
    } catch (error) {
      throw new Error("Native sidecar authentication probe failed", { cause: error })
    }
    if (info.pid !== proof.registration.pid || info.version !== proof.registration.version) {
      throw new Error("Authenticated Desktop sidecar identity changed")
    }
    return nativeBindingFromManifest(proof.manifest)
  }

  private async poll(): Promise<void> {
    while (!this.stopped && !this.ctx.signal.aborted) {
      const binding = this.binding
      if (binding === undefined) return
      let command: { requestID: string; operation: NativeOperation } | null
      try {
        command = await this.rpc().poll(
          { binding, adapterID: this.adapterID, windows: this.windowReferences() },
          { signal: AbortSignal.any([this.ctx.signal, AbortSignal.timeout(2_000)]) },
        )
      } catch {
        await this.delay(250)
        continue
      }
      if (command !== null) {
        let result: NativeActionResult
        try {
          const currentBinding = await this.verifyRuntime(true)
          if (stableValue(currentBinding) !== stableValue(binding)) {
            throw new Error("Owned native binding changed")
          }
          result = await this.execute(command.operation)
        } catch {
          result = { delivery: "not-delivered", message: "Owned native preflight failed" }
        }
        try {
          await this.rpc().complete({
            binding,
            adapterID: this.adapterID,
            requestID: command.requestID,
            result,
          })
        } catch {
          // The caller will retain the request as ambiguous and must resolve by this ID.
        }
      }
      await this.delay(100)
    }
  }

  private async execute(operation: NativeOperation): Promise<NativeActionResult> {
    const window = this.resolveWindow(operation.window)
    if (window === undefined)
      return { delivery: "not-delivered", message: "Native window reference is stale" }
    if (!window.isVisible())
      return { delivery: "not-delivered", message: "Owned Desktop window is not visible" }
    const currentReference = this.currentReference(window.id)
    if (currentReference === undefined)
      return { delivery: "not-delivered", message: "Native window reference is stale" }
    if (operation.kind === "focus") {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer)
          window.removeListener("focus", finish)
          resolve()
        }
        const timer = setTimeout(finish, 1_000)
        window.on("focus", finish)
        try {
          this.activate()
          window.show()
          window.focus()
          if (window.isFocused()) finish()
        } catch (error) {
          clearTimeout(timer)
          window.removeListener("focus", finish)
          reject(error)
        }
      })
      const focused = this.currentReference(window.id)
      if (
        focused === undefined ||
        !sameWindow(focused, operation.window) ||
        !focused.focused ||
        !window.isFocused()
      )
        return { delivery: "not-delivered", message: "Owned Desktop window could not be focused" }
      const snapshot = await this.readSnapshot(window, focused)
      const after = this.currentReference(window.id)
      if (
        after === undefined ||
        !sameWindow(after, operation.window) ||
        !after.focused ||
        !window.isFocused()
      )
        return {
          delivery: "not-delivered",
          message: "Owned Desktop window changed during focus observation",
        }
      return { delivery: "delivered", snapshot }
    }
    if (operation.kind === "snapshot") {
      return { delivery: "delivered", snapshot: await this.readSnapshot(window, currentReference) }
    }
    if (operation.kind === "capture") {
      const snapshot = await this.readSnapshot(window, currentReference)
      if (this.snapshots.get(window.id)?.sensitiveVisible) {
        return {
          delivery: "not-delivered",
          message: "Rendered text resembles credential material; screenshot capture was refused",
          snapshot,
        }
      }
      const image = await window.webContents.capturePage()
      const png = image.toPNG()
      const screenshotBase64 = png.toString("base64")
      if (screenshotBase64.length > 4_000_000) {
        return {
          delivery: "not-delivered",
          message: "Rendered page capture exceeds the evidence size bound",
          snapshot,
        }
      }
      return { delivery: "delivered", snapshot, screenshotBase64 }
    }
    if (!currentReference.focused || !window.isFocused()) {
      return {
        delivery: "not-delivered",
        message: "Owned Desktop window lost focus before native input",
      }
    }

    const previous = this.snapshots.get(window.id)
    if (
      previous === undefined ||
      previous.snapshot.snapshotID !== operation.snapshotID ||
      !sameWindow(previous.snapshot.window, operation.window)
    ) {
      return {
        delivery: "not-delivered",
        message: "Snapshot reference is stale; take a fresh observation",
      }
    }
    const current = await this.readSnapshot(window, currentReference)
    const currentRecord = this.snapshots.get(window.id)
    if (
      !nativeSnapshotMatches(
        previous.snapshot,
        previous.digest,
        operation,
        currentRecord?.digest ?? "",
        current.window,
      )
    ) {
      return {
        delivery: "not-delivered",
        message: "Rendered page changed after the referenced snapshot",
        snapshot: current,
      }
    }
    const element =
      operation.kind === "click" || operation.kind === "type"
        ? current.elements.find((item) => item.ref === operation.elementRef)
        : undefined
    if ((operation.kind === "click" || operation.kind === "type") && element === undefined) {
      return {
        delivery: "not-delivered",
        message: "Target element is not in the current rendered snapshot",
        snapshot: current,
      }
    }
    if (
      operation.kind === "type" &&
      element !== undefined &&
      (!element.editable || sensitiveInput(element))
    ) {
      return {
        delivery: "not-delivered",
        message: "Text input target is not an editable control",
        snapshot: current,
      }
    }
    if (operation.kind === "type" && hasLikelyCredential(operation.text)) {
      return {
        delivery: "not-delivered",
        message: "Credential-like text is not accepted",
        snapshot: current,
      }
    }

    const dispatchReference = this.currentReference(window.id)
    if (
      dispatchReference === undefined ||
      !sameWindow(dispatchReference, operation.window) ||
      !dispatchReference.visible ||
      !dispatchReference.focused ||
      !window.isFocused()
    ) {
      return { delivery: "not-delivered", message: "Owned window changed before native input" }
    }

    let attempted = false
    try {
      attempted = true
      dispatchNativeInput(window.webContents, operation, element)
      const afterReference = this.currentReference(window.id)
      if (afterReference === undefined) throw new Error("Window generation changed after input")
      const snapshot = await this.readSnapshot(window, afterReference)
      return { delivery: "delivered", snapshot }
    } catch {
      let snapshot: NativeSnapshot | undefined
      try {
        const afterReference = this.currentReference(window.id)
        if (afterReference !== undefined) snapshot = await this.readSnapshot(window, afterReference)
      } catch {
        // A missing post-action observation is itself an ambiguity.
      }
      return {
        delivery: attempted ? "ambiguous" : "not-delivered",
        message: attempted
          ? "Native input delivery could not be confirmed; do not replay"
          : "Native input was not dispatched",
        ...(snapshot === undefined ? {} : { snapshot }),
      }
    }
  }

  private async readSnapshot(
    window: NativeWindow,
    reference: NativeWindowReference,
  ): Promise<NativeSnapshot> {
    this.assertCurrentWindow(window, reference)
    const raw = await window.webContents.executeJavaScript(BOUNDED_DOM_SNAPSHOT_SCRIPT, false)
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
    const elements = Array.isArray(record.elements)
      ? record.elements
          .map(rawElement)
          .filter((element): element is NativeElement => element !== undefined)
          .slice(0, 100)
      : []
    const rawText = [
      record.title,
      record.text,
      ...(Array.isArray(record.elements)
        ? record.elements.flatMap((item) => {
            if (typeof item !== "object" || item === null) return []
            const element = item as Record<string, unknown>
            return [element.name, element.text]
          })
        : []),
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
    const content = {
      title: stringField(record.title, 160),
      text: stringField(record.text, 3_000),
      elements,
      truncated: record.truncated === true,
    }
    const digest = stableSnapshot(content)
    const snapshot: NativeSnapshot = {
      ...content,
      window: reference,
      snapshotID: crypto.randomUUID(),
      capturedAt: this.now(),
    }
    this.snapshots.set(window.id, {
      snapshot,
      digest,
      sensitiveVisible: hasLikelyCredential(rawText),
    })
    return snapshot
  }

  private resolveWindow(reference: NativeWindowReference): NativeWindow | undefined {
    const tracker = this.windows.get(reference.windowID)
    if (tracker === undefined || !this.matches(tracker, reference)) return undefined
    return tracker.window
  }

  private currentReference(windowID: number): NativeWindowReference | undefined {
    return this.windowReferences().find((reference) => reference.windowID === windowID)
  }

  private assertCurrentWindow(window: NativeWindow, reference: NativeWindowReference): void {
    const tracker = this.windows.get(window.id)
    if (tracker === undefined || !this.matches(tracker, reference)) {
      throw new Error("Native window generation changed")
    }
  }

  private matches(tracker: WindowTracker, reference: NativeWindowReference): boolean {
    if (tracker.window.isDestroyed() || tracker.window.webContents.isDestroyed()) return false
    const rendererPID = safeRendererPID(tracker.window.webContents)
    if (rendererPID !== tracker.rendererPID) {
      tracker.rendererPID = rendererPID
      tracker.generation++
      this.snapshots.delete(tracker.window.id)
    }
    return (
      tracker.window.id === reference.windowID &&
      tracker.window.webContents.id === reference.webContentsID &&
      tracker.rendererPID === reference.rendererPID &&
      tracker.generation === reference.generation &&
      allowedRendererURL(tracker.window.webContents.getURL())
    )
  }

  private track(window: NativeWindow): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    const windowID = window.id
    const contents = window.webContents
    const existing = this.windows.get(windowID)
    if (existing !== undefined && existing.contents.id === contents.id) return
    if (existing !== undefined) this.forget(windowID)
    const onNavigation = () => this.invalidate(windowID)
    const onRendererGone = () => this.invalidate(windowID)
    const onClosed = () => this.forget(windowID)
    contents.on("did-start-navigation", onNavigation)
    contents.on("render-process-gone", onRendererGone)
    contents.on("destroyed", onRendererGone)
    window.on("closed", onClosed)
    this.windows.set(windowID, {
      window,
      contents,
      generation: 1,
      rendererPID: safeRendererPID(contents),
      onNavigation,
      onRendererGone,
      onClosed,
    })
  }

  private invalidate(windowID: number): void {
    const tracker = this.windows.get(windowID)
    if (tracker === undefined) return
    tracker.generation++
    tracker.rendererPID = safeRendererPID(tracker.contents)
    this.snapshots.delete(windowID)
  }

  private forget(windowID: number): void {
    const tracker = this.windows.get(windowID)
    if (tracker === undefined) return
    tracker.contents.removeListener("did-start-navigation", tracker.onNavigation)
    tracker.contents.removeListener("render-process-gone", tracker.onRendererGone)
    tracker.contents.removeListener("destroyed", tracker.onRendererGone)
    tracker.window.removeListener("closed", tracker.onClosed)
    this.windows.delete(windowID)
    this.snapshots.delete(windowID)
  }

  private windowReferences(): NativeWindowReference[] {
    const focusedID = this.ctx.windows.focused()?.id
    const references: NativeWindowReference[] = []
    for (const raw of this.ctx.windows.list()) {
      const window = raw as unknown as NativeWindow
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      if (!allowedRendererURL(window.webContents.getURL())) continue
      this.track(window)
      const tracker = this.windows.get(window.id)
      if (tracker === undefined) continue
      const rendererPID = safeRendererPID(window.webContents)
      if (rendererPID < 1) continue
      if (rendererPID !== tracker.rendererPID) {
        tracker.rendererPID = rendererPID
        tracker.generation++
        this.snapshots.delete(window.id)
      }
      references.push({
        windowID: window.id,
        webContentsID: window.webContents.id,
        rendererPID,
        generation: tracker.generation,
        visible: window.isVisible(),
        focused: window.isFocused() && focusedID === window.id,
      })
    }
    return references.slice(0, 32)
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolvePromise) => {
      const finish = () => {
        this.ctx.signal.removeEventListener("abort", onAbort)
        resolvePromise()
      }
      const timer = setTimeout(finish, ms)
      const onAbort = () => {
        clearTimeout(timer)
        finish()
      }
      this.ctx.signal.addEventListener("abort", onAbort, { once: true })
    })
  }
}

function safeRendererPID(webContents: NativeWebContents): number {
  try {
    const pid = webContents.getOSProcessId()
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

function sameWindow(left: NativeWindowReference, right: NativeWindowReference): boolean {
  return (
    left.windowID === right.windowID &&
    left.webContentsID === right.webContentsID &&
    left.rendererPID === right.rendererPID &&
    left.generation === right.generation
  )
}

function hasLikelyCredential(value: string): boolean {
  return /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{8,}|(?:authorization|password|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s,;]{8,})\b/i.test(
    value,
  )
}

function sensitiveInput(element: NativeElement): boolean {
  return (
    element.inputType.toLowerCase() === "password" ||
    /(?:password|secret|token|api[ _-]?key|credential|authorization)/i.test(
      `${element.name} ${element.role}`,
    )
  )
}

export function setupNativeInteractionMain(ctx: MainContext): void | (() => void) {
  const root = process.env.OPENCODE_DESKTOP_TEST_ROOT
  if (root === undefined || root.length === 0) return
  const adapter = new NativeInteractionMainAdapter(ctx, root)
  void adapter.start().catch((error: unknown) => {
    adapter.stop()
    try {
      ctx.log.write("warn", "Owned LAZERS native verification adapter is unavailable", {
        reason: nativeAdapterFailureCategory(error),
        detail: nativeAdapterFailureHint(error),
      })
    } catch {
      // Verification support must never affect Desktop startup.
    }
  })
  const abort = () => adapter.stop()
  ctx.signal.addEventListener("abort", abort, { once: true })
  return () => {
    ctx.signal.removeEventListener("abort", abort)
    adapter.stop()
  }
}
