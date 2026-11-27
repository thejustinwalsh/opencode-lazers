import {
  BoundedCapture,
  drainAfterTermination,
  failedStream,
  pumpOutput,
  withTimeout,
} from "./owned-test-process-output.ts"
import {
  registerOwnedProcessTree,
  terminateProcessTree,
  waitForProcessTreeExit,
} from "./owned-test-process-tree.ts"
import type { ProcessStream } from "./owned-test-process-output.ts"

export interface OwnedTestProcessChild {
  pid: number
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: string | number): void
}

export interface OwnedTestProcessSpawnOptions {
  cwd?: string
  env?: Record<string, string>
  stdin: "ignore"
  stdout: "pipe"
  stderr: "pipe"
  detached?: boolean
}

export type OwnedTestProcessSpawner = (
  command: string[],
  options: OwnedTestProcessSpawnOptions,
) => OwnedTestProcessChild

export interface OwnedTestProcessOptions {
  timeoutMs: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Use the caller's owned process group instead of creating an independently detached group. */
  processGroup?: "detached" | "inherited"
  forwardOutput?: boolean
  onOutput?: (stream: ProcessStream, chunk: Uint8Array) => void
  spawn?: OwnedTestProcessSpawner
}

export interface OwnedTestProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type OwnedTestProcessFailureKind =
  "timeout" | "aborted" | "observation" | "descendants" | "cleanup"

const OUTPUT_DRAIN_MS = 5_000
const PROCESS_GROUP_CHECK_MS = 150

export class OwnedTestProcessError extends Error {
  readonly kind: OwnedTestProcessFailureKind
  readonly stdout: string
  readonly stderr: string

  constructor(input: {
    kind: OwnedTestProcessFailureKind
    message: string
    stdout: string
    stderr: string
    cause?: unknown
  }) {
    const diagnostics = [
      input.stdout ? `\n--- child stdout ---\n${input.stdout}` : "",
      input.stderr ? `\n--- child stderr ---\n${input.stderr}` : "",
    ].join("")
    super(`${input.message}${diagnostics}`, { cause: input.cause })
    this.name = "OwnedTestProcessError"
    this.kind = input.kind
    this.stdout = input.stdout
    this.stderr = input.stderr
  }
}

type RunOutcome =
  | { kind: "complete"; exitCode: number }
  | { kind: "interrupted"; reason: "timeout" | "aborted" }
  | { kind: "descendants"; error: unknown }
  | { kind: "observation"; error: unknown }

interface CapturedOutput {
  stdout: BoundedCapture
  stderr: BoundedCapture
  pumps: ReturnType<typeof pumpOutput>[]
}

interface Interruption {
  outcome: Promise<Extract<RunOutcome, { kind: "interrupted" }>>
  dispose(): void
}

function observedExit(
  child: OwnedTestProcessChild,
): Promise<{ kind: "exit"; exitCode: number } | { kind: "observation"; error: unknown }> {
  try {
    return child.exited.then(
      (exitCode) => ({ kind: "exit", exitCode }),
      (error: unknown) => ({ kind: "observation", error }),
    )
  } catch (error) {
    return Promise.resolve({ kind: "observation", error })
  }
}

async function afterExit(
  child: OwnedTestProcessChild,
  pumps: CapturedOutput["pumps"],
  exitCode: number,
  processGroup: "detached" | "inherited",
): Promise<RunOutcome> {
  const ownsProcessTree = process.platform === "win32" || processGroup === "detached"
  if (ownsProcessTree && !(await waitForProcessTreeExit(child.pid, PROCESS_GROUP_CHECK_MS, child)))
    return {
      kind: "descendants",
      error: new Error("Owned test subprocess exited while descendants remained"),
    }
  try {
    await withTimeout(
      Promise.all(pumps.map((pump) => pump.done)),
      OUTPUT_DRAIN_MS,
      "Owned test subprocess output did not drain after exit",
    )
  } catch (error) {
    return { kind: "observation", error }
  }
  return { kind: "complete", exitCode }
}

function observeChild(
  child: OwnedTestProcessChild,
  pumps: CapturedOutput["pumps"],
  processGroup: "detached" | "inherited",
): Promise<RunOutcome> {
  const exit = observedExit(child)
  return Promise.race([exit, ...pumps.map(failedStream)])
    .then((first) =>
      first.kind === "exit" ? afterExit(child, pumps, first.exitCode, processGroup) : first,
    )
    .catch((error: unknown): RunOutcome => ({ kind: "observation", error }))
}

function watchInterruption(signal: AbortSignal | undefined, timeoutMs: number): Interruption {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const outcome = new Promise<Extract<RunOutcome, { kind: "interrupted" }>>((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: "interrupted", reason: "aborted" })
      return
    }
    if (signal) {
      abortListener = () => resolve({ kind: "interrupted", reason: "aborted" })
      signal.addEventListener("abort", abortListener, { once: true })
    }
    timer = setTimeout(() => resolve({ kind: "interrupted", reason: "timeout" }), timeoutMs)
  })
  return {
    outcome,
    dispose() {
      if (timer) clearTimeout(timer)
      if (abortListener) signal?.removeEventListener("abort", abortListener)
    },
  }
}

function failureDetails(
  outcome: Exclude<RunOutcome, { kind: "complete" }>,
  timeoutMs: number,
): { kind: OwnedTestProcessFailureKind; message: string; cause?: unknown } {
  if (outcome.kind === "interrupted")
    return {
      kind: outcome.reason,
      message:
        outcome.reason === "timeout"
          ? `Owned test subprocess exceeded ${timeoutMs} milliseconds`
          : "Owned test subprocess was cancelled",
    }

  const subject = outcome.kind === "descendants" ? "left descendants" : "observation failed"
  const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
  return {
    kind: outcome.kind,
    message: `Owned test subprocess ${subject}: ${detail}`,
    cause: outcome.error,
  }
}

function mergeCleanupError(previous: unknown, error: unknown, message: string): unknown {
  return previous ? new AggregateError([previous, error], message, { cause: error }) : error
}

async function cleanupFailedChild(
  child: OwnedTestProcessChild,
  pumps: CapturedOutput["pumps"],
  operation: Promise<RunOutcome>,
  processGroup: "detached" | "inherited",
): Promise<unknown> {
  let cleanupError: unknown
  try {
    await terminateProcessTree(child, processGroup)
  } catch (error) {
    cleanupError = error
  }
  try {
    await drainAfterTermination(pumps)
  } catch (error) {
    cleanupError = mergeCleanupError(
      cleanupError,
      error,
      "Subprocess termination and output drainage failed",
    )
  }
  try {
    await withTimeout(
      operation,
      OUTPUT_DRAIN_MS,
      "Subprocess observation did not settle after cleanup",
    )
  } catch (error) {
    cleanupError = mergeCleanupError(cleanupError, error, "Subprocess cleanup did not settle")
  }
  return cleanupError
}

function createProcessError(
  details: ReturnType<typeof failureDetails>,
  cleanupError: unknown,
  output: CapturedOutput,
): OwnedTestProcessError {
  return new OwnedTestProcessError({
    kind: cleanupError ? "cleanup" : details.kind,
    message: cleanupError
      ? `${details.message}; cleanup was uncertain: ${String(cleanupError)}`
      : details.message,
    stdout: output.stdout.text(),
    stderr: output.stderr.text(),
    cause: cleanupError ?? details.cause,
  })
}

async function completeChild(
  child: OwnedTestProcessChild,
  options: OwnedTestProcessOptions,
): Promise<OwnedTestProcessResult> {
  const processGroup = options.processGroup ?? "detached"
  const output = captureOutput(child, options)
  const operation = observeChild(child, output.pumps, processGroup)
  const interruption = watchInterruption(options.signal, options.timeoutMs)
  let outcome: RunOutcome
  try {
    outcome = await Promise.race([operation, interruption.outcome])
  } finally {
    interruption.dispose()
  }

  if (outcome.kind === "complete")
    return {
      exitCode: outcome.exitCode,
      stdout: output.stdout.text(),
      stderr: output.stderr.text(),
    }
  const details = failureDetails(outcome, options.timeoutMs)
  const cleanupError = await cleanupFailedChild(child, output.pumps, operation, processGroup)
  throw createProcessError(details, cleanupError, output)
}

function captureOutput(
  child: OwnedTestProcessChild,
  options: OwnedTestProcessOptions,
): CapturedOutput {
  const stdout = new BoundedCapture()
  const stderr = new BoundedCapture()
  const forward =
    options.onOutput ??
    (options.forwardOutput === false
      ? undefined
      : (stream: ProcessStream, chunk: Uint8Array) => {
          ;(stream === "stdout" ? process.stdout : process.stderr).write(chunk)
        })
  return {
    stdout,
    stderr,
    pumps: [
      pumpOutput(child.stdout, stdout, forward, "stdout"),
      pumpOutput(child.stderr, stderr, forward, "stderr"),
    ],
  }
}

function spawnOwnedChild(
  command: string[],
  options: OwnedTestProcessOptions,
): OwnedTestProcessChild {
  const environment = options.env
    ? (Object.fromEntries(
        Object.entries(options.env).filter(([, value]) => value !== undefined),
      ) as Record<string, string>)
    : undefined
  const spawn = options.spawn ?? ((cmd, spawnOptions) => Bun.spawn(cmd, spawnOptions))
  const child = spawn(command, {
    cwd: options.cwd,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(process.platform === "win32"
      ? {}
      : { detached: (options.processGroup ?? "detached") === "detached" }),
  })
  registerOwnedProcessTree(child)
  return child
}

/**
 * Spawn a test subprocess in an owned process tree, forwarding output as it arrives and draining
 * both streams before returning or reporting a failure.
 */
export async function runOwnedTestProcess(
  command: string[],
  options: OwnedTestProcessOptions,
): Promise<OwnedTestProcessResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new RangeError("Owned test subprocess timeout must be a positive finite number")
  if (options.signal?.aborted)
    throw new OwnedTestProcessError({
      kind: "aborted",
      message: "Owned test subprocess was cancelled before launch",
      stdout: "",
      stderr: "",
      cause: options.signal.reason,
    })
  return completeChild(spawnOwnedChild(command, options), options)
}
