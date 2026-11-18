import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SOURCE = /\.(?:tsx?|md|json)$/

/** True when this module runs from the built server bundle (dist/server.js), not from src. */
const bundled = () => !new URL(import.meta.url).pathname.endsWith(".ts")

/**
 * Stable hash of the loaded code generation. A reload that picks up changed code produces
 * a different stamp, so new locations build a new core instead of reusing an older core
 * that still runs the previous code.
 *
 * - Built bundle: the SHA-256 of the bundle file contents, so a rebuild yields a new core
 *   and a touch without a rebuild does not.
 * - Source run (tests, dev): path, size and mtime of every source file under `root` plus
 *   this module's URL.
 *
 * Computed once per module copy; OpenCode loads a fresh copy per location boot.
 */
export function computeGeneration(
  root = join(dirname(fileURLToPath(import.meta.url)), ".."),
  bundle: string | undefined = bundled() ? fileURLToPath(import.meta.url) : undefined,
) {
  const hasher = new Bun.CryptoHasher("sha256")
  if (bundle !== undefined) {
    hasher.update(readFileSync(bundle))
    return hasher.digest("hex").slice(0, 16)
  }
  hasher.update(import.meta.url.split("?")[0] ?? "")
  const walk = (directory: string) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path)
        continue
      }
      if (!SOURCE.test(entry.name)) continue
      try {
        const stat = statSync(path)
        hasher.update(`${path}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`)
      } catch {
        // A file that vanished mid-walk changes the next generation, not this one.
      }
    }
  }
  walk(root)
  return hasher.digest("hex").slice(0, 16)
}

let generation: string | undefined
export const moduleGeneration = () => (generation ??= computeGeneration())
