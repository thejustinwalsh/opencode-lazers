import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { observeProcess, type ProcessObservation } from "../opencode/owned-launch.ts"
import { evaluateMaintenancePreflight } from "./preflight.ts"
import type { GitWorkspaceObservation, ReceiptObservation } from "./contract.ts"

type Arguments = { request: string; inspection: string }

function runGit(workspace: string, args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      workspace,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: "file",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  )
  if (result.error || result.status !== 0) throw new Error("local Git observation unavailable")
  return result.stdout
}

function observeGit(workspace: string): GitWorkspaceObservation {
  try {
    const root = realpathSync(runGit(workspace, ["rev-parse", "--show-toplevel"]).trim())
    const canonicalWorkspace = realpathSync(workspace)
    const head = runGit(workspace, ["rev-parse", "--verify", "HEAD^{commit}"]).trim()
    const status = runGit(workspace, ["status", "--porcelain=v1", "--untracked-files=all"])
    const unmerged = runGit(workspace, ["ls-files", "-u", "-z"])
    return {
      kind: "observed",
      root,
      head: /^[a-f0-9]{40,64}$/.test(head) ? head : null,
      clean: canonicalWorkspace === root && status.length === 0,
      unmerged: unmerged.length > 0,
    }
  } catch {
    return { kind: "unavailable" }
  }
}

function readReceipt(path: string): ReceiptObservation {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) return { kind: "unavailable" }
    const contents = readFileSync(path, "utf8")
    try {
      return { kind: "present", receipt: JSON.parse(contents) as unknown }
    } catch {
      return { kind: "present", receipt: null }
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { kind: "missing" }
    return { kind: "unavailable" }
  }
}

function readArguments(argv: string[]): Arguments {
  if (argv[0] !== "prepare") throw new Error("Expected prepare")
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if ((key !== "--request" && key !== "--inspection") || !value || values.has(key))
      throw new Error("Expected one --request and one --inspection path")
    values.set(key, value)
  }
  const request = values.get("--request")
  const inspection = values.get("--inspection")
  if (!request || !inspection || values.size !== 2)
    throw new Error("Expected one --request and one --inspection path")
  return { request, inspection }
}

function errorResult(code: "invalid-cli" | "request-unreadable" | "inspection-unreadable") {
  return {
    schemaVersion: 1,
    status: "preflight-error",
    coordinationRequired: true,
    containment: "unproven",
    executionPermitted: false,
    blockers: [{ code }],
    missingEvidence: ["valid-offline-preflight-input"],
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: Arguments
  try {
    args = readArguments(argv)
  } catch {
    process.stdout.write(`${JSON.stringify(errorResult("invalid-cli"))}\n`)
    process.exitCode = 2
    return
  }

  let request: unknown
  try {
    request = JSON.parse(await readFile(resolve(args.request), "utf8")) as unknown
  } catch {
    process.stdout.write(`${JSON.stringify(errorResult("request-unreadable"))}\n`)
    process.exitCode = 2
    return
  }
  let inspection: unknown
  try {
    inspection = JSON.parse(await readFile(resolve(args.inspection), "utf8")) as unknown
  } catch {
    process.stdout.write(`${JSON.stringify(errorResult("inspection-unreadable"))}\n`)
    process.exitCode = 2
    return
  }

  const result = await evaluateMaintenancePreflight(request, inspection, {
    git: (workspace) => observeGit(workspace),
    receipt: (path) => readReceipt(path),
    process: (identity): ProcessObservation => observeProcess(identity.pid),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.main) await main()
