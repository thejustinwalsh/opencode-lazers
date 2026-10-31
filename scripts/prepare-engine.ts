import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { ENGINE_SHA256, ENGINE_URL } from "../src/webgpu/manifest.ts"

const target = new URL("../.cache/lfm3-engine.js", import.meta.url)
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const existing = await readFile(target).catch(() => undefined)
if (!existing || digest(existing) !== ENGINE_SHA256) {
  const response = await fetch(ENGINE_URL, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Engine download failed: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (digest(bytes) !== ENGINE_SHA256) throw new Error("Upstream engine checksum mismatch")
  await mkdir(new URL("../.cache/", import.meta.url), { recursive: true })
  await writeFile(target, bytes)
}
console.log("Pinned LiquidAI WebGPU engine verified")
