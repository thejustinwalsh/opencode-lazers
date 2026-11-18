/**
 * The short, plain runtime state shown in the Local inference section header and the header
 * indicator tooltip. The runtime's own prose (`detail`) is for diagnostics: it never appears here.
 */

/** Known runtime failure text, as a short reason. Anything else shows as a bare "Error". */
const knownReasons: ReadonlyArray<readonly [RegExp, string]> = [
  [/retirement evidence|main-process provider/i, "Provider changed"],
  [/webgpu is unavailable|navigator\.gpu/i, "WebGPU unavailable"],
  [/gpu cleanup failed|ownership is retained/i, "GPU cleanup failed"],
  [/completion contract|reload the opencode service/i, "Service needs reload"],
  [/device lost|device was lost/i, "GPU device lost"],
  [/out of memory|oom\b/i, "Out of memory"],
  [/timed? ?out|timeout/i, "Timed out"],
  [
    /checksum|digest|integrity|hash mismatch|failed verification/i,
    "Model files failed verification",
  ],
  [/download/i, "Download failed"],
]

/** A short reason for a runtime error, or undefined when the text is not a known failure. */
export function runtimeErrorReason(detail: string | undefined) {
  if (!detail) return undefined
  return knownReasons.find(([pattern]) => pattern.test(detail))?.[1]
}

export type RuntimeStatusInput = {
  /** The runtime's phase: unloaded, loading, downloading, ready, busy, error or disabled. */
  phase: string
  /** The runtime's own sentence; shown only as the tooltip of an error. */
  detail?: string
  /** The resident model's short name, when one is loaded. */
  modelName?: string
  /** Local inference is switched on. Off reads "Off" whatever the runtime last said. */
  enabled: boolean
}

export type RuntimeStatusLine = {
  text: string
  /** The raw runtime text, for an error; put it in a tooltip, never in the line. */
  tooltip?: string
}

function percent(detail: string | undefined) {
  const value = detail?.match(/(\d{1,3})%/)?.[1]
  return value === undefined ? undefined : `${Math.min(100, Number(value))}%`
}

export function runtimeStatusLine(input: RuntimeStatusInput): RuntimeStatusLine {
  const { phase, detail, modelName } = input
  if (phase === "error") {
    const reason = runtimeErrorReason(detail)
    return {
      text: reason ? `Error · ${reason}` : "Error",
      ...(detail ? { tooltip: detail } : {}),
    }
  }
  if (!input.enabled) return { text: phase === "disabled" ? "Off" : "Stopping local work" }
  switch (phase) {
    case "disabled":
      return { text: "Off" }
    case "loading":
      return { text: "Loading" }
    case "downloading": {
      const done = percent(detail)
      return { text: done ? `Downloading · ${done}` : "Downloading" }
    }
    case "ready":
      return { text: modelName ? `${modelName} loaded` : "Loaded" }
    case "busy":
      return { text: modelName ? `${modelName} working` : "Working" }
    default:
      return { text: "Unloaded · loads on next request" }
  }
}
