import { Worker } from "node:worker_threads"
import { workerURL } from "../worker-url.ts"

type Helper = { worker: Worker; flag: Int32Array }
const HELPER_RUNNING = 0
const HELPER_DONE = 1
const HELPER_WAIT_MS = 100

/** Most helper threads a module may start. The analyzer chooses 1 or 2 within this bound. */
export const MAX_FALLOW_THREADS = 2

/**
 * Helper workers of the threaded module, kept between runs when a run's pool threads return
 * (`wasi_thread_start` ends) by the time the run does. A helper that is still inside the module
 * cannot be reused and is terminated. Idle helpers are unref'd, so they never keep the process
 * alive, and `terminateAll` ends every one of them.
 */
export class ThreadPool {
  private readonly idle: Helper[] = []
  private readonly active = new Set<Helper>()
  private readonly terminating = new Set<Promise<void>>()
  /** Helpers created and helpers reused, for tests and measurements. */
  created = 0
  reused = 0
  private peakLive = 0

  constructor(
    private readonly script?: URL,
    private readonly reuseHelpers = true,
  ) {}

  take(script?: URL): Helper {
    const idle = this.idle.pop()
    if (idle) {
      this.active.add(idle)
      this.reused++
      this.recordPeak()
      return idle
    }
    if (this.liveCount >= MAX_FALLOW_THREADS)
      throw new Error("fallow helper thread pool is at capacity")
    this.created++
    const worker = new Worker(
      script ?? this.script ?? workerURL("./fallow-thread", import.meta.url),
    )
    // An idle helper must not keep the process alive.
    worker.unref()
    // A helper that traps cannot be reported from here, the main thread being inside the module;
    // the request's timeout ends the run.
    worker.on("error", () => {})
    const helper = { worker, flag: new Int32Array(new SharedArrayBuffer(4)) }
    this.active.add(helper)
    this.recordPeak()
    return helper
  }

  /** After a run: keep the helpers that left the module, end the others. */
  settle(helpers: readonly Helper[], keep: boolean): void {
    for (const helper of helpers) {
      this.active.delete(helper)
      let done = false
      if (keep && this.reuseHelpers) {
        try {
          Atomics.wait(helper.flag, 0, HELPER_RUNNING, HELPER_WAIT_MS)
        } catch {
          // Waiting is best-effort; the atomic flag remains authoritative.
        }
        done = Atomics.load(helper.flag, 0) === HELPER_DONE
      }
      if (done) this.idle.push(helper)
      else this.terminate(helper)
    }
  }

  async terminateAll(): Promise<void> {
    for (const helper of this.idle.splice(0)) this.terminate(helper)
    for (const helper of this.active) {
      this.active.delete(helper)
      this.terminate(helper)
    }
    await Promise.all(this.terminating)
  }

  get idleCount(): number {
    return this.idle.length
  }

  /** Helpers still live or completing termination, for bounded-lifetime tests. */
  get liveCount(): number {
    return this.idle.length + this.active.size + this.terminating.size
  }

  get peakLiveCount(): number {
    return this.peakLive
  }

  private recordPeak(): void {
    this.peakLive = Math.max(this.peakLive, this.liveCount)
  }

  private terminate(helper: Helper): void {
    const termination = helper.worker.terminate().then(
      () => {},
      () => {},
    )
    this.terminating.add(termination)
    this.recordPeak()
    void termination.then(() => this.terminating.delete(termination))
  }
}
