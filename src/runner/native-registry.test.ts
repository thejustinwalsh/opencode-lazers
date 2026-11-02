import { expect, test } from "bun:test"

type NativeModule = typeof import("./native.ts")
type LocalLoader = {
  read(entrypoint: string): Promise<{ module: unknown }>
  dispose(): void
}

test("native idle ownership and ordering survive separate pinned local-loader generations", async () => {
  // Exercise the pinned host loader only in this integration test, never in plugin code.
  const source = (await import(
    new URL("./source.js", import.meta.resolve("@opencode/plugin/host")).href
  )) as { createPluginSources(watch: (file: string) => Promise<void>): LocalLoader }
  const first = source.createPluginSources(async () => {})
  const second = source.createPluginSources(async () => {})
  const entrypoint = new URL("./native.ts", import.meta.url).href
  const sessionID = `ses_registry_${crypto.randomUUID()}`
  const ownerA = Symbol("first location")
  const ownerB = Symbol("second location")
  let a: NativeModule | undefined
  let b: NativeModule | undefined
  try {
    a = (await first.read(entrypoint)).module as NativeModule
    a.advanceNativeIdleSequence(sessionID, 40, ownerA)
    a.observeNativeIdleBackground(
      sessionID,
      [],
      { inputID: "msg_owned", executionStartSequence: 39, eventSequence: 40 },
      Date.now(),
      ownerA,
    )
    const fenceA = a.nativeIdleObservationFence(sessionID, ownerA)
    b = (await second.read(entrypoint)).module as NativeModule
    expect(b).not.toBe(a)
    expect(b.nativeIdleObservationFence(sessionID, ownerA)()).toBe(true)
    expect(b.advanceNativeIdleSequence(sessionID, 22, ownerB)).toBe("stale")
    expect(b.markNativeIdleBackgroundUnknown(sessionID, "old listener", ownerB)).toBe(false)
    expect(fenceA()).toBe(true)

    expect(b.advanceNativeIdleSequence(sessionID, 42, ownerB)).toBe("newer")
    b.observeNativeIdleBackground(
      sessionID,
      [],
      { inputID: "msg_successor", executionStartSequence: 41, eventSequence: 42 },
      Date.now(),
      ownerB,
    )
    const fenceB = b.nativeIdleObservationFence(sessionID, ownerB)
    expect(fenceA()).toBe(false)
    a.invalidateNativeIdleObserver(ownerA, "old location disconnected")
    expect(fenceB()).toBe(true)
    a.releaseNativeIdleObserver(ownerA)
    expect(fenceB()).toBe(true)
    b.releaseNativeIdleObserver(ownerB)
    expect(fenceB()).toBe(false)
  } finally {
    a?.releaseNativeIdleObserver(ownerA)
    b?.releaseNativeIdleObserver(ownerB)
    first.dispose()
    second.dispose()
  }
})
