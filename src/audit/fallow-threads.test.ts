import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FallowModules,
  parseFallowThreads,
  sharedMemoryAvailable,
  ThreadsUnsupported,
} from "./fallow-threads.ts"
import { MAX_FALLOW_THREADS, memoryExhausted, runFallowModule, WasiTrap } from "./fallow-wasi.ts"

/** A command module that returns at once, and one that traps: stand-ins for the real modules. */
const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
const prefix = [
  0x01,
  0x04,
  0x01,
  0x60,
  0x00,
  0x00, // type: () -> ()
  0x03,
  0x02,
  0x01,
  0x00, // one function of that type
  0x05,
  0x03,
  0x01,
  0x00,
  0x01, // one memory
  0x07,
  0x13,
  0x02,
  0x06,
  0x6d,
  0x65,
  0x6d,
  0x6f,
  0x72,
  0x79,
  0x02,
  0x00,
  0x06,
  0x5f,
  0x73,
  0x74,
  0x61,
  0x72,
  0x74,
  0x00,
  0x00, // exports memory, _start
]
const returns = new WebAssembly.Module(
  new Uint8Array([...header, ...prefix, 0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b]),
)
const traps = new WebAssembly.Module(
  new Uint8Array([...header, ...prefix, 0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b]),
)

describe("fallowThreads option", () => {
  test("is on unless it is exactly off", () => {
    expect(parseFallowThreads(undefined)).toBe("on")
    expect(parseFallowThreads("on")).toBe("on")
    expect(parseFallowThreads("off")).toBe("off")
    expect(parseFallowThreads("OFF")).toBe("on")
    expect(parseFallowThreads(false)).toBe("on")
    expect(parseFallowThreads(0)).toBe("on")
  })

  test("the pool is bounded by a constant of two", () => {
    expect(MAX_FALLOW_THREADS).toBe(2)
  })

  test("shared memory is available under Bun", () => {
    expect(sharedMemoryAvailable()).toBe(true)
  })
})

describe("running out of memory", () => {
  test("a failed allocation in a trap's stderr is a memory failure, any other trap is not", () => {
    expect(
      memoryExhausted("memory allocation of 27157728 bytes failed\nnote: run with RUST_BACKTRACE"),
    ).toBe(27157728)
    expect(memoryExhausted("panicked at src/lib.rs:1:1: index out of bounds")).toBeUndefined()
    expect(memoryExhausted("")).toBeUndefined()
  })
})

describe("module choice and fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-threads-"))
  const run = (module: WebAssembly.Module, threads: number) =>
    runFallowModule(module, { op: "none", root }, { maxThreads: threads })
  const counting = (threaded: () => Promise<WebAssembly.Module>) => {
    const loads = { single: 0, threaded: 0 }
    const modules = new FallowModules(
      async () => (loads.single++, returns),
      async () => (loads.threaded++, threaded()),
    )
    return { modules, loads }
  }

  test("off never loads the threaded module", async () => {
    const { modules, loads } = counting(async () => traps)
    const first = await modules.execute("off", (_module, threads) => threads)
    const second = await modules.execute("off", (_module, threads) => threads)
    expect([first.result, second.result]).toEqual([1, 1])
    expect(first.fallback).toBeUndefined()
    expect(loads).toEqual({ single: 1, threaded: 0 })
  })

  test("on runs the threaded module with the pool size and loads it once", async () => {
    const { modules, loads } = counting(async () => returns)
    const seen: number[] = []
    for (let i = 0; i < 2; i++)
      expect((await modules.execute("on", (_m, threads) => seen.push(threads))).fallback).toBe(
        undefined,
      )
    expect(seen).toEqual([MAX_FALLOW_THREADS, MAX_FALLOW_THREADS])
    expect(loads).toEqual({ single: 0, threaded: 1 })
  })

  test("a threaded module that fails to load falls back, and later calls skip it", async () => {
    const { modules, loads } = counting(async () => {
      throw new Error("no shared memory")
    })
    const first = await modules.execute("on", (_m, threads) => threads)
    expect(first).toEqual({ result: 1, fallback: "no shared memory" })
    const second = await modules.execute("on", (_m, threads) => threads)
    expect(second).toEqual({ result: 1 })
    expect(modules.disabledReason).toBe("no shared memory")
    expect(loads).toEqual({ single: 1, threaded: 1 })
  })

  test("a threaded call that traps fails that call alone: threads stay on for the next", async () => {
    // The injected threaded module traps; the single-threaded stand-in returns.
    const { modules, loads } = counting(async () => traps)
    await expect(
      modules.execute("on", (module, threads) => run(module, threads)),
    ).rejects.toBeInstanceOf(WasiTrap)
    expect(modules.disabledReason).toBeUndefined()
    await expect(
      modules.execute("on", (module, threads) => run(module, threads)),
    ).rejects.toBeInstanceOf(WasiTrap)
    expect(loads).toEqual({ single: 0, threaded: 1 })
  })

  test("any error of the analysis, memory failures included, is the caller's and keeps threads on", async () => {
    const { modules } = counting(async () => returns)
    for (const error of [new RangeError("Out of memory"), new Error("analysis failed")])
      await expect(
        modules.execute("on", () => {
          throw error
        }),
      ).rejects.toBe(error)
    expect(modules.disabledReason).toBeUndefined()
    expect((await modules.execute("on", (_m, threads) => threads)).result).toBe(MAX_FALLOW_THREADS)
  })

  test("a module the runtime cannot link, or reports as unsupported, falls back and stays off", async () => {
    for (const error of [
      new WebAssembly.LinkError("shared memory is not supported"),
      new WebAssembly.CompileError("bad opcode"),
      new ThreadsUnsupported("no shared memory"),
    ]) {
      const { modules, loads } = counting(async () => returns)
      const first = await modules.execute("on", (_module, threads) => {
        if (threads > 1) throw error
        return threads
      })
      expect(first).toEqual({ result: 1, fallback: error.message })
      expect(await modules.execute("on", (_module, threads) => threads)).toEqual({ result: 1 })
      expect(loads).toEqual({ single: 1, threaded: 1 })
    }
  })

  test("a trap on the single-threaded module is still an error", async () => {
    const modules = new FallowModules(
      async () => traps,
      async () => traps,
    )
    await expect(
      modules.execute("off", (module, threads) => run(module, threads)),
    ).rejects.toBeInstanceOf(WasiTrap)
  })

  test("cleanup", () => rmSync(root, { recursive: true, force: true }))
})
