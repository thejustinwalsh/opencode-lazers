import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROJECT_RECONCILIATION_INTERVAL_MS,
  SchedulerCoordinator,
  schedulerProjectKey,
  sharedScheduler,
} from "./scheduler-coordinator.ts"

class Clock {
  time = 0
  nextID = 0
  maximumTimers = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  now = () => this.time
  set = (callback: () => void, delay: number) => {
    const id = ++this.nextID
    this.timers.set(id, { at: this.time + delay, callback })
    this.maximumTimers = Math.max(this.maximumTimers, this.timers.size)
    return id
  }
  clear = (id: unknown) => {
    this.timers.delete(id as number)
  }
  async advance(ms: number) {
    const end = this.time + ms
    for (let count = 0; ; count++) {
      if (count > 10000) throw new Error("Scheduler is spinning")
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
      await settle()
    }
    this.time = end
    await settle()
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("54 location registrations share one project reconciliation and one timer", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const calls = Array.from({ length: 54 }, () => 0)
  const registrations = calls.map((_, index) =>
    scheduler.register("project", {
      intervalMs: PROJECT_RECONCILIATION_INTERVAL_MS,
      run: () => {
        calls[index] = calls[index]! + 1
      },
    }),
  )
  expect(clock.timers.size).toBe(1)
  await clock.advance(299_999)
  expect(calls[0]).toBe(1)
  await clock.advance(1)
  expect(calls[0]).toBe(2)
  await clock.advance(30_000)
  const immediate = registrations[0]!.runNow()
  await clock.advance(0)
  await immediate
  expect(calls[0]).toBe(3)
  expect(calls.slice(1).every((n) => n === 0)).toBe(true)
  expect(scheduler.snapshot()).toMatchObject({
    groups: 1,
    participants: 54,
    runs: 3,
    timerCount: 1,
  })
  expect(clock.maximumTimers).toBe(1)
  await Promise.all(registrations.map((r) => r.dispose()))
  expect(scheduler.snapshot()).toMatchObject({ groups: 0, timerCount: 0 })
  expect(clock.timers.size).toBe(0)
})

test("independent projects keep requested intervals on the same timer", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const a: number[] = [],
    b: number[] = []
  const first = scheduler.register("a", {
    intervalMs: 2000,
    run: () => {
      a.push(clock.now())
    },
  })
  const second = scheduler.register("b", {
    intervalMs: 3000,
    run: () => {
      b.push(clock.now())
    },
  })
  await clock.advance(6000)
  expect(a).toEqual([0, 2000, 4000, 6000])
  expect(b).toEqual([0, 3000, 6000])
  expect(clock.maximumTimers).toBe(1)
  await first.dispose()
  await second.dispose()
})

test("exact project status isolates registrations and distinguishes scheduled, draining, and disposed", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const pending = deferred()
  const a = scheduler.register("project-a", {
    intervalMs: 2000,
    run: () => pending.promise,
  })
  const b = scheduler.register("project-b", { intervalMs: 2000, run: () => {} })

  expect(scheduler.projectStatus("project-a")).toEqual({ status: "scheduled", participants: 1 })
  expect(scheduler.projectStatus("project-b")).toEqual({ status: "scheduled", participants: 1 })
  expect(scheduler.projectStatus("project-missing")).toEqual({ status: "absent", participants: 0 })
  await clock.advance(0)
  expect(scheduler.projectStatus("project-a")).toEqual({ status: "draining", participants: 1 })
  expect(scheduler.projectStatus("project-b")).toEqual({ status: "scheduled", participants: 1 })

  const disposal = a.dispose()
  expect(scheduler.projectStatus("project-a")).toEqual({ status: "draining", participants: 0 })
  pending.resolve()
  await disposal
  expect(scheduler.projectStatus("project-a")).toEqual({ status: "absent", participants: 0 })
  expect(scheduler.projectStatus("project-b")).toEqual({ status: "scheduled", participants: 1 })
  await b.dispose()
  expect(scheduler.projectStatus("project-b")).toEqual({ status: "absent", participants: 0 })
})

test("slow reconciliation never overlaps, coalesces requests, and does not block other projects", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const pending = deferred()
  let slow = 0,
    fast = 0
  const a = scheduler.register("a", {
    intervalMs: 2000,
    run: () => {
      slow++
      return slow === 1 ? pending.promise : undefined
    },
  })
  const b = scheduler.register("b", {
    intervalMs: 2000,
    run: () => {
      fast++
    },
  })
  await clock.advance(0)
  for (let i = 0; i < 100; i++) a.request()
  await clock.advance(10_000)
  expect(slow).toBe(1)
  expect(fast).toBe(6)
  pending.resolve()
  await settle()
  await clock.advance(0)
  expect(slow).toBe(2)
  expect(scheduler.snapshot().running).toBe(0)
  await a.dispose()
  await b.dispose()
})

test("retiring the elected participant waits for its drain before transferring ownership", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const pending = deferred()
  let firstCalls = 0,
    replacementCalls = 0,
    disposed = false
  const first = scheduler.register("project", {
    intervalMs: 2000,
    run: () => {
      firstCalls++
      return pending.promise
    },
  })
  const second = scheduler.register("project", {
    intervalMs: 2000,
    run: () => {
      replacementCalls++
    },
  })
  await clock.advance(0)
  const disposal = first.dispose().then(() => {
    disposed = true
  })
  first.request()
  await clock.advance(10_000)
  expect(disposed).toBe(false)
  expect(firstCalls).toBe(1)
  expect(replacementCalls).toBe(0)
  pending.resolve()
  await disposal
  await clock.advance(0)
  expect(replacementCalls).toBe(1)
  await clock.advance(2000)
  expect(replacementCalls).toBe(2)
  expect(firstCalls).toBe(1)
  await second.dispose()
  expect(clock.timers.size).toBe(0)
})

test("a replacement registration during final disposal cannot start an overlapping drain", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const pending = deferred()
  const first = scheduler.register("project", { intervalMs: 2000, run: () => pending.promise })
  await clock.advance(0)
  const disposal = first.dispose()
  let calls = 0
  const second = scheduler.register("project", {
    intervalMs: 2000,
    run: () => {
      calls++
    },
  })
  await clock.advance(10_000)
  expect(calls).toBe(0)
  pending.resolve()
  await disposal
  await clock.advance(0)
  expect(calls).toBe(1)
  await second.dispose()
})

test("an error or failing error reporter does not strand subsequent reconciliation", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  let calls = 0,
    errors = 0
  const registration = scheduler.register("project", {
    intervalMs: 2000,
    run: () => {
      calls++
      throw new Error("native read failed")
    },
    onError: () => {
      errors++
      throw new Error("report failed")
    },
  })
  await clock.advance(4000)
  expect(calls).toBe(3)
  expect(errors).toBe(3)
  expect(scheduler.snapshot().errors).toBe(3)
  await registration.dispose()
})

test("requests use the earliest deadline; disposal cancels pending requested work", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const calls: number[] = []
  const registration = scheduler.register("project", {
    intervalMs: 2000,
    run: () => {
      calls.push(clock.now())
    },
  })
  await clock.advance(0)
  registration.request(500)
  registration.request(1500)
  await clock.advance(500)
  expect(calls).toEqual([0, 500])
  registration.request()
  await registration.dispose()
  await clock.advance(10_000)
  expect(calls).toEqual([0, 500])
  expect(clock.timers.size).toBe(0)
})

test("a shorter participant interval advances the deadline without a duplicate startup sweep", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const calls: number[] = []
  const first = scheduler.register("project", {
    intervalMs: 10_000,
    run: () => {
      calls.push(clock.now())
    },
  })
  await clock.advance(0)
  const second = scheduler.register("project", { intervalMs: 2000, run: () => {} })
  await clock.advance(4000)
  expect(calls).toEqual([0, 2000, 4000])
  await first.dispose()
  await second.dispose()
})

test("initial deadlines support periodic jobs without an immediate startup invocation", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  let calls = 0
  const registration = scheduler.register(
    "lease",
    {
      intervalMs: 10_000,
      run: () => {
        calls++
      },
    },
    10_000,
  )
  await clock.advance(9999)
  expect(calls).toBe(0)
  await clock.advance(1)
  expect(calls).toBe(1)
  await registration.dispose()
})

test("explicit start requests join one elected drain and wait for work after an in-flight read", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const pending = deferred()
  let runs = 0,
    returned = 0
  const leader = scheduler.register("project", {
    intervalMs: 2000,
    run: () => {
      runs++
      return runs === 1 ? pending.promise : undefined
    },
  })
  const follower = scheduler.register("project", {
    intervalMs: 2000,
    run: () => {
      throw new Error("wrong owner")
    },
  })
  await clock.advance(0)
  const requests = Array.from({ length: 20 }, () =>
    follower.runNow().then(() => {
      returned++
    }),
  )
  await clock.advance(2000)
  expect(runs).toBe(1)
  expect(returned).toBe(0)
  pending.resolve()
  await settle()
  await clock.advance(0)
  await Promise.all(requests)
  expect(runs).toBe(2)
  expect(returned).toBe(20)
  await leader.dispose()
  await follower.dispose()
})

test("explicit reconciliation errors reach their caller and do not poison the next request", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  let fail = true
  const registration = scheduler.register("project", {
    intervalMs: 2000,
    run: () => {
      if (fail) throw new Error("read failed")
    },
  })
  const failed = registration.runNow().then(
    () => null,
    (error: unknown) => error,
  )
  await clock.advance(0)
  expect(((await failed) as Error).message).toBe("read failed")
  fail = false
  const retry = registration.runNow()
  await clock.advance(0)
  await retry
  await registration.dispose()
})

test("disposal rejects queued explicit requests instead of leaving their callers waiting", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const registration = scheduler.register("project", { intervalMs: 2000, run: () => {} })
  const requested = registration.runNow().then(
    () => null,
    (error: unknown) => error,
  )
  await registration.dispose()
  expect(((await requested) as Error).message).toBe("Scheduler registration was disposed")
  await expect(registration.runNow()).rejects.toThrow("disposed")
  expect(clock.timers.size).toBe(0)
})

test("disposing a follower rejects captured Start waits without resuming its closed store", async () => {
  const clock = new Clock()
  const scheduler = new SchedulerCoordinator(clock)
  const pending = deferred()
  let closed = false,
    postCloseReads = 0,
    survivorFinished = false
  const leader = scheduler.register("project", { intervalMs: 2000, run: () => pending.promise })
  const follower = scheduler.register("project", { intervalMs: 2000, run: () => {} })
  const survivor = scheduler.register("project", { intervalMs: 2000, run: () => {} })
  const start = follower.runNow().then(
    () => {
      if (closed) postCloseReads++
      return "returned"
    },
    (error: Error) => error.message,
  )
  const survivingStart = survivor.runNow().then(() => {
    survivorFinished = true
  })
  await clock.advance(0)
  await follower.dispose()
  closed = true
  pending.resolve()
  await settle()
  expect(await start).toBe("Scheduler registration was disposed")
  expect(postCloseReads).toBe(0)
  await survivingStart
  expect(survivorFinished).toBe(true)
  await leader.dispose()
  await survivor.dispose()
  expect(scheduler.snapshot()).toMatchObject({ running: 0, groups: 0, errors: 0 })
})

test("invalid intervals and deadlines cannot create an unbounded timer loop", async () => {
  const scheduler = new SchedulerCoordinator(new Clock())
  for (const intervalMs of [0, -1, NaN, Infinity])
    expect(() => scheduler.register("bad", { intervalMs, run: () => {} })).toThrow()
  expect(() => scheduler.register("bad", { intervalMs: 2000, run: () => {} }, -1)).toThrow()
  expect(scheduler.snapshot().groups).toBe(0)
})

test("independently loaded module copies share the process coordinator", async () => {
  const url = new URL(`./scheduler-coordinator.ts?copy=${crypto.randomUUID()}`, import.meta.url)
    .href
  const copy = await import(url)
  expect(copy.sharedScheduler).toBe(sharedScheduler)
})

test("canonical project keys coalesce path aliases while keeping databases and projects distinct", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-scheduler-key-"))
  try {
    const database = join(root, "tasks.sqlite")
    writeFileSync(database, "")
    symlinkSync(database, join(root, "alias.sqlite"))
    expect(schedulerProjectKey(database, root, "a")).toBe(
      schedulerProjectKey(join(root, "alias.sqlite"), root, "a"),
    )
    expect(schedulerProjectKey(database, root, "a")).not.toBe(
      schedulerProjectKey(database, root, "b"),
    )
    expect(schedulerProjectKey(database, root, "a")).not.toBe(
      schedulerProjectKey(join(root, "other.sqlite"), root, "a"),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
