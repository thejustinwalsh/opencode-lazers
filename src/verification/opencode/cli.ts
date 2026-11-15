import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  cleanManifest,
  launchDependencies,
  readManifest,
  reopenOwnedDesktop,
  startOwnedDesktop,
} from "./owned-launch.ts"
import {
  nativeAudioObservations,
  nativeInteractionStatus,
  resolveNativeInteractionResult,
  runNativeInteraction,
} from "./native-interaction-cli.ts"
import type { NativeInteractionCliDependencies } from "./native-interaction-cli.ts"

type Arguments = Map<string, string>

export async function main(
  argv = process.argv.slice(2),
  nativeDependencies?: NativeInteractionCliDependencies,
): Promise<void> {
  const [operation, ...rest] = argv
  const args = parseArguments(rest)
  if (operation === "reopen") {
    assertAllowed(args, ["--root"])
    const manifest = await reopenOwnedDesktop(resolve(required(args, "--root")))
    console.log(
      JSON.stringify({ status: manifest.status, root: manifest.root, desktop: manifest.desktop }),
    )
    return
  }
  if (operation === "launch") {
    assertAllowed(args, ["--desktop", "--cli", "--candidate", "--target"])
    const desktopBundle = required(args, "--desktop")
    const cliPath = required(args, "--cli")
    const candidatePath = resolve(required(args, "--candidate"))
    const targetPath = resolve(required(args, "--target"))
    const manifest = await startOwnedDesktop(
      { desktopBundle, cliPath, candidatePath, targetPath },
      launchDependencies(),
    )
    console.log(
      JSON.stringify(
        {
          status: manifest.status,
          root: manifest.root,
          candidate: manifest.candidate,
          target: manifest.target,
          protocolHandlerBaseline: manifest.protocolHandlerBaseline,
          service: manifest.service && {
            process: manifest.service.process,
            id: manifest.service.id,
            version: manifest.service.version,
            url: manifest.service.url,
          },
          desktop: manifest.desktop,
          observations: manifest.observations,
        },
        null,
        2,
      ),
    )
    return
  }
  if (operation === "cleanup") {
    assertAllowed(args, ["--root"])
    const root = resolve(required(args, "--root"))
    const manifest = await cleanManifest(root)
    console.log(
      JSON.stringify(
        {
          status: manifest.status,
          root: manifest.root,
          cleanupIssue: manifest.cleanupIssue,
          observations: manifest.observations,
        },
        null,
        2,
      ),
    )
    if (manifest.status === "cleanup-blocked") process.exitCode = 1
    return
  }
  if (operation === "inspect") {
    assertAllowed(args, ["--root"])
    const root = resolve(required(args, "--root"))
    const manifest = await readManifest(root)
    console.log(JSON.stringify(manifest, null, 2))
    return
  }
  if (operation === "native-status") {
    assertAllowed(args, ["--root"])
    await nativeInteractionStatus(resolve(required(args, "--root")))
    return
  }
  if (operation === "native") {
    assertAllowed(args, [
      "--root",
      "--kind",
      "--window",
      "--snapshot",
      "--element",
      "--text",
      "--key",
      "--output",
      "--confirm-safe-page",
    ])
    const kind = required(args, "--kind")
    if (!["snapshot", "capture", "focus", "click", "type", "key"].includes(kind)) {
      throw new Error("Native kind must be snapshot, capture, focus, click, type, or key")
    }
    const windowID = args.has("--window")
      ? positiveInteger(required(args, "--window"), "--window")
      : undefined
    const confirm = args.get("--confirm-safe-page")
    if (confirm !== undefined && confirm !== "yes") {
      throw new Error("--confirm-safe-page accepts only the explicit value yes")
    }
    await runNativeInteraction(
      {
        root: resolve(required(args, "--root")),
        kind: kind as "snapshot" | "capture" | "focus" | "click" | "type" | "key",
        ...(windowID === undefined ? {} : { windowID }),
        ...(args.has("--snapshot") ? { snapshotID: required(args, "--snapshot") } : {}),
        ...(args.has("--element") ? { elementRef: required(args, "--element") } : {}),
        ...(args.has("--text") ? { text: required(args, "--text") } : {}),
        ...(args.has("--key") ? { key: required(args, "--key") } : {}),
        ...(args.has("--output") ? { output: required(args, "--output") } : {}),
        ...(confirm === "yes" ? { confirmSafePage: true } : {}),
      },
      nativeDependencies,
    )
    return
  }
  if (operation === "native-resolve") {
    assertAllowed(args, ["--root", "--request"])
    await resolveNativeInteractionResult(
      resolve(required(args, "--root")),
      required(args, "--request"),
      nativeDependencies,
    )
    return
  }
  if (operation === "audio-fixture") {
    assertAllowed(args, ["--root", "--window", "--session", "--clip"])
    const fixtureID = required(args, "--clip")
    if (fixtureID !== "quick-brown-fox" && fixtureID !== "turn-left-next-street")
      throw new Error("--clip must be quick-brown-fox or turn-left-next-street")
    await runNativeInteraction(
      {
        root: resolve(required(args, "--root")),
        kind: "dictation-fixture",
        windowID: positiveInteger(required(args, "--window"), "--window"),
        sessionID: required(args, "--session"),
        fixtureID,
      },
      nativeDependencies,
    )
    return
  }
  if (operation === "audio-playback") {
    assertAllowed(args, ["--root", "--window", "--session", "--expected"])
    await runNativeInteraction(
      {
        root: resolve(required(args, "--root")),
        kind: "playback-plan",
        windowID: positiveInteger(required(args, "--window"), "--window"),
        sessionID: required(args, "--session"),
        expected: required(args, "--expected"),
      },
      nativeDependencies,
    )
    return
  }
  if (operation === "audio-observe") {
    assertAllowed(args, ["--root", "--request", "--intelligibility"])
    const intelligibility = args.get("--intelligibility")
    if (
      intelligibility !== undefined &&
      intelligibility !== "pass" &&
      intelligibility !== "fail" &&
      intelligibility !== "unknown"
    ) {
      throw new Error("--intelligibility must be pass, fail, or unknown")
    }
    await nativeAudioObservations(
      resolve(required(args, "--root")),
      required(args, "--request"),
      intelligibility,
    )
    return
  }
  throw new Error(
    "Usage: bun src/verification/opencode/cli.ts <launch|reopen|inspect|cleanup|native-status|native|native-resolve|audio-fixture|audio-playback|audio-observe> [options]",
  )
}

function parseArguments(values: string[]): Arguments {
  const result = new Map<string, string>()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (
      key === undefined ||
      !key.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`Expected option/value pairs; invalid argument ${key ?? "<missing>"}`)
    }
    if (result.has(key)) throw new Error(`Duplicate option ${key}`)
    result.set(key, value)
  }
  return result
}

function required(args: Arguments, key: string): string {
  const value = args.get(key)
  if (value === undefined || value.length === 0) throw new Error(`Missing required option ${key}`)
  return value
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`)
  return number
}

function assertAllowed(args: Arguments, allowed: string[]): void {
  for (const key of args.keys()) {
    if (!allowed.includes(key)) throw new Error(`Unknown option ${key}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(redactError(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}

function redactError(value: string): string {
  return value
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gi,
      "[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/gi, "$1 [REDACTED]")
    .replace(
      /\b((?:authorization|password|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
}
