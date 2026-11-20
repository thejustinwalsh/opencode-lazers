/**
 * Who waits for the one analysis worker. Three priorities share it:
 *
 *  - `interactive`: a tool call from a person or an agent that is waiting for the answer;
 *  - `verification`: the runner's review of a candidate, which gates a task;
 *  - `background`: auditor reports, whole-project sections that take the longest.
 *
 * The worker runs one request at a time. The next request is the oldest of the highest priority
 * waiting. A running request that a higher priority has waited behind for `PREEMPT_AFTER_MS` is
 * stopped and queued again at its place (it restarts, there is no partial result); sections of a
 * report are separate requests, so a report yields to a higher priority between them anyway.
 * A request's time limit covers its wait in the queue and its run: its deadline is fixed when it is
 * submitted and survives a restart.
 */
export type AnalysisPriority = "interactive" | "verification" | "background"

const RANK: Record<AnalysisPriority, number> = { interactive: 0, verification: 1, background: 2 }

/**
 * How long a higher priority waits behind a running lower one before that one is stopped.
 * Measured on this repository with the machine loaded (load average 15), one worker:
 * complexity of one file 16 ms, dead code 0.5 s, duplication 0.7 s, dead code, duplication and
 * health in one run 1.9 s, the health section alone 5.5 s, a cold worker 1.1 s. Most calls
 * finish before the budget and so are never cut; only a run longer than the slowest section
 * measured here (a larger project) is stopped for a waiting request. The restart costs the
 * run's work and a fresh worker's module compile (about 1 s). Tunable per scheduler.
 */
export const PREEMPT_AFTER_MS = 5_000

/** What the scheduler needs from the thing that runs requests. */
export type AnalysisExecutor<Request, Response> = {
  /** Starts one request. It is never called while another is running. */
  run(request: Request): Promise<Response>
  /** Stops the running request (its promise may then reject; the scheduler ignores that). */
  cancel(reason: Error): void
}

type Job<Request, Response> = {
  request: Request
  rank: number
  seq: number
  submittedAt: number
  /** Identifies the current run of this job, so a stopped run's late answer is ignored. */
  token: number
  timeoutMs: number
  signal: AbortSignal | undefined
  deadline: ReturnType<typeof setTimeout>
  onAbort: () => void
  resolve: (response: Response) => void
  reject: (error: Error) => void
  settled: boolean
}

export class AnalysisScheduler<Request, Response> {
  private readonly queue: Job<Request, Response>[] = []
  private running: Job<Request, Response> | undefined
  private preemptTimer: ReturnType<typeof setTimeout> | undefined
  private seq = 0
  private tokens = 0
  /** Counts for tests and diagnostics. */
  preemptions = 0

  constructor(
    private readonly executor: AnalysisExecutor<Request, Response>,
    private readonly preemptAfterMs = PREEMPT_AFTER_MS,
  ) {}

  /** Requests waiting, not counting the one running. */
  get waiting(): number {
    return this.queue.length
  }

  submit(
    request: Request,
    options: { priority?: AnalysisPriority; signal?: AbortSignal; timeoutMs: number },
  ): Promise<Response> {
    options.signal?.throwIfAborted()
    return new Promise<Response>((resolve, reject) => {
      const job: Job<Request, Response> = {
        request,
        rank: RANK[options.priority ?? "interactive"],
        seq: this.seq++,
        submittedAt: Date.now(),
        token: 0,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        deadline: setTimeout(
          () =>
            this.end(
              job,
              new Error(`timeout: analyzer call exceeded ${options.timeoutMs}ms`),
              undefined,
            ),
          options.timeoutMs,
        ),
        onAbort: () =>
          this.end(job, new Error(`cancelled: ${String(options.signal?.reason ?? "aborted")}`)),
        resolve,
        reject,
        settled: false,
      }
      options.signal?.addEventListener("abort", job.onAbort, { once: true })
      this.queue.push(job)
      this.pump()
      this.armPreemption()
    })
  }

  /** Settles a job, wherever it is: queued, or running (which stops the worker). */
  private end(job: Job<Request, Response>, error: Error | undefined, response?: Response): void {
    if (job.settled) return
    job.settled = true
    clearTimeout(job.deadline)
    job.signal?.removeEventListener("abort", job.onAbort)
    const queued = this.queue.indexOf(job)
    if (queued >= 0) this.queue.splice(queued, 1)
    const wasRunning = this.running === job
    if (wasRunning) {
      this.running = undefined
      if (error) this.executor.cancel(error)
    }
    if (error) job.reject(error)
    else job.resolve(response as Response)
    if (wasRunning) this.pump()
    this.armPreemption()
  }

  private pump(): void {
    if (this.running || this.queue.length === 0) return
    let next = 0
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i]!,
        b = this.queue[next]!
      if (a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq)) next = i
    }
    const job = this.queue.splice(next, 1)[0]!
    const token = ++this.tokens
    job.token = token
    this.running = job
    let started: Promise<Response>
    try {
      started = this.executor.run(job.request)
    } catch (error) {
      started = Promise.reject(error)
    }
    started.then(
      (response) => this.finished(job, token, undefined, response),
      (error: unknown) =>
        this.finished(job, token, error instanceof Error ? error : new Error(String(error))),
    )
  }

  private finished(
    job: Job<Request, Response>,
    token: number,
    error: Error | undefined,
    response?: Response,
  ): void {
    // A run that was stopped for a higher priority answers late; its job already runs again.
    if (job.token !== token || this.running !== job) return
    this.end(job, error, response)
  }

  /** Arms one timer for the longest-waiting request of a higher priority than the running one. */
  private armPreemption(): void {
    clearTimeout(this.preemptTimer)
    this.preemptTimer = undefined
    const running = this.running
    if (!running) return
    const waiting = this.queue.filter((job) => job.rank < running.rank)
    if (waiting.length === 0) return
    const oldest = Math.min(...waiting.map((job) => job.submittedAt))
    const wait = Math.max(0, oldest + this.preemptAfterMs - Date.now())
    this.preemptTimer = setTimeout(() => this.preempt(running), wait)
    // A waiting request must not keep a stopped process alive on its own.
    this.preemptTimer.unref?.()
  }

  private preempt(job: Job<Request, Response>): void {
    this.preemptTimer = undefined
    if (this.running !== job || job.settled) return
    const waiting = this.queue.some((other) => other.rank < job.rank)
    if (!waiting) return
    this.preemptions++
    this.running = undefined
    this.executor.cancel(new Error("preempted: a higher-priority analysis was waiting"))
    // Back in the queue at its original place among its own priority; its deadline keeps running.
    this.queue.push(job)
    this.pump()
    this.armPreemption()
  }
}
