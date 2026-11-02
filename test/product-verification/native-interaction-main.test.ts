import { describe, expect, test } from "bun:test"
import type { MainContext } from "@opencode/plugin/gui/main"
import {
  BOUNDED_DOM_SNAPSHOT_SCRIPT,
  NativeInteractionMainAdapter,
  nativeAdapterFailureCategory,
  nativeAdapterFailureHint,
  redactVisibleText,
} from "../../src/verification/opencode/native-interaction-main.ts"
import type {
  NativeWebContents,
  NativeWindow,
} from "../../src/verification/opencode/native-interaction-main.ts"
import type { NativeWindowReference } from "../../src/verification/opencode/native-interaction-contract.ts"

const rawSnapshot = {
  title: "Fixture project",
  text: "Greeting task is ready",
  elements: [
    {
      ref: "e0",
      role: "textbox",
      tag: "input",
      name: "Task prompt",
      text: "",
      inputType: "text",
      editable: true,
      x: 10,
      y: 20,
      width: 300,
      height: 32,
    },
    {
      ref: "e1",
      role: "button",
      tag: "button",
      name: "Submit task",
      text: "Submit task",
      inputType: "",
      editable: false,
      x: 400,
      y: 20,
      width: 100,
      height: 32,
    },
  ],
  truncated: false,
}

function harness(snapshots: unknown[], onRead?: (count: number) => void) {
  const events: unknown[] = []
  const scripts: string[] = []
  let rendererPID = 30001
  let captureCount = 0
  let focused = true
  const webContents: NativeWebContents = {
    id: 42,
    isDestroyed: () => false,
    getOSProcessId: () => rendererPID,
    getURL: () => "oc://renderer/index.html",
    executeJavaScript: async (code) => {
      scripts.push(code)
      onRead?.(scripts.length)
      return snapshots.shift() ?? rawSnapshot
    },
    capturePage: async () => {
      captureCount++
      return { toPNG: () => Buffer.from("png-fixture") }
    },
    sendInputEvent: (event) => events.push(event),
    insertText: (text) => events.push({ insertText: text }),
    on: () => undefined,
    removeListener: () => undefined,
  }
  const window: NativeWindow = {
    id: 12,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => focused,
    focus: () => {
      focused = true
    },
    webContents,
    on: () => undefined,
    removeListener: () => undefined,
  }
  const ctx = {
    windows: { list: () => [window], focused: () => (focused ? window : undefined) },
    signal: new AbortController().signal,
  } as unknown as MainContext
  const adapter = new NativeInteractionMainAdapter(
    ctx,
    "/private/tmp/unused",
    () => 123,
    () => events.push("activate"),
  )
  adapter.trackWindow(window)
  return {
    adapter,
    events,
    scripts,
    window,
    setRendererPID: (pid: number) => (rendererPID = pid),
    setFocused: (value: boolean) => (focused = value),
    captureCount: () => captureCount,
  }
}

function reference(harnessValue: ReturnType<typeof harness>): NativeWindowReference {
  return harnessValue.adapter.currentWindowReferences()[0]!
}

describe("owned native Desktop adapter", () => {
  test("focuses only the referenced owned window and returns a fresh observation without input", async () => {
    const h = harness([rawSnapshot])
    h.setFocused(false)
    const result = await h.adapter.perform({ kind: "focus", window: reference(h) })
    expect(result.delivery).toBe("delivered")
    expect(result.snapshot?.window.focused).toBe(true)
    expect(h.events).toEqual(["activate"])
    expect(
      await h.adapter.perform({ kind: "focus", window: { ...reference(h), generation: 999 } }),
    ).toMatchObject({ delivery: "not-delivered" })
  })
  test("categorizes startup failures without logging untrusted error details", () => {
    expect(
      nativeAdapterFailureCategory(
        new Error("Owned Desktop native adapter did not become ready", {
          cause: new Error("Owned sidecar is not in a ready verification state"),
        }),
      ),
    ).toBe("launch-not-ready")
    expect(nativeAdapterFailureCategory(new Error("untrusted token=secret"))).toBe(
      "adapter-readiness-check-failed",
    )
    expect(
      nativeAdapterFailureCategory(
        new Error("Owned launch verification failed", {
          cause: new Error("Owned service process identity is unavailable or changed"),
        }),
      ),
    ).toBe("service-process-identity-mismatch")
    expect(nativeAdapterFailureCategory(new Error("Native sidecar endpoint lookup failed"))).toBe(
      "sidecar-endpoint-lookup-failed",
    )
    expect(nativeAdapterFailureCategory(new Error("Native adapter RPC attachment failed"))).toBe(
      "sidecar-rpc-attach-failed",
    )
  })

  test("keeps startup failure hints bounded and redacts secrets, URLs, and local paths", () => {
    const hint = nativeAdapterFailureHint(
      new Error("wrapper", {
        cause: new Error(
          "Could not read /private/var/folders/private.json from https://user:secret@example.invalid/api?token=abc123456789 with password=do-not-log",
        ),
      }),
    )
    expect(hint.length).toBeLessThanOrEqual(180)
    expect(hint).toContain("Could not read")
    expect(hint).not.toContain("/private/")
    expect(hint).not.toContain("example.invalid")
    expect(hint).not.toContain("secret")
    expect(hint).not.toContain("do-not-log")
    expect(hint).not.toContain("abc123456789")
  })

  test("uses one fixed bounded rendered-DOM script without reading form values or invoking handlers", async () => {
    expect(BOUNDED_DOM_SNAPSHOT_SCRIPT).toContain("MAX_TEXT = 3000")
    expect(BOUNDED_DOM_SNAPSHOT_SCRIPT).toContain("MAX_ELEMENTS = 100")
    expect(BOUNDED_DOM_SNAPSHOT_SCRIPT).toContain("document.querySelectorAll")
    expect(BOUNDED_DOM_SNAPSHOT_SCRIPT).not.toContain(".value")
    expect(BOUNDED_DOM_SNAPSHOT_SCRIPT).not.toContain("localStorage")
    expect(BOUNDED_DOM_SNAPSHOT_SCRIPT).not.toContain("eval(")
    expect(BOUNDED_DOM_SNAPSHOT_SCRIPT).not.toContain(".click(")
    expect(BOUNDED_DOM_SNAPSHOT_SCRIPT).not.toContain("a[href]")

    const target = harness([rawSnapshot])
    const result = await target.adapter.perform({ kind: "snapshot", window: reference(target) })
    expect(result.delivery).toBe("delivered")
    expect(result.snapshot?.elements).toHaveLength(2)
    expect(target.scripts).toEqual([BOUNDED_DOM_SNAPSHOT_SCRIPT])
    expect(JSON.stringify(result.snapshot)).not.toContain("value")
  })

  test("redacts common visible credentials and rejects credential-bearing screenshot pages", async () => {
    expect(
      redactVisibleText("Bearer abcdefghijklmnop api_key=secret_value_123456 sk-abcdefghijklmnop"),
    ).toBe("Bearer [REDACTED] api_key=[REDACTED] [REDACTED]")
    const sensitive = {
      ...rawSnapshot,
      text: "Authorization: Bearer abcdefghijklmnop",
    }
    const target = harness([sensitive])
    const result = await target.adapter.perform({ kind: "capture", window: reference(target) })
    expect(result.delivery).toBe("not-delivered")
    expect(result.snapshot?.text).toContain("[REDACTED]")
    expect(target.captureCount()).toBe(0)
  })

  test("dispatches native input and returns a fresh post-action observation", async () => {
    const after = { ...rawSnapshot, text: "Greeting task was submitted" }
    const target = harness([rawSnapshot, rawSnapshot, after])
    const initial = await target.adapter.perform({ kind: "snapshot", window: reference(target) })
    const snapshotID = initial.snapshot!.snapshotID
    const result = await target.adapter.perform({
      kind: "type",
      window: reference(target),
      snapshotID,
      elementRef: "e0",
      text: "Return Hello, world!",
    })
    expect(result.delivery).toBe("delivered")
    expect(result.snapshot?.snapshotID).not.toBe(snapshotID)
    expect(result.snapshot?.text).toBe("Greeting task was submitted")
    expect(target.events).toEqual([
      { type: "mouseDown", x: 160, y: 36, button: "left", clickCount: 1 },
      { type: "mouseUp", x: 160, y: 36, button: "left", clickCount: 1 },
      { insertText: "Return Hello, world!" },
    ])
  })

  test("rejects a stale rendered snapshot without sending native input", async () => {
    const changed = { ...rawSnapshot, text: "The UI changed after observation" }
    const target = harness([rawSnapshot, changed])
    const initial = await target.adapter.perform({ kind: "snapshot", window: reference(target) })
    const result = await target.adapter.perform({
      kind: "click",
      window: reference(target),
      snapshotID: initial.snapshot!.snapshotID,
      elementRef: "e1",
    })
    expect(result.delivery).toBe("not-delivered")
    expect(result.message).toContain("changed after")
    expect(result.snapshot?.text).toBe(changed.text)
    expect(target.events).toHaveLength(0)
  })

  test("refuses native input if the owned Desktop window loses focus after observation", async () => {
    const target = harness([rawSnapshot, rawSnapshot])
    const observedWindow = reference(target)
    const initial = await target.adapter.perform({ kind: "snapshot", window: observedWindow })
    target.setFocused(false)
    const result = await target.adapter.perform({
      kind: "click",
      window: observedWindow,
      snapshotID: initial.snapshot!.snapshotID,
      elementRef: "e1",
    })
    expect(result.delivery).toBe("not-delivered")
    expect(result.message).toContain("lost focus")
    expect(target.events).toHaveLength(0)
  })

  test("rechecks focus and renderer identity after the awaited DOM read before any input", async () => {
    for (const change of ["focus", "renderer"] as const) {
      const target = harness([rawSnapshot, rawSnapshot], (count) => {
        if (count !== 2) return
        if (change === "focus") target.setFocused(false)
        else target.setRendererPID(30002)
      })
      const window = reference(target)
      const initial = await target.adapter.perform({ kind: "snapshot", window })
      const result = await target.adapter.perform({
        kind: "click",
        window,
        snapshotID: initial.snapshot!.snapshotID,
        elementRef: "e1",
      })
      expect(result.delivery).toBe("not-delivered")
      expect(result.message).toContain("changed before native input")
      expect(target.events).toHaveLength(0)
    }
  })

  test("rejects a changed renderer generation and never replays after delivery uncertainty", async () => {
    const target = harness([rawSnapshot])
    const oldReference = reference(target)
    target.setRendererPID(30002)
    const result = await target.adapter.perform({ kind: "snapshot", window: oldReference })
    expect(result.delivery).toBe("not-delivered")
    expect(target.scripts).toHaveLength(0)
  })

  test("uses capturePage and refuses credential-like text entry before any input", async () => {
    const target = harness([rawSnapshot])
    const snapshot = await target.adapter.perform({ kind: "snapshot", window: reference(target) })
    const result = await target.adapter.perform({
      kind: "type",
      window: reference(target),
      snapshotID: snapshot.snapshot!.snapshotID,
      elementRef: "e0",
      text: "Bearer abcdefghijklmnop",
    })
    expect(result.delivery).toBe("not-delivered")
    expect(target.events).toHaveLength(0)
    const capture = await target.adapter.perform({ kind: "capture", window: reference(target) })
    expect(capture.delivery).toBe("delivered")
    expect(Buffer.from(capture.screenshotBase64!, "base64").toString()).toBe("png-fixture")
    expect(target.captureCount()).toBe(1)
  })
})
