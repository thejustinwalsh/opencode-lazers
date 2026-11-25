export type ProcessStream = "stdout" | "stderr"

const CAPTURE_BYTES_PER_END = 64 * 1024
const OUTPUT_DRAIN_MS = 5_000
const OUTPUT_CANCEL_WAIT_MS = 1_000

export class BoundedCapture {
  private readonly head: Buffer[] = []
  private readonly tail: Buffer[] = []
  private headBytes = 0
  private tailBytes = 0
  private totalBytes = 0

  append(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength
    let offset = 0

    const headRoom = CAPTURE_BYTES_PER_END - this.headBytes
    if (headRoom > 0) {
      const length = Math.min(headRoom, chunk.byteLength)
      if (length > 0) {
        this.head.push(Buffer.from(chunk.subarray(0, length)))
        this.headBytes += length
        offset = length
      }
    }

    if (offset === chunk.byteLength) return
    const remaining = chunk.subarray(offset)
    const tailChunk =
      remaining.byteLength > CAPTURE_BYTES_PER_END
        ? Buffer.from(remaining.subarray(-CAPTURE_BYTES_PER_END))
        : Buffer.from(remaining)
    this.tail.push(tailChunk)
    this.tailBytes += tailChunk.byteLength

    while (this.tailBytes > CAPTURE_BYTES_PER_END) {
      const excess = this.tailBytes - CAPTURE_BYTES_PER_END
      const first = this.tail[0]!
      if (first.byteLength <= excess) {
        this.tail.shift()
        this.tailBytes -= first.byteLength
      } else {
        this.tail[0] = first.subarray(excess)
        this.tailBytes -= excess
      }
    }

    if (this.tail.length > 64) {
      this.tail.splice(0, this.tail.length, Buffer.concat(this.tail))
    }
  }

  text(): string {
    const head = Buffer.concat(this.head)
    const tail = Buffer.concat(this.tail)
    const omitted = this.totalBytes - head.byteLength - tail.byteLength
    return (
      head.toString("utf8") +
      (omitted > 0 ? `\n[... ${omitted} bytes omitted ...]\n` : "") +
      tail.toString("utf8")
    )
  }
}

export interface OutputPump {
  done: Promise<void>
  cancel(): Promise<void>
}

export interface OutputDrainTimeouts {
  drainMs: number
  cancelMs: number
  settleMs: number
}

const DEFAULT_DRAIN_TIMEOUTS: OutputDrainTimeouts = {
  drainMs: OUTPUT_DRAIN_MS,
  cancelMs: OUTPUT_CANCEL_WAIT_MS,
  settleMs: OUTPUT_CANCEL_WAIT_MS,
}

export function pumpOutput(
  stream: ReadableStream<Uint8Array>,
  capture: BoundedCapture,
  forward: ((stream: ProcessStream, chunk: Uint8Array) => void) | undefined,
  name: ProcessStream,
): OutputPump {
  const reader = stream.getReader()
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) return
        capture.append(next.value)
        forward?.(name, next.value)
      }
    } finally {
      reader.releaseLock()
    }
  })()

  return {
    done,
    cancel: async () => {
      try {
        await reader.cancel()
      } catch {
        // An errored stream is already settled; preserve the original observation failure.
      }
    },
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export async function drainAfterTermination(
  pumps: OutputPump[],
  timeouts: OutputDrainTimeouts = DEFAULT_DRAIN_TIMEOUTS,
): Promise<void> {
  try {
    await withTimeout(
      Promise.allSettled(pumps.map((pump) => pump.done)).then(() => {}),
      timeouts.drainMs,
      "Owned test subprocess output did not drain after termination",
    )
  } catch (drainError) {
    const cleanupErrors: unknown[] = []
    const cancellationErrors: unknown[] = []
    const cancellations = pumps.map((pump) => {
      try {
        return pump.cancel().then(
          () => {},
          (error: unknown) => {
            cancellationErrors.push(error)
          },
        )
      } catch (error) {
        cancellationErrors.push(error)
        return Promise.resolve()
      }
    })
    try {
      await withTimeout(
        Promise.all(cancellations),
        timeouts.cancelMs,
        "Owned test subprocess stream cancellation did not settle",
      )
      cleanupErrors.push(...cancellationErrors)
    } catch (error) {
      cleanupErrors.push(...cancellationErrors, error)
    }
    try {
      await withTimeout(
        Promise.allSettled(pumps.map((pump) => pump.done)).then(() => {}),
        timeouts.settleMs,
        "Owned test subprocess output readers did not settle after cancellation",
      )
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [drainError, ...cleanupErrors],
        "Could not settle owned subprocess output",
        { cause: drainError },
      )
  }
}

export function failedStream(pump: OutputPump): Promise<{ kind: "observation"; error: unknown }> {
  return pump.done.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => ({ kind: "observation", error }),
  )
}
