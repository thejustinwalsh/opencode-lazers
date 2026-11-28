import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { wasiEnvironment } from "./build-difftastic-wasm.ts"

describe("Difftastic WASI build environment", () => {
  test("uses a configured SDK and sysroot for target C compilation", () => {
    const sdk = mkdtempSync(join(tmpdir(), "difftastic-wasi-sdk-"))
    const sysroot = join(sdk, "share/wasi-sysroot")
    mkdirSync(sysroot, { recursive: true })
    try {
      expect(wasiEnvironment({ WASI_SDK_PATH: sdk })).toEqual({
        WASI_SYSROOT: sysroot,
        "CC_wasm32-wasip1": join(sdk, "bin/clang"),
        "AR_wasm32-wasip1": join(sdk, "bin/llvm-ar"),
        "RANLIB_wasm32-wasip1": join(sdk, "bin/llvm-ranlib"),
        "CFLAGS_wasm32-wasip1": `--sysroot=${sysroot}`,
      })
    } finally {
      rmSync(sdk, { recursive: true, force: true })
    }
  })

  test("keeps explicit cross compiler and flags and rejects a missing sysroot", () => {
    const sysroot = mkdtempSync(join(tmpdir(), "difftastic-wasi-sysroot-"))
    try {
      expect(
        wasiEnvironment({
          WASI_SYSROOT: sysroot,
          "CC_wasm32-wasip1": "custom-clang",
          "AR_wasm32-wasip1": "custom-ar",
          "RANLIB_wasm32-wasip1": "custom-ranlib",
          "CFLAGS_wasm32-wasip1": "-DTEST",
        }),
      ).toEqual({
        WASI_SYSROOT: sysroot,
        "CC_wasm32-wasip1": "custom-clang",
        "AR_wasm32-wasip1": "custom-ar",
        "RANLIB_wasm32-wasip1": "custom-ranlib",
        "CFLAGS_wasm32-wasip1": `-DTEST --sysroot=${sysroot}`,
      })
      expect(() => wasiEnvironment({})).toThrow("Set WASI_SYSROOT or WASI_SDK_PATH")
    } finally {
      rmSync(sysroot, { recursive: true, force: true })
    }
  })
})
