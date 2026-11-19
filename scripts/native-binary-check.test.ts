import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

  test("the runtime sources and the package manifest ship no native binary or native dependency", async () => {
    expect(await findNativeBinaries(join(root, "src"))).toEqual([])
    const manifest = await Bun.file(join(root, "package.json")).json()
    expect(Object.keys(manifest.dependencies)).not.toContain("@fallow-cli/fallow-node")
    expect(Object.keys(manifest.devDependencies)).toContain("@fallow-cli/fallow-node")
  })
})
