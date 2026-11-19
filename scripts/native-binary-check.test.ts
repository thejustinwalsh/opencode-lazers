import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { assertNoNativeBinaries, findNativeBinaries } from "./native-binary-check.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "native-check-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("native binary detection", () => {
  test("flags an addon, ELF, Mach-O and PE file, and allows WebAssembly and text", async () => {
    writeFileSync(join(dir, "addon.node"), "anything")
    writeFileSync(join(dir, "elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))
    writeFileSync(join(dir, "macho"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]))
    writeFileSync(join(dir, "pe"), Buffer.from("MZ\x90\0"))
    writeFileSync(join(dir, "ok.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
    writeFileSync(join(dir, "ok.js"), "export {}")
    const found = (await findNativeBinaries(dir)).map((f) => f.path).sort()
    expect(found).toEqual(["addon.node", "elf", "macho", "pe"])
    await expect(assertNoNativeBinaries(dir)).rejects.toThrow(/native binaries/)
  })

  test("the runtime sources ship no native binary", async () => {
    expect(await findNativeBinaries(join(root, "src"))).toEqual([])
  })

  test("no Fallow package, native or not, is a dependency or in the lockfile", async () => {
    const manifest = await Bun.file(join(root, "package.json")).json()
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
    // Fallow runs from the committed WebAssembly modules. Its npm packages carry native binaries
    // and platform packages (for example `-darwin-arm64`), which a dev install would download.
    const forbidden = /^(@fallow-cli\/|fallow-(node|similar-code|type-aware)$)/
    expect(names.filter((name) => forbidden.test(name))).toEqual([])
    const lock = await Bun.file(join(root, "bun.lock")).text()
    expect(lock).not.toContain("@fallow-cli/")
    expect(lock).not.toMatch(/"fallow-(similar-code|type-aware)"/)
  })

  test("a clean install has no native Fallow package (checked where node_modules exists)", async () => {
    const installed = join(root, "node_modules/@fallow-cli")
    expect(await Bun.file(join(installed, "fallow-node/package.json")).exists()).toBe(false)
    expect(existsSync(installed)).toBe(false)
  })
})
