import { afterEach, describe, expect, test } from "bun:test"
import { AnalysisScheduler, PREEMPT_AFTER_MS, type AnalysisExecutor } from "./analysis-scheduler.ts"

type Run = { request: string; resolve: (value: string) => void; reject: (error: Error) => void }

/** An executor whose runs finish when the test says so. */
function fake() {
  const runs: Run[] = []
  const cancels: string[] = []
  let throwOnRun: Error | undefined
  const executor: AnalysisExecutor<string, string> = {
    run(request) {
      if (throwOnRun) throw throwOnRun
      return new Promise((resolve, reject) => runs.push({ request, resolve, reject }))
    },
    cancel(reason) {
      cancels.push(reason.message)
      runs.at(-1)?.reject(reason)
    },
  }
  return {
    executor,
    runs,
    cancels,
    started: () => runs.map((run) => run.request),
    failNextRun: (error: Error) => (throwOnRun = error),
  }
}
/** Every request a test leaves unanswered is cancelled at its end, so no timer fires later. */
const open: AbortController[] = []
afterEach(() => {
  for (const controller of open.splice(0)) controller.abort(new Error("test ended"))
})
class TrackedScheduler<Request, Response> extends AnalysisScheduler<Request, Response> {
  override submit(
    request: Request,
    options: Parameters<AnalysisScheduler<Request, Response>["submit"]>[1],
  ): Promise<Response> {
    const controller = new AbortController()
    open.push(controller)
    const promise = super.submit(request, { signal: controller.signal, ...options })
    promise.catch(() => undefined)
    return promise
  }
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe("priority order", () => {
  test("the next request is the oldest of the highest priority waiting", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor, 60_000)
    const done: string[] = []
    const submit = (name: string, priority: "interactive" | "verification" | "background") =>
      scheduler.submit(name, { priority, timeoutMs: 10_000 }).then((value) => void done.push(value))
    const all = [
      submit("background-1", "background"),
      submit("background-2", "background"),
      submit("tool-1", "interactive"),
      submit("review-1", "verification"),
      submit("tool-2", "interactive"),
    ]
    // The first request was alone, so it started; the rest wait their turn.
    expect(f.started()).toEqual(["background-1"])
    for (let i = 0; i < 5; i++) {
      f.runs.at(-1)!.resolve(f.runs.at(-1)!.request)
      await tick()
    }
    await Promise.all(all)
    expect(f.started()).toEqual(["background-1", "tool-1", "tool-2", "review-1", "background-2"])
    expect(done).toEqual(f.started())
  })

  test("a request without a priority is interactive", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor, 60_000)
    void scheduler.submit("first", { priority: "background", timeoutMs: 10_000 })
    void scheduler.submit("later-background", { priority: "background", timeoutMs: 10_000 })
    void scheduler.submit("default", { timeoutMs: 10_000 })
    f.runs[0]!.resolve("x")
    await tick()
    expect(f.started()).toEqual(["first", "default"])
  })
})

describe("yielding to a higher priority", () => {
  test("a running request that a higher priority has waited behind is stopped, then runs again after it", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor, 40)
    const background = scheduler.submit("section", { priority: "background", timeoutMs: 10_000 })
    const tool = scheduler.submit("tool", { timeoutMs: 10_000 })
    expect(f.started()).toEqual(["section"])
    await tick(120)
    expect(f.cancels).toEqual(["preempted: a higher-priority analysis was waiting"])
    expect(f.started()).toEqual(["section", "tool"])
    expect(scheduler.preemptions).toBe(1)
    f.runs[1]!.resolve("tool answer")
    expect(await tool).toBe("tool answer")
    // The stopped section restarts, and its earlier run's late answer does not settle it.
    await tick()
    expect(f.started()).toEqual(["section", "tool", "section"])
    f.runs[0]!.resolve("stale")
    await tick()
    f.runs[2]!.resolve("fresh")
    expect(await background).toBe("fresh")
  })

  test("a request that finishes within the budget is never stopped", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor, 200)
    const background = scheduler.submit("section", { priority: "background", timeoutMs: 10_000 })
    const tool = scheduler.submit("tool", { timeoutMs: 10_000 })
    await tick(20)
    f.runs[0]!.resolve("section answer")
    await tick()
    f.runs[1]!.resolve("tool answer")
    expect([await background, await tool]).toEqual(["section answer", "tool answer"])
    await tick(260)
    expect(f.cancels).toEqual([])
    expect(scheduler.preemptions).toBe(0)
  })

  test("the same priority never stops a running request, and a lower one never does", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor, 20)
    void scheduler.submit("tool-1", { timeoutMs: 10_000 })
    void scheduler.submit("tool-2", { timeoutMs: 10_000 })
    void scheduler.submit("background", { priority: "background", timeoutMs: 10_000 })
    await tick(100)
    expect(f.cancels).toEqual([])
    expect(f.started()).toEqual(["tool-1"])
  })

  test("the budget has a measured default", () => {
    expect(PREEMPT_AFTER_MS).toBe(5_000)
  })
})

describe("time limits and cancellation", () => {
  test("the time limit covers the wait in the queue: a request that never started times out", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor, 60_000)
    void scheduler.submit("long", { timeoutMs: 10_000 })
    const queued = scheduler.submit("queued", { timeoutMs: 30 })
    await expect(queued).rejects.toThrow("timeout: analyzer call exceeded 30ms")
    expect(scheduler.waiting).toBe(0)
    f.runs[0]!.resolve("done")
    await tick()
    // It never reached the worker.
    expect(f.started()).toEqual(["long"])
  })

  test("a request that is running when its limit passes stops the worker, and the next one runs", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor, 60_000)
    const slow = scheduler.submit("slow", { timeoutMs: 30 })
    const next = scheduler.submit("next", { timeoutMs: 10_000 })
    await expect(slow).rejects.toThrow("timeout")
    expect(f.cancels).toHaveLength(1)
    expect(f.started()).toEqual(["slow", "next"])
    f.runs[1]!.resolve("ok")
    expect(await next).toBe("ok")
  })

  test("aborting a queued request removes it; aborting a running one stops the worker", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor, 60_000)
    const running = new AbortController(),
      queued = new AbortController()
    const first = scheduler.submit("first", { signal: running.signal, timeoutMs: 10_000 })
    const second = scheduler.submit("second", { signal: queued.signal, timeoutMs: 10_000 })
    const third = scheduler.submit("third", { timeoutMs: 10_000 })
    queued.abort(new Error("no longer wanted"))
    await expect(second).rejects.toThrow("cancelled: Error: no longer wanted")
    running.abort(new Error("stop"))
    await expect(first).rejects.toThrow("cancelled")
    expect(f.cancels).toHaveLength(1)
    expect(f.started()).toEqual(["first", "third"])
    f.runs[1]!.resolve("third answer")
    expect(await third).toBe("third answer")
  })

  test("an already-aborted request is refused before it is queued", () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor)
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    expect(() => scheduler.submit("x", { signal: controller.signal, timeoutMs: 10 })).toThrow()
    expect(scheduler.waiting).toBe(0)
  })

  test("an executor that throws fails that request and does not poison the queue", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor)
    f.failNextRun(new Error("cannot start"))
    await expect(scheduler.submit("bad", { timeoutMs: 10_000 })).rejects.toThrow("cannot start")
    f.failNextRun(undefined as never)
    const good = scheduler.submit("good", { timeoutMs: 10_000 })
    f.runs[0]!.resolve("fine")
    expect(await good).toBe("fine")
  })

  test("a failed run rejects its request and the next one starts", async () => {
    const f = fake()
    const scheduler = new TrackedScheduler(f.executor)
    const first = scheduler.submit("first", { timeoutMs: 10_000 })
    const second = scheduler.submit("second", { timeoutMs: 10_000 })
    f.runs[0]!.reject(new Error("analyzer-panic: boom"))
    await expect(first).rejects.toThrow("analyzer-panic")
    f.runs[1]!.resolve("second answer")
    expect(await second).toBe("second answer")
  })
})
