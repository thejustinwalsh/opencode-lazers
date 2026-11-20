import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** The command-line flag every test run carries (`bun test --timeout 120000`). */
const FLAG_MS = 120_000

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === "node_modules" || entry.name === ".cache" ? [] : files(path)
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

test("no test sets a per-test timeout below the command-line flag", () => {
  const root = new URL("../", import.meta.url).pathname
  const found: string[] = []
  for (const directory of ["test", "scripts"])
    for (const path of files(join(root, directory))) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          // A test call closed with its own timeout: `}, 20000)` or `}, 15_000)`.
          const match = /^\s*\}\s*,\s*(\d[\d_]*)\s*\)\s*;?\s*$/.exec(line)
          const ms = match ? Number(match[1]!.replaceAll("_", "")) : 0
          if (ms >= 1_000 && ms < FLAG_MS)
            found.push(`${path.slice(root.length)}:${index + 1} ${ms}`)
        })
    }
  expect(found).toEqual([])
})
