import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runFallowModule, type GitCall, type RunOptions } from "../fallow-wasi.ts"

export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
export const wasmBytes = readFileSync(new URL("./fallow.wasm", import.meta.url))
export const wasmModule = new WebAssembly.Module(wasmBytes)

export type OpResult = { report: Record<string, any>; git: GitCall[]; stderr: string }

/** Run one request against the shipped module and unwrap its envelope. */
export function runOp(
  op: string,
  root: string,
  extra: Record<string, unknown> = {},
  options: RunOptions = {},
): OpResult {
  const git: GitCall[] = []
  const outcome = runFallowModule(
    wasmModule,
    { op, root, options: { threads: 1, explain: true, css: true }, ...extra },
    { ...options, onGit: (call) => (git.push(call), options.onGit?.(call)) },
  )
  const parsed = JSON.parse(outcome.stdout) as {
    report?: Record<string, any>
    error?: { code: string; message: string }
  }
  if (parsed.error) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
  return { report: parsed.report ?? {}, git, stderr: outcome.stderr }
}

/** Error code of a request that must fail. */
export function errorCode(op: string, root: string, extra: Record<string, unknown> = {}) {
  const outcome = runFallowModule(wasmModule, { op, root, ...extra })
  return (JSON.parse(outcome.stdout) as { error?: { code: string } }).error?.code
}

export function trackedSources(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    maxBuffer: 1 << 28,
  })
    .toString()
    .split("\0")
    .filter(Boolean)
}

/** Every path under `dir` (`.git` included) with a digest of its bytes or link target. */
export function snapshot(dir: string, prefix = ""): Map<string, string> {
  const rows = new Map<string, string>()
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(dir, relative)
    if (entry.isSymbolicLink()) rows.set(relative, `link:${readlinkSync(path)}`)
    else if (entry.isDirectory()) {
      rows.set(relative, "dir")
      for (const [key, value] of snapshot(dir, relative)) rows.set(key, value)
    } else
      rows.set(
        relative,
        `${lstatSync(path).size}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
      )
  }
  return rows
}

const block = (name: string) => `export function ${name}(items: number[], limit: number) {
  const out: number[] = []
  for (const item of items) {
    if (item > limit) {
      out.push(item * 2)
    } else if (item < 0) {
      out.push(-item)
    } else {
      out.push(item + limit)
    }
  }
  const total = out.reduce((sum, value) => sum + value, 0)
  const average = out.length === 0 ? 0 : total / out.length
  return { out, total, average, max: Math.max(...out), min: Math.min(...out) }
}
`

const branchy = `export function route(a: number, b: number, c: string): string {
${Array.from({ length: 12 }, (_, i) => `  if (a === ${i} && b > ${i} || c === "k${i}") {\n    if (b % 2 === 0) { return "even${i}" }\n  }`).join("\n")}
  return "none"
}
`

export const fixtureFiles: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "fixture",
    type: "module",
    main: "src/index.ts",
    dependencies: { "dep-a": "1.0.0", "never-used": "1.0.0" },
  }),
  ".fallowrc.json": JSON.stringify({ entry: ["src/index.ts"] }),
  "src/index.ts": `import { shout } from "dep-a"\nimport { ping } from "./ping.ts"\nimport { alpha } from "./a.ts"\nexport const main = () => shout(ping(), alpha([1], 0))\n`,
  "src/ping.ts": `import { pong } from "./pong.ts"\nexport const ping = () => pong() + 1\nexport const unusedExport = 3\n`,
  "src/pong.ts": `import { ping } from "./ping.ts"\nexport const pong = (): number => (ping === undefined ? 0 : 1)\n`,
  "src/a.ts": block("alpha"),
  "src/b.ts": block("beta"),
  "src/c.ts": branchy,
  "src/orphan.ts": `export const orphan = 1\n`,
  "src/flags.ts": `export function mode(): number {
  if (process.env.FEATURE_NEW_CHECKOUT) return 1
  return process.env.ENABLE_BETA_PANEL ? 2 : 0
}
`,
  "src/view.vue": `<script setup lang="ts">\n${block("gamma")}\n</script>\n<template><div /></template>\n`,
  // The dependency lives outside node_modules and is reached through a symlink, as with a
  // workspace package or a pnpm store.
  "packages/dep-a/package.json": JSON.stringify({
    name: "dep-a",
    version: "1.0.0",
    type: "module",
    main: "index.js",
  }),
  "packages/dep-a/index.js": `export const shout = (a, b) => String(a) + String(b)\n`,
}

/** A git work tree holding `fixtureFiles` and a symlinked `node_modules/dep-a`. */
export function makeFixture(extra: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fallow-fixture-")))
  for (const [path, text] of Object.entries({ ...fixtureFiles, ...extra })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  mkdirSync(join(dir, "node_modules"), { recursive: true })
  symlinkSync("../packages/dep-a", join(dir, "node_modules/dep-a"))
  writeFileSync(join(dir, ".gitignore"), "node_modules\n")
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
      { cwd: dir, stdio: "pipe" },
    )
  git("init", "-q", "-b", "main")
  git("add", ".")
  git("commit", "-q", "-m", "fixture")
  return dir
}
